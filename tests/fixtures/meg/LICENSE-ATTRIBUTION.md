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

## bti-tiny/ (synthesised, CC0)

Files in `bti-tiny/` are synthesised by `scripts/make-bti-fixture.mjs`
(this repo) — no upstream data. Released under CC0. Binary layout
follows the 4D Neuroimaging / BTi (Magnes WH3600) PDF format
documented in MNE-Python's `mne/io/bti/bti.py` + `mne/io/bti/read.py`
+ `mne/io/bti/constants.py` (BSD-3-clause). Field offsets in the PDF
tail header and per-epoch / per-channel records were cross-checked
against the vendored sources at `/tmp/mne_bti.py` (lines 766-848) at
the time of authorship.

- 4 channels, 500 samples @ 100 Hz = 5 s recording.
- `data_format` = 3 → float32 big-endian on disk (per the MNE DTYPES
  table; the other documented modes — int16 / int32 / float64 BE —
  are exercised by their own decode branches but not by this fixture).
- Per-channel deterministic sine waves: `sin(2π · t/100 · (c+1))`
  written as float32 BE, interleaved per sample.
- Single epoch (continuous acquisition). Multi-epoch / evoked PDFs
  are intentionally NOT generated here — the reader rejects them
  with a clean error.
- Bundle layout:
  - `config` — minimal stub (128 B). The real BTi `config` is a
    multi-MB binary with many user blocks (channel maps, calibration,
    weight tables). The reader opens recordings purely from the PDF
    tail header and falls back to indexed channel labels Ch1..ChN,
    so the stub config is sufficient for current tests. See
    `formats/_bti-config.js` for the deferred config-block parser.
  - `c,rfDC` — the PDF (Patient Data File). Filename literal — BTi
    bundles carry no file extensions. `c,rfDC` is the most common
    naming (raw, no high-pass); alternates like `c,rfhp1.0Hz` exist
    and the reader probes for all known variants when the caller
    passes the bundle directory.

## kriss-tiny.kdf (synthesised, CC0)

`kriss-tiny.kdf` is synthesised by `scripts/make-kriss-fixture.mjs`
(this repo) — no upstream data. Released under CC0.

Unlike `kit-tiny.con`, this fixture is **not** a structurally valid
KRISS recording — it is a STUB used by the `formats/kriss.js` STUB
reader. The KRISS (Korea Research Institute of Standards and Science)
`.kdf` binary format has no public specification: it is documented in
the BIDS-MEG appendix at the filename level only
(https://bids-specification.readthedocs.io/en/stable/appendices/meg-file-formats.html#kriss),
and neither MNE-Python (no `mne/io/kriss/` module) nor FieldTrip (no
`read_kriss_header.m`) ships a public reader.

The fixture exists solely to exercise the stub reader's two code paths:
1. KRISS-shaped header detected → throws "not yet implemented" error
2. Bytes don't look like KRISS → throws "not a valid KRISS file" error

Bytes 0..3 carry the ASCII "KDF\0" magic (the four-byte signature we
adopt for the stub); bytes 16..29 carry the label "KRISS MEG v0.0".
The rest is a deterministic sin-byte pattern. When a real .kdf spec
becomes available, this script will be rewritten to emit a structurally
valid file and the reader will gain a real parser. See
`scripts/make-kriss-fixture.mjs` for the layout details.
