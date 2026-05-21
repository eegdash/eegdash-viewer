# MEG fixture attribution

This directory contains small MEG-format fixtures used by the unit /
property tests. Each entry below documents the upstream source and
license so future maintainers can audit re-distribution.

## test-eve.fif / test-proj.fif / test_raw-annot.fif / synth-raw.fif / test_ctf_comp_raw.fif

Sourced from MNE-Python (https://github.com/mne-tools/mne-python),
BSD-3-clause. Small FIFF test files used to exercise the FIFF reader's
parse paths. See the MNE-Python LICENSE.txt for full terms.

`test_ctf_comp_raw.fif` (432 KB) is the smallest real-world FIFF in
the MNE-Python repo with an actual `FIFFB_RAW_DATA` block — 340
channels at 480 Hz, 0.5 s recording. Used by
`tests/unit-fiff-realworld.test.mjs` to verify the reader handles
production-grade FIFF (vs. the 5 KB `synth-raw.fif` which only
exercises the synthesised happy path).

## ctf-tiny.ds/ (synthesised, CC0)

Files in `ctf-tiny.ds/` are synthesised by `scripts/make-ctf-fixture.mjs`
(this repo) — no upstream data. Released under CC0. Binary layout follows
the CTF MEG format documented in MNE-Python's `mne/io/ctf/res4.py`
(BSD-3 clause).

- 4 channels (3 MEG + 1 EEG), 250 samples @ 100 Hz = 2.5 s recording.
- Sample values: deterministic sine waves at increasing frequency per channel.
- One marker at t=0.5 s and t=1.25 s. One bad channel: EEG001.

## kit-tiny.con (synthesised, CC0)

`kit-tiny.con` is synthesised by `scripts/make-kit-fixture.mjs` (this
repo) — no upstream data. Released under CC0. Binary layout follows the
KIT/Yokogawa/Ricoh MEG format documented in MNE-Python's
`mne/io/kit/kit.py` + `mne/io/kit/constants.py` (BSD-3-clause). Field
offsets in the SYSTEM and ACQ_COND directories were cross-checked
against the vendored sources at `/tmp/kit_kit.py` (lines 483-718) at
the time of authorship.

- 4 channels, 500 samples @ 1000 Hz = 0.5 s recording.
- 16-bit ADC, 12 bits stored, ± 0.5 V range.
- Per-channel deterministic sine waves at increasing frequency.
- Acquisition mode: CONTINUOUS (acq_type=1). Epoched/evoked KIT files
  are intentionally NOT generated here — the reader rejects them with
  a clean error, and supporting them would be a separate fixture.
