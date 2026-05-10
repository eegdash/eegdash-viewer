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
