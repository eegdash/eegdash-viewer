"""Ground-truth dump for the BDF (24-bit BioSemi) smoke test.

ds001787 sub-003 ses-01 task-meditation is the smallest BDF on
ds001787 (~59 MB). BDF differs from EDF in two places: the 0xFF
header byte, and 24-bit signed sample storage instead of int16.
That last bit is the one that's easy to get wrong — sign-extension
at -2^23 / +2^23-1 is silently fatal — so this test is the one
that catches int24 decode regressions.
"""
from __future__ import annotations

import sys
from pathlib import Path

import mne
import numpy as np

from _cross_check_lib import dump_reference, make_fetcher

DATASET = "ds001787"
SUB = "sub-003"
SES = "ses-01"
ENT = "sub-003_ses-01_task-meditation"
S3 = f"https://s3.amazonaws.com/openneuro.org/{DATASET}/{SUB}/{SES}/eeg"
N_REF = 100

HERE = Path(__file__).parent
fetch = make_fetcher(S3, HERE / ".cache" / DATASET / SUB / SES)


def main() -> int:
    bdf_path = fetch(f"{ENT}_eeg.bdf")
    raw = mne.io.read_raw_bdf(bdf_path, preload=False, verbose="ERROR")

    # Note on BDF unit handling: BDF doesn't carry channel-type
    # metadata so mne defaults everything to `eeg/V`, including
    # non-voltage sensors (GSR1/2 in ohms, Temp in °C, EXG, Status).
    # mne's "value" for those sensors is therefore in nominal volts
    # — but the file actually declares them in their own physical
    # units, and our reader returns whatever the file says. To stay
    # apples-to-apples we compare only channels mne and our reader
    # agree on: BioSemi channels A1-A32, B1-B32 (the first 64) are
    # real EEG; everything else (EXG, GSR, Resp, Plet, Temp, Erg,
    # Status) is skipped from the value-equality check.
    BIOSEMI_EEG_PREFIXES = ("A", "B", "C", "D", "E", "F", "G", "H")
    AUX_PREFIXES = ("EXG", "GSR", "Erg", "Resp", "Plet", "Temp")
    types = raw.get_channel_types()
    data, _ = raw[:, :N_REF]
    values_uv = (data * 1e6).astype(np.float32)

    is_stim = [t == "stim" for t in types]
    skip = []
    for name, stim in zip(raw.ch_names, is_stim):
        is_eeg = (
            name[0] in BIOSEMI_EEG_PREFIXES
            and len(name) >= 2
            and name[1].isdigit()
        )
        is_aux = any(name.startswith(p) for p in AUX_PREFIXES)
        skip.append(stim or is_aux or not is_eeg)

    dump_reference(
        HERE / "cross_check_bdf.json",
        source=f"{S3}/{ENT}_eeg.bdf",
        raw=raw,
        n_ref=N_REF,
        values_uv=values_uv,
        extras={"is_stim": is_stim, "skip": skip},
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
