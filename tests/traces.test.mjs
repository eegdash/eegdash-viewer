// Pure-math helpers in traces.js — meanStd + decimateMinMax.
// The drawing path needs a browser to verify visually; these are
// the parts that produce wrong pixels even when they don't crash.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// traces.js wants `window` for the legacy global; satisfy it once.
globalThis.window = globalThis.window || {};
const TraceRenderer = require('../traces.js');

test('meanStd', async (t) => {
  await t.test('constant series → mean=value, std=0', () => {
    const r = TraceRenderer.meanStd(new Float32Array([1, 1, 1, 1]), 4);
    assert.equal(r.mean, 1);
    assert.ok(Math.abs(r.std) < 1e-6);
  });
  await t.test('±1 alternating → mean≈0, std≈1', () => {
    const r = TraceRenderer.meanStd(new Float32Array([-1, 1, -1, 1, -1, 1, -1, 1]), 8);
    assert.ok(Math.abs(r.mean) < 1e-6);
    assert.ok(Math.abs(r.std - 1) < 1e-6);
  });
  await t.test('empty input is safe', () => {
    const r = TraceRenderer.meanStd(new Float32Array(0), 0);
    assert.equal(r.mean, 0);
    assert.equal(r.std, 0);
  });

  // --- Edge-case additions ---

  await t.test('single sample → mean=value, std=0', () => {
    // n=1: variance = ss/1 - mean^2 = v^2 - v^2 = 0. No NaN from
    // division. Catches the off-by-one variant where `n-1` is used.
    const r = TraceRenderer.meanStd(new Float32Array([42]), 1);
    assert.ok(Math.abs(r.mean - 42) < 1e-4);
    assert.ok(Math.abs(r.std) < 1e-4, `std was ${r.std}`);
  });

  await t.test('all-NaN input propagates NaN cleanly (does not throw)', () => {
    // Float32Array of NaN — meanStd must return without throwing.
    // The EEG viewer skips rendering when std<=0, so NaN std is fine
    // as long as it does not crash. We only assert no exception here.
    const data = new Float32Array([NaN, NaN, NaN]);
    let threw = false;
    try { TraceRenderer.meanStd(data, 3); } catch { threw = true; }
    assert.ok(!threw, 'meanStd should not throw on all-NaN input');
  });

  await t.test('mixed NaN/finite: n covers only finite-prefix in array', () => {
    // Caller controls n; if n=2 only first 2 elements are used even if
    // array is longer. This guards against accidental out-of-bounds reads.
    const data = new Float32Array([3, 7, NaN, 9999]);
    const r = TraceRenderer.meanStd(data, 2);
    assert.ok(Math.abs(r.mean - 5) < 1e-4, `mean was ${r.mean}`);
    // std of [3,7] around mean 5: variance = (4+4)/2 = 4 → std=2
    assert.ok(Math.abs(r.std - 2) < 1e-3, `std was ${r.std}`);
  });

  await t.test('extreme dynamic range (1e-10 to 1e10) does not produce NaN/Inf', () => {
    // Float32 loses precision at extremes but should not produce NaN std.
    const data = new Float32Array([1e-10, 1e10]);
    const r = TraceRenderer.meanStd(data, 2);
    assert.ok(isFinite(r.mean), `mean was ${r.mean}`);
    // std may lose all precision at Float32 dynamic range limits — just
    // ensure it is non-negative and finite (not NaN/Inf).
    assert.ok(isFinite(r.std) && r.std >= 0, `std was ${r.std}`);
  });

  await t.test('n=0 on non-empty array returns {mean:0, std:0} guard', () => {
    // Callers may legitimately pass n=0 when a channel has zero visible
    // samples. The guard must short-circuit regardless of array content.
    const r = TraceRenderer.meanStd(new Float32Array([99, 88]), 0);
    assert.equal(r.mean, 0);
    assert.equal(r.std, 0);
  });

  await t.test('caching: second call with same reference + same n reuses stats', () => {
    // The WeakMap cache must return the exact same object on a re-call.
    const data = new Float32Array([1, 2, 3, 4]);
    const r1 = TraceRenderer.meanStd(data, 4);
    const r2 = TraceRenderer.meanStd(data, 4);
    assert.strictEqual(r1, r2, 'should be the same cached object');
  });
});

test('decimateMinMax', async (t) => {
  await t.test('aligned 8 samples → 4 buckets of 2', () => {
    const data = new Float32Array([1, 3, 5, 7, 2, 4, -2, 0]);
    const { mn, mx } = TraceRenderer.decimateMinMax(data, 8, 4);
    assert.deepEqual(Array.from(mn).slice(0, 4), [1, 5, 2, -2]);
    assert.deepEqual(Array.from(mx).slice(0, 4), [3, 7, 4, 0]);
  });
  await t.test('preserves a single-sample spike inside the right bucket', () => {
    const data = new Float32Array(1000);
    data[50] = 10;
    const { mn, mx } = TraceRenderer.decimateMinMax(data, 1000, 100);
    assert.equal(mx[5], 10);
    assert.equal(mn[5], 0);
  });
  await t.test('sparse: pixels > samples does not NaN out', () => {
    const data = new Float32Array([5]);
    const { mn, mx } = TraceRenderer.decimateMinMax(data, 1, 4);
    assert.equal(mx[3], 5);
    assert.equal(mn[3], 5);
  });

  // --- Edge-case additions ---

  await t.test('window=1 pixel: single output bucket spans all samples', () => {
    // nPixels=1 forces a single bucket that must capture the global min/max.
    const data = new Float32Array([4, -3, 7, 1, -9, 2]);
    const { mn, mx } = TraceRenderer.decimateMinMax(data, 6, 1);
    assert.equal(mn[0], -9, `mn[0] was ${mn[0]}`);
    assert.equal(mx[0], 7,  `mx[0] was ${mx[0]}`);
  });

  await t.test('window > data: each pixel bucket still returns finite value', () => {
    // nPixels > n means most buckets map to the same (or adjacent) sample.
    // Catch the <= nWin off-by-one mutation: loop bound error would produce
    // an extra pixel read beyond the array, returning garbage or NaN.
    const data = new Float32Array([10, 20]);
    const { mn, mx } = TraceRenderer.decimateMinMax(data, 2, 8);
    for (let i = 0; i < 8; i++) {
      assert.ok(isFinite(mn[i]), `mn[${i}] was ${mn[i]}`);
      assert.ok(isFinite(mx[i]), `mx[${i}] was ${mx[i]}`);
    }
  });

  await t.test('n=0 or nPixels=0: returns buffers without throwing', () => {
    // Guard against divide-by-zero / empty input that callers can send
    // before data arrives.
    const data = new Float32Array([1, 2, 3]);
    let threw = false;
    try {
      TraceRenderer.decimateMinMax(data, 0, 4);
      TraceRenderer.decimateMinMax(data, 3, 0);
    } catch { threw = true; }
    assert.ok(!threw, 'decimateMinMax should not throw on n=0 or nPixels=0');
  });

  await t.test('output dimensions: mn and mx are at least nPixels long', () => {
    // The scratch buffer grows lazily. Assert the returned views are large
    // enough for the caller to index [0..nPixels-1] safely.
    const data = new Float32Array(512).fill(1);
    const { mn, mx } = TraceRenderer.decimateMinMax(data, 512, 200);
    assert.ok(mn.length >= 200, `mn.length=${mn.length}`);
    assert.ok(mx.length >= 200, `mx.length=${mx.length}`);
  });

  await t.test('negative values: min/max preserved correctly across buckets', () => {
    // Regression guard for sign inversion in inner loop.
    const data = new Float32Array([-5, -3, -10, -1]);
    const { mn, mx } = TraceRenderer.decimateMinMax(data, 4, 2);
    // bucket 0: [-5,-3] → min=-5, max=-3
    assert.equal(mn[0], -5, `mn[0] was ${mn[0]}`);
    assert.equal(mx[0], -3, `mx[0] was ${mx[0]}`);
    // bucket 1: [-10,-1] → min=-10, max=-1
    assert.equal(mn[1], -10, `mn[1] was ${mn[1]}`);
    assert.equal(mx[1], -1,  `mx[1] was ${mx[1]}`);
  });

  await t.test('large spike at last sample lands in final bucket', () => {
    // Catches off-by-one in bucket boundary: `(p === nPixels-1) ? n : ...`
    // If that guard is wrong, the last sample falls outside all buckets.
    const data = new Float32Array(100).fill(0);
    data[99] = 999;
    const { mx } = TraceRenderer.decimateMinMax(data, 100, 10);
    assert.equal(mx[9], 999, `mx[9] was ${mx[9]} — last-sample spike not captured`);
  });
});
