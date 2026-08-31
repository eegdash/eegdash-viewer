// tests/unit-viewer-bridge.test.mjs
// Host-page bridge: a `message` event carrying File objects must take
// the same road as drag-drop — register local blobs, then load().
// Harness mirrors unit-viewer-boot.test.mjs (jsdom + stub Worker +
// 404 fetch stub for the sidecar walk).
import './_jsdom-bootstrap.mjs';
import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.location = globalThis.window.location;
const stage = globalThis.document.createElement('main');
stage.id = 'stage';
globalThis.document.body.appendChild(stage);
for (const id of ['shortcuts-overlay', 'metadata-overlay']) {
  const el = globalThis.document.getElementById(id);
  if (el && !el.querySelector('.overlay-backdrop')) {
    const backdrop = globalThis.document.createElement('div');
    backdrop.className = 'overlay-backdrop';
    const close = globalThis.document.createElement('button');
    close.className = 'overlay-close';
    el.appendChild(backdrop);
    el.appendChild(close);
  }
}
globalThis.fetch = async () => new Response('', { status: 404, statusText: 'Not Found' });
let workerInstance = null;
globalThis.Worker = class {
  constructor() { this.sent = []; workerInstance = this; }
  postMessage(msg) {
    this.sent.push(msg);
    if (msg && msg.type === 'INIT') {
      queueMicrotask(() => this.onmessage && this.onmessage({
        data: { type: 'INIT_OK', formats: ['edf', 'bdf', 'set', 'vhdr'] } }));
    }
  }
  terminate() {}
};
process.on('unhandledRejection', () => {});

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
require('../traces.js');
require('../filters.js');
require('../pose-panel.js');
require('../stimulus-panel.js');
require('../viewer.js');

const Viewer = globalThis.window.Viewer;
const HttpRange = globalThis.HttpRange;
const PosePanel = globalThis.PosePanel;

// Bridge messages arrive as MessageEvents on `window`; viewer.js listens
// on globalThis, which the jsdom bootstrap aliases to `dom.window`
// (globalThis.window). Dispatch on the same object.
function post(data) {
  const ev = new globalThis.window.MessageEvent('message', { data });
  globalThis.window.dispatchEvent(ev);
}

before(() => {
  globalThis.window.history.replaceState({}, '', '/?embed=1');
  Viewer.boot({});
});

test('bridge: open message registers the file locally and starts load()', async () => {
  const file = new globalThis.window.File([new Uint8Array(512)], 'sub-01_task-x_emg.bdf');
  post({ type: 'eegdash-viewer:open', files: [file] });
  await new Promise(r => setTimeout(r, 20));
  const url = 'https://localdrop.invalid/sub-01_task-x_emg.bdf';
  assert.equal(await HttpRange.probeLength(url), 512, 'blob registered');
  const status = globalThis.document.getElementById('status').textContent;
  assert.match(status, /sub-01_task-x_emg\.bdf/, `status names the modality: ${status}`);
  // The worker owns a separate registry: LOAD_FILE must carry the blobs.
  const load = workerInstance.sent.find(m => m.type === 'LOAD_FILE');
  assert.ok(load, 'LOAD_FILE sent');
  assert.deepEqual(load.local_files.map(f => f.name), ['sub-01_task-x_emg.bdf']);
  assert.equal(load.local_files[0].blob.size, 512);
});

test('bridge keeps image blobs out of the EEG worker', async () => {
  const edf = new globalThis.window.File([new Uint8Array(512)], 'sub-05_task-images_eeg.edf');
  const jpegBlob = new Blob(['real-image-bytes'], { type: 'image/jpeg' });
  post({
    type: 'eegdash-viewer:open',
    files: [edf],
    stimuli: { '16595': jpegBlob },
  });
  await new Promise(r => setTimeout(r, 20));

  const workerLoad = workerInstance.sent.filter(m => m.type === 'LOAD_FILE').at(-1);
  assert.ok(workerLoad, 'LOAD_FILE sent');
  assert.equal(workerLoad.local_files.some(file => file.name.endsWith('.jpg')), false);

  const caption = globalThis.document.querySelector('#stimulus-caption');
  assert.ok(caption, 'stimulus dock is mounted');
  globalThis.StimulusPanel.syncWindow([
    { onset: 1.5, stimulus_id: '16595', label: 'stim_test,16595,-1,1' },
  ], 1.5);
  assert.match(caption.textContent, /16595/);
});

test('an invalid image Blob hides only the active stimulus source', () => {
  const StimulusPanel = globalThis.StimulusPanel;
  StimulusPanel.clear();
  const originalRevoke = globalThis.URL.revokeObjectURL;
  const revoked = [];
  globalThis.URL.revokeObjectURL = (url) => {
    revoked.push(url);
    originalRevoke.call(globalThis.URL, url);
  };
  try {
    const events = [
      { onset: 0.25, stimulus_id: '16595', label: 'stim_test,16595,-1,1' },
      { onset: 1.50, stimulus_id: '16596', label: 'stim_test,16596,-1,2' },
    ];
    StimulusPanel.setAssets({
      '16595': new Blob(['not a JPEG'], { type: 'image/jpeg' }),
      '16596': new Blob(['still not a JPEG'], { type: 'image/jpeg' }),
    });
    StimulusPanel.syncCursor(events, 0.25);

    const panel = globalThis.document.querySelector('#stimulus-panel');
    const image = globalThis.document.querySelector('#stimulus-image');
    const staleError = image.onerror;
    assert.equal(typeof staleError, 'function', 'images install an error handler');
    const firstSource = image.src;

    StimulusPanel.syncCursor(events, 1.50);
    const secondSource = image.src;
    assert.notEqual(secondSource, firstSource, 'second stimulus has its own object URL');
    staleError.call(image, new globalThis.window.Event('error'));
    assert.equal(panel.hidden, false, 'an error from the replaced source must not hide the active image');
    assert.equal(image.dataset.stimulusId, '16596');
    assert.deepEqual(revoked, [firstSource]);

    image.dispatchEvent(new globalThis.window.Event('error'));
    assert.equal(panel.hidden, true, 'the active invalid image hides the dock');
    assert.deepEqual(revoked, [firstSource, secondSource]);
  } finally {
    globalThis.URL.revokeObjectURL = originalRevoke;
    StimulusPanel.clear();
  }
});

test('a rejected stimulus object URL does not break cursor synchronization', () => {
  const StimulusPanel = globalThis.StimulusPanel;
  StimulusPanel.clear();
  const originalCreate = globalThis.URL.createObjectURL;
  globalThis.URL.createObjectURL = () => { throw new TypeError('invalid image Blob'); };
  try {
    StimulusPanel.setAssets({
      '16595': new Blob(['not a JPEG'], { type: 'image/jpeg' }),
    });
    assert.doesNotThrow(() => StimulusPanel.syncCursor([
      { onset: 1.5, stimulus_id: '16595', label: 'stim_test,16595,-1,1' },
    ], 1.5));
    const panel = globalThis.document.querySelector('#stimulus-panel');
    assert.equal(panel.hidden, true, 'an unrenderable Blob leaves the dock hidden');
  } finally {
    globalThis.URL.createObjectURL = originalCreate;
    StimulusPanel.clear();
  }
});

test('bridge: pose url opens the shared pose panel; a later open without pose hides it', async () => {
  const opened = [];
  const origOpen = PosePanel.openUrl, origHide = PosePanel.hideActive;
  let hidden = 0;
  PosePanel.openUrl = (u) => { opened.push(u); return {}; };
  PosePanel.hideActive = () => { hidden++; };
  try {
    const file = new globalThis.window.File([new Uint8Array(64)], 'sub-02_emg.bdf');
    post({ type: 'eegdash-viewer:open', files: [file], pose: 'data:application/json;base64,e30=' });
    post({ type: 'eegdash-viewer:open', files: [file] });
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(opened, ['data:application/json;base64,e30=']);
    assert.equal(hidden, 1);
  } finally {
    PosePanel.openUrl = origOpen; PosePanel.hideActive = origHide;
  }
});

test('bridge: a Blob pose is forwarded as-is (no base64 data: URL)', async () => {
  const opened = [];
  const origOpen = PosePanel.openUrl;
  PosePanel.openUrl = (u) => { opened.push(u); return {}; };
  try {
    const file = new globalThis.window.File([new Uint8Array(64)], 'sub-03_emg.bdf');
    const blob = new globalThis.window.Blob(['{}'], { type: 'application/json' });
    post({ type: 'eegdash-viewer:open', files: [file], pose: blob });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(opened.length, 1);
    assert.equal(opened[0], blob, 'the Blob reaches PosePanel untouched');
  } finally { PosePanel.openUrl = origOpen; }
});

test('bridge: a non-string, non-Blob pose is dropped rather than forwarded', async () => {
  const opened = [];
  const origOpen = PosePanel.openUrl, origHide = PosePanel.hideActive;
  let hidden = 0;
  PosePanel.openUrl = (u) => { opened.push(u); return {}; };
  PosePanel.hideActive = () => { hidden++; };
  try {
    const file = new globalThis.window.File([new Uint8Array(64)], 'sub-04_emg.bdf');
    post({ type: 'eegdash-viewer:open', files: [file], pose: { nope: 1 } });
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(opened, []);
    assert.equal(hidden, 1);
  } finally { PosePanel.openUrl = origOpen; PosePanel.hideActive = origHide; }
});

test('bridge: ignores foreign / malformed messages', async () => {
  const before = globalThis.document.getElementById('status').textContent;
  post({ type: 'something-else', files: [] });
  post({ type: 'eegdash-viewer:open', files: 'not-an-array' });
  post(null);
  await new Promise(r => setTimeout(r, 5));
  const after = globalThis.document.getElementById('status').textContent;
  // Only the well-formed-but-empty case may touch status, and then only with an error.
  assert.ok(after === before || /no files/.test(after), after);
});

test('bridge: ready handshake is posted to the parent when framed', () => {
  const got = [];
  const parent = { postMessage: (m, origin) => got.push([m, origin]) };
  Object.defineProperty(globalThis, 'parent', { value: parent, configurable: true });
  try {
    Viewer.boot({});
    assert.deepEqual(got.at(-1), [{ type: 'eegdash-viewer:ready' }, '*']);
  } finally {
    Object.defineProperty(globalThis, 'parent', { value: globalThis, configurable: true });
  }
});
