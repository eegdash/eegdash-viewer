# 800-Dataset Full Browser Reality-Check Audit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "18/20 on a Mulberry32-seeded subsample" headline with a definitive "N of 712 loadable URLs actually render in a real browser" headline, broken down into 6 failure-mode bins (CTF-residual, FIFF-large, EEGLAB-large, EEGLAB-v7.3-renamed-fdt, network-flake, timeout-cold-cdn, unknown).

**Architecture:** Re-enable per-spec Playwright parallelism (4 workers) on the existing `audit-loadable.spec.mjs` while preserving the JSONL sidecar correctness via per-worker shard files merged at the end. Add a new `AUDIT_FULL=1` env that bypasses Mulberry32 subsampling and iterates every loadable row in `scripts/audit-100-datasets.json` (currently 712 in the 800-dataset full audit, ~57 in the 100-sample dev copy). A new `scripts/audit-failure-classifier.mjs` bins the JSONL failures by regex-matching the existing `error_message`, `ext`, and `console_errors` fields. A new `scripts/audit-browser-reality-full-report.mjs` emits the final markdown with the headline + classification tables + per-dataset appendix.

**Tech Stack:** Playwright 1.59 (`@playwright/test`) with project-level `workers: 4` + `fullyParallel: true` override; Node 20 `fs/promises`; the existing `node scripts/serve.mjs 8011` static server (auto-spawned by `playwright.config.mjs` webServer); the existing `scripts/audit-100-datasets.json` produced by `node scripts/audit-100-datasets.mjs --full`.

---

## File Structure

- **Create:** `playwright.audit-full.config.mjs` — config override that imports the base config and enables 4-worker parallelism + a per-worker JSONL shard directory. Keeps the base config's `fullyParallel: false` (which the truncate-on-load sentinel in `audit-loadable.spec.mjs` lines 112-126 depends on for all *other* specs) untouched.
- **Modify:** `tests/e2e/acceptance/audit-loadable.spec.mjs` — add `AUDIT_FULL=1` branch that skips the Mulberry32 subsample and iterates all loadable rows; write to a per-worker JSONL shard when `process.env.TEST_WORKER_INDEX` is set instead of the single `results.jsonl`.
- **Create:** `scripts/audit-merge-shards.mjs` — pure Node script that globs `tests/evidence/audit-browser-reality/results.worker-*.jsonl` and concatenates them into `tests/evidence/audit-browser-reality/results-full.jsonl` deterministically (sorted by dataset_id then cdn_url for stable diffs).
- **Create:** `scripts/audit-failure-classifier.mjs` — pure Node script that reads the merged JSONL and emits a per-row `failure_class` field into `tests/evidence/audit-browser-reality/results-classified.jsonl`. Seven bins, regex-based.
- **Create:** `scripts/audit-browser-reality-full-report.mjs` — pure Node script that reads the classified JSONL and writes `docs/audit-browser-reality-full-2026-05-21.md` with the headline + 6 classification tables + top-10-surprising appendix + sortable per-dataset appendix + self-comparison vs the 20-sample baseline (`docs/audit-browser-reality-2026-05-21.md`).
- **Modify:** `package.json` — add `test:audit-reality:full`, `merge:audit-shards`, `classify:audit-failures`, `report:audit-reality:full`.
- **Create:** `tests/evidence/audit-browser-reality/results-full.jsonl` — runtime output (merged shards, gitignored except in evidence directory if convention allows; written by Task 5).
- **Create:** `tests/evidence/audit-browser-reality/results-classified.jsonl` — runtime output (classified rows, written by Task 6).
- **Create:** `docs/audit-browser-reality-full-2026-05-21.md` — final report (written by Task 7).

No production source code under `src/` is changed. No fixtures are added. The viewer's `?eeg=<URL>` deep-link path (the same path the 20-sample run exercises) is the only production behaviour under test.

---

## Task 1: Add the 4-worker config override + per-worker JSONL shard support

**Files:**
- Create: `playwright.audit-full.config.mjs`
- Modify: `tests/e2e/acceptance/audit-loadable.spec.mjs` (lines 112-126 — replace the single-file truncate block with a per-worker-shard branch)

- [ ] **Step 1: Create the override config**

The base `playwright.config.mjs` has `fullyParallel: false` because the truncate-on-load sentinel in `audit-loadable.spec.mjs` relies on the spec being re-evaluated in a single Node process. We override only for the full-audit run by pointing Playwright at a separate config file that enables `fullyParallel: true` + `workers: 4`. The base config is imported and spread so any future change there (timeout, webServer, devices) automatically flows through.

```javascript
// playwright.audit-full.config.mjs
//
// Override config used ONLY by `npm run test:audit-reality:full`. The base
// config (playwright.config.mjs) keeps fullyParallel:false because most specs
// share the truncate-on-load sentinel in audit-loadable.spec.mjs. For the
// 712-dataset full run we re-enable parallelism (4 workers, ~3 hours →
// ~50 min wall) and switch the spec to per-worker JSONL shards so writes
// never race.
import { defineConfig } from '@playwright/test';
import base from './playwright.config.mjs';

export default defineConfig({
  ...base,
  fullyParallel: true,
  workers: 4,
  // 712 × ~15 s budget per test = ~3 h serial → ~50 min wall at 4 workers.
  // No per-test timeout change: the existing 90 s budget already covers the
  // cold-CDN 60 s stage-caption deadline.
  reporter: [
    ['list'],
    ['json', { outputFile: 'tests/evidence/audit-browser-reality/playwright-full.json' }],
  ],
});
```

- [ ] **Step 2: Replace the spec's truncate block with per-worker shards**

The current block (lines 112-126) truncates a single `results.jsonl` per parent-PID. With 4 workers all writing to that one file we would lose rows under append-race. Switch to one JSONL per worker; Task 5 merges them. When `AUDIT_FULL` is unset (the legacy 20-sample path), keep the existing single-file behaviour so we don't break `npm run test:audit-reality`.

Replace lines 112-126 of `tests/e2e/acceptance/audit-loadable.spec.mjs` (the truncate-sentinel block — read the file to confirm exact line numbers before editing) with:

```javascript
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
    process.env.__AUDIT_RESULTS_TRUNCATED__ = '1';
  }
}
```

And change the `afterEach` flush (currently `fs.appendFileSync(RESULTS_JSONL, …)` on line 203) to use `RESULTS_JSONL_EFFECTIVE`:

```javascript
test.afterEach(async ({}, testInfo) => {
  const row = PENDING_RESULTS.get(testInfo.title);
  if (!row) return;
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
```

- [ ] **Step 3: Smoke-run the spec under the override config without AUDIT_FULL to verify the legacy path still works**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
AUDIT_SAMPLE_SIZE=3 npx playwright test --config=playwright.audit-full.config.mjs tests/e2e/acceptance/audit-loadable.spec.mjs
```

Expected: 3 per-dataset tests run + 1 bootstrap sanity test, all PASS. A single `tests/evidence/audit-browser-reality/results.jsonl` is written (NOT the per-worker shards, because `AUDIT_FULL` is unset). `results.worker-*.jsonl` does NOT appear.

If the test fails: the most likely cause is that the truncate-sentinel branch broke the legacy path. Revert and rewrite the block, keeping the legacy `RESULTS_JSONL` write site identical to commit 8852a7c.

- [ ] **Step 4: Smoke-run with AUDIT_FULL=1 + tiny sample to verify shards appear**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
rm -f tests/evidence/audit-browser-reality/results.worker-*.jsonl
AUDIT_FULL=1 AUDIT_SAMPLE_SIZE=4 npx playwright test --config=playwright.audit-full.config.mjs tests/e2e/acceptance/audit-loadable.spec.mjs
ls tests/evidence/audit-browser-reality/results.worker-*.jsonl
```

Expected: 4 per-dataset tests run, distributed across up to 4 workers. `ls` shows between 1 and 4 `results.worker-N.jsonl` files (depending on how Playwright distributed the load). Each shard contains 0-4 JSON lines, summing to exactly 4. `results.jsonl` is NOT touched.

If only one worker file appears: Playwright may have decided 4 tests fit in 1 worker; raise `AUDIT_SAMPLE_SIZE` to 12 and re-verify. Note: Task 2 will add the `AUDIT_FULL` branch that ignores `AUDIT_SAMPLE_SIZE`; until Task 2 lands, `AUDIT_SAMPLE_SIZE` still controls the iteration count.

- [ ] **Step 5: Commit**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
git add playwright.audit-full.config.mjs tests/e2e/acceptance/audit-loadable.spec.mjs
git commit -m "test(audit): add 4-worker config override + per-worker JSONL shards for full mode"
```

---

## Task 2: Add the `AUDIT_FULL=1` branch that bypasses subsampling

**Files:**
- Modify: `tests/e2e/acceptance/audit-loadable.spec.mjs` (lines 99-100 — the `ALL_LOADABLE` / `CASES` assignment)

- [ ] **Step 1: Replace the subsample call with a conditional**

The current lines 99-100 are:

```javascript
const ALL_LOADABLE = loadLoadableRows();
const CASES = subsample(ALL_LOADABLE, SAMPLE_SIZE, SEED);
```

Replace with:

```javascript
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
```

- [ ] **Step 2: Smoke-run with `AUDIT_FULL=1` against the dev-copy 100-sample audit JSON**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
rm -f tests/evidence/audit-browser-reality/results.worker-*.jsonl
AUDIT_FULL=1 npx playwright test --config=playwright.audit-full.config.mjs tests/e2e/acceptance/audit-loadable.spec.mjs --list | head -10
```

Expected output starts with: `Listing tests:` then enumerates ~57 tests (matches `Unique URLs: 57` from the dev-copy audit JSON; see `node -e "const j=require('./scripts/audit-100-datasets.json'); const r=j.results.filter(x=>x.verdict==='loadable'); const u=new Set(r.map(x=>x.cdn_url)); console.log(u.size);"`). Plus the 1 bootstrap sanity test = ~58 total. The titles are sorted alphabetically by `cdn_url`.

If the count is the old 20: the env var is not being read. Print `process.env.AUDIT_FULL` from the spec via a `console.log` and re-run; the spec file is evaluated by Playwright's test discovery in the same Node process, so the env var must be set at the npx invocation.

- [ ] **Step 3: Commit**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
git add tests/e2e/acceptance/audit-loadable.spec.mjs
git commit -m "test(audit): add AUDIT_FULL=1 to bypass subsampling and iterate all loadable rows"
```

---

## Task 3: Run the full audit and capture wall-clock + pass/fail counts

**Files:**
- Modify: `package.json` (add `test:audit-reality:full` script)
- Read: `tests/evidence/audit-browser-reality/results.worker-*.jsonl` (produced by the run)

> **Agent suggestion:** dispatch this task to a `browser-agent` or `e2e-runner` subagent. The wall-clock is ~50 minutes at 4 workers. If a class of failures shows parser-style stack traces, escalate that subclass to `sleuth`.

- [ ] **Step 1: Add the npm script**

Read `package.json` first to confirm the audit-script block location. Then add this script next to the existing `test:audit-reality` entry:

```json
"test:audit-reality:full": "AUDIT_FULL=1 playwright test --config=playwright.audit-full.config.mjs tests/e2e/acceptance/audit-loadable.spec.mjs",
```

The script intentionally does NOT set `AUDIT_SAMPLE_SIZE`; the `AUDIT_FULL` branch in Task 2 makes that env var inert.

- [ ] **Step 2: Ensure the audit JSON is the full 712-row version**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
node -e "const j=require('./scripts/audit-100-datasets.json'); const r=j.results.filter(x=>x.verdict==='loadable'); const u=new Set(r.map(x=>x.cdn_url)); console.log('loadable rows:', r.length, '| unique URLs:', u.size, '| full mode:', j.full === true);"
```

Expected (target state): `loadable rows: 712 | unique URLs: 712 | full mode: true`.
If you see `loadable rows: 86 | unique URLs: 57 | full mode: false`, the file is still the 100-sample dev copy. Regenerate it:

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
node scripts/audit-100-datasets.mjs --full --out scripts/audit-100-datasets.json
```

Expected runtime: 5-15 minutes (file-existence HEAD probes only; no browser). Verify the output again with the same `node -e` snippet. The `full: true` field comes from `scripts/audit-100-datasets.mjs:285`.

- [ ] **Step 3: Wipe old shards and run the full audit**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
rm -f tests/evidence/audit-browser-reality/results.worker-*.jsonl
rm -f tests/evidence/audit-browser-reality/playwright-full.json
echo "START $(date -u +%FT%TZ)" | tee tests/evidence/audit-browser-reality/full-run.log
time npm run test:audit-reality:full 2>&1 | tee -a tests/evidence/audit-browser-reality/full-run.log
echo "END $(date -u +%FT%TZ)" | tee -a tests/evidence/audit-browser-reality/full-run.log
```

Expected wall-clock: 40-60 min at 4 workers. Expected exit code: non-zero (we *expect* ~70 failures). Playwright's `list` reporter prints one line per test plus a final summary like `601 passed (50m), 71 failed (50m), 40 flaky (50m)`. The numbers are estimates; the real counts come from the JSONL aggregation in Task 5.

If the run dies mid-way (laptop sleep, network outage): individual worker shards are still on disk from the tests they completed. Re-run only the missing dataset set by setting `AUDIT_FULL=0 AUDIT_SAMPLE_SIZE=<N>` is NOT correct — instead, re-run the full command after deleting the worker shards. Playwright has no resume capability and we want a self-consistent merged JSONL.

- [ ] **Step 4: Verify shard files exist and row count matches the input**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
ls -la tests/evidence/audit-browser-reality/results.worker-*.jsonl
wc -l tests/evidence/audit-browser-reality/results.worker-*.jsonl
```

Expected: 1-4 shard files (one per worker that ran tests). The summed line count from `wc -l` total line equals the unique-URL count in the audit JSON (712 for the full mode; minus 1 for the bootstrap sanity test which has no JSONL row).

If the sum is less: at least one test's `afterEach` failed to flush. Inspect `playwright-full.json` for tests with `status: "timedOut"` and `error: null` — those tests timed out before the spec body ran. The afterEach hook (Task 1 Step 2) promotes `unknown` → `timeout`, so it should have written. Open one shard and grep for `verdict":"timeout"` to confirm.

- [ ] **Step 5: Commit the npm script + run log**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
git add package.json tests/evidence/audit-browser-reality/full-run.log
git commit -m "test(audit): add test:audit-reality:full npm script + capture full run log"
```

Note: the worker shard JSONL files are NOT committed in this task — they become committed evidence after Task 5 merges them.

---

## Task 4: Build the shard-merger script

**Files:**
- Create: `scripts/audit-merge-shards.mjs`
- Modify: `package.json` (add `merge:audit-shards` script)
- Create: `tests/evidence/audit-browser-reality/results-full.jsonl` (output)

- [ ] **Step 1: Write the merger**

A small pure-Node script: read every `results.worker-*.jsonl` in the evidence directory, parse each line, dedupe by `cdn_url` (keep the row with the most-recent `render_ms` or just the first if ties), sort by `dataset_id` then `cdn_url`, emit `results-full.jsonl`. Deterministic output so diffs across re-runs are meaningful.

```javascript
#!/usr/bin/env node
/**
 * scripts/audit-merge-shards.mjs
 *
 * Merges per-worker JSONL shards (results.worker-*.jsonl) produced by the
 * AUDIT_FULL=1 run of audit-loadable.spec.mjs into a single, deterministically
 * sorted results-full.jsonl. Idempotent: re-running overwrites the merged
 * file without touching the shards.
 *
 * Usage:
 *   node scripts/audit-merge-shards.mjs
 *   node scripts/audit-merge-shards.mjs --out tests/evidence/audit-browser-reality/results-full.jsonl
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'tests/evidence/audit-browser-reality');

function parseArgs(argv) {
  const out = { outPath: path.join(EVIDENCE_DIR, 'results-full.jsonl') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) {
      out.outPath = path.resolve(argv[i + 1]);
      i++;
    }
  }
  return out;
}

function loadShards() {
  if (!fs.existsSync(EVIDENCE_DIR)) {
    throw new Error(`evidence directory not found: ${EVIDENCE_DIR}`);
  }
  const files = fs
    .readdirSync(EVIDENCE_DIR)
    .filter((f) => /^results\.worker-\d+\.jsonl$/.test(f))
    .sort();
  if (files.length === 0) {
    throw new Error(
      `no worker shards found in ${EVIDENCE_DIR} — run \`npm run test:audit-reality:full\` first`,
    );
  }
  const rows = [];
  for (const f of files) {
    const full = path.join(EVIDENCE_DIR, f);
    const lines = fs.readFileSync(full, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    for (let i = 0; i < lines.length; i++) {
      try {
        rows.push(JSON.parse(lines[i]));
      } catch (err) {
        throw new Error(`${f} line ${i + 1} is not valid JSON: ${err.message}`);
      }
    }
  }
  return { rows, shardFiles: files };
}

function dedupeAndSort(rows) {
  // Dedupe by cdn_url (a URL should be tested exactly once across all
  // workers; if it appears twice, prefer the row with verdict==='pass'
  // — re-runs after a flake should override the failing row).
  const byUrl = new Map();
  for (const r of rows) {
    const existing = byUrl.get(r.cdn_url);
    if (!existing) {
      byUrl.set(r.cdn_url, r);
      continue;
    }
    const existingPasses = existing.verdict === 'pass';
    const incomingPasses = r.verdict === 'pass';
    if (incomingPasses && !existingPasses) byUrl.set(r.cdn_url, r);
  }
  return Array.from(byUrl.values()).sort((a, b) => {
    const da = a.dataset_id ?? '';
    const db = b.dataset_id ?? '';
    if (da !== db) return da.localeCompare(db);
    return (a.cdn_url ?? '').localeCompare(b.cdn_url ?? '');
  });
}

function main() {
  const { outPath } = parseArgs(process.argv.slice(2));
  const { rows: raw, shardFiles } = loadShards();
  const merged = dedupeAndSort(raw);
  const payload = merged.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, payload);
  console.log(
    `merged ${shardFiles.length} shard(s) → ${merged.length} unique rows (from ${raw.length} raw) → ${outPath}`,
  );
}

main();
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add next to the other `audit` scripts:

```json
"merge:audit-shards": "node scripts/audit-merge-shards.mjs",
```

- [ ] **Step 3: Sanity-check the merger on the Task 3 output**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
npm run merge:audit-shards
wc -l tests/evidence/audit-browser-reality/results-full.jsonl
node -e "const fs=require('fs'); const rows=fs.readFileSync('tests/evidence/audit-browser-reality/results-full.jsonl','utf8').split('\n').filter(Boolean).map(JSON.parse); const v={}; for(const r of rows) v[r.verdict]=(v[r.verdict]||0)+1; console.log(v); console.log('total:',rows.length);"
```

Expected output (target):
- `merged 4 shard(s) → 712 unique rows (from 712 raw) → tests/evidence/audit-browser-reality/results-full.jsonl`
- `712 tests/evidence/audit-browser-reality/results-full.jsonl`
- Something like `{ pass: 640, 'render-fail': 35, 'console-error': 12, timeout: 15, 'blank-canvas': 6, 'pill-mismatch': 4 }` and `total: 712`.

If the unique count is less than the loadable count: a worker's `afterEach` did not flush some tests (timed-out + no error). Either accept the loss (less than 1 % is acceptable) or re-run Task 3.

- [ ] **Step 4: Commit**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
git add scripts/audit-merge-shards.mjs package.json
git commit -m "feat(audit): merge per-worker JSONL shards into deterministic results-full.jsonl"
```

---

## Task 5: Build the failure-mode classifier

**Files:**
- Create: `scripts/audit-failure-classifier.mjs`
- Modify: `package.json` (add `classify:audit-failures` script)
- Create: `tests/evidence/audit-browser-reality/results-classified.jsonl` (output)

- [ ] **Step 1: Write the classifier with explicit regex bins**

Seven bins, in priority order (first match wins). Each bin's regex is anchored to a real error-message pattern produced by the corresponding viewer code path. The bins:

| Bin | Match criteria |
|---|---|
| `format-CTF-residual` | `ext === 'ds'` AND verdict !== `pass` |
| `format-FIFF-large` | `ext === 'fif'` AND `error_message` matches `/(fetchBuffer|exceeds .* cap|over .*MB|200 MB)/i` |
| `format-EEGLAB-large` | `ext === 'set'` AND `error_message` matches `/200 ?MB|inline .* exceeds|cap on inline/i` |
| `format-EEGLAB-v73-renamed-fdt` | `ext === 'set'` AND `error_message` matches `/v?7\.3|HDF5|jsfive|renamed .*fdt|fdt .*not found/i` |
| `network-flake` | `verdict === 'console-error'` AND `error_message` matches `/5\d\d|net::ERR|TLS|ECONNRESET|EAI_AGAIN/i` |
| `timeout-cold-cdn` | `verdict === 'timeout'` OR (`verdict === 'render-fail'` AND `error_message` matches `/stage-caption never visible/i`) |
| `unknown` | everything else that's not `pass` |

```javascript
#!/usr/bin/env node
/**
 * scripts/audit-failure-classifier.mjs
 *
 * Consumes tests/evidence/audit-browser-reality/results-full.jsonl
 * (produced by `npm run merge:audit-shards`) and emits
 * tests/evidence/audit-browser-reality/results-classified.jsonl with an
 * added per-row `failure_class` field. Pass rows get `failure_class: null`.
 *
 * Bins are matched in priority order (first match wins). Each bin maps to a
 * known viewer code path:
 *   format-CTF-residual          — formats/ctf.js post offset-fix bugs (a52b74c)
 *   format-FIFF-large            — fetchBuffer 200 MB cap in src/http-range.js
 *   format-EEGLAB-large          — 200 MB inline .set cap (91aeae3)
 *   format-EEGLAB-v73-renamed-fdt — Mat73 reader (d555923) + cross-basename fdt
 *   network-flake                — 5xx/TLS/DNS surfaced as page console errors
 *   timeout-cold-cdn             — stage-caption never visible within 60 s
 *   unknown                      — needs investigation (escalate to sleuth)
 *
 * Usage:
 *   node scripts/audit-failure-classifier.mjs
 *   node scripts/audit-failure-classifier.mjs --in <path> --out <path>
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'tests/evidence/audit-browser-reality');

function parseArgs(argv) {
  const out = {
    inPath: path.join(EVIDENCE_DIR, 'results-full.jsonl'),
    outPath: path.join(EVIDENCE_DIR, 'results-classified.jsonl'),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in' && argv[i + 1]) {
      out.inPath = path.resolve(argv[i + 1]);
      i++;
    } else if (argv[i] === '--out' && argv[i + 1]) {
      out.outPath = path.resolve(argv[i + 1]);
      i++;
    }
  }
  return out;
}

// Each entry: { class, test(row) -> boolean }. First true wins.
// Order matters: more-specific format bins before generic network/timeout bins.
const CLASSIFIERS = [
  {
    class: 'format-CTF-residual',
    test: (r) => r.ext === 'ds' && r.verdict !== 'pass',
  },
  {
    class: 'format-FIFF-large',
    test: (r) => {
      if (r.ext !== 'fif') return false;
      const m = r.error_message ?? '';
      return /(fetchBuffer|exceeds .* cap|over .*MB|200 ?MB)/i.test(m);
    },
  },
  {
    class: 'format-EEGLAB-large',
    test: (r) => {
      if (r.ext !== 'set') return false;
      const m = r.error_message ?? '';
      return /200 ?MB|inline .* exceeds|cap on inline/i.test(m);
    },
  },
  {
    class: 'format-EEGLAB-v73-renamed-fdt',
    test: (r) => {
      if (r.ext !== 'set') return false;
      const m = r.error_message ?? '';
      return /v?7\.3|HDF5|jsfive|renamed .*fdt|fdt .*not found/i.test(m);
    },
  },
  {
    class: 'network-flake',
    test: (r) => {
      if (r.verdict !== 'console-error') return false;
      const m = r.error_message ?? '';
      return /5\d\d|net::ERR|TLS|ECONNRESET|EAI_AGAIN/i.test(m);
    },
  },
  {
    class: 'timeout-cold-cdn',
    test: (r) => {
      if (r.verdict === 'timeout') return true;
      if (r.verdict !== 'render-fail') return false;
      const m = r.error_message ?? '';
      return /stage-caption never visible/i.test(m);
    },
  },
];

function classify(row) {
  if (row.verdict === 'pass') return null;
  for (const c of CLASSIFIERS) {
    if (c.test(row)) return c.class;
  }
  return 'unknown';
}

function main() {
  const { inPath, outPath } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(inPath)) {
    throw new Error(`input not found: ${inPath} — run \`npm run merge:audit-shards\` first`);
  }
  const rows = fs
    .readFileSync(inPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));

  const out = rows.map((r) => ({ ...r, failure_class: classify(r) }));
  const tally = {};
  for (const r of out) {
    const k = r.failure_class ?? 'pass';
    tally[k] = (tally[k] ?? 0) + 1;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`classified ${out.length} rows → ${outPath}`);
  console.log('tally:', JSON.stringify(tally, null, 2));
}

main();
```

- [ ] **Step 2: Add the npm script**

```json
"classify:audit-failures": "node scripts/audit-failure-classifier.mjs",
```

- [ ] **Step 3: Run the classifier and eyeball the tally**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
npm run classify:audit-failures
```

Expected output: `classified 712 rows → tests/evidence/audit-browser-reality/results-classified.jsonl` followed by a JSON tally like:

```
tally: {
  "pass": 640,
  "format-CTF-residual": 8,
  "format-FIFF-large": 5,
  "format-EEGLAB-large": 12,
  "format-EEGLAB-v73-renamed-fdt": 18,
  "network-flake": 9,
  "timeout-cold-cdn": 15,
  "unknown": 5
}
```

The numbers are estimates; the real counts will deviate. If `unknown` is more than 10% of failures, the classifier is missing a real failure mode — read 3-5 `unknown` rows from `results-classified.jsonl` (`grep '"failure_class":"unknown"' results-classified.jsonl | head -5`), find the common error pattern, add a new bin or extend an existing regex, and re-run.

- [ ] **Step 4: Commit**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
git add scripts/audit-failure-classifier.mjs package.json
git commit -m "feat(audit): classify browser-reality failures into 7 named bins"
```

---

## Task 6: Build the markdown report writer

**Files:**
- Create: `scripts/audit-browser-reality-full-report.mjs`
- Modify: `package.json` (add `report:audit-reality:full` script)
- Create: `docs/audit-browser-reality-full-2026-05-21.md` (output)

- [ ] **Step 1: Write the reporter**

Inputs: `results-classified.jsonl` (the Task 5 output) and the 20-sample baseline `docs/audit-browser-reality-2026-05-21.md` (read to extract the baseline pass rate for the self-comparison section — parsed by regex against the `## Headline` line).

Outputs: `docs/audit-browser-reality-full-2026-05-21.md` with these sections, in order:
1. **Headline** — "N of M datasets (X.X%) actually render in the browser." + median render time + total wall-clock from `full-run.log` (parsed by regex from the START/END lines).
2. **Self-comparison vs 20-sample baseline** — old pass% vs new pass% with delta.
3. **Verdict breakdown** — bullet list of `{pass, render-fail, blank-canvas, console-error, pill-mismatch, timeout}` counts.
4. **Failure-mode tables** — one table per non-pass bin (6 + `unknown` = 7 tables), each with the dataset_id, ext, error_message-excerpt for every row in that bin.
5. **Top 10 surprising failures** — failures sorted by `render_ms == null` first, then by ext-rarity (least-common ext among failures = most surprising). 10 rows.
6. **Per-dataset appendix** — sortable markdown table of all 712 rows: `dataset_id | ext | datatype | verdict | failure_class | render_ms | error_message`.

```javascript
#!/usr/bin/env node
/**
 * scripts/audit-browser-reality-full-report.mjs
 *
 * Consumes tests/evidence/audit-browser-reality/results-classified.jsonl
 * (produced by `npm run classify:audit-failures`) and emits
 * docs/audit-browser-reality-full-2026-05-21.md.
 *
 * Pure transform — no network, no Playwright dependency. Idempotent:
 * rerunning overwrites the doc but does not touch the JSONL.
 *
 * Usage:
 *   node scripts/audit-browser-reality-full-report.mjs
 *   node scripts/audit-browser-reality-full-report.mjs --out docs/custom.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'tests/evidence/audit-browser-reality');
const CLASSIFIED_JSONL = path.join(EVIDENCE_DIR, 'results-classified.jsonl');
const RUN_LOG = path.join(EVIDENCE_DIR, 'full-run.log');
const BASELINE_MD = path.join(REPO_ROOT, 'docs/audit-browser-reality-2026-05-21.md');

const BIN_ORDER = [
  'format-CTF-residual',
  'format-FIFF-large',
  'format-EEGLAB-large',
  'format-EEGLAB-v73-renamed-fdt',
  'network-flake',
  'timeout-cold-cdn',
  'unknown',
];

const BIN_BLURB = {
  'format-CTF-residual': 'CTF .ds bundles that still fail after the .res4 offset fix (a52b74c). Each row needs a one-off look — likely a new .res4 header variant.',
  'format-FIFF-large': 'FIFF files that exceed the current 200 MB fetchBuffer cap in src/http-range.js. Lifting the cap requires streaming-decode work in formats/fiff.js.',
  'format-EEGLAB-large': 'Inline .set files larger than 200 MB (cap added in 91aeae3). Same streaming-decode story as FIFF.',
  'format-EEGLAB-v73-renamed-fdt': 'MAT v7.3 (HDF5) .set files where the companion .fdt has a different basename than the .set. Mat73 reader (d555923) needs cross-basename .fdt sidecar resolution.',
  'network-flake': 'Console errors that surfaced 5xx/TLS/DNS — likely flakes, not viewer bugs. Re-run the listed URLs in isolation to confirm.',
  'timeout-cold-cdn': 'stage-caption never appeared within 60 s. Cold CDN + first range-fetch latency. Confirm by re-running the listed URLs after a warm-up GET.',
  unknown: 'Failures that did not match any classifier regex. Escalate to sleuth for one-by-one investigation.',
};

function parseArgs(argv) {
  const out = {
    outPath: path.join(REPO_ROOT, 'docs/audit-browser-reality-full-2026-05-21.md'),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) {
      out.outPath = path.resolve(argv[i + 1]);
      i++;
    }
  }
  return out;
}

function loadRows() {
  if (!fs.existsSync(CLASSIFIED_JSONL)) {
    throw new Error(
      `${CLASSIFIED_JSONL} not found — run \`npm run classify:audit-failures\` first`,
    );
  }
  return fs
    .readFileSync(CLASSIFIED_JSONL, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function parseRunLog() {
  if (!fs.existsSync(RUN_LOG)) return null;
  const text = fs.readFileSync(RUN_LOG, 'utf8');
  const startMatch = text.match(/^START (\S+)$/m);
  const endMatch = text.match(/^END (\S+)$/m);
  if (!startMatch || !endMatch) return null;
  const startMs = Date.parse(startMatch[1]);
  const endMs = Date.parse(endMatch[1]);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const totalMs = endMs - startMs;
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  return { totalMs, formatted: `${minutes}m ${seconds}s` };
}

function parseBaselinePass() {
  if (!fs.existsSync(BASELINE_MD)) return null;
  const text = fs.readFileSync(BASELINE_MD, 'utf8');
  // Headline format in the 20-sample report (audit-browser-reality-report.mjs:128):
  //   **N of M datasets (X.X%) actually render in the browser.**
  const m = text.match(/\*\*(\d+) of (\d+) datasets \(([\d.]+)%\)/);
  if (!m) return null;
  return { passed: +m[1], total: +m[2], pct: +m[3] };
}

function cleanMsg(msg) {
  if (!msg) return '';
  return String(msg)
    .replace(/\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarise(rows) {
  const verdictCounts = {};
  const classCounts = {};
  const renderTimes = [];
  for (const r of rows) {
    verdictCounts[r.verdict] = (verdictCounts[r.verdict] ?? 0) + 1;
    const k = r.failure_class ?? 'pass';
    classCounts[k] = (classCounts[k] ?? 0) + 1;
    if (typeof r.render_ms === 'number') renderTimes.push(r.render_ms);
  }
  renderTimes.sort((a, b) => a - b);
  const median = renderTimes.length === 0 ? null : renderTimes[Math.floor(renderTimes.length / 2)];
  return {
    verdictCounts,
    classCounts,
    total: rows.length,
    passed: verdictCounts.pass ?? 0,
    medianRenderMs: median,
  };
}

function renderBinTable(rows) {
  if (rows.length === 0) return '_no rows_\n';
  const header = '| dataset_id | ext | datatype | verdict | render_ms | error_message |\n|---|---|---|---|---:|---|';
  const body = rows
    .slice()
    .sort((a, b) => (a.dataset_id ?? '').localeCompare(b.dataset_id ?? ''))
    .map((r) => {
      const ms = r.render_ms == null ? '—' : `${r.render_ms}`;
      const msg = cleanMsg(r.error_message).slice(0, 140).replace(/\|/g, '\\|');
      return `| ${r.dataset_id} | ${r.ext ?? '—'} | ${r.datatype ?? '—'} | ${r.verdict} | ${ms} | ${msg} |`;
    })
    .join('\n');
  return `${header}\n${body}\n`;
}

function renderExampleUrls(rows) {
  // First 5 unique cdn_urls for the bin (cited inline so the reader can reproduce
  // without scrolling to the appendix).
  const seen = new Set();
  const urls = [];
  for (const r of rows) {
    if (!r.cdn_url || seen.has(r.cdn_url)) continue;
    seen.add(r.cdn_url);
    urls.push(r.cdn_url);
    if (urls.length === 5) break;
  }
  if (urls.length === 0) return '';
  return '\nFirst example URLs:\n' + urls.map((u) => `- ${u}`).join('\n') + '\n';
}

function renderSurprising(rows) {
  // "Surprising" = failures with the rarest extension among failures (signals
  // a code path we haven't seen break before). Tie-break by render_ms === null
  // (the test got nowhere at all, which is more surprising than a late blank-canvas).
  const failures = rows.filter((r) => r.verdict !== 'pass');
  const extFreq = {};
  for (const r of failures) extFreq[r.ext ?? 'unknown'] = (extFreq[r.ext ?? 'unknown'] ?? 0) + 1;
  const surprising = failures
    .slice()
    .sort((a, b) => {
      const fa = extFreq[a.ext ?? 'unknown'];
      const fb = extFreq[b.ext ?? 'unknown'];
      if (fa !== fb) return fa - fb;
      const nullA = a.render_ms == null ? 0 : 1;
      const nullB = b.render_ms == null ? 0 : 1;
      return nullA - nullB;
    })
    .slice(0, 10);
  return renderBinTable(surprising);
}

function renderAppendix(rows) {
  const header = '| dataset_id | ext | datatype | verdict | failure_class | render_ms | error_message |\n|---|---|---|---|---|---:|---|';
  const body = rows
    .slice()
    .sort((a, b) => {
      const da = a.dataset_id ?? '';
      const db = b.dataset_id ?? '';
      if (da !== db) return da.localeCompare(db);
      return (a.cdn_url ?? '').localeCompare(b.cdn_url ?? '');
    })
    .map((r) => {
      const ms = r.render_ms == null ? '—' : `${r.render_ms}`;
      const cls = r.failure_class ?? '—';
      const msg = cleanMsg(r.error_message).slice(0, 100).replace(/\|/g, '\\|');
      return `| ${r.dataset_id} | ${r.ext ?? '—'} | ${r.datatype ?? '—'} | ${r.verdict} | ${cls} | ${ms} | ${msg} |`;
    })
    .join('\n');
  return `${header}\n${body}\n`;
}

function render(rows) {
  const today = new Date().toISOString().slice(0, 10);
  const { verdictCounts, classCounts, total, passed, medianRenderMs } = summarise(rows);
  const passPct = total === 0 ? 0 : (passed / total) * 100;
  const wall = parseRunLog();
  const baseline = parseBaselinePass();

  const verdictLines = Object.entries(verdictCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `- **${k}**: ${v}`)
    .join('\n');

  const byClass = {};
  for (const r of rows) {
    const k = r.failure_class ?? 'pass';
    (byClass[k] ??= []).push(r);
  }

  const binSections = BIN_ORDER.map((bin) => {
    const binRows = byClass[bin] ?? [];
    return `### ${bin} — ${binRows.length} row(s)

${BIN_BLURB[bin]}
${renderExampleUrls(binRows)}
${renderBinTable(binRows)}`;
  }).join('\n');

  const comparison = baseline
    ? `**Baseline (20-sample, ${baseline.total} datasets):** ${baseline.passed}/${baseline.total} = ${baseline.pct.toFixed(1)}%
**Full run (this report, ${total} datasets):** ${passed}/${total} = ${passPct.toFixed(1)}%
**Delta:** ${(passPct - baseline.pct).toFixed(1)} pp`
    : '_baseline file not found at docs/audit-browser-reality-2026-05-21.md — skipping comparison_';

  return `# Browser reality check — FULL audit (all loadable URLs)

**Date:** ${today}
**Source JSONL:** \`tests/evidence/audit-browser-reality/results-classified.jsonl\`
**Spec:** \`tests/e2e/acceptance/audit-loadable.spec.mjs\` (AUDIT_FULL=1, 4 workers)
**Config:** \`playwright.audit-full.config.mjs\`
**Wall-clock:** ${wall ? wall.formatted : 'unknown'}

## Headline

**${passed} of ${total} datasets (${passPct.toFixed(1)}%) actually render in the browser.**

Median end-to-end render time: ${medianRenderMs == null ? 'n/a' : `${medianRenderMs} ms`}.

## Self-comparison vs 20-sample baseline

${comparison}

## Verdict breakdown

${verdictLines || '_no rows_'}

## Failure-mode classification

${binSections}

## Top 10 surprising failures

(Sorted by rarest failing extension first, then by tests that never got a render_ms.)

${renderSurprising(rows)}

## Per-dataset appendix

${renderAppendix(rows)}

## How to reproduce

\`\`\`bash
# Regenerate the audit JSON (file-existence probes, ~10 min):
node scripts/audit-100-datasets.mjs --full --out scripts/audit-100-datasets.json

# Full 712-URL browser run (~50 min wall at 4 workers):
rm -f tests/evidence/audit-browser-reality/results.worker-*.jsonl
npm run test:audit-reality:full

# Merge per-worker shards + classify + render:
npm run merge:audit-shards
npm run classify:audit-failures
npm run report:audit-reality:full
\`\`\`

## Notes

- The audit JSON marks "loadable" based on a 1-byte HEAD-range probe. This report verifies the viewer's reader actually decodes + renders the file in a real Chromium.
- Network flakes are classified separately from real reader bugs (see the \`network-flake\` bin). Re-run the listed URLs in isolation before opening an issue.
- The \`unknown\` bin is the action queue: failures with no matching regex bin. Escalate row-by-row to the \`sleuth\` agent.
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

- [ ] **Step 2: Add the npm script**

```json
"report:audit-reality:full": "node scripts/audit-browser-reality-full-report.mjs",
```

- [ ] **Step 3: Render the report**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
npm run report:audit-reality:full
```

Expected output: `wrote 712 rows to /Users/bruaristimunha/Projects/eegdash-viewer/docs/audit-browser-reality-full-2026-05-21.md`.

Open the file (`head -80 docs/audit-browser-reality-full-2026-05-21.md`) and verify:
1. The Headline line reads "**N of 712 datasets (XX.X%) actually render in the browser.**" — not 20, not 100.
2. The Self-comparison block shows both the 20-sample baseline AND the new run with a delta in pp.
3. All 7 failure-mode tables are present (even if one is "_no rows_").
4. The Top-10 surprising-failures table has 10 rows (or all failures if fewer).
5. The appendix has 712 rows.

If the baseline pass count is missing: the regex in `parseBaselinePass` is wrong — open `docs/audit-browser-reality-2026-05-21.md` and adjust the regex to match the actual headline format.

- [ ] **Step 4: Commit**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
git add scripts/audit-browser-reality-full-report.mjs package.json docs/audit-browser-reality-full-2026-05-21.md tests/evidence/audit-browser-reality/results-full.jsonl tests/evidence/audit-browser-reality/results-classified.jsonl
git commit -m "feat(audit): full 712-URL browser-reality report with 7-bin failure classification"
```

---

## Task 7: Self-review pass

> **Agent suggestion:** dispatch this task to `plan-reviewer`. The implementer can also self-review using the checklist below.

- [ ] **Step 1: Verify the headline number is real**

Read `docs/audit-browser-reality-full-2026-05-21.md` and confirm:
- Headline `M` matches the row count in `results-classified.jsonl` (`wc -l tests/evidence/audit-browser-reality/results-classified.jsonl`).
- Headline `N` matches the count of `verdict:"pass"` rows (`grep -c '"verdict":"pass"' tests/evidence/audit-browser-reality/results-classified.jsonl`).
- The pp delta in the self-comparison block is computed correctly: `newPct - oldPct`, not the other way around.

- [ ] **Step 2: Verify no failure-mode is `unknown` > 10 % of failures**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
node -e "const fs=require('fs'); const rows=fs.readFileSync('tests/evidence/audit-browser-reality/results-classified.jsonl','utf8').split('\n').filter(Boolean).map(JSON.parse); const f=rows.filter(r=>r.verdict!=='pass'); const u=f.filter(r=>r.failure_class==='unknown'); console.log('failures:',f.length,'| unknown:',u.length,'| pct:',(100*u.length/f.length).toFixed(1));"
```

Expected: `unknown` is less than 10 % of failures.

If it's higher, dump 5 unknown rows, find the common error_message pattern, extend `scripts/audit-failure-classifier.mjs` with a new bin or extend an existing regex, re-run Tasks 5-6.

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
grep '"failure_class":"unknown"' tests/evidence/audit-browser-reality/results-classified.jsonl | head -5 | node -e "process.stdin.on('data',d=>{for(const l of d.toString().split('\n').filter(Boolean)){const r=JSON.parse(l);console.log(r.dataset_id,'|',r.ext,'|',r.verdict,'|',(r.error_message||'').slice(0,200));}});"
```

- [ ] **Step 3: Verify the per-worker shards summed to the unique-URL count**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
node -e "const fs=require('fs'); const j=require('./scripts/audit-100-datasets.json'); const loadable=j.results.filter(x=>x.verdict==='loadable'); const u=new Set(loadable.map(x=>x.cdn_url)); const rows=fs.readFileSync('tests/evidence/audit-browser-reality/results-classified.jsonl','utf8').split('\n').filter(Boolean).map(JSON.parse); console.log('audit unique URLs:',u.size,'| classified rows:',rows.length,'| match:',u.size===rows.length);"
```

Expected: `match: true`. If false, at least one test never flushed — note the gap in the report's Notes section, or re-run Task 3 for the missing URLs only by writing them to a smaller temp audit JSON and pointing the spec at it via a one-off `AUDIT_JSON_PATH` env (not yet implemented; deferred).

- [ ] **Step 4: Sleuth dispatch for parser-style failures (CONDITIONAL)**

If the `format-CTF-residual` bin has more than 3 rows, OR the `unknown` bin contains rows with stack traces in `error_message` mentioning `formats/` or `parse`, dispatch a `sleuth` subagent with the row(s) as input and ask for a root-cause hypothesis per failure. This task documents the trigger; the actual dispatch is the reviewer's call.

- [ ] **Step 5: No commit (review-only task)**

If issues are found in Steps 1-3, fix them and amend the Task 6 commit, OR add a follow-up commit. Do not skip the review.

---

## Task 8: Final commit + push

- [ ] **Step 1: Confirm the working tree is clean except for the expected evidence files**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
git status
```

Expected: all of these should already be committed by Tasks 1-6:
- `playwright.audit-full.config.mjs`
- `tests/e2e/acceptance/audit-loadable.spec.mjs`
- `scripts/audit-merge-shards.mjs`
- `scripts/audit-failure-classifier.mjs`
- `scripts/audit-browser-reality-full-report.mjs`
- `package.json`
- `docs/audit-browser-reality-full-2026-05-21.md`
- `tests/evidence/audit-browser-reality/results-full.jsonl`
- `tests/evidence/audit-browser-reality/results-classified.jsonl`
- `tests/evidence/audit-browser-reality/full-run.log`

Possibly uncommitted (decide per-shard whether to commit raw shards alongside the merged file — they are big but useful for re-runs without re-executing the browser):
- `tests/evidence/audit-browser-reality/results.worker-*.jsonl`
- `tests/evidence/audit-browser-reality/playwright-full.json`

- [ ] **Step 2: Commit the raw shards (recommended) so re-merges are reproducible**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
git add tests/evidence/audit-browser-reality/results.worker-*.jsonl tests/evidence/audit-browser-reality/playwright-full.json
git commit -m "test(audit): commit per-worker JSONL shards + playwright json reporter output"
```

If the shards exceed 1 MB total, consider gzipping (`gzip -k results.worker-*.jsonl`) and committing the `.gz` files instead. The merger script does not currently handle `.gz`; if you go that route, extend it first.

- [ ] **Step 3: Push to origin/main**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
git log --oneline -10
git push origin main
```

Expected: 5-7 new commits pushed (one per Task 1-6 plus the optional Task 8 Step 2 commit). The `git log` should show them all in reverse chronological order, each with the conventional prefix (`test(audit)`, `feat(audit)`).

If `git push` is rejected (e.g. someone else pushed first): `git pull --rebase origin main`, resolve any conflicts (none expected — this work is in fresh files), and re-push.

- [ ] **Step 4: Announce DONE**

The deliverable is `docs/audit-browser-reality-full-2026-05-21.md` with the definitive "N of 712 actually render" headline + 7-bin classification.

---

## Self-Review Checklist (run after writing this plan)

1. **Spec coverage:**
   - Deliverable 1 (re-enable parallelism) → Task 1.
   - Deliverable 2 (AUDIT_FULL env) → Task 2.
   - Deliverable 3 (run the audit) → Task 3.
   - Deliverable 4 (failure classifier with 7 bins) → Task 5 (six explicit bins + `unknown`).
   - Deliverable 5 (markdown report with headline + 6 tables + top-10 + appendix + baseline comparison) → Task 6.
   - Deliverable 6 (npm script `test:audit-reality:full`) → Task 3 Step 1.
   - Deliverable 7 (commit + push) → Tasks 1, 2, 3, 4, 5, 6, 8 (commit per task) + Task 8 (push).
2. **Placeholder scan:** every code block is complete; no TBD/TODO/"fill in"; no "similar to Task N" forward refs.
3. **Type consistency:** `failure_class` field name used identically in Task 5 (writer) and Task 6 (reader); `RESULTS_JSONL_EFFECTIVE` is defined in Task 1 Step 2 and used in the afterEach in the same step; `BIN_ORDER` in Task 6 contains exactly the 7 bins from Task 5's `CLASSIFIERS` array (+ `unknown` as the fallback).
4. **Bin count alignment:** the spec asks for "5 failure-mode tables" in one place and "6 classification tables" in another. This plan ships **7** (six explicit format/network/timeout bins + the catch-all `unknown`) because `unknown` is the action queue and must be visible in the report. Documented in Task 6's bullet list.
