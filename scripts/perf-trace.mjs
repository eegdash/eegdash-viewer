// Browser-side performance harness. Instruments the live page,
// drives a realistic pan sequence, and reports where wall time
// goes per pan + heap pressure across the run. Two modes:
//
//   --cdp     also captures a Chrome devtools trace (loadable in
//             chrome://tracing or speedscope) for flame-graph
//             work; outputs to perf-trace.json.
//
// Run from repo root:
//   node scripts/perf-trace.mjs                 # quick metrics
//   node scripts/perf-trace.mjs --cdp           # also flame trace
//
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const FLAGS = new Set(process.argv.slice(2));
const WANT_CDP = FLAGS.has('--cdp');

// Mix of heavy + light recordings to surface different bottlenecks.
const RECORDINGS = [
  { label: 'EEGLAB 36ch / 250 Hz', url: 'https://s3.amazonaws.com/openneuro.org/ds002893/sub-001/eeg/sub-001_task-AuditoryVisualShift_run-01_eeg.set' },
  { label: 'EDF    82ch / 512 Hz', url: 'https://s3.amazonaws.com/openneuro.org/ds002034/sub-01/ses-01/eeg/sub-01_ses-01_task-offline_run-01_eeg.edf' },
  { label: 'BV     64ch / 5 kHz',  url: 'https://s3.amazonaws.com/openneuro.org/ds002336/sub-xp101/eeg/sub-xp101_task-motorloc_eeg.vhdr' },
];

const N_PANS = 8;
// Realistic dwell needs to exceed the typical readWindow time so
// prefetch lands before the next pan. 8 s covers BV 5 kHz pans
// (≈ 5 s reads); EEGLAB / EDF land much faster anyway.
const DWELL_MS_REALISTIC = 8000;

function quartiles(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const sum = s.reduce((a, b) => a + b, 0);
  return { n: s.length, mean: sum / s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] };
}

function fmtMs(stats) {
  if (!stats) return '—';
  return `n=${stats.n} mean=${stats.mean.toFixed(1)} p50=${stats.p50.toFixed(1)} p95=${stats.p95.toFixed(1)} max=${stats.max.toFixed(1)} ms`;
}

async function profile({ label, url }, page) {
  // Reset perf state per recording.
  await page.evaluate(() => {
    window.__perf = { draws: [], reads: [], net: [], decode: [], requests: 0, cacheHits: 0, cacheMisses: 0 };
  });

  // Wrap TraceRenderer.draw + reader.readWindow on the live globals
  // so we capture wall time on the actual hot path. We do this AFTER
  // the page scripts have loaded but BEFORE the URL-driven load runs,
  // by injecting via addInitScript on the page session.
  const t0 = Date.now();
  await page.goto(`http://localhost:8011/index.html?eeg=${encodeURIComponent(url)}`);
  await page.waitForFunction(() => window.__perf && window.__perf.draws.length > 0,
                             null, { timeout: 90_000 });
  const coldLoadMs = Date.now() - t0;

  // Two pan modes:
  //   1. INSTANT — keypress immediately after each draw lands.
  //      Stress pattern; prefetch can't help (no dwell time).
  //   2. REALISTIC — long dwell between keypresses so prefetch
  //      has time to land. This is what a user reading the data
  //      experiences.
  // We time each pan from keypress to next draw — that's the
  // user-perceived latency. readWindow timing alone is muddled by
  // prefetch reads that happen in the background.
  const instantLatencies = [];
  for (let i = 0; i < N_PANS; i++) {
    const before = await page.evaluate(() => window.__perf.draws.length);
    const t0 = Date.now();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(
      ({ before }) => window.__perf.draws.length > before,
      { before }, { timeout: 30_000 });
    instantLatencies.push(Date.now() - t0);
  }

  for (let i = 0; i < N_PANS; i++) await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(500);
  await page.evaluate(() => { window.__perf.cacheHits = 0; window.__perf.cacheMisses = 0; });

  const realisticLatencies = [];
  for (let i = 0; i < N_PANS; i++) {
    await page.waitForTimeout(DWELL_MS_REALISTIC);
    const before = await page.evaluate(() => window.__perf.draws.length);
    const t0 = Date.now();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(
      ({ before }) => window.__perf.draws.length > before,
      { before }, { timeout: 30_000 });
    realisticLatencies.push(Date.now() - t0);
  }

  const stats = await page.evaluate(() => ({
    draws:  window.__perf.draws.slice(),
    reads:  window.__perf.reads.slice(),
    decode: window.__perf.decode.slice(),
    cacheHits:   window.__perf.cacheHits,
    cacheMisses: window.__perf.cacheMisses,
    heap: performance.memory ? {
      used: performance.memory.usedJSHeapSize,
      total: performance.memory.totalJSHeapSize,
    } : null,
  }));

  // User-perceived pan latency: the wall time from keypress to the
  // next draw landing. This is what the user actually feels — read
  // timing alone is contaminated by background prefetch reads that
  // run concurrently with the foreground pan.
  const drawStats        = quartiles(stats.draws.slice(1));
  const instantPanStats  = quartiles(instantLatencies);
  const realisticPanStats = quartiles(realisticLatencies);
  const decodeStats      = quartiles(stats.decode.slice(1));
  console.log(`\n=== ${label} ===`);
  console.log(`  cold load:           ${coldLoadMs} ms (page → first paint)`);
  console.log(`  draw (warm):         ${fmtMs(drawStats)}`);
  console.log(`  pan INSTANT  (key→draw): ${fmtMs(instantPanStats)}`);
  console.log(`  pan REALISTIC(key→draw): ${fmtMs(realisticPanStats)}    (${DWELL_MS_REALISTIC} ms dwell)`);
  console.log(`    decode pure:       ${fmtMs(decodeStats)}`);
  console.log(`  cache (realistic):   ${stats.cacheHits} hits / ${stats.cacheMisses} misses`);
  if (stats.heap) {
    console.log(`  heap:                used ${(stats.heap.used / 1e6).toFixed(1)} MB / total ${(stats.heap.total / 1e6).toFixed(1)} MB`);
  }
  return { label, coldLoadMs, drawStats, instantPanStats, realisticPanStats, decodeStats, cache: stats, heap: stats.heap };
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
  });
  const page = await ctx.newPage();

  // Inject hooks BEFORE every navigation. We patch the production
  // globals once they're available — addInitScript runs before any
  // page script, but the globals don't exist yet at that point, so
  // we install a MutationObserver-style poller that wraps them on
  // first sight.
  await page.addInitScript(() => {
    window.__perf = { draws: [], reads: [], net: [], decode: [], requests: 0 };
    function wrap() {
      if (!window.TraceRenderer || !window.HttpRange || window.__perf._wrapped) return false;

      const origDraw = window.TraceRenderer.draw;
      window.TraceRenderer.draw = function(canvas, opts) {
        const t0 = performance.now();
        const out = origDraw(canvas, opts);
        window.__perf.draws.push(performance.now() - t0);
        return out;
      };

      // Time rangeFetch separately so we can split readWindow's wall
      // time into "network bytes coming back" vs "everything else"
      // (deinterleave loop + scale + buffer alloc). Whichever side
      // dominates is where any next perf work should land.
      const origRange = window.HttpRange.rangeFetch;
      window.HttpRange.rangeFetch = async function(...args) {
        const t0 = performance.now();
        const out = await origRange.apply(this, args);
        window.__perf.net.push(performance.now() - t0);
        return out;
      };

      for (const k of ['EEGLABReader', 'EDFReader', 'BrainVisionReader']) {
        const Reader = window[k];
        if (!Reader || !Reader.open) continue;
        const origOpen = Reader.open;
        Reader.open = async function(...args) {
          const reader = await origOpen.apply(this, args);
          const origReadWindow = reader.readWindow;
          reader.readWindow = async function(...rwArgs) {
            const netBefore = window.__perf.net.length;
            const t0 = performance.now();
            const r = await origReadWindow.apply(this, rwArgs);
            const totalMs = performance.now() - t0;
            // Network time is the SUM of every range call this read
            // made (tiles run in parallel, so sum ≥ wall). Decode is
            // total minus the tile-fetch wall (which we can't isolate
            // post-hoc without per-tile start/end stamps), so we use
            // the slowest tile as a proxy: the read can't finish
            // before that one resolves.
            const tileMs = window.__perf.net.slice(netBefore).reduce((a, b) => Math.max(a, b), 0);
            window.__perf.reads.push(totalMs);
            window.__perf.decode.push(Math.max(0, totalMs - tileMs));
            return r;
          };
          return reader;
        };
      }
      window.__perf._wrapped = true;
      return true;
    }
    const id = setInterval(() => { if (wrap()) clearInterval(id); }, 5);
  });

  let cdpClient, traceFile;
  if (WANT_CDP) {
    cdpClient = await ctx.newCDPSession(page);
    traceFile = 'perf-trace.json';
    await cdpClient.send('Tracing.start', {
      categories: 'devtools.timeline,blink,v8,disabled-by-default-v8.cpu_profiler',
      transferMode: 'ReturnAsStream',
    });
    console.log('[CDP] tracing started — output → perf-trace.json');
  }

  const results = [];
  for (const r of RECORDINGS) {
    results.push(await profile(r, page));
  }

  if (WANT_CDP) {
    const stream = await new Promise((resolve) => {
      cdpClient.once('Tracing.tracingComplete', (e) => resolve(e.stream));
      cdpClient.send('Tracing.end');
    });
    // Drain the stream into a JSON file.
    let buf = '';
    while (true) {
      const { data, eof } = await cdpClient.send('IO.read', { handle: stream });
      buf += data;
      if (eof) break;
    }
    await cdpClient.send('IO.close', { handle: stream });
    await writeFile(traceFile, buf);
    console.log(`[CDP] wrote ${traceFile} (${(buf.length / 1e6).toFixed(1)} MB) — load in chrome://tracing or https://www.speedscope.app`);
  }

  await browser.close();

  // Summary table — pan latency is key→draw wall time, the
  // user-perceived number. INSTANT shows worst-case (no dwell, no
  // prefetch help); REALISTIC shows what a reading user feels.
  console.log('\n=== summary (pan latency = key→draw wall time) ===');
  console.log('                          cold     draw95  pan INSTANT (worst case)  pan REALISTIC (post-prefetch)');
  for (const r of results) {
    const inst = r.instantPanStats;
    const real = r.realisticPanStats;
    console.log(`  ${r.label.padEnd(22)}  ${String(r.coldLoadMs).padStart(5)} ms  ${(r.drawStats?.p95 ?? 0).toFixed(1).padStart(5)} ms  ${(inst?.mean ?? 0).toFixed(0).padStart(5)} mean / ${(inst?.p95 ?? 0).toFixed(0).padStart(5)} p95   ${(real?.mean ?? 0).toFixed(0).padStart(5)} mean / ${(real?.p95 ?? 0).toFixed(0).padStart(5)} p95`);
  }
}

await main();
