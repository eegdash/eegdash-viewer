# Session 2026-05-22 — "be more generous" pass against 648-dataset OpenNeuro audit

> Compact-prep snapshot. Continuation of `docs/session-2026-05-22-format-resilience.md`. Driven by the user's observation that the 648-dataset full-catalog audit's rejection list was full of "known limitations" that should be turned into successes. Inspired by mne-python#13884 (BrainVision overrides), this session iterated on the reader code to accept files we'd previously rejected.

## Headline impact

| Audit run | pass | reader-rejected | render-fail | console-err |
|---|---:|---:|---:|---:|
| Pre-session (last full run) | 467/648 (72.1%) | 172 | 7 | 2 |
| Post-session (in flight at compact time) | **~280/383 = 73%** (mid-run) | reduced ~50 | similar | similar |

**Per-category fix progress** (categories from the pre-session audit):

| Category | Before | After | Fix |
|---|---:|---:|---|
| BrainVision `DataOrientation=VECTORIZED` | 5 fail | **0** | implement vectorized read (N parallel range fetches) |
| EEGLAB lenient struct field synthesis | 3 fail | **0** | empty placeholder for missing nested subelements |
| EEGLAB inline cap 200 MB → 1 GB | 11 fail | ~5 fail | now loads files in 200-900 MB range (5 remain >1 GB) |
| EEGLAB v7.3 flat root layout | 5 fail | (in audit) | accept `data`/`srate`/`nbchan` at root, not just wrapped in `/EEG` |
| Bad `_eeg.json` SamplingFrequency | 1 fail | **0** | warn + derive from file header instead of throwing |
| EDF non-modal-rate channel filter | 1 fail | **0** | extend BDF auxiliary-channel filter to plain EDF |
| BrainVision `.eeg` size mismatch | 2 fail | (in audit) | floor() to complete samples + warn (symmetric with EEGLAB) |
| Range-ignored stream cap 200 MB → 1 GB | 8 fail | (in audit) | recover slices from huge files when CDN ignores Range |
| HTTP 5xx transient retries | 103 fail | (in audit) | 3-retry backoff (200/600/1500 ms) on 502/503/504 |
| macOS AppleDouble (`._*` filter) | 1 fail | **0** | reject early with clean message + skip in enumerator |
| SNIRF jsfive crash wrap | 1 fail | **0** | catch and emit reader-specific message |

## Files modified

### `formats/brainvision.js`
- **VECTORIZED layout**: N parallel range fetches (one per channel covering only that channel's `nWin` samples within the channel-major file layout). HTTP/2 multiplexing keeps the 64-128 concurrent fetches light. Confirmed working on all 5 audit datasets: ds003944, ds004000, ds004621, ds007655, ds003947.
- **`.eeg` trailing-bytes tolerance**: when file size isn't a multiple of `n_channels·bps`, floor to complete samples and warn. Mirrors EEGLAB `.fdt` truncation tolerance. Observed on ds003816.
- **AppleDouble magic detection**: reject early with "looks like macOS AppleDouble metadata file" when first 4 bytes are 0x00 05 16 07.

### `formats/_matv5.js`
- **Lenient nested struct field handling**: synthesize empty placeholder for missing/non-`miMATRIX` subelements instead of throwing. Real EEGLAB writers truncate trailing all-empty fields (`chanlocs.labels`, `chanlocs.theta`). Affects ds005876, ds005185, ds005106.

### `formats/_mat73.js`
- **Flat v7.3 root layout**: accept `/data`, `/srate`, `/nbchan` directly at root when no `/EEG` wrapper group exists. Some MATLAB `save -v7.3 -struct EEG` exports flatten the layout. Affects ds004105, ds004118, ds004121, ds004122, ds004123.

### `formats/eeglab.js`
- **`INLINE_LEGACY_FALLBACK_CAP` 200 MB → 1 GB**: unblocks struct-wrapped inline .sets in 286-903 MB range. Files >1 GB still fail with a clear cap message.

### `formats/edf.js`
- **Non-modal-rate filter for plain EDF**: drop auxiliary signals at non-modal rate (was BDF-only). Symmetric with existing BDF status-channel filter.
- **Trailing partial record tolerance**: floor to complete records on ds003343-style data-section mismatches.

### `formats/_http_range.js`
- **`RANGE_IGNORED_STREAM_CAP_BYTES` 200 MB → 1 GB**: recover slices from huge files when CDN returns 200 instead of 206 for Range requests.
- **`fetchWithRetry`**: wraps every fetch with 3-retry backoff (200/600/1500 ms) on transient 502/503/504. Only on those exact codes; 4xx propagates immediately.

### `formats/snirf.js`
- **jsfive crash wrap**: catch raw library errors ("thing is not a function" from internal asserts) and emit "SNIRF: jsfive crashed while walking the HDF5 group tree" with the original error attached.

### `bids-recording.js`
- **Lenient `_eeg.json` SamplingFrequency**: invalid (null, 0, NaN, negative) no longer fatal — warn and pass `null` to the reader, which derives sfreq from the file itself (EEG.srate, .vhdr SamplingInterval, EDF record duration).

### `tests/e2e/acceptance/audit-loadable.spec.mjs` + `playwright.audit-full.config.mjs`
- **Stage-caption gate 60 s → 120 s**.
- **Playwright per-test timeout 90 s → 180 s**.
- Trade: 14 stage-caption-never-visible cases in this audit were mostly large files (500 MB-1.6 GB) where the cap-raise wins meant the file now loads (vs instantly rejecting at the old cap) — but loading takes 60-90 s on a typical home connection. The longer timeout lets them actually pass.

### `scripts/list-openneuro-datasets-one-per.mjs`
- New enumerator: lists every OpenNeuro `ds######` root via S3 (the EEGDash API blocks unauthenticated requests). For each, picks one electrophysiology recording. Produces a 647-row manifest.

### `scripts/audit-openneuro-one-per-dataset.json`
- Generated manifest: 647 datasets (after pruning the one AppleDouble entry that slipped in before the enumerator filter landed).

## Commits this session (chronological)

```
6294b12 feat(readers): be more generous — unblock 13+ datasets
1c83d46 feat(readers): 4 more generous fixes from the 648-dataset audit re-run
531c8f2 feat(http-range): raise Range-ignored stream-slice cap 200 MB → 1 GB
29aa53a feat(edf): apply non-modal-rate filtering to plain EDF (was BDF-only)
cc6e799 feat(http-range): retry on transient CDN 502/503/504
8f08a0e test(audit): raise timeouts to accommodate the cap-raise wins
a7db05f data(audit): remove macOS AppleDouble entry from one-per-dataset manifest
```

## What can't be improved client-side

| Category | Count | Why |
|---|---:|---|
| CDN 502 (persistent) | ~49 | OpenNeuro S3 requires signed URLs; CDN proxy fails for specific objects. Retry doesn't help (cached error response or origin route broken). S3 fallback returns 403 (auth required). |
| Files >1 GB inline | ~5 | Hard memory cap (1 GB) to protect low-end browsers. The exact file is downloadable in principle, but loading 1.5-2.7 GB into a single ArrayBuffer risks OOM on mobile/older machines. |
| Calibration FIFs | 13 | No FIFFB_RAW_DATA — matches MNE-Python rejection. Intentional, not a bug. |
| HDF5 features not in jsfive | 2-3 | `Filter id:6` (LZF compression), fractal heap extensions. Library limitation. |
| Files broken at OpenNeuro source | ~3 | `.fdt` referenced but missing, `.set` truncated, etc. Need re-upload by publisher. |

## How to resume after compaction

```bash
# 1. Verify HEAD
git log --oneline -10

# 2. Tests + typecheck
node --test --test-skip-pattern='rejects URLs that are not BIDS' tests/unit-*.test.mjs 2>&1 | tail -6
npm run test:typecheck

# 3. Browser audit (full, 4-worker, ~25-40 min wall)
AUDIT_FULL=1 AUDIT_MANIFEST=scripts/audit-openneuro-one-per-dataset.json \
  npm run test:audit-reality:full

# 4. Inspect results
cat tests/evidence/audit-browser-reality/results.worker-*.jsonl | \
  jq -r '.verdict' | sort | uniq -c
```

## Open follow-ups

1. **KIT viewer pageerror** (ds004738) — reader returns valid data but viewer throws `Cannot read properties of undefined (reading '0')`. Likely a viewer-side access to a field the KIT reader doesn't populate (`bids_channels` is undefined; other readers return `null`).

2. **EDF "offset out of bounds"** (ds006914) — reader opens fine in Node but browser pageerrors. Worker-side bug, needs investigation.

3. **HDF5 LZF compression** — jsfive doesn't ship a filter for id:6 (LZF). Could vendor a small LZF decoder. 2 audit datasets affected.

4. **Multi-part FIF split files** (`_split-01_meg.fif`, etc.) — these are chunk 1 of larger recordings; reader currently treats as standalone. 3 audit datasets affected (ds005241, ds005261, ds005356, each 2.1 GB).

5. **EEGLAB v5 `.fdt` cross-name with sub-folder lookup** — current basename fallback works for sibling files. Some legacy exports use deeply-nested or differently-named `.fdt` paths that 404 both candidates (ds002181 in earlier audits, confirmed broken at OpenNeuro source).

Session state: durable. Safe to compact.
