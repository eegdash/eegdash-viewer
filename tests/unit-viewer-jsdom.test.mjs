// Smoke test: viewer.js loads under JSDOM without throwing.
// Sets the floor for Stryker's mutate-on-viewer.js coverage.
import './_jsdom-bootstrap.mjs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('viewer.js: loads under JSDOM without throwing', () => {
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
  require('../viewer.js');

  assert.ok(globalThis.window.Viewer, 'window.Viewer must be set');
  assert.equal(typeof globalThis.window.Viewer.boot, 'function');
  assert.equal(typeof globalThis.window.Viewer.clampStart, 'function');
});

test('viewer.js: clampStart matches the formula contract', () => {
  const v = globalThis.window.Viewer;
  assert.equal(v.clampStart(-5, 100, 10), 0);
  assert.equal(v.clampStart(95, 100, 10), 90);
  assert.equal(v.clampStart(5, 10, 20), 0);
  assert.equal(v.clampStart(42.5, 100, 10), 42.5);
});
