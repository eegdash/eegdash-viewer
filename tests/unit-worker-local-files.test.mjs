// unit-worker-local-files.test.mjs
// LOAD_FILE carries the main thread's local-blob registry (drag-drop /
// host-bridge files). The worker must register them before opening the
// reader — its HttpRange starts empty, and readers resolve
// localdrop.invalid URLs against it.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const recorded = [];
globalThis.self = { onmessage: null, postMessage(msg) { recorded.push(msg); } };
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

const HttpRange = globalThis.HttpRange;
const url = 'https://localdrop.invalid/sub-01_ses-02_task-x_emg.bdf';

test('worker LOAD_FILE registers local_files before opening the reader', async () => {
  const seen = [];
  const orig = globalThis.EDFReader.open;
  globalThis.EDFReader.open = async (meta) => {
    seen.push(await HttpRange.probeLength(meta.eeg_url));   // throws if unregistered
    return { n_channels: 1, sampling_frequency: 1, duration_s: 1, channel_labels: ['a'],
      bytes_per_sample: 3, n_samples: 1, readWindow: async () => [new Float32Array(1)] };
  };
  try {
    await globalThis.self.onmessage({ data: { type: 'LOAD_FILE', ext: 'bdf', eeg_url: url,
      sidecars: { eeg_url: url, ext: 'bdf', eeg_json: {}, channels: null },
      local_files: [{ name: 'sub-01_ses-02_task-x_emg.bdf', blob: new Blob([new Uint8Array(777)]) }] } });
  } finally { globalThis.EDFReader.open = orig; }
  assert.deepEqual(seen, [777]);
  assert.equal(recorded.at(-1).type, 'HEADER');
});

test('worker LOAD_FILE without local_files clears a stale registry', async () => {
  HttpRange.registerLocal('stale_emg.bdf', new Blob([new Uint8Array(3)]));
  const orig = globalThis.EDFReader.open;
  globalThis.EDFReader.open = async () => ({ n_channels: 1, sampling_frequency: 1, duration_s: 1,
    channel_labels: ['a'], bytes_per_sample: 3, n_samples: 1, readWindow: async () => [new Float32Array(1)] });
  try {
    await globalThis.self.onmessage({ data: { type: 'LOAD_FILE', ext: 'bdf', eeg_url: 'https://x.test/a_emg.bdf',
      sidecars: { eeg_url: 'https://x.test/a_emg.bdf', ext: 'bdf', eeg_json: {}, channels: null } } });
  } finally { globalThis.EDFReader.open = orig; }
  assert.equal(HttpRange.localEntries().length, 0);
});
