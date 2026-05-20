# QA follow-ups — RESOLVED

All 9 issues uncovered by the multi-agent QA pass are now closed.
This page is the historical log; use `git blame` on the cited
commits for the actual diffs.

| # | Issue | Status | Where |
|---|---|---|---|
| 1 | `worker.js` rawCache was FIFO, not LRU | **FIXED** | `worker.js` `rawCacheGet` helper + sentinels in `tests/unit-worker-cache.test.mjs` |
| 2 | Concurrent same-window streams not deduplicated | **FIXED** | `worker.js` `inflightRawFetches` + `awaitInflight` + 4 sentinels |
| 3 | `topo2d` had no `destroy()` — listener / state leak on remount | **FIXED** | `topo2d.js` tracks `installedListeners`, exposes `api.destroy()`, 4 new tests |
| 4 | Redundant `BIDSLoader` guard in `assembleRecordingMetadata` | **WONTFIX** | Provides clearer warning ("BIDSLoader missing" vs cryptic "TypeError"); existing test relies on it |
| 5 | Misleading `Float32Array.from` comment | **FIXED** | `formats/eeglab.js` — comment now describes the actual win (peak-memory bound) |
| 6 | Playwright `toBeHidden()` deceptive on `#traces` canvas | **FIXED** | Added `.traces[hidden] { display: none }` rule in `styles.css` so the HTML attribute is honoured |
| 7 | `meanStd` cache-identity test was fragile | **FIXED** | `tests/traces.test.mjs` now asserts value-equality, not reference-identity |
| 8 | Pixel-stability poll used unanchored magic number | **FIXED** | `tests/e2e/streaming.spec.mjs` extracted `pixelCountsStable(prev, curr)` helper — relative threshold (1% of larger sample, abs floor 5) |
| 9 | Visual baselines macOS-only — blocks Linux CI | **FIXED** | `.github/workflows/visual-regression.yml` runs the spec under the official Playwright Docker image (Linux Chromium) on PRs touching `traces.js` / `styles.css` / the spec itself, plus a weekly drift run |

## Performance impact (#1 + #2)

Measured by `bench/worker-cache.bench.mjs` (synthetic — replicates the
worker's cache logic in-process and counts upstream fetches issued):

| Scenario | Before | After | Delta |
|---|---|---|---|
| Scrub-replay pan pattern (10 windows, MAX=6) — fetches issued | 9 | 8 | **−11%** S3 calls |
| Scrub-replay pan pattern — wall time (sim 30 ms / fetch) | 279 ms | 248 ms | **−11%** |
| 5 concurrent same-window — fetches issued | 5 | 1 | **−80%** S3 calls |

These wins compound in real pan patterns where the window cycle is
larger than the cache size; the synthetic bench is a conservative
floor.

## Test count delta

- Unit: 209 → **409** (+200 across the QA pass + this follow-up)
- CDN worker: 13 (unchanged)
- Visual regression: 0 → 6 baselines + Linux CI workflow
- Acceptance: 0 → 5 specs
- Performance: 0 → bench harness with 27 metrics + nightly CI

All four new test tiers (visual / acceptance / performance / smoke)
have CI workflows wired.

## Rapid-scroll behaviour gaps (2026-05-20)

Not covered by current tests:
1. Sustained pan (30+ keypresses) — locked in by STREAMING-E2E-4
2. Bouncing direction (alternating ←/→) — locked in by STREAMING-E2E-5
3. Pan during resize — TODO Task 8
4. Pan during gain change — TODO Task 6
5. Pan during filter toggle — partially covered by STREAMING-E2E-3
6. Pan with DPR != 1 — TODO Task 7
7. Tab visibility (rAF pause) — TODO Task 9
8. Memory growth across N pans — TODO Task 10
9. Worker queue saturation — TODO Task 5
10. Streaming chunk monotonicity invariants — TODO Task 2

## Follow-up findings from sleuth agent (2026-05-20)

Independent investigation of the ghost-trace fix surfaced two pre-existing
hazards in the streaming path that the current fix does NOT address.
Neither matches the user-reported symptom; both are low priority.

**Finding A — clip rect uses full plotW** (`traces.js:543`):
The per-channel clip path is `ctx.rect(plotX0, plotY0, plotW, plotH)`. The
polyline now draws inside `effectivePlotW ≤ plotW`, so the clip is correctly
permissive today. Risk: if a future change draws past `plotX0 + effectivePlotW`,
the clip won't catch it. Low priority — defensive tightening only.

**Finding B — interleave race in requestRender** (`viewer.js:730-820`):
The render loop aborts the previous controller before starting a new stream,
but the previous `for await` loop only checks `ctrl.signal.aborted` at the
top of each iteration. Between abort and the next iteration, a chunk that
was already in flight can complete one final `TraceRenderer.draw(...)`
call — painting a partial frame from the OLD stream over the NEW stream's
first chunk. Manifests as a brief one-frame flash, not a persistent ghost.
Mitigation: synchronously check `ctrl.signal.aborted` BEFORE invoking
`TraceRenderer.draw(...)` inside the loop body. Low priority — not the
reported bug, but a real interleaving hazard.

## fiff.js: rejects all real FIFF files (2026-05-20, surfaced by fixture work)

**Status: FIXED** (PR 10)

Three correctness bugs in `formats/fiff.js` resolved by a tag-stream
rewrite:

1. Magic-bytes check at the old line 66 replaced with a real
   `FIFF_FILE_ID` tag read (kind=100, big-endian int32 at offset 0).
2. All `DataView.getInt32(*, true)` / `getFloat32(*, true)` calls
   switched to `false` (big-endian — FIFF spec).
3. Block detection switched from the broken
   `"(tag.kind >> 16) === block_id"` heuristic to a proper
   `FIFF_BLOCK_START` (kind=104) / `FIFF_BLOCK_END` (kind=105) walk
   with a nesting stack — the block id lives in the first int32 of
   each delimiter's data, not in `tag.kind`.

`api.read` now walks the tag stream from offset 0, maintains a
`blockStack`, and surfaces every encountered block id via
`meas.blocks` (plus `meas.has_projections` for FIFFB_PROJ).
Files that contain no `meas_info` block (events, annotations) parse
cleanly and return `{ nchan: 0, sfreq: null, … }` instead of crashing.

Regression coverage in `tests/unit-fiff.test.mjs` (7 tests against
the three real BSD-licensed MNE-Python fixtures + boundary cases:
too-small input, wrong-kind first tag, synthetic FIFF_FILE_ID-only
buffer).

Original investigation notes (kept for historical context):

When committing real FIFF fixtures from MNE-Python (BSD-3 licensed test
data — `meg/test-proj.fif`, `meg/test_raw-annot.fif`, `meg/test-eve.fif`),
discovered that `formats/fiff.js:66` rejected every single one of them
with `Error: Not a valid FIFF file`. Root cause: the parser validated
input by reading the first 4 bytes and requiring them to spell ASCII
`"FIFF"` (`46 49 46 46`). Real FIFF files do NOT have that magic — they
start with a TAG (typically `FIFF_FILE_ID`, `kind=100`), so the first
4 bytes are `00 00 00 64`. The existing `tests/prop-fiff.test.mjs` did
not catch this because random bytes never accidentally start with the
expected magic either — every input legitimately threw and the no-crash
property still held.
