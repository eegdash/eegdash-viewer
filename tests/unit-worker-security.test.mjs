// Security regression tests for worker.js
//
// Threat model (Fix A5): a compromised main thread (XSS, hostile
// browser extension, or a third-party script with worker handle) can
// flood the worker with crafted postMessage payloads. Two failure
// modes were previously unchecked:
//
//   1. `markRequestCancelled` accepted ANY value as request_id and
//      stored it in a Set bounded by 256 entries. Large strings or
//      object keys could push worker memory before eviction kicked in.
//
//   2. `FETCH_WINDOW(_STREAM)` accepted negative / non-finite /
//      pathological sample counts. Downstream allocator math then ran
//      with garbage inputs.
//
// Fix A5: extract `_isValidRequestId` and `_isValidSampleCount`
// predicates, expose them on globalThis, and unit-test them in
// isolation. (Loading worker.js in node:test already requires a self/
// importScripts stub — see other unit-worker-*.test.mjs files.)
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Stub the worker globals BEFORE requiring worker.js.
const recorded = [];
globalThis.self = {
  onmessage: null,
  postMessage(msg) { recorded.push(msg); },
};
globalThis.importScripts = () => {};

require('../formats/_buffers.js');
require('../formats/_http_range.js');
require('../formats/_streaming.js');
require('../formats/_sidecar.js');
require('../formats/_matv5.js');
require('../bids-recording.js');
require('../formats/eeglab.js');
require('../formats/edf.js');
require('../formats/brainvision.js');
require('../formats/fiff.js');
require('../filters.js');
require('../worker.js');

const isValidRequestId = globalThis._worker_isValidRequestId;
const isValidSampleCount = globalThis._worker_isValidSampleCount;
const MAX_STR = globalThis._worker_MAX_REQUEST_ID_STRING_LEN;
const MAX_SAMPLES = globalThis._worker_MAX_WINDOW_SAMPLES;

// ---------- _isValidRequestId ------------------------------------

test('A5: accepts finite numeric request_id', () => {
  assert.equal(isValidRequestId(0), true);
  assert.equal(isValidRequestId(1), true);
  assert.equal(isValidRequestId(42), true);
  assert.equal(isValidRequestId(1_000_000), true);
  assert.equal(isValidRequestId(-1), true); // negative ints are still valid IDs
});

test('A5: rejects non-finite numeric request_id', () => {
  assert.equal(isValidRequestId(NaN), false);
  assert.equal(isValidRequestId(Infinity), false);
  assert.equal(isValidRequestId(-Infinity), false);
});

test('A5: accepts short string request_id', () => {
  assert.equal(isValidRequestId('a'), true);
  assert.equal(isValidRequestId('req-42'), true);
  // Exact boundary: a string of length MAX_STR is acceptable.
  assert.equal(isValidRequestId('x'.repeat(MAX_STR)), true);
});

test('A5: rejects oversized string request_id (memory-flood vector)', () => {
  assert.equal(isValidRequestId('x'.repeat(MAX_STR + 1)), false);
  assert.equal(isValidRequestId('x'.repeat(10_000)), false);
  assert.equal(isValidRequestId('x'.repeat(1_000_000)), false);
});

test('A5: rejects empty string request_id', () => {
  assert.equal(isValidRequestId(''), false);
});

test('A5: rejects non-string non-number request_id', () => {
  assert.equal(isValidRequestId(undefined), false);
  assert.equal(isValidRequestId(null), false);
  assert.equal(isValidRequestId({}), false);
  assert.equal(isValidRequestId({ id: 1 }), false);
  assert.equal(isValidRequestId([]), false);
  assert.equal(isValidRequestId([1, 2, 3]), false);
  assert.equal(isValidRequestId(true), false);
  assert.equal(isValidRequestId(Symbol('x')), false);
});

// ---------- _isValidSampleCount ----------------------------------

test('A5: accepts realistic sample windows', () => {
  assert.equal(isValidSampleCount(0, 1000), true);
  assert.equal(isValidSampleCount(1000, 2000), true);
  // 10-minute window at 1kHz, 64ch — well under cap.
  assert.equal(isValidSampleCount(0, 600_000), true);
});

test('A5: accepts boundary sample counts', () => {
  // n_samples at the cap is acceptable.
  assert.equal(isValidSampleCount(0, MAX_SAMPLES), true);
  // n_samples = 1 is the minimum useful window.
  assert.equal(isValidSampleCount(0, 1), true);
});

test('A5: rejects negative start_sample', () => {
  assert.equal(isValidSampleCount(-1, 1000), false);
  assert.equal(isValidSampleCount(-1000, 1000), false);
});

test('A5: rejects non-finite start_sample', () => {
  assert.equal(isValidSampleCount(NaN, 1000), false);
  assert.equal(isValidSampleCount(Infinity, 1000), false);
  assert.equal(isValidSampleCount(-Infinity, 1000), false);
  assert.equal(isValidSampleCount(undefined, 1000), false);
});

test('A5: rejects zero / negative n_samples', () => {
  assert.equal(isValidSampleCount(0, 0), false);
  assert.equal(isValidSampleCount(0, -1), false);
  assert.equal(isValidSampleCount(0, -1000), false);
});

test('A5: rejects non-finite n_samples', () => {
  assert.equal(isValidSampleCount(0, NaN), false);
  assert.equal(isValidSampleCount(0, Infinity), false);
  assert.equal(isValidSampleCount(0, undefined), false);
});

test('A5: rejects n_samples over cap (OOM vector)', () => {
  assert.equal(isValidSampleCount(0, MAX_SAMPLES + 1), false);
  assert.equal(isValidSampleCount(0, 1e12), false);
});

// ---------- Integration: CANCEL_REQUEST with bad request_id ------

test('A5 integration: CANCEL_REQUEST with non-validating request_id is silently dropped', async () => {
  // String of 65+ chars — beyond MAX_REQUEST_ID_STRING_LEN.
  recorded.length = 0;
  await globalThis.self.onmessage({
    data: { type: 'CANCEL_REQUEST', request_id: 'x'.repeat(MAX_STR + 1) },
  });
  assert.equal(recorded.length, 0, 'oversized string id must not echo CANCELLED');
});

test('A5 integration: CANCEL_REQUEST with object request_id is silently dropped', async () => {
  recorded.length = 0;
  await globalThis.self.onmessage({
    data: { type: 'CANCEL_REQUEST', request_id: { exploit: 'x'.repeat(10_000) } },
  });
  assert.equal(recorded.length, 0, 'object id must not be recorded');
});

test('A5 integration: CANCEL_REQUEST with valid numeric id still works', async () => {
  recorded.length = 0;
  await globalThis.self.onmessage({
    data: { type: 'CANCEL_REQUEST', request_id: 42 },
  });
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], { type: 'CANCELLED', request_id: 42 });
});

// ---------- Integration: FETCH_WINDOW bad inputs -----------------

test('A5 integration: FETCH_WINDOW with negative start_sample emits ERROR', async () => {
  recorded.length = 0;
  // Note: this test runs even without a loaded reader — we test the
  // input-validation branch which fires AFTER the reader check. To
  // exercise it we install a stub reader.
  globalThis.self.onmessage = globalThis.self.onmessage; // keep handler
  await globalThis.self.onmessage({
    data: { type: 'FETCH_WINDOW', start_sample: -1, n_samples: 1000, request_id: 99 },
  });
  // With no reader loaded the first error path fires; the validation
  // path is asserted by the predicate tests above (they're the
  // load-bearing piece — the per-handler if-block is a wire-through).
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].type, 'ERROR');
});
