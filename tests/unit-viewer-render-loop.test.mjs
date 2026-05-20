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

// GAP: Two distinct startSec values that both land in the tail-clamp region
// (start beyond the last full-window position) must collapse to the SAME cache
// key. Without this, rapidly pressing ArrowRight near the end of a recording
// would re-fetch the same tail window from the worker on every press — wasting
// network and triggering an unnecessary streaming render cascade (the original
// ghost-trace failure mode this test suite locks down).
//
// Note: this test asserts on the IDEAL contract — that any startSec >=
// (duration_s - window_sec) collapses to the same key. The live viewer's
// cacheKey is derived from `Math.round(startSec * fs)` AFTER `clampStart`,
// so we must apply clampStart first when forming the key for tail-region
// requests. We model both: the raw formula (which would diverge on different
// in-tail startSec values) and the post-clamp formula (which collapses).
function clampedCacheKey(startSec, windowSec, fs, totalSamples, durationSec) {
  const clamped = clampStart(startSec, durationSec, windowSec);
  return cacheKey(clamped, windowSec, fs, totalSamples);
}

test('cacheKey: distinct in-tail startSec values collapse to the same key (cache hit)', () => {
  // 100s / 500Hz / 50000 samples. window_sec=5 → maxStart = 95s.
  // Three distinct user-input startSec values all live in the tail-clamp
  // region: 96, 98, 200. After clampStart they all become 95s, so the
  // cache key MUST be identical. Without this, rapid panning past the end
  // would never hit the read cache and would re-stream every keypress.
  const k96  = clampedCacheKey(96,  5, 500, 50_000, 100);
  const k98  = clampedCacheKey(98,  5, 500, 50_000, 100);
  const k200 = clampedCacheKey(200, 5, 500, 50_000, 100);
  assert.equal(k96, k98,
    `tail-clamped startSec=96 and startSec=98 must produce the same key — ` +
    `otherwise the cache misses on every press near end-of-recording. Got ${k96} vs ${k98}.`);
  assert.equal(k98, k200,
    `pan-past-end (startSec=200) must clamp to the same tail key as startSec=98. ` +
    `Got ${k200} vs ${k98}.`);
  // And the key must be the canonical full-window tail key, not a partial.
  assert.equal(k96, '47500-2500',
    `tail-clamp key must reflect startSample=95*500=47500 and a FULL window (2500). ` +
    `Got "${k96}".`);
});
