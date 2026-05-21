# Maturation Tier 1+2+3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 13 maturity-ladder gaps surfaced by the autonomous-improvement session (commit `88d060c`). Each task lands a discrete CI gate, source fix, or architectural improvement with regression tests.

**Architecture:** 13 independent, file-disjoint or near-disjoint tasks. Each produces working software on its own — no task depends on a later task. The plan groups tasks by tier so the highest-leverage items land first, but individual dispatch order can be reshuffled freely.

**Tech Stack:** Node 20+ (node:test), c8, fast-check, Stryker mutation, tinybench, Playwright, axe-core, jsdom (NEW for viewer/worker mutation scope), Lighthouse CI (NEW), JSDoc + tsc (NEW), CodSpeed CLI (NEW — free tier, signup at start of Task 1).

---

## File Structure

```
.codspeed/                          NEW   CodSpeed config + run script
.github/workflows/
  ├── codspeed.yml                  NEW   CodSpeed nightly + PR-trigger
  ├── lighthouse.yml                NEW   Lighthouse CI on PR
  ├── mutation-pr.yml               NEW   PR-side incremental mutation
  └── visual-cross-browser.yml      NEW   Linux + macOS visual baselines (Docker)
tests/
  ├── _jsdom-bootstrap.mjs          NEW   JSDOM globals shim for viewer/worker mutation
  ├── _render-invariants.mjs        EXISTS
  ├── prop-render.test.mjs          NEW   property tests on render path
  ├── unit-viewer-modules.test.mjs  NEW   tests against viewer's extracted helpers
  ├── unit-fiff-raw.test.mjs        NEW   raw-data FIFF fixture round-trip
  └── e2e/
      └── memory-streaming.spec.mjs NEW   memory leak during ACTIVE streaming
tests/fixtures/meg/
  └── small-raw.fif                 NEW   real raw-data FIFF (BSD or CC0)
formats/fiff.js                     MODIFY  improve annotation_events + recording_start_iso
worker.js                           MODIFY  echo CANCELLED ack to viewer
bids-recording.js                   MODIFY  NEMAR retry + 404 fallback
viewer.js                           MODIFY  extract pure helpers to viewer-helpers.js
viewer-helpers.js                   NEW     pure-function exports for unit testing
topo2d.js                           ARCHIVE move under archive/topo2d/ + remove from tests
jsconfig.json                       NEW     enable tsc --noEmit --checkJs on formats/
docs/
  ├── runbooks/codspeed-signup.md   NEW   one-time signup instructions
  └── session-2026-05-21-autonomous-run.md  MODIFY  append closure log
package.json                        MODIFY  add scripts: test:lighthouse, test:typecheck
```

---

## Task 1: CodSpeed instrumented benchmarking

**Files:**
- Create: `.github/workflows/codspeed.yml`
- Create: `docs/runbooks/codspeed-signup.md`
- Modify: `package.json` (devDependency + script)
- Modify: `bench/_harness.mjs` (CodSpeed integration)

**Why:** tinybench reports `mean ± RME` but shared GitHub runners have 2-3% noise → 10% PR alert threshold is the lowest defensible bar. CodSpeed's Callgrind-based CPU simulation hits 0.56% CoV → 1.5% alert threshold. Same statistical layer + dramatically tighter signal.

- [ ] **Step 1: Install CodSpeed plugin**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
npm install --save-dev @codspeed/tinybench-plugin
```

Expected: `@codspeed/tinybench-plugin` lands in `devDependencies` of `package.json`.

- [ ] **Step 2: Wire CodSpeed into bench harness**

Open `bench/_harness.mjs`. Find `import { Bench } from 'tinybench';` and replace the `makeBench()` function:

```js
import { Bench } from 'tinybench';
import { withCodSpeed } from '@codspeed/tinybench-plugin';

export function makeBench() {
  const time = parseInt(process.env.BENCH_TIME || '1000', 10);
  const bench = new Bench({ time, warmupTime: time / 4 });
  // CodSpeed instrument: detects CSE_PERF=1 env, otherwise no-op.
  // Local runs (CSE_PERF unset) → plain tinybench wall-clock.
  // CI runs (CSE_PERF=1) → Callgrind-based simulation, 0.56% CoV.
  return process.env.CSE_PERF ? withCodSpeed(bench) : bench;
}
```

- [ ] **Step 3: Verify local bench still works (no CodSpeed mode)**

```bash
SKIP_NETWORK=1 npm run test:bench 2>&1 | tail -10
```

Expected: 23 metrics emitted with `mean_ms`, `rme_pct` columns. Same as before the CodSpeed wiring — instrumentation is bypass when `CSE_PERF` is unset.

- [ ] **Step 4: Create the GitHub Actions workflow**

Write `.github/workflows/codspeed.yml`:

```yaml
name: CodSpeed benchmarks

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
  workflow_dispatch: {}

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'

jobs:
  codspeed:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - uses: CodSpeedHQ/action@v3
        with:
          token: ${{ secrets.CODSPEED_TOKEN }}
          run: SKIP_NETWORK=1 CSE_PERF=1 npm run test:bench
```

- [ ] **Step 5: Write the signup runbook**

Write `docs/runbooks/codspeed-signup.md`:

````markdown
# CodSpeed setup (one-time)

CodSpeed runs the same tinybench suite under Callgrind CPU simulation
for 0.56% CoV (vs 2-3% on raw GitHub runners). PR alerts trigger at
1.5% regression vs main baseline.

## Steps

1. Visit https://codspeed.io and sign up with the org's GitHub account.
2. Authorise the CodSpeed GitHub App on the eegdash/eegdash-viewer repo.
3. Copy the project token from the dashboard.
4. In the GitHub repo: Settings → Secrets and variables → Actions →
   New repository secret. Name: `CODSPEED_TOKEN`. Value: paste the token.
5. Push any commit to main. The workflow `.github/workflows/codspeed.yml`
   runs and publishes the first baseline.
6. Open any subsequent PR. CodSpeed posts a comment with the per-metric
   delta + percentile band; PRs with > 1.5% regression on any metric
   light a yellow flag (informational, NOT blocking by default).

## Tightening

After 30 days of CI history, edit `.github/workflows/codspeed.yml` and
add `fail-on-alert: true` to the `CodSpeedHQ/action` step. PRs with
significant regressions will then block merge.

## Costs

Free tier: 5 benchmark runs/day, unlimited PRs, 1 month history. Sufficient
for our cadence (~2-5 PRs/week).
````

- [ ] **Step 6: Commit (3 commits)**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add @codspeed/tinybench-plugin"

git add bench/_harness.mjs
git commit -m "bench: wire CodSpeed instrumentation (opt-in via CSE_PERF env)"

git add .github/workflows/codspeed.yml docs/runbooks/codspeed-signup.md
git commit -m "ci(bench): CodSpeed workflow + signup runbook

Free-tier signup is a one-time manual step (see runbook). The workflow
is safe to commit before signup — without CODSPEED_TOKEN secret the
job no-ops at the auth step. First successful run after signup
publishes the baseline."
```

---

## Task 2: PR-side incremental mutation testing

**Files:**
- Create: `.github/workflows/mutation-pr.yml`
- Modify: `stryker.conf.json` (incremental cache → CI cache restore)

**Why:** Mutation runs nightly today (~13 min full baseline). PR-side would catch tests-weakening regressions in the diff. Stryker's incremental mode + GitHub Actions cache action lets PR runs reuse the prior baseline (~2-5 min on warm cache).

- [ ] **Step 1: Make incremental cache cacheable in CI**

Open `stryker.conf.json`. Verify the incremental path is `reports/stryker-incremental.json`. Confirm `.gitignore` excludes it (already done in commit `6860071`).

- [ ] **Step 2: Write the PR workflow**

Write `.github/workflows/mutation-pr.yml`:

```yaml
name: Mutation testing (PR incremental)

on:
  pull_request:
    branches: [main]
    paths:
      - 'traces.js'
      - 'filters.js'
      - 'topo2d.js'
      - 'bids-recording.js'
      - 'tests/unit-traces-*.test.mjs'
      - 'tests/unit-filters.test.mjs'
      - 'tests/unit-topo2d.test.mjs'
      - 'tests/unit-bids-recording*.test.mjs'
      - 'stryker.conf.json'
  workflow_dispatch: {}

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'

jobs:
  mutation-pr:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # incremental needs git history

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - run: npm ci

      # Restore the Stryker incremental cache from the latest main run.
      # The nightly workflow (mutation.yml) writes it on every push to
      # main; PR runs read it.
      - name: Restore Stryker cache
        uses: actions/cache/restore@v4
        with:
          path: reports/stryker-incremental.json
          key: stryker-incremental-${{ github.event.pull_request.base.sha }}
          restore-keys: |
            stryker-incremental-

      - name: Run Stryker (incremental)
        run: npx stryker run --incremental

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: mutation-pr-report
          path: reports/mutation/
          retention-days: 14
```

- [ ] **Step 3: Update the nightly workflow to SAVE the cache**

Open `.github/workflows/mutation.yml`. Find the steps after `npm run mutation`. Add a cache-save step:

```yaml
      - name: Save Stryker incremental cache
        if: always()
        uses: actions/cache/save@v4
        with:
          path: reports/stryker-incremental.json
          key: stryker-incremental-${{ github.sha }}
```

This must come AFTER the `npm run mutation` step but BEFORE the artifact upload.

- [ ] **Step 4: Local verification (no CI infrastructure needed)**

```bash
# Confirm incremental cache file exists from a prior run
ls -la reports/stryker-incremental.json
# Stryker incremental should be fast (< 30 s)
npx stryker run --incremental 2>&1 | tail -5
```

Expected: aggregate ≥ 67% (current threshold), runtime < 60 s.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/mutation-pr.yml .github/workflows/mutation.yml
git commit -m "ci(mutation): PR-side incremental gate

PR workflow restores the latest main-branch Stryker incremental cache
and runs incremental — typically 2-5 min vs 13 min cold. Triggers
only on PRs that touch one of the 4 mutated files or their tests
(paths filter).

Nightly workflow now saves the cache keyed on the commit SHA so the
PR run finds a recent baseline."
```

---

## Task 3: JSDOM injection for viewer.js mutation scope

**Files:**
- Create: `tests/_jsdom-bootstrap.mjs`
- Modify: `stryker.conf.json` (add viewer.js to mutate scope)
- Create: `tests/unit-viewer-jsdom.test.mjs`

**Why:** viewer.js is excluded from mutation because its IIFE depends on `document`, `window`, `requestAnimationFrame`, `ResizeObserver`, Web Worker globals. JSDOM provides most of these. The test won't reach 100% of viewer.js (Worker requires a separate harness) but ~40-50% of pure-logic paths become mutable.

- [ ] **Step 1: Install JSDOM**

```bash
npm install --save-dev jsdom
```

Expected: `jsdom` in devDependencies.

- [ ] **Step 2: Write the JSDOM bootstrap**

Write `tests/_jsdom-bootstrap.mjs`:

```js
// tests/_jsdom-bootstrap.mjs
//
// JSDOM globals shim for testing viewer.js under node:test. Sets up
// just enough DOM surface that viewer.js's IIFE can load without
// throwing, while keeping the harness lightweight (no full page
// init, no actual rendering).
//
// To use: import './_jsdom-bootstrap.mjs' before require()-ing
// viewer.js.

import { JSDOM } from 'jsdom';

const dom = new JSDOM(`
<!DOCTYPE html>
<html>
<body>
  <main>
    <input id="window-sec" value="10" />
    <input id="gain" value="1" />
    <span id="status"></span>
    <div id="provenance"></div>
    <canvas id="traces" width="800" height="600"></canvas>
    <div id="stage-hint"></div>
    <div id="stage-caption"></div>
    <span id="pill-format"></span>
    <span id="pill-fs"></span>
    <span id="pill-channels"></span>
    <span id="pill-duration"></span>
    <div id="ch-list"></div>
    <span id="channel-count">0</span>
    <a id="electrode-link" hidden></a>
    <div id="cursor-info-bar" hidden>
      <span class="cursor-time"></span>
      <span class="cursor-channel"></span>
      <span class="cursor-value"></span>
    </div>
    <div id="cursor-dot" hidden></div>
    <div id="shortcuts-overlay" hidden></div>
    <div id="metadata-overlay" hidden></div>
    <button id="time-mode-toggle" data-mode="relative">rel</button>
    <input id="filter-hp-enable" type="checkbox" />
    <input id="filter-hp-cutoff" value="0.5" />
    <input id="filter-lp-enable" type="checkbox" />
    <input id="filter-lp-cutoff" value="45" />
    <input id="filter-notch-enable" type="checkbox" />
    <select id="filter-notch-freq"><option value="50">50</option><option value="60" selected>60</option></select>
    <span id="ch-types-colors"></span>
  </main>
</body>
</html>
`, { url: 'http://localhost/' });

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;
globalThis.Element = dom.window.Element;
globalThis.Event = dom.window.Event;
globalThis.URLSearchParams = dom.window.URLSearchParams;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

// Canvas getContext stub — viewer.js calls .getContext('2d') once at
// boot; we hand it a no-op proxy so the renderer can be invoked
// without actually painting pixels.
const stubCtx = new Proxy({}, {
  get: () => () => {},
  set: () => true,
});
const origGetContext = dom.window.HTMLCanvasElement.prototype.getContext;
dom.window.HTMLCanvasElement.prototype.getContext = function () { return stubCtx; };

// Worker stub — viewer.js creates `new Worker('worker.js')` at boot.
// We provide a no-op constructor; tests that need real worker
// behaviour should use the in-process stub from integration tests.
globalThis.Worker = class {
  constructor() {}
  postMessage() {}
  terminate() {}
  set onmessage(fn) {}
  set onerror(fn) {}
};

// devicePixelRatio is used by traces.js's deviceFitCanvas.
globalThis.window.devicePixelRatio = 1;
```

- [ ] **Step 3: Write a smoke test that loads viewer.js cleanly**

Write `tests/unit-viewer-jsdom.test.mjs`:

```js
// Smoke test: viewer.js loads under JSDOM without throwing.
// Sets the floor for Stryker's mutate-on-viewer.js coverage.
import './_jsdom-bootstrap.mjs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('viewer.js: loads under JSDOM without throwing', () => {
  // Format readers must load first — viewer.js references them at
  // boot via globalThis.{EDFReader,EEGLABReader,...}.
  require('../formats/_buffers.js');
  require('../formats/_http_range.js');
  require('../formats/_streaming.js');
  require('../formats/_sidecar.js');
  require('../formats/_matv5.js');
  require('../bids-recording.js');
  require('../formats/eeglab.js');
  require('../formats/edf.js');
  require('../formats/brainvision.js');
  require('../formats/fiff.js');
  require('../traces.js');
  require('../filters.js');

  // Now load viewer.js. The IIFE will:
  //   - Attach window.Viewer
  //   - NOT call boot() (boot() requires explicit invocation)
  require('../viewer.js');

  assert.ok(globalThis.window.Viewer, 'window.Viewer must be set');
  assert.equal(typeof globalThis.window.Viewer.boot, 'function');
  assert.equal(typeof globalThis.window.Viewer.clampStart, 'function');
});

test('viewer.js: clampStart matches the formula contract', () => {
  // viewer.js's clampStart was previously contract-tested via re-
  // implementation in tests/unit-viewer-render-loop.test.mjs. Now that
  // we can require viewer.js directly under JSDOM, exercise the live
  // function.
  const v = globalThis.window.Viewer;
  assert.equal(v.clampStart(-5, 100, 10), 0);
  assert.equal(v.clampStart(95, 100, 10), 90);
  assert.equal(v.clampStart(5, 10, 20), 0);
  assert.equal(v.clampStart(42.5, 100, 10), 42.5);
});
```

- [ ] **Step 4: Run the smoke test**

```bash
node --test tests/unit-viewer-jsdom.test.mjs 2>&1 | tail -10
```

Expected: 2 tests pass. If viewer.js throws at load, the JSDOM shim needs more globals — extend `_jsdom-bootstrap.mjs` with whatever the error reports as missing, then re-run.

- [ ] **Step 5: Add viewer.js to Stryker mutate scope**

Edit `stryker.conf.json`. Update the `mutate` array and `commandRunner.command`:

```json
{
  "commandRunner": {
    "command": "node --test tests/unit-traces-draw.test.mjs tests/unit-traces-partial-fill.test.mjs tests/unit-traces-nice-round.test.mjs tests/unit-traces-time-axis.test.mjs tests/unit-traces-scalebar-axis.test.mjs tests/traces.test.mjs tests/unit-filters.test.mjs tests/unit-topo2d.test.mjs tests/unit-bids-recording.test.mjs tests/unit-bids-recording-assemble.test.mjs tests/unit-viewer-jsdom.test.mjs tests/unit-viewer-render-loop.test.mjs tests/unit-viewer-races.test.mjs"
  },
  "mutate": [
    "traces.js",
    "filters.js",
    "topo2d.js",
    "bids-recording.js",
    "viewer.js"
  ]
}
```

- [ ] **Step 6: Run incremental Stryker to capture the new baseline**

```bash
rm -f reports/stryker-incremental.json
npx stryker run 2>&1 | tee /tmp/stryker-viewer-expand.log | tail -10
```

Expected: aggregate moves; viewer.js per-file score appears in the table. Score likely in the 30-50% range (JSDOM doesn't reach DOM-side render paths). Document the new baseline in `docs/mutation-survivors-2026-05.md`.

- [ ] **Step 7: Adjust break threshold**

Per the project's documented decision tree:
- If new aggregate ≥ 67% → keep `break: 67`
- Else → lower to `(new aggregate − 5)`

Write the new threshold into `stryker.conf.json`.

- [ ] **Step 8: Commit (3 commits)**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add jsdom for viewer.js mutation coverage"

git add tests/_jsdom-bootstrap.mjs tests/unit-viewer-jsdom.test.mjs
git commit -m "test(viewer): JSDOM smoke test — viewer.js loads + clampStart works"

git add stryker.conf.json docs/mutation-survivors-2026-05.md
git commit -m "chore(stryker): add viewer.js to mutate scope (new baseline <N>%)"
```

Substitute `<N>` with the actual measured score.

---

## Task 4: Worker mutation scope via in-process harness

**Files:**
- Modify: `stryker.conf.json` (worker.js into mutate scope, paired with worker-protocol tests)
- Create: `tests/unit-worker-jsdom.test.mjs`

**Why:** worker.js currently can't be mutated because Stryker's command runner loads it via `importScripts` (Web Worker semantics) which node:test can't simulate. But the existing `tests/unit-worker-protocol.test.mjs` already exercises the message-handling logic through dependency injection. We can re-use that harness for mutation.

- [ ] **Step 1: Audit existing worker-protocol test infrastructure**

```bash
grep -l "FETCH_WINDOW\|onmessage\|self\.postMessage" tests/unit-worker-*.test.mjs
```

Expected: 3-4 test files. Read them and confirm they use `globalThis.self = { postMessage }` and DI'd reader.

- [ ] **Step 2: Write a worker-loadable smoke test**

Write `tests/unit-worker-jsdom.test.mjs`:

```js
// Smoke test: worker.js's logic surface is reachable under node:test
// via a `self` shim. Sets the floor for Stryker mutation coverage.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Shim the WebWorker globals before requiring worker.js. We use
// `self` (not `globalThis`) because worker.js's importScripts +
// onmessage references attach there.
const recordedMessages = [];
globalThis.self = {
  onmessage: null,
  postMessage(msg, transfer) {
    recordedMessages.push({ msg, transfer });
  },
};
// importScripts is a no-op; worker.js's load order relies on the
// format readers + helpers being already loaded into globalThis.
globalThis.importScripts = () => {};

// Load the dependency chain that importScripts() normally loads.
require('../formats/_buffers.js');
require('../formats/_http_range.js');
require('../formats/_streaming.js');
require('../formats/_sidecar.js');
require('../formats/_matv5.js');
require('../bids-recording.js');
require('../formats/eeglab.js');
require('../formats/edf.js');
require('../formats/brainvision.js');
require('../formats/fiff.js');
require('../filters.js');

// Now worker.js can be required — its top-level only attaches
// self.onmessage; no fetch happens until we send a message.
require('../worker.js');

test('worker.js: loads under self-shim without throwing', () => {
  assert.equal(typeof globalThis.self.onmessage, 'function',
    'worker.js must attach self.onmessage at load');
});

test('worker.js: INIT message gets INIT_OK reply', async () => {
  recordedMessages.length = 0;
  await globalThis.self.onmessage({ data: { type: 'INIT' } });
  assert.ok(recordedMessages.length >= 1, 'must reply to INIT');
  const reply = recordedMessages[0].msg;
  assert.equal(reply.type, 'INIT_OK');
  assert.ok(Array.isArray(reply.formats), 'INIT_OK must list supported formats');
  assert.ok(reply.formats.includes('edf'), 'edf must be supported');
  assert.ok(reply.formats.includes('fif'), 'fif must be supported');
});

test('worker.js: CANCEL_REQUEST marks the request cancelled (idempotent)', async () => {
  recordedMessages.length = 0;
  await globalThis.self.onmessage({ data: { type: 'CANCEL_REQUEST', request_id: 999 } });
  // CANCEL_REQUEST produces no reply (fire-and-forget protocol).
  assert.equal(recordedMessages.length, 0);
  // Sending it again must not throw.
  await globalThis.self.onmessage({ data: { type: 'CANCEL_REQUEST', request_id: 999 } });
  assert.equal(recordedMessages.length, 0);
});
```

- [ ] **Step 3: Verify the smoke test passes**

```bash
node --test tests/unit-worker-jsdom.test.mjs 2>&1 | tail -8
```

Expected: 3 tests pass.

- [ ] **Step 4: Add worker.js to Stryker mutate scope**

Edit `stryker.conf.json`:

```json
{
  "commandRunner": {
    "command": "<existing command> tests/unit-worker-jsdom.test.mjs tests/unit-worker-protocol.test.mjs tests/unit-worker-faults.test.mjs tests/unit-worker-cache.test.mjs tests/unit-worker-races.test.mjs"
  },
  "mutate": [
    "traces.js",
    "filters.js",
    "topo2d.js",
    "bids-recording.js",
    "viewer.js",
    "worker.js"
  ]
}
```

- [ ] **Step 5: Fresh Stryker baseline**

```bash
rm -f reports/stryker-incremental.json
npx stryker run 2>&1 | tee /tmp/stryker-worker-expand.log | tail -10
```

- [ ] **Step 6: Document + commit**

Append iteration 11 section to `docs/mutation-survivors-2026-05.md` with the new per-file table + aggregate.

```bash
git add tests/unit-worker-jsdom.test.mjs stryker.conf.json docs/mutation-survivors-2026-05.md
git commit -m "chore(stryker): add worker.js to mutate scope (aggregate <N>%)"
```

---

## Task 5: JSDoc + tsc --noEmit type checking on formats/

**Files:**
- Create: `jsconfig.json`
- Modify: `package.json` (add `test:typecheck` script + tsc devDep)
- Modify: `formats/edf.js` (add JSDoc to public api functions)
- Modify: `formats/brainvision.js` (same)
- Modify: `formats/eeglab.js` (same)
- Modify: `formats/fiff.js` (same)

**Why:** Lightweight type checking without a full TypeScript rewrite. `tsc --noEmit --checkJs` reads JSDoc `@param` / `@returns` annotations and reports mismatches. Start with the format-reader public API surface — it's the most-imported module surface.

- [ ] **Step 1: Install typescript as a devDependency**

```bash
npm install --save-dev typescript
```

Expected: `typescript` in devDependencies. We're using it only for `tsc --noEmit`, not to compile.

- [ ] **Step 2: Write jsconfig.json**

Write `jsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "node",
    "checkJs": true,
    "noEmit": true,
    "allowJs": true,
    "strict": false,
    "noImplicitAny": false,
    "strictNullChecks": false,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": [
    "formats/edf.js",
    "formats/brainvision.js",
    "formats/eeglab.js",
    "formats/fiff.js"
  ],
  "exclude": [
    "node_modules",
    "tests",
    "bench",
    "reports",
    "coverage"
  ]
}
```

Why permissive: existing JS has no annotations. We turn on `checkJs` but leave `strict` off so files compile without forced annotations. Functions WITH JSDoc get checked; functions WITHOUT JSDoc fall back to `any`. Gradual adoption.

- [ ] **Step 3: Add JSDoc to formats/fiff.js api.read**

Open `formats/fiff.js`. Find `api.read = function (buf) {`. Add a JSDoc block above it:

```js
/**
 * Parse a FIFF (Neuromag/Elekta MEG) file's tag stream into a meas object.
 * @param {ArrayBuffer} buf - The full file as an ArrayBuffer (FIFF doesn't
 *   support random access without the directory; pass the whole file).
 * @returns {{
 *   blocks: number[],
 *   chs: Array<{ ch_name: string, kind: number, scanno: number, range: number, cal: number }>,
 *   has_projections: boolean,
 *   meas_date: number | null,
 *   nchan: number,
 *   raw: { data: Float32Array[] } | null,
 *   sfreq: number
 * }}
 * @throws {Error} if the file is shorter than 16 bytes or the first tag
 *   is not FIFF_FILE_ID (kind=100, big-endian).
 */
api.read = function (buf) {
```

- [ ] **Step 4: Add JSDoc to formats/edf.js api.parseHeader**

Open `formats/edf.js`. Find `api.parseHeader = function (arrayBuf) {`:

```js
/**
 * Parse the 256-byte fixed header + per-signal 256-byte metadata blocks
 * of an EDF / EDF+ / BDF file.
 * @param {ArrayBuffer} arrayBuf - The first 256 + 256*n_signals bytes.
 *   Must be at least 256 bytes (just the fixed header is OK for n_signals=0).
 * @returns {{
 *   version: string,
 *   local_patient_id: string,
 *   local_recording_id: string,
 *   start_date: string,
 *   start_time: string,
 *   n_header_bytes: number,
 *   reserved: string,
 *   n_records: number,
 *   record_duration: number,
 *   n_signals: number,
 *   signals: Array<{ label: string, transducer: string, physical_dimension: string, physical_min: number, physical_max: number, digital_min: number, digital_max: number, prefiltering: string, samples_per_record: number, reserved: string }>
 * }}
 */
api.parseHeader = function (arrayBuf) {
```

- [ ] **Step 5: Add JSDoc to formats/brainvision.js api.parseHeader and api.parseIni**

```js
/**
 * Parse a BrainVision .vhdr file's INI-flavoured text into a flat key-
 * value map keyed by section.
 * @param {string} text - The full UTF-8 content of the .vhdr file.
 * @returns {Object<string, Object<string, string>>} - Maps section name
 *   (e.g. "Common Infos") to its key/value pairs.
 */
api.parseIni = function (text) {

/**
 * Parse a BrainVision .vhdr file and return the recording metadata.
 * @param {string} text - The full .vhdr text.
 * @returns {{
 *   n_channels: number,
 *   sampling_rate: number,
 *   sampling_interval: number,
 *   binary_format: string,
 *   data_orientation: string,
 *   data_format: string,
 *   data_file: string,
 *   marker_file: string,
 *   channels: Array<{ name: string, ref: string, resolution: number, units: string }>
 * }}
 */
api.parseHeader = function (text) {
```

- [ ] **Step 6: Add JSDoc to formats/eeglab.js api.open**

```js
/**
 * Open an EEGLAB .set file (with optional external .fdt) for windowed reading.
 * @param {{
 *   eeg_url: string,
 *   sibling_urls?: Object<string, string>,
 *   channels?: Array<{ name: string, type?: string, units?: string }>,
 *   eeg_json?: { sampling_frequency?: number }
 * }} meta - The recording descriptor from bids-recording.js.
 * @returns {Promise<{
 *   n_channels: number,
 *   sampling_frequency: number,
 *   duration_s: number,
 *   channel_labels: string[] | null,
 *   bytes_per_sample: number,
 *   n_samples: number,
 *   recording_start_iso: string | null,
 *   annotation_events: Array<{ onset: number, label: string }> | null,
 *   readWindow: (start: number, n: number, opts?: { signal?: AbortSignal }) => Promise<Float32Array[]>,
 *   readWindowStreaming?: (start: number, n: number, opts?: { signal?: AbortSignal }) => AsyncIterable<{ channels: Float32Array[], firstSampleIdx: number, lastSampleIdx: number }>
 * }>}
 */
api.open = async function (meta) {
```

- [ ] **Step 7: Add `test:typecheck` script**

Open `package.json`. Add a new script:

```json
"test:typecheck": "tsc --noEmit -p jsconfig.json"
```

Place it between `test:perf` and `bench`.

- [ ] **Step 8: Run typecheck — expect to see existing issues**

```bash
npm run test:typecheck 2>&1 | tail -20
```

Expected: TypeScript reports errors on the JSDoc-annotated functions where the actual return shape disagrees with the documented shape. For each error:
- If it's a real type bug → fix the JSDoc to match reality (the source is the ground truth for now).
- If it's a TypeScript-quirk false positive → suppress with `// @ts-ignore` or remove the over-strict annotation.

Goal: zero errors. The check becomes a CI gate going forward.

- [ ] **Step 9: Wire into CI**

Open `.github/workflows/ci.yml`. Find the unit-test job. Add a step after `npm run test:unit`:

```yaml
      - name: Type check (tsc on JSDoc-annotated files)
        run: npm run test:typecheck
```

- [ ] **Step 10: Commit (4 commits)**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add typescript for tsc --noEmit JSDoc checking"

git add jsconfig.json
git commit -m "chore: jsconfig for tsc --checkJs on formats/ public API"

git add formats/edf.js formats/brainvision.js formats/eeglab.js formats/fiff.js
git commit -m "docs(formats): JSDoc type annotations on public API entry points"

git add .github/workflows/ci.yml
git commit -m "ci: add test:typecheck gate on JSDoc-annotated formats/"
```

---

## Task 6: Property tests on the render path

**Files:**
- Create: `tests/prop-render.test.mjs`

**Why:** fast-check has 8 property tests on format parsers. The render path has zero. Geometry invariants are perfect property-test targets — they're easy to express, hard to enumerate by hand.

- [ ] **Step 1: Write `tests/prop-render.test.mjs`**

```js
// tests/prop-render.test.mjs
//
// Property-based tests for TraceRenderer.draw() geometry invariants.
// Each property is something that MUST hold for any valid input
// regardless of channel count, sample count, gain, window size, etc.
//
// Pairs with the existing example-based tests in unit-traces-*.test.mjs:
// example tests pin specific edge cases; property tests sweep the
// continuous input space looking for unanticipated failures.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { fc } from './_arbitraries.mjs';
import { makeRecordingCanvas } from './_render-invariants.mjs';

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
globalThis.ResizeObserver = globalThis.ResizeObserver || class {
  observe() {} unobserve() {} disconnect() {}
};
globalThis.window.devicePixelRatio = 1;
const TraceRenderer = require('../traces.js');

const validChannelCount = fc.integer({ min: 1, max: 64 });
const validSampleCount = fc.integer({ min: 2, max: 5000 });
const validGain = fc.float({ min: Math.fround(0.1), max: Math.fround(10), noNaN: true });
const validStartSec = fc.float({ min: 0, max: 1000, noNaN: true });
const validFs = fc.constantFrom(100, 250, 500, 1000, 2000);

function buildChannels(nCh, nSamp) {
  const out = [];
  for (let c = 0; c < nCh; c++) {
    const d = new Float32Array(nSamp);
    for (let i = 0; i < nSamp; i++) {
      d[i] = Math.sin(i * 0.1 + c) * (10 + c);
    }
    out.push(d);
  }
  return out;
}

test('property: every draw produces at least 1 polyline lineTo per visible channel', () => {
  fc.assert(
    fc.property(validChannelCount, validSampleCount, validGain, validFs,
      (nCh, nSamp, gain, fs) => {
        const channels = buildChannels(nCh, nSamp);
        const { canvas, calls } = makeRecordingCanvas(800, 600);
        TraceRenderer.draw(canvas, {
          channels,
          channel_labels: channels.map((_, i) => `Ch${i+1}`),
          channel_types: channels.map(() => 'EEG'),
          n_samples_visible: nSamp,
          fs,
          start_sec: 0,
          gain,
          transparent: false,
        });
        const lineToCount = calls.filter(c => c.op === 'lineTo').length;
        // At least nVisibleChannels * 1 lineTo (polyline draws at least
        // 1 segment per channel for nSamp >= 2).
        const maxVisible = TraceRenderer.lastMaxVisibleChannels || nCh;
        const visibleCh = Math.min(maxVisible, nCh);
        return lineToCount >= visibleCh;
      }),
    { numRuns: 100 },
  );
});

test('property: lastSlotMicrovolts is finite and positive on any draw with std > 0', () => {
  fc.assert(
    fc.property(validChannelCount, validSampleCount, validGain,
      (nCh, nSamp, gain) => {
        const channels = buildChannels(nCh, nSamp);
        const { canvas } = makeRecordingCanvas(800, 600);
        TraceRenderer.draw(canvas, {
          channels,
          channel_labels: channels.map((_, i) => `Ch${i+1}`),
          channel_types: channels.map(() => 'EEG'),
          n_samples_visible: nSamp,
          fs: 250,
          start_sec: 0,
          gain,
          transparent: false,
        });
        return isFinite(TraceRenderer.lastSlotMicrovolts) &&
               TraceRenderer.lastSlotMicrovolts > 0;
      }),
    { numRuns: 100 },
  );
});

test('property: lastTotalChannels equals input nCh, lastChannelOffset clamped', () => {
  fc.assert(
    fc.property(validChannelCount, fc.integer({ min: 0, max: 1000 }),
      (nCh, offsetRaw) => {
        const channels = buildChannels(nCh, 200);
        const { canvas } = makeRecordingCanvas(800, 600);
        TraceRenderer.draw(canvas, {
          channels,
          channel_labels: channels.map((_, i) => `Ch${i+1}`),
          channel_types: channels.map(() => 'EEG'),
          channel_offset: offsetRaw,
          n_samples_visible: 200,
          fs: 250,
          start_sec: 0,
          gain: 1,
          transparent: false,
        });
        if (TraceRenderer.lastTotalChannels !== nCh) return false;
        if (TraceRenderer.lastChannelOffset < 0) return false;
        if (TraceRenderer.lastChannelOffset > Math.max(0, nCh - 1)) return false;
        return true;
      }),
    { numRuns: 100 },
  );
});

test('property: partial_fill polyline X-bounds stay within (samples_visible/total) * plotW', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 500, max: 5000 }),  // total
      fc.float({ min: Math.fround(0.05), max: Math.fround(0.95), noNaN: true }), // partial ratio
      (total, ratio) => {
        const partial = Math.max(2, Math.floor(total * ratio));
        const fullCh = buildChannels(1, total)[0];
        const partialCh = fullCh.subarray(0, partial);
        const { canvas, calls } = makeRecordingCanvas(800, 600);
        TraceRenderer.draw(canvas, {
          channels: [partialCh],
          channel_labels: ['Ch1'],
          channel_types: ['EEG'],
          n_samples_visible: partial,
          fs: 250,
          start_sec: 0,
          gain: 1,
          transparent: false,
          partial_fill: { sample_start: 0, sample_end: partial - 1, total_samples: total },
        });
        const plotX0 = TraceRenderer.PAD_LEFT;
        const plotW = 800 - TraceRenderer.PAD_RIGHT - TraceRenderer.PAD_LEFT;
        const PAD_TOP = TraceRenderer.PAD_TOP;
        const PAD_BOTTOM = TraceRenderer.PAD_BOTTOM;
        const plotY1 = 600 - PAD_BOTTOM;
        // Polyline lineTos in the plot Y band:
        const polylineXs = calls
          .filter(c => c.op === 'lineTo' && c.args[1] >= PAD_TOP && c.args[1] <= plotY1)
          .map(c => c.args[0]);
        if (polylineXs.length === 0) return true;  // empty channel — vacuously true
        const expectedMax = plotX0 + (partial / total) * plotW;
        const actualMax = Math.max(...polylineXs);
        return actualMax <= expectedMax + 4;  // 4-px rounding slack
      }),
    { numRuns: 100 },
  );
});

test('property: events outside [t0, t1] never produce a fillText', () => {
  fc.assert(
    fc.property(
      fc.float({ min: 0, max: 100, noNaN: true }),  // window start
      fc.float({ min: 0.5, max: 30, noNaN: true }), // window duration (s)
      (start, duration) => {
        const channels = buildChannels(2, 500);
        const fs = 250;
        // Place 5 events: all outside the window
        const events = [
          { onset: start - 5, label: 'past1' },
          { onset: start - 1, label: 'past2' },
          { onset: start + duration + 0.1, label: 'fut1' },
          { onset: start + duration + 10, label: 'fut2' },
          { onset: start + duration * 100, label: 'fut3' },
        ];
        const { canvas, calls } = makeRecordingCanvas(800, 600);
        TraceRenderer.draw(canvas, {
          channels,
          channel_labels: channels.map((_, i) => `Ch${i+1}`),
          channel_types: channels.map(() => 'EEG'),
          n_samples_visible: Math.floor(duration * fs),
          fs,
          start_sec: start,
          gain: 1,
          transparent: false,
          events,
        });
        for (const ev of events) {
          if (calls.some(c => c.op === 'fillText' && c.args[0] === ev.label)) {
            return false;
          }
        }
        return true;
      }),
    { numRuns: 100 },
  );
});
```

- [ ] **Step 2: Run the new property tests**

```bash
node --test tests/prop-render.test.mjs 2>&1 | tail -8
```

Expected: 5 tests pass with 100 runs each = 500 generated cases.

- [ ] **Step 3: Add to the c8 coverage script**

The test:coverage script in package.json already picks up `tests/prop-*.test.mjs`. Verify:

```bash
grep "test:coverage" package.json
```

Confirm `prop-*.test.mjs` is in the file list. If not, add it.

- [ ] **Step 4: Commit**

```bash
git add tests/prop-render.test.mjs
git commit -m "test(render): property tests on geometry invariants

5 fast-check properties × 100 runs each = 500 generated cases:
- every draw produces ≥ 1 lineTo per visible channel
- lastSlotMicrovolts is finite + positive
- lastTotalChannels matches input, lastChannelOffset clamped
- partial_fill polyline X stays within (partial/total) * plotW
- events outside [t0, t1] never produce a fillText"
```

---

## Task 7: Lighthouse CI workflow

**Files:**
- Create: `.github/workflows/lighthouse.yml`
- Create: `.lighthouserc.cjs`

**Why:** Microbenchmarks measure per-function CPU. Lighthouse measures USER-OBSERVED metrics: LCP, INP, CLS, TBT. Different layer of the perf stack.

- [ ] **Step 1: Write the Lighthouse config**

Write `.lighthouserc.cjs`:

```js
// .lighthouserc.cjs
// Lighthouse CI config — runs against the local static server, gates
// on Web Vitals budgets.

module.exports = {
  ci: {
    collect: {
      url: [
        'http://localhost:8011/index.html?eeg=/test-data/edfplus-with-annotations.edf',
      ],
      startServerCommand: 'node scripts/serve.mjs 8011',
      startServerReadyPattern: 'Static server listening',
      numberOfRuns: 3,
    },
    assert: {
      assertions: {
        'categories:performance':  ['warn',  { minScore: 0.80 }],
        'categories:accessibility':['error', { minScore: 0.90 }],
        'categories:best-practices':['warn', { minScore: 0.85 }],
        // Specific Web Vitals:
        'largest-contentful-paint': ['warn',  { maxNumericValue: 2500 }],
        'cumulative-layout-shift':  ['error', { maxNumericValue: 0.10 }],
        'total-blocking-time':      ['warn',  { maxNumericValue: 300 }],
      },
    },
    upload: {
      target: 'temporary-public-storage',
    },
  },
};
```

- [ ] **Step 2: Write the workflow**

Write `.github/workflows/lighthouse.yml`:

```yaml
name: Lighthouse CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
  workflow_dispatch: {}

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'

jobs:
  lighthouse:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci

      - name: Install Lighthouse CI
        run: npm install --no-save @lhci/cli

      - name: Run Lighthouse CI
        run: npx lhci autorun --config=./.lighthouserc.cjs
        env:
          LHCI_GITHUB_APP_TOKEN: ${{ secrets.LHCI_GITHUB_APP_TOKEN }}
```

`LHCI_GITHUB_APP_TOKEN` is optional — without it, results upload to temporary public storage (the URL is printed in the run log).

- [ ] **Step 3: Local run for baseline**

```bash
npm install --no-save @lhci/cli
npx lhci autorun --config=./.lighthouserc.cjs 2>&1 | tail -15
```

Expected: Lighthouse boots a headless Chrome, runs 3 times, reports the assertions. If any assertion fails, either:
- Fix the underlying issue (rare — usually means a real regression)
- Relax the threshold (document why in `.lighthouserc.cjs` comments)

- [ ] **Step 4: Commit**

```bash
git add .lighthouserc.cjs .github/workflows/lighthouse.yml
git commit -m "ci(perf): Lighthouse CI on PR + main push

Gates on user-observed Web Vitals:
- accessibility >= 0.90 (ERROR if below — blocks)
- CLS <= 0.10 (ERROR — blocks)
- performance >= 0.80, LCP <= 2.5s, TBT <= 300ms (WARN — non-blocking)

Free temporary-public-storage uploads results; the URL is printed in
the CI log. Optional GitHub App token enables PR-comment posting."
```

---

## Task 8: Active-streaming memory leak test

**Files:**
- Create: `tests/e2e/memory-streaming.spec.mjs`

**Why:** RAPID-5 measures heap after 200 pans SETTLE. Doesn't catch leaks during ACTIVE streaming (heap grows mid-pan, may recover after but allocator fragmentation could matter).

- [ ] **Step 1: Write the spec**

Write `tests/e2e/memory-streaming.spec.mjs`:

```js
// tests/e2e/memory-streaming.spec.mjs
//
// Memory leak detection during ACTIVE streaming, not just at rest.
// Differs from RAPID-5 (heap after settle) — this samples the heap
// AT regular intervals WHILE a continuous pan workload runs.

import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const EEG_URL = 'https://s3.amazonaws.com/openneuro.org/ds002893/sub-001/eeg/sub-001_task-AuditoryVisualShift_run-01_eeg.set';
const EVIDENCE_ROOT = path.resolve('tests/evidence');

function evidenceDir(id) {
  const d = path.join(EVIDENCE_ROOT, id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function waitForLoad(page, timeout = 90_000) {
  await expect(page.locator('#stage-caption')).toBeVisible({ timeout });
}

test('MEM-STREAM: heap stays bounded during 5 min of continuous panning', async ({ page }) => {
  const dir = evidenceDir('mem-streaming');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      errors.push(m.text());
    }
  });

  await page.goto(`/index.html?eeg=${encodeURIComponent(EEG_URL)}`);
  await waitForLoad(page);
  await page.waitForTimeout(2000);

  const hasGc = await page.evaluate(() => typeof window.gc === 'function');
  test.skip(!hasGc, 'window.gc unavailable — run with --js-flags=--expose-gc');

  // Sample heap mid-streaming every ~5 s for 30 cycles (~2.5 minutes).
  // After each sample, fire another 20 pans to keep streaming active.
  const samples = [];
  for (let cycle = 0; cycle < 30; cycle++) {
    // Force GC + read heap.
    const heap = await page.evaluate(() => {
      for (let i = 0; i < 5; i++) window.gc();
      return performance.memory.usedJSHeapSize;
    });
    samples.push({ cycle, heap, ts: Date.now() });

    // Drive 20 more pans (mix of left/right).
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press(i % 2 === 0 ? 'ArrowRight' : 'ArrowLeft');
    }
    await page.waitForTimeout(200);
  }

  // Sample 0 is the baseline AFTER initial settle. Last samples are
  // after 600 pans of streaming. Compute the slope of heap-vs-cycle
  // — a real leak shows a positive trend; bounded usage shows a flat
  // line with cyclic GC-driven variance.
  const start = samples[5].heap;  // skip the first 5 (settling)
  const end = samples[samples.length - 1].heap;
  const growth = end - start;
  const growthMb = growth / 1024 / 1024;

  fs.writeFileSync(path.join(dir, 'samples.json'), JSON.stringify({
    samples,
    growthBytes: growth,
    growthMb: Number(growthMb.toFixed(2)),
    cycles: samples.length,
    pansApprox: 600,
  }, null, 2));

  expect(errors).toHaveLength(0);
  // Bounded growth: < 10 MB over 600 pans + 30 GC cycles. RAPID-5's
  // post-settle gate is 5 MB; this active-streaming gate is more
  // permissive because mid-streaming heap can transiently retain
  // pending chunk buffers.
  expect(growthMb).toBeLessThan(10);
});
```

- [ ] **Step 2: Verify locally (long-running test)**

```bash
npx playwright test tests/e2e/memory-streaming.spec.mjs --project=chromium --reporter=list 2>&1 | tail -10
```

Expected: 1 test passes (or skips if `window.gc` not exposed — `playwright.config.mjs` already passes `--js-flags=--expose-gc`). Runtime ~3-4 min.

- [ ] **Step 3: Wire into the `test:e2e:rapid` script**

Open `package.json`. Update:

```json
"test:e2e:rapid": "playwright test tests/e2e/streaming.spec.mjs tests/e2e/rapid-scroll.spec.mjs tests/e2e/memory-streaming.spec.mjs --project=chromium"
```

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/memory-streaming.spec.mjs package.json
git commit -m "test(e2e): memory leak detection during ACTIVE streaming

MEM-STREAM samples heap every ~5 s for 30 cycles while firing 20 pans
between samples (~600 pans total). Asserts heap growth from sample
5 to last < 10 MB (relaxed vs RAPID-5's post-settle 5 MB because
mid-streaming heap retains pending chunk buffers).

Skips if window.gc is unavailable; playwright.config.mjs sets
--js-flags=--expose-gc on the chromium project so it's normally on."
```

---

## Task 9: Cross-browser visual baselines via Playwright Docker

**Files:**
- Create: `.github/workflows/visual-cross-browser.yml`

**Why:** Visual baselines are macOS-only. Linux/Windows ship from CI but can't compare against locally-generated baselines. Solution: generate baselines INSIDE the official Playwright Docker image (Linux) and ship both alongside macOS-darwin baselines.

- [ ] **Step 1: Write the workflow**

Write `.github/workflows/visual-cross-browser.yml`:

```yaml
name: Visual regression (cross-browser)

on:
  pull_request:
    branches: [main]
    paths:
      - 'traces.js'
      - 'styles.css'
      - 'topo2d.js'
      - 'tests/e2e/visual-regression.spec.mjs'
  push:
    branches: [main]
    paths:
      - 'traces.js'
      - 'styles.css'
      - 'topo2d.js'
      - 'tests/e2e/visual-regression.spec.mjs'
  workflow_dispatch: {}

jobs:
  visual:
    runs-on: ubuntu-latest
    container:
      image: mcr.microsoft.com/playwright:v1.59.1-jammy
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: Run visual regression
        run: npx playwright test tests/e2e/visual-regression.spec.mjs --project=chromium --reporter=list
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: visual-diffs
          path: |
            test-results/**/*.png
            test-results/**/diff.png
          retention-days: 30
```

The container's Linux Chromium produces `*-chromium-linux.png` snapshots which Playwright auto-stores in `visual-regression.spec.mjs-snapshots/` next to the existing `-darwin.png` ones.

- [ ] **Step 2: Generate the Linux baselines locally (optional, faster than waiting for CI)**

```bash
# Pull the Playwright image (downloads on first use, ~700 MB)
docker pull mcr.microsoft.com/playwright:v1.59.1-jammy

# Run a baseline generation against our local code
docker run --rm -v "$(pwd):/work" -w /work \
  mcr.microsoft.com/playwright:v1.59.1-jammy \
  bash -c 'npm ci && npx playwright test tests/e2e/visual-regression.spec.mjs --project=chromium --update-snapshots'
```

Expected: 6 new `*-chromium-linux.png` files appear in `tests/e2e/visual-regression.spec.mjs-snapshots/`.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/visual-regression.spec.mjs-snapshots/*chromium-linux.png
git commit -m "test(visual): Linux baselines for cross-browser visual regression

Generated under mcr.microsoft.com/playwright:v1.59.1-jammy (the
official Playwright image). Pair-files with the existing
*-chromium-darwin.png baselines. Playwright auto-selects by host
OS — CI on ubuntu-latest now compares against Linux baselines;
local macOS dev compares against darwin baselines."

git add .github/workflows/visual-cross-browser.yml
git commit -m "ci(visual): cross-browser visual-regression workflow

Runs inside official Playwright Docker image for deterministic Linux
output. Triggers on PRs touching the render path; uploads diff PNGs
as artifacts on failure for human review."
```

---

## Task 10: Network resilience — NEMAR + OpenNeuro retry policy

**Files:**
- Modify: `bids-recording.js` (add retry helper around fetch + 404-tolerant NEMAR fallback)
- Create: `tests/unit-network-retry.test.mjs`

**Why:** NEMAR returns "Version not published" (404) intermittently; OpenNeuro S3 sometimes returns 503 under load. Today the viewer surfaces these as fatal errors. Add exponential backoff (3 retries, 200/400/800 ms) + a circuit-breaker that falls back to the alternate provider if both attempts fail.

- [ ] **Step 1: Find the existing fetch call sites**

```bash
grep -n "fetch(\|HttpRange\.fetch" bids-recording.js | head -20
```

Expected: 3-5 call sites in `loadNemarRecording`, `fetchInheritedSidecar`, similar. Note the line numbers.

- [ ] **Step 2: Add a retry wrapper at the top of bids-recording.js**

Edit `bids-recording.js`. After the existing `function isAllowedProtocol(...)` block, add:

```js
// Network resilience: NEMAR's data.nemar.org occasionally returns 404
// 'Version not published' on the latest manifest; OpenNeuro S3 returns
// 503 under load. Wrap fetch() with bounded exponential backoff —
// 3 retries (200, 400, 800 ms) on transient 5xx and on network errors.
// 4xx (other than 429) is treated as terminal — the URL is wrong, no
// point retrying.
async function fetchWithRetry(url, opts) {
  const TRANSIENT = new Set([429, 502, 503, 504]);
  const delays = [200, 400, 800];
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok) return res;
      if (TRANSIENT.has(res.status) && attempt < delays.length) {
        await new Promise(r => setTimeout(r, delays[attempt]));
        continue;
      }
      // 4xx terminal — return the response so caller can decide
      // (parsePhysioUrl or the sidecar walk often expects 404).
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < delays.length) {
        await new Promise(r => setTimeout(r, delays[attempt]));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('fetchWithRetry: unreachable');
}
api._fetchWithRetry = fetchWithRetry;  // exposed for tests
```

- [ ] **Step 3: Swap the fetch calls inside loadNemarRecording**

In `bids-recording.js`, find `loadNemarRecording`. Find any `await fetch(...)` calls inside it. Replace with `await fetchWithRetry(...)`.

Same for `fetchInheritedSidecar` and any other internal sidecar walker.

DO NOT change `HttpRange.fetch*` calls — those go through a different abstraction (the range-fetch layer in `formats/_http_range.js`) and have their own concerns.

- [ ] **Step 4: Write retry tests**

Write `tests/unit-network-retry.test.mjs`:

```js
// tests/unit-network-retry.test.mjs
//
// Network resilience tests for the retry helper in bids-recording.js.
// Monkey-patches globalThis.fetch with a programmable mock that returns
// a configured sequence of responses, then asserts:
//   1. transient 5xx is retried up to 3 times
//   2. terminal 4xx is returned without retry
//   3. network error (throw) is retried with exponential backoff
//   4. successful 2xx is returned immediately

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BIDSRecording } from './_bootstrap.mjs';

function mockFetch(responses) {
  let i = 0;
  return async () => {
    const r = responses[i++];
    if (r instanceof Error) throw r;
    return r;
  };
}

function fakeResponse(status, body = 'ok') {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body; },
    async json() { return JSON.parse(body); },
  };
}

test('retry: 200 returned without retry', async () => {
  globalThis.fetch = mockFetch([fakeResponse(200, 'good')]);
  const res = await BIDSRecording._fetchWithRetry('https://example.com/x');
  assert.equal(res.status, 200);
});

test('retry: 503 retried, eventual 200 succeeds', async () => {
  globalThis.fetch = mockFetch([
    fakeResponse(503), fakeResponse(503), fakeResponse(200, 'good'),
  ]);
  const res = await BIDSRecording._fetchWithRetry('https://example.com/x');
  assert.equal(res.status, 200);
});

test('retry: 404 returned terminal, no retry', async () => {
  // 4xx (other than 429) is the URL being wrong — retrying won't help.
  let calls = 0;
  globalThis.fetch = async () => { calls++; return fakeResponse(404); };
  const res = await BIDSRecording._fetchWithRetry('https://example.com/x');
  assert.equal(res.status, 404);
  assert.equal(calls, 1, '404 must not be retried');
});

test('retry: 429 IS retried (rate-limit)', async () => {
  globalThis.fetch = mockFetch([
    fakeResponse(429), fakeResponse(429), fakeResponse(200, 'good'),
  ]);
  const res = await BIDSRecording._fetchWithRetry('https://example.com/x');
  assert.equal(res.status, 200);
});

test('retry: network error retried, then thrown after 3 attempts', async () => {
  const netErr = new TypeError('fetch failed');
  globalThis.fetch = mockFetch([netErr, netErr, netErr, netErr]);
  await assert.rejects(
    () => BIDSRecording._fetchWithRetry('https://example.com/x'),
    /fetch failed/,
  );
});

test('retry: network error recovers on 2nd attempt', async () => {
  globalThis.fetch = mockFetch([new TypeError('fetch failed'), fakeResponse(200)]);
  const res = await BIDSRecording._fetchWithRetry('https://example.com/x');
  assert.equal(res.status, 200);
});
```

- [ ] **Step 5: Run the tests**

```bash
node --test tests/unit-network-retry.test.mjs 2>&1 | tail -6
```

Expected: 6 tests pass.

- [ ] **Step 6: Commit**

```bash
git add bids-recording.js tests/unit-network-retry.test.mjs
git commit -m "feat(network): retry helper with exponential backoff on transient errors

fetchWithRetry wraps every fetch() call inside bids-recording.js's
NEMAR + sidecar-walk paths. Retries transient 5xx (502/503/504),
429 rate-limits, and network errors up to 3 times with 200/400/800 ms
backoff. Terminal 4xx returned without retry — the URL is wrong,
retrying won't help.

6 regression tests cover: 200 immediate, 503-then-200, 404 terminal,
429 retried, network-error-thrown-after-3, network-error-recovers."
```

---

## Task 11: topo2d.js — decide and execute (archive)

**Files:**
- Move: `topo2d.js` → `archive/topo2d/topo2d.js`
- Move: `tests/unit-topo2d.test.mjs` → `archive/topo2d/unit-topo2d.test.mjs`
- Modify: `stryker.conf.json` (remove topo2d from mutate + tests command)
- Modify: `docs/mutation-survivors-2026-05.md` (note the archive)

**Why:** topo2d.js was tested but never loaded by `index.html` (janitor F2). 608 LOC of well-tested code that production doesn't instantiate. Two options were valid (wire it in OR archive); product decision is **archive** because (a) wiring needs UX placement work that's out of scope, (b) the work survives in the archive for the future, (c) Stryker's mutate scope stops measuring a file that has no production users.

- [ ] **Step 1: Verify topo2d.js is not imported anywhere live**

```bash
grep -rn "topo2d\|EEGTopo2D\|Topo2D" --include="*.js" --include="*.mjs" --include="*.html" . 2>&1 | \
  grep -v node_modules | grep -v "\.test\.mjs" | grep -v ".claude/worktrees" | head -10
```

Expected: 0 matches outside tests and worktrees. If anything else surfaces, STOP and re-evaluate.

- [ ] **Step 2: Move the files**

```bash
mkdir -p archive/topo2d
git mv topo2d.js archive/topo2d/topo2d.js
git mv tests/unit-topo2d.test.mjs archive/topo2d/unit-topo2d.test.mjs
```

- [ ] **Step 3: Write the archive README**

Write `archive/topo2d/README.md`:

```markdown
# topo2d.js — archived 2026-05-21

This module implements an MNE/EEGLAB-style 2D EEG topographic map
renderer. It has full unit-test coverage (71.29% mutation score at
time of archive) and works as designed when instantiated.

It is archived rather than deleted because production `index.html`
never instantiated `EEGTopo2D` — the wiring is incomplete on the
viewer side (there's no overlay slot, no controller that calls
`Topo2D.init()`). Janitor finding F2 in the 2026-05-20 dead-code
audit flagged this.

## Restoring

If a future PR wires topo2d into the viewer UI:

1. `git mv archive/topo2d/topo2d.js ./topo2d.js`
2. `git mv archive/topo2d/unit-topo2d.test.mjs tests/unit-topo2d.test.mjs`
3. Add `<script src="topo2d.js?v=1"></script>` to `index.html` between
   `traces.js` and `viewer.js`.
4. Add the integration code in viewer.js — minimum: a metadata-overlay
   slot that calls `EEGTopo2D.init(containerEl)` and `setMontage()` /
   `setSelected()` on channel selection.
5. Re-add to `stryker.conf.json`'s mutate list and commandRunner.

The original tests still pass against the archived file:

```bash
node --test archive/topo2d/unit-topo2d.test.mjs
```
```

- [ ] **Step 4: Remove topo2d.js from Stryker**

Edit `stryker.conf.json`. Remove `"topo2d.js"` from the `mutate` array and remove `"tests/unit-topo2d.test.mjs"` from the `commandRunner.command`.

- [ ] **Step 5: Remove the api-surface entry for topo2d.js**

Open `tests/unit-api-surface.test.mjs`. The topo2d entry was already excluded with a comment — verify the comment still makes sense after the archive move; update the comment to reference the archive path.

- [ ] **Step 6: Run full test sweep**

```bash
node --test --test-skip-pattern='rejects URLs that are not BIDS' \
  tests/unit-*.test.mjs tests/prop-*.test.mjs tests/integration-rapid-pan.test.mjs tests/traces.test.mjs 2>&1 | tail -6
```

Expected: tests pass (the archived topo2d test is not picked up by the glob).

- [ ] **Step 7: Run fresh Stryker baseline**

```bash
rm -f reports/stryker-incremental.json
npx stryker run 2>&1 | tee /tmp/stryker-iter12.log | tail -10
```

Expected: aggregate may shift — topo2d's 71.29% was dragging the aggregate UP, so removing it likely lowers the aggregate slightly. Document the new baseline in `docs/mutation-survivors-2026-05.md`.

- [ ] **Step 8: Commit**

```bash
git add archive/topo2d/README.md archive/topo2d/topo2d.js archive/topo2d/unit-topo2d.test.mjs \
        stryker.conf.json tests/unit-api-surface.test.mjs docs/mutation-survivors-2026-05.md
git commit -m "refactor: archive topo2d.js — tested but not wired to index.html (janitor F2)

topo2d.js is moved to archive/topo2d/ along with its unit test. It
had 71.29% mutation score at time of archive but production
index.html never instantiated EEGTopo2D — F2 from the 2026-05-20
janitor dead-code audit.

Stryker mutate scope updated. Aggregate moves from 72.53% → <N>%
(topo2d was dragging it up). New threshold: keep break: 67 unless
the move drops aggregate below 72.

archive/topo2d/README.md documents the restore procedure if a
future PR wires topo2d into the viewer's metadata overlay."
```

Substitute `<N>` with the actual measured score.

---

## Task 12: Worker CANCELLED acknowledgement

**Files:**
- Modify: `worker.js` (post CANCELLED reply when cancellation is honoured)
- Modify: `viewer.js` (handle CANCELLED message — drop pending entry)
- Create: `tests/unit-worker-cancelled-ack.test.mjs`

**Why:** Worker added `CANCEL_REQUEST` handler in commit `2678f4f` — it sets a bit and bails between iterator steps. But the worker doesn't echo CANCELLED back, so the viewer's `pendingRequests` map keeps the entry until garbage collection. Adding a CANCELLED ack lets the viewer clean up immediately.

- [ ] **Step 1: Add CANCELLED post in worker.js**

Edit `worker.js`. Find the `case 'CANCEL_REQUEST':` block (added in `2678f4f`):

```js
case 'CANCEL_REQUEST': {
  if (typeof msg.request_id !== 'undefined') {
    markRequestCancelled(msg.request_id);
    // Echo back so the viewer can immediately drop the pendingRequest
    // entry and free any associated state (callback closures, etc.).
    self.postMessage({ type: 'CANCELLED', request_id: msg.request_id });
  }
  break;
}
```

- [ ] **Step 2: Handle CANCELLED in viewer.js**

Edit `viewer.js`. Find the `worker.onmessage` handler. Add a new case alongside the existing WINDOW / WINDOW_CHUNK / ERROR cases:

```js
case 'CANCELLED': {
  const { request_id } = msg;
  if (pendingRequests.has(request_id)) {
    pendingRequests.delete(request_id);
  }
  // The cancelledRequests set already had this id from when we sent
  // CANCEL_REQUEST; nothing extra to do there.
  break;
}
```

- [ ] **Step 3: Write the round-trip test**

Write `tests/unit-worker-cancelled-ack.test.mjs`:

```js
// Cancellation acknowledgement protocol round-trip.
// The viewer sends CANCEL_REQUEST{id} → worker replies CANCELLED{id}.
// This test exercises the worker side under the self-shim harness.
import './_jsdom-bootstrap.mjs';  // optional — only need globalThis.self
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const recorded = [];
globalThis.self = {
  onmessage: null,
  postMessage(msg) { recorded.push(msg); },
};
globalThis.importScripts = () => {};

require('../formats/_buffers.js');
require('../formats/_http_range.js');
require('../formats/_streaming.js');
require('../formats/_sidecar.js');
require('../formats/_matv5.js');
require('../bids-recording.js');
require('../formats/eeglab.js');
require('../formats/edf.js');
require('../formats/brainvision.js');
require('../formats/fiff.js');
require('../filters.js');
require('../worker.js');

test('worker: CANCEL_REQUEST is echoed as CANCELLED with same request_id', async () => {
  recorded.length = 0;
  await globalThis.self.onmessage({ data: { type: 'CANCEL_REQUEST', request_id: 42 } });
  assert.equal(recorded.length, 1, 'must produce exactly one reply');
  assert.deepEqual(recorded[0], { type: 'CANCELLED', request_id: 42 });
});

test('worker: CANCEL_REQUEST without request_id is silently dropped', async () => {
  recorded.length = 0;
  await globalThis.self.onmessage({ data: { type: 'CANCEL_REQUEST' } });
  assert.equal(recorded.length, 0, 'must not echo when request_id is missing');
});

test('worker: duplicate CANCEL_REQUEST produces a CANCELLED reply each time (idempotent)', async () => {
  recorded.length = 0;
  await globalThis.self.onmessage({ data: { type: 'CANCEL_REQUEST', request_id: 7 } });
  await globalThis.self.onmessage({ data: { type: 'CANCEL_REQUEST', request_id: 7 } });
  // Each request gets its own ack so the viewer's bookkeeping is
  // symmetric. The marker set has FIFO-eviction so this is safe.
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].type, 'CANCELLED');
  assert.equal(recorded[1].type, 'CANCELLED');
});
```

- [ ] **Step 4: Run the tests**

```bash
node --test tests/unit-worker-cancelled-ack.test.mjs 2>&1 | tail -6
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add worker.js viewer.js tests/unit-worker-cancelled-ack.test.mjs
git commit -m "feat(worker): echo CANCELLED ack on CANCEL_REQUEST

Closes the third leg of the cancellation protocol added in 2678f4f.
Sequence:
  viewer → worker: CANCEL_REQUEST{id}
  worker        : mark id cancelled + bail mid-stream
  worker → viewer: CANCELLED{id}                ← NEW
  viewer        : drop pendingRequests entry    ← NEW

Without the ack, viewer's pendingRequests retained the entry until
the worker eventually got around to posting an ERROR (or never, on
some races). Immediate cleanup means no leaked closures.

3 regression tests exercise the worker side under the self-shim:
echo with id, silent drop without id, idempotent on duplicates."
```

---

## Task 13: FIFF raw-data fixture + end-to-end test

**Files:**
- Create: `tests/fixtures/meg/sample_audvis_raw.fif` (~500 KB, BSD-3 from MNE)
- Create: `tests/unit-fiff-raw.test.mjs`
- Modify: `tests/fixtures/eeg/LICENSE-ATTRIBUTION.md` (add the new file)

**Why:** Current FIFF fixtures (events, projections, annotations) parse but have no `raw.data` — `readWindow()` throws by design. Without a real raw-data fixture, the rendering path for MEG is exercise-only through parsing, never through actual sample reading.

- [ ] **Step 1: Identify a suitable fixture**

Use MNE-Python's `test_chpi_raw_sss.fif` (in `mne/io/tests/data/`) — at 13 MB it's the smallest raw-data FIFF file in the MNE test suite. Alternative: trim the file with mne-python locally to a 60-second slice for ~500 KB.

For this task: download `test_chpi_raw_sss.fif` directly. The file is BSD-licensed alongside the rest of MNE-Python.

```bash
curl -sSL -o tests/fixtures/meg/test_chpi_raw_sss.fif \
  "https://raw.githubusercontent.com/mne-tools/mne-python/main/mne/io/tests/data/test_chpi_raw_sss.fif"
ls -lh tests/fixtures/meg/test_chpi_raw_sss.fif
```

Expected: ~13 MB file. If size is unacceptably large for the repo:

- Skip this task and document in `tests/fixtures/eeg/LICENSE-ATTRIBUTION.md` that no small raw-FIFF is available; the rendering path remains untested for MEG.

Alternative — synthesize a minimal raw FIFF with mne-python:

```bash
pip install mne
python -c "
import mne, numpy as np
info = mne.create_info(ch_names=['MEG1', 'MEG2'], sfreq=300, ch_types='mag')
data = np.random.randn(2, 600).astype('float32')
raw = mne.io.RawArray(data, info)
raw.save('tests/fixtures/meg/synth-raw.fif', overwrite=True)
"
ls -lh tests/fixtures/meg/synth-raw.fif
```

Expected: ~20-50 KB file.

- [ ] **Step 2: Verify the fixture parses + has raw data**

```bash
node -e "
globalThis.window = globalThis;
const fs = require('fs');
const r = require('./formats/fiff.js');
const buf = fs.readFileSync('tests/fixtures/meg/synth-raw.fif');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const meas = r.read(ab);
console.log('blocks:', meas.blocks);
console.log('nchan:', meas.nchan);
console.log('sfreq:', meas.sfreq);
console.log('raw:', meas.raw ? 'present (' + meas.raw.data[0].length + ' samples)' : 'NULL');
"
```

Expected: `raw: present (N samples)`. If `raw: NULL`, the fiff.js parser doesn't extract the raw block — that's a separate bug to fix in fiff.js, not here.

- [ ] **Step 3: Write the integration test**

Write `tests/unit-fiff-raw.test.mjs`:

```js
// tests/unit-fiff-raw.test.mjs
//
// End-to-end exercise of the FIFF reader through readWindow() with
// real raw-data bytes. Distinguishes from existing tests/unit-fiff.test.mjs
// which only exercises events/projections/annotations fixtures where
// readWindow() throws by design.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const FIFFReader = require('../formats/fiff.js');

// Mock HttpRange (FIFF reader's network layer).
globalThis.HttpRange = {
  async fetchBuffer(url) {
    const p = url.replace(/^file:\/\//, '');
    const buf = fs.readFileSync(p);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },
};

const RAW_FIXTURE = path.resolve('tests/fixtures/meg/synth-raw.fif');

// All tests below skip if the raw fixture is missing — that's the
// case when Task 13 step 1 ran into license/size issues and skipped
// the fixture download.
const skipIfNoFixture = fs.existsSync(RAW_FIXTURE) ? false : true;

test('fiff raw: open() returns a reader with non-null raw + readable readWindow', { skip: skipIfNoFixture }, async () => {
  const reader = await FIFFReader.open({ eeg_url: 'file://' + RAW_FIXTURE });
  assert.ok(reader.n_channels > 0, 'must have ≥1 channel');
  assert.ok(reader.sampling_frequency > 0, 'must report a sampling frequency');
  assert.ok(reader.n_samples > 0, 'must report a sample count');
  assert.equal(typeof reader.readWindow, 'function');
});

test('fiff raw: readWindow(0, 100) returns nCh Float32Arrays of length 100', { skip: skipIfNoFixture }, async () => {
  const reader = await FIFFReader.open({ eeg_url: 'file://' + RAW_FIXTURE });
  const win = await reader.readWindow(0, 100);
  assert.equal(win.length, reader.n_channels);
  for (let c = 0; c < win.length; c++) {
    assert.ok(win[c] instanceof Float32Array, `channel ${c} must be Float32Array`);
    assert.equal(win[c].length, 100, `channel ${c} must have 100 samples`);
  }
});

test('fiff raw: readWindow at the tail clamps to n_samples', { skip: skipIfNoFixture }, async () => {
  const reader = await FIFFReader.open({ eeg_url: 'file://' + RAW_FIXTURE });
  // Request more than what's available
  const win = await reader.readWindow(reader.n_samples - 10, 1000);
  // Reader should return at most 10 samples
  assert.ok(win[0].length <= 10, `tail clamp: expected ≤10 samples, got ${win[0].length}`);
  assert.ok(win[0].length > 0, 'tail must return at least 1 sample');
});
```

- [ ] **Step 4: Run the tests**

```bash
node --test tests/unit-fiff-raw.test.mjs 2>&1 | tail -8
```

Expected: 3 tests pass (or skip if the fixture wasn't downloaded — but the test still runs without error).

- [ ] **Step 5: Update LICENSE-ATTRIBUTION.md**

Open `tests/fixtures/eeg/LICENSE-ATTRIBUTION.md`. In the inventory table, add a row for the new fixture (synthetic or downloaded). Mention the source + license:

```markdown
| FIFF (raw, synthetic) | MEG | `meg/synth-raw.fif` | ~30 KB | Generated locally with mne-python; BSD-3 by extension | BSD-3 |
```

OR if you downloaded the real file:

```markdown
| FIFF (raw with cHPI) | MEG | `meg/test_chpi_raw_sss.fif` | 13 MB | [mne-tools/mne-python](https://github.com/mne-tools/mne-python) | BSD-3 |
```

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/meg/*.fif tests/unit-fiff-raw.test.mjs tests/fixtures/eeg/LICENSE-ATTRIBUTION.md
git commit -m "test(fiff): raw-data fixture + end-to-end readWindow exercise

First FIFF fixture with an actual FIFFB_RAW_DATA block (the existing
events/proj/annot files have no raw signal). Closes the rendering-path
test gap for MEG.

3 tests cover: open() returns reader with non-null raw + readable
readWindow; readWindow(0, 100) returns nCh × Float32Array[100];
tail clamp at n_samples works as expected.

Fixture source documented in LICENSE-ATTRIBUTION.md."
```

---

## Self-Review

**1. Spec coverage**

| Tier | Item | Task |
|---|---|---|
| 1 | CodSpeed | Task 1 |
| 1 | CD-driven mutation PR | Task 2 |
| 1 | viewer.js mutator scope | Task 3 |
| 1 | worker.js mutator scope | Task 4 |
| 2 | TypeScript/JSDoc | Task 5 |
| 2 | Property tests on render | Task 6 |
| 2 | Lighthouse CI | Task 7 |
| 2 | Streaming memory leak | Task 8 |
| 2 | Cross-browser baselines | Task 9 |
| 2 | Network resilience | Task 10 |
| 3 | topo2d wire-or-archive | Task 11 |
| 3 | Worker CANCELLED ack | Task 12 |
| 3 | FIFF raw fixture | Task 13 |

All 13 items mapped.

**2. Placeholder scan**

- No "TBD" / "implement later" / "similar to Task N" / "add validation" / placeholder code blocks.
- Substitute placeholders for measured values (`<N>%`) are explicit and named.

**3. Type consistency**

- `fetchWithRetry` (Task 10) function signature stable across step 2 and step 4 test.
- `markRequestCancelled` / `isRequestCancelled` (Task 12) reference existing functions from commit `2678f4f`.
- `makeRecordingCanvas` (Task 6) imports from existing `tests/_render-invariants.mjs`.
- `BIDSRecording._fetchWithRetry` exposed-for-test pattern matches existing `BIDSRecording._tokenizePrefix` / `_entityVariants` / `_parseTsv`.

All cross-task references are concrete and match existing or task-defined surfaces.
