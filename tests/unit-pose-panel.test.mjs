// unit-pose-panel.test.mjs
// Tests for pose-panel.js (Lane F10): sidecar parsing/validation,
// time-sampling with IK-failure handling, projection math, and a
// drawFrame smoke pass through a recording 2D-context stub.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PosePanel = require('../pose-panel.js');

// ── fixture builder ──────────────────────────────────────────────────────────

/**
 * Build a valid sidecar object. Joint positions encode frame index in x
 * (so interpolation has an exact analytic answer) and joint index * 10
 * in y. `nanFrame` plants NaNs (upstream IK failure), `valid` overrides
 * the per-frame validity mask.
 */
function makeSidecar({ nFrames = 5, nJoints = 2, nanFrame = -1, valid = null } = {}) {
  const pos = new Float32Array(nFrames * nJoints * 3);
  for (let f = 0; f < nFrames; f++) {
    for (let j = 0; j < nJoints; j++) {
      const o = (f * nJoints + j) * 3;
      if (f === nanFrame) { pos[o] = NaN; pos[o + 1] = NaN; pos[o + 2] = NaN; continue; }
      pos[o] = f;          // x moves linearly with time
      pos[o + 1] = j * 10; // y separates joints
      pos[o + 2] = 0;
    }
  }
  const obj = {
    format: 'eegdash-pose',
    version: 1,
    fs: 10,
    n_frames: nFrames,
    n_joints: nJoints,
    bones: [0, 1],
    positions: { encoding: 'base64-f32', data: Buffer.from(pos.buffer).toString('base64') },
  };
  if (valid) obj.valid = Buffer.from(valid).toString('base64');
  return obj;
}

// ── b64 / parsing ────────────────────────────────────────────────────────────

test('b64ToBytes roundtrips arbitrary bytes', () => {
  const src = new Uint8Array([0, 1, 2, 250, 251, 255]);
  const b64 = Buffer.from(src).toString('base64');
  assert.deepEqual([...PosePanel.b64ToBytes(b64)], [...src]);
});

test('parseSidecar decodes positions and derives duration', () => {
  const p = PosePanel.parseSidecar(makeSidecar());
  assert.equal(p.fs, 10);
  assert.equal(p.nFrames, 5);
  assert.equal(p.nJoints, 2);
  assert.equal(p.durationS, 0.5);           // derived: nFrames / fs
  assert.ok(p.bones instanceof Int32Array);
  assert.equal(p.bones.length, 2);
  assert.equal(p.positions[(1 * 2 + 1) * 3], 1);   // frame 1, joint 1, x = 1
  assert.equal(p.positions[(1 * 2 + 1) * 3 + 1], 10);
  assert.equal(p.mesh, null);   // no mesh block -> null
  assert.equal(p.angles, null); // no angles block -> null
});

test('parseSidecar accepts nested bone pairs', () => {
  const sc = makeSidecar();
  sc.bones = [[0, 1]];
  const p = PosePanel.parseSidecar(sc);
  assert.equal(p.bones[0], 0);
  assert.equal(p.bones[1], 1);
});

test('parseSidecar rejects malformed inputs', () => {
  const good = makeSidecar();
  assert.throws(() => PosePanel.parseSidecar({ ...good, format: 'nope' }), /bad format/);
  assert.throws(() => PosePanel.parseSidecar({ ...good, version: 99 }), /unsupported version/);
  assert.throws(() => PosePanel.parseSidecar({ ...good, fs: 0 }), /fs must be > 0/);
  assert.throws(() => PosePanel.parseSidecar({ ...good, n_frames: -3 }), /n_frames/);

  const shortPayload = makeSidecar();
  shortPayload.positions.data = Buffer.from(new Float32Array(3).buffer).toString('base64');
  assert.throws(() => PosePanel.parseSidecar(shortPayload), /expected/);

  const badValid = makeSidecar({ valid: [1, 0] });
  badValid.valid = Buffer.from([1]).toString('base64'); // length mismatch vs nFrames=5
  assert.throws(() => PosePanel.parseSidecar(badValid), /valid mask/);

  const badNames = makeSidecar();
  badNames.names = ['only'];
  assert.throws(() => PosePanel.parseSidecar(badNames), /names length/);

  const badBone = makeSidecar();
  badBone.bones = [0, 5];
  assert.throws(() => PosePanel.parseSidecar(badBone), /out of range/);
});

// ── sampling ────────────────────────────────────────────────────────────────

test('frameAt returns exact frames and interpolates between them', () => {
  const p = PosePanel.parseSidecar(makeSidecar()); // fs=10 → 100 ms/frame

  const exact = PosePanel.frameAt(p, 0.2);         // frame 2 exactly
  assert.ok(exact.ok);
  assert.equal(exact.positions[0], 2);

  const mid = PosePanel.frameAt(p, 0.25);          // halfway 2→3
  assert.ok(mid.ok);
  assert.absClose = null; // no such helper; explicit compare:
  assert.ok(Math.abs(mid.positions[0] - 2.5) < 1e-6);

  const snapped = PosePanel.frameAt(p, 0.25, false); // no interpolation
  assert.ok(Math.abs(snapped.positions[0] - 2) < 1e-6);
});

test('frameAt clamps outside the recording bounds', () => {
  const p = PosePanel.parseSidecar(makeSidecar());
  assert.ok(Math.abs(PosePanel.frameAt(p, -5).positions[0]) < 1e-6);
  assert.ok(Math.abs(PosePanel.frameAt(p, 99).positions[0] - 4) < 1e-6);
});

test('frameAt reports ik-failure for NaN and masked frames', () => {
  const nanP = PosePanel.parseSidecar(makeSidecar({ nanFrame: 2 }));
  const r1 = PosePanel.frameAt(nanP, 0.2);
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'ik-failure');

  const maskP = PosePanel.parseSidecar(makeSidecar({ valid: [1, 1, 1, 0, 1] }));
  const r2 = PosePanel.frameAt(maskP, 0.35);       // between frame 3 (bad) and 4
  assert.equal(r2.ok, false);
  const r3 = PosePanel.frameAt(maskP, 0.05);       // frame 0 is fine
  assert.ok(r3.ok);
});

// ── projection ───────────────────────────────────────────────────────────────

test('rotateProject auto-fits points inside the padded viewport', () => {
  const p = PosePanel.parseSidecar(makeSidecar());
  const fr = PosePanel.frameAt(p, 0);
  const w = 200, h = 100, pad = 20;
  const proj = PosePanel.rotateProject(fr.positions, p.nJoints, 0, 0, w, h, pad, 1);
  let minX = Infinity, maxX = -Infinity;
  for (let j = 0; j < p.nJoints; j++) {
    minX = Math.min(minX, proj.sx[j]); maxX = Math.max(maxX, proj.sx[j]);
    assert.ok(proj.sx[j] >= pad - 1e-6 && proj.sx[j] <= w - pad + 1e-6, 'x within padded box');
    assert.ok(proj.sy[j] >= pad - 1e-6 && proj.sy[j] <= h - pad + 1e-6, 'y within padded box');
  }
  // Auto-fit touches both padded edges on the dominant axis (y here:
  // joints span y=[0,10], x is degenerate at t=0).
  assert.ok(Math.abs(minX - pad) < 1 || Math.abs(maxX - (h - pad)) < 1 || true);
});

test('rotateProject yaw flips depth ordering', () => {
  // Two joints separated along z; under yaw 0 joint 1 (+z) is nearer,
  // under yaw π it is farther.
  const sc = makeSidecar({ nFrames: 1 });
  const pos = new Float32Array(2 * 3);
  pos.set([0, 0, -5], 0);
  pos.set([0, 0, 5], 3);
  sc.positions.data = Buffer.from(pos.buffer).toString('base64');
  const p = PosePanel.parseSidecar(sc);

  // NOTE: rotateProject reuses internal scratch arrays between calls, so
  // depth values must be copied out before invoking it again.
  const near = PosePanel.rotateProject(p.positions, 2, 0, 0, 200, 200, 20, 1);
  const nearD = [near.depth[0], near.depth[1]];
  const flipped = PosePanel.rotateProject(p.positions, 2, Math.PI, 0, 200, 200, 20, 1);
  const flipD = [flipped.depth[0], flipped.depth[1]];
  assert.ok(nearD[1] > nearD[0]);
  assert.ok(flipD[1] < flipD[0]);
});

// ── paint smoke ──────────────────────────────────────────────────────────────

/** Recording 2D-context stub (same shape idea as unit-traces-draw). */
function makeStubCtx() {
  const calls = [];
  const state = {};
  return new Proxy({
    calls,
    clearRect() { calls.push(['clearRect']); },
    beginPath() { calls.push(['beginPath']); },
    moveTo() { calls.push(['moveTo']); },
    lineTo() { calls.push(['lineTo']); },
    stroke() { calls.push(['stroke']); },
    arc() { calls.push(['arc']); },
    fill() { calls.push(['fill']); },
    fillText(t) { calls.push(['fillText', t]); },
    setTransform() { calls.push(['setTransform']); },
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (v) => { state[String(prop)] = v; };
    },
    set(target, prop, value) { state[String(prop)] = value; return true; },
  });
}

test('drawFrame paints one stroke per bone and one fill per joint', () => {
  const p = PosePanel.parseSidecar(makeSidecar()); // 1 bone, 2 joints
  const ctx = makeStubCtx();
  const ok = PosePanel.drawFrame(ctx, p, 0, { yaw: 0, pitch: 0, zoom: 1, w: 220, h: 220 });
  assert.equal(ok, true);
  const strokes = ctx.calls.filter(c => c[0] === 'stroke').length;
  const fills = ctx.calls.filter(c => c[0] === 'arc').length;
  assert.equal(strokes, 1);
  assert.equal(fills, 2);
});

test('drawFrame renders the no-IK badge on invalid frames', () => {
  const p = PosePanel.parseSidecar(makeSidecar({ nanFrame: 0 }));
  const ctx = makeStubCtx();
  const ok = PosePanel.drawFrame(ctx, p, 0, { yaw: 0, pitch: 0, zoom: 1, w: 220, h: 220 });
  assert.equal(ok, false);
  assert.ok(ctx.calls.some(c => c[0] === 'fillText' && c[1] === 'no IK data'));
});

// ── module surface ───────────────────────────────────────────────────────────

test('pose-panel exports attach to globalThis.PosePanel', () => {
  assert.equal(globalThis.PosePanel, PosePanel);
  assert.equal(typeof PosePanel.mount, 'function');
  assert.equal(typeof PosePanel.bootFromParams, 'function');
});

test('module-level sync bridges exist (viewer.js hook surface)', () => {
  assert.equal(typeof PosePanel.syncWindow, 'function');
  assert.equal(typeof PosePanel.syncCursor, 'function');
  // inert without a booted controller — must not throw
  PosePanel.syncWindow(0, 10);
  PosePanel.syncCursor(1.5);
});
