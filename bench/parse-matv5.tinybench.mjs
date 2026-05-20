// Tinybench-based version of parse-matv5.bench.mjs.
//
// Benchmarks the full inline-set parse pipeline (MatV5.parse +
// extractEegInline + optional Float32 conversion) and raw parse-only
// throughput on 1/10/50 MB matrices. Fixture sizes match the original
// bench so the new numbers are comparable to the existing baseline:
//   - matv5_pipeline_{32ch_250hz_30s,64ch_512hz_60s,64ch_1000hz_120s}_{single,double}
//   - matv5_parse_raw_{1MB,10MB,50MB}
//
// Output: bench/results-parse-matv5.json + bench/results-parse-matv5-gab.json.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeBench, runAndEmit } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const MatV5 = require(path.join(__dirname, '..', 'formats', '_matv5.js'));

// ---- MAT v5 buffer builder (identical to parse-matv5.bench.mjs) -

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

function buildInlineEegSet(nCh, fs, dur_s, { dataClass = 'single' } = {}) {
  const nPts    = Math.round(fs * dur_s);
  const dataF32 = new Float32Array(nCh * nPts);
  for (let i = 0; i < nCh * nPts; i++) dataF32[i] = Math.sin(i * 0.001) * 50 + (i % 256) * 0.01;

  let dataMxClass, dataPayload, dataType;
  if (dataClass === 'single') {
    dataMxClass  = mxSINGLE;
    dataType     = miSINGLE;
    dataPayload  = new Uint8Array(dataF32.buffer);
  } else {
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

function buildRawSinglePayload(nSamples) {
  const dataF32 = new Float32Array(nSamples);
  for (let i = 0; i < nSamples; i++) dataF32[i] = (i % 4096) * 0.1;
  const dataPayload = new Uint8Array(dataF32.buffer);
  const matP   = makeMatrixPayload(mxSINGLE, [1, nSamples], 'data', miSINGLE, dataPayload);
  const rawBuf = new ArrayBuffer(128 + 8 + matP.length + pad8(matP.length) + 8 * 4);
  const rawV   = new DataView(rawBuf);
  writeHeader(rawV);
  writeLongElement(rawV, 128, miMATRIX, matP);
  return rawBuf;
}

// ---- bench setup ------------------------------------------------

const bench = makeBench();

// Inline-set pipeline benchmarks (parse + extractEegInline + Float32 cast)
const INLINE_CONFIGS = [
  { nCh: 32, fs: 250,  dur: 30,  dataClass: 'single' },
  { nCh: 64, fs: 512,  dur: 60,  dataClass: 'single' },
  { nCh: 64, fs: 1000, dur: 120, dataClass: 'single' },
  { nCh: 64, fs: 1000, dur: 120, dataClass: 'double' },
];

for (const { nCh, fs, dur, dataClass } of INLINE_CONFIGS) {
  // Build once outside the task — the bench measures parse-time, not
  // fixture-build time (matches the old bench loop).
  const buf = buildInlineEegSet(nCh, fs, dur, { dataClass });
  const name = `matv5_pipeline_${nCh}ch_${fs}hz_${dur}s_${dataClass}`;
  bench.add(name, async () => {
    const vars = await MatV5.parse(buf);
    const eeg = MatV5.extractEegInline(vars);
    const data32 = eeg.dataClass === 'single' ? eeg.data : Float32Array.from(eeg.data);
    void data32.length;
  });
}

// Raw parse-only benchmarks (1/10/50 MB single-variable buffers)
const RAW_SIZES = [
  { label: '1MB',  nSamples: Math.floor((1  * 1024 * 1024) / 4) },
  { label: '10MB', nSamples: Math.floor((10 * 1024 * 1024) / 4) },
  { label: '50MB', nSamples: Math.floor((50 * 1024 * 1024) / 4) },
];

for (const { label, nSamples } of RAW_SIZES) {
  const rawBuf = buildRawSinglePayload(nSamples);
  bench.add(`matv5_parse_raw_${label}`, async () => {
    await MatV5.parse(rawBuf);
  });
}

console.log('=== parse-matv5.tinybench.mjs ===');
console.log(`BENCH_TIME=${process.env.BENCH_TIME || '1000'}ms  (matv5 parse pipeline + raw parse)`);

await runAndEmit(bench, 'bench/results-parse-matv5.json', 'bench/results-parse-matv5-gab.json');
