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
