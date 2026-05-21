// scanElements walks the top-level stream of a MAT v5 buffer and
// returns per-element headers WITHOUT decoding the (potentially
// huge) data payload. This is the metadata-only path the inline-set
// EEGLAB reader uses to find EEG.data's byte range so it can range-
// fetch slices instead of the whole file.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MatV5 } from './_bootstrap.mjs';

// Same primitives the existing matv5 tests use.
const miINT8   = 1;
const miINT32  = 5;
const miUINT32 = 6;
const miSINGLE = 7;
const miDOUBLE = 9;
const miMATRIX = 14;
const mxDOUBLE = 6;
const mxSINGLE = 7;

function pad8(n) { return n % 8 === 0 ? 0 : 8 - (n % 8); }

function writeLong(view, off, type, payload) {
  view.setUint32(off, type, true);
  view.setUint32(off + 4, payload.length, true);
  new Uint8Array(view.buffer, view.byteOffset + off + 8, payload.length).set(payload);
  return off + 8 + payload.length + pad8(payload.length);
}

function writeHeader(view) {
  const text = 'MATLAB 5.0 MAT-file scanElements test';
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

function int32Payload(values) { return new Uint8Array(new Int32Array(values).buffer); }
function singlesPayload(values) { return new Uint8Array(new Float32Array(values).buffer); }
function doublesPayload(values) { return new Uint8Array(new Float64Array(values).buffer); }

function asciiPayload(s) {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

// Build a matrix payload: [flags, dims, name, realData].
function makeMatrixPayload(mxClass, dims, name, realDataMiType, realDataPayload) {
  const flagsBytes = arrayFlagsPayload(mxClass);
  const dimsBytes  = int32Payload(dims);
  const nameBytes  = asciiPayload(name);
  // Each sub-element is a tag (8) + padded payload.
  const subSize = (type, payload) => 8 + payload.length + pad8(payload.length);
  const totalSubBytes =
    subSize(miUINT32, flagsBytes) +
    subSize(miINT32,  dimsBytes)  +
    subSize(miINT8,   nameBytes)  +
    subSize(realDataMiType, realDataPayload);
  const out = new Uint8Array(totalSubBytes);
  const v = new DataView(out.buffer);
  let off = 0;
  off = writeLong(v, off, miUINT32, flagsBytes);
  off = writeLong(v, off, miINT32,  dimsBytes);
  off = writeLong(v, off, miINT8,   nameBytes);
  off = writeLong(v, off, realDataMiType, realDataPayload);
  return out;
}

test('matv5 scan: returns metadata for every top-level matrix', async () => {
  // Build a buffer with 3 matrices: srate (scalar double), nbchan (scalar double),
  // data (2×4 single = 8 floats).
  const srateBytes  = makeMatrixPayload(mxDOUBLE, [1, 1],          'srate',  miDOUBLE, doublesPayload([100]));
  const nbchanBytes = makeMatrixPayload(mxDOUBLE, [1, 1],          'nbchan', miDOUBLE, doublesPayload([2]));
  const dataBytes   = makeMatrixPayload(mxSINGLE, [2, 4],          'data',   miSINGLE, singlesPayload([1,2,3,4,5,6,7,8]));
  // Each top-level miMATRIX is wrapped in an 8-byte tag (long-form) +
  // padded payload. With padded-payload bytes already accounted for in
  // makeMatrixPayload's return length, total = 8 + payload.length per
  // matrix (no extra padding since sub-elements are already padded
  // to 8-byte boundaries).
  const totalMat = srateBytes.length + nbchanBytes.length + dataBytes.length + 3 * 8;
  const buf = new ArrayBuffer(128 + totalMat);
  const v   = new DataView(buf);
  writeHeader(v);
  let off = 128;
  off = writeLong(v, off, miMATRIX, srateBytes);
  off = writeLong(v, off, miMATRIX, nbchanBytes);
  off = writeLong(v, off, miMATRIX, dataBytes);
  assert.equal(off, buf.byteLength, 'no trailing bytes — buf is sized exactly');

  const scan = MatV5.scanElements(buf);
  assert.equal(scan.length, 3, 'three top-level elements');

  const byName = Object.fromEntries(scan.map(e => [e.name, e]));
  assert.ok(byName.srate,  'srate element found');
  assert.ok(byName.nbchan, 'nbchan element found');
  assert.ok(byName.data,   'data element found');

  assert.deepEqual(byName.data.dims, [2, 4]);
  assert.equal(byName.data.mxClass, mxSINGLE);
  assert.equal(byName.data.dataSubMiType, miSINGLE);
  assert.equal(byName.data.dataSubBytes, 32);  // 8 floats × 4
  // The data sub-element payload must be at a specific absolute offset
  // within `buf`. Verify by reading those bytes back and getting the
  // same values as the input.
  const f32 = new Float32Array(buf, byName.data.dataSubOffset, byName.data.dataSubBytes / 4);
  assert.equal(f32[0], 1);
  assert.equal(f32[7], 8);
});

test('matv5 scan: rejects v7.3 files with a clear error', () => {
  const buf = new ArrayBuffer(128);
  const v = new DataView(buf);
  writeHeader(v);
  v.setUint16(124, 0x0200, true);
  assert.throws(() => MatV5.scanElements(buf), /v7\.3|HDF5/);
});

test('matv5 scan: rejects buffers shorter than 128 B', () => {
  assert.throws(() => MatV5.scanElements(new ArrayBuffer(64)), /too short/);
});
