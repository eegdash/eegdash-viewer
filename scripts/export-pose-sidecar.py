#!/usr/bin/env python
"""Export an `eegdash-pose` skeleton sidecar from a recording with
joint-angle channels (emg2pose BDF conversions: `joint0..joint19`).

Forward kinematics runs here (Python, UmeTrack `HandModel`), so the
viewer stays dumb: it only plays back the precomputed joint positions.

    python scripts/export-pose-sidecar.py recording_emg.bdf \
        [--side left|right] [--fs 30] [--model scripts/umetrack_generic_hand_model.json]

Writes `<prefix>_desc-pose.json` next to the recording (format spec:
docs/pose-sidecar.md). Left/right is auto-detected from the BIDS
`recording-<side>` entity and mirrored via x-negation.

Requires: mne, numpy, torch, and facebookresearch/emg2pose
(`pip install git+https://github.com/facebookresearch/emg2pose`).
"""
import argparse
import base64
import json
import sys
import types
from pathlib import Path

import mne
import numpy as np
import torch


def _load_kinematics():
    """Import emg2pose.kinematics with PEP-563 forced.

    Upstream evaluates a `NamedTuple | Any` annotation at class-body
    time, which raises TypeError on Python >= 3.10 without
    `from __future__ import annotations`; inject it before exec instead
    of patching site-packages.
    """
    import emg2pose  # noqa: F401  (fail early with a clear error)

    path = Path(emg2pose.__file__).parent / "kinematics.py"
    src = "from __future__ import annotations\n" + path.read_text()
    mod = types.ModuleType("emg2pose.kinematics")
    mod.__file__ = str(path)
    sys.modules["emg2pose.kinematics"] = mod
    exec(compile(src, mod.__file__, "exec"), mod.__dict__)
    return mod


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("recording", help="mne-readable recording with joint* channels")
    ap.add_argument("--side", choices=["left", "right"], default=None,
                    help="hand side; default auto from `recording-<side>`")
    ap.add_argument("--fs", type=float, default=30.0, help="output pose rate")
    ap.add_argument("--model", default=str(Path(__file__).parent / "umetrack_generic_hand_model.json"))
    args = ap.parse_args()

    kin = _load_kinematics()
    hand = kin.load_hand_model_from_dict(json.loads(Path(args.model).read_text()))

    rec = Path(args.recording)
    raw = mne.io.read_raw(rec, preload=True, verbose="ERROR")
    joint_chs = [c for c in raw.ch_names if c.lower().startswith("joint")]
    if not joint_chs:
        sys.exit(f"no `joint*` channels in {rec.name}")
    angles = raw.get_data(picks=joint_chs)          # (20, T) channels-first
    fs = raw.info["sfreq"]

    step = max(1, int(round(fs / args.fs)))
    idx = np.arange(0, angles.shape[1], step)
    ang = angles[:, idx].astype(np.float32)         # (20, F)
    valid = np.isfinite(ang).all(axis=0).astype(np.uint8)
    ang = np.nan_to_num(ang)

    # forward_kinematics expects (B, n_dof, T); returns (B, T, J, 3).
    pos = kin.forward_kinematics(torch.from_numpy(ang)[None], hand)[0]
    pos = pos.numpy().astype(np.float32)

    side = args.side or next(
        (t for t in ("left", "right") if f"recording-{t}" in rec.stem), None)
    if side == "left":  # mirror across the yz plane
        pos[..., 0] *= -1

    # FK returns the 21 UmeTrack landmarks ordered
    # [wrist, finger0 x4, finger1 x4, finger2 x4, finger3 x4, finger4 x4];
    # bones use the standard hand topology (each finger chains off wrist).
    bones = []
    for f in range(5):
        bones += [0, 1 + 4 * f]
        for k in range(3):
            bones += [1 + 4 * f + k, 2 + 4 * f + k]

    sidecar = {
        "format": "eegdash-pose",
        "version": 1,
        "fs": fs / step,
        "n_frames": int(pos.shape[0]),
        "n_joints": int(pos.shape[1]),
        "bones": bones,
        "duration_s": float(pos.shape[0]) * step / fs,
        "positions": {"encoding": "base64-f32",
                      "data": base64.b64encode(
                          np.ascontiguousarray(pos.reshape(-1)).tobytes()).decode()},
        "valid": base64.b64encode(valid.tobytes()).decode(),
    }
    out = rec.with_name(rec.stem.rsplit("_", 1)[0] + "_desc-pose.json")
    out.write_text(json.dumps(sidecar))
    print(f"wrote {out.name}: {sidecar['n_frames']} frames @ "
          f"{sidecar['fs']:.1f} Hz, {sidecar['n_joints']} joints, "
          f"side={side}, valid={valid.mean():.1%}")


if __name__ == "__main__":
    main()
