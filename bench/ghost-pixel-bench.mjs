// bench/ghost-pixel-bench.mjs
//
// Captures a reference render of the canvas at a fixed window, then
// performs a rapid-pan sequence and computes the per-pixel diff between
// the post-stress canvas and the reference. The diff is reported as
// (a) total non-zero diff pixels, (b) RMS RGB delta. Both numbers should
// be small (< 0.5% of canvas area, < 5/255 RMS) on a clean implementation.
//
// Usage:
//   1. Start the dev server in another terminal: `node scripts/dev-server.mjs` (or `npm run dev`)
//   2. Run this bench: `node bench/ghost-pixel-bench.mjs`
// Output: bench/ghost-pixel-baseline.json

import { chromium } from '@playwright/test';
import fs from 'node:fs';

const EEG_URL = 'https://s3.amazonaws.com/openneuro.org/ds002893/sub-001/eeg/sub-001_task-AuditoryVisualShift_run-01_eeg.set';

async function captureCanvas(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('traces');
    const ctx = canvas.getContext('2d');
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { w: d.width, h: d.height, data: Array.from(d.data) };
  });
}

function diff(a, b) {
  if (a.w !== b.w || a.h !== b.h) throw new Error('size mismatch');
  let nonZero = 0;
  let sumSq = 0;
  let nPx = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const dr = a.data[i] - b.data[i];
    const dg = a.data[i+1] - b.data[i+1];
    const db = a.data[i+2] - b.data[i+2];
    if (dr || dg || db) nonZero++;
    sumSq += dr*dr + dg*dg + db*db;
    nPx++;
  }
  const rms = Math.sqrt(sumSq / (nPx * 3));
  return { nonZero, total: nPx, rms: Number(rms.toFixed(3)) };
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://localhost:8011/index.html?eeg=${encodeURIComponent(EEG_URL)}`);
await page.waitForSelector('#stage-caption', { timeout: 90_000 });
await page.waitForTimeout(2000);

const reference = await captureCanvas(page);

for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(3000);

const after = await captureCanvas(page);
const d = diff(reference, after);

fs.mkdirSync('bench', { recursive: true });
fs.writeFileSync('bench/ghost-pixel-baseline.json', JSON.stringify({
  reference_size: { w: reference.w, h: reference.h },
  diff: d,
  diff_ratio: Number((d.nonZero / d.total).toFixed(4)),
}, null, 2));

console.log(`pixels differing: ${d.nonZero}/${d.total} (${(d.nonZero / d.total * 100).toFixed(2)}%)`);
console.log(`RMS delta: ${d.rms}/255`);
await browser.close();
