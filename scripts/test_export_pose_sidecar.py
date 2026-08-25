"""pytest for scripts/export-pose-sidecar.py (run: pytest scripts/)."""
import base64
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("export_pose_sidecar", HERE / "export-pose-sidecar.py")
exp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exp)
MODEL = HERE / "umetrack_generic_hand_model.json"


def _f32(block):
    return np.frombuffer(base64.b64decode(block["data"]), "<f4")


@pytest.fixture(scope="module")
def hm():
    return exp.load_model(MODEL)


def test_zero_angles_reproduce_rest_landmarks(hm):
    lm = exp.skin(exp.fk_frames(np.zeros(exp.N_DOF), hm["axes"], hm["rests"]), hm["lm_rest"], hm["LW"])
    assert np.allclose(lm, hm["lm_rest"], atol=1e-9)


def test_landmark_order_matches_umetrack(hm):
    """Bending the thumb's distal joint moves the thumb tip, never the wrist or other fingers."""
    ang = np.zeros(exp.N_DOF)
    ang[3] = 0.5  # finger 0 (thumb), distal joint
    lm = exp.skin(exp.fk_frames(ang, hm["axes"], hm["rests"]), hm["lm_rest"], hm["LW"])
    moved = np.linalg.norm(lm - hm["lm_rest"], axis=1) > 1e-6
    names = exp.LANDMARKS
    assert moved[names.index("thumb_tip")]
    assert not moved[[names.index(n) for n in ("wrist", "index_tip", "index_proximal", "pinky_tip")]].any()
    assert len(exp.BONES) == 2 * (3 + 4 * 4) and max(exp.BONES) == 19 and min(exp.BONES) == 0


def test_build_sidecar_shape_and_mirror(hm):
    ang = np.zeros((exp.N_DOF, 3), np.float32)
    ang[0, 1] = np.nan
    sc = exp.build_sidecar(ang, 30.0, 1 / 30, 10.0, hm, mirror=True)
    assert (sc["n_frames"], sc["n_joints"], sc["n_angles"], sc["start_s"]) == (3, 21, exp.N_DOF, 10.0)
    assert np.frombuffer(base64.b64decode(sc["valid"]), np.uint8).tolist() == [1, 0, 1]
    pos = _f32(sc["positions"]).reshape(3, 21, 3)
    assert np.allclose(pos[0, :, 0], -hm["lm_rest"][:, 0])  # left hand: x mirrored
    assert sc["mesh"]["mode"] == "umetrack-fk" and sc["mesh"]["mirror_x"] is True
    assert "n_fk_frames" not in sc["mesh"]
    assert len(_f32(sc["mesh"]["joint_axes"])) == exp.N_DOF * 3


def test_load_angles_clamps_the_window(tmp_path):
    mne = pytest.importorskip("mne")
    fs = 200.0
    info = mne.create_info([f"joint{i}" for i in range(exp.N_DOF)] + ["emg0"], fs, ["misc"] * exp.N_DOF + ["emg"])
    raw = mne.io.RawArray(np.zeros((exp.N_DOF + 1, int(4 * fs))), info, verbose="ERROR")
    path = tmp_path / "sub-1_task-a_recording-left_emg.edf"
    mne.export.export_raw(path, raw, fmt="edf", overwrite=True, verbose="ERROR")
    ang, fs_pose, dt = exp.load_angles(path, 50.0, start=3.0, duration=10.0)  # overshoots: clamped to 1 s
    assert ang.shape == (exp.N_DOF, 50) and fs_pose == 50.0 and dt == 1 / 50
    ang_all, _, _ = exp.load_angles(path, 50.0, start=0.0, duration=None)
    assert ang_all.shape[1] == 200  # every sample of the 4 s recording, none dropped
    with pytest.raises(SystemExit):
        exp.load_angles(path, 50.0, start=9.0, duration=None)
