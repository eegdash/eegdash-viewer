// unit-pose-mesh.test.mjs
// Mesh path: sidecar parsing, UmeTrack forward kinematics + linear-blend
// skinning, and drawMesh smoke. Two oracles pin the math:
//  1. an analytic one-finger chain (rotations about rest anchors compose),
//  2. real data — tests/fixtures/pose/sub-01_run-17_2s_desc-pose.json was
//     exported by scripts/export-pose-sidecar.py, whose numpy FK agrees
//     with emg2pose's torch implementation to ~6e-5; the JS must
//     reproduce its 21 landmarks per frame from the angles alone.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const PosePanel = require('../pose-panel.js');
const { FK_DOF, FK_FRAMES } = PosePanel;

const b64f32 = (arr) => Buffer.from(new Float32Array(arr).buffer).toString('base64');
const b64u32 = (arr) => Buffer.from(new Uint32Array(arr).buffer).toString('base64');

/**
 * Synthetic UmeTrack-shaped model: finger 0 is a straight chain along +x
 * with joints anchored at x = 0, 1, 2, 3, every axis +z. Other fingers
 * have zero-length chains (anchors at origin) so they never matter.
 * Three vertices sit at x = 2, 3, 4 and are fully weighted to finger 0's
 * proximal (frame 2), intermediate (3) and distal (4) frames.
 */
function makeMeshSidecar({ angles = new Array(FK_DOF).fill(0), nFrames = 2 } = {}) {
  const nJoints = 2;
  const axes = [], rests = [];
  for (let q = 0; q < FK_DOF; q++) {
    axes.push(0, 0, 1);
    rests.push(q < 4 ? q : 0, 0, 0);
  }
  const ang = [];
  for (let f = 0; f < nFrames; f++) ang.push(...(f === 0 ? new Array(FK_DOF).fill(0) : angles));
  return {
    format: 'eegdash-pose', version: 1, fs: 10,
    n_frames: nFrames, n_joints: nJoints, n_angles: FK_DOF, bones: [0, 1],
    positions: { encoding: 'base64-f32', data: b64f32(new Array(nFrames * nJoints * 3).fill(0)) },
    angles: { encoding: 'base64-f32', data: b64f32(ang) },
    mesh: {
      mode: 'umetrack-fk',
      mirror_x: false,
      joint_axes: { encoding: 'base64-f32', data: b64f32(axes) },
      joint_rest: { encoding: 'base64-f32', data: b64f32(rests) },
      rest_vertices: { encoding: 'base64-f32', data: b64f32([2, 0, 0, 3, 0, 0, 4, 0, 0]) },
      triangles: { encoding: 'base64-u32', data: b64u32([0, 1, 2]) },
      weight_vertex: { encoding: 'base64-u32', data: b64u32([0, 1, 2]) },
      weight_bone: { encoding: 'base64-u32', data: b64u32([2, 3, 4]) },
      weight_value: { encoding: 'base64-f32', data: b64f32([1, 1, 1]) },
    },
  };
}

function stubCtx() {
  const calls = [];
  return new Proxy({
    calls,
    clearRect() { calls.push(['clearRect']); },
    beginPath() { calls.push(['beginPath']); },
    moveTo() { calls.push(['moveTo']); },
    lineTo() { calls.push(['lineTo']); },
    closePath() { calls.push(['closePath']); },
    fill() { calls.push(['fill']); },
    arc() { calls.push(['arc']); },
    stroke() { calls.push(['stroke']); },
    fillText(t) { calls.push(['fillText', t]); },
    setTransform() {},
  }, {
    get(t, prop) { return prop in t ? t[prop] : () => {}; },
    set(t, prop, v) { t[prop] = v; return true; },
  });
}

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

test('parseSidecar decodes n_angles, angles, camera and the fk mesh block', () => {
  const sc = makeMeshSidecar();
  sc.camera = { yaw: -0.4, pitch: -1 };
  const p = PosePanel.parseSidecar(sc);
  assert.equal(p.nAngles, FK_DOF);
  assert.ok(p.angles instanceof Float32Array);
  assert.equal(p.angles.length, 2 * FK_DOF);
  assert.equal(p.mesh.nVerts, 3);
  assert.equal(p.mesh.nTris, 1);
  assert.equal(p.mesh.mirrorX, false);
  assert.deepEqual(p.camera, { yaw: -0.4, pitch: -1 });
});

test('umetrackFrames: zero angles → 17 identity frames', () => {
  const p = PosePanel.parseSidecar(makeMeshSidecar());
  const out = PosePanel.umetrackFrames(new Float32Array(FK_DOF), p.mesh.axes, p.mesh.jointRest, new Float32Array(FK_FRAMES * 12));
  for (let k = 0; k < FK_FRAMES; k++) {
    assert.deepEqual([...out.slice(k * 12, k * 12 + 12)], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], `frame ${k}`);
  }
});

test('skinMesh with zero angles reproduces the rest pose', () => {
  const p = PosePanel.parseSidecar(makeMeshSidecar());
  const fr = PosePanel.anglesAt(p, 0.0);
  assert.ok(fr.ok);
  const skinned = PosePanel.skinMesh(p, fr.angles);
  for (let i = 0; i < skinned.length; i++) near(skinned[i], p.mesh.restVertices[i], 1e-6, `coord ${i}`);
});

test('finger chain: rotating joint 0 by π/2 about the origin swings every downstream vertex', () => {
  const angles = new Array(FK_DOF).fill(0); angles[0] = Math.PI / 2;
  const p = PosePanel.parseSidecar(makeMeshSidecar({ angles }));
  const fr = PosePanel.anglesAt(p, 0.1, false);           // frame 1
  const v = PosePanel.skinMesh(p, fr.angles);
  // (2,0,0) → (0,2,0), (3,0,0) → (0,3,0), (4,0,0) → (0,4,0)
  for (let i = 0; i < 3; i++) {
    near(v[i * 3], 0, 1e-6, `x${i}`); near(v[i * 3 + 1], i + 2, 1e-6, `y${i}`); near(v[i * 3 + 2], 0, 1e-6, `z${i}`);
  }
});

test('finger chain: rotating joint 1 about its anchor (1,0,0) leaves nothing upstream moved', () => {
  const angles = new Array(FK_DOF).fill(0); angles[1] = Math.PI / 2;
  const p = PosePanel.parseSidecar(makeMeshSidecar({ angles }));
  const v = PosePanel.skinMesh(p, PosePanel.anglesAt(p, 0.1, false).angles);
  // proximal frame (after joints 0,1): (2,0,0) → rotate about (1,0,0): (1,1,0)
  near(v[0], 1, 1e-6, 'x0'); near(v[1], 1, 1e-6, 'y0');
  // distal (4,0,0) → (1,3,0)
  near(v[6], 1, 1e-6, 'x2'); near(v[7], 3, 1e-6, 'y2');
});

test('finger chain: composed rotations (joint 0 and joint 2 by π/2)', () => {
  const angles = new Array(FK_DOF).fill(0); angles[0] = Math.PI / 2; angles[2] = Math.PI / 2;
  const p = PosePanel.parseSidecar(makeMeshSidecar({ angles }));
  const v = PosePanel.skinMesh(p, PosePanel.anglesAt(p, 0.1, false).angles);
  // distal vertex (4,0,0): joint 2 about (2,0,0) → (2,2,0); then joint 0 about origin → (-2,2,0)
  near(v[6], -2, 1e-6, 'x2'); near(v[7], 2, 1e-6, 'y2');
  // proximal vertex (2,0,0) is upstream of joint 2 → only joint 0 applies → (0,2,0)
  near(v[0], 0, 1e-6, 'x0'); near(v[1], 2, 1e-6, 'y0');
});

test('mirror_x negates x after skinning', () => {
  const sc = makeMeshSidecar(); sc.mesh.mirror_x = true;
  const p = PosePanel.parseSidecar(sc);
  const v = PosePanel.skinMesh(p, PosePanel.anglesAt(p, 0).angles);
  assert.deepEqual([...v], [-2, 0, 0, -3, 0, 0, -4, 0, 0]);
});

test('real data: JS landmarks from angles match the exporter positions on every frame', () => {
  const json = JSON.parse(fs.readFileSync(new URL('./fixtures/pose/sub-01_run-17_2s_desc-pose.json', import.meta.url), 'utf8'));
  const p = PosePanel.parseSidecar(json);
  assert.equal(p.nFrames, 60);
  assert.ok(p.mesh.landmarks, 'fixture carries landmark skinning data');
  let worst = 0;
  for (let f = 0; f < p.nFrames; f++) {
    const ang = p.angles.subarray(f * p.nAngles, (f + 1) * p.nAngles);
    const lm = PosePanel.skinLandmarks(p, ang);
    for (let i = 0; i < lm.length; i++) worst = Math.max(worst, Math.abs(lm[i] - p.positions[f * p.nJoints * 3 + i]));
  }
  assert.ok(worst < 1e-3, `max |JS − exporter| = ${worst}`);
  // and the mesh skins into a hand-sized cloud (mm), not NaNs
  const v = PosePanel.skinMesh(p, p.angles.subarray(0, p.nAngles));
  assert.ok(v.every(Number.isFinite));
  const xs = Array.from({ length: p.mesh.nVerts }, (_, i) => v[i * 3]);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 50, 'hand spans > 50 mm in x');
});

test('start_s: windowed sidecars are sampled relative to the window start', () => {
  const angles = new Array(FK_DOF).fill(0); angles[0] = 1;
  const sc = makeMeshSidecar({ angles }); sc.start_s = 10;   // frames cover 10.0–10.1 s
  const p = PosePanel.parseSidecar(sc);
  assert.equal(p.startS, 10);
  assert.equal(PosePanel.anglesAt(p, 10.0, false).angles[0], 0);
  assert.equal(PosePanel.anglesAt(p, 10.15, false).angles[0], 1);   // 10.15 → frame 1 (10.1 − 10 is 0.0999… in floats)
  near(PosePanel.frameAt(p, 10.15, false).t, 0.15, 1e-9, 't is window-relative');
});

test('a NaN in any angle (not only DOF 0) invalidates the frame', () => {
  const angles = new Array(FK_DOF).fill(0); angles[7] = NaN;
  const p = PosePanel.parseSidecar(makeMeshSidecar({ angles }));
  assert.equal(p.valid[0], 1);
  assert.equal(p.valid[1], 0);
  assert.equal(PosePanel.anglesAt(p, 0.1, false).ok, false);
});

test('n_angles is derived for hand-authored sidecars that omit it', () => {
  const sc = makeMeshSidecar(); delete sc.n_angles;
  assert.equal(PosePanel.parseSidecar(sc).nAngles, FK_DOF);
  const bad = makeMeshSidecar(); delete bad.n_angles;
  bad.angles = { encoding: 'base64-f32', data: b64f32(new Array(2 * FK_DOF + 1).fill(0)) };
  assert.throws(() => PosePanel.parseSidecar(bad), /whole number per frame/);
});

test('drawMesh and drawFrame do not clear: \'both\' keeps the mesh under the skeleton', () => {
  const p = PosePanel.parseSidecar(makeMeshSidecar());
  const ctx = stubCtx();
  PosePanel.drawMesh(ctx, p, 0, { yaw: 0, pitch: 0, zoom: 1, w: 220, h: 220 });
  PosePanel.drawFrame(ctx, p, 0, { yaw: 0, pitch: 0, zoom: 1, w: 220, h: 220 });
  assert.equal(ctx.calls.filter(c => c[0] === 'clearRect').length, 0, 'the panel clears once per frame, not the painters');
});

test('parseMeshBlock rejects malformed blocks', () => {
  const noAngles = makeMeshSidecar();
  delete noAngles.angles;
  assert.throws(() => PosePanel.parseSidecar(noAngles), /needs the angles block/);

  const badMode = makeMeshSidecar();
  badMode.mesh.mode = 'umetrack-lbs';
  assert.throws(() => PosePanel.parseSidecar(badMode), /unknown mesh mode/);

  const badDof = makeMeshSidecar();
  badDof.n_angles = 2; badDof.angles = { encoding: 'base64-f32', data: b64f32([0, 0, 0, 0]) };
  assert.throws(() => PosePanel.parseSidecar(badDof), /n_angles=20/);

  const badTri = makeMeshSidecar();
  badTri.mesh.triangles = { encoding: 'base64-u32', data: b64u32([0, 1, 99]) };
  assert.throws(() => PosePanel.parseSidecar(badTri), /triangle index/);

  const badBone = makeMeshSidecar();
  badBone.mesh.weight_bone = { encoding: 'base64-u32', data: b64u32([2, 3, 17]) };
  assert.throws(() => PosePanel.parseSidecar(badBone), /weight bone index/);

  const ragged = makeMeshSidecar();
  ragged.mesh.weight_bone = { encoding: 'base64-u32', data: b64u32([0]) };
  assert.throws(() => PosePanel.parseSidecar(ragged), /share one length/);
});

test('drawMesh paints one filled path per triangle', () => {
  const p = PosePanel.parseSidecar(makeMeshSidecar());
  const ctx = stubCtx();
  const ok = PosePanel.drawMesh(ctx, p, 0.0, { yaw: 0, pitch: 0, zoom: 1, w: 220, h: 220 });
  assert.equal(ok, true);
  assert.equal(ctx.calls.filter(c => c[0] === 'fill').length, 1);
});

test('drawMesh falls back to the no-IK badge on masked frames', () => {
  const sc = makeMeshSidecar();
  sc.valid = Buffer.from([1, 0]).toString('base64');
  const p = PosePanel.parseSidecar(sc);
  const ctx = stubCtx();
  const ok = PosePanel.drawMesh(ctx, p, 0.15, { yaw: 0, pitch: 0, zoom: 1, w: 220, h: 220 });
  assert.equal(ok, false);
  assert.ok(ctx.calls.some(c => c[0] === 'fillText' && c[1] === 'no IK data'));
});

test('nextMode cycles only when a mesh exists', () => {
  assert.equal(PosePanel.nextMode('auto', true), 'skeleton');
  assert.equal(PosePanel.nextMode('skeleton', true), 'mesh');
  assert.equal(PosePanel.nextMode('mesh', true), 'both');
  assert.equal(PosePanel.nextMode('both', true), 'auto');
  assert.equal(PosePanel.nextMode('auto', false), 'auto');
});

test('drawMesh: a smaller mesh after a larger one paints only its own triangles', () => {
  // The scratch buffers are reused whenever they are merely long enough, so
  // the 1544-triangle fixture leaves indices far past the synthetic mesh's
  // single triangle behind. Sorting the whole array shuffled those stale
  // indices into the painted range, and mesh.triangles[stale] is undefined —
  // NaN coordinates.
  const pts = [];
  const ctx = new Proxy({
    beginPath() {}, closePath() {}, fill() {}, stroke() {}, arc() {},
    moveTo(x, y) { pts.push(x, y); }, lineTo(x, y) { pts.push(x, y); },
  }, { get: (t, p) => (p in t ? t[p] : () => {}), set: (t, p, v) => { t[p] = v; return true; } });

  const big = PosePanel.parseSidecar(JSON.parse(fs.readFileSync(
    new URL('./fixtures/pose/sub-01_run-17_2s_desc-pose.json', import.meta.url), 'utf8')));
  const opts = { yaw: 0, pitch: 0, zoom: 1, w: 220, h: 220 };
  assert.equal(PosePanel.drawMesh(ctx, big, big.startS, opts), true);
  assert.ok(big.mesh.nTris > 100, 'fixture must be the larger mesh');

  pts.length = 0;
  assert.equal(PosePanel.drawMesh(ctx, PosePanel.parseSidecar(makeMeshSidecar()), 0, opts), true);
  assert.equal(pts.length, 6, 'one triangle → three points');
  for (const v of pts) assert.ok(Number.isFinite(v), `painted a non-finite coordinate: ${v}`);
});
