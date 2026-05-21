# MAT v7.3 (HDF5) browser-test evidence

Real-browser verification of MAT v7.3 EEGLAB support (commits `5f7d508`,
`d555923`, `1204700`, `990ac05`). Each test opened the URL in a real
Chrome instance (via chrome-devtools-mcp), waited for `#stage-caption`
to become visible, then checked the format pill + canvas pixels.

## Results

| Fixture | Format | Source | Status | What was checked |
|---|---|---|---|---|
| `test_raw_2021.set` (75 KB) | MAT v5 inline | mne-testing-data EEGLAB | ✓ **3 ch · 128 Hz · 10.0 s** | regression — v5 still works after v7.3 dispatch |
| `test_raw_hdf5.set` (2.4 MB) | **MAT v7.3 inline** | mne-testing-data EEGLAB | ✓ **271 ch · 1024 Hz · 0.3 s** | **first proof v7.3 inline parses + renders end-to-end** |
| `test_raw_h5.set` (554 KB) | MAT v7.3 + sidecar `.fdt` | mne-testing-data EEGLAB | ✗ clean error | edge case: `/EEG/data` is a CHAR referencing `test_raw.fdt` but the .set basename is `test_raw_h5` — sibling-detect heuristic fails. Reader correctly surfaces error message; doesn't follow the CHAR pointer. Tracked as follow-up. |
| `ds002893` (OpenNeuro production) | MAT v7.3 + sibling `.fdt` matching basename | OpenNeuro via cdn.eegdash.org | ✓ **36 ch · 250 Hz · 3473.4 s** | **real OpenNeuro production v7.3 dataset renders correctly** (split path takes precedence over inline since `.fdt` is present) |

## What this confirms

1. **v7.3 inline (single-file modern EEGLAB exports) works end-to-end** in a real browser. `test_raw_hdf5.set` renders 271 channels at 1024 Hz with 31/200 non-background pixels sampled randomly across a 1760×1698 canvas (15.5% pixel density — well above the visual-regression threshold).

2. **v5 path is not regressed.** `test_raw_2021.set` (3 ch, 128 Hz) renders identically to before commit `d555923`.

3. **Real OpenNeuro v7.3 data renders.** `ds002893` is the canonical EEGLAB test dataset we've used throughout this session. Its `.set` is MAT v7.3 with a sibling `.fdt`. The viewer takes the existing split path (no behaviour change) and renders cleanly.

4. **Edge case identified, not a regression:** when a v7.3 `.set` stores `/EEG/data` as a CHAR string referencing a sibling `.fdt` with a NON-matching basename, the reader surfaces a clean error message but does not follow the pointer. This is a 1-test-fixture edge case (mne-testing-data renamed the .set but kept the .fdt's original name). Production OpenNeuro datasets don't hit this pattern — they ship matching basenames.

## Console hygiene

Zero unexpected console errors. The 60 "404" entries during load are the BIDS sidecar inheritance walk probing for `_channels.tsv`, `_electrodes.tsv` etc. that don't exist for standalone fixtures — expected behaviour. The one warning is from chrome-devtools-mcp's `getImageData` pixel-sample probe, not the viewer.

## Screenshots

- `test_raw_hdf5.png` — v7.3 inline rendering 271 channels
- `test_raw_2021_v5.png` — v5 regression check, 3 channels
- `ds002893-v73-split.png` — real OpenNeuro v7.3 split, 36 channels

## Test commands

```bash
# Local server
node scripts/serve.mjs 8011 &

# Each URL
open "http://localhost:8011/index.html?eeg=/test-data/v73-test/test_raw_2021.set"
open "http://localhost:8011/index.html?eeg=/test-data/v73-test/test_raw_hdf5.set"
open "http://localhost:8011/index.html?dataset=ds002893&sub=001&task=AuditoryVisualShift&run=01&ext=set"
```
