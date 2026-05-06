// Unit tests for the pure-math helpers in traces.js (decimateMinMax,
// meanStd). The drawing path needs a browser to verify visually; this
// covers the parts that produce wrong pixels even when they don't crash.
//
// Run: node scripts/smoke-traces.mjs
import { createRequire } from 'node:module';
import { makeChecker } from './_smoke_lib.mjs';

const require = createRequire(import.meta.url);
// traces.js wants `window` (for the legacy global) but exports via
// module.exports too; we fake a window stub for Node.
globalThis.window = globalThis.window || {};
const TraceRenderer = require('../traces.js');

const { check, summary } = makeChecker();

// ---- meanStd ----
{
  const a = new Float32Array([1, 1, 1, 1]);
  const r = TraceRenderer.meanStd(a, 4);
  check('meanStd constant: mean=1', Math.abs(r.mean - 1) < 1e-6);
  check('meanStd constant: std=0', Math.abs(r.std) < 1e-6);
}
{
  // {-1, 1} repeated → mean 0, stddev 1.
  const a = new Float32Array([-1, 1, -1, 1, -1, 1, -1, 1]);
  const r = TraceRenderer.meanStd(a, 8);
  check('meanStd ±1: mean≈0', Math.abs(r.mean) < 1e-6);
  check('meanStd ±1: std≈1', Math.abs(r.std - 1) < 1e-6);
}
{
  const r = TraceRenderer.meanStd(new Float32Array(0), 0);
  check('meanStd empty: mean=0', r.mean === 0);
  check('meanStd empty: std=0', r.std === 0);
}

// ---- decimateMinMax ----
{
  // n=8 samples into 4 buckets → each bucket holds 2 consecutive samples.
  // Buckets: [0,1] [2,3] [4,5] [6,7] → pairs (1,3) (5,7) (2,4) (-2,0)
  const data = new Float32Array([1, 3, 5, 7, 2, 4, -2, 0]);
  const { mn, mx } = TraceRenderer.decimateMinMax(data, 8, 4);
  const mnArr = Array.from(mn), mxArr = Array.from(mx);
  check('decimate min: bucket 0 = 1', mnArr[0] === 1);
  check('decimate max: bucket 0 = 3', mxArr[0] === 3);
  check('decimate min: bucket 1 = 5', mnArr[1] === 5);
  check('decimate max: bucket 1 = 7', mxArr[1] === 7);
  check('decimate min: bucket 2 = 2', mnArr[2] === 2);
  check('decimate max: bucket 2 = 4', mxArr[2] === 4);
  check('decimate min: bucket 3 = -2', mnArr[3] === -2);
  check('decimate max: bucket 3 = 0', mxArr[3] === 0);
}
{
  // Spike preservation: a 1-sample spike at index 50 in 1000 samples
  // decimated into 100 pixels lands in bucket 5 and must survive.
  const data = new Float32Array(1000);
  data[50] = 10;
  const { mn, mx } = TraceRenderer.decimateMinMax(data, 1000, 100);
  check('decimate preserves single-sample spike', mx[5] === 10);
  check('decimate keeps surrounding zero', mn[5] === 0);
}
{
  // n_pixels > n_samples isn't a typical render path (we'd polyline
  // instead), but the function shouldn't NaN out on it. Each bucket
  // covers ≤1 sample.
  const data = new Float32Array([5]);
  const { mn, mx } = TraceRenderer.decimateMinMax(data, 1, 4);
  check('decimate sparse: at least last bucket gets the value', mx[3] === 5 && mn[3] === 5);
}

summary();
