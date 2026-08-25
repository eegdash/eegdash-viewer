/* ============================================================
   pose-kinematics.js — UmeTrack forward kinematics + linear-blend
   skinning. Pure math, no DOM: pose-panel.js skins the hand with it
   per frame; tests drive it against the exporter's numpy port
   (scripts/export-pose-sidecar.py) as an oracle.

   Model (emg2pose/UmeTrack/lib/common/hand_skinning.py):
     - 20 DOF = 5 fingers × 4 joints; each joint rotates by angle θ_q
       about a unit axis anchored at its rest position.
     - 17 skinning frames: root, wrist (both identity — emg2pose fixes
       the wrist) and, per finger, the frames after joints 2, 3, 4
       (proximal, intermediate, distal).
     - A point is Σ_k w[v,k] · F_k · [p_v, 1] over sparse weights.
   ============================================================ */
'use strict';
(function () {
  const FK_DOF = 20;
  const FK_FRAMES = 17;

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
  const _L = new Float64Array(12), _T = new Float64Array(12), _N = new Float64Array(12);
  function umetrackFrames(angles, axes, rests, out) {
    out.set(IDENT34, 0);
    out.set(IDENT34, 12);
    for (let f = 0; f < 5; f++) {
      _T.set(IDENT34);
      for (let j = 0; j < 4; j++) {
        const q = 4 * f + j;
        const kx = axes[q * 3], ky = axes[q * 3 + 1], kz = axes[q * 3 + 2];
        const c = Math.cos(angles[q]), s = Math.sin(angles[q]), oneC = 1 - c;
        // Rodrigues, R = I + s·K + (1−c)·K² for the unit axis k (row-major).
        _L[0] = c + kx * kx * oneC;      _L[1] = kx * ky * oneC - kz * s;  _L[2]  = kx * kz * oneC + ky * s;
        _L[4] = ky * kx * oneC + kz * s; _L[5] = c + ky * ky * oneC;      _L[6]  = ky * kz * oneC - kx * s;
        _L[8] = kz * kx * oneC - ky * s; _L[9] = kz * ky * oneC + kx * s; _L[10] = c + kz * kz * oneC;
        // Translation so the joint rotates about its rest anchor: t = r − R·r.
        const rx = rests[q * 3], ry = rests[q * 3 + 1], rz = rests[q * 3 + 2];
        _L[3]  = rx - (_L[0] * rx + _L[1] * ry + _L[2]  * rz);
        _L[7]  = ry - (_L[4] * rx + _L[5] * ry + _L[6]  * rz);
        _L[11] = rz - (_L[8] * rx + _L[9] * ry + _L[10] * rz);
        mulAffine(_N, _T, _L);
        _T.set(_N);
        if (j >= 1) out.set(_T, (2 + 3 * f + (j - 1)) * 12);
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

  const api = { FK_DOF, FK_FRAMES, IDENT34, mulAffine, umetrackFrames, skinPoints };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.PoseKinematics = api;
})();
