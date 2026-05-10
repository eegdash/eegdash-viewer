// Unit tests for the EEGLAB openInlineSet code path.
// Uses synthetic MAT v5 buffers built from the same primitives as
// unit-matv5.test.mjs — no network required.
//
// openInlineSet is private inside eeglab.js but its observable
// surface is the object returned by EEGLABReader.open() when the
// .fdt is absent. We exercise it through a mock meta object whose
// eeg_url points to a registered in-memory blob, and whose
// HttpRange.probeLength / rangeFetch calls are satisfied by the
// local-blob URL registration already in _bootstrap.mjs.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MatV5, EEGLABReader, HttpRange } from './_bootstrap.mjs';

// ----- spec primitives (duplicated from unit-matv5 for readability) --

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
  const text = 'MATLAB 5.0 MAT-file EEGLAB inline test';
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

// ----- helpers to register buffers as local blobs ----------------
// The HttpRange module exposes registerLocal for drag-drop testing;
// we reuse it to feed in-memory MAT buffers without a real server.

let blobCounter = 0;
function registerBuf(buf) {
  const filename = `test-inline-${blobCounter++}.set`;
  const blob = new Blob([new Uint8Array(buf)], { type: 'application/octet-stream' });
  return HttpRange.registerLocal(filename, blob);
}

// Minimal meta object for openInlineSet: no sibling_urls means no .fdt
// candidate, so open() falls through to the inline path. Channels and
// eeg_json fields must satisfy the guard at the top of api.open().
function makeMeta(buf, { nChannels = 2, srate = 256, channelNames } = {}) {
  const url = registerBuf(buf);
  const labels = channelNames ?? Array.from({ length: nChannels }, (_, i) => `Ch${i + 1}`);
  return {
    eeg_url: url,
    prefix: 'test',
    dir: 'https://localdrop.invalid/',
    ext: 'set',
    // Pretend no .fdt exists: sibling_urls present but empty so the
    // resolveFdtUrl path returns null.
    sibling_urls: {},
    channels: labels.map((name, index) => ({ name, index, type: 'EEG', units: 'uV', status: 'good' })),
    eeg_json: {
      sampling_frequency: srate,
      recording_duration: null,
      eeg_reference: null,
      power_line_frequency: null,
      software_filters: null,
      manufacturer: null,
      raw: {},
    },
  };
}

// ----- tests -------------------------------------------------------

test('openInlineSet: basic mxSINGLE data opens cleanly', async () => {
  const nCh = 2, nPts = 100;
  const vals = Array.from({ length: nCh * nPts }, (_, i) => i * 0.1);
  const buf = multiMatrixFile([
    { name: 'data',   mxClass: mxSINGLE, dims: [nCh, nPts],
      dataPayload: singlesPayload(vals), dataType: miSINGLE },
    { name: 'srate',  mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([256]), dataType: miDOUBLE },
    { name: 'nbchan', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nCh]),   dataType: miDOUBLE },
    { name: 'pnts',   mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nPts]),   dataType: miDOUBLE },
    { name: 'trials', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([1]),   dataType: miDOUBLE },
  ]);
  const meta = makeMeta(buf, { nChannels: nCh, srate: 256 });
  const rec = await EEGLABReader.open(meta);
  assert.equal(rec.n_channels, nCh);
  assert.equal(rec.n_samples, nPts);
  assert.equal(rec.sampling_frequency, 256);
  assert.equal(rec.bytes_per_sample, 4);
  assert.ok(typeof rec.readWindow === 'function');
});

test('openInlineSet: mxDOUBLE data is converted to Float32 in-memory', async () => {
  // The inline path always normalises to Float32Array (matches .fdt path assumption).
  const nCh = 2, nPts = 50;
  const vals = Array.from({ length: nCh * nPts }, (_, i) => i * 0.01);
  const buf = multiMatrixFile([
    { name: 'data',   mxClass: mxDOUBLE, dims: [nCh, nPts],
      dataPayload: doublesPayload(vals), dataType: miDOUBLE },
    { name: 'srate',  mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([512]), dataType: miDOUBLE },
    { name: 'nbchan', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nCh]),   dataType: miDOUBLE },
    { name: 'pnts',   mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nPts]),   dataType: miDOUBLE },
    { name: 'trials', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([1]),   dataType: miDOUBLE },
  ]);
  const meta = makeMeta(buf, { nChannels: nCh, srate: 512 });
  const rec = await EEGLABReader.open(meta);
  // readWindow returns ChannelBuffers (array of Float32Array)
  const win = await rec.readWindow(0, 10);
  assert.equal(win.length, nCh);
  assert.equal(win[0].constructor.name, 'Float32Array');
  assert.equal(win[0].length, 10);
});

test('openInlineSet: 3D epoched data sets trials_hint', async () => {
  // dims = [nCh, nPts, nTrials] — epoched; viewer v1 flattens to continuous
  const nCh = 2, nPts = 10, nTrials = 5;
  const nElem = nCh * nPts * nTrials;
  const vals = Array.from({ length: nElem }, (_, i) => i);
  const buf = multiMatrixFile([
    { name: 'data',   mxClass: mxSINGLE, dims: [nCh, nPts, nTrials],
      dataPayload: singlesPayload(vals), dataType: miSINGLE },
    { name: 'srate',  mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([256]), dataType: miDOUBLE },
    { name: 'nbchan', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nCh]),   dataType: miDOUBLE },
    { name: 'pnts',   mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nPts]),   dataType: miDOUBLE },
    { name: 'trials', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nTrials]),   dataType: miDOUBLE },
  ]);
  const meta = makeMeta(buf, { nChannels: nCh, srate: 256 });
  const rec = await EEGLABReader.open(meta);
  assert.equal(rec.trials_hint, nTrials);
  // Flat n_samples = pnts × trials
  assert.equal(rec.n_samples, nPts * nTrials);
});

test('openInlineSet: sidecar nbchan disagrees with EEG.nbchan — warns, .set wins', async () => {
  // Sidecar says 3 channels, but the .set declares 2 — .set should win.
  const nCh = 2, nPts = 10;
  const vals = Array.from({ length: nCh * nPts }, (_, i) => i);
  const buf = multiMatrixFile([
    { name: 'data',   mxClass: mxSINGLE, dims: [nCh, nPts],
      dataPayload: singlesPayload(vals), dataType: miSINGLE },
    { name: 'srate',  mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([256]), dataType: miDOUBLE },
    { name: 'nbchan', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nCh]),   dataType: miDOUBLE },
    { name: 'pnts',   mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nPts]),   dataType: miDOUBLE },
    { name: 'trials', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([1]),   dataType: miDOUBLE },
  ]);
  const sidecarNChannels = 3;  // deliberately wrong
  const meta = makeMeta(buf, { nChannels: sidecarNChannels, srate: 256 });
  const rec = await EEGLABReader.open(meta);
  // .set's nbchan=2 wins
  assert.equal(rec.n_channels, nCh);
});

test('openInlineSet: sidecar srate disagrees with EEG.srate — warns, .set wins', async () => {
  // Sidecar says 128 Hz, .set says 256 Hz — .set wins.
  const nCh = 2, nPts = 10;
  const vals = Array.from({ length: nCh * nPts }, () => 0);
  const buf = multiMatrixFile([
    { name: 'data',   mxClass: mxSINGLE, dims: [nCh, nPts],
      dataPayload: singlesPayload(vals), dataType: miSINGLE },
    { name: 'srate',  mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([256]), dataType: miDOUBLE },
    { name: 'nbchan', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nCh]),   dataType: miDOUBLE },
    { name: 'pnts',   mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nPts]),   dataType: miDOUBLE },
    { name: 'trials', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([1]),   dataType: miDOUBLE },
  ]);
  const meta = makeMeta(buf, { nChannels: nCh, srate: 128 });  // sidecar claims 128
  const rec = await EEGLABReader.open(meta);
  assert.equal(rec.sampling_frequency, 256);  // .set wins
});

test('openInlineSet: readWindow at exactly EOF (start === n_samples) returns empty', async () => {
  const nCh = 2, nPts = 10;
  const vals = Array.from({ length: nCh * nPts }, () => 1);
  const buf = multiMatrixFile([
    { name: 'data',   mxClass: mxSINGLE, dims: [nCh, nPts],
      dataPayload: singlesPayload(vals), dataType: miSINGLE },
    { name: 'srate',  mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([256]), dataType: miDOUBLE },
    { name: 'nbchan', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nCh]),   dataType: miDOUBLE },
    { name: 'pnts',   mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nPts]),   dataType: miDOUBLE },
    { name: 'trials', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([1]),   dataType: miDOUBLE },
  ]);
  const meta = makeMeta(buf, { nChannels: nCh, srate: 256 });
  const rec = await EEGLABReader.open(meta);
  // At exactly EOF, readWindow should return an empty ChannelBuffers.
  const empty = await rec.readWindow(nPts, 100);
  assert.equal(empty.length, nCh);
  assert.equal(empty[0].length, 0);
});

test('openInlineSet: readWindow with negative start clamps to 0', async () => {
  const nCh = 2, nPts = 20;
  const vals = Array.from({ length: nCh * nPts }, (_, i) => i);
  const buf = multiMatrixFile([
    { name: 'data',   mxClass: mxSINGLE, dims: [nCh, nPts],
      dataPayload: singlesPayload(vals), dataType: miSINGLE },
    { name: 'srate',  mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([256]), dataType: miDOUBLE },
    { name: 'nbchan', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nCh]),   dataType: miDOUBLE },
    { name: 'pnts',   mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nPts]),   dataType: miDOUBLE },
    { name: 'trials', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([1]),   dataType: miDOUBLE },
  ]);
  const meta = makeMeta(buf, { nChannels: nCh, srate: 256 });
  const rec = await EEGLABReader.open(meta);
  // start = -5 should be treated as start = 0
  const win = await rec.readWindow(-5, 5);
  assert.equal(win.length, nCh);
  // 5 samples starting from sample 0 (vals[0..4] for ch0, vals[nPts..nPts+4] for ch1)
  // column-major: data[chan, sample] → flat index = sample * nCh + chan
  assert.equal(win[0].length, 5);
  // The flat data is column-major: index = sample * nCh + chan
  assert.ok(Math.abs(win[0][0] - vals[0 * nCh + 0]) < 1e-5);
});

test('openInlineSet: pnts scalar disagrees with data dims → rejects with data length error', async () => {
  // data dims = [2, 4] but pnts scalar = 10 → expectedLen=20 ≠ data32.length=8
  const nCh = 2, nPts = 4;
  const vals = Array.from({ length: nCh * nPts }, (_, i) => i);
  const buf = multiMatrixFile([
    { name: 'data',   mxClass: mxSINGLE, dims: [nCh, nPts],
      dataPayload: singlesPayload(vals), dataType: miSINGLE },
    { name: 'srate',  mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([256]), dataType: miDOUBLE },
    { name: 'nbchan', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([nCh]),   dataType: miDOUBLE },
    // pnts scalar says 10 but data only has 4 columns → length mismatch
    { name: 'pnts',   mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([10]), dataType: miDOUBLE },
    { name: 'trials', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([1]),   dataType: miDOUBLE },
  ]);
  const meta = makeMeta(buf, { nChannels: nCh, srate: 256 });
  await assert.rejects(
    () => EEGLABReader.open(meta),
    /data length.*!=.*nbchan.*pnts.*trials/
  );
});

test('openInlineSet: 404 on the .set URL rejects with clear error', async () => {
  const url = 'https://localdrop.invalid/nonexistent-404-inline.set';
  // Do NOT register this URL in the blob store — probeLength should throw HTTP 404
  const meta = {
    eeg_url: url,
    prefix: 'test', dir: 'https://localdrop.invalid/', ext: 'set',
    sibling_urls: {},
    channels: [{ name: 'Ch1', index: 0, type: 'EEG', units: 'uV', status: 'good' }],
    eeg_json: {
      sampling_frequency: 256,
      recording_duration: null, eeg_reference: null,
      power_line_frequency: null, software_filters: null, manufacturer: null, raw: {},
    },
  };
  await assert.rejects(
    () => EEGLABReader.open(meta),
    (err) => {
      // Should propagate some kind of fetch/HTTP error
      assert.ok(err instanceof Error);
      return true;
    }
  );
});
