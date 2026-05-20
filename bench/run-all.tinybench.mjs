// Run all tinybench suites and concatenate their github-action-benchmark
// outputs into a single bench/results-all-gab.json. github-action-benchmark
// reads ONE file per invocation, so the merge happens here.
//
// We also concatenate the rich JSON outputs into bench/results-all.json
// for our own consumption (the regression-checker scripts).
//
// Usage:
//   npm run test:bench                  # run everything with BENCH_TIME=1000
//   BENCH_TIME=2000 npm run test:bench  # tighter CI numbers (2s per task)
//   SKIP_NETWORK=1 npm run test:bench   # skip readwindow (no network)

import fs from 'node:fs';
import { execSync } from 'node:child_process';

const SKIP_NETWORK = process.env.SKIP_NETWORK === '1';

const suites = [
  { script: 'bench/filter.tinybench.mjs',        network: false },
  { script: 'bench/parse-matv5.tinybench.mjs',   network: false },
  { script: 'bench/worker-cache.tinybench.mjs',  network: false },
  { script: 'bench/readwindow.tinybench.mjs',    network: true  },
];

const t0 = Date.now();
const failures = [];

for (const { script, network } of suites) {
  if (network && SKIP_NETWORK) {
    console.log(`\n=== SKIP ${script} (SKIP_NETWORK=1) ===`);
    continue;
  }
  console.log(`\n=== ${script} ===`);
  try {
    execSync(`node ${script}`, { stdio: 'inherit' });
  } catch (err) {
    failures.push({ script, error: err.message });
    console.error(`FAIL ${script}: ${err.message}`);
  }
}

// Merge per-suite JSON files into one of each shape.
function pathFor(script, suffix) {
  // bench/foo.tinybench.mjs  → bench/results-foo.json  / bench/results-foo-gab.json
  const base = script
    .replace(/^bench\//, '')
    .replace(/\.tinybench\.mjs$/, '');
  return `bench/results-${base}${suffix}`;
}

const mergedRich = [];
const mergedGAB  = [];
for (const { script } of suites) {
  const richPath = pathFor(script, '.json');
  const gabPath  = pathFor(script, '-gab.json');
  if (fs.existsSync(richPath)) {
    try {
      mergedRich.push(...JSON.parse(fs.readFileSync(richPath, 'utf-8')));
    } catch (err) {
      console.warn(`Skip merge ${richPath}: ${err.message}`);
    }
  }
  if (fs.existsSync(gabPath)) {
    try {
      mergedGAB.push(...JSON.parse(fs.readFileSync(gabPath, 'utf-8')));
    } catch (err) {
      console.warn(`Skip merge ${gabPath}: ${err.message}`);
    }
  }
}

fs.writeFileSync('bench/results-all.json', JSON.stringify(mergedRich, null, 2));
fs.writeFileSync('bench/results-all-gab.json', JSON.stringify(mergedGAB, null, 2));

const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nWrote bench/results-all-gab.json with ${mergedGAB.length} metrics ` +
            `(${mergedRich.length} rich rows) in ${elapsedSec}s.`);

if (failures.length > 0) {
  console.error(`\n${failures.length} suite(s) failed:`);
  for (const { script, error } of failures) {
    console.error(`  - ${script}: ${error}`);
  }
  process.exit(1);
}
