// unit-viewer-render-loop.test.mjs
//
// Contract tests for the render-loop logic inside viewer.js. Because
// viewer.js is an IIFE that does not export its internals, these are
// formula tests — they re-implement the small bits of math the live
// viewer uses and assert they behave as specified. If the live viewer
// drifts from the formula, the corresponding e2e test catches the
// behavioural difference; this layer catches the formula bug fast.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

function clampStart(secs, durationSec, windowSec) {
  // Mirrors the inline `clampStart` in viewer.js.
  const maxStart = Math.max(0, durationSec - windowSec);
  return Math.max(0, Math.min(maxStart, secs));
}

test('clampStart: holds start_sec >= 0', () => {
  assert.equal(clampStart(-5, 100, 10), 0);
});

test('clampStart: holds start_sec + window_sec <= duration_s', () => {
  assert.equal(clampStart(95, 100, 10), 90);
});

test('clampStart: window larger than recording clamps to 0', () => {
  assert.equal(clampStart(5, 10, 20), 0);
});

test('clampStart: identity on a valid in-range request', () => {
  assert.equal(clampStart(42.5, 100, 10), 42.5);
});

// Cache-key contract. requestRender builds `${startSample}-${windowSamples}`.
// Two pans to the same window must produce identical keys → cache hit.
function cacheKey(startSec, windowSec, fs, totalSamples) {
  const startSample = Math.max(0,
    Math.min(totalSamples - 1, Math.round(startSec * fs)));
  const windowSamples = Math.min(
    totalSamples - startSample,
    Math.round(windowSec * fs),
  );
  return `${startSample}-${windowSamples}`;
}

test('cacheKey: identical (start, window) → identical key', () => {
  const k1 = cacheKey(1.234, 5, 500, 50_000);
  const k2 = cacheKey(1.234, 5, 500, 50_000);
  assert.equal(k1, k2);
});

test('cacheKey: pan and pan-back → identical key', () => {
  const k1 = cacheKey(0.0, 5, 500, 50_000);
  const k2 = cacheKey(2.5, 5, 500, 50_000);
  const k3 = cacheKey(0.0, 5, 500, 50_000);
  assert.notEqual(k1, k2);
  assert.equal(k1, k3);
});

test('cacheKey: tail-clamp produces a shorter window key, not a phantom one', () => {
  // At t=99 with windowSec=5 on a 100s/500Hz recording (50000 samples), the
  // tail clamps: startSample=49500, windowSamples=500. The key reflects the
  // shorter window so a subsequent pan to the same edge hits the cache.
  const k = cacheKey(99, 5, 500, 50_000);
  assert.equal(k, '49500-500');
});
