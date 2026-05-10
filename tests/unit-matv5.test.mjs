// Hand-built MAT v5 buffers test the parser without going to the
// network. Each test constructs a minimal valid buffer, asserts the
// extracted shape, and exercises one branch of the format spec
// (small vs long element format, struct wrapping, char arrays,
// numeric class dispatch).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MatV5 } from './_bootstrap.mjs';

// ----- spec primitives -------------------------------------------

const miINT8     = 1;
const miINT32    = 5;
const miUINT32   = 6;
const miSINGLE   = 7;
const miDOUBLE   = 9;
const miMATRIX   = 14;

const mxDOUBLE   = 6;
const mxSINGLE   = 7;
const mxCHAR     = 4;
const mxSTRUCT   = 2;

// Pads `n` up to the next multiple of 8 — every long-format element
// pads its payload to an 8-byte boundary.
const pad8 = (n) => (n % 8 === 0) ? 0 : 8 - (n % 8);

// Writes a long-format MAT element [type:u32 nbytes:u32 payload pad].
// Returns the new offset. `payload` is a Uint8Array.
function writeLongElement(view, off, type, payload) {
  view.setUint32(off, type, true);
  view.setUint32(off + 4, payload.length, true);
  new Uint8Array(view.buffer, view.byteOffset + off + 8, payload.length).set(payload);
  return off + 8 + payload.length + pad8(payload.length);
}

// Writes a small-format element [nbytes:u16 type:u16 payload≤4 pad].
// Used for tiny array-flag / dim payloads.
function writeSmallElement(view, off, type, payload) {
  if (payload.length > 4) throw new Error('small format payload must be ≤ 4 bytes');
  view.setUint16(off, payload.length, true);
  view.setUint16(off + 2, type, true);
  new Uint8Array(view.buffer, view.byteOffset + off + 4, payload.length).set(payload);
  return off + 8;  // small format always consumes exactly 8 bytes
}

// 128-byte MAT v5 header: text + version 0x0100 + endian 0x4D49.
function writeHeader(view) {
  const text = 'MATLAB 5.0 MAT-file Test Buffer';
  for (let i = 0; i < text.length; i++) view.setUint8(i, text.charCodeAt(i));
  view.setUint16(124, 0x0100, true);
  view.setUint16(126, 0x4D49, true);
}

// Bytes of an array-flags subelement: low byte of word0 = mxClass.
function arrayFlagsPayload(mxClass) {
  const buf = new ArrayBuffer(8);
  const v = new DataView(buf);
  v.setUint32(0, mxClass, true);
  v.setUint32(4, 0, true);
  return new Uint8Array(buf);
}

function int32ArrayPayload(values) {
  const a = new Int32Array(values);
  return new Uint8Array(a.buffer);
}

function doublesPayload(values) {
  const a = new Float64Array(values);
  return new Uint8Array(a.buffer);
}

function singlesPayload(values) {
  const a = new Float32Array(values);
  return new Uint8Array(a.buffer);
}

function asciiPayload(s) {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

// Builds a single miMATRIX (numeric, 1D-or-2D, real-only) with the
// given name and Float32 data. Returns the raw payload bytes (caller
// wraps in the outer miMATRIX tag).
function numericMatrixPayload({ name, mxClass, dims, dataPayload, dataType }) {
  // Subelement layout: array flags | dims | name | data
  // We use long-format throughout for predictability.
  let total = 0;
  const flags = arrayFlagsPayload(mxClass);
  const dimsP = int32ArrayPayload(dims);
  const nameP = asciiPayload(name);
  const sub = [
    { type: miUINT32, payload: flags },
    { type: miINT32,  payload: dimsP },
    { type: miINT8,   payload: nameP },
    { type: dataType, payload: dataPayload },
  ];
  for (const s of sub) total += 8 + s.payload.length + pad8(s.payload.length);
  const payload = new Uint8Array(total);
  const view = new DataView(payload.buffer);
  let off = 0;
  for (const s of sub) {
    off = writeLongElement(view, off, s.type, s.payload);
  }
  return payload;
}

function buildSingleMatrixFile({ name, mxClass, dims, dataPayload, dataType }) {
  const matrixPayload = numericMatrixPayload({ name, mxClass, dims, dataPayload, dataType });
  // Outer file: 128-byte header + tag(8) + matrixPayload.
  const buf = new ArrayBuffer(128 + 8 + matrixPayload.length + pad8(matrixPayload.length));
  const view = new DataView(buf);
  writeHeader(view);
  writeLongElement(view, 128, miMATRIX, matrixPayload);
  return buf;
}

// ----- tests ------------------------------------------------------

test('parse: header rejects wrong endianness', async () => {
  const buf = new ArrayBuffer(256);
  const view = new DataView(buf);
  writeHeader(view);
  view.setUint16(126, 0x4949, true);  // big-endian indicator
  await assert.rejects(() => MatV5.parse(buf), /not little-endian/);
});

test('parse: header rejects MAT v7.3 (HDF5)', async () => {
  const buf = new ArrayBuffer(256);
  const view = new DataView(buf);
  writeHeader(view);
  view.setUint16(124, 0x0200, true);  // pretend v7.3
  await assert.rejects(() => MatV5.parse(buf), /unsupported MAT version/);
});

test('parse: a 2x3 single-class numeric matrix', async () => {
  const data = new Float32Array([1, 2, 3, 4, 5, 6]);  // column-major: shape [2, 3]
  const buf = buildSingleMatrixFile({
    name: 'X', mxClass: mxSINGLE, dims: [2, 3],
    dataPayload: new Uint8Array(data.buffer), dataType: miSINGLE,
  });
  const vars = await MatV5.parse(buf);
  assert.equal(vars.size, 1);
  const x = vars.get('X');
  assert.equal(x.class, 'single');
  assert.deepEqual(x.dims, [2, 3]);
  assert.equal(x.data.constructor.name, 'Float32Array');
  assert.deepEqual([...x.data], [1, 2, 3, 4, 5, 6]);
});

test('parse: scalar double', async () => {
  const buf = buildSingleMatrixFile({
    name: 'srate', mxClass: mxDOUBLE, dims: [1, 1],
    dataPayload: doublesPayload([512]), dataType: miDOUBLE,
  });
  const vars = await MatV5.parse(buf);
  const v = vars.get('srate');
  assert.equal(v.class, 'double');
  assert.equal(v.data[0], 512);
});

test('parse: char string variable', async () => {
  const text = 'hello';
  const buf = buildSingleMatrixFile({
    name: 'setname', mxClass: mxCHAR, dims: [1, text.length],
    dataPayload: asciiPayload(text), dataType: miINT8,
  });
  const vars = await MatV5.parse(buf);
  const v = vars.get('setname');
  assert.equal(v.class, 'char');
  assert.equal(v.data, 'hello');
});

// ----- extractEegInline ------------------------------------------

test('extractEegInline: top-level layout (data + scalar fields)', async () => {
  // Build a buffer with three named matrices: data (single, 2x4),
  // srate (double scalar), nbchan (double scalar). Mirrors the
  // BIDS-converted EEGLAB shape we observed in nm000121.
  function* concatBuffers(...buffers) {
    for (const b of buffers) yield new Uint8Array(b);
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
  const buf = multiMatrixFile([
    { name: 'data',   mxClass: mxSINGLE, dims: [2, 4],
      dataPayload: singlesPayload([1, 2, 3, 4, 5, 6, 7, 8]), dataType: miSINGLE },
    { name: 'srate',  mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([256]), dataType: miDOUBLE },
    { name: 'nbchan', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([2]),   dataType: miDOUBLE },
    { name: 'pnts',   mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([4]),   dataType: miDOUBLE },
    { name: 'trials', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([1]),   dataType: miDOUBLE },
  ]);
  const vars = await MatV5.parse(buf);
  const eeg = MatV5.extractEegInline(vars);
  assert.equal(eeg.nbchan, 2);
  assert.equal(eeg.pnts, 4);
  assert.equal(eeg.trials, 1);
  assert.equal(eeg.srate, 256);
  assert.equal(eeg.dataClass, 'single');
  assert.deepEqual([...eeg.data], [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('extractEegInline: missing data field surfaces a clear error', async () => {
  const buf = buildSingleMatrixFile({
    name: 'srate', mxClass: mxDOUBLE, dims: [1, 1],
    dataPayload: doublesPayload([256]), dataType: miDOUBLE,
  });
  const vars = await MatV5.parse(buf);
  assert.throws(
    () => MatV5.extractEegInline(vars),
    /missing `data`/
  );
});

test('extractEegInline: missing srate surfaces a clear error', async () => {
  const buf = buildSingleMatrixFile({
    name: 'data', mxClass: mxSINGLE, dims: [2, 4],
    dataPayload: singlesPayload([0,0,0,0,0,0,0,0]), dataType: miSINGLE,
  });
  const vars = await MatV5.parse(buf);
  assert.throws(
    () => MatV5.extractEegInline(vars),
    /srate missing/
  );
});
