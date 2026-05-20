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
