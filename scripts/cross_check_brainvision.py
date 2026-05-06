"""Ground-truth dump for the BrainVision smoke test (Phase 4)."""
from __future__ import annotations

import sys
from pathlib import Path

import mne
import numpy as np

from _cross_check_lib import dump_reference, make_fetcher

# ds002336 sub-xp101 task-motorloc: 64 channels, fs=5000 Hz, INT_16 +
# MULTIPLEXED + 0.5 µV resolution. Picked because:
#   - the .eeg is small enough to cache (~215 MB);
#   - exercises the "no _eeg.json at the run level" inheritance gap that
#     ds002336 puts at the dataset root (verifying the BrainVision reader
#     can fall back to the .vhdr's own SamplingInterval);
#   - has [Channel Infos] in the .vhdr we can verify against.
DATASET = "ds002336"
SUB = "sub-xp101"
ENT = "sub-xp101_task-motorloc"
S3 = f"https://s3.amazonaws.com/openneuro.org/{DATASET}/{SUB}/eeg"
N_REF = 100

HERE = Path(__file__).parent
fetch = make_fetcher(S3, HERE / ".cache" / DATASET / SUB)


def main() -> int:
    vhdr_path = fetch(f"{ENT}_eeg.vhdr")
    fetch(f"{ENT}_eeg.eeg")
    fetch(f"{ENT}_eeg.vmrk")
    raw = mne.io.read_raw_brainvision(vhdr_path, preload=False, verbose="ERROR")

    # mne returns volts internally; BrainVision .vhdr [Channel Infos]
    # specify resolution in µV per int16 step. Multiply by 1e6 so reference
    # matches what our reader emits (it applies the per-channel µV scale).
    data, _ = raw[:, :N_REF]
    values_uv = (data * 1e6).astype(np.float32)

    dump_reference(
        HERE / "cross_check_brainvision.json",
        source=f"{S3}/{ENT}_eeg.vhdr",
        raw=raw,
        n_ref=N_REF,
        values_uv=values_uv,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
