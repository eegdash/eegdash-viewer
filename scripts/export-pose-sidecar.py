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
# UmeTrack landmark order (emg2pose/UmeTrack/lib/common/hand.py, LANDMARK):
# the five fingertips, the wrist, then per finger its frames base→tip, palm.
LANDMARKS = [
    "thumb_tip", "index_tip", "middle_tip", "ring_tip", "pinky_tip", "wrist",
    "thumb_intermediate", "thumb_distal",
    "index_proximal", "index_intermediate", "index_distal",
    "middle_proximal", "middle_intermediate", "middle_distal",
    "ring_proximal", "ring_intermediate", "ring_distal",
    "pinky_proximal", "pinky_intermediate", "pinky_distal",
    "palm_center",
]
_CHAINS = [[5, 6, 7, 0], [5, 8, 9, 10, 1], [5, 11, 12, 13, 2], [5, 14, 15, 16, 3], [5, 17, 18, 19, 4]]
BONES = [i for chain in _CHAINS for pair in zip(chain, chain[1:]) for i in pair]


def fk_frames_batch(angles, axes, rests):
    """UmeTrack `_hand_skinning_transform` for all frames: (F, 20) → (F, 17, 4, 4).

    Per joint the local transform is a Rodrigues rotation about its unit
    axis anchored at its rest position; per finger the four joints chain
    and the frames after joints 2, 3, 4 are kept (proximal, intermediate,
    distal); root and wrist stay identity. Vectorised over frames.
    """
    angles = np.asarray(angles, float)
    F = angles.shape[0]
    K = np.zeros((N_DOF, 3, 3))
    K[:, 0, 1], K[:, 0, 2] = -axes[:, 2], axes[:, 1]
    K[:, 1, 0], K[:, 1, 2] = axes[:, 2], -axes[:, 0]
    K[:, 2, 0], K[:, 2, 1] = -axes[:, 1], axes[:, 0]
    KK = K @ K
    s, c = np.sin(angles)[..., None, None], (1 - np.cos(angles))[..., None, None]
    R = np.eye(3) + s * K + c * KK                                  # (F, 20, 3, 3)
    L = np.tile(np.eye(4), (F, N_DOF, 1, 1))
    L[..., :3, :3] = R
    L[..., :3, 3] = rests - np.einsum("fqij,qj->fqi", R, rests)     # rotate about the anchor
    out = np.tile(np.eye(4), (F, N_FRAMES, 1, 1))
    for f in range(5):
        T = L[:, 4 * f]
        for j in range(1, 4):
            T = T @ L[:, 4 * f + j]
            out[:, 2 + 3 * f + (j - 1)] = T
    return out


def fk_frames(angles, axes, rests):
    """Single-frame convenience wrapper: (20,) → (17, 4, 4)."""
    return fk_frames_batch(np.asarray(angles)[None], axes, rests)[0]


def skin_batch(frames, points, weights):
    """Linear-blend skinning for all frames: Σ_k w[v,k] · F_k · [p_v, 1] → (F, V, 3)."""
    P = np.c_[points, np.ones(len(points))]
    return np.einsum("vk,fkij,vj->fvi", weights, frames, P, optimize=True)[..., :3]


def skin(frames, points, weights):
    """Single-frame convenience wrapper: (17, 4, 4) → (V, 3)."""
    return skin_batch(np.asarray(frames)[None], points, weights)[0]


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


def load_model(path):
    """The UmeTrack hand model plus the arrays FK and the sidecar share."""
    model = json.loads(Path(path).read_text())
    return {
        "model": model,
        "axes": np.asarray(model["joint_rotation_axes"], float)[:N_DOF],
        "rests": np.asarray(model["joint_rest_positions"], float)[:N_DOF],
        "lm_rest": np.asarray(model["landmark_rest_positions"], float),
        "LW": dense_landmark_weights(model),
    }


def mesh_block(hm, mirror_x):
    model = hm["model"]
    block = {
        "mode": "umetrack-fk",
        "mirror_x": bool(mirror_x),
        "joint_axes": _f32(hm["axes"]),
        "joint_rest": _f32(hm["rests"]),
        "rest_vertices": _f32(model["mesh_vertices"]),
        "triangles": _u32(model["mesh_triangles"]),
        "rest_landmarks": _f32(hm["lm_rest"]),
    }
    block.update(_sparse(np.asarray(model["dense_bone_weights"], float)))
    block.update({"landmark_" + k: v for k, v in _sparse(hm["LW"]).items()})
    return block


def load_angles(recording, fs_out, start, duration):
    """Joint angles (20, F) decimated to ~fs_out Hz from [start, start+duration] s.

    Window bounds are clamped to the recording (the last window of a
    session needs no exact length); only the joint channels are read.
    """
    raw = mne.io.read_raw(recording, preload=False, verbose="ERROR")
    joint_chs = [c for c in raw.ch_names if c.lower().startswith("joint")]
    if len(joint_chs) != N_DOF:
        sys.exit(f"expected {N_DOF} `joint*` channels in {Path(recording).name}, found {len(joint_chs)}")
    fs = raw.info["sfreq"]
    n = raw.n_times
    i0 = min(n, max(0, int(round(start * fs))))
    i1 = n if duration is None else min(n, i0 + int(round(duration * fs)))
    if i1 <= i0:
        sys.exit(f"window [{start}, +{duration}] s is outside the {n / fs:.1f} s recording")
    step = max(1, int(round(fs / fs_out)))
    ang = raw.get_data(picks=joint_chs, start=i0, stop=i1)[:, ::step].astype(np.float32)
    return ang, fs / step


def build_sidecar(ang, fs_pose, start, hm, mirror, check=False, mesh=True):
    """Assemble the eegdash-pose document for angles (20, F) at fs_pose Hz."""
    valid = np.isfinite(ang).all(axis=0)
    ang = np.nan_to_num(ang)
    pos_raw = skin_batch(fk_frames_batch(ang.T, hm["axes"], hm["rests"]), hm["lm_rest"], hm["LW"])
    if check:
        check_against_emg2pose(ang, hm["model"], pos_raw)
    pos = (pos_raw * ([-1, 1, 1] if mirror else 1)).astype(np.float32)
    n_frames = int(pos.shape[0])
    sidecar = {
        "format": "eegdash-pose",
        "version": 1,
        "fs": fs_pose,
        "n_frames": n_frames,
        "n_joints": int(pos.shape[1]),
        "n_angles": N_DOF,
        "names": LANDMARKS,
        "bones": BONES,
        "root": LANDMARKS.index("wrist"),
        "duration_s": n_frames / fs_pose,
        "start_s": float(start),
        "camera": DEFAULT_CAMERA,
        "positions": _f32(pos.reshape(-1)),
        "angles": _f32(ang.T.reshape(-1)),
        "valid": base64.b64encode(valid.astype(np.uint8).tobytes()).decode(),
    }
    if mesh:
        sidecar["mesh"] = mesh_block(hm, mirror)
    return sidecar


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
    ap.add_argument("--duration", type=float, default=None, help="window length (s); default: to the end")
    ap.add_argument("--no-mesh", action="store_true", help="skeleton-only sidecar (no hand model)")
    ap.add_argument("--model", default=str(Path(__file__).parent / "umetrack_generic_hand_model.json"))
    ap.add_argument("--out", default=None, help="output path; default <prefix>_desc-pose.json next to the recording")
    ap.add_argument("--check", action="store_true", help="compare numpy FK with emg2pose (needs torch + emg2pose)")
    args = ap.parse_args()

    rec = Path(args.recording)
    side = args.side or next((t for t in ("left", "right") if f"recording-{t}" in rec.stem), None)
    ang, fs_pose = load_angles(rec, args.fs, args.start, args.duration)
    sidecar = build_sidecar(ang, fs_pose, args.start, load_model(args.model), side == "left",
                            check=args.check, mesh=not args.no_mesh)
    out = Path(args.out) if args.out else rec.with_name(rec.stem.rsplit("_", 1)[0] + "_desc-pose.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(sidecar, separators=(",", ":")))
    valid = np.frombuffer(base64.b64decode(sidecar["valid"]), np.uint8)
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB): {sidecar['n_frames']} frames @ "
          f"{sidecar['fs']:.1f} Hz, side={side}, mesh={'no' if args.no_mesh else 'yes'}, "
          f"valid={valid.mean():.1%}")


if __name__ == "__main__":
    main()
