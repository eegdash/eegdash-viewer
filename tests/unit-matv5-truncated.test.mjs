// scanElements must tolerate a top-level element whose declared
// payload extends past the end of the buffer. The Plan A range-based
// inline-EEGLAB path passes only the first ~16 MB of the file to
// scanElements, but EEGLAB files with top-level data variables often
// have a multi-hundred-MB tail element. The walker should yield a
// truncated entry (so name/dims/dataSubOffset/dataSubMiType remain
// extractable from the header) rather than throw.
//
// Real-world: ds002578 (695 MB) and ds002718 (224 MB) both have
// EEG.data at the TOP LEVEL — verified by direct probe of the actual
// file bytes (Plan A finisher's struct-wrapped diagnosis was wrong).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MatV5 } from './_bootstrap.mjs';

// Same primitives the scanElements test uses.
const miINT8   = 1;
const miINT32  = 5;
const miUINT32 = 6;
const miSINGLE = 7;
const miDOUBLE = 9;
const miMATRIX = 14;
const mxSINGLE = 7;

function pad8(n) { return n % 8 === 0 ? 0 : 8 - (n % 8); }

function writeLong(view, off, type, payload) {
  view.setUint32(off, type, true);
  view.setUint32(off + 4, payload.length, true);
  new Uint8Array(view.buffer, view.byteOffset + off + 8, payload.length).set(payload);
  return off + 8 + payload.length + pad8(payload.length);
}

function writeHeader(view) {
  const text = 'MATLAB 5.0 MAT-file truncated test';
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

function asciiPayload(s) {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

function makeMatrixPayload(mxClass, dims, name, realDataMiType, realDataPayload) {
  const flagsBytes = arrayFlagsPayload(mxClass);
  const dimsBytes  = int32Payload(dims);
  const nameBytes  = asciiPayload(name);
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

test('matv5 scan: tolerates a truncated tail element and exposes its header', () => {
  // Build a buffer with one full matrix (srate) and one TRUNCATED
  // matrix (data). The data element declares a big payload but we
  // give the scanner a buffer that cuts off mid-payload — exactly
  // the shape of a 16 MB range-fetch over a multi-hundred-MB file.
  const srateBytes = makeMatrixPayload(
    7 /*mxSINGLE not actually used here*/,
    [1, 1], 'srate', miSINGLE, singlesPayload([100.0]),
  );
  // data: 2 chans × 8 samples = 16 floats = 64 bytes of real data
  const realData = singlesPayload([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const dataPayload = makeMatrixPayload(mxSINGLE, [2, 8], 'data', miSINGLE, realData);

  // Full layout: [128 header][srate element][data element]
  const srateElemBytes = 8 + srateBytes.length + pad8(srateBytes.length);
  const dataElemBytes  = 8 + dataPayload.length + pad8(dataPayload.length);
  const fullLen = 128 + srateElemBytes + dataElemBytes;
  const fullBuf = new ArrayBuffer(fullLen);
  const fullV = new DataView(fullBuf);
  writeHeader(fullV);
  let off = 128;
  off = writeLong(fullV, off, miMATRIX, srateBytes);
  off = writeLong(fullV, off, miMATRIX, dataPayload);

  // Now truncate so the data element's payload is cut off mid-flight.
  // We keep enough bytes for the data element's HEADER + ~3 sub-elements
  // (flags + dims + name) but slice off most of the real-data payload.
  // The truncate point: 128 header + srate elem + 8 tag header for data
  // matrix + enough of dataPayload to cover flags + dims + name only.
  const flagsSize = 8 + 8 + pad8(8);
  const dimsSize  = 8 + 8 + pad8(8);   // 2-int dims = 8 B
  const nameSize  = 8 + 4 + pad8(4);   // 'data' = 4 B
  const headerOnlyBytes = flagsSize + dimsSize + nameSize;
  // Add the 8-byte realdata sub-tag (so we have the dataSubOffset/MiType
  // info readable) but truncate before the actual realdata bytes.
  const minDataElemBytes = headerOnlyBytes + 8;  // include realdata tag (8B)
  const truncLen = 128 + srateElemBytes + 8 + minDataElemBytes;
  const truncBuf = fullBuf.slice(0, truncLen);

  // Run scanElements on the truncated buffer.
  const scan = MatV5.scanElements(truncBuf);
  assert.equal(scan.length, 2, 'scan found both elements despite truncation');

  const byName = Object.fromEntries(scan.map(e => [e.name, e]).filter(([n]) => n));
  assert.ok(byName.srate, 'srate fully readable');
  assert.ok(byName.data, 'data element header readable through truncation');

  // The data element must expose the correct dims, name, and a
  // dataSubOffset that points INTO the original full buffer (so a
  // subsequent range-fetch can read the real bytes).
  assert.deepEqual(byName.data.dims, [2, 8]);
  assert.equal(byName.data.name, 'data');
  assert.equal(byName.data.dataSubMiType, miSINGLE);
  assert.ok(byName.data.dataSubOffset > 0, 'dataSubOffset is positive');
  // The dataSubOffset should be just past the truncation point (the
  // header was readable, the payload is what got cut off).
  assert.ok(
    byName.data.dataSubOffset <= truncLen,
    `dataSubOffset (${byName.data.dataSubOffset}) is within or just past truncation point (${truncLen})`,
  );
});

test('matv5 parse (materializing): still throws on truncated payload', async () => {
  // The parse() path materializes data and MUST not silently consume
  // a truncated payload. Build the same truncated buffer and verify
  // parse throws (allowTruncated must not leak into parse).
  const realData = singlesPayload([1, 2, 3, 4]);
  const dataPayload = makeMatrixPayload(mxSINGLE, [2, 2], 'data', miSINGLE, realData);
  const fullLen = 128 + 8 + dataPayload.length + pad8(dataPayload.length);
  const fullBuf = new ArrayBuffer(fullLen);
  const fullV = new DataView(fullBuf);
  writeHeader(fullV);
  writeLong(fullV, 128, miMATRIX, dataPayload);
  // Truncate to half the realdata payload.
  const truncBuf = fullBuf.slice(0, fullLen - 8);
  await assert.rejects(
    MatV5.parse(truncBuf),
    /overruns/i,
    'parse() still rejects truncated buffers',
  );
});
