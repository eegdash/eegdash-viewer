// tests/unit-pose-export.test.mjs
// exportPNG() must re-render the on-screen frame off-screen at N× the
// panel size with the context scaled to match — geometry auto-fits to
// w×h, so without the setTransform the strokes would stay hairline.
import './_jsdom-bootstrap.mjs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PosePanel = require('../pose-panel.js');

const calls = [];
const stubCtx = new Proxy({}, {
  get: (_, k) => (k === 'canvas' ? undefined
    : (...a) => { calls.push([k, ...a]); }),
  set: () => true,
});
let lastCanvas = null;
globalThis.HTMLCanvasElement.prototype.getContext = function () { lastCanvas = this; return stubCtx; };
globalThis.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AA==';

const SIDECAR = {
  format: 'eegdash-pose', version: 1, fs: 10, n_frames: 2, n_joints: 2, bones: [0, 1],
  positions: {
    encoding: 'base64-f32',
    data: Buffer.from(new Float32Array([0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0]).buffer).toString('base64'),
  },
};

test('exportPNG: off-screen bitmap is scale× the panel, context scaled to match', async () => {
  const ctl = PosePanel.mount({ container: globalThis.document.body });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => SIDECAR });
  await ctl.load('data:application/json;base64,e30=');
  ctl.syncWindow(0, 0.2);
  calls.length = 0;

  const url = ctl.exportPNG(8);
  assert.match(url, /^data:image\/png/);

  const off = lastCanvas;   // never appended to the DOM; the ctx call is the only handle
  assert.equal(off.width, ctl.canvas.width * 8, 'bitmap widened 8×');
  assert.deepEqual(calls[0], ['setTransform', 8, 0, 0, 8, 0, 0], 'strokes scale with the geometry');
  assert.ok(calls.some(([k]) => k === 'stroke' || k === 'fill'), 'something was actually drawn');

  // Nothing loaded -> nothing to export (no blank PNG downloads).
  ctl.clear();
  assert.equal(ctl.exportPNG(8), null);
});

test('renderPNG: public artifact API renders a supplied sidecar without mounting UI', () => {
  calls.length = 0;

  const url = PosePanel.renderPNG(SIDECAR, {
    time: 0.1,
    width: 320,
    height: 180,
    scale: 3,
    mode: 'skeleton',
  });

  assert.match(url, /^data:image\/png/);
  assert.equal(lastCanvas.width, 960);
  assert.equal(lastCanvas.height, 540);
  assert.deepEqual(calls[0], ['setTransform', 3, 0, 0, 3, 0, 0]);
  assert.ok(calls.some(([name]) => name === 'stroke' || name === 'fill'));
});
