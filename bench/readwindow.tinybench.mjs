// Tinybench-based version of readwindow.bench.mjs.
//
// End-to-end readWindow latency on three real OpenNeuro recordings.
// Network I/O is intentional — these match what the user feels on a pan.
//
// Each readWindow call targets a different offset so HTTP Range responses
// can't be served by an in-memory cache; the offset stride is a closed
// captured counter rather than the iteration index of the old script.
//
// Output: bench/results-readwindow.json + bench/results-readwindow-gab.json.
//
// NOTE: This bench is allowed to gracefully skip a fixture when the
// network is unavailable or the recording can't be opened. In that case
// the rich JSON still contains an entry for the other fixtures so the
// CI gate can compare what was measured. A complete network outage means
// no tasks → empty results file, which the aggregator tolerates.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeBench, runAndEmit } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load the full reader stack in the same order as scripts/integration.mjs.
require(path.join(__dirname, '..', 'bids-loader.js'));
require(path.join(__dirname, '..', 'formats', '_buffers.js'));
require(path.join(__dirname, '..', 'formats', '_http_range.js'));
require(path.join(__dirname, '..', 'formats', '_sidecar.js'));
const BIDSRecording = require(path.join(__dirname, '..', 'bids-recording.js'));
require(path.join(__dirname, '..', 'formats', '_matv5.js'));
require(path.join(__dirname, '..', 'formats', '_jsfive.js'));
require(path.join(__dirname, '..', 'formats', '_mat73.js'));
require(path.join(__dirname, '..', 'formats', 'eeglab.js'));
require(path.join(__dirname, '..', 'formats', 'edf.js'));
require(path.join(__dirname, '..', 'formats', 'brainvision.js'));
require(path.join(__dirname, '..', 'formats', '_fiff-dir.js'));
require(path.join(__dirname, '..', 'formats', 'fiff.js'));

const EEGLABReader      = globalThis.EEGLABReader;
const EDFReader         = globalThis.EDFReader;
const BrainVisionReader = globalThis.BrainVisionReader;
const FiffReader        = globalThis.FiffReader;

// ---- fixtures (identical to readwindow.bench.mjs) ---------------

const FIXTURES = [
  {
    key: 'readwindow_eeglab_fdt',
    label: 'EEGLAB .fdt (ds002893/sub-001)',
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
    key: 'readwindow_edf',
    label: 'EDF (ds002034/sub-01)',
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
    key: 'readwindow_bv_large',
    label: 'BrainVision .eeg (ds002336/sub-xp101)',
    async build() {
      const url = BIDSRecording.buildOpenNeuroEegUrl({
        dataset: 'ds002336', sub: 'xp101', task: 'motorloc', ext: 'vhdr',
      });
      const meta   = await BIDSRecording.loadRecordingMetadata(url);
      const reader = await BrainVisionReader.open(meta);
      return { reader, fs: reader.sampling_frequency, n_samples: reader.n_samples };
    },
  },
  {
    key: 'readwindow_fiff_range',
    label: 'FIFF (ds002885 — range-streaming, mid-size)',
    async build() {
      const url = BIDSRecording.buildOpenNeuroEegUrl({
        dataset: 'ds002885', sub: '01', task: 'DSMW', ext: 'fif',
      });
      const meta   = await BIDSRecording.loadRecordingMetadata(url);
      const reader = await FiffReader.open(meta);
      return { reader, fs: reader.sampling_frequency, n_samples: reader.n_samples };
    },
  },
  {
    key: 'readwindow_eeglab_inline_range',
    label: 'EEGLAB inline .set (ds003478 — range-streaming, mid-size)',
    async build() {
      const url = BIDSRecording.buildOpenNeuroEegUrl({
        dataset: 'ds003478', sub: '001', task: 'Rest', run: '01', ext: 'set',
      });
      const meta   = await BIDSRecording.loadRecordingMetadata(url);
      const reader = await EEGLABReader.open(meta);
      return { reader, fs: reader.sampling_frequency, n_samples: reader.n_samples };
    },
  },
];

const WINDOW_SECS = [2, 10, 30];

// ---- bench setup ------------------------------------------------

// Build readers up-front. Tasks fail gracefully if a fixture can't be
// opened (network down, recording moved, etc.) — the corresponding tasks
// are simply not added to the bench.
const opened = [];
const openErrors = [];
for (const fixture of FIXTURES) {
  try {
    const { reader, fs, n_samples } = await fixture.build();
    opened.push({ ...fixture, reader, fs, n_samples });
    console.log(`opened: ${fixture.key}  ${reader.n_channels}ch  fs=${fs}Hz  dur=${(n_samples/fs).toFixed(0)}s`);
  } catch (err) {
    openErrors.push({ key: fixture.key, error: err.message });
    console.warn(`SKIP ${fixture.key}: ${err.message}`);
  }
}

if (openErrors.length) {
  console.warn(`\n${openErrors.length} fixture(s) skipped — proceeding with the rest.`);
}

const bench = makeBench();

for (const fixture of opened) {
  for (const windowSec of WINDOW_SECS) {
    const windowSamples = Math.round(fixture.fs * windowSec);
    if (windowSamples > fixture.n_samples) {
      console.log(`SKIP ${fixture.key}_${windowSec}s — recording too short`);
      continue;
    }
    // Each task instance gets its own offset counter so successive
    // iterations target different parts of the file, defeating any
    // in-memory range cache the reader might keep.
    const maxStart = Math.max(1, fixture.n_samples - windowSamples);
    let cursor = 0;
    const stride = Math.max(1, Math.floor(maxStart / 32));
    const name = `${fixture.key}_${windowSec}s`;
    const { reader } = fixture;
    bench.add(name, async () => {
      const startSample = cursor % maxStart;
      cursor += stride;
      await reader.readWindow(startSample, windowSamples);
    });
  }
}

console.log(`\n=== readwindow.tinybench.mjs ===`);
console.log(`Network bench. BENCH_TIME=${process.env.BENCH_TIME || '1000'}ms per task.`);

if (bench.tasks.length === 0) {
  console.warn('No fixtures opened successfully — emitting empty results.');
}

await runAndEmit(bench, 'bench/results-readwindow.json', 'bench/results-readwindow-gab.json');
