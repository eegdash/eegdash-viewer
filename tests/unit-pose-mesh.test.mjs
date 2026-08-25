// unit-pose-mesh.test.mjs
// v2 mesh path: angles block parsing, linear-blend skinning (Rodrigues
// convention), and drawMesh smoke. The analytic case pins the rotation
// math: rotating (1,0,0) by π/2 about +z yields (0,1,0).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PosePanel = require('../pose-panel.js');

const b64f32 = (arr) => Buffer.from(new Float32Array(arr).buffer).toString('base64');
const b64u32 = (arr) => Buffer.from(new Uint32Array(arr).buffer).toString('base64');

/**
 * 2 joints, 2 frames, one triangle (3 verts).
 * Frame 1 carries angle θ per test; joint 0 anchors at origin with
 * axis +z; joint 1 is inert (axis +x anchored far away, weight 0).
 */
function makeMeshSidecar({ theta = [0, Math.PI / 2] } = {}) {
  const nFrames = 2, nJoints = 2;
  const positions = new Float32Array(nFrames * nJoints * 3); // zeros
  const angles = new Float32Array(nFrames * nJoints);
  for (let f = 0; f < nFrames; f++) {
    angles[f * nJoints] = theta[f % theta.length];
    // joint-1 angle stays 0
  }
  return {
    format: 'eegdash-pose',
    version: 1,
    fs: 10,
    n_frames: nFrames,
    n_joints: nJoints,
    bones: [0, 1],
    positions: { encoding: 'base64-f32', data: b64f32([...positions]) },
    angles: { encoding: 'base64-f32', data: b64f32([...angles]) },
    mesh: {
      mode: 'umetrack-lbs',
      rest_vertices: {
        encoding: 'base64-f32',
        data: b64f32([1, 0, 0, 5, -9, 2, 7, 3, -4]), // v0 on unit x; others off-anchor
      },
      triangles: { encoding: 'base64-u32', data: b64u32([0, 1, 2]) },
      weight_vertex: { encoding: 'base64-u32', data: b64u32([0, 1, 2]) },
      weight_bone: { encoding: 'base64-u32', data: b64u32([0, 1, 1]) },
      weight_value: { encoding: 'base64-f32', data: b64f32([1, 1, 1]) },
      joint_axes: { encoding: 'base64-f32', data: b64f32([0, 0, 1, 1, 0, 0]) },
      joint_rest: { encoding: 'base64-f32', data: b64f32([0, 0, 0, 40, 40, 40]) },
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

test('parseSidecar decodes angles and the full mesh block', () => {
  const p = PosePanel.parseSidecar(makeMeshSidecar());
  assert.ok(p.angles instanceof Float32Array);
  assert.equal(p.mesh.nVerts, 3);
  assert.equal(p.mesh.nTris, 1);
  assert.deepEqual([...p.mesh.axes.slice(0, 3)], [0, 0, 1]);
});

test('skinMesh with zero angles reproduces the rest pose', () => {
  const sc = makeMeshSidecar({ theta: [0, 0] });
  const p = PosePanel.parseSidecar(sc);
  const fr = PosePanel.anglesAt(p, 0.05); // frame 0, all-zero angles
  assert.ok(fr.ok);
  const skinned = PosePanel.skinMesh(p, fr.angles);
  const rest = p.mesh.restVertices;
  for (let i = 0; i < skinned.length; i++) {
    assert.ok(Math.abs(skinned[i] - rest[i]) < 1e-4, `coord ${i}`);
  }
});

test('skinMesh rotates about the anchor: (1,0,0) -> (0,1,0)', () => {
  const p = PosePanel.parseSidecar(makeMeshSidecar());
  const fr = PosePanel.anglesAt(p, 0.15); // frame 1: θ=π/2 on joint 0
  assert.ok(fr.ok);
  const skinned = PosePanel.skinMesh(p, fr.angles);
  assert.ok(Math.abs(skinned[0] - 0) < 1e-5);
  assert.ok(Math.abs(skinned[1] - 1) < 1e-5);
  assert.ok(Math.abs(skinned[2] - 0) < 1e-5);
});

test('rotateAroundAxis matches Rodrigues on a known case', () => {
  const out = PosePanel.rotateAroundAxis([0, 0, 0], [0, 1, 0], [0, 0, 1], Math.PI / 2);
  assert.ok(Math.abs(out[0] - (-1)) < 1e-12);   // y rotated π/2 about z → −x
  assert.ok(Math.abs(out[1]) < 1e-12);
  assert.ok(Math.abs(out[2]) < 1e-12);
});

test('parseMeshBlock rejects malformed blocks', () => {
  const good = makeMeshSidecar();
  const noAngles = makeMeshSidecar();
  delete noAngles.angles;
  assert.throws(() => PosePanel.parseSidecar(noAngles), /needs the angles block/);

  const badMode = makeMeshSidecar();
  badMode.mesh.mode = 'magic';
  assert.throws(() => PosePanel.parseSidecar(badMode), /unknown mesh mode/);

  const badTri = makeMeshSidecar();
  badTri.mesh.triangles = { encoding: 'base64-u32', data: b64u32([0, 1, 99]) };
  assert.throws(() => PosePanel.parseSidecar(badTri), /triangle index/);

  const ragged = makeMeshSidecar();
  ragged.mesh.weight_bone = {
    encoding: 'base64-u32', data: b64u32([0]),
  };
  assert.throws(() => PosePanel.parseSidecar(ragged), /share one length/);
});

test('drawMesh paints one filled path per triangle', () => {
  const p = PosePanel.parseSidecar(makeMeshSidecar());
  const ctx = stubCtx();
  const ok = PosePanel.drawMesh(ctx, p, 0.05, { yaw: 0, pitch: 0, zoom: 1, w: 220, h: 220 });
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
  assert.equal(PosePanel.nextMode('auto', false), 'auto'); // stuck without mesh
});
