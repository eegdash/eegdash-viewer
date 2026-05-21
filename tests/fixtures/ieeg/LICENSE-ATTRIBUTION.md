# iEEG fixture attribution

This directory contains small iEEG-format fixtures used by the unit /
property tests. Each entry below documents the upstream source and
license so future maintainers can audit re-distribution.

## sub-01_ses-iemu_task-film_acq-clinical_run-1_ieeg.* (BrainVision)

Sourced from the BIDS `ieeg_visual` example dataset
(https://github.com/bids-standard/bids-examples), CC0. A clinical
intracranial EEG recording in BrainVision format (.vhdr / .vmrk / .eeg)
used to exercise the BrainVision reader's iEEG channel-type handling.

## nwb-tiny.nwb (synthesised, CC0)

`nwb-tiny.nwb` is synthesised by `scripts/make-nwb-fixture.mjs` (this
repo) via Python's `h5py`. No upstream data. Released under CC0. Binary
layout follows the NWB schema documented at
https://nwb-schema.readthedocs.io/ (BSD-3-clause).

- 4 channels, 5000 samples @ 1000 Hz = 5 s recording.
- `/acquisition/ECoG` as `ElectricalSeries` with float32 data,
  `starting_time.rate = 1000.0`.
- `/general/extracellular_ephys/electrodes` `DynamicTable` with `id`
  and `label` columns; labels are `LFP1`..`LFP4`.
- Sample values: deterministic sinusoids — channel c carries
  `sin(2π(c+1)t)`, so the unit tests can assert exact byte-stable
  values at t = 0 and t = 1.0 s.

The fixture is intentionally well under the reader's 200 MB whole-
file cap so the in-memory parse path is always exercised. NWB files
in DANDI commonly exceed several GB; range-based / chunked NWB
streaming is a deliberately-deferred follow-up (jsfive cannot do
HTTP-range reads on HDF5 chunk index pages).

To regenerate after a Python h5py upgrade:

```
node scripts/make-nwb-fixture.mjs
```

Requires `pip install h5py numpy` in the active Python environment.

## mef-tiny.mefd/ (synthesised, CC0)

The MEF3 directory bundle in `mef-tiny.mefd/` is synthesised by
`scripts/make-mef-fixture.mjs` (this repo) — no upstream data. Released
under CC0. Binary layout follows the Multiscale Electrophysiology
Format v3 spec from `msel-source/meflib` (Apache 2.0):

> Copyright 2013, Mayo Foundation, Rochester MN. Apache 2.0 license.
> https://github.com/msel-source/meflib

Universal-header byte offsets and the Koopman32 CRC table embedded in
`formats/_mef-segment.js` are quoted verbatim from `meflib.h` and
`meflib.c` and are subject to the Apache 2.0 license of the original
work.

Fixture parameters:
- 4 channels (A1, A2, A3, A4), each in its own `<channel>.timd/` dir.
- 2500 samples @ 1000 Hz = 2.5 s per channel.
- One segment per channel (`<channel>-000000.{tmet, tdat, tidx}`).
- Universal headers carry valid Koopman32 CRCs (validated by the
  `formats/_mef-segment.js` parser in unit tests).
- **No actual RED-encoded sample data** — the `.tdat` files contain
  placeholder block-header bodies only. The fixture is consistent with
  the **Tier 1** reader, which parses metadata + structure but throws
  on `readWindow()` because the RED codec is not yet implemented (see
  `formats/mef.js` header for the full rationale).

Therefore the fixture cannot be used to verify sample-level decode
accuracy. Doing so requires either implementing the full RED codec
(meflib.c `RED_decode`, ~2000 LOC of bit-level range-decoding logic)
or sourcing a redistributable real-world `.mefd/` recording. Neither
is in scope for this initial reader.

To regenerate:

```
node scripts/make-mef-fixture.mjs
```
