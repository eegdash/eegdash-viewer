# MEG fixture attribution

This directory contains small MEG-format fixtures used by the unit /
property tests. Each entry below documents the upstream source and
license so future maintainers can audit re-distribution.

## test-eve.fif / test-proj.fif / test_raw-annot.fif / synth-raw.fif

Sourced from MNE-Python (https://github.com/mne-tools/mne-python),
BSD-3-clause. Small FIFF test files used to exercise the FIFF reader's
parse paths. See the MNE-Python LICENSE.txt for full terms.

## ctf-tiny.ds/ (synthesised, CC0)

Files in `ctf-tiny.ds/` are synthesised by `scripts/make-ctf-fixture.mjs`
(this repo) — no upstream data. Released under CC0. Binary layout follows
the CTF MEG format documented in MNE-Python's `mne/io/ctf/res4.py`
(BSD-3 clause).

- 4 channels (3 MEG + 1 EEG), 250 samples @ 100 Hz = 2.5 s recording.
- Sample values: deterministic sine waves at increasing frequency per channel.
- One marker at t=0.5 s and t=1.25 s. One bad channel: EEG001.
