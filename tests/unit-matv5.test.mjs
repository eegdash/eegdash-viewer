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
const miCOMPRESSED = 15;

const mxCELL     = 1;
const mxSTRUCT   = 2;
const mxOBJECT   = 3;
const mxCHAR     = 4;
const mxSPARSE   = 5;
const mxDOUBLE   = 6;
const mxSINGLE   = 7;

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
function arrayFlagsPayload(mxClass, { complex = false } = {}) {
  const buf = new ArrayBuffer(8);
  const v = new DataView(buf);
  const flagBits = complex ? 0x08 : 0;
  v.setUint32(0, mxClass | (flagBits << 8), true);
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

// Build a multi-variable file with named matrices
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

// Build a matrix payload for an unsupported mxClass (cell/sparse/object)
function unsupportedClassMatrixPayload({ name, mxClass, dims }) {
  const flags = arrayFlagsPayload(mxClass);
  const dimsP = int32ArrayPayload(dims);
  const nameP = asciiPayload(name);
  const sub = [
    { type: miUINT32, payload: flags },
    { type: miINT32,  payload: dimsP },
    { type: miINT8,   payload: nameP },
  ];
  let total = 0;
  for (const s of sub) total += 8 + s.payload.length + pad8(s.payload.length);
  const payload = new Uint8Array(total);
  const view = new DataView(payload.buffer);
  let off = 0;
  for (const s of sub) {
    off = writeLongElement(view, off, s.type, s.payload);
  }
  return payload;
}

function buildUnsupportedClassFile({ name, mxClass, dims }) {
  const matrixPayload = unsupportedClassMatrixPayload({ name, mxClass, dims });
  const buf = new ArrayBuffer(128 + 8 + matrixPayload.length + pad8(matrixPayload.length));
  const view = new DataView(buf);
  writeHeader(view);
  writeLongElement(view, 128, miMATRIX, matrixPayload);
  return buf;
}

// ----- original happy-path tests ---------------------------------

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
  // Surface an actionable error: tell the user how to re-save the file
  // in a supported format. Pre-fix the message was the generic
  // "unsupported MAT version" which left the user stuck.
  await assert.rejects(() => MatV5.parse(buf), /MAT v7\.3 \(HDF5\) format detected/);
  await assert.rejects(() => MatV5.parse(buf), /-v6/);
});

test('detectMatVersion: classifies v5 vs v7.3 from header', () => {
  const v5 = new ArrayBuffer(128);
  const dvV5 = new DataView(v5);
  dvV5.setUint16(124, 0x0100, true);
  dvV5.setUint16(126, 0x4d49, true);
  assert.equal(MatV5.detectMatVersion(v5), 'v5');

  const v7 = new ArrayBuffer(128);
  const dvV7 = new DataView(v7);
  dvV7.setUint16(124, 0x0200, true);
  dvV7.setUint16(126, 0x4d49, true);
  assert.equal(MatV5.detectMatVersion(v7), 'v7.3');

  // Too-short buffer: unknown rather than crash.
  assert.equal(MatV5.detectMatVersion(new ArrayBuffer(64)), 'unknown');
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

// ----- NEW EDGE CASE TESTS ----------------------------------------

// 1. Truncated buffers

test('parse: header-only buffer (128B) is valid but produces no vars', async () => {
  // A 128-byte header with no elements — should parse cleanly, empty map.
  const buf = new ArrayBuffer(128);
  const view = new DataView(buf);
  writeHeader(view);
  const vars = await MatV5.parse(buf);
  assert.equal(vars.size, 0);
});

test('parse: buffer smaller than 128 bytes rejects with clear error', async () => {
  const buf = new ArrayBuffer(100);
  const view = new DataView(buf);
  // Write partial header
  view.setUint16(100 - 4, 0x0100, true);
  await assert.rejects(() => MatV5.parse(buf), /too short for header/);
});

test('parse: buffer truncated mid-element-tag (header ok, element overruns)', async () => {
  // Build a valid header + start of a matrix element but truncate before payload.
  // The element declares nbytes=1000 but there are 0 bytes of payload.
  const buf = new ArrayBuffer(128 + 8);
  const view = new DataView(buf);
  writeHeader(view);
  // Write tag: type=14 (miMATRIX), nbytes=1000 — payload obviously overruns
  view.setUint32(128, 14, true);
  view.setUint32(132, 1000, true);
  // This will be caught by the bounds check in iterElements
  await assert.rejects(() => MatV5.parse(buf), /overruns container/);
});

test('parse: mid-payload truncation (nbytes claims more than actual buffer)', async () => {
  // Build a real single-var file, then chop 20 bytes off the end.
  const data = singlesPayload([1, 2, 3, 4]);
  const full = buildSingleMatrixFile({
    name: 'X', mxClass: mxSINGLE, dims: [2, 2],
    dataPayload: data, dataType: miSINGLE,
  });
  // Truncate: keep header + just 8 bytes of outer element tag = mid-payload
  const truncated = full.slice(0, 128 + 20);
  await assert.rejects(() => MatV5.parse(truncated), /overruns container/);
});

// 2. Wrong version / endianness (covered by originals above, add explicit big-endian)

test('parse: big-endian file rejected with informative hex in message', async () => {
  const buf = new ArrayBuffer(256);
  const view = new DataView(buf);
  writeHeader(view);
  view.setUint16(126, 0x4d4d, true);  // some other endian marker
  await assert.rejects(
    () => MatV5.parse(buf),
    (err) => {
      assert.match(err.message, /4d4d/i);
      return true;
    }
  );
});

// 3. Unsupported mxClass codes — should return data:null, NOT throw

test('parse: mxCELL class returns data:null, does not throw', async () => {
  const buf = buildUnsupportedClassFile({ name: 'cellarr', mxClass: mxCELL, dims: [1, 2] });
  const vars = await MatV5.parse(buf);
  const v = vars.get('cellarr');
  assert.ok(v, 'variable should be present');
  assert.equal(v.class, 'cell');
  assert.equal(v.data, null);
});

test('parse: mxSPARSE class returns data:null, does not throw', async () => {
  const buf = buildUnsupportedClassFile({ name: 'sp', mxClass: mxSPARSE, dims: [5, 5] });
  const vars = await MatV5.parse(buf);
  const v = vars.get('sp');
  assert.ok(v);
  assert.equal(v.class, 'sparse');
  assert.equal(v.data, null);
});

test('parse: mxOBJECT class returns data:null, does not throw', async () => {
  const buf = buildUnsupportedClassFile({ name: 'obj', mxClass: mxOBJECT, dims: [1, 1] });
  const vars = await MatV5.parse(buf);
  const v = vars.get('obj');
  assert.ok(v);
  assert.equal(v.class, 'object');
  assert.equal(v.data, null);
});

// 4. Complex flag rejection

test('parse: complex matrix throws "not supported"', async () => {
  // Build a double matrix with the complex flag set (bit 3 of flags byte)
  const flags = arrayFlagsPayload(mxDOUBLE, { complex: true });
  const dimsP = int32ArrayPayload([1, 1]);
  const nameP = asciiPayload('z');
  const dataP = doublesPayload([1.0]);
  const sub = [
    { type: miUINT32, payload: flags },
    { type: miINT32,  payload: dimsP },
    { type: miINT8,   payload: nameP },
    { type: miDOUBLE, payload: dataP },
  ];
  let total = 0;
  for (const s of sub) total += 8 + s.payload.length + pad8(s.payload.length);
  const matPayload = new Uint8Array(total);
  const pv = new DataView(matPayload.buffer);
  let off = 0;
  for (const s of sub) off = writeLongElement(pv, off, s.type, s.payload);

  const buf = new ArrayBuffer(128 + 8 + matPayload.length + pad8(matPayload.length));
  const view = new DataView(buf);
  writeHeader(view);
  writeLongElement(view, 128, miMATRIX, matPayload);

  await assert.rejects(() => MatV5.parse(buf), /complex.*not supported/i);
});

// 5. Element bounds overrun

test('parse: element nbytes declared larger than outer container throws', async () => {
  // Craft a matrix file where inner sub-element declares more bytes
  // than remain. We do this by truncating a valid file after outer tag.
  const data = singlesPayload([1, 2, 3, 4, 5, 6]);
  const matPayload = numericMatrixPayload({
    name: 'Y', mxClass: mxSINGLE, dims: [2, 3],
    dataPayload: data, dataType: miSINGLE,
  });
  // Corrupt the inner last sub-element (data element) to claim excessive nbytes.
  // The outer element tag for miMATRIX encloses matPayload. We corrupt in there.
  const buf = new ArrayBuffer(128 + 8 + matPayload.length + pad8(matPayload.length));
  const view = new DataView(buf);
  writeHeader(view);
  writeLongElement(view, 128, miMATRIX, matPayload);
  // Now artificially inflate the outer element nbytes field to exceed actual buffer
  view.setUint32(132, matPayload.length + 10000, true);
  await assert.rejects(() => MatV5.parse(buf), /overruns container/);
});

// 6. miCOMPRESSED happy path via CompressionStream/DecompressionStream

test('parse: miCOMPRESSED element decompresses and yields matrix', async () => {
  // Build the inner matrix bytes that would normally appear after the outer tag.
  const data = singlesPayload([10, 20, 30, 40]);
  const matPayload = numericMatrixPayload({
    name: 'compressed_var', mxClass: mxSINGLE, dims: [2, 2],
    dataPayload: data, dataType: miSINGLE,
  });
  // Wrap in an outer miMATRIX element (the inner element the compressor sees)
  const innerBuf = new ArrayBuffer(8 + matPayload.length + pad8(matPayload.length));
  const innerView = new DataView(innerBuf);
  writeLongElement(innerView, 0, miMATRIX, matPayload);
  const innerBytes = new Uint8Array(innerBuf);

  // Compress using CompressionStream (deflate = zlib raw stream)
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(innerBytes);
  writer.close();
  const reader = cs.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const compressed = new Uint8Array(total);
  let cOff = 0;
  for (const c of chunks) { compressed.set(c, cOff); cOff += c.length; }

  // Build a MAT file: header + miCOMPRESSED element wrapping compressed bytes
  const buf = new ArrayBuffer(128 + 8 + compressed.length + pad8(compressed.length));
  const view = new DataView(buf);
  writeHeader(view);
  writeLongElement(view, 128, miCOMPRESSED, compressed);

  const vars = await MatV5.parse(buf);
  const v = vars.get('compressed_var');
  assert.ok(v, 'compressed variable should be parsed');
  assert.equal(v.class, 'single');
  assert.deepEqual(v.dims, [2, 2]);
  assert.deepEqual([...v.data], [10, 20, 30, 40]);
});

// 7. Struct with multiple field name lengths

test('parse: struct with two fields', async () => {
  // Build a struct named "EEG" with fields srate (double scalar) and nbchan (double scalar).
  // Struct layout: array-flags (mxSTRUCT) | dims | name | fieldNameLen | fieldNames | field0 | field1
  const structName = 'EEG';
  const fieldNameLen = 8;  // padded width for all field names
  const fieldNames = ['srate', 'nbchan'];
  // Field names blob: each name padded to fieldNameLen with \0
  const namesBlob = new Uint8Array(fieldNames.length * fieldNameLen);
  for (let i = 0; i < fieldNames.length; i++) {
    for (let j = 0; j < fieldNames[i].length; j++) {
      namesBlob[i * fieldNameLen + j] = fieldNames[i].charCodeAt(j);
    }
  }

  // Each field is a nested miMATRIX
  const sratePayload = numericMatrixPayload({
    name: '', mxClass: mxDOUBLE, dims: [1, 1],
    dataPayload: doublesPayload([256]), dataType: miDOUBLE,
  });
  const nbchanPayload = numericMatrixPayload({
    name: '', mxClass: mxDOUBLE, dims: [1, 1],
    dataPayload: doublesPayload([32]), dataType: miDOUBLE,
  });

  // Build the struct payload
  const flagsP = arrayFlagsPayload(mxSTRUCT);
  const dimsP  = int32ArrayPayload([1, 1]);
  const nameP  = asciiPayload(structName);
  const fieldLenP = int32ArrayPayload([fieldNameLen]);

  const subs = [
    { type: miUINT32, payload: flagsP },
    { type: miINT32,  payload: dimsP },
    { type: miINT8,   payload: nameP },
    { type: miINT32,  payload: fieldLenP },
    { type: miINT8,   payload: namesBlob },
    { type: miMATRIX, payload: sratePayload },
    { type: miMATRIX, payload: nbchanPayload },
  ];
  let total = 0;
  for (const s of subs) total += 8 + s.payload.length + pad8(s.payload.length);
  const structPayload = new Uint8Array(total);
  const spv = new DataView(structPayload.buffer);
  let off = 0;
  for (const s of subs) off = writeLongElement(spv, off, s.type, s.payload);

  // Outer file
  const buf = new ArrayBuffer(128 + 8 + structPayload.length + pad8(structPayload.length));
  const bv = new DataView(buf);
  writeHeader(bv);
  writeLongElement(bv, 128, miMATRIX, structPayload);

  const vars = await MatV5.parse(buf);
  const eeg = vars.get('EEG');
  assert.ok(eeg);
  assert.equal(eeg.class, 'struct');
  assert.equal(eeg.data.get('srate').data[0], 256);
  assert.equal(eeg.data.get('nbchan').data[0], 32);
});

// 8. Numeric class / on-disk type mismatch (mxDOUBLE storing miSINGLE payload)

test('parse: mxDOUBLE with miSINGLE on-disk payload (EEGLAB optimisation) round-trips', async () => {
  // EEGLAB sometimes saves an mxDOUBLE matrix with miSINGLE payload to halve file size.
  // The parser should honour the on-disk type (miSINGLE → Float32Array).
  const data = singlesPayload([1.5, 2.5, 3.5, 4.5]);
  const buf = buildSingleMatrixFile({
    name: 'data', mxClass: mxDOUBLE,  // declared as double
    dims: [2, 2],
    dataPayload: data, dataType: miSINGLE,  // but stored as single
  });
  const vars = await MatV5.parse(buf);
  const v = vars.get('data');
  assert.ok(v, 'variable should be parsed');
  // The on-disk type wins: Float32Array (miSINGLE)
  assert.equal(v.data.constructor.name, 'Float32Array');
  assert.ok(Math.abs(v.data[0] - 1.5) < 1e-6);
  assert.ok(Math.abs(v.data[3] - 4.5) < 1e-6);
});

// 9. Numeric payload not a multiple of elemBytes

test('parse: payload length not multiple of elemBytes throws', async () => {
  // Build a file where the data sub-element has 7 bytes for miDOUBLE (8-byte elements)
  const flagsP  = arrayFlagsPayload(mxDOUBLE);
  const dimsP   = int32ArrayPayload([1, 1]);
  const nameP   = asciiPayload('x');
  const badData = new Uint8Array(7);  // 7 bytes for float64 = invalid

  const subs = [
    { type: miUINT32, payload: flagsP },
    { type: miINT32,  payload: dimsP  },
    { type: miINT8,   payload: nameP  },
    { type: miDOUBLE, payload: badData },
  ];
  let total = 0;
  for (const s of subs) total += 8 + s.payload.length + pad8(s.payload.length);
  const matPayload = new Uint8Array(total);
  const mpv = new DataView(matPayload.buffer);
  let off = 0;
  for (const s of subs) off = writeLongElement(mpv, off, s.type, s.payload);

  const buf = new ArrayBuffer(128 + 8 + matPayload.length + pad8(matPayload.length));
  const bv = new DataView(buf);
  writeHeader(bv);
  writeLongElement(bv, 128, miMATRIX, matPayload);

  await assert.rejects(() => MatV5.parse(buf), /not a multiple/);
});

// 10. Property-based fuzz: 50 randomised valid headers with varying dims/class/data

test('parse: fuzz 50 randomised single-variable files round-trip correctly', async () => {
  // Use a seeded-like deterministic sequence (no external random library needed).
  // Simple LCG for reproducibility.
  let seed = 0xdeadbeef;
  function nextInt(max) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % max;
  }

  const classes = [
    { mxClass: mxSINGLE, dataType: miSINGLE, ctor: Float32Array, bytesEach: 4, name: 'single' },
    { mxClass: mxDOUBLE, dataType: miDOUBLE, ctor: Float64Array, bytesEach: 8, name: 'double' },
  ];

  for (let i = 0; i < 50; i++) {
    const cls = classes[nextInt(classes.length)];
    const nRows = 1 + nextInt(8);   // 1..8
    const nCols = 1 + nextInt(16);  // 1..16
    const nElem = nRows * nCols;

    // Generate random values [-10, 10]
    const values = Array.from({ length: nElem }, () => (nextInt(200) - 100) / 10);
    const typed = new cls.ctor(values);
    const dataPayload = new Uint8Array(typed.buffer);

    const buf = buildSingleMatrixFile({
      name: 'fuzz',
      mxClass: cls.mxClass,
      dims: [nRows, nCols],
      dataPayload,
      dataType: cls.dataType,
    });

    const vars = await MatV5.parse(buf);
    const v = vars.get('fuzz');
    assert.ok(v, `fuzz iteration ${i}: variable missing`);
    assert.deepEqual(v.dims, [nRows, nCols], `fuzz iteration ${i}: dims mismatch`);
    assert.equal(v.data.length, nElem, `fuzz iteration ${i}: length mismatch`);
    // Round-trip: all values within float32 precision
    for (let j = 0; j < nElem; j++) {
      assert.ok(
        Math.abs(v.data[j] - values[j]) < 1e-5,
        `fuzz iteration ${i}, elem ${j}: ${v.data[j]} vs ${values[j]}`
      );
    }
  }
});

// ----- extractEegInline ------------------------------------------

test('extractEegInline: top-level layout (data + scalar fields)', async () => {
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

test('extractEegInline: mxDOUBLE data array accepted', async () => {
  const buf = multiMatrixFile([
    { name: 'data',   mxClass: mxDOUBLE, dims: [2, 3],
      dataPayload: doublesPayload([1, 2, 3, 4, 5, 6]), dataType: miDOUBLE },
    { name: 'srate',  mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([500]), dataType: miDOUBLE },
    { name: 'nbchan', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([2]),   dataType: miDOUBLE },
    { name: 'pnts',   mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([3]),   dataType: miDOUBLE },
    { name: 'trials', mxClass: mxDOUBLE, dims: [1, 1],
      dataPayload: doublesPayload([1]),   dataType: miDOUBLE },
  ]);
  const vars = await MatV5.parse(buf);
  const eeg = MatV5.extractEegInline(vars);
  assert.equal(eeg.dataClass, 'double');
  assert.equal(eeg.nbchan, 2);
  assert.equal(eeg.pnts, 3);
});

test('extractEegInline: 3D epoched dims (trials > 1)', async () => {
  // data is [nbchan, pnts, trials] = [2, 4, 3]
  const nCh = 2, nPts = 4, nTrials = 3;
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
  const vars = await MatV5.parse(buf);
  const eeg = MatV5.extractEegInline(vars);
  assert.equal(eeg.trials, nTrials);
  assert.equal(eeg.nbchan, nCh);
  assert.equal(eeg.pnts, nPts);
  assert.equal(eeg.data.length, nElem);
});
