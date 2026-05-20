// Shared tinybench harness for the perf suite.
//
// tinybench reports `mean ± RME` (Relative Margin of Error) per task, not
// a single number. That's the upgrade from the hand-rolled benches —
// `bench/baseline.json` previously stored just `{ name: mean_ms }`
// records, which gave no way to distinguish a real regression from
// timer noise. The new format stores statistical summaries.
//
// Output schema for `bench/results.json` (one row per bench task):
//   {
//     name:        string,    // task name
//     mean_ms:     number,    // tinybench `mean` in milliseconds
//     rme_pct:     number,    // relative margin of error (1.96σ / mean × 100)
//     p75_ms:      number,
//     p99_ms:      number,
//     samples:     number,    // # iterations sampled
//     hz:          number,    // operations / second
//   }
//
// Format for github-action-benchmark (customSmallerIsBetter):
//   [{ name, unit: 'ms', value: mean_ms, range: '±<rme_pct>%', extra: '<p99=Xms, n=Ysamples>' }]

import { Bench } from 'tinybench';
import { withCodSpeed } from '@codspeed/tinybench-plugin';
import fs from 'node:fs';

/**
 * Run a Bench instance and emit two files:
 *   - bench/results.json — rich format for our own analysis
 *   - bench/results-gab.json — github-action-benchmark customSmallerIsBetter input
 *
 * @param {Bench} bench - configured tinybench instance (tasks already added)
 * @param {string} outRich - path for the rich JSON
 * @param {string} outGAB  - path for the gh-action-benchmark JSON
 */
export async function runAndEmit(bench, outRich, outGAB) {
  // tinybench v6 dropped the explicit warmup() method; warmup runs as part
  // of run() when `warmupTime > 0` was set on the Bench instance.
  if (typeof bench.warmup === 'function') {
    await bench.warmup();
  }
  await bench.run();

  const rich = [];
  const gab = [];
  for (const task of bench.tasks) {
    const r = task.result;
    if (!r) continue;
    // tinybench v6 nests stats under `latency` (already in milliseconds —
    // tinybench uses performance.now() under the hood) and `throughput`.
    // Older shapes exposed mean/rme/p75/p99/hz/samples at the top level.
    const latency = r.latency ?? null;
    const meanMs = latency
      ? latency.mean
      : (typeof r.mean === 'number' ? r.mean : NaN);
    const rmePct = latency
      ? latency.rme
      : (typeof r.rme === 'number' ? r.rme : NaN);
    const p75Ms = latency
      ? latency.p75
      : (typeof r.p75 === 'number' ? r.p75 : NaN);
    const p99Ms = latency
      ? latency.p99
      : (typeof r.p99 === 'number' ? r.p99 : NaN);
    const samples = latency
      ? (latency.samplesCount ?? latency.samples?.length ?? r.samples?.length ?? 0)
      : (r.samples?.length ?? 0);
    const hz = typeof r.throughput?.mean === 'number'
      ? r.throughput.mean
      : (typeof r.hz === 'number' ? r.hz : (meanMs > 0 ? 1000 / meanMs : 0));

    rich.push({
      name: task.name,
      mean_ms: Number(meanMs.toFixed(4)),
      rme_pct: Number(rmePct.toFixed(2)),
      p75_ms: Number(p75Ms.toFixed(4)),
      p99_ms: Number(p99Ms.toFixed(4)),
      samples,
      hz: Number(hz.toFixed(1)),
    });
    gab.push({
      name: task.name,
      unit: 'ms',
      value: Number(meanMs.toFixed(4)),
      range: `±${rmePct.toFixed(2)}%`,
      extra: `p99=${p99Ms.toFixed(3)}ms, n=${samples}samples`,
    });
  }
  fs.writeFileSync(outRich, JSON.stringify(rich, null, 2));
  fs.writeFileSync(outGAB, JSON.stringify(gab, null, 2));

  // Console summary so CI logs show the numbers without having to cat the JSON.
  for (const r of rich) {
    console.log(
      `  ${r.name.padEnd(50)} ${r.mean_ms.toFixed(3)} ms ± ${r.rme_pct.toFixed(2)}%  ` +
      `(p99=${r.p99_ms.toFixed(3)}ms, n=${r.samples})`,
    );
  }

  return { rich, gab };
}

/**
 * Default bench config tuned for the EEG viewer's workload (mostly ~ms
 * tasks). 1 s per task is plenty for stable RME on a quiet machine; 3 s
 * if you want tighter CI numbers (set BENCH_TIME=3000 env var).
 */
export function makeBench(extra = {}) {
  const time = parseInt(process.env.BENCH_TIME || '1000', 10);
  const bench = new Bench({ time, warmupTime: Math.max(50, Math.floor(time / 4)), ...extra });
  // CodSpeed instrument: enabled when CSE_PERF=1, otherwise plain tinybench.
  // Local runs (CSE_PERF unset) → wall-clock measurement.
  // CI runs (CSE_PERF=1) → Callgrind-based CPU simulation, 0.56% CoV.
  return process.env.CSE_PERF ? withCodSpeed(bench) : bench;
}
