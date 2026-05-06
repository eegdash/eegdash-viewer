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
});
