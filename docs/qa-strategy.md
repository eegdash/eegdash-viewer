# QA Strategy — EEGDash Viewer

## Test Pyramid

```
           ┌─────────────────────────────────────┐
           │         E2E — Acceptance            │  5 specs
           │   viewer.first-load, format-        │  ~5–20 tests
           │   coverage, embed, filter, error    │
           ├─────────────────────────────────────┤
           │         E2E — Smoke                 │  1 spec
           │         smoke.spec.mjs              │  ~12 tests, <30 s
           ├─────────────────────────────────────┤
           │     E2E — Integration (existing)    │  6 specs
           │   viewer, features, multi-record,   │  ~20 tests, ~5–10 min
           │   nemar-smoke, streaming,           │
           │   live-deployed-smoke               │
           ├─────────────────────────────────────┤
           │       Integration / Network         │  5 files
           │  eeglab, edf, bdf, brainvision,    │  real S3 reads
           │  sidecars (Node test runner)        │
           ├─────────────────────────────────────┤
           │           Unit Tests                │  15 files
           │   unit-*.test.mjs, traces,         │  pure logic, no network
           │   local-blob, tile-fetching, etc.   │
           └─────────────────────────────────────┘
```

## Where Each Tier Lives

| Tier         | Location                         | Runner              | When to run         |
|--------------|----------------------------------|---------------------|---------------------|
| Unit         | `tests/unit-*.test.mjs`          | `npm run test:unit` | Always (fast, < 10 s) |
| Integration  | `tests/*.test.mjs` (non-unit)    | `npm run test:net`  | PR + nightly        |
| E2E – Smoke  | `tests/e2e/smoke.spec.mjs`       | `npm run test:smoke`| Post-deploy hook    |
| E2E – Accept | `tests/e2e/acceptance/`          | `npm run test:acceptance` | PR + nightly  |
| E2E – Full   | `tests/e2e/`                     | `npm run test:e2e`  | Nightly / release   |

## Fixture Registry

All known real recordings are catalogued in `tests/fixtures/index.mjs`. Each
entry is a `FIXTURES` object key with:

- `url_query` — the query string to append to `index.html`
- `expect.format` — the format pill the viewer should show
- `expect.n_channels` — channel count (null means "any positive integer")
- `expect.duration_s_min` — minimum recording duration in seconds

### How to Add a Fixture

1. Choose a camelCase key describing dataset + format (e.g. `ds003000_edf`).
2. Add the entry to `FIXTURES` in `tests/fixtures/index.mjs`.
3. Open the viewer locally (`npm run test:e2e` with the local server) and
   confirm the pills and canvas populate correctly.
4. Record the observed values in `expect`.
5. Reference the fixture key in your test: `const fx = FIXTURES.my_key`.

### Synthetic Fixtures (Offline Tests)

`tests/fixtures/synthetic.mjs` exports helpers to build small in-memory
recordings without any network call:

```js
import { synthEEGLABSplit, synthEDF } from '../fixtures/synthetic.mjs';

// 4-channel, 256 Hz, 2-second EEGLAB split recording
const { setBlob, fdtBlob, sidecars, meta } = synthEEGLABSplit({ nCh: 4, fs: 256, durationS: 2 });

// 4-channel, 256 Hz, 2-second EDF blob
const { blob, meta } = synthEDF({ nCh: 4, fs: 256, durationS: 2 });
```

Use synthetic fixtures in:
- Unit tests that test reader internals (pass the blob directly)
- Local Playwright tests that do NOT need real BIDS metadata

## How to Add an Acceptance Scenario

Acceptance specs live in `tests/e2e/acceptance/` and follow a gherkin-flavoured
structure:

```js
// tests/e2e/acceptance/viewer.my-feature.spec.mjs
import { test, expect } from '@playwright/test';
import { FIXTURES } from '../../fixtures/index.mjs';

test.describe('As a user, I [scenario description]', () => {
  test('[Given / When / Then narrative]', async ({ page }) => {
    // Given: [precondition — navigate to the fixture]
    await page.goto('/index.html' + FIXTURES.edf.url_query);
    await expect(page.locator('#stage-caption')).toBeVisible();

    // When: [user action]
    await page.keyboard.press('ArrowRight');

    // Then: [observable outcome]
    // ... assertions ...
  });
});
```

Rules for acceptance specs:

1. One spec file per user journey (not per feature flag).
2. Import fixtures from `../../fixtures/index.mjs` — never hard-code URLs.
3. Document the timeout budget in the JSDoc header comment.
4. Use `expect.poll()` for canvas pixel assertions (avoids flaky `waitForTimeout`).
5. Use `page.waitForFunction()` instead of `page.waitForTimeout()` when waiting
   for a DOM condition.
6. Every `waitForTimeout` that remains must have an inline comment explaining
   WHY it cannot be replaced with a condition-based wait.

## When to Use Unit vs Integration vs E2E

| Scenario                                             | Tier        |
|------------------------------------------------------|-------------|
| Testing a pure function (parser, math, DSP)          | Unit        |
| Testing a reader against a real file from S3         | Integration |
| Testing DOM construction helpers in isolation        | Unit        |
| Testing the viewer with a real recording loaded      | E2E         |
| Checking that a deployed build serves the right code | E2E – Smoke |
| Verifying a user journey end-to-end                  | E2E – Accept|

**When NOT to use E2E:**
- Testing format-parsing edge cases → unit or integration
- Asserting a helper function returns the right value → unit
- Testing BIDS sidecar resolution logic → unit (`unit-sidecar.test.mjs`)

**When NOT to use unit tests:**
- Any test that needs a real HTTP fetch
- Any test that requires a canvas or DOM
- Any test that proves a deployed artifact works

## Flaky-Test Policy

1. A test is considered flaky if it fails on 1 of 5 identical runs.
2. Flaky tests must NOT be silently retried to hide root cause.
3. Address flakiness with:
   a. Replace `waitForTimeout` with `waitForFunction` / `expect.poll` / `waitForResponse`.
   b. Replace a fixed timeout with the concrete-element-present pattern.
   c. If the test is environment-dependent (CI vs local), annotate with
      `test.skip(!!process.env.CI, 'reason')` and file a tracking issue.
4. Do NOT increase the global timeout as a substitute for fixing the root cause.

## CI/CD Integration Points

- **Pre-merge (PR)**: `npm run test:unit` + `npm run test:acceptance`
- **Post-deploy**: `npm run test:smoke` (< 30 s, targets the live GitHub Pages URL)
- **Nightly**: `npm run test:e2e` (full suite including live CDN data)

The smoke spec is the only spec that hits the live `https://eegdash.github.io`
URL. All other specs run against `localhost:8011` via the local static server.

## Rapid-Input Behaviour Suite

Rapid keyboard / pointer input on the viewer exercises the streaming render
path (worker → assembled chunks → partial_fill draw) and the abort cascade
(every new pan aborts the in-flight stream). This suite locks down the
class of bugs reported on 2026-05-20 where fast left/right scrolling left
ghost trace residue on the canvas.

| Layer | File | Covers |
|---|---|---|
| Unit | tests/unit-traces-partial-fill.test.mjs | polyline x-mapping during partial_fill, full_clear flag, monotonic data-front, idempotent re-draw, DPR invariance |
| Unit | tests/unit-viewer-render-loop.test.mjs | clampStart formula, cache-key formula, tail-clamp keys |
| Integration | tests/integration-rapid-pan.test.mjs | abort cascade, no-delivery-after-abort, 50-pan stress, prefetch gate |
| E2E | tests/e2e/streaming.spec.mjs | STREAMING-E2E-1..5 |
| E2E | tests/e2e/rapid-scroll.spec.mjs | RAPID-1..5 (gain, DPR, resize, visibility, heap) |
| Bench | bench/ghost-pixel-bench.mjs | per-pixel diff before/after stress |

Run all rapid-input tests:

```bash
npm run test:e2e:rapid
```

## Coverage Gate

The repo enforces a minimum coverage floor via c8 (V8-native, node:test-compatible).

Configuration: `.c8rc.json`. Source patterns: format readers, render path,
worker, filter, topo2d, BIDS loader. Test patterns and bench/scripts are
excluded so they don't inflate the score.

Thresholds derived from 2026-05-20 baseline:

- lines: 52% (baseline 57.18%)
- branches: 77% (baseline 82.50%)
- functions: 70% (baseline 75.82%)
- statements: 52% (baseline 57.18%)

Each is the baseline value minus 5% (rounded down) or an absolute floor
(60% lines/functions/statements, 50% branches), whichever is higher.
Lines and statements sit below the 60% floor because `worker.js`,
`formats/fiff.js`, and most of `viewer.js` are browser-only render code
not driven by `node:test`. Pinning those metrics to (baseline − 5)
reflects the testable surface today rather than aspirational headroom.

This gate rejects PRs that regress coverage by >5% without forcing
green-coverage cargo culting.

Tighten quarterly: each quarter, re-baseline against the latest main and
raise the thresholds by 2–3%. Don't chase 100%.

Run locally: `npm run test:coverage`. HTML report at `coverage/index.html`.
The coverage script intentionally runs only the deterministic unit set
(same files as `npm run test:unit`) so the gate doesn't drift with
NEMAR / OpenNeuro network flakes.

## Mutation Testing

Stryker (via `@stryker-mutator/core`'s built-in `command` runner driving
`node:test`) measures the *kill ratio* of the test suite against
synthetic code mutations. A mutant is "killed" if at least one test
fails against the mutated source.

Configuration: `stryker.conf.json`. Scope (v1): `traces.js` only — the
strongest-tested file in the repo. viewer.js is excluded because its
IIFE depends on DOM globals that node:test cannot provide.

Baseline (2026-05-20):
- Mutation score: 37.29%
- Killed: 236 / Survived: 407 / Timed out: 6 / Total: 649
- Surviving mutants documented at `docs/mutation-survivors-2026-05.md`

Thresholds (in `stryker.conf.json`):
- break: 32 (baseline − 5; CI exit non-zero if score drops below)
- low: 34 (baseline − 3; non-blocking warning band)
- high: 80 (aspirational)

The baseline sits below 50 because most of traces.js renders into a
canvas and the existing harness records only a subset of the ctx call
stream — visual-correctness mutants survive node:test by design. The
break floor is set to baseline − 5 (not 50) so the gate catches
regression without rejecting today's reality.

Run locally: `npm run mutation` (full) or `npm run mutation:incremental`
(reuses `reports/stryker-incremental.json` to skip mutants on unchanged
code; typically <30 s after the first full run). HTML report at
`reports/mutation/html/index.html` (gitignored) and JSON at
`reports/mutation/mutation.json`.

CI: runs nightly at 03:00 UTC (`.github/workflows/mutation.yml`). Not
per-PR because a full run is ~2–15 minutes (cold cache: ~2.5 min
locally, longer on shared CI runners). To trigger manually: GitHub
Actions → "Mutation testing (nightly)" → Run workflow.

Tightening cadence: once `traces.js` is above 50%, expand `mutate` to
add `filters.js`, `topo2d.js`, `bids-recording.js`. Do not expand to
`viewer.js` until it can be tested under `node:test` (see the
"eventually-modularize" thread in `docs/qa-followups.md`).

## Fuzz Testing

The format parsers (EDF/BDF, BrainVision, EEGLAB, FIFF) are the highest-
leverage fuzz targets in the repo — they consume external user-provided
binary input. The PR fast suite (`tests/prop-*.test.mjs`, 100 runs/test)
provides per-PR safety; the nightly fuzz suite
(`tests/fuzz-formats.test.mjs`, 10,000 runs/test) provides depth.

Configuration:
- Uses fast-check with corpus-seeded mutation (1:9 verbatim:mutated)
- Corpus seeds: real fixtures under `tests/fixtures/` when present.
  As of the PR introducing this section, `tests/fixtures/` only ships
  ES-module helpers (synthetic builders, fixture URL registry), so
  every corpus-seeded target is in "synthetic-fallback" mode: a 1 KB
  zeroed seed with 0–16 random byte overwrites. When real .edf/.bdf/
  .vhdr/.fif files land, add their paths to the `corpusFuzzedBuffer(
  [...])` calls in `tests/fuzz-formats.test.mjs` to upgrade the fuzz
  from "random noise" to "header-aware mutation".
- Runtime budget: ~10 s locally for 60K total iterations; 30 min CI
  timeout
- 6 fuzz targets × 10,000 runs = 60,000 iterations per nightly run

Local: `npm run test:fuzz`
CI: nightly 04:00 UTC via `.github/workflows/fuzz.yml`

When a fuzz target finds a crash:
1. fast-check shrinks to the smallest reproducing input.
2. Capture the bytes; pin as `examples: [...]` in the corresponding
   `tests/prop-*.test.mjs` so PR CI catches regressions immediately.
3. Document the bug in `docs/fuzz-findings-<date>.md`.
4. Fix the parser; verify both the prop test and the fuzz test pass.

Scope for next iteration: deepen the mutation strategy (currently
random byte overwrites only — could add format-aware mutations like
"corrupt the num_data_records header field", "truncate at chunk
boundary", "duplicate a section"). Also: commit a small set of real
fixture files so the corpus is non-synthetic.

## Statistical Benchmarks

Microbenchmarks for hot paths (filter convolutions, parse-matv5,
readWindow, worker-cache) run through tinybench, which samples each
task repeatedly and reports `mean ± RME` (Relative Margin of Error)
plus p75 and p99. This replaces the previous single-number bench
scripts that couldn't distinguish noise from a real regression.

Configuration: `bench/_harness.mjs`. Per-suite scripts:
`bench/{filter,parse-matv5,readwindow,worker-cache}.tinybench.mjs`.
Aggregator: `bench/run-all.tinybench.mjs`.

Local:
- `npm run test:bench` — runs all suites with the default 1 s/task.
- `BENCH_TIME=3000 npm run test:bench` — 3 s/task for tighter CI-style numbers.
- `SKIP_NETWORK=1 npm run test:bench` — skips readwindow (offline).
- `npm run test:bench:{filter,parse,cache,readwindow}` — single suite.

CI: `.github/workflows/bench.yml` runs on every PR and main-branch push.
It uses [benchmark-action/github-action-benchmark](https://github.com/benchmark-action/github-action-benchmark)
with `customSmallerIsBetter`, storing historical results on the
`gh-pages` branch and commenting on PRs where any metric regresses
≥10%. The alert is informational (`fail-on-alert: false`) — shared
GitHub runners have ~2–3% noise on CPU-bound benches and readwindow
runs even higher (5–30% RME) due to network jitter, so PR-blocking
on jitter would generate noise. Tighten the threshold once historical
data shows the per-metric noise floor.

Result schema (`bench/results-*.json`):
- `name`     — task name
- `mean_ms`  — sample mean
- `rme_pct`  — relative margin of error (the meaningful "± X%" figure)
- `p75_ms`, `p99_ms` — percentile latencies
- `samples`  — sample count
- `hz`       — operations per second

Result schema (`bench/results-all-gab.json`) is the github-action-benchmark
`customSmallerIsBetter` shape: `[{ name, unit: 'ms', value, range, extra }]`.

The previous bench scripts (`bench/*.bench.mjs`) are still runnable via
`npm run test:perf` but are deprecated. They will be removed once the
tinybench equivalents have ~30 days of CI history confirming the
metrics are comparable.
