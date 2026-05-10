/**
 * bench/parse-matv5.bench.mjs — MatV5 inline-set parse pipeline benchmark
 *
 * Benchmarks the complete inline-data .set parse pipeline:
 *   MatV5.parse()  →  MatV5.extractEegInline()  →  Float32Array.from()
 * on hand-built buffers mimicking realistic inline EEG .set files:
 *   small:  32ch × 250 Hz × 30 s  ≈ 0.9 MB
 *   medium: 64ch × 512 Hz × 60 s  ≈ 7.5 MB
 *   large:  64ch × 1000 Hz × 120 s ≈ 29 MB
 *
 * Also benchmarks raw MatV5.parse() on large numeric buffers (1/10/50 MB)
 * to expose parsing overhead independent of type-conversion.
 *
 * Reports p50 / p95 over 10 iterations per size.
 * No network I/O — all data is built in-memory.
 *
 * Run:  node bench/parse-matv5.bench.mjs
 */

import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const MatV5 = require(path.join(__dirname, '..', 'formats', '_matv5.js'));

// ---- MAT v5 buffer builder ---------------------------------------

const miINT8   = 1;
const miINT32  = 5;
const miUINT32 = 6;
const miSINGLE = 7;
const miDOUBLE = 9;
const miMATRIX = 14;

const mxSINGLE = 7;
const mxDOUBLE = 6;

const pad8 = (n) => (n % 8 === 0) ? 0 : 8 - (n % 8);

function writeHeader(view) {
  const text = 'MATLAB 5.0 MAT-file Bench';
  for (let i = 0; i < text.length; i++) view.setUint8(i, text.charCodeAt(i));
  view.setUint16(124, 0x0100, true);
  view.setUint16(126, 0x4d49, true);
}

function writeLongElement(view, off, type, payload) {
  view.setUint32(off, type, true);
  view.setUint32(off + 4, payload.length, true);
  new Uint8Array(view.buffer, view.byteOffset + off + 8, payload.length).set(payload);
  return off + 8 + payload.length + pad8(payload.length);
}

function makeMatrixPayload(mxClass, dims, name, dataType, dataPayload) {
  const flags = new Uint8Array(8);
  flags[0] = mxClass;
  const dimsP  = new Uint8Array(new Int32Array(dims).buffer);
  const nameP  = new Uint8Array(name.length);
  for (let i = 0; i < name.length; i++) nameP[i] = name.charCodeAt(i);
  const parts = [
    { t: miUINT32, p: flags },
    { t: miINT32,  p: dimsP },
    { t: miINT8,   p: nameP },
    { t: dataType, p: dataPayload },
  ];
  let sz = 0;
  for (const p of parts) sz += 8 + p.p.length + pad8(p.p.length);
  const buf = new ArrayBuffer(sz);
  const view = new DataView(buf);
  let off = 0;
  for (const { t, p } of parts) off = writeLongElement(view, off, t, p);
  return new Uint8Array(buf);
}

/**
 * Build a realistic inline EEG .set buffer containing:
 *   data   (mxSINGLE, [nCh × nPts])
 *   srate  (mxDOUBLE, scalar)
 *   nbchan (mxDOUBLE, scalar)
 *   pnts   (mxDOUBLE, scalar)
 *   trials (mxDOUBLE, scalar)
 */
function buildInlineEegSet(nCh, fs, dur_s, { dataClass = 'single' } = {}) {
  const nPts    = Math.round(fs * dur_s);
  const dataF32 = new Float32Array(nCh * nPts);
  // Fill with sin waves to avoid trivial zero-page optimisations
  for (let i = 0; i < nCh * nPts; i++) dataF32[i] = Math.sin(i * 0.001) * 50 + (i % 256) * 0.01;

  let dataMxClass, dataPayload, dataType;
  if (dataClass === 'single') {
    dataMxClass  = mxSINGLE;
    dataType     = miSINGLE;
    dataPayload  = new Uint8Array(dataF32.buffer);
  } else {
    // Double: 8 bytes/sample — heavier conversion load
    dataMxClass  = mxDOUBLE;
    dataType     = miDOUBLE;
    const f64    = Float64Array.from(dataF32);
    dataPayload  = new Uint8Array(f64.buffer);
  }

  function scalarMat(name, value) {
    return makeMatrixPayload(mxDOUBLE, [1, 1], name, miDOUBLE,
      new Uint8Array(new Float64Array([value]).buffer));
  }

  const matrices = [
    makeMatrixPayload(dataMxClass, [nCh, nPts], 'data', dataType, dataPayload),
    scalarMat('srate',  fs),
    scalarMat('nbchan', nCh),
    scalarMat('pnts',   nPts),
    scalarMat('trials', 1),
  ];

  let totalData = 0;
  for (const m of matrices) totalData += 8 + m.length + pad8(m.length);

  const buf  = new ArrayBuffer(128 + totalData);
  const view = new DataView(buf);
  writeHeader(view);
  let off = 128;
  for (const m of matrices) off = writeLongElement(view, off, miMATRIX, m);
  return buf;
}

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

// ---- main -------------------------------------------------------

const ITERATIONS = 10;

console.log('=== parse-matv5.bench.mjs ===');
console.log(`Iterations: ${ITERATIONS}`);
console.log('Measures: MatV5.parse + extractEegInline + Float32 conversion (= full inline-set pipeline)');
console.log('');

const results = {};

// --- Inline-set pipeline benchmarks (realistic EEG sizes) --------

const INLINE_CONFIGS = [
  { label: 'small  (32ch × 250Hz × 30s, single)', nCh: 32,  fs: 250,  dur: 30,  dataClass: 'single' },
  { label: 'medium (64ch × 512Hz × 60s, single)',  nCh: 64,  fs: 512,  dur: 60,  dataClass: 'single' },
  { label: 'large  (64ch × 1000Hz × 120s, single)',nCh: 64,  fs: 1000, dur: 120, dataClass: 'single' },
  { label: 'large  (64ch × 1000Hz × 120s, double)',nCh: 64,  fs: 1000, dur: 120, dataClass: 'double' },
];

console.log('--- inline-set pipeline (parse + extract + type-convert) ---');
for (const { label, nCh, fs, dur, dataClass } of INLINE_CONFIGS) {
  const buf = buildInlineEegSet(nCh, fs, dur, { dataClass });
  const mb  = (buf.byteLength / 1024 / 1024).toFixed(1);

  const times = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    const vars  = await MatV5.parse(buf);
    const eeg   = MatV5.extractEegInline(vars);
    // This is the cost the eeglab.js openInlineSet path pays for non-single data
    const data32 = eeg.dataClass === 'single' ? eeg.data : Float32Array.from(eeg.data);
    void data32.length;  // prevent dead-code elimination
    times.push(performance.now() - t0);
  }

  const s   = stats(times);
  // Key uses nCh, fs, dur for uniqueness; strip spaces
  const key = `matv5_pipeline_${nCh}ch_${fs}hz_${dur}s_${dataClass}`;
  results[key] = { p50_ms: s.p50, p95_ms: s.p95 };
  console.log(`${label} (${mb} MB): p50=${s.p50}ms  p95=${s.p95}ms  min=${s.min}ms  max=${s.max}ms`);
}

console.log('');
console.log('--- raw parse only (1/10/50 MB single-variable buffers) ---');

// These isolate the parser's iteration cost independent of data shape
const RAW_SIZES = [
  { label: '1MB',  bytes: 1  * 1024 * 1024 },
  { label: '10MB', bytes: 10 * 1024 * 1024 },
  { label: '50MB', bytes: 50 * 1024 * 1024 },
];

for (const { label, bytes } of RAW_SIZES) {
  // One big flat numeric matrix — parser must iterate the element list once
  const nSamples   = Math.floor(bytes / 4);
  const dataF32    = new Float32Array(nSamples);
  for (let i = 0; i < nSamples; i++) dataF32[i] = (i % 4096) * 0.1;
  const buf = buildInlineEegSet(1, 1, nSamples, { dataClass: 'single' });  // reuse builder
  // Simpler: just wrap one big matrix
  const dataPayload = new Uint8Array(dataF32.buffer);
  const matP   = makeMatrixPayload(mxSINGLE, [1, nSamples], 'data', miSINGLE, dataPayload);
  const rawBuf = new ArrayBuffer(128 + 8 + matP.length + pad8(matP.length) + 8*4);
  const rawV   = new DataView(rawBuf);
  writeHeader(rawV);
  writeLongElement(rawV, 128, miMATRIX, matP);
  const actualMB = (rawBuf.byteLength / 1024 / 1024).toFixed(1);

  const times = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    await MatV5.parse(rawBuf);
    times.push(performance.now() - t0);
  }
  const s   = stats(times);
  const key = `matv5_parse_raw_${label}`;
  results[key] = { p50_ms: s.p50, p95_ms: s.p95 };
  console.log(`parse ${label} (${actualMB} MB): p50=${s.p50}ms  p95=${s.p95}ms  min=${s.min}ms  max=${s.max}ms`);
}

console.log('');

const meta = {
  bench: 'parse-matv5',
  captured_at: new Date().toISOString(),
  host_arch: os.arch(),
  node_version: process.version,
};

console.log('Results JSON:');
console.log(JSON.stringify({ ...meta, results }, null, 2));

export { results, meta };
