// Cross-format integration suite.
//
// What this covers (beyond the per-format bitwise smokes):
//   1. Breadth — every reader against multiple OpenNeuro recordings.
//   2. Boundary — head, mid, tail, past-EOF, zero-length, negative.
//   3. AbortController — the rapid-pan path bails with AbortError.
//   4. Concurrency — N loads in parallel don't cross-contaminate.
//   5. eegdash fallback — ds002336 sidecars resolve via the inheritance
//      walk (newly fixed) without bricking the BV header path.
//
// Run with:  node scripts/integration.mjs
// Network-bound — first run ~60-90s, re-runs faster (HTTP cache).
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
require('../bids-loader.js');
require('../formats/_buffers.js');
require('../formats/_http_range.js');
const BIDSRecording = require('../bids-recording.js');
require('../formats/eeglab.js');
require('../formats/edf.js');
require('../formats/brainvision.js');

const READERS = {
  set:  globalThis.EEGLABReader,
  edf:  globalThis.EDFReader,
  bdf:  globalThis.EDFReader,
  vhdr: globalThis.BrainVisionReader,
};

// Matrix: format/dataset/sub/ses/task/run. All on OpenNeuro S3 with
// CORS+Range; chosen to span sample rates (250-5000 Hz), channel counts
// (36-82), and at least one recording per format. EEGLAB recordings
// must have a sibling .fdt — datasets that embed data inside the .set
// MAT-file (ds003800, ds003061, ds004504) are intentionally excluded;
// the EEGLAB reader surfaces a clear error for those.
const MATRIX = [
  { fmt: 'set',  ds: 'ds002893', sub: '001',   task: 'AuditoryVisualShift', run: '01' },
  { fmt: 'set',  ds: 'ds003478', sub: '001',   task: 'Rest',                run: '01' },
  { fmt: 'set',  ds: 'ds003490', sub: '001',   ses: '01', task: 'Rest' },
  { fmt: 'edf',  ds: 'ds002034', sub: '01',    ses: '01', task: 'offline',  run: '01' },
  { fmt: 'vhdr', ds: 'ds002336', sub: 'xp101', task: 'motorloc' },
  { fmt: 'vhdr', ds: 'ds002336', sub: 'xp101', task: 'eegfmriNF' },
];

let pass = 0, fail = 0;
function check(name, ok, detail) {
  const tag = ok ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${tag}  ${name}${detail ? ': ' + detail : ''}`);
  if (ok) pass++; else fail++;
}

function isAllFinite(arr) {
  for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return false;
  return true;
}

function plausibleEegVoltage(arr) {
  // Reference-removed EEG sits in ±100 µV; raw EEG with DC offset can
  // reach ±10 mV. Accept anything inside that envelope; flag if every
  // sample is bigger than 1 V (almost certainly a unit/scale bug).
  for (let i = 0; i < arr.length; i++) if (Math.abs(arr[i]) < 1e6) return true;
  return false;
}

async function loadOne(spec) {
  const url = BIDSRecording.buildOpenNeuroEegUrl({
    dataset: spec.ds, sub: spec.sub, ses: spec.ses,
    task: spec.task, run: spec.run, ext: spec.fmt,
  });
  const t0 = performance.now();
  const meta = await BIDSRecording.loadRecordingMetadata(url);
  const tMeta = performance.now() - t0;
  const Reader = READERS[meta.ext];
  if (!Reader) throw new Error(`No reader for ext "${meta.ext}"`);
  const reader = await Reader.open(meta);
  const tOpen = performance.now() - t0;
  return { url, meta, reader, tMeta, tOpen };
}

// ----- 1. Breadth + boundary --------------------------------

async function testRecording(spec) {
  const tag = `${spec.ds}/${spec.task}${spec.run ? '/' + spec.run : ''}`;
  let r;
  try {
    r = await loadOne(spec);
  } catch (err) {
    check(`${tag} :: load`, false, err.message);
    return null;
  }
  const { meta, reader, tMeta, tOpen } = r;
  const N = 100;

  // Head.
  const head = await reader.readWindow(0, N);
  check(`${tag} :: head shape`,
    head.length === reader.n_channels && head[0].length === N);
  check(`${tag} :: head finite`, head.every(isAllFinite));
  check(`${tag} :: head plausible voltage`,
    head.slice(0, Math.min(3, head.length)).every(plausibleEegVoltage));

  // Mid.
  const midStart = Math.floor(reader.n_samples / 2);
  const mid = await reader.readWindow(midStart, N);
  check(`${tag} :: mid shape`, mid.every(ch => ch.length === N));
  check(`${tag} :: mid != head`,
    head.some((h, c) => h.some((v, s) => v !== mid[c][s])));

  // Tail.
  const tailStart = Math.max(0, reader.n_samples - N);
  const tail = await reader.readWindow(tailStart, N);
  check(`${tag} :: tail shape`, tail.every(ch => ch.length === N));

  // Past EOF — every reader must return zero-length channels, never throw.
  const past = await reader.readWindow(reader.n_samples + 1000, N);
  check(`${tag} :: past-EOF returns 0-length`, past.every(ch => ch.length === 0));

  // Zero-length window is a no-op.
  const zero = await reader.readWindow(0, 0);
  check(`${tag} :: zero-length returns 0-length`, zero.every(ch => ch.length === 0));

  // Negative start clamps to 0 (callers may overshoot during pan).
  const neg = await reader.readWindow(-50, N);
  check(`${tag} :: negative-start does not throw`,
    neg.length === reader.n_channels);

  console.log(`         ${reader.n_channels}ch · ${reader.sampling_frequency}Hz · ${reader.duration_s.toFixed(0)}s · meta ${tMeta.toFixed(0)}ms · open ${tOpen.toFixed(0)}ms`);
  return r;
}

// ----- 2. AbortController correctness ----------------------

async function testAbort(spec) {
  const tag = `${spec.ds}/${spec.task} :: abort`;
  const { reader } = await loadOne(spec);
  // Fire two reads, abort the first immediately. The second must
  // complete normally; the first must reject with AbortError. Exercises
  // the same path the page hits when the user pans rapidly.
  const ctrl1 = new AbortController();
  const p1 = reader.readWindow(0, 1000, { signal: ctrl1.signal });
  ctrl1.abort();

  let aborted = false;
  try { await p1; } catch (e) { aborted = e.name === 'AbortError'; }
  check(`${tag} aborted promise rejects with AbortError`, aborted);

  const ctrl2 = new AbortController();
  const win = await reader.readWindow(2000, 1000, { signal: ctrl2.signal });
  check(`${tag} subsequent read still resolves`, win[0].length === 1000);
}

// ----- 3. Concurrent loads -----------------------------------

async function testConcurrent() {
  const subset = MATRIX.slice(0, 4);
  const t0 = performance.now();
  // allSettled so a single dataset failure surfaces as a check, not a
  // crash that prevents the rest of the suite from running.
  const results = await Promise.allSettled(subset.map(loadOne));
  const t = performance.now() - t0;
  const ok = results.filter(r => r.status === 'fulfilled');
  check(`concurrent: ${subset.length}/${subset.length} parallel loads succeeded`,
    ok.length === subset.length,
    ok.length === subset.length ? null
      : results.filter(r => r.status === 'rejected').map(r => r.reason.message).join('; '));
  const seenUrls = new Set(ok.map(r => r.value.reader.url));
  check(`concurrent: produces distinct readers`, seenUrls.size === ok.length);
  const serialMs = ok.reduce((s, r) => s + r.value.tOpen, 0);
  console.log(`         ${ok.length} parallel loads · ${t.toFixed(0)}ms wall (vs sum ~${serialMs.toFixed(0)}ms serial)`);
}

// ----- 4. eegdash fallback exercise -------------------------

async function testEegdashFallback() {
  // ds002336 puts every sidecar at the dataset root with task-level
  // entity stripping. The recently-fixed inheritance walk should find
  // them — with the eegdash dep_keys fallback as the safety net.
  const url = BIDSRecording.buildOpenNeuroEegUrl({
    dataset: 'ds002336', sub: 'xp101', task: 'eegfmriNF', ext: 'vhdr',
  });
  const meta = await BIDSRecording.loadRecordingMetadata(url);
  check('ds002336 :: _eeg.json found via inheritance walk',
    meta.eeg_json.sampling_frequency === 5000);
  check('ds002336 :: _channels.tsv found',
    meta.channels && meta.channels.length === 64);
  check('ds002336 :: _events.tsv found',
    meta.events.length > 0);
  check('ds002336 :: sidecar source paths point to dataset root', !!(
    meta.sidecar_sources.eeg_json   && meta.sidecar_sources.eeg_json.endsWith('task-eegfmriNF_eeg.json') &&
    meta.sidecar_sources.channels   && meta.sidecar_sources.channels.endsWith('task-eegfmriNF_channels.tsv')
  ));
}

// ----- 5. stress patterns -----------------------------------

// Rapid abort: simulate the "user pans frantically" path. Fire 20
// readWindow calls back-to-back with the prior one aborted, then let
// the last one resolve. The hot-path invariants we want to hold:
//   - no unhandled promise rejection
//   - exactly one read produces real data; the rest reject AbortError
//   - the reader's internal state isn't corrupted by the rapid churn
async function stressRapidAbort() {
  const { reader } = await loadOne(MATRIX[0]);
  const N = 20;
  const fs = reader.sampling_frequency;
  const windowSamples = Math.floor(fs * 5);    // 5 s at native fs
  const ctrls = [];
  const promises = [];
  for (let i = 0; i < N; i++) {
    const c = new AbortController();
    ctrls.push(c);
    const start = Math.floor(Math.random() * (reader.n_samples - windowSamples));
    promises.push(reader.readWindow(start, windowSamples, { signal: c.signal }));
  }
  // Abort all but the last.
  for (let i = 0; i < N - 1; i++) ctrls[i].abort();

  const results = await Promise.allSettled(promises);
  const aborted = results.slice(0, N - 1).filter(r =>
    r.status === 'rejected' && r.reason && r.reason.name === 'AbortError');
  const last = results[N - 1];
  check(`stress: ${N - 1}/${N - 1} aborted reads rejected with AbortError`,
    aborted.length === N - 1);
  check(`stress: surviving read resolved`, last.status === 'fulfilled');
  check(`stress: surviving read returned full window`,
    last.status === 'fulfilled' && last.value[0].length === windowSamples);
}

// Large window: pull a 60-second pan from a high-rate recording. For
// ds002336 (5 kHz × 64 ch × 60 s × 2 B = ~38 MB) this exercises the
// big-buffer path: range fetch, deinterleave, allocChannelViews. We
// just want it to complete without OOM and produce finite values.
async function stressLargeWindow() {
  const { reader } = await loadOne(MATRIX.find(s => s.fmt === 'vhdr'));
  const fs = reader.sampling_frequency;
  const windowSamples = Math.min(reader.n_samples, Math.floor(fs * 60));
  const t0 = performance.now();
  const win = await reader.readWindow(Math.floor(reader.n_samples / 4), windowSamples);
  const t = performance.now() - t0;
  const bytesIn = windowSamples * reader.n_channels * reader.bytes_per_sample;
  check(`stress: 60s window shape`,
    win.length === reader.n_channels && win[0].length === windowSamples);
  check(`stress: 60s window finite`, win.every(isAllFinite));
  console.log(`         ${(bytesIn / 1e6).toFixed(1)} MB pulled · ${t.toFixed(0)}ms · ${(bytesIn / t / 1e3).toFixed(1)} MB/s`);
}

// Many small windows at random offsets: stresses the cache-miss path
// when the user's pan target keeps changing. Each read is small, but
// they share no locality, so the HTTP cache can't help.
async function stressManyWindows() {
  const { reader } = await loadOne(MATRIX[0]);
  const N = 30;
  const fs = reader.sampling_frequency;
  const windowSamples = Math.floor(fs * 0.5);  // 0.5 s
  const t0 = performance.now();
  let bytesTotal = 0;
  for (let i = 0; i < N; i++) {
    const start = Math.floor(Math.random() * (reader.n_samples - windowSamples));
    const win = await reader.readWindow(start, windowSamples);
    if (win[0].length !== windowSamples) {
      check(`stress: many-windows iteration ${i} shape`, false);
      return;
    }
    bytesTotal += windowSamples * reader.n_channels * (reader.bytes_per_sample || 4);
  }
  const t = performance.now() - t0;
  check(`stress: ${N} sequential disjoint reads completed`, true);
  console.log(`         ${N}× 0.5s windows · ${t.toFixed(0)}ms total (${(t / N).toFixed(0)}ms/read) · ${(bytesTotal / 1e6).toFixed(1)} MB`);
}

// ----- main --------------------------------------------------

(async function () {
  console.log('\n=== 1. multi-dataset breadth + boundary ===');
  for (const spec of MATRIX) await testRecording(spec);

  console.log('\n=== 2. AbortController ===');
  await testAbort(MATRIX[0]);

  console.log('\n=== 3. concurrent loads ===');
  await testConcurrent();

  console.log('\n=== 4. eegdash inheritance / fallback ===');
  await testEegdashFallback();

  console.log('\n=== 5. stress: rapid abort ===');
  await stressRapidAbort();

  console.log('\n=== 6. stress: large window (60s) ===');
  await stressLargeWindow();

  console.log('\n=== 7. stress: 30 disjoint reads ===');
  await stressManyWindows();

  console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` (${fail} failed)` : ''}`);
  process.exit(fail ? 1 : 0);
})();
