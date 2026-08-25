// unit-worker-rpc-load.test.mjs
// A window/stream ERROR from a superseded recording carries its
// request_id; it must not reject the pending LOAD_FILE of the newer one.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

let instance = null;
globalThis.Worker = class {
  constructor() { this.sent = []; this.onmessage = null; this.onerror = null; instance = this; }
  postMessage(m) { this.sent.push(m); }
  terminate() {}
};
const { createWorkerRpc } = require('../viewer/worker-rpc.js');

test('rpc: an ERROR with a request_id leaves __LOAD__ pending', async () => {
  const rpc = createWorkerRpc({});
  const header = rpc.fetchHeader({ type: 'LOAD_FILE', ext: 'bdf', eeg_url: 'https://localdrop.invalid/b_emg.bdf', sidecars: {} });
  instance.onmessage({ data: { type: 'ERROR', request_id: 'stale-window-7', message: 'Local drop missing: a_emg.bdf' } });
  instance.onmessage({ data: { type: 'HEADER', n_channels: 1, sampling_frequency: 1, duration_s: 1 } });
  const h = await header;
  assert.equal(h.n_channels, 1, 'the newer load still resolves');
});

test('rpc: an ERROR without request_id rejects __LOAD__', async () => {
  const rpc = createWorkerRpc({});
  const header = rpc.fetchHeader({ type: 'LOAD_FILE', ext: 'xyz', eeg_url: 'x', sidecars: {} });
  instance.onmessage({ data: { type: 'ERROR', request_id: null, message: 'No reader for *.xyz' } });
  await assert.rejects(header, /No reader/);
});
