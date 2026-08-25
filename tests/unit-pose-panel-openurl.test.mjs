// tests/unit-pose-panel-openurl.test.mjs
// openUrl() must give hosts (drag-drop, postMessage bridge, ?pose=)
// one shared controller: first call mounts, later calls only reload.
import './_jsdom-bootstrap.mjs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The bridge/viewer look the panel up on globalThis; the test drives
// the same object node:test gets via module.exports.
const PosePanel = require('../pose-panel.js');

const EMPTY_JSON = 'data:application/json;base64,e30=';

// The header button is static markup in index.html, present before the
// first openUrl(); mirror that here.
const toggleBtn = globalThis.document.createElement('button');
toggleBtn.id = 'pose-toggle'; toggleBtn.hidden = true;
globalThis.document.body.append(toggleBtn);

test('openUrl: mounts one panel and reuses it on the next call', async () => {
  const fetched = [];
  globalThis.fetch = async (url) => { fetched.push(url); return { ok: false, status: 404 }; };
  const a = PosePanel.openUrl(EMPTY_JSON);
  const b = PosePanel.openUrl(EMPTY_JSON);
  assert.equal(a, b, 'same controller');
  assert.equal(globalThis.document.querySelectorAll('.pose-panel').length, 1);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(fetched.length, 2, 'each call loads the url');
});

test('hideActive: hides the shared panel; openUrl shows it again', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  PosePanel.openUrl(EMPTY_JSON);
  PosePanel.hideActive();
  const root = globalThis.document.querySelector('.pose-panel');
  assert.ok(root.hasAttribute('hidden'));
  PosePanel.openUrl(EMPTY_JSON);
  await new Promise(r => setTimeout(r, 0));
  assert.ok(!root.hasAttribute('hidden'), 'load() shows the panel (even on load failure, for the caption)');
});

test('openUrl: wires #pose-toggle once; hideActive hides it and forgets the sidecar', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
    format: 'eegdash-pose', version: 1, fs: 10, n_frames: 1, n_joints: 2, bones: [0, 1],
    positions: { encoding: 'base64-f32', data: Buffer.from(new Float32Array(6).buffer).toString('base64') },
  }) });
  const ctl = PosePanel.openUrl(EMPTY_JSON);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(toggleBtn.hidden, false, 'button revealed');
  assert.equal(toggleBtn.getAttribute('aria-pressed'), 'true');
  toggleBtn.click();
  assert.ok(ctl.root.hasAttribute('hidden'), 'click toggles');
  assert.equal(toggleBtn.getAttribute('aria-pressed'), 'false');
  toggleBtn.click();
  assert.ok(!ctl.root.hasAttribute('hidden'), 'one listener, not two');
  PosePanel.hideActive();
  assert.equal(toggleBtn.hidden, true, 'no sidecar → no button');
  ctl.show(); ctl.syncWindow(0, 1);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(ctl.root.querySelector('.pose-caption').textContent, '', 'nothing stale to draw after clear()');
});

test('load: a stale fetch that resolves after clear() is dropped', async () => {
  let release;
  const slow = new Promise(r => { release = r; });
  globalThis.fetch = async () => { await slow; return { ok: true, status: 200, json: async () => ({
    format: 'eegdash-pose', version: 1, fs: 10, n_frames: 1, n_joints: 2, bones: [0, 1],
    positions: { encoding: 'base64-f32', data: Buffer.from(new Float32Array(6).buffer).toString('base64') },
  }) }; };
  const ctl = PosePanel.openUrl(EMPTY_JSON);
  PosePanel.hideActive();
  release();
  await new Promise(r => setTimeout(r, 5));
  assert.ok(ctl.root.hasAttribute('hidden'), 'panel stays hidden');
  assert.equal(toggleBtn.hidden, true);
});
