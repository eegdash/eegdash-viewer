"""Ground-truth dump for the EEGLAB .fdt smoke test (Phase 2)."""
from __future__ import annotations

import sys
from pathlib import Path

import mne
import numpy as np

from _cross_check_lib import dump_reference, make_fetcher

# ds002893 sub-001 task-AuditoryVisualShift run-01: 36 channels, fs=250 Hz,
# duration ~3473 s. Picked because it's small enough to round-trip in
# seconds (~125 MB .fdt), has _channels.tsv + _eeg.json so our Node reader
# has the metadata it needs (we never parse .set), and matches the case
# in scripts/smoke-sidecars.mjs.
DATASET = "ds002893"
SUB = "sub-001"
ENT = "sub-001_task-AuditoryVisualShift_run-01"
S3 = f"https://s3.amazonaws.com/openneuro.org/{DATASET}/{SUB}/eeg"
N_REF = 100

HERE = Path(__file__).parent
fetch = make_fetcher(S3, HERE / ".cache" / DATASET / SUB)


def main() -> int:
    set_path = fetch(f"{ENT}_eeg.set")
    fetch(f"{ENT}_eeg.fdt")
    raw = mne.io.read_raw_eeglab(set_path, preload=False, verbose="ERROR")

    # mne returns volts; EEGLAB writes microvolts to .fdt. Multiply by 1e6
    # so the reference values are in the same unit the Node reader observes.
    data, _ = raw[:, :N_REF]
    values_uv = (data * 1e6).astype(np.float32)

    dump_reference(
        HERE / "cross_check_eeglab.json",
        source=f"{S3}/{ENT}_eeg.set",
        raw=raw,
        n_ref=N_REF,
        values_uv=values_uv,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
