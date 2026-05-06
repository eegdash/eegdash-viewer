// Bench: is OpenNeuro S3 per-connection bandwidth-throttled, or
// is the slow 60s window pull an end-to-end thing? If parallel
// range requests are meaningfully faster than one big request,
// tile fetching at the reader level is worth implementing.
//
// We measure three patterns over the same total byte count from
// the same file:
//   1. Single 60s range fetch                 (current behaviour)
//   2. 6× 10s range fetches via Promise.all   (parallel, same conn)
//   3. 6× 10s range fetches sequentially      (control: serialised)
//
// Run with:  node scripts/bench-fetch.mjs
import { performance } from 'node:perf_hooks';

const URL = 'https://s3.amazonaws.com/openneuro.org/ds002336/sub-xp101/eeg/sub-xp101_task-motorloc_eeg.eeg';
const FS = 5000;
const N_CH = 64;
const BPS = 2;

// 60 s × 64 ch × 5 kHz × 2 B = 38_400_000 B
const BYTES_PER_SECOND = N_CH * FS * BPS;
const TOTAL_SECONDS = 60;
const TILE_SECONDS = 10;
const TOTAL_BYTES = TOTAL_SECONDS * BYTES_PER_SECOND;
const TILE_BYTES = TILE_SECONDS * BYTES_PER_SECOND;
const N_TILES = TOTAL_SECONDS / TILE_SECONDS;

// Use a different absolute byte offset on each pattern so the HTTP
// cache doesn't make a later run look fast. Each starts at minute 0,
// 1, and 2 of the recording respectively (the file is ~340 s long).
async function fetchRange(byteStart, byteEnd) {
  const r = await fetch(URL, { headers: { Range: `bytes=${byteStart}-${byteEnd}` } });
  if (r.status !== 206 && r.status !== 200) {
    throw new Error(`HTTP ${r.status}`);
  }
  const buf = await r.arrayBuffer();
  if (buf.byteLength !== byteEnd - byteStart + 1) {
    throw new Error(`expected ${byteEnd - byteStart + 1} B, got ${buf.byteLength}`);
  }
  return buf.byteLength;
}

async function patternSingle(originSec) {
  const start = originSec * BYTES_PER_SECOND;
  const t0 = performance.now();
  const got = await fetchRange(start, start + TOTAL_BYTES - 1);
  return { ms: performance.now() - t0, bytes: got };
}

async function patternParallel(originSec) {
  const start = originSec * BYTES_PER_SECOND;
  const t0 = performance.now();
  const promises = [];
  for (let i = 0; i < N_TILES; i++) {
    const a = start + i * TILE_BYTES;
    promises.push(fetchRange(a, a + TILE_BYTES - 1));
  }
  const sizes = await Promise.all(promises);
  return { ms: performance.now() - t0, bytes: sizes.reduce((s, b) => s + b, 0) };
}

async function patternSequential(originSec) {
  const start = originSec * BYTES_PER_SECOND;
  const t0 = performance.now();
  let bytes = 0;
  for (let i = 0; i < N_TILES; i++) {
    const a = start + i * TILE_BYTES;
    bytes += await fetchRange(a, a + TILE_BYTES - 1);
  }
  return { ms: performance.now() - t0, bytes };
}

function fmt({ ms, bytes }) {
  const mbps = (bytes / 1e6) / (ms / 1000);
  return `${(bytes / 1e6).toFixed(1)} MB · ${ms.toFixed(0)} ms · ${mbps.toFixed(2)} MB/s`;
}

(async function () {
  console.log(`URL: ${URL}`);
  console.log(`Each run pulls ${(TOTAL_BYTES / 1e6).toFixed(1)} MB total.\n`);

  // Origins differ so the HTTP cache can't fake a result — each test
  // hits bytes the prior tests didn't touch.
  const single = await patternSingle(0);
  console.log(`1) single ${TOTAL_SECONDS}s range:   ${fmt(single)}`);

  const parallel = await patternParallel(60);
  console.log(`2) ${N_TILES}× ${TILE_SECONDS}s parallel:        ${fmt(parallel)}`);

  const sequential = await patternSequential(120);
  console.log(`3) ${N_TILES}× ${TILE_SECONDS}s sequential:      ${fmt(sequential)}`);

  console.log('\nspeedup of parallel over single:    ' + (single.ms / parallel.ms).toFixed(2) + '×');
  console.log('speedup of parallel over sequential: ' + (sequential.ms / parallel.ms).toFixed(2) + '×');
})();
