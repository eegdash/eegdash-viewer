// EEGLAB-specific unit tests for pure helpers exposed via the
// `_classifyDurationMismatch` test hook. The main `open()` path is
// covered end-to-end by tests/eeglab.test.mjs against ds002893; this
// file pins down the corner cases the integration test can't reach
// from a single recording (epoched .fdt detection, bad declared
// durations, near-zero comparisons).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EEGLABReader } from './_bootstrap.mjs';

const classify = EEGLABReader._classifyDurationMismatch;

test('classifyDurationMismatch: declared null → no-declared', () => {
  assert.deepEqual(classify(100, null), { kind: 'no-declared' });
});

test('classifyDurationMismatch: declared <= 0 → no-declared (avoids div by 0)', () => {
  assert.deepEqual(classify(100, 0), { kind: 'no-declared' });
  assert.deepEqual(classify(100, -5), { kind: 'no-declared' });
});

test('classifyDurationMismatch: file ≈ declared (within 10 ms) → ok', () => {
  assert.deepEqual(classify(100.005, 100), { kind: 'ok' });
});

test('classifyDurationMismatch: file is integer multiple → epoched', () => {
  // 5×120-second trials → 600s file, sidecar declares the per-trial
  // length. Detect the integer ratio so the reader can warn instead
  // of just shrugging at the size mismatch.
  const r = classify(600, 120);
  assert.equal(r.kind, 'epoched');
  assert.equal(r.trials, 5);
});

test('classifyDurationMismatch: file ≈ 2× declared with rounding noise → epoched', () => {
  // mne writes durations to 1 ms precision so sometimes 2×120.001
  // shows up as 240.002. Should still classify as epoched-with-2-trials.
  const r = classify(240.002, 120);
  assert.equal(r.kind, 'epoched');
  assert.equal(r.trials, 2);
});

test('classifyDurationMismatch: file 1.3× declared → mismatch (not epoched)', () => {
  // Non-integer ratio means it's not an epoched file with whole trials;
  // surface as a mismatch warning so the user sees it.
  assert.equal(classify(130, 100).kind, 'mismatch');
});

test('classifyDurationMismatch: file shorter than declared → mismatch', () => {
  assert.equal(classify(50, 100).kind, 'mismatch');
});
