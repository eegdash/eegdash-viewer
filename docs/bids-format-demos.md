# BIDS Format Demo Matrix

One publicly-accessible demo per BIDS-accepted electrophysiology format.
Pinned 2026-05-21 by the Lane J wiring commit, drives
`tests/e2e/acceptance/format-demos.spec.mjs` (gated by `RUN_DEMO_TESTS=1`).

Support tiers:

| Tier            | Meaning                                                                 |
|-----------------|-------------------------------------------------------------------------|
| **Full**        | `open()` + `readWindow()` both work; canvas paints real samples.        |
| **Metadata-only** | `open()` works; `readWindow()` throws a documented error (e.g. compressed payload not yet decoded). The viewer must surface the error cleanly, not crash. |
| **Stub**        | `open()` deliberately throws a documented error pending public spec. The dispatch table lists the format only so the user gets a useful message instead of a 404. |

## Matrix

| Format       | Ext(s)             | Tier            | BIDS spec                                                                 | Demo                                                                                                                                              | Notes |
|--------------|--------------------|-----------------|---------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------|-------|
| EDF          | `.edf`             | Full            | https://bids-specification.readthedocs.io/en/stable/modality-specific-files/electroencephalography.html | `https://cdn.eegdash.org/ds002034/sub-01/ses-01/eeg/sub-01_ses-01_task-offline_run-01_eeg.edf`                                                     | Verified by `audit-loadable.spec.mjs` (worker-0 row). |
| BDF          | `.bdf`             | Full            | (same)                                                                    | `https://cdn.eegdash.org/ds001787/sub-001/ses-01/eeg/sub-001_ses-01_task-meditation_eeg.bdf`                                                       | BioSemi 24-bit variant; shares EDF reader. Verified by audit. |
| BrainVision  | `.vhdr` + `.eeg` + `.vmrk` | Full    | (same)                                                                    | `https://cdn.eegdash.org/ds001810/sub-01/ses-anodalpost/eeg/sub-01_ses-anodalpost_task-attentionalblink_eeg.vhdr`                                  | Companion files resolved via sidecar inheritance. Verified by audit. |
| EEGLAB v5    | `.set`             | Full            | (same)                                                                    | `https://cdn.eegdash.org/ds001785/sub-01/ses-01/eeg/sub-01_ses-01_task-adapt_run-01_eeg.set`                                                       | MAT v5 container; reader dispatches via header magic. Verified by audit. |
| EEGLAB v7.3  | `.set`             | Full            | (same)                                                                    | `tests/fixtures/eeg/tiny_v73_eeg.set`                                                                                                              | MAT v7.3 (HDF5) container; shares ext with v5. No verified cdn.eegdash.org dataset in current audit catalog — local fixture only. |
| FIFF         | `.fif`, `.fiff`    | Full            | https://bids-specification.readthedocs.io/en/stable/modality-specific-files/magnetoencephalography.html | `https://cdn.eegdash.org/ds000248/sub-01/meg/sub-01_acq-crosstalk_meg.fif`                                                                         | MEG-canonical (MNE). Verified by audit. |
| CTF          | `.ds/` (directory) | Full            | (same)                                                                    | `https://cdn.eegdash.org/ds000246/sub-emptyroom/meg/sub-emptyroom_task-noise_run-01_meg.ds/sub-emptyroom_task-noise_run-01_meg.meg4`               | Directory bundle; URL points at the inner `.meg4` binary. Verified by audit. |
| KIT          | `.con`, `.sqd`     | Full            | (same)                                                                    | `tests/fixtures/meg/kit-tiny.con`                                                                                                                  | No verified cdn.eegdash.org dataset in current audit catalog — KIT recordings are rare on OpenNeuro. Local fixture only. |
| SNIRF        | `.snirf`           | Full            | https://bids-specification.readthedocs.io/en/stable/modality-specific-files/near-infrared-spectroscopy.html | `tests/fixtures/nirs/snirf-tiny.snirf`                                                                                                             | Pure HDF5; no real fNIRS dataset in current audit catalog. |
| **NWB**      | `.nwb`             | **Full**        | https://bids-specification.readthedocs.io/en/stable/modality-specific-files/intracranial-electroencephalography.html | `tests/fixtures/ieeg/nwb-tiny.nwb` (local); external canonical: DANDI `https://dandiarchive.org/dandiset/000126` (167 KB `sub-1.nwb`)              | HDF5 container. Two read paths: whole-file via jsfive (up to 1 GB cap, was 200 MB), and range-streaming via `formats/_h5-stream.js` for files > 200 MB whose HDF5 metadata fits in the first 16 MB. Streaming path walks the V1 chunk B-tree itself and fetches only the chunks intersecting each `readWindow` — O(window) bandwidth, not O(file). See `tests/evidence/nwb-streaming/README.md` for benchmarks. Files > 1 GB with scattered metadata (some pynwb writers append small datasets after the big chunked one) fail cleanly today — a known follow-up is a sparse-page jsfive wrapper. |
| **MEF3**     | `.mefd/` (directory) | **Full**        | (iEEG spec, same as NWB)                                                | `tests/fixtures/ieeg/mef-tiny.mefd/` (legacy flat layout) + `tests/fixtures/ieeg/mef-pymef-real.mefd/` (BIDS-canonical `.segd/` layout, pymef-encoded ground truth) | Parses `.tmet` segment metadata, decodes RED (Range Encoded Differential) blocks from `.tdat` via the per-channel `.tidx` block map. JS port of `meflib.c` `RED_decode` (see `formats/_mef-red-spec.md`). Encrypted MEF3 is rejected; lossless + fixed-scale-factor decode paths are exercised. **Verification: HIGH.** Cross-decoded against `pymef 1.4.8` (the official Mayo Clinic C wrapper) — `tests/unit-mef-real.test.mjs` reads a fixture produced by `scripts/make-mef-pymef-fixture.py` and asserts every sample matches the deterministic sine ground truth, including across RED block boundaries. Layout walker exercised against `bids-standard/bids-examples` `xeeg_hed_score` (166 channels, BIDS-canonical `.segd/` subdir). |
| **BTi/4D**   | (none — directory) | **Full**        | (MEG spec, same as FIFF)                                                  | `tests/fixtures/meg/bti-tiny/`                                                                                                                     | Path-based dispatch: URL ends in `/config` or matches `/c,rf<…>`. The `bti` synthetic ext is internal; users never type it. |
| **ITAB**     | `.raw` + `.mhd`    | **Full**        | (MEG spec, same as FIFF)                                                  | `tests/fixtures/meg/itab-tiny.raw` (+ `.mhd` companion)                                                                                            | Chieti ARGOS MEG. `.raw` collides with EGI Net Station which BIDS doesn't accept, so `.raw` always routes to ITAB. The `.mhd` companion is read via sidecar inheritance. |
| **KRISS**    | `.kdf`             | **Stub**        | (MEG spec, same as FIFF)                                                  | `tests/fixtures/meg/kriss-tiny.kdf`                                                                                                                | `.kdf` spec is not public; reader emits `"KRISS .kdf format is not yet supported …"` on `open()`. Listed in the dispatch table so users get a clean message instead of a 404. |

## Why some demos are local-only

The five Lane H formats (NWB, MEF3, BTi, ITAB, KRISS) are not yet
represented on `cdn.eegdash.org` because the audit catalog
(`scripts/audit-100-datasets.json`) is sourced from OpenNeuro's BIDS-EEG
corpus and these formats are predominantly iEEG/MEG. As soon as a
dataset on OpenNeuro publishes one of them the audit will surface it on
the next `npm run audit-100-datasets --full` and this matrix should be
updated to swap the local-fixture row for a real URL.

The synthetic fixtures (`tests/fixtures/{ieeg,meg}/...`) are
small (under 50 KB each), CC0, and produced by deterministic Python
scripts (`scripts/make-*-fixture.mjs` / Python h5py for NWB). They are
sufficient to exercise the open / readWindow code path end-to-end.

## Running the demo spec

```sh
# All demos (~10 tests, real CDN + local fixtures):
RUN_DEMO_TESTS=1 npx playwright test tests/e2e/acceptance/format-demos.spec.mjs

# Just the cdn-backed ones (fast smoke test):
RUN_DEMO_TESTS=1 npx playwright test tests/e2e/acceptance/format-demos.spec.mjs --grep cdn

# Just the local-fixture ones (offline-safe):
RUN_DEMO_TESTS=1 npx playwright test tests/e2e/acceptance/format-demos.spec.mjs --grep fixture
```

The spec is gated by `RUN_DEMO_TESTS=1` so it doesn't slow down normal
test runs (some demos pull 10–40 MB across cold CDN ranges).

## Expected outcomes

| Format       | Expected verdict                                                          |
|--------------|---------------------------------------------------------------------------|
| EDF / BDF / BV / SET / FIFF / CTF | `pass` — canvas paints, format pill correct.        |
| KIT / SNIRF / EEGLAB v7.3         | `pass` — local fixture, canvas paints.              |
| NWB                               | `pass` — local fixture, canvas paints.              |
| BTi / ITAB                        | `pass` — local fixture, canvas paints.              |
| MEF3                              | `pass` — local fixture, canvas paints decoded RED blocks. |
| KRISS                             | `stub-error` — open throws clean "not yet supported". |
