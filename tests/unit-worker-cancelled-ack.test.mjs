// Cancellation acknowledgement protocol round-trip.
// viewer sends CANCEL_REQUEST{id} → worker replies CANCELLED{id}.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

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

test('worker: CANCEL_REQUEST is echoed as CANCELLED with same request_id', async () => {
  recorded.length = 0;
  await globalThis.self.onmessage({ data: { type: 'CANCEL_REQUEST', request_id: 42 } });
  assert.equal(recorded.length, 1, 'must produce exactly one reply');
  assert.deepEqual(recorded[0], { type: 'CANCELLED', request_id: 42 });
});

test('worker: CANCEL_REQUEST without request_id is silently dropped', async () => {
  recorded.length = 0;
  await globalThis.self.onmessage({ data: { type: 'CANCEL_REQUEST' } });
  assert.equal(recorded.length, 0, 'must not echo when request_id is missing');
});

test('worker: duplicate CANCEL_REQUEST produces a CANCELLED reply each time (idempotent)', async () => {
  recorded.length = 0;
  await globalThis.self.onmessage({ data: { type: 'CANCEL_REQUEST', request_id: 7 } });
  await globalThis.self.onmessage({ data: { type: 'CANCEL_REQUEST', request_id: 7 } });
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].type, 'CANCELLED');
  assert.equal(recorded[1].type, 'CANCELLED');
});
