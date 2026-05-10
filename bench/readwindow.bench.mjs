/**
 * bench/readwindow.bench.mjs — readWindow latency benchmark
 *
 * Benchmarks the reader's `readWindow` method against representative
 * recordings from OpenNeuro (via cdn.eegdash.org):
 *   - Small EEGLAB .fdt:  ds002893  (sub-001, task-AuditoryVisualShift, run-01, 36ch 500Hz)
 *   - Medium EDF:         ds002034  (sub-01, ses-01, task-offline, run-01)
 *   - Large BV .eeg:      ds002336  (sub-xp101, task-motorloc, 64ch 5000Hz)
 *
 * Window sizes tested:  2s, 10s, 30s
 * Measurement:          cold-cache p50/p95 over 20 runs
 *   "cold-cache": each readWindow call targets a different offset so
 *   HTTP response caching cannot serve the same bytes as the previous run.
 *
 * Run:  node bench/readwindow.bench.mjs
 *
 * NOTE: Network I/O is intentional — these are end-to-end measurements
 * matching what the user feels on a pan.
 */

import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load the full reader stack in the same order as scripts/integration.mjs
require(path.join(__dirname, '..', 'bids-loader.js'));
require(path.join(__dirname, '..', 'formats', '_buffers.js'));
require(path.join(__dirname, '..', 'formats', '_http_range.js'));
require(path.join(__dirname, '..', 'formats', '_sidecar.js'));
const BIDSRecording = require(path.join(__dirname, '..', 'bids-recording.js'));
require(path.join(__dirname, '..', 'formats', 'eeglab.js'));
require(path.join(__dirname, '..', 'formats', 'edf.js'));
require(path.join(__dirname, '..', 'formats', 'brainvision.js'));

const EEGLABReader      = globalThis.EEGLABReader;
const EDFReader         = globalThis.EDFReader;
const BrainVisionReader = globalThis.BrainVisionReader;

// ---- percentile helper -------------------------------------------

function stats(arr) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    n:   arr.length,
    min: +sorted[0].toFixed(1),
    p50: +at(0.50).toFixed(1),
    p95: +at(0.95).toFixed(1),
    max: +sorted[sorted.length - 1].toFixed(1),
  };
}

// ---- recording definitions ---------------------------------------

/**
 * Each fixture specifies:
 *   label  — human name for display
 *   key    — machine key prefix for results / baseline.json
 *   build  — async fn → { reader, fs, n_samples }
 */
const FIXTURES = [
  {
    label: 'EEGLAB .fdt (ds002893/sub-001/task-AuditoryVisualShift/run-01)',
    key:   'readwindow_eeglab_fdt',
    note:  'Small .fdt; 36ch 500Hz; ~100MB; split-format range-fetch',
    async build() {
      const url = BIDSRecording.buildOpenNeuroEegUrl({
        dataset: 'ds002893', sub: '001', task: 'AuditoryVisualShift', run: '01', ext: 'set',
      });
      const meta   = await BIDSRecording.loadRecordingMetadata(url);
      const reader = await EEGLABReader.open(meta);
      return { reader, fs: reader.sampling_frequency, n_samples: reader.n_samples };
    },
  },
  {
    label: 'EDF (ds002034/sub-01/ses-01/task-offline/run-01)',
    key:   'readwindow_edf',
    note:  'Standard EDF; ds002034 is the ds used in integration tests',
    async build() {
      const url = BIDSRecording.buildOpenNeuroEegUrl({
        dataset: 'ds002034', sub: '01', ses: '01', task: 'offline', run: '01', ext: 'edf',
      });
      const meta   = await BIDSRecording.loadRecordingMetadata(url);
      const reader = await EDFReader.open(meta);
      return { reader, fs: reader.sampling_frequency, n_samples: reader.n_samples };
    },
  },
  {
    label: 'BrainVision .eeg (ds002336/sub-xp101/task-motorloc)',
    key:   'readwindow_bv_large',
    note:  'Large BV; 64ch 5000Hz; ~340s; high data rate',
    async build() {
      const url = BIDSRecording.buildOpenNeuroEegUrl({
        dataset: 'ds002336', sub: 'xp101', task: 'motorloc', ext: 'vhdr',
      });
      const meta   = await BIDSRecording.loadRecordingMetadata(url);
      const reader = await BrainVisionReader.open(meta);
      return { reader, fs: reader.sampling_frequency, n_samples: reader.n_samples };
    },
  },
];

const WINDOW_SECS = [2, 10, 30];
const ITERATIONS  = 20;

// ---- bench one fixture at one window size ----------------------

async function benchReadWindow(reader, fs, nSamples, windowSec, nIter) {
  const windowSamples = Math.round(fs * windowSec);
  if (windowSamples > nSamples) return null;

  // Stride so each iteration reads from a different offset — prevents
  // HTTP Range responses being served by in-memory cache.
  const maxStart = Math.max(1, nSamples - windowSamples);
  const stride   = Math.max(1, Math.floor(maxStart / nIter));

  const times = [];
  for (let i = 0; i < nIter; i++) {
    const startSample = (i * stride) % maxStart;
    const t0 = performance.now();
    await reader.readWindow(startSample, windowSamples);
    times.push(performance.now() - t0);
  }
  return stats(times);
}

// ---- main -------------------------------------------------------

console.log('=== readwindow.bench.mjs ===');
console.log(`Window sizes: ${WINDOW_SECS.join('s, ')}s  |  Iterations: ${ITERATIONS} per config`);
console.log('Network I/O is expected — these measure end-to-end readWindow latency.');
console.log('');

const results = {};
const openErrors = [];

for (const fixture of FIXTURES) {
  console.log(`--- ${fixture.label} ---`);
  let reader, fs, nSamples;
  try {
    const t0 = performance.now();
    const built = await fixture.build();
    reader = built.reader;
    fs = built.fs;
    nSamples = built.n_samples;
    const openMs = (performance.now() - t0).toFixed(0);
    console.log(`  opened: ${reader.n_channels}ch  fs=${fs}Hz  dur=${(nSamples/fs).toFixed(0)}s  open_ms=${openMs}`);
  } catch (err) {
    console.error(`  SKIP — could not open: ${err.message}`);
    openErrors.push({ key: fixture.key, error: err.message });
    continue;
  }

  for (const windowSec of WINDOW_SECS) {
    const windowSamples = Math.round(fs * windowSec);
    if (windowSamples > nSamples) {
      console.log(`  window=${windowSec}s: SKIP (recording too short: ${(nSamples/fs).toFixed(0)}s)`);
      continue;
    }
    try {
      const s = await benchReadWindow(reader, fs, nSamples, windowSec, ITERATIONS);
      if (!s) {
        console.log(`  window=${windowSec}s: SKIP`);
        continue;
      }
      const key = `${fixture.key}_${windowSec}s`;
      results[key] = { p50_ms: s.p50, p95_ms: s.p95 };
      console.log(`  window=${windowSec}s: p50=${s.p50}ms  p95=${s.p95}ms  min=${s.min}ms  max=${s.max}ms`);
    } catch (err) {
      console.error(`  window=${windowSec}s: ERROR — ${err.message}`);
    }
  }
  console.log('');
}

if (openErrors.length) {
  console.warn('Skipped fixtures:', openErrors.map(e => e.key).join(', '));
}

const meta = {
  bench: 'readwindow',
  captured_at: new Date().toISOString(),
  host_arch: os.arch(),
  node_version: process.version,
};

console.log('Results JSON:');
console.log(JSON.stringify({ ...meta, results }, null, 2));

export { results, meta };
