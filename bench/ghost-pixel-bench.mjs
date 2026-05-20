// bench/ghost-pixel-bench.mjs
//
// Validates the partial_fill streaming render path by sampling the canvas
// AT HIGH FREQUENCY during a single cache-miss pan and asserting that the
// data front (rightmost non-background x column with trace pixels) grows
// MONOTONICALLY across samples. A ghost-residue bug shows up as one of:
//   (a) max_x exceeds the expected data front at an intermediate sample —
//       partial data was stretched across full plotW and later cleared, or
//   (b) max_x DECREASES between samples — earlier ghost pixels were cleared
//       by the next chunk's narrow band but the polyline shrunk back.
//
// Why this design: the previous bench captured the reference AFTER the
// page had fully settled, then panned away and back. The pan-back is a
// cache hit that takes the NON-streaming path, so the diff is always 0
// regardless of whether streaming has bugs. This version forces a single
// fresh streaming pan and watches the canvas WHILE chunks arrive.
//
// Usage:
//   1. Start the dev server: `node scripts/serve.mjs 8011 &`
//   2. Run this bench:        `node bench/ghost-pixel-bench.mjs`
// Output: bench/ghost-pixel-baseline.json

import { chromium } from '@playwright/test';
import fs from 'node:fs';

const EEG_URL = 'https://s3.amazonaws.com/openneuro.org/ds002893/sub-001/eeg/sub-001_task-AuditoryVisualShift_run-01_eeg.set';

// Inset of the plot area in the trace canvas (mirrors traces.js constants
// — sourcing them at runtime would require a JS module import; hard-coding
// keeps the bench standalone, but if traces.js drifts they must be updated
// here too. Verified against traces.js 2026-05-20.)
const PAD_LEFT = 96;
const PAD_RIGHT = 70;
const PAD_TOP = 8;
const PAD_BOTTOM = 28;

// Sample the canvas: returns the rightmost CSS-pixel x-column (in the trace
// plot band) that has any non-background pixel. Background is #fbfaf6.
async function sampleDataFront(page) {
  return page.evaluate(({ PAD_LEFT, PAD_RIGHT, PAD_TOP, PAD_BOTTOM }) => {
    const canvas = document.getElementById('traces');
    if (!canvas || !canvas.width) return { maxX: 0, w: 0, h: 0, t: performance.now() };
    const ctx = canvas.getContext('2d');
    const { width: w, height: h } = canvas;
    const data = ctx.getImageData(0, 0, w, h).data;
    // Backing-store pixel scale: canvas.width = cssW * dpr.
    const dpr = w / canvas.clientWidth;
    const xMinPx = Math.floor(PAD_LEFT * dpr);
    const xMaxPx = Math.ceil((canvas.clientWidth - PAD_RIGHT) * dpr);
    const yMinPx = Math.floor(PAD_TOP * dpr);
    const yMaxPx = Math.ceil((canvas.clientHeight - PAD_BOTTOM) * dpr);
    let maxX = -1;
    for (let y = yMinPx; y < yMaxPx; y++) {
      const rowOff = y * w * 4;
      for (let x = xMaxPx - 1; x > maxX && x >= xMinPx; x--) {
        const i = rowOff + x * 4;
        const r = data[i], g = data[i+1], b = data[i+2];
        if (Math.abs(r - 251) > 8 || Math.abs(g - 250) > 8 || Math.abs(b - 246) > 8) {
          if (x > maxX) maxX = x;
          break;
        }
      }
    }
    // Return in CSS pixels for stable cross-DPR comparison.
    return { maxX: maxX < 0 ? 0 : maxX / dpr, w, h, t: performance.now() };
  }, { PAD_LEFT, PAD_RIGHT, PAD_TOP, PAD_BOTTOM });
}

const browser = await chromium.launch();
const page = await browser.newPage();

// Throttle OpenNeuro S3 byte-range responses to give the bench a chance
// to actually sample mid-stream chunks. Without this, the streaming
// completes in <5 ms after the keypress and every sample sees the final
// state — the overshoot/monotonicity checks still run but the
// 'captured_mid_stream' flag in the JSON output will be false.
// 80 ms per request × N range fetches gives us a workable streaming window.
await page.route('**/openneuro.org/**', async (route) => {
  await new Promise(r => setTimeout(r, 80));
  await route.continue();
});

await page.goto(`http://localhost:8011/index.html?eeg=${encodeURIComponent(EEG_URL)}`);
await page.waitForSelector('#stage-caption', { timeout: 90_000 });

// Let initial render settle so the baseline window is fully painted.
await page.waitForTimeout(3000);
const initial = await sampleDataFront(page);

// Trigger a fresh streaming pan: hop the window forward by enough that
// the new window is NOT in the read cache (default cache holds ~6 windows).
// 10 rapid ArrowRight presses move ~5 window-widths forward — guaranteed
// cache miss.
for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');

// Sample the canvas tightly while streaming completes. We don't know when
// the final chunk lands, so sample for up to 5s with a small delay.
const samples = [];
const SAMPLE_CAP_MS = 5000;
const SAMPLE_INTERVAL_MS = 25;
const startSample = Date.now();
while (Date.now() - startSample < SAMPLE_CAP_MS) {
  samples.push(await sampleDataFront(page));
  await page.waitForTimeout(SAMPLE_INTERVAL_MS);
}

const cssW = await page.evaluate(() => document.getElementById('traces').clientWidth);
const expectedFront = cssW - PAD_RIGHT;

// Invariant 1: the data front must NEVER exceed expectedFront. A ghost-stretch
// bug paints a polyline across the full plotW while only a narrow band gets
// cleared — but in steady state our renderer never paints past plotX0+plotW.
// More importantly, mid-streaming, the front must not exceed expectedFront.
let maxFront = 0;
let maxFrontIdx = -1;
for (let i = 0; i < samples.length; i++) {
  if (samples[i].maxX > maxFront) { maxFront = samples[i].maxX; maxFrontIdx = i; }
}
const overshoot = maxFront - expectedFront;

// Invariant 2: monotonic non-decreasing data front. Once samples beyond
// the warm-up settle (skip first 3 samples for setup transients), each
// subsequent sample's maxX must be >= the previous. A decrease means an
// earlier sample had ghost pixels that were later cleared.
let regressions = 0;
let worstRegressionPx = 0;
for (let i = 4; i < samples.length; i++) {
  const drop = samples[i - 1].maxX - samples[i].maxX;
  if (drop > 2) { // 2px slack for anti-aliasing
    regressions++;
    if (drop > worstRegressionPx) worstRegressionPx = drop;
  }
}

// Did we actually catch mid-stream samples? If the first sample already
// shows the final data front, the worker's byte cache + route-throttle
// weren't slow enough to keep streaming open during sampling. The
// invariant checks still pass (overshoot==0, regressions==0) but the
// bench is reduced to a steady-state sanity check.
const firstFrontCss = samples[0]?.maxX || 0;
const capturedMidStream = firstFrontCss < expectedFront * 0.9;

const verdict = (overshoot <= 2 && regressions === 0) ? 'PASS' : 'FAIL';

fs.mkdirSync('bench', { recursive: true });
fs.writeFileSync('bench/ghost-pixel-baseline.json', JSON.stringify({
  verdict,
  captured_mid_stream: capturedMidStream,
  canvas_size: { w: initial.w, h: initial.h },
  expected_front_css: expectedFront,
  samples_count: samples.length,
  max_front_css: Number(maxFront.toFixed(1)),
  max_front_sample_idx: maxFrontIdx,
  overshoot_css: Number(overshoot.toFixed(1)),
  regressions,
  worst_regression_px: Number(worstRegressionPx.toFixed(1)),
  // First/last few samples for human eyeball.
  samples_head: samples.slice(0, 5).map(s => ({ maxX: Number(s.maxX.toFixed(1)) })),
  samples_tail: samples.slice(-5).map(s => ({ maxX: Number(s.maxX.toFixed(1)) })),
}, null, 2));

console.log(`verdict:                ${verdict}`);
console.log(`samples:                ${samples.length}`);
console.log(`expected front (CSS x): ${expectedFront.toFixed(1)}`);
console.log(`max observed front:     ${maxFront.toFixed(1)} (sample ${maxFrontIdx})`);
console.log(`overshoot:              ${overshoot.toFixed(1)} px (PASS if ≤ 2)`);
console.log(`regressions:            ${regressions} (PASS if 0)`);
if (regressions > 0) console.log(`worst regression:       ${worstRegressionPx.toFixed(1)} px`);
console.log(`mid-stream captured:    ${capturedMidStream ? 'yes' : 'no (worker bytes cached — invariants still valid, but no mid-stream signal)'}`);

await browser.close();
if (verdict !== 'PASS') process.exit(1);
