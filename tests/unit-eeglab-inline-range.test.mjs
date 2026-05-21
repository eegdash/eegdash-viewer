// Range-based inline EEGLAB .set test. Builds a synthetic MAT v5
// payload representing an EEG struct with nbchan=2 + srate=100 +
// data=[2, 25] (50 floats), serves it via a tracked rangeFetch mock,
// and asserts that:
//   1. openInlineSet fetches MUCH less than the whole file when the
//      file is large enough to exceed the metadata-budget window.
//   2. readWindow only fetches the column slice — not the full data.
import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { EEGLABReader, HttpRange } from './_bootstrap.mjs';

// Reuse the matv5 helpers from unit-matv5-scan in inline form.
const miINT8   = 1;
const miINT32  = 5;
const miUINT32 = 6;
const miSINGLE = 7;
const miDOUBLE = 9;
const miMATRIX = 14;
const mxSINGLE = 7;
const mxDOUBLE = 6;
const pad8 = (n) => n % 8 === 0 ? 0 : 8 - (n % 8);

function writeLong(view, off, type, payload) {
  view.setUint32(off, type, true);
  view.setUint32(off + 4, payload.length, true);
  new Uint8Array(view.buffer, view.byteOffset + off + 8, payload.length).set(payload);
  return off + 8 + payload.length + pad8(payload.length);
}
function writeHeader(view) {
  const text = 'MATLAB 5.0 MAT-file inline-range test';
  for (let i = 0; i < text.length; i++) view.setUint8(i, text.charCodeAt(i));
  view.setUint16(124, 0x0100, true);
  view.setUint16(126, 0x4D49, true);
}
function arrayFlags(mxClass) {
  const b = new ArrayBuffer(8); const v = new DataView(b);
  v.setUint32(0, mxClass, true); v.setUint32(4, 0, true);
  return new Uint8Array(b);
}
function i32(values) { return new Uint8Array(new Int32Array(values).buffer); }
function f32(values) { return new Uint8Array(new Float32Array(values).buffer); }
function f64(values) { return new Uint8Array(new Float64Array(values).buffer); }
function ascii(s) { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }

function makeMatrix(mxClass, dims, name, realDataMiType, realDataPayload) {
  const sub = (t, p) => 8 + p.length + pad8(p.length);
  const total = sub(miUINT32, arrayFlags(mxClass)) + sub(miINT32, i32(dims)) + sub(miINT8, ascii(name)) + sub(realDataMiType, realDataPayload);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  let o = 0;
  o = writeLong(v, o, miUINT32, arrayFlags(mxClass));
  o = writeLong(v, o, miINT32,  i32(dims));
  o = writeLong(v, o, miINT8,   ascii(name));
  o = writeLong(v, o, realDataMiType, realDataPayload);
  return out;
}

function buildInlineSet() {
  // Generate 25 samples × 2 channels of synthetic data in column-major
  // order (data[chan, sample] @ sample*nchan + chan).
  const dataVals = new Float32Array(25 * 2);
  for (let s = 0; s < 25; s++) for (let c = 0; c < 2; c++) dataVals[s * 2 + c] = s * 0.1 + c * 0.01;
  const sMat   = makeMatrix(mxDOUBLE, [1, 1],  'srate',  miDOUBLE, f64([100]));
  const nMat   = makeMatrix(mxDOUBLE, [1, 1],  'nbchan', miDOUBLE, f64([2]));
  const pMat   = makeMatrix(mxDOUBLE, [1, 1],  'pnts',   miDOUBLE, f64([25]));
  const tMat   = makeMatrix(mxDOUBLE, [1, 1],  'trials', miDOUBLE, f64([1]));
  const dataMat = makeMatrix(mxSINGLE, [2, 25], 'data',  miSINGLE, new Uint8Array(dataVals.buffer));
  const matrices = [sMat, nMat, pMat, tMat, dataMat];
  // Each miMATRIX wraps payload in 8-byte long-form tag.
  const total = 128 + matrices.reduce((acc, m) => acc + 8 + m.length, 0);
  const buf = new ArrayBuffer(total);
  const v = new DataView(buf);
  writeHeader(v);
  let off = 128;
  for (const m of matrices) off = writeLong(v, off, miMATRIX, m);
  return buf;
}

let mockSource;
let rangeRequestLog;
beforeEach(() => {
  mockSource = buildInlineSet();
  rangeRequestLog = [];
  // probeLength: return totalBytes only for the .set URL; 404 for
  // anything else (especially the implicit .fdt sibling probe).
  globalThis.HttpRange.probeLength = async (url) => {
    if (url.endsWith('.set')) return mockSource.byteLength;
    const err = new Error(`HTTP 404 (mock) for ${url}`);
    throw err;
  };
  globalThis.HttpRange.rangeFetch  = async (url, s, e) => {
    if (!url.endsWith('.set')) throw new Error(`unexpected rangeFetch to ${url}`);
    rangeRequestLog.push({ start: s, end: e });
    return mockSource.slice(s, e + 1);
  };
});

test('eeglab inline range: openInlineSet exposes n_channels, sampling_frequency, n_samples', async () => {
  const reader = await EEGLABReader.open({ eeg_url: 'mock://inline.set' });
  assert.equal(reader.n_channels, 2);
  assert.equal(reader.sampling_frequency, 100);
  assert.equal(reader.n_samples, 25);
});

test('eeglab inline range: readWindow returns correct column slice', async () => {
  const reader = await EEGLABReader.open({ eeg_url: 'mock://inline.set' });
  const win = await reader.readWindow(0, 5);
  assert.equal(win.length, 2);
  for (let c = 0; c < 2; c++) {
    for (let s = 0; s < 5; s++) {
      assert.ok(Math.abs(win[c][s] - (s * 0.1 + c * 0.01)) < 1e-5);
    }
  }
});

test('eeglab inline range: readWindow only fetches the slice bytes', async () => {
  const reader = await EEGLABReader.open({ eeg_url: 'mock://inline.set' });
  rangeRequestLog.length = 0;
  await reader.readWindow(0, 5);
  const fetched = rangeRequestLog.reduce((a, r) => a + (r.end - r.start + 1), 0);
  // 5 samples × 2 chans × 4 bytes = 40 bytes (allow small overhead).
  assert.ok(fetched <= 100, `readWindow fetched ${fetched}B for 40B slice`);
});

test('eeglab inline range: openInlineSet handles files larger than the metadata budget by scanning the head', async () => {
  // Verify by probing: if probeLength reports 100 MB but the actual
  // buffer is 1 KB, open should still succeed because all metadata
  // is in the first 16 MB.
  const real = mockSource;
  globalThis.HttpRange.probeLength = async (url) => {
    if (url.endsWith('.set')) return 100 * 1024 * 1024;
    throw new Error(`HTTP 404 (mock) for ${url}`);
  };
  globalThis.HttpRange.rangeFetch  = async (url, s, e) => {
    if (!url.endsWith('.set')) throw new Error(`unexpected rangeFetch to ${url}`);
    if (s >= real.byteLength) {
      throw new Error(`unexpected range fetch [${s}..${e}] past real source end ${real.byteLength}`);
    }
    return real.slice(s, Math.min(e + 1, real.byteLength));
  };
  const reader = await EEGLABReader.open({ eeg_url: 'mock://inline-large.set' });
  assert.equal(reader.n_channels, 2);
  assert.equal(reader.n_samples, 25);
});
