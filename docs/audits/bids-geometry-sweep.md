# BIDS sensor geometry audit

## Scope and reproducibility

The audit downloads every `electrodes.tsv`, `optodes.tsv` and
`coordsystem.json` in the official BIDS examples at
[`ca54a02e55548090fced87f38a28bae13a1f692d`](https://github.com/bids-standard/bids-examples/tree/ca54a02e55548090fced87f38a28bae13a1f692d).
All 260 files were retrieved, covering 116 coordinate tables in 21 datasets.
Cached reruns use the same immutable input.

```sh
node scripts/audit-sensor-inputs.mjs
```

Each table goes through the production sidecar matcher, parser and display
conversion. Assertions check finite output, preservation of source geometry,
unit/axis conversion and absence of silent template substitution.
[Full results](bids-geometry-sweep.json) include every file, frame, position
count and parsing issue. This is a coordinate-input audit, not a complete
BIDS validator or an end-to-end test of every raw format.

| Modality | Coordinate tables | Renderable 3D | No valid 3D positions |
| --- | ---: | ---: | ---: |
| EEG | 41 | 41 | 0 |
| iEEG | 40 | 33 | 7 |
| fNIRS | 29 | 24 | 5 |
| EMG | 6 | 5 | 1 |
| Total | 116 | 103 | 13 |

There are no MEG electrode tables in this pinned collection. MEG coverage
comes from the native FIFF comparison and synthetic mixed EEG/MEG sidecars.

## Why 13 tables cannot provide this view

- Seven `ieeg_filtered_speech` tables have no finite participant x/y/z.
- Five `fnirs_tapping` tables have missing x/y/z. Custom `template_x/y/z`
  columns exist, but are not silently substituted for participant positions.
- The high-density EMG table in `emg_ConcurrentIndependentUnits` lacks a z
  column. A planar export does not establish the missing depth.

Other tables with partially missing coordinates keep their valid points and
report skipped rows. Published EMG `EMGCoordinateSystemUnits` is accepted
alongside `EMGCoordinateUnits`. Named body frames retain independent units
and are never assembled into an invented common anatomy.

## Position errors corrected

The MEG fixture contains 274 measurement coils and 29 reference coils. The
old display combined both and ignored the FIFF device-to-head transform.
The corrected display transforms the coils into MNE head coordinates and
offers references as a separate visibility control. All 303 displayed
positions match MNE-Python 1.11.0 exactly in the recorded comparison:
maximum absolute error **0 mm**. Original device coordinates remain visible
in the readout. [Numerical result](mne-fiff-geometry-check.json).

EEG electrodes accompanying MEG now select EEG coordinate keys, including
when the JSON also contains different MEG axes and units. Local and indexed
inputs resolve space-qualified JSON by BIDS entities and directory scope;
unrelated subject/acquisition files cannot determine the geometry.

The head overlay uses MNE's actual fsaverage scalp mesh in MNE head
coordinates. The export checks mesh integrity and its alignment with the
standard montage (median electrode-to-scalp-vertex distance 4.50 mm).
It remains a generic reference: participant anatomy needs registration.
Rotation uses a fixed geometric scale; the top view puts anterior upward.

## Regression coverage

Unit checks cover coordinate precedence across five modalities, exact EEG
template matching, axes and units, separate frames, malformed and missing
values, duplicate names, JSON validation, space/entity pairing, nested EMG
units, mixed EEG/MEG sidecars, native FIFF transforms and singular transforms.

Browser checks exercise coordinate-only file and URL input, a real
129-electrode BIDS example, five modality prefixes, reference-coil visibility,
the head/opacity controls, keyboard interaction, mobile layout, accessibility,
the reader worker and preservation of trace controls and companion panels.
The full example sweep is numerical; representative cases are rendered in
the browser. Screenshot inspection uses local Chrome rather than asserting
pixel baselines from another browser version.

```sh
npm run test:unit
npm run test:typecheck
npx playwright test --config=playwright.local-chromium.config.mjs \
  tests/e2e/sensor-geometry.spec.mjs tests/e2e/host-bridge.spec.mjs \
  tests/e2e/chrome-integrity.spec.mjs --workers=3 --trace off --timeout 15000
```

## Remaining input limits

An arbitrary remote server cannot enumerate space-qualified files without
an inventory; supply those files explicitly or use an EEGDash/NEMAR index.
Unknown origins, ACPC/ScanRAS and body frames need anatomical registration
before a head overlay can be meaningful. Native geometry extraction currently
covers FIFF and SNIRF; other readers rely on BIDS sidecars or the explicitly
labeled EEG template. MRI/CT/PET anatomy is outside this sensor viewer.
