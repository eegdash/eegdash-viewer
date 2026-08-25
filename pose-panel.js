/* ============================================================
   pose-panel.js — synchronized hand-skeleton panel (Lane F10).

   Renders a 3D hand skeleton (or any joint hierarchy) that stays
   in sync with the traces canvas time cursor. Data comes from a
   "pose sidecar" — a small JSON file sitting next to the BIDS
   recording whose `positions` block carries per-frame joint
   coordinates precomputed by forward kinematics on the Python
   side (e.g. emg2pose's UmeTrack HandModel). The viewer stays
   dumb: interpolate + project + draw. No kinematics here by
   design; see docs/pose-sidecar.md for the format (v1 skeleton,
   v2 reserves an optional mesh block).

   Structure mirrors traces.js / viewer.js conventions:
     - Pure helpers attached to `window.PosePanel` (also
       `module.exports` under Node) so unit tests can drive them
       with synthetic data and no DOM.
     - DOM glue (mount/boot) only touches `document` at call time.

   Core-viewer integration is intentionally minimal: viewer.js's
   updateGainReadout() calls PosePanel.syncWindow(start, win) after
   every paint, and updateCursor() calls syncCursor(t) while
   hovering — both guarded with optional chaining so the panel is
   inert when absent.
   ============================================================ */
'use strict';
(function () {
  // ---- constants ---------------------------------------------

  const FORMAT = 'eegdash-pose';
  const VERSION = 1;

  // Cursor staleness window: when the pointer stops moving over the
  // traces we fall back to the visible-window centre after this long.
  const CURSOR_TTL_MS = 200;
  // Default camera distance-ish padding fraction for auto-fit.
  const DEFAULT_PAD = 24; // px inside the canvas edge

  // ---- pure: base64 / parsing --------------------------------

  function b64ToBytes(b64) {
    if (typeof Buffer !== 'undefined' && Buffer.from) {
      return new Uint8Array(Buffer.from(b64, 'base64'));
    }
    const bin = globalThis.atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** Typed-array view over base64; expectedBytes<=0 skips the length pin. */
  function decodeBlock(block, expectedBytes, what) {
    const enc = (block && block.encoding) || '';
    if (enc !== 'base64-f32' && enc !== 'base64-u32') {
      throw new Error(`pose sidecar: unsupported ${what} encoding ${JSON.stringify(enc)}`);
    }
    const bytes = b64ToBytes(block.data || '');
    if (expectedBytes > 0 && bytes.length !== expectedBytes) {
      throw new Error(
        `pose sidecar: ${what} payload is ${bytes.length} bytes, expected ${expectedBytes}`,
      );
    }
    if (enc === 'base64-u32') {
      return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2);
    }
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2);
  }

  // UmeTrack hand model constants (emg2pose/UmeTrack/lib/common/hand.py):
  // 5 fingers × 4 joints drive 17 skinning frames — root, wrist, then
  // (proximal, intermediate, distal) per finger.
  const FK_DOF = 20;
  const FK_FRAMES = 17;

  function sparseWeights(block, prefix, nPoints, what) {
    const wv = decodeBlock(block[prefix + 'weight_vertex'], 0, what + ' weight_vertex');
    const wb = decodeBlock(block[prefix + 'weight_bone'], 0, what + ' weight_bone');
    const ww = decodeBlock(block[prefix + 'weight_value'], 0, what + ' weight_value');
    const N = wv.length;
    if (!N || wb.length !== N || ww.length !== N) {
      throw new Error(`pose sidecar: ${what} sparse weight arrays must share one length`);
    }
    for (let i = 0; i < N; i++) {
      if (wb[i] >= FK_FRAMES) throw new Error(`pose sidecar: ${what} weight bone index out of range`);
      if (wv[i] >= nPoints) throw new Error(`pose sidecar: ${what} weight vertex index out of range`);
    }
    return { wv, wb, ww };
  }

  /**
   * Validate + decode the optional mesh block (docs/pose-sidecar.md).
   * Mode `umetrack-fk`: the sidecar ships the hand model (rest vertices,
   * triangles, sparse skinning weights over the 17 UmeTrack frames, the
   * 20 joint axes/anchors) and the viewer runs forward kinematics +
   * linear-blend skinning per frame from the sibling `angles` block.
   * Optional `rest_landmarks` + `landmark_weight_*` let the same FK
   * reproduce the 21 skeleton landmarks (used by tests as an oracle
   * against `positions`).
   * Returns { nVerts, nTris, restVertices, triangles, weights, axes,
   *            jointRest, mirrorX, landmarks|null }.
   */
  function parseMeshBlock(mesh, nAngles, anglesArr, nJoints) {
    if (!mesh || typeof mesh !== 'object') {
      throw new Error('pose sidecar: mesh block object required');
    }
    if (!anglesArr) {
      throw new Error('pose sidecar: mesh mode needs the angles block');
    }
    if (mesh.mode !== 'umetrack-fk') {
      throw new Error(`pose sidecar: unknown mesh mode ${JSON.stringify(mesh.mode)}`);
    }
    if (nAngles !== FK_DOF) {
      throw new Error(`pose sidecar: umetrack-fk needs n_angles=${FK_DOF}, got ${nAngles}`);
    }
    const restVertices = decodeBlock(mesh.rest_vertices, 0, 'rest_vertices');
    if (restVertices.length === 0 || restVertices.length % 3 !== 0) {
      throw new Error('pose sidecar: rest_vertices must be non-empty xyz triples');
    }
    const nVerts = restVertices.length / 3;
    const axes = decodeBlock(mesh.joint_axes, FK_DOF * 12, 'joint_axes');
    const jointRest = decodeBlock(mesh.joint_rest, FK_DOF * 12, 'joint_rest');
    const triangles = decodeBlock(mesh.triangles, 0, 'triangles');
    if (triangles.length === 0 || triangles.length % 3 !== 0) {
      throw new Error('pose sidecar: triangles must be non-empty index triples');
    }
    for (let i = 0; i < triangles.length; i++) {
      if (triangles[i] >= nVerts) throw new Error('pose sidecar: triangle index out of range');
    }
    const weights = sparseWeights(mesh, '', nVerts, 'mesh');
    let landmarks = null;
    if (mesh.rest_landmarks) {
      const rest = decodeBlock(mesh.rest_landmarks, nJoints * 12, 'rest_landmarks');
      landmarks = { rest, weights: sparseWeights(mesh, 'landmark_', nJoints, 'landmark') };
    }
    return {
      nVerts, nTris: triangles.length / 3,
      restVertices, triangles, weights, axes, jointRest,
      mirrorX: mesh.mirror_x === true,
      landmarks,
    };
  }

  /**
   * Validate + decode a pose-sidecar JSON object into a parsed record:
   *   { fs, nFrames, nJoints, durationS, bones: Int32Array(flat pairs),
   *     names, positions: Float32Array(frame-major xyz), valid, hasMeshBlock }
   *
   * Layout of `positions`: index = (frame * nJoints + joint) * 3 + axis,
   * little-endian float32, transported as base64 under encoding
   * 'base64-f32'. Throws Error with a precise message on malformed input
   * so load failures surface in the panel caption instead of console-only.
   */
  function parseSidecar(json) {
    if (typeof json === 'string') json = JSON.parse(json);
    if (!json || typeof json !== 'object') throw new Error('pose sidecar: not an object');
    if (json.format !== FORMAT) throw new Error(`pose sidecar: bad format ${JSON.stringify(json.format)}`);
    if ((json.version | 0) !== VERSION) throw new Error(`pose sidecar: unsupported version ${json.version}`);

    const fs = Number(json.fs);
    if (!Number.isFinite(fs) || fs <= 0) throw new Error('pose sidecar: fs must be > 0');
    const nFrames = json.n_frames | 0;
    if (nFrames <= 0) throw new Error('pose sidecar: n_frames must be > 0');
    const nJoints = json.n_joints | 0;
    if (nJoints < 2) throw new Error('pose sidecar: n_joints must be >= 2');

    const enc = (json.positions && json.positions.encoding) || 'base64-f32';
    if (enc !== 'base64-f32') throw new Error(`pose sidecar: unsupported positions encoding ${enc}`);
    const bytes = b64ToBytes((json.positions && json.positions.data) || '');
    const expected = nFrames * nJoints * 3 * 4;
    if (bytes.length !== expected) {
      throw new Error(`pose sidecar: positions payload is ${bytes.length} bytes, expected ${expected}`);
    }
    const positions = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2);

    let valid = null;
    if (json.valid != null) {
      const vb = b64ToBytes(json.valid);
      if (vb.length !== nFrames) throw new Error('pose sidecar: valid mask length mismatch');
      valid = vb;
    }

    // Bones: canonical flat pair list [i0,j0,i1,j1,...]; nested [[i,j],...]
    // accepted for hand-authored files.
    let bonePairs = [];
    if (Array.isArray(json.bones)) {
      if (Array.isArray(json.bones[0])) {
        for (const b of json.bones) {
          if (!Array.isArray(b) || b.length !== 2) throw new Error('pose sidecar: bad bone entry');
          bonePairs.push(b[0], b[1]);
        }
      } else {
        bonePairs = json.bones;
      }
    } else {
      throw new Error('pose sidecar: bones array required');
    }
    for (const idx of bonePairs) {
      if (!(idx >= 0 && idx < nJoints)) throw new Error('pose sidecar: bone index out of range');
    }
    const bones = Int32Array.from(bonePairs);

    let names = null;
    if (Array.isArray(json.names)) {
      if (json.names.length !== nJoints) throw new Error('pose sidecar: names length mismatch');
      names = json.names.slice();
    }

    const durationS = Number.isFinite(json.duration_s) ? Number(json.duration_s) : nFrames / fs;

    // v2: optional per-frame joint angles (n_frames × n_joints) feeding
    // the mesh skinning path. Same frame grid and validity semantics as
    // `positions`.
    // `n_angles` is the joint-angle count per frame (UmeTrack: 20 DOF
    // for 21 landmarks); it defaults to n_joints for hand-authored files.
    const nAngles = json.n_angles != null ? (json.n_angles | 0) : nJoints;
    let angles = null;
    if (json.angles) {
      if (nAngles <= 0) throw new Error('pose sidecar: n_angles must be > 0');
      angles = decodeBlock(json.angles, nFrames * nAngles * 4, 'angles');
      for (let f = 0; f < nFrames; f++) {
        if (!Number.isFinite(angles[f * nAngles])) {
          valid = valid || new Uint8Array(nFrames).fill(1);
          valid[f] = 0;
        }
      }
    }

    const mesh = json.mesh ? parseMeshBlock(json.mesh, nAngles, angles, nJoints) : null;

    // Optional default camera (radians) chosen by the exporter so the
    // first frame reads as a hand (palm/back facing the viewer).
    let camera = null;
    if (json.camera && Number.isFinite(json.camera.yaw) && Number.isFinite(json.camera.pitch)) {
      camera = { yaw: Number(json.camera.yaw), pitch: Number(json.camera.pitch) };
    }

    return {
      fs, nFrames, nJoints, nAngles, durationS,
      bones, names, valid, positions, angles, mesh, camera,
    };
  }

  // ---- pure: sampling ----------------------------------------

  /**
   * Sample the parsed record at time tSec. Linear interpolation between
   * neighbouring frames when `interpolate` (default). Clamps to the
   * recording bounds. Frames flagged invalid in the `valid` mask (IK
   * failures upstream) or containing NaN yield { ok:false } rather than
   * garbage geometry.
   *
   * Returns { ok:true, t, positions } or { ok:false, reason:'ik-failure', t }.
   * The returned positions array is reused between calls (scratch) —
   * copy it if you need to retain it.
   */
  function frameAt(parsed, tSec, interpolate = true) {
    const { fs, nFrames, nJoints, durationS, positions, valid } = parsed;
    const t = Math.max(0, Math.min(durationS, tSec));
    const fExact = Math.min(nFrames - 1, t * fs);
    const f0 = Math.floor(fExact);
    const f1 = Math.min(nFrames - 1, f0 + 1);
    const alpha = interpolate ? fExact - f0 : 0;

    const badFrame = (f) => (valid && !valid[f]) ||
      !Number.isFinite(positions[f * nJoints * 3]);

    if (badFrame(f0) || (alpha > 0 && badFrame(f1))) {
      return { ok: false, reason: 'ik-failure', t };
    }

    let scratch = parsed._scratch;
    if (!scratch || scratch.length !== nJoints * 3) {
      scratch = parsed._scratch = new Float32Array(nJoints * 3);
    }
    const o0 = f0 * nJoints * 3;
    const o1 = f1 * nJoints * 3;
    for (let i = 0; i < nJoints * 3; i++) {
      scratch[i] = positions[o0 + i] + alpha * (positions[o1 + i] - positions[o0 + i]);
    }
    return { ok: true, t, positions: scratch };
  }

  /**
   * Sample the per-frame joint angles at tSec (v2 mesh path). Same
   * clamping/interpolation semantics as frameAt; angles live on the
   * same frame grid, so validity follows the shared mask.
   * Returns { ok:true, t, angles } | { ok:false, reason:'ik-failure', t }.
   */
  function anglesAt(parsed, tSec, interpolate = true) {
    const { fs, nFrames, nAngles, durationS, angles, valid } = parsed;
    if (!angles) return { ok: false, reason: 'no-angles', t: 0 };
    const nJoints = nAngles;
    const t = Math.max(0, Math.min(durationS, tSec));
    const fExact = Math.min(nFrames - 1, t * fs);
    const f0 = Math.floor(fExact);
    const f1 = Math.min(nFrames - 1, f0 + 1);
    const alpha = interpolate ? fExact - f0 : 0;

    if ((valid && !valid[f0]) || (alpha > 0 && valid && !valid[f1])) {
      return { ok: false, reason: 'ik-failure', t };
    }

    let scratch = parsed._angleScratch;
    if (!scratch || scratch.length !== nJoints) {
      scratch = parsed._angleScratch = new Float32Array(nJoints);
    }
    for (let j = 0; j < nJoints; j++) {
      const a = angles[f0 * nJoints + j];
      const b = angles[f1 * nJoints + j];
      scratch[j] = a + alpha * (b - a);
    }
    return { ok: true, t, angles: scratch };
  }

  // ---- pure: linear-blend skinning (v2 mesh path) ---------------

  /**
   * Rodrigues rotation of `d` around unit axis `k` by angle θ.
   * Writes into `out`. Standard formula:
   *   v·cosθ + (k×v)·sinθ + k(k·v)(1-cosθ)
   */
  function rotateAroundAxis(out, d, k, theta) {
    const c = Math.cos(theta), s = Math.sin(theta);
    const kdv = k[0] * d[0] + k[1] * d[1] + k[2] * d[2];
    const cx = k[1] * d[2] - k[2] * d[1];
    const cyk = k[2] * d[0] - k[0] * d[2];
    const cz = k[0] * d[1] - k[1] * d[0];
    const oneC = 1 - c;
    out[0] = d[0] * c + cx * s + k[0] * kdv * oneC;
    out[1] = d[1] * c + cyk * s + k[1] * kdv * oneC;
    out[2] = d[2] * c + cz * s + k[2] * kdv * oneC;
    return out;
  }

  const IDENT34 = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);

  /** out = A · B for 3×4 row-major affines (rotation | translation). */
  function mulAffine(out, A, B) {
    for (let r = 0; r < 3; r++) {
      const a0 = A[r * 4], a1 = A[r * 4 + 1], a2 = A[r * 4 + 2], a3 = A[r * 4 + 3];
      out[r * 4]     = a0 * B[0] + a1 * B[4] + a2 * B[8];
      out[r * 4 + 1] = a0 * B[1] + a1 * B[5] + a2 * B[9];
      out[r * 4 + 2] = a0 * B[2] + a1 * B[6] + a2 * B[10];
      out[r * 4 + 3] = a0 * B[3] + a1 * B[7] + a2 * B[11] + a3;
    }
    return out;
  }

  /**
   * UmeTrack forward kinematics (`_hand_skinning_transform` in
   * emg2pose/UmeTrack/lib/common/hand_skinning.py): per finger, chain the
   * four joint transforms — each a rotation by `angles[q]` about
   * `axes[q]` anchored at `rests[q]` — and keep the frames after joints
   * 2, 3 and 4 (proximal, intermediate, distal). Root and wrist stay at
   * identity (emg2pose fixes the wrist transform).
   * Writes 17 row-major 3×4 affines into `out` (Float32Array(17 * 12)).
   */
  function umetrackFrames(angles, axes, rests, out) {
    out.fill(0);
    out.set(IDENT34, 0);
    out.set(IDENT34, 12);
    const L = umetrackFrames._L || (umetrackFrames._L = new Float64Array(12));
    const T = umetrackFrames._T || (umetrackFrames._T = new Float64Array(12));
    const N = umetrackFrames._N || (umetrackFrames._N = new Float64Array(12));
    const k = [0, 0, 0], e = [0, 0, 0];
    for (let f = 0; f < 5; f++) {
      T.set(IDENT34);
      for (let j = 0; j < 4; j++) {
        const q = 4 * f + j;
        k[0] = axes[q * 3]; k[1] = axes[q * 3 + 1]; k[2] = axes[q * 3 + 2];
        // Rotation columns via Rodrigues on the basis vectors.
        rotateAroundAxis(e, [1, 0, 0], k, angles[q]); L[0] = e[0]; L[4] = e[1]; L[8] = e[2];
        rotateAroundAxis(e, [0, 1, 0], k, angles[q]); L[1] = e[0]; L[5] = e[1]; L[9] = e[2];
        rotateAroundAxis(e, [0, 0, 1], k, angles[q]); L[2] = e[0]; L[6] = e[1]; L[10] = e[2];
        // Translation so the joint rotates about its rest anchor: t = r − R·r.
        const rx = rests[q * 3], ry = rests[q * 3 + 1], rz = rests[q * 3 + 2];
        L[3]  = rx - (L[0] * rx + L[1] * ry + L[2] * rz);
        L[7]  = ry - (L[4] * rx + L[5] * ry + L[6] * rz);
        L[11] = rz - (L[8] * rx + L[9] * ry + L[10] * rz);
        mulAffine(N, T, L);
        T.set(N);
        if (j >= 1) out.set(T, (2 + 3 * f + (j - 1)) * 12);
      }
    }
    return out;
  }

  /**
   * Linear-blend skinning: p' = Σ_k w[v,k] · F_k · [p_v, 1] over the sparse
   * (vertex, bone, weight) triplets; weights sum to 1 per vertex in the
   * UmeTrack model. `mirrorX` flips x afterwards (left hands).
   */
  function skinPoints(frames, rest, weights, nPoints, mirrorX, out) {
    out.fill(0);
    const { wv, wb, ww } = weights;
    for (let i = 0; i < wv.length; i++) {
      const v = wv[i], w = ww[i];
      if (w === 0) continue;
      const m = wb[i] * 12;
      const px = rest[v * 3], py = rest[v * 3 + 1], pz = rest[v * 3 + 2];
      out[v * 3]     += w * (frames[m]     * px + frames[m + 1] * py + frames[m + 2]  * pz + frames[m + 3]);
      out[v * 3 + 1] += w * (frames[m + 4] * px + frames[m + 5] * py + frames[m + 6]  * pz + frames[m + 7]);
      out[v * 3 + 2] += w * (frames[m + 8] * px + frames[m + 9] * py + frames[m + 10] * pz + frames[m + 11]);
    }
    if (mirrorX) for (let v = 0; v < nPoints; v++) out[v * 3] = -out[v * 3];
    return out;
  }

  function framesFor(parsed, angles) {
    let fr = parsed._fkFrames;
    if (!fr || fr.length !== FK_FRAMES * 12) fr = parsed._fkFrames = new Float32Array(FK_FRAMES * 12);
    return umetrackFrames(angles, parsed.mesh.axes, parsed.mesh.jointRest, fr);
  }

  /** Skin the hand mesh at sampled joint angles. Returns a reused Float32Array(V*3). */
  function skinMesh(parsed, angles) {
    const mesh = parsed.mesh;
    if (!mesh) throw new Error('skinMesh: sidecar has no mesh block');
    let out = parsed._meshScratch;
    if (!out || out.length !== mesh.nVerts * 3) out = parsed._meshScratch = new Float32Array(mesh.nVerts * 3);
    return skinPoints(framesFor(parsed, angles), mesh.restVertices, mesh.weights, mesh.nVerts, mesh.mirrorX, out);
  }

  /** Skin the 21 landmarks from angles (needs `rest_landmarks`); oracle for `positions`. */
  function skinLandmarks(parsed, angles) {
    const mesh = parsed.mesh;
    if (!mesh || !mesh.landmarks) throw new Error('skinLandmarks: sidecar has no landmark skinning data');
    let out = parsed._lmScratch;
    if (!out || out.length !== parsed.nJoints * 3) out = parsed._lmScratch = new Float32Array(parsed.nJoints * 3);
    return skinPoints(framesFor(parsed, angles), mesh.landmarks.rest, mesh.landmarks.weights, parsed.nJoints, mesh.mirrorX, out);
  }

  // ---- pure: projection ---------------------------------------

  /**
   * Rotate joints (yaw around Y, then pitch around X), auto-fit to the
   * viewport and orthographically project. Returns screen-space arrays
   * plus depth for painter's-algorithm ordering downstream.
   *
   * view: { yaw, pitch, zoom } radians/ratio; w/h CSS pixels; pad px.
   */
  function rotateProject(positions, nJoints, yaw, pitch, w, h, pad, zoom) {
    // Trig locals deliberately suffixed — plain `cy`/`sy` collided with
    // the screen-y scratch below (caught by unit tests; kept suffixed so
    // it cannot regress).
    const cyw = Math.cos(yaw), syw = Math.sin(yaw);
    const cpt = Math.cos(pitch), spt = Math.sin(pitch);

    // Rotate into scratch, tracking bounds for auto-fit.
    const n = nJoints;
    const rx = rotateProject._rx && rotateProject._rx.length >= n
      ? rotateProject._rx : (rotateProject._rx = new Float32Array(n));
    const ry = rotateProject._ry && rotateProject._ry.length >= n
      ? rotateProject._ry : (rotateProject._ry = new Float32Array(n));
    const rz = rotateProject._rz && rotateProject._rz.length >= n
      ? rotateProject._rz : (rotateProject._rz = new Float32Array(n));

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let j = 0; j < n; j++) {
      const x = positions[j * 3], y = positions[j * 3 + 1], z = positions[j * 3 + 2];
      const x1 = x * cyw + z * syw;
      const z1 = -x * syw + z * cyw;
      const y2 = y * cpt - z1 * spt;
      const z2 = y * spt + z1 * cpt;
      rx[j] = x1; ry[j] = y2; rz[j] = z2;
      if (x1 < minX) minX = x1; if (x1 > maxX) maxX = x1;
      if (y2 < minY) minY = y2; if (y2 > maxY) maxY = y2;
    }

    const spanX = Math.max(maxX - minX, 1e-6);
    const spanY = Math.max(maxY - minY, 1e-6);
    const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY) * (zoom || 1);
    const cx = (minX + maxX) / 2, cyy = (minY + maxY) / 2;

    const sx = rotateProject._sx && rotateProject._sx.length >= n
      ? rotateProject._sx : (rotateProject._sx = new Float32Array(n));
    const syp = rotateProject._sy && rotateProject._sy.length >= n
      ? rotateProject._sy : (rotateProject._sy = new Float32Array(n));
    for (let j = 0; j < n; j++) {
      sx[j] = w / 2 + (rx[j] - cx) * scale;
      syp[j] = h / 2 - (ry[j] - cyy) * scale;
    }
    return { sx, sy: syp, depth: rz };
  }

  // ---- pure-ish: paint -----------------------------------------

  /**
   * Draw one frame onto a 2D context. Returns true when geometry was
   * drawn, false for IK-failure frames (caller shows a badge).
   * opts: { yaw, pitch, zoom, w, h, dpr }
   */
  function drawFrame(ctx, parsed, tSec, opts) {
    const { yaw, pitch, zoom, w, h } = opts;
    ctx.clearRect(0, 0, w, h);
    const fr = frameAt(parsed, tSec);
    if (!fr.ok) {
      ctx.fillStyle = 'rgba(120,124,130,0.9)';
      ctx.font = '11px IBM Plex Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('no IK data', w / 2, h / 2);
      return false;
    }
    const proj = rotateProject(fr.positions, parsed.nJoints, yaw || 0, pitch || 0, w, h, DEFAULT_PAD, zoom || 1);

    // Bones: far-to-near so nearer segments overpaint; depth also maps
    // to stroke alpha for cheap depth cueing (no WebGL required).
    const nb = parsed.bones.length >> 1;
    const order = [];
    for (let b = 0; b < nb; b++) order.push(b);
    order.sort((a, b) => {
      const da = proj.depth[parsed.bones[a << 1]] + proj.depth[parsed.bones[(a << 1) | 1]];
      const dbb = proj.depth[parsed.bones[b << 1]] + proj.depth[parsed.bones[(b << 1) | 1]];
      return dbb - da;
    });
    // Normalise depth range once for alpha mapping.
    let zMin = Infinity, zMax = -Infinity;
    for (let j = 0; j < parsed.nJoints; j++) {
      if (proj.depth[j] < zMin) zMin = proj.depth[j];
      if (proj.depth[j] > zMax) zMax = proj.depth[j];
    }
    const zSpan = Math.max(zMax - zMin, 1e-6);

    ctx.lineCap = 'round';
    for (const b of order) {
      const i0 = parsed.bones[b << 1], i1 = parsed.bones[(b << 1) | 1];
      const dNorm = ((proj.depth[i0] + proj.depth[i1]) / 2 - zMin) / zSpan;
      ctx.strokeStyle = `rgba(23,24,26,${0.35 + 0.55 * dNorm})`;
      ctx.lineWidth = 1.5 + dNorm;
      ctx.beginPath();
      ctx.moveTo(proj.sx[i0], proj.sy[i0]);
      ctx.lineTo(proj.sx[i1], proj.sy[i1]);
      ctx.stroke();
    }
    // Joints on top; wrist (joint 0) emphasised as the anchor.
    for (let j = 0; j < parsed.nJoints; j++) {
      const dNorm = (proj.depth[j] - zMin) / zSpan;
      const r = (j === 0 ? 4 : 2.5) * (0.85 + 0.3 * dNorm);
      ctx.beginPath();
      ctx.arc(proj.sx[j], proj.sy[j], r, 0, Math.PI * 2);
      ctx.fillStyle = j === 0 ? '#D55E00' : '#17181a';
      ctx.fill();
    }
    return true;
  }

  /**
   * Draw the skinned mesh (v2). Painter's algorithm over triangles with
   * cheap lambert shading from a fixed headlight. Returns true when
   * painted, false for IK-failure frames. opts: { yaw, pitch, zoom, w, h }.
   */
  function drawMesh(ctx, parsed, tSec, opts) {
    const mesh = parsed.mesh;
    if (!mesh) return false;
    const fr = anglesAt(parsed, tSec);
    if (!fr.ok) {
      ctx.fillStyle = 'rgba(120,124,130,0.9)';
      ctx.font = '11px IBM Plex Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('no IK data', opts.w / 2, opts.h / 2);
      return false;
    }
    const verts = skinMesh(parsed, fr.angles);
    // rotateProject is vertex-count agnostic; reuse it for all V verts.
    const proj = rotateProject(
      verts, mesh.nVerts,
      opts.yaw || 0, opts.pitch || 0, opts.w, opts.h, DEFAULT_PAD, opts.zoom || 1,
    );

    // Face depth + normal shading in one pass over triangles.
    const T = mesh.nTris;
    const order = drawMesh._order && drawMesh._order.length >= T
      ? drawMesh._order : (drawMesh._order = new Uint32Array(T));
    const shade = drawMesh._shade && drawMesh._shade.length >= T
      ? drawMesh._shade : (drawMesh._shade = new Float32Array(T));
    // Fixed headlight direction (view-independent approximation).
    const LX = -0.35, LY = -0.6, LZ = 0.72;
    for (let t = 0; t < T; t++) {
      const i0 = mesh.triangles[t * 3] * 3;
      const i1 = mesh.triangles[t * 3 + 1] * 3;
      const i2 = mesh.triangles[t * 3 + 2] * 3;
      // Geometric 3D normal via cross of two edges.
      const ux = verts[i1] - verts[i0], uy = verts[i1 + 1] - verts[i0 + 1], uz = verts[i1 + 2] - verts[i0 + 2];
      const vx = verts[i2] - verts[i0], vy = verts[i2 + 1] - verts[i0 + 1], vz = verts[i2 + 2] - verts[i0 + 2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      let lam = nx * LX + ny * LY + nz * LZ;
      shade[t] = 0.45 + 0.55 * Math.abs(lam); // double-sided: abs keeps backfaces visible
      order[t] = t;
    }
    order.sort((a, b) => {
      const da = proj.depth[mesh.triangles[a * 3]] +
        proj.depth[mesh.triangles[a * 3 + 1]] + proj.depth[mesh.triangles[a * 3 + 2]];
      const db = proj.depth[mesh.triangles[b * 3]] +
        proj.depth[mesh.triangles[b * 3 + 1]] + proj.depth[mesh.triangles[b * 3 + 2]];
      return db - da;
    });
    ctx.lineJoin = 'round';
    for (let k = 0; k < T; k++) {
      const t = order[k];
      const s = Math.round(150 + 70 * shade[t]);
      ctx.fillStyle = `rgb(${s + 60},${s},${s + 8})`;
      ctx.beginPath();
      const a = mesh.triangles[t * 3], b = mesh.triangles[t * 3 + 1], c = mesh.triangles[t * 3 + 2];
      ctx.moveTo(proj.sx[a], proj.sy[a]);
      ctx.lineTo(proj.sx[b], proj.sy[b]);
      ctx.lineTo(proj.sx[c], proj.sy[c]);
      ctx.closePath();
      ctx.fill();
    }
    return true;
  }

  /** Cycle view mode: auto → skeleton → mesh → both → auto. */
  function nextMode(mode, hasMesh) {
    if (!hasMesh) return mode === 'auto' ? 'auto' : 'auto'; // only auto exists
    const cycle = { auto: 'skeleton', skeleton: 'mesh', mesh: 'both', both: 'auto' };
    return cycle[mode] || 'auto';
  }

  // ---- DOM glue ------------------------------------------------

  function el(tag, cls, text) {
    const e = globalThis.document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /**
   * Mount the floating panel into #stage (or a supplied container).
   * Returns a controller: { root, canvas, load(url), show(), hide(),
   * toggle(), syncWindow(startSec, windowSec), syncCursor(t|null) }.
   */
  function mount(opts = {}) {
    const doc = globalThis.document;
    const container = opts.container
      || doc.getElementById('stage')
      || doc.body;

    const root = el('div', 'pose-panel');
    root.setAttribute('hidden', '');
    const header = el('div', 'pose-header');
    header.append(el('span', 'pose-title', 'Hand pose'));
    const closeBtn = el('button', 'pose-close');
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Close hand-pose panel');
    header.append(closeBtn);
    const canvas = doc.createElement('canvas');
    canvas.className = 'pose-canvas';
    canvas.width = 260; canvas.height = 260;
    const caption = el('div', 'pose-caption', '');
    root.append(header, canvas, caption);
    container.append(root);

    const ctx2d = canvas.getContext('2d');

    // Camera state persists across loads.
    const DEFAULT_CAM = { yaw: -0.5, pitch: 0.25 };
    const cam = { ...DEFAULT_CAM, zoom: 1, mode: 'auto' };
    let home = DEFAULT_CAM;   // sidecar `camera` overrides on load

    // Time state: visible-window centre from syncWindow; transient
    // hover override from syncCursor with TTL fallback.
    let centerT = null;
    let cursorT = null;
    let cursorAt = 0;
    let parsed = null;
    let rafId = null;
    let drag = null;

    closeBtn.addEventListener('click', () => hide());

    // Optional header button (index.html `.header-right`); wired once
    // to the shared controller by openUrl(), never per mount(). Looked
    // up at call time so a button added after mount still reflects.
    function reflect(visible) {
      const toggleBtn = doc.getElementById('pose-toggle');
      if (toggleBtn) toggleBtn.setAttribute('aria-pressed', String(visible));
      // Docked (embed) layout: the panel shares the stage row with the
      // traces canvas, so its visibility changes the canvas width.
      // viewer.js refits on window resize; nudge it.
      try { globalThis.dispatchEvent(new globalThis.Event('resize')); } catch { /* no window */ }
    }

    function schedule() {
      if (rafId != null) return;
      rafId = globalThis.requestAnimationFrame(() => {
        rafId = null;
        redraw();
      });
    }

    function redraw() {
      if (!parsed) return;
      const fresh = cursorT != null && (Date.now() - cursorAt) < CURSOR_TTL_MS;
      const t = fresh ? cursorT : centerT;
      if (t == null) return;
      // Backing-store size tracks CSS size × dpr like traces.js.
      const dpr = globalThis.devicePixelRatio || 1;
      const cssW = canvas.clientWidth || canvas.width;
      const cssH = canvas.clientHeight || canvas.height;
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      // View mode: 'auto' shows the mesh when the sidecar carries one,
      // otherwise the skeleton; explicit modes honour the choice.
      const hasMesh = !!parsed.mesh;
      const mode = cam.mode === 'auto' ? (hasMesh ? 'mesh' : 'skeleton') : cam.mode;
      const opts = { ...cam, w: cssW, h: cssH };
      if (mode !== 'skeleton') drawMesh(ctx2d, parsed, t, opts);
      if (mode !== 'mesh') drawFrame(ctx2d, parsed, t, opts);
      caption.textContent =
        `t = ${t.toFixed(3)} s${hasMesh ? ` · ${mode}` : ''}`;
    }

    // Orbit + zoom (pointer events cover mouse/touch/pen uniformly).
    canvas.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, yaw: cam.yaw, pitch: cam.pitch };
      try { canvas.setPointerCapture(e.pointerId); } catch {}
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      cam.yaw = drag.yaw + (e.clientX - drag.x) * 0.01;
      cam.pitch = Math.max(-1.45, Math.min(1.45, drag.pitch + (e.clientY - drag.y) * 0.01));
      schedule();
    });
    const endDrag = () => { drag = null; };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      cam.zoom = Math.max(0.3, Math.min(8, cam.zoom * Math.exp(-e.deltaY * 0.001)));
      schedule();
    }, { passive: false });
    canvas.addEventListener('dblclick', () => {
      cam.yaw = home.yaw; cam.pitch = home.pitch; cam.zoom = 1;
      schedule();
    });

    async function load(url) {
      try {
        const res = await globalThis.fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        parsed = parseSidecar(await res.json());
        home = parsed.camera || DEFAULT_CAM;
        cam.yaw = home.yaw; cam.pitch = home.pitch; cam.zoom = 1;
        show();
        schedule();
      } catch (err) {
        parsed = null;
        show();
        caption.textContent = `pose load failed: ${err.message}`;
      }
    }

    function show() { root.removeAttribute('hidden'); reflect(true); }
    function hide() { root.setAttribute('hidden', ''); reflect(false); }
    function toggle() { root.hasAttribute('hidden') ? show() : hide(); }
    /** Cycle skeleton/mesh view; no-op without a mesh block. */
    function cycleMode() {
      cam.mode = nextMode(cam.mode || 'auto', !!(parsed && parsed.mesh));
      schedule();
    }

    function syncWindow(startSec, windowSec) {
      centerT = startSec + windowSec / 2;
      schedule();
    }
    function syncCursor(t) {
      if (t == null) { cursorT = null; schedule(); return; }
      cursorT = t; cursorAt = Date.now();
      schedule();
    }

    return {
      root, canvas, load, show, hide, toggle, cycleMode,
      syncWindow, syncCursor, redraw,
    };
  }

  // ---- bootstrap -----------------------------------------------

  /** Wire keyboard: 'p' toggles panel, 'm' cycles skeleton/mesh. */
  function attachKeys(controller) {
    globalThis.addEventListener?.('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'p' || e.key === 'P') controller.toggle();
      if (e.key === 'm' || e.key === 'M') controller.cycleMode();
    });
  }

  /**
   * Boot from URL params: `?pose=<url>` resolves against the page URL,
   * mounts the panel and starts loading. Returns the controller or null.
   */
  // Controller booted from URL params (or null). The viewer's hooks
  // call the MODULE-level syncWindow/syncCursor below, which forward to
  // this instance — mount() users manage controllers directly.
  let _active = null;

  /**
   * Open a sidecar URL on the shared controller: mounts (and wires
   * keys) on first use, then just reloads — hosts that push a new
   * recording (postMessage bridge, drag-drop) never stack panels.
   */
  function openUrl(url) {
    if (!_active) {
      _active = mount({});
      attachKeys(_active);
    }
    // Header button (index.html `.header-right`): wired once, to whatever
    // the shared controller is, so re-opens never stack listeners.
    const btn = globalThis.document?.getElementById('pose-toggle');
    if (btn && !btn.dataset.poseWired) {
      btn.dataset.poseWired = '1';
      btn.hidden = false;
      btn.addEventListener('click', () => _active?.toggle());
    }
    _active.load(url);
    return _active;
  }

  /** Hide the shared panel (a recording without a sidecar was opened). */
  function hideActive() {
    _active?.hide();
  }

  function bootFromParams(params) {
    const poseUrl = params && params.get ? params.get('pose') : null;
    if (!poseUrl) return null;
    const abs = globalThis.location ? new URL(poseUrl, globalThis.location.href).href : poseUrl;
    return openUrl(abs);
  }

  /** Module-level bridge: visible-window centre (viewer.js hook). */
  function syncWindow(startSec, windowSec) {
    _active?.syncWindow(startSec, windowSec);
  }

  /** Module-level bridge: hover-time override (viewer.js hook). */
  function syncCursor(t) {
    _active?.syncCursor(t);
  }

  const api = {
    FORMAT, VERSION,
    FK_DOF, FK_FRAMES,
    b64ToBytes, parseSidecar, parseMeshBlock, frameAt, anglesAt,
    rotateAroundAxis, umetrackFrames, skinPoints, skinMesh, skinLandmarks,
    rotateProject, drawFrame, drawMesh, nextMode,
    mount, attachKeys, openUrl, hideActive, bootFromParams, syncWindow, syncCursor,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.PosePanel = api;

  // Auto-boot in the browser once the stage exists. Script tags sit in
  // <head>, so wait for DOMContentLoaded; the no-document guard keeps
  // node:test imports side-effect free.
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    const start = () => bootFromParams(new URLSearchParams(window.location.search));
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  }
})();
