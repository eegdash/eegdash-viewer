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
