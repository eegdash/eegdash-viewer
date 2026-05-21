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

main().catch(e => {
  console.error(e);
  process.exit(1);
});
