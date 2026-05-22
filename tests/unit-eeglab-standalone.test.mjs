// Regression tests for the BIDS-strict-relaxation fix in formats/eeglab.js.
// Before: standalone inline `.set` files (no `_channels.tsv` sidecar) were
// rejected with "EEGLAB .fdt reader needs _channels.tsv (we skip .set
// parsing)" even though the inline-data path can derive nbchan + srate
// directly from the MAT struct itself.
//
// After: the BIDS-strict gate only fires on the .fdt-split path (where
// there really is no other source for those values). Standalone inline
// .set files open cleanly with Ch1..ChN labels.
//
// Surfaced by attempting to load mne-testing-data's test_raw_2021.set
// against the live reader.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EEGLABReader, HttpRange } from './_bootstrap.mjs';

// Reuse the spec primitives + helpers from unit-eeglab-inline.test.mjs.
// Duplicating the small set rather than refactoring into a shared module
// keeps each test file standalone-runnable.

const miINT8   = 1;
const miINT32  = 5;
const miUINT32 = 6;
const miSINGLE = 7;
const miDOUBLE = 9;
const miMATRIX = 14;
const mxDOUBLE = 6;
const mxSINGLE = 7;

const pad8 = (n) => (n % 8 === 0) ? 0 : 8 - (n % 8);

function writeLongElement(view, off, type, payload) {
  view.setUint32(off, type, true);
  view.setUint32(off + 4, payload.length, true);
  new Uint8Array(view.buffer, view.byteOffset + off + 8, payload.length).set(payload);
  return off + 8 + payload.length + pad8(payload.length);
}

function writeHeader(view) {
  const text = 'MATLAB 5.0 MAT-file EEGLAB standalone test';
  for (let i = 0; i < text.length; i++) view.setUint8(i, text.charCodeAt(i));
  view.setUint16(124, 0x0100, true);
  view.setUint16(126, 0x4D49, true);
}

function arrayFlagsPayload(mxClass) {
  const buf = new ArrayBuffer(8);
  const v = new DataView(buf);
  v.setUint32(0, mxClass, true);
  v.setUint32(4, 0, true);
  return new Uint8Array(buf);
}
function int32ArrayPayload(values) { return new Uint8Array(new Int32Array(values).buffer); }
function doublesPayload(values)    { return new Uint8Array(new Float64Array(values).buffer); }
function singlesPayload(values)    { return new Uint8Array(new Float32Array(values).buffer); }
function asciiPayload(s) {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

function numericMatrixPayload({ name, mxClass, dims, dataPayload, dataType }) {
  const flags = arrayFlagsPayload(mxClass);
  const dimsP = int32ArrayPayload(dims);
  const nameP = asciiPayload(name);
  const sub = [
    { type: miUINT32, payload: flags },
    { type: miINT32,  payload: dimsP },
    { type: miINT8,   payload: nameP },
    { type: dataType, payload: dataPayload },
  ];
  let total = 0;
  for (const s of sub) total += 8 + s.payload.length + pad8(s.payload.length);
  const payload = new Uint8Array(total);
  const view = new DataView(payload.buffer);
  let off = 0;
  for (const s of sub) off = writeLongElement(view, off, s.type, s.payload);
  return payload;
}

function multiMatrixFile(matrices) {
  const payloads = matrices.map(m => numericMatrixPayload(m));
  const totalSize = 128 + payloads.reduce((s, p) => s + 8 + p.length + pad8(p.length), 0);
  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  writeHeader(view);
  let off = 128;
  for (const p of payloads) off = writeLongElement(view, off, miMATRIX, p);
  return buf;
}

let blobCounter = 0;
function registerBuf(buf) {
  const filename = `test-standalone-${blobCounter++}.set`;
  const blob = new Blob([new Uint8Array(buf)], { type: 'application/octet-stream' });
  return HttpRange.registerLocal(filename, blob);
}

// Meta with NO channels and NO eeg_json sampling_frequency — the state
// you get when the user drops a standalone .set file (no BIDS layout)
// or browses to one on a non-BIDS dataset.
function makeStandaloneMeta(buf) {
  return {
    eeg_url: registerBuf(buf),
    prefix: 'test',
    dir: 'https://localdrop.invalid/',
    ext: 'set',
    sibling_urls: {},  // no .fdt → falls through to inline path
    channels: null,    // no _channels.tsv
    eeg_json: {        // no _eeg.json — empty stub
      sampling_frequency: null,
      recording_duration: null,
      eeg_reference: null,
      power_line_frequency: null,
      software_filters: null,
      manufacturer: null,
      raw: {},
    },
  };
}

// Inline .set with no BIDS sidecars: the reader must derive everything
// from the MAT struct. Pre-fix this would throw at the BIDS gate; post-
// fix it opens and serves windows with Ch1..ChN labels.
test('open: standalone inline .set (no _channels.tsv) opens with Ch1..ChN labels', async () => {
  const nCh = 4, nPts = 120;
  const vals = Array.from({ length: nCh * nPts }, (_, i) => (i % 7) - 3);
  const buf = multiMatrixFile([
    { name: 'data',   mxClass: mxSINGLE, dims: [nCh, nPts],
      dataPayload: singlesPayload(vals), dataType: miSINGLE },
    { name: 'srate',  mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([200]), dataType: miDOUBLE },
    { name: 'nbchan', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nCh]), dataType: miDOUBLE },
    { name: 'pnts',   mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nPts]), dataType: miDOUBLE },
    { name: 'trials', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([1]), dataType: miDOUBLE },
  ]);
  const rec = await EEGLABReader.open(makeStandaloneMeta(buf));
  assert.equal(rec.n_channels, nCh);
  assert.equal(rec.n_samples, nPts);
  assert.equal(rec.sampling_frequency, 200);
  // Fallback labels when no _channels.tsv is provided
  assert.deepEqual(rec.channel_labels, ['Ch1', 'Ch2', 'Ch3', 'Ch4']);
  // bids_channels remains null (faithful provenance: no sidecar was read)
  assert.equal(rec.bids_channels, null);
});

test('open: standalone .set readWindow returns expected sample values', async () => {
  const nCh = 3, nPts = 50;
  // Distinguishable per-channel pattern so we can verify de-interleaving:
  // data is column-major (channels-major), so flat[s*nCh + c] = chan c at sample s.
  const vals = new Array(nCh * nPts);
  for (let s = 0; s < nPts; s++) {
    for (let c = 0; c < nCh; c++) {
      vals[s * nCh + c] = c * 1000 + s;
    }
  }
  const buf = multiMatrixFile([
    { name: 'data',   mxClass: mxSINGLE, dims: [nCh, nPts],
      dataPayload: singlesPayload(vals), dataType: miSINGLE },
    { name: 'srate',  mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([100]), dataType: miDOUBLE },
    { name: 'nbchan', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nCh]), dataType: miDOUBLE },
    { name: 'pnts',   mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nPts]), dataType: miDOUBLE },
    { name: 'trials', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([1]), dataType: miDOUBLE },
  ]);
  const rec = await EEGLABReader.open(makeStandaloneMeta(buf));
  const win = await rec.readWindow(10, 5);
  // Channel 0 at samples 10..14 should be [10, 11, 12, 13, 14]
  assert.deepEqual(Array.from(win[0]), [10, 11, 12, 13, 14]);
  // Channel 1 should be [1010, 1011, 1012, 1013, 1014]
  assert.deepEqual(Array.from(win[1]), [1010, 1011, 1012, 1013, 1014]);
  // Channel 2 should be [2010, 2011, 2012, 2013, 2014]
  assert.deepEqual(Array.from(win[2]), [2010, 2011, 2012, 2013, 2014]);
});

test('open: inline .set ignores sidecar nbchan when it disagrees (warn only)', async () => {
  // Construct a .set saying nbchan=2 inside but provide channels[]
  // claiming 5 channels. The .set is the authority — viewer should
  // open with n_channels=2, not 5.
  const nCh = 2, nPts = 20;
  const vals = Array.from({ length: nCh * nPts }, () => 0);
  const buf = multiMatrixFile([
    { name: 'data',   mxClass: mxSINGLE, dims: [nCh, nPts],
      dataPayload: singlesPayload(vals), dataType: miSINGLE },
    { name: 'srate',  mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([128]), dataType: miDOUBLE },
    { name: 'nbchan', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nCh]), dataType: miDOUBLE },
    { name: 'pnts',   mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nPts]), dataType: miDOUBLE },
    { name: 'trials', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([1]), dataType: miDOUBLE },
  ]);
  const meta = {
    eeg_url: registerBuf(buf),
    prefix: 'test',
    dir: 'https://localdrop.invalid/',
    ext: 'set',
    sibling_urls: {},
    channels: Array.from({ length: 5 }, (_, i) => ({
      name: `Sidecar${i}`, index: i, type: 'EEG', units: 'uV', status: 'good',
    })),
    eeg_json: { sampling_frequency: 128, recording_duration: null, raw: {} },
  };
  // suppress the warn while opening
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const rec = await EEGLABReader.open(meta);
    assert.equal(rec.n_channels, 2);
    // labels fall back to Ch1..ChN because sidecar length didn't match
    assert.deepEqual(rec.channel_labels, ['Ch1', 'Ch2']);
  } finally {
    console.warn = origWarn;
  }
});

test('open: split .set+.fdt with truncated .fdt accepts floor() samples with warning', async () => {
  // ds003570/ds003751 in the wild: .fdt is truncated mid-sample. The
  // .set declares (nbchan, pnts) that would imply more bytes than the
  // .fdt actually contains. Pre-fix: hard-rejected with "size is not a
  // multiple of N×4". Post-fix: warn + use floor(bytes/recordSize) samples.
  //
  // Construct a .set saying nbchan=4 (16-byte records) and a .fdt that
  // has 100 complete records + 5 trailing bytes (truncated). Expect
  // open() to succeed with n_samples=100 and a console.warn.
  const nCh = 4, nPts = 100;
  const recordSize = nCh * 4;
  const fdtBytes = nPts * recordSize + 5;   // 5 trailing bytes
  const fdtArr = new Float32Array(nPts * nCh);
  for (let s = 0; s < nPts; s++) {
    for (let c = 0; c < nCh; c++) fdtArr[s * nCh + c] = s + c * 1000;
  }
  const fdtFull = new Uint8Array(fdtBytes);
  fdtFull.set(new Uint8Array(fdtArr.buffer), 0);
  const fdtBlob = new Blob([fdtFull], { type: 'application/octet-stream' });
  const fdtUrl = HttpRange.registerLocal(`trunc-test-${blobCounter++}.fdt`, fdtBlob);

  // Minimal valid .set declaring nbchan=4, srate=128, pnts=200 (file
  // would have 200 samples if not truncated; we have 100).
  const buf = multiMatrixFile([
    { name: 'nbchan', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nCh]), dataType: miDOUBLE },
    { name: 'srate',  mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([128]), dataType: miDOUBLE },
    { name: 'pnts',   mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([200]), dataType: miDOUBLE },
    { name: 'trials', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([1]), dataType: miDOUBLE },
  ]);
  const setUrl = registerBuf(buf);
  // Sibling lookup is by `${prefix}_eeg.fdt`. Pick a fresh prefix and
  // register the fdt against the matching key.
  const prefix = `trunc-test-${blobCounter++}`;
  const meta = {
    eeg_url: setUrl,
    prefix,
    dir: 'https://localdrop.invalid/',
    ext: 'set',
    sibling_urls: { [`${prefix}_eeg.fdt`]: fdtUrl },
    channels: null,
    eeg_json: { sampling_frequency: 128, raw: {} },
  };
  const origWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(msg);
  try {
    const rec = await EEGLABReader.open(meta);
    assert.equal(rec.n_channels, nCh);
    assert.equal(rec.n_samples, nPts, 'truncated to floor(bytes/recordSize)');
    assert.ok(warnings.some(w => /trailing|truncated|not a multiple/.test(w)),
      `expected a truncation warning, got: ${warnings.join(' | ')}`);
  } finally {
    console.warn = origWarn;
  }
});

test('open: split .set + .fdt path no longer requires _channels.tsv (parses .set instead)', async () => {
  // As of the ds003645/ds003751 fix: when the sidecar is missing,
  // we parse the .set itself to derive nbchan/srate. This test verifies
  // both the success and failure paths:
  //  (a) bogus .set (not parseable) + no sidecar → "need either sidecar
  //      or parseable .set" combined-source error
  //  (b) The error message no longer mentions "_channels.tsv" exclusively
  const fdtBlob = new Blob([new Uint8Array(16)], { type: 'application/octet-stream' });
  const fdtUrl = HttpRange.registerLocal(`split-test-${blobCounter++}.fdt`, fdtBlob);
  const setBlob = new Blob([new Uint8Array(128)], { type: 'application/octet-stream' });
  const setUrl = HttpRange.registerLocal(`split-test-${blobCounter++}.set`, setBlob);
  const meta = {
    eeg_url: setUrl,
    prefix: 'split-test',
    dir: 'https://localdrop.invalid/',
    ext: 'set',
    sibling_urls: { 'split-test_eeg.fdt': fdtUrl },
    channels: null,
    eeg_json: { sampling_frequency: 256, raw: {} },
  };
  await assert.rejects(
    () => EEGLABReader.open(meta),
    /need either parseable \.set with EEG\.nbchan \+ EEG\.srate OR _channels\.tsv \+ _eeg\.json/,
  );
});
