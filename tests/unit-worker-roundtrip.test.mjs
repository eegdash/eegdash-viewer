// tests/unit-worker-roundtrip.test.mjs
//
// Dispatches real messages through worker.js's actual self.onmessage
// handler (via the self-shim from unit-worker-jsdom). Drives:
//   INIT         → INIT_OK
//   LOAD_FILE    → HEADER (via a mocked-in-READERS reader)
//   FETCH_WINDOW → WINDOW (real reader.readWindow path)
//   APPLY_FILTER → FILTERED
//   post-filter FETCH_WINDOW with filter applied
//
// The mock reader is injected by monkey-patching globalThis.EDFReader.open.
// worker.js's READERS map captures the MODULE OBJECT reference at IIFE
// load time, then looks up `readerModule.open(sidecars)` at handler time
// — so a runtime mutation of EDFReader.open is visible to the handler.
// (Verified in worker.js around lines 39-46 + 178-211.)

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const recordedMessages = [];
globalThis.self = {
  onmessage: null,
  postMessage(msg, transfer) { recordedMessages.push({ msg, transfer }); },
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

// READERS[edf] === globalThis.EDFReader (the module object), so
// replacing EDFReader.open at runtime is visible to the LOAD_FILE handler.
const realEDFOpen = globalThis.EDFReader.open;

function makeMockReader({ n_channels = 2, n_samples = 1000, sampling_frequency = 250 } = {}) {
  return {
    n_channels,
    sampling_frequency,
    duration_s: n_samples / sampling_frequency,
    channel_labels: Array.from({ length: n_channels }, (_, i) => `Ch${i + 1}`),
    bytes_per_sample: 2,
    n_samples,
    recording_start_iso: null,
    annotation_events: null,
    async readWindow(start, n) {
      const out = [];
      const len = Math.max(0, Math.min(n, n_samples - start));
      for (let c = 0; c < n_channels; c++) {
        const d = new Float32Array(len);
        for (let i = 0; i < d.length; i++) d[i] = Math.sin((start + i) * 0.1 + c) * 10;
        out.push(d);
      }
      return out;
    },
  };
}

test('worker: INIT → INIT_OK', async () => {
  recordedMessages.length = 0;
  await globalThis.self.onmessage({ data: { type: 'INIT' } });
  assert.equal(recordedMessages[0].msg.type, 'INIT_OK');
  assert.ok(Array.isArray(recordedMessages[0].msg.formats));
});

test('worker: LOAD_FILE (mocked EDFReader.open) → HEADER reply', async () => {
  recordedMessages.length = 0;
  globalThis.EDFReader.open = async () => makeMockReader({ n_channels: 4, n_samples: 2500 });
  try {
    await globalThis.self.onmessage({ data: {
      type: 'LOAD_FILE',
      ext: 'edf',
      eeg_url: 'https://example.com/foo.edf',
      sidecars: { eeg_url: 'https://example.com/foo.edf', ext: 'edf' },
    } });
  } finally {
    globalThis.EDFReader.open = realEDFOpen;
  }
  assert.equal(recordedMessages[0].msg.type, 'HEADER');
  assert.equal(recordedMessages[0].msg.n_channels, 4);
  assert.equal(recordedMessages[0].msg.n_samples, 2500);
  assert.equal(recordedMessages[0].msg.sampling_frequency, 250);
});

test('worker: FETCH_WINDOW after LOAD_FILE → WINDOW with 4 Float32Arrays', async () => {
  recordedMessages.length = 0;
  globalThis.EDFReader.open = async () => makeMockReader({ n_channels: 4, n_samples: 2500 });
  try {
    await globalThis.self.onmessage({ data: {
      type: 'LOAD_FILE', ext: 'edf', eeg_url: 'https://example.com/foo.edf',
      sidecars: { eeg_url: 'https://example.com/foo.edf', ext: 'edf' },
    } });
  } finally {
    globalThis.EDFReader.open = realEDFOpen;
  }
  recordedMessages.length = 0;
  await globalThis.self.onmessage({ data: {
    type: 'FETCH_WINDOW', start_sample: 0, n_samples: 100, request_id: 1,
  } });
  const reply = recordedMessages[0].msg;
  assert.equal(reply.type, 'WINDOW');
  assert.equal(reply.request_id, 1);
  assert.equal(reply.channels.length, 4);
  assert.ok(reply.channels[0] instanceof Float32Array);
  assert.equal(reply.channels[0].length, 100);
});

test('worker: APPLY_FILTER → FILTERED ack', async () => {
  recordedMessages.length = 0;
  globalThis.EDFReader.open = async () => makeMockReader();
  try {
    await globalThis.self.onmessage({ data: {
      type: 'LOAD_FILE', ext: 'edf', eeg_url: 'x',
      sidecars: { eeg_url: 'x', ext: 'edf' },
    } });
  } finally {
    globalThis.EDFReader.open = realEDFOpen;
  }
  recordedMessages.length = 0;
  await globalThis.self.onmessage({ data: {
    type: 'APPLY_FILTER',
    filters: [{ kind: 'highpass', cutoff_hz: 0.5 }],
  } });
  assert.equal(recordedMessages[0].msg.type, 'FILTERED');
  assert.ok(recordedMessages[0].msg.filter_id.includes('highpass'));
});

test('worker: FETCH_WINDOW after APPLY_FILTER applies the filter chain', async () => {
  recordedMessages.length = 0;
  globalThis.EDFReader.open = async () => makeMockReader();
  try {
    await globalThis.self.onmessage({ data: {
      type: 'LOAD_FILE', ext: 'edf', eeg_url: 'x',
      sidecars: { eeg_url: 'x', ext: 'edf' },
    } });
  } finally {
    globalThis.EDFReader.open = realEDFOpen;
  }
  await globalThis.self.onmessage({ data: {
    type: 'APPLY_FILTER',
    filters: [{ kind: 'highpass', cutoff_hz: 0.5 }],
  } });
  recordedMessages.length = 0;
  await globalThis.self.onmessage({ data: {
    type: 'FETCH_WINDOW', start_sample: 0, n_samples: 200, request_id: 2,
  } });
  const reply = recordedMessages[0].msg;
  assert.equal(reply.type, 'WINDOW');
  // Crude check: the mock signal is sin(...) * 10 — no DC component,
  // so we mainly verify the filter path didn't crash and still
  // produced n channels of Float32Arrays.
  assert.equal(reply.channels.length, 2);
  assert.ok(reply.channels[0] instanceof Float32Array);
});
