// Tinybench-based version of filter.bench.mjs.
//
// Runs every named filter benchmark from the old script with statistical
// sampling (mean ± RME, p75, p99). The hand-rolled bench reported a single
// p50/p95 over 50 iterations — that's barely enough samples for stable
// percentiles on a multi-ms task, and gives no confidence interval. This
// version lets tinybench sample for `BENCH_TIME` ms per task and reports
// the RME so a CI gate can tell signal from jitter.
//
// Output: bench/results-filter.json + bench/results-filter-gab.json.
//
// Setup, fixtures, sample rates, and filter configurations match the
// original bench file exactly so the new numbers stay comparable to the
// existing bench/baseline.json entries (filter_{hp,lp,notch,bp}_{fs}hz).

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeBench, runAndEmit } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load filters.js (IIFE that attaches to globalThis.Filters + module.exports).
const Filters = require(path.join(__dirname, '..', 'filters.js'));

// ---- synthetic data (identical to filter.bench.mjs) -------------

function buildChannels(nChannels, nSamples) {
  const channels = [];
  for (let c = 0; c < nChannels; c++) {
    const ch = new Float32Array(nSamples);
    const f_alpha = 10 + (c % 4);  // 10–13 Hz
    const amp_signal = 50;          // µV
    const amp_noise  = 5;
    for (let i = 0; i < nSamples; i++) {
      ch[i] = amp_signal * Math.sin(2 * Math.PI * f_alpha * i / nSamples)
            + amp_noise  * Math.sin(2 * Math.PI * 60       * i / nSamples)
            + amp_noise  * (Math.random() * 2 - 1);
    }
    channels.push(ch);
  }
  return channels;
}

function filterAllChannels(channels, coefsList) {
  for (const ch of channels) {
    Filters.applyChain(ch, coefsList);
  }
}

// ---- bench setup ------------------------------------------------

const N_CHANNELS = 32;
const DURATION_S = 30;
const SAMPLE_RATES = [250, 512, 1000];

const bench = makeBench();

for (const fs of SAMPLE_RATES) {
  const nSamples = Math.round(fs * DURATION_S);
  const channels = buildChannels(N_CHANNELS, nSamples);

  // HP-only: 1 Hz highpass (typical DC removal)
  const hpCoefs = Filters.designHighpass(fs, 1.0);
  bench.add(`filter_hp_${fs}hz`, () => filterAllChannels(channels, [hpCoefs]));

  // LP-only: 45 Hz (or 0.4·fs if lower)
  const lpCoefs = Filters.designLowpass(fs, Math.min(45, fs * 0.4));
  bench.add(`filter_lp_${fs}hz`, () => filterAllChannels(channels, [lpCoefs]));

  // Notch: 60 Hz, Q=30 (power-line removal)
  const notchCoefs = Filters.designNotch(fs, 60, 30);
  bench.add(`filter_notch_${fs}hz`, () => filterAllChannels(channels, [notchCoefs]));

  // BP: HP + LP chain (most expensive — real usage)
  bench.add(`filter_bp_${fs}hz`, () => filterAllChannels(channels, [hpCoefs, lpCoefs]));
}

console.log('=== filter.tinybench.mjs ===');
console.log(`Channels: ${N_CHANNELS}, Duration: ${DURATION_S}s, ` +
            `BENCH_TIME=${process.env.BENCH_TIME || '1000'}ms`);

await runAndEmit(bench, 'bench/results-filter.json', 'bench/results-filter-gab.json');
