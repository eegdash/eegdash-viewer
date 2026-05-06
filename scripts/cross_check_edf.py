"""Ground-truth dump for the EDF smoke test (Phase 3)."""
from __future__ import annotations

import sys
from pathlib import Path

import mne
import numpy as np

from _cross_check_lib import dump_reference, make_fetcher

# ds002034 sub-01 ses-01 task-offline run-01: 64 EEG + 16 misc + 1 trigger,
# fs=512 Hz, duration 733 s, 16-bit EDF (~58 MB). Picked for compactness
# and because BIDS sidecars (_channels.tsv, _eeg.json) are present.
DATASET = "ds002034"
SUB = "sub-01"
SES = "ses-01"
ENT = "sub-01_ses-01_task-offline_run-01"
S3 = f"https://s3.amazonaws.com/openneuro.org/{DATASET}/{SUB}/{SES}/eeg"
N_REF = 100

HERE = Path(__file__).parent
fetch = make_fetcher(S3, HERE / ".cache" / DATASET / SUB / SES)


def main() -> int:
    edf_path = fetch(f"{ENT}_eeg.edf")
    raw = mne.io.read_raw_edf(edf_path, preload=False, verbose="ERROR")

    # mne returns volts internally; the BIDS _channels.tsv units are uV
    # and our Node reader emits whatever the EDF physical_dimension says
    # (uV here). Multiply by 1e6 so reference and Node values share units.
    data, _ = raw[:, :N_REF]
    values_uv = (data * 1e6).astype(np.float32)

    # mne re-encodes stim channels as event codes; flag those so the
    # smoke test can skip them when comparing physical values.
    is_stim = [t == "stim" for t in raw.get_channel_types()]

    dump_reference(
        HERE / "cross_check_edf.json",
        source=f"{S3}/{ENT}_eeg.edf",
        raw=raw,
        n_ref=N_REF,
        values_uv=values_uv,
        extras={"is_stim": is_stim},
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
