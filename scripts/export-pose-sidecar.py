#!/usr/bin/env python
"""Export an `eegdash-pose` sidecar (skeleton + skinned-hand mesh) from a
recording with joint-angle channels (emg2pose BDF conversions:
`joint0..joint19`).

    python scripts/export-pose-sidecar.py recording_emg.bdf \
        [--side left|right] [--fs 30] [--start 0] [--duration N] [--no-mesh] \
        [--model scripts/umetrack_generic_hand_model.json] [--check]

Writes `<prefix>_desc-pose.json` next to the recording (format spec:
docs/pose-sidecar.md). The sidecar carries, per frame, the 21 UmeTrack
landmarks (`positions`, drawn as the skeleton) and the 20 raw joint
angles (`angles`), plus the hand model (`mesh` block: rest vertices,
triangles, sparse skinning weights, joint axes/anchors) so the viewer
skins the full hand itself. Left/right is auto-detected from the BIDS
`recording-<side>` entity and mirrored via x-negation.

Forward kinematics is a numpy port of UmeTrack's `skin_landmarks`
(hand_skinning.py); `--check` compares it against emg2pose's torch
implementation when that package is importable (max |Δ| ≈ 2e-5, float32).
Requires only: mne, numpy.
"""
import argparse
import base64
import json
import sys
from pathlib import Path

import mne
import numpy as np

N_DOF = 20        # 5 fingers × 4 joints (the 2 wrist DOFs are unused by FK)
N_FRAMES = 17     # root, wrist, 5 fingers × (proximal, intermediate, distal)
DEFAULT_CAMERA = {"yaw": -0.4, "pitch": -1.0}   # back of the hand, fingers spread


def _rodrigues(axis, theta):
    k = axis / (np.linalg.norm(axis) or 1.0)
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + np.sin(theta) * K + (1 - np.cos(theta)) * (K @ K)


def fk_frames(angles, axes, rests):
    """UmeTrack `_hand_skinning_transform` for one frame → (17, 4, 4)."""
    eye = np.eye(4)
    out = [eye, eye]                                   # root, wrist
    for f in range(5):
        T = eye
        for j in range(4):
            q = 4 * f + j
            R = _rodrigues(axes[q], angles[q])
            L = np.eye(4)
            L[:3, :3] = R
            L[:3, 3] = rests[q] - R @ rests[q]        # rotate about the rest anchor
            T = T @ L
            if j >= 1:                                 # frames after joints 2, 3, 4
                out.append(T)
    return np.stack(out)


def skin(frames, points, weights):
    """Linear-blend skinning: Σ_k w[v,k] · F_k · [p_v, 1]. weights: (V, 17)."""
    P = np.c_[points, np.ones(len(points))]
    return np.einsum("vk,kij,vj->vi", weights, frames, P)[:, :3]


def dense_landmark_weights(model):
    idx = np.asarray(model["landmark_rest_bone_indices"], int)
    w = np.asarray(model["landmark_rest_bone_weights"], float)
    W = np.zeros((idx.shape[0], N_FRAMES))
    for v in range(idx.shape[0]):
        for k in range(idx.shape[1]):
            W[v, idx[v, k]] += w[v, k]
    return W


def _f32(a):
    return {"encoding": "base64-f32",
            "data": base64.b64encode(np.ascontiguousarray(a, dtype="<f4").tobytes()).decode()}


def _u32(a):
    return {"encoding": "base64-u32",
            "data": base64.b64encode(np.ascontiguousarray(a, dtype="<u4").tobytes()).decode()}


def _sparse(W, eps=1e-6):
    v, b = np.nonzero(W > eps)
    return {"weight_vertex": _u32(v), "weight_bone": _u32(b), "weight_value": _f32(W[v, b])}


def mesh_block(model, mirror_x):
    LW = dense_landmark_weights(model)
    block = {
        "mode": "umetrack-fk",
        "mirror_x": bool(mirror_x),
        "n_fk_frames": N_FRAMES,
        "joint_axes": _f32(np.asarray(model["joint_rotation_axes"])[:N_DOF]),
        "joint_rest": _f32(np.asarray(model["joint_rest_positions"])[:N_DOF]),
        "rest_vertices": _f32(model["mesh_vertices"]),
        "triangles": _u32(model["mesh_triangles"]),
        "rest_landmarks": _f32(model["landmark_rest_positions"]),
    }
    block.update(_sparse(np.asarray(model["dense_bone_weights"], float)))
    lm = _sparse(LW)
    block.update({"landmark_" + k: v for k, v in lm.items()})
    return block


def check_against_emg2pose(angles, model, positions_numpy):
    """Optional oracle: emg2pose's torch FK on the same angles."""
    import types
    import torch
    import emg2pose
    path = Path(emg2pose.__file__).parent / "kinematics.py"
    mod = types.ModuleType("emg2pose.kinematics")
    sys.modules["emg2pose.kinematics"] = mod
    exec(compile("from __future__ import annotations\n" + path.read_text(), str(path), "exec"),
         mod.__dict__)
    hand = mod.load_hand_model_from_dict(model)
    ref = mod.forward_kinematics(torch.from_numpy(angles.astype(np.float32))[None], hand)[0].numpy()  # (1, 20, F) → (F, 21, 3)
    err = np.abs(ref - positions_numpy).max()
    print(f"check vs emg2pose torch FK: max |Δ| = {err:.2e}")
    if err > 1e-3:
        sys.exit("numpy FK disagrees with emg2pose")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("recording", help="mne-readable recording with joint* channels")
    ap.add_argument("--side", choices=["left", "right"], default=None,
                    help="hand side; default auto from `recording-<side>`")
    ap.add_argument("--fs", type=float, default=30.0, help="output pose rate (Hz)")
    ap.add_argument("--start", type=float, default=0.0, help="window start (s)")
    ap.add_argument("--duration", type=float, default=None, help="window length (s); default: all")
    ap.add_argument("--no-mesh", action="store_true", help="skeleton-only sidecar (no hand model)")
    ap.add_argument("--model", default=str(Path(__file__).parent / "umetrack_generic_hand_model.json"))
    ap.add_argument("--out", default=None, help="output path; default <prefix>_desc-pose.json next to the recording")
    ap.add_argument("--check", action="store_true", help="compare numpy FK with emg2pose (needs torch + emg2pose)")
    args = ap.parse_args()

    model = json.loads(Path(args.model).read_text())
    axes = np.asarray(model["joint_rotation_axes"], float)[:N_DOF]
    rests = np.asarray(model["joint_rest_positions"], float)[:N_DOF]
    lm_rest = np.asarray(model["landmark_rest_positions"], float)
    LW = dense_landmark_weights(model)

    rec = Path(args.recording)
    raw = mne.io.read_raw(rec, preload=True, verbose="ERROR")
    joint_chs = [c for c in raw.ch_names if c.lower().startswith("joint")]
    if len(joint_chs) != N_DOF:
        sys.exit(f"expected {N_DOF} `joint*` channels in {rec.name}, found {len(joint_chs)}")
    fs = raw.info["sfreq"]
    stop = None if args.duration is None else args.start + args.duration
    raw.crop(tmin=args.start, tmax=stop, include_tmax=False)
    step = max(1, int(round(fs / args.fs)))
    ang = raw.get_data(picks=joint_chs)[:, ::step].astype(np.float32)    # (20, F)
    valid = np.isfinite(ang).all(axis=0)
    ang = np.nan_to_num(ang)

    side = args.side or next((t for t in ("left", "right") if f"recording-{t}" in rec.stem), None)
    mirror = side == "left"
    pos = np.stack([skin(fk_frames(a, axes, rests), lm_rest, LW) for a in ang.T]).astype(np.float32)
    if mirror:
        pos[..., 0] *= -1
    if args.check:
        unmirrored = pos.copy()
        if mirror:
            unmirrored[..., 0] *= -1
        check_against_emg2pose(ang, model, unmirrored)

    bones = []
    for f in range(5):                       # landmarks: [wrist, finger0×4, …]
        bones += [0, 1 + 4 * f]
        for k in range(3):
            bones += [1 + 4 * f + k, 2 + 4 * f + k]

    n_frames = int(pos.shape[0])
    sidecar = {
        "format": "eegdash-pose",
        "version": 1,
        "fs": fs / step,
        "n_frames": n_frames,
        "n_joints": int(pos.shape[1]),
        "n_angles": N_DOF,
        "bones": bones,
        "duration_s": n_frames * step / fs,
        "start_s": float(args.start),
        "camera": DEFAULT_CAMERA,
        "positions": _f32(pos.reshape(-1)),
        "angles": _f32(ang.T.reshape(-1)),
        "valid": base64.b64encode(valid.astype(np.uint8).tobytes()).decode(),
    }
    if not args.no_mesh:
        sidecar["mesh"] = mesh_block(model, mirror)

    out = Path(args.out) if args.out else rec.with_name(rec.stem.rsplit("_", 1)[0] + "_desc-pose.json")
    out.write_text(json.dumps(sidecar, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB): {n_frames} frames @ "
          f"{sidecar['fs']:.1f} Hz, side={side}, mesh={'no' if args.no_mesh else 'yes'}, "
          f"valid={valid.mean():.1%}")


if __name__ == "__main__":
    main()
