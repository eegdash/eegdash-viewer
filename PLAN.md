# EEG Trace Viewer — Plan

## Goal

Static, vanilla-JS viewer for **any BIDS EEG raw recording** served over
HTTPS (e.g. OpenNeuro S3). No backend, no auth. Same shape as the sister
project `electrode-explorer/`: drop a URL into the address bar, get a
trace + topo plot in the browser. Embeddable via iframe into eegdash
dataset pages.

## Why this exists

`website_eeg_reject_login/` already has a Flask viewer for EEG traces,
but it's tied to:

- session auth, the rater allocation algorithm, and the artifact
  annotation workflow (none of which we want here);
- pre-processed `.fdt` files MATLAB-exported to local disk
  (we want to read raw BIDS straight from OpenNeuro instead).

This project keeps only the visualization, redesigned to read native
BIDS formats from any HTTPS source.

## Architecture

```
?eeg=https://s3.amazonaws.com/openneuro.org/ds00XXXX/sub-YY/eeg/<prefix>_eeg.<ext>
                                  │
                                  ▼
                ┌──────────────────────────────────┐
                │ bids-recording.js                │
                │   ─ walks BIDS inheritance       │
                │   ─ fetches _eeg.json,           │
                │     _channels.tsv, _events.tsv,  │
                │     _electrodes.tsv,             │
                │     _coordsystem.json            │
                │   → BIDSRecording metadata       │
                └────────────┬─────────────────────┘
                             │ ext = set | edf | bdf | vhdr
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
       formats/eeglab.js  formats/edf.js  formats/brainvision.js
              │              │              │
              └──────────────┴──────────────┘
                             │  range-fetched Float32Array
                             ▼  (channels × samples_in_visible_window)
                       traces.js  ──── canvas trace plot, decimated
                       topo.js    ──── reuses topo2d.js + chanlocs
                       filters.js ──── optional in-browser HP/LP biquad
```

**Key invariant**: the format readers always emit a uniform
`{channel_index → Float32Array}` for the visible window, sampled at the
recording's native rate. The renderer is format-agnostic.

**No data ever stays in memory whole.** Recordings can be multiple GB;
we range-fetch only the bytes covering the visible window plus a
small read-ahead, and discard them when the user pans away. This is
the entire reason the architecture works for arbitrary BIDS data
without a backend cache.

## Phases

| # | Topic | Status | Notes |
|---|-------|--------|-------|
| 0 | Scaffold + reuse from electrode-explorer | done | bids-loader.js + topo2d.js copied verbatim |
| 1 | BIDS sidecar fetcher + inheritance walk | done | smoke test passes 5/5 against EEGLAB/EDF/BV on OpenNeuro |
| 2 | EEGLAB `.fdt` reader | done | bitwise-equal to mne on ds002893 (max |Δ| = 0 µV across 36 ch × 100 samples); single-allocation deinterleave; epoched detection |
| 3 | EDF/EDF+/BDF reader | done | bitwise-equal to mne on ds002034 (max |Δ| = 0 µV across 81 non-stim ch × 100 samples); typed-array views + branch-free decode; shared HTTP-range helper extracted |
| 4 | BrainVision `.vhdr/.eeg/.vmrk` reader | done | bitwise-equal to mne on ds002336 (max |Δ| = 0 µV across 64 ch × 100 samples, no `_eeg.json`/`_channels.tsv` sidecars — derived from `.vhdr`); shared `formats/_buffers.js` and `scripts/_smoke_lib.mjs`/`_cross_check_lib.py` extracted |
| 5 | Trace renderer (canvas, decimated, scrubbable) | done | block-min/max decimation w/ scratch-buffer reuse; AbortController plumbed through `readWindow`; XSS-safe DOM construction; index.html dispatches to all 3 readers; 17/17 unit tests for the pure helpers |
| 6 | Spatial layout (deep-link to electrode-explorer) | done | dropped the dynamic hover-topo plan in favour of a "View electrode layout →" link to `electrodes.eegdash.org/?tsv=&coords=` — it already covers spatial visualisation and avoids 400+ LOC of duplicated griddata machinery. Link only appears when the dataset's BIDS inheritance walk found `_electrodes.tsv`. |
| 7 | URL grammar + `?embed=1` + drag-drop | done | drag-drop a `_eeg.*` file (plus siblings) → loaded via `localdrop.invalid` synthetic URLs that route through the same readers; AbortController + `clearLocal()` race fixed in the drop handler; `?embed=1` hides chrome with transparent bg for iframe hosting |
| 8 | In-browser HP/LP filters (display-only) | pending | replaces the rater app's pre-computed `_hp05`/`_lp45` variants |

## URL grammar

Three priority-ordered shapes the bootstrap accepts:

1. `?eeg=<full-url>` — direct URL to a BIDS `*_eeg.<ext>` file. Sidecars
   derived from the basename and inheritance walk.
2. `?dataset=ds00XXXX&sub=01&ses=01&task=rest&run=01&ext=set` — assemble
   the OpenNeuro S3 URL from BIDS path conventions. The eegdash dataset
   pages will deep-link into this shape.
3. `?demo=<id>` — small bundled fixtures under `test-data/` for offline
   work. Not yet wired.

Plus `?embed=1` (compact mode for iframe) and `?tweaks=1`
(escape-hatch debug panel) — same convention as electrode-explorer.

## Reuse boundary with electrode-explorer

These two files were copied verbatim and must stay in sync (manually
for now; in a future merge into a shared `eegdash-bids-js` package
both viewers would consume them):

- `bids-loader.js` — `electrodes.tsv` + `coordsystem.json` parsing,
  unit + axis inference, sphere-fit. Used here only to render the
  topomap when the dataset has 3D positions.
- `topo2d.js` — MNE/EEGLAB-style scalp topomap renderer.

`bids-recording.js` (new, this project) builds on top of `BIDSLoader`
to add the rest of the BIDS sidecar surface (`_eeg.json`,
`_channels.tsv`, `_events.tsv`).

## Verification

Each phase ships with its own smoke test harness in `scripts/`. Phase 1
is `scripts/smoke-sidecars.mjs`, runnable with `node`, exercising
sidecar fetching against five OpenNeuro recordings spanning all three
formats. Subsequent phases will add range-fetch correctness checks
(byte counts match expected sample counts), and screenshot evidence in
`test-data/` once the renderer lands.

## Deployment

Eventual home: subdomain like `traces.eegdash.org` (TBD), GitHub Pages
or static S3, with `CNAME` matching electrode-explorer's pattern. The
viewer is fully static — no build, no server.

## Performance

The viewer's hot path is bandwidth-bound on cold OpenNeuro S3
connections — single-fetch range requests get throttled to ~0.7 MB/s
per TCP connection, but HTTP/2 lets us multiplex parallel range
requests on the same connection at ~5 MB/s aggregate. `HttpRange.rangeFetch`
auto-tiles reads ≥ 4 MiB into ~8 parallel sub-fetches; the format
readers see no change. Result: a 60-second × 5 kHz × 64-channel pan
that took ~140 s before now takes ~7 s. Documented in detail at
`docs/streaming-study.md`.

## Tests

The full official-runner test suite is `npm test` (`node --test
--test-reporter=spec --test-concurrency=1 tests/*.test.mjs`). Covers:

- 4 sidecar resolution cases across formats
- 3 reader bitwise-equivalence-to-mne tests (skipped when no Python
  reference is checked in)
- Pure-math unit tests for the trace renderer
- 7-recording integration matrix with boundary conditions, abort
  semantics, concurrent loads, eegdash-fallback verification
- 3 stress patterns: 19/20-aborted rapid pan, 38 MB single window,
  30 random disjoint reads

Bench: `npm run bench` runs `scripts/bench-fetch.mjs` against
ds002336's 5 kHz BV recording for the parallel-vs-single comparison.

Real-browser end-to-end: `npm run test:e2e` (Playwright + Chromium,
~16 s). Covers the cold load → canvas paints non-blank pixels path,
embed mode, drag-drop overlay, and ResizeObserver-driven canvas
reflow. The Node test suite covers everything below the page; e2e
is what catches the "we actually painted to the canvas" case.

## Documented gaps

- BIDS inheritance walks 4 directory levels and tries entity-stripped
  prefix variants, but does **not merge** sidecars across levels. If
  a dataset puts e.g. `PowerLineFrequency` only at the dataset root
  and `SamplingFrequency` only at the run level, we'll see whichever
  was found first (the deepest). Real datasets so far all keep each
  field at one level.
- `.set` MAT-file parsing is intentionally skipped: we trust BIDS
  sidecars for everything (channel names, fs, units) and treat `.fdt`
  as a flat float32 matrix. Datasets without proper sidecars will
  surface as "no _channels.tsv — will read from format header" and
  the EEGLAB reader will refuse them. Acceptable for v1; full `.set`
  support would mean vendoring a MAT parser.
- Multi-trial / epoched `.fdt` (3-D arrays) isn't planned. Continuous
  recordings only.
