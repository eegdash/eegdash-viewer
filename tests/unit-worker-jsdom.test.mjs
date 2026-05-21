// Smoke test: worker.js's logic surface is reachable under node:test
// via a `self` shim. Sets the floor for Stryker mutation coverage.
//
// worker.js cannot be loaded via importScripts() in node, so we:
//   1. Pre-shim `self` (postMessage + onmessage holder) and `importScripts`.
//   2. require() the same modules importScripts() would have loaded.
//   3. require() worker.js itself — its top-level code attaches an
//      onmessage handler to self and registers cross-module helpers.
//
// This is intentionally a thin smoke test. It exists to give Stryker
// a foothold on worker.js mutants; richer protocol coverage already
// lives in tests/unit-worker-{protocol,faults,cache,races}.test.mjs
// which use a contract re-implementation harness.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Shim the WebWorker globals BEFORE requiring worker.js. We use
// `self` (not `globalThis`) because worker.js's importScripts +
// onmessage attach to it.
const recordedMessages = [];
globalThis.self = {
  onmessage: null,
  postMessage(msg, transfer) {
    recordedMessages.push({ msg, transfer });
  },
};
// worker.js calls importScripts() at top — make it a no-op since
// we load deps via require() instead.
globalThis.importScripts = () => {};

// Load the dependency chain importScripts() normally loads.
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

test('worker.js: loads under self-shim without throwing', () => {
  assert.equal(typeof globalThis.self.onmessage, 'function',
    'worker.js must attach self.onmessage at load');
});

test('worker.js: INIT message gets INIT_OK reply', async () => {
  recordedMessages.length = 0;
  await globalThis.self.onmessage({ data: { type: 'INIT' } });
  assert.ok(recordedMessages.length >= 1, 'must reply to INIT');
  const reply = recordedMessages[0].msg;
  assert.equal(reply.type, 'INIT_OK');
  assert.ok(Array.isArray(reply.formats), 'INIT_OK must list supported formats');
  assert.ok(reply.formats.includes('edf'), 'edf must be supported');
  assert.ok(reply.formats.includes('fif'), 'fif must be supported');
});

test('worker.js: CANCEL_REQUEST marks the request cancelled (idempotent)', async () => {
  recordedMessages.length = 0;
  await globalThis.self.onmessage({ data: { type: 'CANCEL_REQUEST', request_id: 999 } });
  // CANCEL_REQUEST is now echoed as CANCELLED so the viewer can drop the
  // pendingRequests entry immediately (see tests/unit-worker-cancelled-ack).
  assert.equal(recordedMessages.length, 1);
  assert.equal(recordedMessages[0].msg.type, 'CANCELLED');
  assert.equal(recordedMessages[0].msg.request_id, 999);
  await globalThis.self.onmessage({ data: { type: 'CANCEL_REQUEST', request_id: 999 } });
  assert.equal(recordedMessages.length, 2);
  assert.equal(recordedMessages[1].msg.type, 'CANCELLED');
});
