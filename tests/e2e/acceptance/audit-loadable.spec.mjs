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
  // Dedupe by cdn_url — the audit JSON can contain the same recording under
  // multiple dataset_id rows (e.g. when a dataset publishes only one canonical
  // file but the catalog walk emits it once per subject). We only need a
  // unique render-target list; Playwright also rejects duplicate test titles.
  const seen = new Set();
  const unique = [];
  for (const r of loadable) {
    if (seen.has(r.cdn_url)) continue;
    seen.add(r.cdn_url);
    unique.push(r);
  }
  return unique;
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
// AUDIT_FULL=1 disables Mulberry32 subsampling so we iterate EVERY loadable
// row in the audit JSON (typically 712 after `node scripts/audit-100-datasets.mjs --full`,
// or ~57 in the 100-sample dev copy). Sort by cdn_url for stable test title
// ordering across runs — Playwright requires unique titles, which the dedupe
// in loadLoadableRows() guarantees, but sorted ordering makes shard
// distribution deterministic when AUDIT_FULL=1.
const CASES = process.env.AUDIT_FULL === '1'
  ? ALL_LOADABLE.slice().sort((a, b) => a.cdn_url.localeCompare(b.cdn_url))
  : subsample(ALL_LOADABLE, SAMPLE_SIZE, SEED);

// Truncate the JSONL sidecar at the START of a fresh `npx playwright test`
// invocation. Playwright may re-evaluate this spec file once per test when it
// re-imports for isolation, so a naive `fs.writeFileSync(RESULTS_JSONL, '')`
// would clobber rows written by previous tests in the same run. Two strategies
// combined:
//   1. In-process: a module-level constant + env-var ensures we truncate at
//      most once per Node process.
//   2. Cross-process: a sentinel file containing the playwright invocation's
//      parent-PID truncates only when the PPID changes (which means a new
//      shell-level `npm run test:audit-reality` invocation).
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

// Per-worker shard selection — only active under AUDIT_FULL because the
// legacy 20-sample mode is serial and the single-file truncate sentinel
// below is its correctness invariant.
const FULL_MODE = process.env.AUDIT_FULL === '1';
const WORKER_INDEX = process.env.TEST_WORKER_INDEX ?? '0';
const RESULTS_JSONL_EFFECTIVE = FULL_MODE
  ? path.join(EVIDENCE_DIR, `results.worker-${WORKER_INDEX}.jsonl`)
  : RESULTS_JSONL;

if (FULL_MODE) {
  // Each worker owns its own shard file. Truncate at most once per worker
  // process. Workers never share files, so no PPID sentinel is needed —
  // a per-process env flag suffices because Playwright re-imports the
  // spec inside the same worker for each test, not across worker boundaries.
  if (!process.env.__AUDIT_SHARD_TRUNCATED__) {
    fs.writeFileSync(RESULTS_JSONL_EFFECTIVE, '');
    process.env.__AUDIT_SHARD_TRUNCATED__ = '1';
  }
} else {
  // Legacy 20-sample path — preserve the parent-PID sentinel exactly as
  // it was (commit 8852a7c). Single file, serial worker, one truncate per
  // outer `npm run test:audit-reality` invocation.
  const TRUNCATE_SENTINEL = path.join(EVIDENCE_DIR, '.last-truncate-ppid');
  const PARENT_PID_KEY = String(process.ppid ?? process.pid);
  const sentinelPpid = fs.existsSync(TRUNCATE_SENTINEL)
    ? fs.readFileSync(TRUNCATE_SENTINEL, 'utf8').trim()
    : '';
  if (!process.env.__AUDIT_RESULTS_TRUNCATED__ && sentinelPpid !== PARENT_PID_KEY) {
    fs.writeFileSync(RESULTS_JSONL, '');
    fs.writeFileSync(TRUNCATE_SENTINEL, PARENT_PID_KEY);
    process.env.__AUDIT_RESULTS_TRUNCATED__ = '1';
  } else if (!process.env.__AUDIT_RESULTS_TRUNCATED__) {
    // Same parent PID = same outer playwright run; do not retruncate even if
    // the module re-evaluates across test isolations.
    process.env.__AUDIT_RESULTS_TRUNCATED__ = '1';
  }
}

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

// The viewer's pill is set via `setPill('pill-format', meta.ext.toUpperCase())`
// (see src/viewer.js). So the expected pill is simply ext.toUpperCase() for
// every supported format. .ds (CTF) is the one exception — the viewer's
// meta.ext may be remapped to 'CTF' or 'MEG4' internally; we record whatever
// the pill shows and only fail on mismatch for the well-known leaf-format
// extensions (set/edf/bdf/vhdr/fif/snirf).
const STRICT_PILL_EXTS = new Set(['set', 'edf', 'bdf', 'vhdr', 'fif', 'snirf']);
function expectedPillFor(ext) {
  if (!ext) return null;
  if (!STRICT_PILL_EXTS.has(ext)) return null; // record-only, no assertion
  return ext.toUpperCase();
}

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
  fs.appendFileSync(RESULTS_JSONL_EFFECTIVE, JSON.stringify(row) + '\n');
  PENDING_RESULTS.delete(testInfo.title);
});

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
      const expectedPill = expectedPillFor(c.ext);
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
