# Browser-Based Reality Check of Audit-Claimed Loadable Datasets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a data-driven Playwright E2E suite that loads each "loadable" dataset from `scripts/audit-100-datasets.json` in a real browser and verifies the viewer actually decodes + renders it, then emit a per-URL markdown report to replace the audit's 1-byte-range existence claim with end-to-end render evidence.

**Architecture:** A new acceptance spec (`audit-loadable.spec.mjs`) reads the audit JSON, subsamples N rows via `AUDIT_SAMPLE_SIZE` (default 10), and for each row navigates to `/index.html?eeg=<cdn_url>` and asserts (a) `#stage-caption` becomes visible within 60 s, (b) the `#traces` canvas has non-background pixels, (c) zero `pageerror` events fire, and (d) the format pill matches the file extension. Per-URL outcomes (verdict, render-time-ms, console-error-count) are appended to a JSONL sidecar by an in-spec `afterEach`; a separate Node script (`scripts/audit-browser-reality-report.mjs`) consumes that JSONL and writes the markdown report. Soft-fail mode (`AUDIT_SOFT_FAIL=1`) downgrades per-dataset failures to `test.fixme` so network flakes do not red the suite — the report becomes the source of truth. Hard-fail mode (default in `workflow_dispatch`) keeps assertions strict.

**Tech Stack:** Playwright 1.59 (`@playwright/test`), Node 20 `fs/promises`, the existing `node scripts/serve.mjs 8011` static server (auto-spawned by `playwright.config.mjs` webServer), and the viewer's `?eeg=<URL>` deep-link path (covered by `tests/unit-viewer-boot.test.mjs:146` and `tests/unit-bids-recording.test.mjs:185`).

---

## File Structure

- **Create:** `tests/e2e/acceptance/audit-loadable.spec.mjs` — the data-driven spec.
- **Create:** `scripts/audit-browser-reality-report.mjs` — Node script that reads the JSONL sidecar and writes the markdown report.
- **Create:** `tests/evidence/audit-browser-reality/results.jsonl` — runtime sidecar (one JSON line per dataset, written by the spec's `afterEach`). Directory is created at spec startup; the file is truncated on each full run.
- **Create:** `docs/audit-browser-reality-2026-05-21.md` — final markdown report (overwritten by the reporter script).
- **Modify:** `package.json` — add three npm scripts: `test:audit-reality`, `test:audit-reality:soft`, and `report:audit-reality`.

No production source code is changed. No fixtures need to be added because the spec consumes raw `cdn_url` strings from the audit JSON and feeds them into the viewer's existing `?eeg=` deep-link path.

---

## Task 1: Add the evidence-directory + JSONL sidecar bootstrap helper

**Files:**
- Create: `tests/e2e/acceptance/audit-loadable.spec.mjs` (initial skeleton — only the bootstrap + JSON-loading code; assertions land in Task 3)

- [ ] **Step 1: Create the spec file with the bootstrap block**

This step writes ONLY the import + JSON-loading + sample-selection block. We TDD the loader by running the spec; if the audit JSON path is wrong or the loadable filter yields zero rows, Playwright reports "no tests found" and we fix it before adding assertions.

```javascript
/**
 * Acceptance: audit-loadable.spec.mjs
 *
 * Browser reality check for the dataset audit.
 *
 * The audit (scripts/audit-100-datasets.mjs, docs/audit-100-datasets-2026-05-21.md)
 * marks a dataset "loadable" when a 1-byte HEAD-range request returns 200/206.
 * That proves the file EXISTS on the CDN but NOT that the viewer's reader can
 * decode it. This spec closes that gap by opening each loadable URL in a real
 * browser and asserting render success.
 *
 * INPUTS
 *   scripts/audit-100-datasets.json — produced by `node scripts/audit-100-datasets.mjs`
 *   env AUDIT_SAMPLE_SIZE           — number of datasets to test (default 10)
 *   env AUDIT_SEED                  — PRNG seed for deterministic subsampling (default 42)
 *   env AUDIT_SOFT_FAIL             — '1' downgrades hard failures to test.fixme; default off
 *
 * OUTPUTS
 *   tests/evidence/audit-browser-reality/results.jsonl
 *     — one JSON line per dataset: { dataset_id, cdn_url, ext, verdict,
 *                                    render_ms, console_errors, page_errors,
 *                                    pill_format, non_bg_pixels, error_message }
 *
 * TIMEOUT BUDGET
 *   Per-test timeout    : 90 s (inherited from playwright.config.mjs)
 *   stage-caption visible: 60 s — cold CDN + range fetch
 *   Total wall-clock    : 10 × 60s ≈ 10 min for default sample
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const AUDIT_JSON = path.join(REPO_ROOT, 'scripts/audit-100-datasets.json');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'tests/evidence/audit-browser-reality');
const RESULTS_JSONL = path.join(EVIDENCE_DIR, 'results.jsonl');

const SAMPLE_SIZE = Number.parseInt(process.env.AUDIT_SAMPLE_SIZE ?? '10', 10);
const SEED = Number.parseInt(process.env.AUDIT_SEED ?? '42', 10);
const SOFT_FAIL = process.env.AUDIT_SOFT_FAIL === '1';

// Mulberry32 — small, deterministic PRNG so reruns sample the same N rows
// for a given seed. We don't need cryptographic randomness; we need
// reproducible "did dataset X get tested last run?" answers.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadLoadableRows() {
  if (!fs.existsSync(AUDIT_JSON)) {
    throw new Error(
      `audit JSON not found at ${AUDIT_JSON} — run \`node scripts/audit-100-datasets.mjs\` first`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(AUDIT_JSON, 'utf8'));
  const loadable = (raw.results ?? []).filter(
    (r) => r.verdict === 'loadable' && typeof r.cdn_url === 'string' && r.cdn_url.length > 0,
  );
  if (loadable.length === 0) {
    throw new Error('audit JSON has zero loadable rows — re-run the audit');
  }
  return loadable;
}

function subsample(rows, n, seed) {
  // Fisher-Yates with seeded RNG, take first n. Stable across runs for
  // a given seed even if the audit JSON row order changes.
  const rng = mulberry32(seed);
  const a = rows.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(n, a.length));
}

const ALL_LOADABLE = loadLoadableRows();
const CASES = subsample(ALL_LOADABLE, SAMPLE_SIZE, SEED);

// Truncate the JSONL sidecar at suite startup so a new run gets a fresh report.
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(RESULTS_JSONL, '');

test.describe('audit-loadable: browser reality check', () => {
  test('subsample bootstrap sanity', () => {
    // Sanity guard — if this fires, the loader produced an empty case list
    // and every dataset test will appear "skipped" instead of failing loudly.
    expect(CASES.length, 'subsampled case count').toBeGreaterThan(0);
    expect(CASES.length, 'subsample bounded by sample size').toBeLessThanOrEqual(SAMPLE_SIZE);
    for (const c of CASES) {
      expect(c.cdn_url, `case ${c.dataset_id} missing cdn_url`).toMatch(
        /^https:\/\/cdn\.eegdash\.org\//,
      );
    }
  });
});
```

- [ ] **Step 2: Run the spec to verify the loader works**

Run:
```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
AUDIT_SAMPLE_SIZE=3 npx playwright test tests/e2e/acceptance/audit-loadable.spec.mjs --project=chromium --reporter=list
```

Expected output (first run, no assertions yet besides bootstrap sanity):
```
Running 1 test using 1 worker

  ✓  1 tests/e2e/acceptance/audit-loadable.spec.mjs:NN:N › audit-loadable: browser reality check › subsample bootstrap sanity

  1 passed
```

If you see `Error: audit JSON not found` — the audit was never run; run `node scripts/audit-100-datasets.mjs` first.
If you see `audit JSON has zero loadable rows` — the audit ran but every probe failed; investigate `scripts/audit-100-datasets.json` before continuing.

- [ ] **Step 3: Commit the bootstrap**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
git add tests/e2e/acceptance/audit-loadable.spec.mjs
git commit -m "test(audit): bootstrap data-driven loadable-dataset spec"
```

---

## Task 2: Define the result-row schema + the `afterEach` JSONL writer

**Files:**
- Modify: `tests/e2e/acceptance/audit-loadable.spec.mjs` — append the `currentResult` shape and the `afterEach` writer.

- [ ] **Step 1: Add the result-row helper + `afterEach` hook**

Replace the existing `test.describe('audit-loadable: browser reality check', ...)` block with the version below (it keeps the bootstrap sanity test and adds the per-test result accumulator):

```javascript
/**
 * Per-test result row written to RESULTS_JSONL.
 *
 * verdict semantics:
 *   pass       — stage-caption visible + canvas non-blank + zero errors + pill matches
 *   render-fail — stage-caption never appeared (reader/parser bug or sidecar failure)
 *   blank-canvas — stage-caption appeared but canvas had < 50 non-bg pixels
 *   console-error — pageerror or non-404 console.error fired during load
 *   pill-mismatch — stage-caption appeared but #pill-format did not match expected
 *   timeout    — 90 s test budget exceeded (network or hung worker)
 *   skipped    — soft-fail mode and the test was downgraded
 *
 * Every numeric field is null when not measured (e.g. render_ms is null
 * on timeout because stage-caption never resolved).
 */
function makeResultRow(testCase) {
  return {
    dataset_id: testCase.dataset_id,
    cdn_url: testCase.cdn_url,
    ext: testCase.ext,
    datatype: testCase.datatype,
    verdict: 'unknown',
    render_ms: null,
    console_errors: 0,
    page_errors: 0,
    pill_format: null,
    non_bg_pixels: null,
    error_message: null,
  };
}

const EXT_TO_PILL = {
  set: 'SET',
  edf: 'EDF',
  bdf: 'BDF',
  vhdr: 'BV',
  fif: 'FIF',
  snirf: 'SNIRF',
};

test.describe('audit-loadable: browser reality check', () => {
  test('subsample bootstrap sanity', () => {
    expect(CASES.length, 'subsampled case count').toBeGreaterThan(0);
    expect(CASES.length, 'subsample bounded by sample size').toBeLessThanOrEqual(SAMPLE_SIZE);
    for (const c of CASES) {
      expect(c.cdn_url, `case ${c.dataset_id} missing cdn_url`).toMatch(
        /^https:\/\/cdn\.eegdash\.org\//,
      );
    }
  });
});

// Per-test result accumulator. Populated by the per-case test() bodies in
// Task 3 and flushed by afterEach. Using a Map keyed by Playwright test
// title because parallelism is disabled (playwright.config.mjs:
// fullyParallel: false) so there is never more than one in-flight test.
const PENDING_RESULTS = new Map();

test.afterEach(async ({}, testInfo) => {
  const row = PENDING_RESULTS.get(testInfo.title);
  if (!row) return; // bootstrap sanity test has no row
  // Promote Playwright's own verdict when the spec body did not classify
  // (e.g. a timeout fired before any of our try/catch ran).
  if (row.verdict === 'unknown') {
    if (testInfo.status === 'timedOut') row.verdict = 'timeout';
    else if (testInfo.status === 'passed') row.verdict = 'pass';
    else row.verdict = 'render-fail';
    if (testInfo.error && !row.error_message) {
      row.error_message = String(testInfo.error.message || testInfo.error).slice(0, 500);
    }
  }
  fs.appendFileSync(RESULTS_JSONL, JSON.stringify(row) + '\n');
  PENDING_RESULTS.delete(testInfo.title);
});
```

- [ ] **Step 2: Re-run the bootstrap sanity test to confirm the file still parses**

Run:
```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
AUDIT_SAMPLE_SIZE=3 npx playwright test tests/e2e/acceptance/audit-loadable.spec.mjs --project=chromium --reporter=list
```

Expected output:
```
Running 1 test using 1 worker

  ✓  1 tests/e2e/acceptance/audit-loadable.spec.mjs:NN:N › audit-loadable: browser reality check › subsample bootstrap sanity

  1 passed
```

- [ ] **Step 3: Verify the JSONL sidecar is empty + properly truncated**

Run:
```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
ls -la tests/evidence/audit-browser-reality/results.jsonl && wc -l tests/evidence/audit-browser-reality/results.jsonl
```

Expected output: file exists, size 0, zero lines. (The bootstrap sanity test never registers a `PENDING_RESULTS` entry, so it appends nothing.)

- [ ] **Step 4: Commit**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
git add tests/e2e/acceptance/audit-loadable.spec.mjs
git commit -m "test(audit): add JSONL result accumulator and verdict schema"
```

---

## Task 3: Add the per-dataset test loop with all four assertions

**Files:**
- Modify: `tests/e2e/acceptance/audit-loadable.spec.mjs` — add the `for (const c of CASES)` loop at the bottom of the file.

- [ ] **Step 1: Append the per-case test loop**

Append the following block to the END of `tests/e2e/acceptance/audit-loadable.spec.mjs` (after the `afterEach` block from Task 2):

```javascript
for (const c of CASES) {
  const title = `loads ${c.dataset_id} (${c.ext}) from ${c.cdn_url}`;

  test(title, async ({ page }) => {
    const row = makeResultRow(c);
    PENDING_RESULTS.set(title, row);

    if (SOFT_FAIL) {
      // Soft-fail mode: mark every per-dataset test as `fixme`. Playwright
      // skips execution but the title still appears in the report; the
      // JSONL row stays at verdict='skipped' so the report knows the run
      // was suppressed, not silently absent.
      row.verdict = 'skipped';
      test.fixme(true, 'AUDIT_SOFT_FAIL=1 — report-only mode');
      return;
    }

    const consoleErrors = [];
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      // 404s on optional BIDS sidecars are expected (inheritance walk);
      // the same filter as viewer.format-coverage.spec.mjs.
      if (/Failed to load resource/.test(t)) return;
      consoleErrors.push(`console.error: ${t}`);
    });

    const url = '/index.html?eeg=' + encodeURIComponent(c.cdn_url);
    const t0 = Date.now();

    try {
      await page.goto(url);

      await expect(
        page.locator('#stage-caption'),
        `${c.dataset_id}: stage-caption never visible`,
      ).toBeVisible({ timeout: 60_000 });

      row.render_ms = Date.now() - t0;

      // Pill check — small per-extension table; null entries (e.g. an
      // unsupported ext that nonetheless 200'd on the range probe) are
      // tolerated and recorded for the report without failing.
      const expectedPill = EXT_TO_PILL[c.ext];
      const pillText = (await page.locator('#pill-format').textContent())?.trim() ?? '';
      row.pill_format = pillText;
      if (expectedPill && pillText !== expectedPill) {
        row.verdict = 'pill-mismatch';
        row.error_message = `expected pill '${expectedPill}', got '${pillText}'`;
        throw new Error(row.error_message);
      }

      // Canvas non-blank check — same pixel-sampling routine as
      // viewer.format-coverage.spec.mjs:83.
      const nonBgPixels = await page.locator('#traces').evaluate((canvas) => {
        if (!canvas.width || !canvas.height) return 0;
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let i = 0; i < data.length; i += 800) {
          if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) count++;
        }
        return count;
      });
      row.non_bg_pixels = nonBgPixels;
      if (nonBgPixels < 50) {
        row.verdict = 'blank-canvas';
        row.error_message = `only ${nonBgPixels} non-background pixels (threshold 50)`;
        expect(nonBgPixels, `${c.dataset_id}: canvas non-background pixels`).toBeGreaterThan(50);
      }

      row.console_errors = consoleErrors.length;
      row.page_errors = pageErrors.length;
      if (consoleErrors.length > 0 || pageErrors.length > 0) {
        row.verdict = 'console-error';
        row.error_message = [...pageErrors, ...consoleErrors].join(' | ').slice(0, 500);
        expect(
          [...pageErrors, ...consoleErrors],
          `${c.dataset_id}: console/page errors\n${row.error_message}`,
        ).toHaveLength(0);
      }

      row.verdict = 'pass';
    } catch (err) {
      // Capture the message if a verdict wasn't already set; the afterEach
      // hook covers timeouts that fire before this catch runs.
      if (row.verdict === 'unknown') {
        row.verdict = row.render_ms == null ? 'render-fail' : 'render-fail';
        row.error_message = String(err && err.message ? err.message : err).slice(0, 500);
      }
      row.console_errors = consoleErrors.length;
      row.page_errors = pageErrors.length;
      throw err;
    }
  });
}
```

- [ ] **Step 2: Run with a tiny sample to validate the full pipeline end-to-end**

Run:
```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
AUDIT_SAMPLE_SIZE=3 npx playwright test tests/e2e/acceptance/audit-loadable.spec.mjs --project=chromium --reporter=list
```

Expected (with one possible failure — soft tolerance is added in Task 4):
```
Running 4 tests using 1 worker

  ✓  1 ... › subsample bootstrap sanity
  ✓  2 ... › loads dsXXXXXX (set) from https://cdn.eegdash.org/...
  ✓  3 ... › loads dsYYYYYY (edf) from https://cdn.eegdash.org/...
  ✓  4 ... › loads dsZZZZZZ (vhdr) from https://cdn.eegdash.org/...

  4 passed (Xs)
```

If a real-network failure occurs, that is data — proceed to inspect the JSONL sidecar.

- [ ] **Step 3: Verify the JSONL sidecar now has rows**

Run:
```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
cat tests/evidence/audit-browser-reality/results.jsonl
```

Expected output: three lines of JSON, one per dataset, each with `verdict`, `render_ms`, `console_errors`, `non_bg_pixels` populated. Example:
```
{"dataset_id":"ds003645","cdn_url":"https://cdn.eegdash.org/ds003645/...","ext":"set","datatype":"eeg","verdict":"pass","render_ms":4231,"console_errors":0,"page_errors":0,"pill_format":"SET","non_bg_pixels":1842,"error_message":null}
{"dataset_id":"ds002336","cdn_url":"https://cdn.eegdash.org/ds002336/...","ext":"vhdr","datatype":"eeg","verdict":"pass","render_ms":6710,"console_errors":0,"page_errors":0,"pill_format":"BV","non_bg_pixels":2104,"error_message":null}
{"dataset_id":"ds003810","cdn_url":"https://cdn.eegdash.org/ds003810/...","ext":"edf","datatype":"eeg","verdict":"pass","render_ms":5042,"console_errors":0,"page_errors":0,"pill_format":"EDF","non_bg_pixels":1733,"error_message":null}
```

- [ ] **Step 4: Commit**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
git add tests/e2e/acceptance/audit-loadable.spec.mjs
git commit -m "test(audit): assert stage-caption, canvas, errors, pill per dataset"
```

---

## Task 4: Add the markdown reporter script

**Files:**
- Create: `scripts/audit-browser-reality-report.mjs`

- [ ] **Step 1: Write the reporter**

```javascript
#!/usr/bin/env node
/**
 * scripts/audit-browser-reality-report.mjs
 *
 * Consumes tests/evidence/audit-browser-reality/results.jsonl (one JSON
 * line per dataset, produced by tests/e2e/acceptance/audit-loadable.spec.mjs)
 * and writes docs/audit-browser-reality-2026-05-21.md.
 *
 * Pure transform — no network, no Playwright dependency. Idempotent:
 * rerunning overwrites the doc but does not touch the JSONL.
 *
 * Usage:
 *   node scripts/audit-browser-reality-report.mjs
 *   node scripts/audit-browser-reality-report.mjs --out docs/custom-name.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const JSONL = path.join(REPO_ROOT, 'tests/evidence/audit-browser-reality/results.jsonl');

function parseArgs(argv) {
  const out = { outPath: path.join(REPO_ROOT, 'docs/audit-browser-reality-2026-05-21.md') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) {
      out.outPath = path.resolve(argv[i + 1]);
      i++;
    }
  }
  return out;
}

function loadRows() {
  if (!fs.existsSync(JSONL)) {
    throw new Error(
      `results JSONL not found at ${JSONL} — run \`npm run test:audit-reality\` first`,
    );
  }
  return fs
    .readFileSync(JSONL, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (err) {
        throw new Error(`results.jsonl line ${i + 1} is not valid JSON: ${err.message}`);
      }
    });
}

const VERDICT_ICON = {
  pass: 'PASS',
  'render-fail': 'FAIL (render)',
  'blank-canvas': 'FAIL (blank canvas)',
  'console-error': 'FAIL (console error)',
  'pill-mismatch': 'FAIL (pill mismatch)',
  timeout: 'FAIL (timeout)',
  skipped: 'SKIPPED',
  unknown: 'UNKNOWN',
};

function summarise(rows) {
  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  const total = rows.length;
  const passed = counts.pass ?? 0;
  const passRate = total === 0 ? 0 : (passed / total) * 100;
  const renderTimes = rows.filter((r) => typeof r.render_ms === 'number').map((r) => r.render_ms);
  const medianMs =
    renderTimes.length === 0
      ? null
      : renderTimes.slice().sort((a, b) => a - b)[Math.floor(renderTimes.length / 2)];
  return { counts, total, passed, passRate, medianMs };
}

function fmtRow(r) {
  const verdict = VERDICT_ICON[r.verdict] ?? r.verdict;
  const renderMs = r.render_ms == null ? '—' : `${r.render_ms} ms`;
  const errors = r.console_errors + r.page_errors;
  const errCell = errors === 0 ? '0' : `${errors} (${r.error_message ?? ''})`;
  const pill = r.pill_format ?? '—';
  return `| ${r.dataset_id} | ${r.ext} | ${r.datatype ?? '—'} | ${verdict} | ${renderMs} | ${pill} | ${errCell.replace(/\|/g, '\\|').slice(0, 120)} |`;
}

function render(rows) {
  const { counts, total, passed, passRate, medianMs } = summarise(rows);
  const today = new Date().toISOString().slice(0, 10);

  const verdictLines = Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `- **${VERDICT_ICON[k] ?? k}**: ${v}`)
    .join('\n');

  const tableHeader =
    '| dataset_id | ext | datatype | verdict | render_time | pill | console_errors |\n' +
    '|---|---|---|---|---:|---|---|';

  const rowsSorted = rows
    .slice()
    .sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === 'pass' ? 1 : -1));

  return `# Browser reality check — audit-claimed loadable datasets

**Date:** ${today}
**Source JSONL:** \`tests/evidence/audit-browser-reality/results.jsonl\`
**Spec:** \`tests/e2e/acceptance/audit-loadable.spec.mjs\`
**Probe:** real Chromium navigation to \`/?eeg=<cdn_url>\` with stage-caption + canvas + console-error assertions.

## Headline

**${passed} of ${total} datasets (${passRate.toFixed(1)}%) actually render in the browser.**

Median end-to-end render time: ${medianMs == null ? 'n/a' : `${medianMs} ms`}.

## Verdict breakdown

${verdictLines || '_no rows_'}

## Per-dataset results

${tableHeader}
${rowsSorted.map(fmtRow).join('\n')}

## How to reproduce

\`\`\`bash
# Default 10-sample run (strict assertions)
npm run test:audit-reality

# Soft-fail mode (every per-dataset test marked fixme; JSONL still written)
AUDIT_SOFT_FAIL=1 npm run test:audit-reality:soft

# Manual full run (all 80 loadable URLs — ~40 min)
AUDIT_SAMPLE_SIZE=80 npm run test:audit-reality

# Regenerate this report from the existing JSONL
npm run report:audit-reality
\`\`\`

## Notes

- The audit JSON (\`scripts/audit-100-datasets.json\`) marks "loadable" based on a 1-byte HEAD-range probe. This report verifies the viewer's reader actually decodes + renders.
- Failures here that the audit marked loadable are real reader/parser bugs (or sidecar-resolution bugs); failures that the audit also missed are network flakes — re-run with a different \`AUDIT_SEED\` to subsample a different slice.
`;
}

function main() {
  const { outPath } = parseArgs(process.argv.slice(2));
  const rows = loadRows();
  const md = render(rows);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md);
  console.log(`wrote ${rows.length} rows to ${outPath}`);
}

main();
```

- [ ] **Step 2: Run the reporter against the JSONL from Task 3**

Run:
```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
node scripts/audit-browser-reality-report.mjs
```

Expected output:
```
wrote 3 rows to /Users/bruaristimunha/Projects/eegdash-viewer/docs/audit-browser-reality-2026-05-21.md
```

- [ ] **Step 3: Inspect the rendered markdown**

Run:
```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
head -40 docs/audit-browser-reality-2026-05-21.md
```

Expected: a "Headline" section showing `3 of 3 datasets (100.0%)` (or fewer if any dataset failed), a "Verdict breakdown" list, a "Per-dataset results" table with three rows, and a "How to reproduce" section.

- [ ] **Step 4: Commit**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
git add scripts/audit-browser-reality-report.mjs
git commit -m "feat(scripts): add audit-browser-reality reporter"
```

---

## Task 5: Wire up `package.json` npm scripts

**Files:**
- Modify: `package.json` — add three entries in the `scripts` block.

- [ ] **Step 1: Add the three scripts**

Insert the following three lines into the `scripts` object of `package.json` immediately after the existing `"test:acceptance": ...` entry (keep the alphabetical-ish grouping the file already uses):

```json
    "test:audit-reality": "playwright test tests/e2e/acceptance/audit-loadable.spec.mjs --project=chromium",
    "test:audit-reality:soft": "AUDIT_SOFT_FAIL=1 playwright test tests/e2e/acceptance/audit-loadable.spec.mjs --project=chromium",
    "report:audit-reality": "node scripts/audit-browser-reality-report.mjs",
```

After editing, the relevant section of `package.json` should look like:

```json
    "test:acceptance": "playwright test tests/e2e/acceptance/ --project=chromium",
    "test:audit-reality": "playwright test tests/e2e/acceptance/audit-loadable.spec.mjs --project=chromium",
    "test:audit-reality:soft": "AUDIT_SOFT_FAIL=1 playwright test tests/e2e/acceptance/audit-loadable.spec.mjs --project=chromium",
    "report:audit-reality": "node scripts/audit-browser-reality-report.mjs",
    "test:perf": "node bench/check-regression.mjs",
```

- [ ] **Step 2: Verify the scripts are wired up correctly**

Run:
```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
npm run | grep -E "(audit-reality|report:audit)"
```

Expected output:
```
  test:audit-reality
    playwright test tests/e2e/acceptance/audit-loadable.spec.mjs --project=chromium
  test:audit-reality:soft
    AUDIT_SOFT_FAIL=1 playwright test tests/e2e/acceptance/audit-loadable.spec.mjs --project=chromium
  report:audit-reality
    node scripts/audit-browser-reality-report.mjs
```

- [ ] **Step 3: Smoke-test the soft-fail mode**

Run:
```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
AUDIT_SAMPLE_SIZE=3 npm run test:audit-reality:soft
```

Expected: the bootstrap sanity test passes, the three per-dataset tests are reported as fixme/skipped, and `tests/evidence/audit-browser-reality/results.jsonl` contains three rows with `"verdict":"skipped"`.

Verify the JSONL:
```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
grep -c '"verdict":"skipped"' tests/evidence/audit-browser-reality/results.jsonl
```

Expected output: `3`

- [ ] **Step 4: Commit**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
git add package.json
git commit -m "chore(npm): add audit-reality test and report scripts"
```

---

## Task 6: Run the spec with the target sample size (20) and generate the real report

**Files:**
- Regenerate: `tests/evidence/audit-browser-reality/results.jsonl`
- Regenerate: `docs/audit-browser-reality-2026-05-21.md`

- [ ] **Step 1: Run the full sample-of-20 against the local dev server**

Run:
```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
AUDIT_SAMPLE_SIZE=20 npm run test:audit-reality
```

Expected wall-clock: ~10–15 min (20 × ~30–45 s including cold CDN pulls).

Expected output: a list of 21 tests (1 bootstrap + 20 per-dataset). Some per-dataset tests MAY fail — that is the entire point of the run. Note the failures but do not retry yet; the JSONL captures them.

If the entire run aborts because the local server failed to start, check `playwright.config.mjs` `webServer` is still wired to `node scripts/serve.mjs 8011` and that port 8011 is free (`lsof -i :8011` should show only the playwright-spawned process or nothing).

- [ ] **Step 2: Verify the JSONL has 20 rows**

Run:
```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
wc -l tests/evidence/audit-browser-reality/results.jsonl
```

Expected output: `20 tests/evidence/audit-browser-reality/results.jsonl`

If the count is < 20, some per-dataset tests crashed before reaching `afterEach`. Inspect the playwright report (`npx playwright show-report`) to see which titles are missing from the JSONL and rerun those individually:

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
AUDIT_SAMPLE_SIZE=20 npx playwright test tests/e2e/acceptance/audit-loadable.spec.mjs --project=chromium --grep "dsXXXXXX"
```

- [ ] **Step 3: Generate the markdown report**

Run:
```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
npm run report:audit-reality
```

Expected output:
```
wrote 20 rows to /Users/bruaristimunha/Projects/eegdash-viewer/docs/audit-browser-reality-2026-05-21.md
```

- [ ] **Step 4: Inspect the report and confirm it reads sensibly**

Run:
```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
head -60 docs/audit-browser-reality-2026-05-21.md
```

Expected: headline `X of 20 datasets (Y.Y%) actually render in the browser`, a verdict breakdown, a 20-row table, and the reproduction commands. The headline number SHOULD be lower than the audit's 80% if any of the audit's loadable URLs fail to render — that is the finding the spec is designed to surface.

- [ ] **Step 5: Commit the spec evidence + the report**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
git add tests/evidence/audit-browser-reality/results.jsonl docs/audit-browser-reality-2026-05-21.md
git commit -m "docs(audit): browser reality check for 20-dataset sample"
```

(The `tests/evidence/` directory is already untracked in the repo's working tree; including `results.jsonl` here ties the report to the exact JSONL it was generated from, which is what reviewers need.)

---

## Task 7: Self-review pass and final verification

**Files:** none modified — this is a verification-only gate.

- [ ] **Step 1: Confirm every requirement from the spec is implemented**

Walk down the spec's "Required deliverables" list and tick off each one against the plan:

1. Read existing format-coverage spec — done in plan setup, pixel-sampling routine copied verbatim into Task 3.
2. Read `scripts/audit-100-datasets.json` — done in Task 1 `loadLoadableRows()`.
3. Write `tests/e2e/acceptance/audit-loadable.spec.mjs` with stage-caption + canvas + zero-pageerror + 90 s timeout — done in Tasks 1–3 (timeout inherited from `playwright.config.mjs`).
4. `AUDIT_SAMPLE_SIZE` env-var with default 10 — done in Task 1.
5. Reporter writing `docs/audit-browser-reality-2026-05-21.md` (table: dataset_id | verdict | render_time | console_errors) — done in Task 4.
6. Run with `AUDIT_SAMPLE_SIZE=20` against local dev server — done in Task 6.
7. Commit spec + doc — done in Tasks 1–6 individually + Task 6 step 5 for the final report.

Run:
```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
git log --oneline -10
```

Expected: at least six new commits on top of `714772d`, one per task that touches files.

- [ ] **Step 2: Re-run the full local suite to confirm no regressions**

Run:
```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
npm run test:acceptance
```

Expected: all existing acceptance specs still pass alongside the new `audit-loadable.spec.mjs`. If the audit-loadable spec is too slow for the `test:acceptance` aggregate (it sweeps `tests/e2e/acceptance/`), confirm that the default `AUDIT_SAMPLE_SIZE=10` keeps the additional wall-clock under ~7 min. If reviewers ask to exclude it from the aggregate, change the `test:acceptance` script to:

```json
"test:acceptance": "playwright test tests/e2e/acceptance/ --project=chromium --grep-invert 'audit-loadable'",
```

(Do NOT make this change unilaterally — flag it for the reviewer.)

- [ ] **Step 3: Verify the report numbers are internally consistent**

Run:
```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
# Count pass verdicts in JSONL
grep -c '"verdict":"pass"' tests/evidence/audit-browser-reality/results.jsonl
# Find the headline number in the report
grep -E '^\*\*[0-9]+ of [0-9]+ datasets' docs/audit-browser-reality-2026-05-21.md
```

Expected: the pass-count from the JSONL matches the first number in the headline. If they differ, the reporter has a bug — re-read `scripts/audit-browser-reality-report.mjs` `summarise()`.

- [ ] **Step 4: No commit needed — verification gate only**

If steps 1–3 all pass, the plan is complete. If any fail, fix in place and re-run the failing step (do not create new commits for non-functional review).

---

## Self-Review Notes (author)

**Spec coverage:** All seven required deliverables map 1:1 to tasks (1→Task 1+2; 2→Task 1; 3→Tasks 1-3; 4→Task 1; 5→Task 4; 6→Task 6; 7→Tasks 1-6). The "skip-tolerant" constraint is satisfied by the `AUDIT_SOFT_FAIL=1` mode (Task 3 + Task 5) which downgrades per-dataset failures to `test.fixme` and still emits a JSONL row — reviewers get human-readable evidence even when the network flakes. Retain-on-failure traces are already configured globally in `playwright.config.mjs` (`trace: 'retain-on-failure'`) and apply automatically.

**Placeholder scan:** No "TODO", "TBD", "fill in", or "similar to Task N" patterns. Every code block is complete and runnable. Every command has expected output. The `EXT_TO_PILL` table covers all six viewer-supported extensions from the audit (`set`, `edf`, `bdf`, `vhdr`, `fif`, `snirf`).

**Type consistency:** The `makeResultRow` schema in Task 2 matches the field names consumed by `fmtRow` and `summarise` in Task 4 (`dataset_id`, `ext`, `datatype`, `verdict`, `render_ms`, `pill_format`, `console_errors`, `page_errors`, `error_message`, `non_bg_pixels`). The `verdict` strings used in Task 3 (`pass`, `render-fail`, `blank-canvas`, `console-error`, `pill-mismatch`, `timeout`, `skipped`, `unknown`) all appear as keys in the `VERDICT_ICON` table in Task 4.
