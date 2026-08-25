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

test('openUrl: wires #pose-toggle once to the shared controller', async () => {
  const btn = globalThis.document.createElement('button');
  btn.id = 'pose-toggle'; btn.hidden = true;
  globalThis.document.body.append(btn);
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  const ctl = PosePanel.openUrl(EMPTY_JSON);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(btn.hidden, false, 'button revealed');
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  btn.click();
  assert.ok(ctl.root.hasAttribute('hidden'), 'click toggles');
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  btn.click();
  assert.ok(!ctl.root.hasAttribute('hidden'), 'one listener, not two');
  btn.remove();
});
