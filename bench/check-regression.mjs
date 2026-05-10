/**
 * bench/check-regression.mjs — Performance regression gate
 *
 * Runs all bench/*.bench.mjs files, compares results against the
 * committed baseline.json, and exits non-zero if any metric regressed:
 *
 *   p50 regression: current p50 > baseline_p50 × 1.10  (+10%)
 *   p95 regression: current p95 > baseline_p95 × 1.20  (+20%)
 *
 * Prints a formatted summary table to stdout.
 *
 * Usage:
 *   node bench/check-regression.mjs            # normal check
 *   node bench/check-regression.mjs --update-baseline  # write fresh baseline.json
 *   node bench/check-regression.mjs --skip-network     # skip readwindow bench (offline)
 *
 * Run via:  npm run test:perf
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(__dirname, 'baseline.json');

const args = process.argv.slice(2);
const UPDATE_BASELINE = args.includes('--update-baseline');
const SKIP_NETWORK   = args.includes('--skip-network');

// Regression thresholds
const P50_THRESH = 1.10;  // 10% regression allowed for p50
const P95_THRESH = 1.20;  // 20% regression allowed for p95
// Minimum absolute delta to trigger a regression — avoids noise on sub-ms
// metrics where a 1 µs difference would register as 50% even though it's
// well within measurement error. Anything under 0.5 ms absolute is noise.
const MIN_ABSOLUTE_DELTA_MS = 0.5;

// ---- bench file definitions -------------------------------------

const BENCH_FILES = [
  {
    file:    path.join(__dirname, 'filter.bench.mjs'),
    label:   'Filter',
    network: false,
  },
  {
    file:    path.join(__dirname, 'parse-matv5.bench.mjs'),
    label:   'MatV5 parse',
    network: false,
  },
  {
    file:    path.join(__dirname, 'readwindow.bench.mjs'),
    label:   'readWindow',
    network: true,
  },
];

// ---- run all bench files ----------------------------------------

async function runBenchFile(entry) {
  console.log(`\nRunning: ${path.basename(entry.file)} ...`);
  // Dynamic import — each bench file exports { results, meta }
  const url = pathToFileURL(entry.file).href;
  const mod = await import(url);
  return { label: entry.label, results: mod.results, meta: mod.meta };
}

// ---- table formatting -------------------------------------------

function fmtNum(n) {
  if (n == null || isNaN(n)) return '   N/A';
  return n.toFixed(1).padStart(8);
}

function fmtStatus(ok, regressor) {
  if (!ok) return `REGRESS (${regressor})`;
  return 'ok';
}

const COL = {
  metric: 42,
  base50:  9,
  curr50:  9,
  delta50: 8,
  base95:  9,
  curr95:  9,
  delta95: 8,
  status: 24,
};

function header() {
  return [
    'Metric'.padEnd(COL.metric),
    'base_p50'.padStart(COL.base50),
    'curr_p50'.padStart(COL.curr50),
    'Δp50%'.padStart(COL.delta50),
    'base_p95'.padStart(COL.base95),
    'curr_p95'.padStart(COL.curr95),
    'Δp95%'.padStart(COL.delta95),
    'Status'.padEnd(COL.status),
  ].join('  ');
}

function row(metric, baseline, current) {
  const bp50 = baseline?.p50_ms;
  const bp95 = baseline?.p95_ms;
  const cp50 = current?.p50_ms;
  const cp95 = current?.p95_ms;

  let d50 = (bp50 != null && cp50 != null) ? ((cp50 / bp50 - 1) * 100) : null;
  let d95 = (bp95 != null && cp95 != null) ? ((cp95 / bp95 - 1) * 100) : null;

  const regresses = [];
  // Only flag a regression if the absolute delta also exceeds the noise floor.
  // This prevents sub-millisecond jitter from triggering false positives.
  if (d50 != null && cp50 > bp50 * P50_THRESH && (cp50 - bp50) > MIN_ABSOLUTE_DELTA_MS) {
    regresses.push(`p50+${d50.toFixed(0)}%`);
  }
  if (d95 != null && cp95 > bp95 * P95_THRESH && (cp95 - bp95) > MIN_ABSOLUTE_DELTA_MS) {
    regresses.push(`p95+${d95.toFixed(0)}%`);
  }

  const ok = regresses.length === 0;
  const status = ok ? 'ok' : `REGRESS (${regresses.join(', ')})`;

  const fmtDelta = (d) => {
    if (d == null) return '   N/A'.padStart(COL.delta50);
    const sign = d > 0 ? '+' : '';
    return `${sign}${d.toFixed(1)}%`.padStart(COL.delta50);
  };

  return {
    line: [
      metric.padEnd(COL.metric),
      fmtNum(bp50),
      fmtNum(cp50),
      fmtDelta(d50),
      fmtNum(bp95),
      fmtNum(cp95),
      fmtDelta(d95),
      status,
    ].join('  '),
    ok,
    regresses,
  };
}

// ---- main -------------------------------------------------------

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

const allResults = {};
const benchErrors = [];

for (const entry of BENCH_FILES) {
  if (entry.network && SKIP_NETWORK) {
    console.log(`Skipping (--skip-network): ${path.basename(entry.file)}`);
    continue;
  }
  try {
    const { results } = await runBenchFile(entry);
    Object.assign(allResults, results);
  } catch (err) {
    benchErrors.push({ file: path.basename(entry.file), error: err.message });
    console.error(`ERROR running ${entry.file}: ${err.message}`);
  }
}

// ---- comparison -------------------------------------------------

console.log('\n' + '═'.repeat(130));
console.log('  PERFORMANCE REGRESSION REPORT');
console.log('  Baseline: ' + BASELINE_PATH);
console.log('  Thresholds: p50 >+10% or p95 >+20% → FAIL');
console.log('  Network metrics are noisy on CI shared runners — nightly only, not PR gate.');
console.log('═'.repeat(130));
console.log('');
console.log(header());
console.log('-'.repeat(130));

const regressions = [];
const newMetrics  = [];

// Report all current results against baseline
for (const [metric, current] of Object.entries(allResults)) {
  const base = baseline[metric];
  if (!base) {
    newMetrics.push(metric);
    // Still print it as informational
    const r = row(metric + ' [NEW]', null, current);
    console.log(r.line);
    continue;
  }
  const r = row(metric, base, current);
  console.log(r.line);
  if (!r.ok) regressions.push({ metric, regresses: r.regresses });
}

// Warn about metrics in baseline not covered by current run
const missingFromCurrentRun = Object.keys(baseline)
  .filter(k => !k.startsWith('_'))
  .filter(k => !(k in allResults));
if (missingFromCurrentRun.length > 0) {
  console.log('-'.repeat(130));
  console.log('  MISSING from current run (baseline entries not re-measured):');
  for (const m of missingFromCurrentRun) {
    console.log(`    ${m}`);
  }
}

console.log('═'.repeat(130));

// ---- update baseline -------------------------------------------

if (UPDATE_BASELINE) {
  const newBaseline = { ...baseline };
  for (const [metric, current] of Object.entries(allResults)) {
    newBaseline[metric] = {
      p50_ms: current.p50_ms,
      p95_ms: current.p95_ms,
      captured_at: new Date().toISOString(),
      host_arch: os.arch(),
    };
  }
  newBaseline._meta = {
    ...newBaseline._meta,
    captured_at: new Date().toISOString(),
    host_arch: os.arch(),
    node_version: process.version,
    platform: process.platform,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(newBaseline, null, 2) + '\n');
  console.log('\nBaseline updated: ' + BASELINE_PATH);
}

// ---- exit -------------------------------------------------------

const hadErrors = benchErrors.length > 0;

if (regressions.length === 0 && !hadErrors) {
  console.log('\nAll metrics within threshold. No regression detected.');
  process.exit(0);
} else {
  if (regressions.length > 0) {
    console.log('\nREGRESSIONS DETECTED:');
    for (const { metric, regresses } of regressions) {
      console.log(`  ${metric}: ${regresses.join(', ')}`);
    }
  }
  if (hadErrors) {
    console.log('\nBENCH ERRORS:');
    for (const { file, error } of benchErrors) {
      console.log(`  ${file}: ${error}`);
    }
  }
  console.log('\nExit 1 (regression or error)');
  process.exit(1);
}
