# Audit Resample Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-sample 80% loadability claim with a statistically defensible figure by running the existing audit across 5 seeded samples (plus optional full-catalog pass) and reporting mean, range, and standard deviation per datatype.

**Architecture:** Keep the existing `scripts/audit-100-datasets.mjs` script as-is structurally; swap its non-deterministic `Math.random()` reservoir sample for a Mulberry32-seeded PRNG and add `--seed=<N>` and `--full` flags. Add a new wrapper `scripts/audit-multi-run.mjs` that shells out to the audit script 5 times (seeds 1..5), reads each per-run JSON from `reports/audit/run-<seed>.json`, aggregates per-datatype loadability with mean/min/max/std/95% CI, and writes a human-readable markdown report.

**Tech Stack:** Node.js (ESM, built-in `fetch`, `node:child_process`, `node:fs`); no new dependencies.

---

## File Structure

- Modify: `scripts/audit-100-datasets.mjs` — add Mulberry32 RNG, `--seed`, `--full`, `--out` flags
- Create: `scripts/audit-multi-run.mjs` — runner that invokes the audit 5 times and aggregates
- Modify: `.gitignore` — exclude `reports/audit/run-*.json`
- Create: `docs/audit-multi-run-2026-05-21.md` — aggregate report (committed)
- Transient (untracked): `reports/audit/run-1.json` ... `reports/audit/run-5.json`, optionally `reports/audit/run-full.json`

---

### Task 1: Add Mulberry32 seeded RNG and CLI flags to the audit script

**Files:**
- Modify: `scripts/audit-100-datasets.mjs` (constants block lines 22-32; `sample()` lines 174-182; `main()` lines 186-243)

- [ ] **Step 1: Add a CLI parser, Mulberry32, and replace the constants block**

Replace the constants block (lines 22-32) and add a `parseArgs()` helper plus `mulberry32()` immediately after the imports. The final shape of lines 19-65 should be:

```js
import fs from 'node:fs';
import path from 'node:path';

const CATALOG_API = 'https://data.eegdash.org/api/eegdash/datasets';
const CDN = 'https://cdn.eegdash.org';
const S3 = 'https://s3.amazonaws.com/openneuro.org';
const PER_PAGE = 100;
const DEFAULT_SAMPLE_SIZE = 100;
const BATCH = 8;
const PROBE_TIMEOUT_MS = 15_000;

// Supported by the viewer.
const SUPPORTED_DATATYPES = new Set(['eeg', 'ieeg', 'meg', 'emg', 'nirs']);
const SUPPORTED_EXTS = new Set(['edf', 'bdf', 'set', 'vhdr', 'fif', 'snirf']);

// --- CLI ------------------------------------------------------------

function parseArgs(argv) {
  const args = { seed: null, full: false, out: 'scripts/audit-100-datasets.json', sampleSize: DEFAULT_SAMPLE_SIZE };
  for (const a of argv.slice(2)) {
    if (a === '--full') args.full = true;
    else if (a.startsWith('--seed=')) args.seed = Number(a.slice('--seed='.length));
    else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
    else if (a.startsWith('--sample-size=')) args.sampleSize = Number(a.slice('--sample-size='.length));
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (args.seed !== null && (!Number.isInteger(args.seed) || args.seed < 0)) {
    throw new Error(`--seed must be a non-negative integer, got: ${args.seed}`);
  }
  return args;
}

// --- seeded RNG (Mulberry32) ----------------------------------------

function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

- [ ] **Step 2: Update `sample()` to accept an RNG**

Replace the `sample()` function (lines 174-182) with:

```js
function sample(arr, n, rng = Math.random) {
  // Reservoir sample (Algorithm R) with injectable RNG for reproducibility.
  const out = arr.slice(0, n);
  for (let i = n; i < arr.length; i++) {
    const j = Math.floor(rng() * (i + 1));
    if (j < n) out[j] = arr[i];
  }
  return out;
}
```

- [ ] **Step 3: Update `main()` to honor `--seed`, `--full`, and `--out`**

Replace the `main()` function (lines 186-243) with:

```js
async function main() {
  const args = parseArgs(process.argv);
  const allDatasets = await fetchCatalog();
  process.stderr.write(`\nCatalog: ${allDatasets.length} datasets.\n`);

  const sampleSize = args.full ? allDatasets.length : Math.min(args.sampleSize, allDatasets.length);
  const rng = args.seed !== null ? mulberry32(args.seed) : Math.random;
  const seedLabel = args.seed !== null ? `seed=${args.seed}` : 'seed=unseeded';
  const modeLabel = args.full ? 'FULL' : `sample=${sampleSize}`;
  process.stderr.write(`Mode: ${modeLabel} (${seedLabel})\n\n`);

  const sampled = args.full ? allDatasets.slice() : sample(allDatasets, sampleSize, rng);

  const results = [];
  for (let i = 0; i < sampled.length; i += BATCH) {
    const batch = sampled.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(classifyDataset));
    results.push(...batchResults);
    const loadableInBatch = batchResults.filter(r => r.verdict === 'loadable').length;
    process.stderr.write(
      `  ${String(results.length).padStart(3)}/${sampled.length} ` +
      `(${loadableInBatch}/${batch.length} loadable in this batch)\n`,
    );
  }

  // Summary
  const verdictCounts = {};
  for (const r of results) {
    verdictCounts[r.verdict] = (verdictCounts[r.verdict] || 0) + 1;
  }

  console.log('\n=== AUDIT SUMMARY ===\n');
  console.log(`Catalog total:  ${allDatasets.length}`);
  console.log(`Sampled:        ${results.length}  (${modeLabel}, ${seedLabel})\n`);
  console.log(`Verdict counts:`);
  for (const [v, n] of Object.entries(verdictCounts).sort((a, b) => b[1] - a[1])) {
    const pct = ((n / results.length) * 100).toFixed(1);
    console.log(`  ${v.padEnd(24)} ${String(n).padStart(3)}  (${pct}%)`);
  }

  const byDatatype = {};
  for (const r of results) {
    const key = r.datatype || (r.datatypes && r.datatypes[0]) || 'unknown';
    if (!byDatatype[key]) byDatatype[key] = { loadable: 0, total: 0 };
    byDatatype[key].total++;
    if (r.verdict === 'loadable') byDatatype[key].loadable++;
  }
  console.log(`\nLoadable rate by datatype:`);
  for (const [t, { loadable, total }] of Object.entries(byDatatype).sort((a, b) => b[1].total - a[1].total)) {
    const pct = ((loadable / total) * 100).toFixed(1);
    console.log(`  ${t.padEnd(10)} ${loadable}/${total}  (${pct}%)`);
  }

  // Write full results
  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    seed: args.seed,
    full: args.full,
    catalogTotal: allDatasets.length,
    sampled: results.length,
    verdictCounts,
    byDatatype,
    results,
  }, null, 2));
  console.log(`\nFull report: ${outPath}`);

  // Non-loadable examples for debugging
  const nonLoadable = results.filter(r => r.verdict !== 'loadable').slice(0, 10);
  if (nonLoadable.length > 0) {
    console.log(`\nFirst ${nonLoadable.length} non-loadable examples:`);
    for (const r of nonLoadable) {
      const detail = r.key || `datatypes=${JSON.stringify(r.datatypes || [])}`;
      console.log(`  ${r.dataset_id.padEnd(12)} ${r.verdict.padEnd(22)}  ${detail}`);
    }
  }

  // Loadable examples for confirmation
  const loadable = results.filter(r => r.verdict === 'loadable').slice(0, 5);
  if (loadable.length > 0) {
    console.log(`\nFirst ${loadable.length} loadable examples:`);
    for (const r of loadable) {
      console.log(`  ${r.dataset_id.padEnd(12)} ${r.datatype.padEnd(5)} sub-${r.sub}  ${r.key}`);
    }
  }
}
```

- [ ] **Step 4: Quick determinism smoke test (no network — RNG only)**

Run:

```bash
node -e "
const f = (seed) => {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const a = f(1); const b = f(1);
const seqA = [a(), a(), a()];
const seqB = [b(), b(), b()];
console.log('A:', seqA);
console.log('B:', seqB);
console.log('match:', JSON.stringify(seqA) === JSON.stringify(seqB));
"
```

Expected output (last line):

```
match: true
```

If `match: false`, the Mulberry32 was transcribed wrong — re-check Step 1.

- [ ] **Step 5: Verify the script's CLI parsing**

Run:

```bash
node -e "
import('./scripts/audit-100-datasets.mjs').catch(() => {});
" 2>&1 | head -5
```

(The script will try to run on import; that's OK, just Ctrl-C if it hangs on the catalog fetch — we only care that no syntax error appears.) Better, lint with:

```bash
node --check scripts/audit-100-datasets.mjs
```

Expected: no output, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/audit-100-datasets.mjs
git commit -m "feat(audit): add seeded RNG and --seed/--full/--out flags"
```

---

### Task 2: Add `.gitignore` entry for per-run JSON

**Files:**
- Modify: `.gitignore` (append a new section)

- [ ] **Step 1: Append the ignore rule**

Append these two lines at the bottom of `.gitignore`:

```
# Per-run audit JSON — transient, only the aggregate doc is committed
reports/audit/run-*.json
```

- [ ] **Step 2: Verify the rule matches**

Run:

```bash
mkdir -p reports/audit && touch reports/audit/run-1.json && git check-ignore -v reports/audit/run-1.json
```

Expected output (path may vary):

```
.gitignore:NN:reports/audit/run-*.json    reports/audit/run-1.json
```

Then clean up the touched file:

```bash
rm reports/audit/run-1.json
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore(gitignore): exclude per-run audit JSON"
```

---

### Task 3: Create the multi-run wrapper script (scaffold + child invocation)

**Files:**
- Create: `scripts/audit-multi-run.mjs`

- [ ] **Step 1: Write the file with scaffolding, CLI parsing, and child spawning**

Create `scripts/audit-multi-run.mjs` with this exact content:

```js
#!/usr/bin/env node
/**
 * Run scripts/audit-100-datasets.mjs N times with seeds 1..N and aggregate
 * per-datatype loadability statistics.
 *
 * Usage:
 *   node scripts/audit-multi-run.mjs                       # 5 runs, seeds 1..5
 *   node scripts/audit-multi-run.mjs --runs=3              # 3 runs, seeds 1..3
 *   node scripts/audit-multi-run.mjs --seeds=1,2,3,7,42    # explicit seeds
 *
 * Output:
 *   reports/audit/run-<seed>.json  (per run, gitignored)
 *   docs/audit-multi-run-2026-05-21.md  (aggregate, committed)
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const AUDIT_SCRIPT = 'scripts/audit-100-datasets.mjs';
const REPORTS_DIR = 'reports/audit';
const DOC_PATH = 'docs/audit-multi-run-2026-05-21.md';

function parseArgs(argv) {
  const args = { runs: 5, seeds: null };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--runs=')) args.runs = Number(a.slice('--runs='.length));
    else if (a.startsWith('--seeds=')) args.seeds = a.slice('--seeds='.length).split(',').map(Number);
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!args.seeds) args.seeds = Array.from({ length: args.runs }, (_, i) => i + 1);
  return args;
}

function runOne(seed) {
  const outPath = path.join(REPORTS_DIR, `run-${seed}.json`);
  process.stderr.write(`\n========== seed=${seed} → ${outPath} ==========\n`);
  const res = spawnSync('node', [AUDIT_SCRIPT, `--seed=${seed}`, `--out=${outPath}`], {
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    throw new Error(`Audit run for seed=${seed} exited with status ${res.status}`);
  }
  return JSON.parse(fs.readFileSync(outPath, 'utf8'));
}

async function main() {
  const args = parseArgs(process.argv);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const runs = [];
  for (const seed of args.seeds) {
    runs.push(runOne(seed));
  }

  // Aggregation happens in Task 4.
  console.log(`\n${runs.length} runs complete. Next: aggregate.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Lint the file**

Run:

```bash
node --check scripts/audit-multi-run.mjs
```

Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/audit-multi-run.mjs
git commit -m "feat(audit): scaffold multi-run wrapper that spawns seeded child runs"
```

---

### Task 4: Add aggregation (mean / min / max / std / 95% CI) and markdown report writer

**Files:**
- Modify: `scripts/audit-multi-run.mjs` (replace the `main()` and add helpers)

- [ ] **Step 1: Add aggregation helpers above `main()`**

Insert these helpers immediately after the `runOne()` function and before `async function main()`:

```js
function mean(xs) {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

function ci95(xs) {
  // 95% CI using t-approximation; for n=5 we use t=2.776 (df=4).
  // For n>=30 falls back to 1.96. Adequate for our scale.
  const tTable = { 2: 12.706, 3: 4.303, 4: 3.182, 5: 2.776, 6: 2.571, 7: 2.447, 8: 2.365, 9: 2.306, 10: 2.262 };
  const n = xs.length;
  if (n < 2) return 0;
  const t = tTable[n] ?? 1.96;
  return t * std(xs) / Math.sqrt(n);
}

function aggregate(runs) {
  // Overall loadable rate per run.
  const overallRates = runs.map(r => (r.verdictCounts.loadable || 0) / r.sampled);

  // Per-datatype loadable rate per run.
  const datatypes = new Set();
  for (const r of runs) for (const k of Object.keys(r.byDatatype)) datatypes.add(k);

  const perDatatype = {};
  for (const dt of datatypes) {
    const rates = [];
    const totals = [];
    for (const r of runs) {
      const b = r.byDatatype[dt];
      if (!b || b.total === 0) continue;
      rates.push(b.loadable / b.total);
      totals.push(b.total);
    }
    perDatatype[dt] = {
      runs: rates.length,
      meanRate: mean(rates),
      minRate: Math.min(...rates),
      maxRate: Math.max(...rates),
      std: std(rates),
      ci95: ci95(rates),
      meanSampleSize: mean(totals),
    };
  }

  // Verdict counts: mean across runs.
  const verdictKeys = new Set();
  for (const r of runs) for (const k of Object.keys(r.verdictCounts)) verdictKeys.add(k);
  const perVerdict = {};
  for (const v of verdictKeys) {
    const counts = runs.map(r => r.verdictCounts[v] || 0);
    perVerdict[v] = {
      mean: mean(counts),
      min: Math.min(...counts),
      max: Math.max(...counts),
      std: std(counts),
    };
  }

  return {
    runCount: runs.length,
    seeds: runs.map(r => r.seed),
    catalogTotal: runs[0].catalogTotal,
    sampleSize: runs[0].sampled,
    overall: {
      meanLoadable: mean(overallRates),
      minLoadable: Math.min(...overallRates),
      maxLoadable: Math.max(...overallRates),
      std: std(overallRates),
      ci95: ci95(overallRates),
      perRun: overallRates,
    },
    perVerdict,
    perDatatype,
  };
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function writeMarkdown(agg, runs, docPath) {
  const lines = [];
  lines.push(`# Multi-Run Audit: data.eegdash.org Loadability`);
  lines.push('');
  lines.push(`**Date:** ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`**Runs:** ${agg.runCount} (seeds: ${agg.seeds.join(', ')})`);
  lines.push(`**Catalog total:** ${agg.catalogTotal} datasets`);
  lines.push(`**Sample size per run:** ${agg.sampleSize}`);
  lines.push('');
  lines.push(`## Overall Loadability`);
  lines.push('');
  lines.push(`| Statistic | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Mean loadable rate | **${pct(agg.overall.meanLoadable)}** |`);
  lines.push(`| Min | ${pct(agg.overall.minLoadable)} |`);
  lines.push(`| Max | ${pct(agg.overall.maxLoadable)} |`);
  lines.push(`| Std deviation | ${pct(agg.overall.std)} |`);
  lines.push(`| 95% CI (half-width) | ±${pct(agg.overall.ci95)} |`);
  lines.push(`| Per-run rates | ${agg.overall.perRun.map(pct).join(', ')} |`);
  lines.push('');
  lines.push(`## Loadability by Datatype`);
  lines.push('');
  lines.push(`| Datatype | Runs | Mean | Min | Max | Std | 95% CI | Avg n |`);
  lines.push(`| --- | ---:| ---:| ---:| ---:| ---:| ---:| ---:|`);
  const sorted = Object.entries(agg.perDatatype).sort((a, b) => b[1].meanSampleSize - a[1].meanSampleSize);
  for (const [dt, s] of sorted) {
    lines.push(`| ${dt} | ${s.runs} | **${pct(s.meanRate)}** | ${pct(s.minRate)} | ${pct(s.maxRate)} | ${pct(s.std)} | ±${pct(s.ci95)} | ${s.meanSampleSize.toFixed(1)} |`);
  }
  lines.push('');
  lines.push(`## Verdict Counts (mean across runs)`);
  lines.push('');
  lines.push(`| Verdict | Mean | Min | Max | Std |`);
  lines.push(`| --- | ---:| ---:| ---:| ---:|`);
  const verdictsSorted = Object.entries(agg.perVerdict).sort((a, b) => b[1].mean - a[1].mean);
  for (const [v, s] of verdictsSorted) {
    lines.push(`| ${v} | ${s.mean.toFixed(1)} | ${s.min} | ${s.max} | ${s.std.toFixed(2)} |`);
  }
  lines.push('');
  lines.push(`## Methodology`);
  lines.push('');
  lines.push(`- Audit script: \`scripts/audit-100-datasets.mjs\` (commit-pinned).`);
  lines.push(`- Sampling: reservoir sampling (Algorithm R) seeded with Mulberry32 PRNG.`);
  lines.push(`- Per-dataset probe: list S3 keys for the first subject's recording, then range-GET via cdn.eegdash.org.`);
  lines.push(`- Verdicts: \`loadable\`, \`cdn-missing-file\`, \`no-recording-found\`, \`unsupported-datatype\`.`);
  lines.push(`- 95% CI uses Student's t for small n (n=5 → t=2.776).`);
  lines.push(`- Per-run JSON: \`reports/audit/run-<seed>.json\` (gitignored).`);
  lines.push('');
  fs.writeFileSync(docPath, lines.join('\n'));
  console.log(`\nAggregate report: ${docPath}`);
}
```

- [ ] **Step 2: Wire aggregation into `main()`**

Replace the existing `main()` function with:

```js
async function main() {
  const args = parseArgs(process.argv);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const runs = [];
  for (const seed of args.seeds) {
    runs.push(runOne(seed));
  }

  const agg = aggregate(runs);

  console.log('\n=== AGGREGATE ===');
  console.log(`Runs:                ${agg.runCount} (seeds ${agg.seeds.join(', ')})`);
  console.log(`Mean loadable rate:  ${pct(agg.overall.meanLoadable)}  (min ${pct(agg.overall.minLoadable)}, max ${pct(agg.overall.maxLoadable)})`);
  console.log(`Std:                 ${pct(agg.overall.std)}`);
  console.log(`95% CI half-width:   ±${pct(agg.overall.ci95)}`);
  console.log(`\nPer-datatype mean loadable:`);
  for (const [dt, s] of Object.entries(agg.perDatatype).sort((a, b) => b[1].meanSampleSize - a[1].meanSampleSize)) {
    console.log(`  ${dt.padEnd(10)} ${pct(s.meanRate).padStart(6)}  ±${pct(s.ci95).padStart(5)}  (n≈${s.meanSampleSize.toFixed(1)})`);
  }

  writeMarkdown(agg, runs, DOC_PATH);
}
```

- [ ] **Step 3: Unit-test the math with a fixture (no network)**

Run:

```bash
node -e "
import('./scripts/audit-multi-run.mjs').catch(() => {});
" 2>&1 | head -3
```

Then test the helpers in isolation:

```bash
node -e "
const { spawnSync } = require('node:child_process');
// Verify the file parses.
const r = spawnSync('node', ['--check', 'scripts/audit-multi-run.mjs']);
process.exit(r.status);
"
```

Expected: exit code 0.

Then manually verify aggregation math with a synthetic fixture:

```bash
mkdir -p reports/audit
node -e "
const fs = require('node:fs');
for (let s = 1; s <= 3; s++) {
  fs.writeFileSync(\`reports/audit/run-\${s}.json\`, JSON.stringify({
    timestamp: new Date().toISOString(),
    seed: s,
    full: false,
    catalogTotal: 800,
    sampled: 100,
    verdictCounts: { loadable: 75 + s, 'cdn-missing-file': 25 - s },
    byDatatype: { eeg: { loadable: 60 + s, total: 80 }, meg: { loadable: 15, total: 20 } },
    results: [],
  }, null, 2));
}
console.log('Wrote 3 fixture runs.');
"
node scripts/audit-multi-run.mjs --seeds=1,2,3 2>&1 | tail -20
```

Because the fixtures already exist, the wrapper will re-run the audit and overwrite them. For a true math-only check, temporarily comment out the `runOne(seed)` call inside the `for` loop and replace with:

```js
runs.push(JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, `run-${seed}.json`), 'utf8')));
```

Run the wrapper, confirm the printed mean loadable for seeds 1,2,3 is `(76+77+78)/300 = 77.0%`, then revert the temporary change.

Expected console output line: `Mean loadable rate:  77.0%  (min 76.0%, max 78.0%)`

Clean up:

```bash
rm reports/audit/run-1.json reports/audit/run-2.json reports/audit/run-3.json
```

- [ ] **Step 4: Commit**

```bash
git add scripts/audit-multi-run.mjs
git commit -m "feat(audit): aggregate loadability with mean/std/95% CI and write markdown"
```

---

### Task 5: Execute the multi-run audit (5 seeds × ~100 datasets)

**Files:**
- Generates: `reports/audit/run-1.json` ... `reports/audit/run-5.json` (untracked)
- Generates: `docs/audit-multi-run-2026-05-21.md` (committed in Task 7)

- [ ] **Step 1: Run the wrapper**

Run:

```bash
node scripts/audit-multi-run.mjs 2>&1 | tee /tmp/audit-multi-run.log
```

Expected wall-clock: ~15-25 minutes total (~3-5 min per run × 5 runs). Console will print per-run progress then a final `=== AGGREGATE ===` block.

Expected final-line shape (numbers will vary):

```
Mean loadable rate:  78.4%  (min 75.0%, max 82.0%)
Std:                 2.7%
95% CI half-width:   ±3.4%
```

- [ ] **Step 2: Verify all 5 per-run JSONs exist**

Run:

```bash
ls -la reports/audit/run-*.json && echo "---" && wc -c reports/audit/run-*.json
```

Expected: 5 files, each non-empty (typically 50-200 KB).

- [ ] **Step 3: Confirm the markdown report was written**

Run:

```bash
ls -la docs/audit-multi-run-2026-05-21.md && head -30 docs/audit-multi-run-2026-05-21.md
```

Expected: file exists, header reads `# Multi-Run Audit: data.eegdash.org Loadability` followed by the date, run count, and overall stats table.

- [ ] **Step 4: Sanity-check reproducibility**

Run the audit a second time with one of the seeds and verify the sample is identical:

```bash
node scripts/audit-100-datasets.mjs --seed=1 --out=/tmp/audit-replay.json 2>&1 | tail -5
node -e "
const a = require('./reports/audit/run-1.json');
const b = require('/tmp/audit-replay.json');
const ids = (j) => j.results.map(r => r.dataset_id).sort().join(',');
console.log('match:', ids(a) === ids(b));
"
```

Expected output:

```
match: true
```

If `false`, the RNG isn't being honored — go back to Task 1 Step 1 and re-check the `sample()` signature is being called with `rng`.

---

### Task 6: (Optional) Run the full 800-dataset audit and append exact numbers

**Files:**
- Generates: `reports/audit/run-full.json` (untracked)
- Modify: `docs/audit-multi-run-2026-05-21.md` (append a section)

Skip this task if the full run wall-clock (~30-45 min) is too long for the implementer's window. The multi-run from Task 5 is sufficient on its own.

- [ ] **Step 1: Run the full audit**

Run:

```bash
node scripts/audit-100-datasets.mjs --full --seed=0 --out=reports/audit/run-full.json 2>&1 | tee /tmp/audit-full.log
```

Expected wall-clock: ~30-45 minutes. Final console output will show:

```
Catalog total:  800
Sampled:        800  (FULL, seed=0)

Verdict counts:
  loadable                  NNN  (NN.N%)
  ...
```

- [ ] **Step 2: Append a "Full Catalog Result" section to the markdown**

Run:

```bash
node -e "
const fs = require('node:fs');
const r = JSON.parse(fs.readFileSync('reports/audit/run-full.json', 'utf8'));
const docPath = 'docs/audit-multi-run-2026-05-21.md';
const pct = (n, total) => ((n / total) * 100).toFixed(1) + '%';

const lines = [];
lines.push('');
lines.push('## Full Catalog Result (n=' + r.sampled + ')');
lines.push('');
lines.push('A single deterministic pass over the entire catalog (seed=0) gives the exact ground-truth numbers:');
lines.push('');
lines.push('| Verdict | Count | Share |');
lines.push('| --- | ---:| ---:|');
for (const [v, n] of Object.entries(r.verdictCounts).sort((a, b) => b[1] - a[1])) {
  lines.push(\`| \${v} | \${n} | \${pct(n, r.sampled)} |\`);
}
lines.push('');
lines.push('| Datatype | Loadable | Total | Rate |');
lines.push('| --- | ---:| ---:| ---:|');
const dts = Object.entries(r.byDatatype).sort((a, b) => b[1].total - a[1].total);
for (const [dt, s] of dts) {
  lines.push(\`| \${dt} | \${s.loadable} | \${s.total} | \${pct(s.loadable, s.total)} |\`);
}
lines.push('');
fs.appendFileSync(docPath, lines.join('\n'));
console.log('Appended Full Catalog Result section to', docPath);
"
```

Expected output:

```
Appended Full Catalog Result section to docs/audit-multi-run-2026-05-21.md
```

- [ ] **Step 3: Verify the appended section**

Run:

```bash
tail -30 docs/audit-multi-run-2026-05-21.md
```

Expected: the new `## Full Catalog Result (n=800)` section with two markdown tables.

---

### Task 7: Commit the report and finalize

**Files:**
- Commit: `docs/audit-multi-run-2026-05-21.md`

- [ ] **Step 1: Confirm `reports/audit/run-*.json` are NOT staged**

Run:

```bash
git status --porcelain reports/audit/ 2>&1 | head -10
```

Expected: empty output (all per-run JSON should be matched by the `.gitignore` rule from Task 2).

If any per-run JSON appears here, the `.gitignore` rule didn't match — re-check Task 2 Step 2.

- [ ] **Step 2: Stage and commit the markdown only**

Run:

```bash
git add docs/audit-multi-run-2026-05-21.md
git status --porcelain
```

Expected: a single `A  docs/audit-multi-run-2026-05-21.md` line.

Then:

```bash
git commit -m "docs(audit): add multi-run loadability report with mean/CI per datatype"
```

- [ ] **Step 3: Final verification**

Run:

```bash
git log --oneline -6
```

Expected: the most recent commits are (in order):

```
<hash> docs(audit): add multi-run loadability report with mean/CI per datatype
<hash> feat(audit): aggregate loadability with mean/std/95% CI and write markdown
<hash> feat(audit): scaffold multi-run wrapper that spawns seeded child runs
<hash> chore(gitignore): exclude per-run audit JSON
<hash> feat(audit): add seeded RNG and --seed/--full/--out flags
```

(Plus the prior commit `714772d` at the bottom of the window.)

---

## Self-Review Notes

- **Spec coverage:** All 8 deliverables map to tasks. Task 1 covers items 1-3 (read + RNG + flags), Task 2 covers item 5 (.gitignore), Tasks 3-4 cover item 4 (multi-run script with aggregation + markdown), Task 5 covers item 6 (run it), Task 6 covers item 7 (optional full audit), Task 7 covers item 8 (commit).
- **Type consistency:** `args.seed`, `args.full`, `args.out`, `args.sampleSize` are used consistently in `parseArgs()` and `main()` in the audit script. `runs[]`, `agg.overall.meanLoadable`, `agg.perDatatype[dt].meanRate`, and `pct()` are consistent across `aggregate()`, the console block, and `writeMarkdown()`.
- **Placeholder scan:** Every code block is complete. No TODO/TBD. Test fixtures in Task 4 Step 3 use concrete numbers that produce a known mean (77.0%).
- **Politeness to CDN:** `BATCH = 8` is preserved from the original script; the wrapper runs the audit serially (5 sequential subprocess invocations), so peak concurrency stays at 8 just like the single-run baseline.
