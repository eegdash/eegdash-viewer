/**
 * bench/filter.bench.mjs — Filter latency benchmark
 *
 * Benchmarks HP / LP / Notch / BP (HP+LP chain) filtering on synthetic
 * 32-channel × 30-second buffers at 250 / 512 / 1000 Hz sample rates.
 * Reports p50 / p95 over 50 iterations per configuration.
 *
 * Run:  node bench/filter.bench.mjs
 */

import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load filters.js (IIFE that attaches to globalThis.Filters + module.exports)
const Filters = require(path.join(__dirname, '..', 'filters.js'));

// ---- percentile helper -------------------------------------------

function stats(arr) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    n:   arr.length,
    min: +sorted[0].toFixed(3),
    p50: +at(0.50).toFixed(3),
    p95: +at(0.95).toFixed(3),
    max: +sorted[sorted.length - 1].toFixed(3),
  };
}

// ---- synthetic data ----------------------------------------------

/**
 * Build a 32-channel × (duration_s × fs) Float32Array buffer.
 * Channels are band-limited sinusoids so the filter has real work to do.
 */
function buildChannels(nChannels, nSamples) {
  const channels = [];
  for (let c = 0; c < nChannels; c++) {
    const ch = new Float32Array(nSamples);
    // Mix: alpha rhythm + 60 Hz noise + broadband noise
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

// ---- benchmark runner -------------------------------------------

/**
 * Run `fn` `n` times, record wall-clock ms each iteration, return stats.
 */
function bench(fn, n) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return stats(times);
}

// ---- filter workloads -------------------------------------------

/**
 * Apply a filter chain to every channel using applyChain (filtfilt per stage).
 * This matches what the worker does on each WINDOW_CHUNK.
 */
function filterAllChannels(channels, coefsList) {
  for (const ch of channels) {
    Filters.applyChain(ch, coefsList);
  }
}

// ---- main -------------------------------------------------------

const ITERATIONS = 50;
const N_CHANNELS = 32;
const DURATION_S = 30;
const SAMPLE_RATES = [250, 512, 1000];

const results = {};

console.log('=== filter.bench.mjs ===');
console.log(`Channels: ${N_CHANNELS}, Duration: ${DURATION_S}s, Iterations: ${ITERATIONS}`);
console.log('');

for (const fs of SAMPLE_RATES) {
  const nSamples = Math.round(fs * DURATION_S);
  const channels = buildChannels(N_CHANNELS, nSamples);

  // HP-only: 1 Hz highpass (typical DC removal)
  const hpCoefs  = Filters.designHighpass(fs, 1.0);
  const hpResult = bench(() => filterAllChannels(channels, [hpCoefs]), ITERATIONS);
  const hpKey    = `filter_hp_${fs}hz`;
  results[hpKey] = { p50_ms: hpResult.p50, p95_ms: hpResult.p95 };
  console.log(`HP  1Hz  @ ${fs}Hz: p50=${hpResult.p50}ms  p95=${hpResult.p95}ms  (n=${N_CHANNELS}ch × ${nSamples}smp)`);

  // LP-only: 45 Hz lowpass
  const lpCoefs  = Filters.designLowpass(fs, Math.min(45, fs * 0.4));
  const lpResult = bench(() => filterAllChannels(channels, [lpCoefs]), ITERATIONS);
  const lpKey    = `filter_lp_${fs}hz`;
  results[lpKey] = { p50_ms: lpResult.p50, p95_ms: lpResult.p95 };
  console.log(`LP 45Hz  @ ${fs}Hz: p50=${lpResult.p50}ms  p95=${lpResult.p95}ms`);

  // Notch: 60 Hz notch (power-line removal)
  const notchCoefs  = Filters.designNotch(fs, 60, 30);
  const notchResult = bench(() => filterAllChannels(channels, [notchCoefs]), ITERATIONS);
  const notchKey    = `filter_notch_${fs}hz`;
  results[notchKey] = { p50_ms: notchResult.p50, p95_ms: notchResult.p95 };
  console.log(`Notch60Hz @ ${fs}Hz: p50=${notchResult.p50}ms  p95=${notchResult.p95}ms`);

  // BP: HP(1Hz) + LP(45Hz) chain (bandpass — most expensive, real usage)
  const bpCoefs  = [hpCoefs, lpCoefs];
  const bpResult = bench(() => filterAllChannels(channels, bpCoefs), ITERATIONS);
  const bpKey    = `filter_bp_${fs}hz`;
  results[bpKey] = { p50_ms: bpResult.p50, p95_ms: bpResult.p95 };
  console.log(`BP 1-45Hz @ ${fs}Hz: p50=${bpResult.p50}ms  p95=${bpResult.p95}ms`);

  console.log('');
}

// Attach metadata for baseline.json consumption
const meta = {
  bench: 'filter',
  captured_at: new Date().toISOString(),
  host_arch: os.arch(),
  node_version: process.version,
};

console.log('Results JSON:');
console.log(JSON.stringify({ ...meta, results }, null, 2));

// Export for check-regression.mjs
export { results, meta };
