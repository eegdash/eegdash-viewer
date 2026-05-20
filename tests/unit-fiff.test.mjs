// Unit tests for formats/fiff.js — regression coverage for the
// tag-stream rewrite. The three real fixtures live under
// tests/fixtures/meg/ and are BSD-3-licensed copies of MNE-Python's
// own test data, so they exercise authentic FIFF byte distributions
// (big-endian, BLOCK_START/END nested blocks, FIFF_FILE_ID header).
//
// What we lock in:
//   1. read() does not throw on real fixtures.
//   2. The block-id stack is populated correctly (test-proj.fif must
//      contain FIFFB_PROJ = 313).
//   3. Bad inputs are rejected with a regular Error (no host crash).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const FIFFReader = require('../formats/fiff.js');

function readArrayBuffer(path) {
  const buf = fs.readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

test('fiff: test-proj.fif parses without throwing', () => {
  const ab = readArrayBuffer('tests/fixtures/meg/test-proj.fif');
  const meas = FIFFReader.read(ab);
  assert.ok(meas && typeof meas === 'object', 'read() returned non-object');
});

test('fiff: test-proj.fif contains a projection block (313)', () => {
  const ab = readArrayBuffer('tests/fixtures/meg/test-proj.fif');
  const meas = FIFFReader.read(ab);
  assert.ok(Array.isArray(meas.blocks), 'meas.blocks must be an array');
  assert.ok(
    meas.blocks.includes(313),
    `expected FIFFB_PROJ (313) in blocks; got ${JSON.stringify(meas.blocks)}`
  );
  assert.equal(meas.has_projections, true, 'has_projections flag must be set');
});

test('fiff: test-eve.fif (events file) parses without throwing', () => {
  const ab = readArrayBuffer('tests/fixtures/meg/test-eve.fif');
  const meas = FIFFReader.read(ab);
  assert.ok(meas && typeof meas === 'object');
  // No meas_info → no sample rate / channels.
  assert.equal(meas.sfreq, null);
  assert.equal(meas.nchan, 0);
});

test('fiff: test_raw-annot.fif (annotations) parses without throwing', () => {
  const ab = readArrayBuffer('tests/fixtures/meg/test_raw-annot.fif');
  const meas = FIFFReader.read(ab);
  assert.ok(meas && typeof meas === 'object');
});

test('fiff: rejects bytes shorter than a tag header', () => {
  const ab = new ArrayBuffer(8);
  assert.throws(() => FIFFReader.read(ab), /too small|FIFF/i);
});

test('fiff: rejects bytes whose first tag is not FIFF_FILE_ID', () => {
  // Construct a 32-byte buffer with first int32 != 100 (BE).
  const ab = new ArrayBuffer(32);
  const v = new DataView(ab);
  v.setInt32(0, 999, false);
  v.setInt32(4, 31, false);
  v.setInt32(8, 20, false);
  v.setInt32(12, 0, false);
  assert.throws(() => FIFFReader.read(ab), /Not a valid FIFF/i);
});

test('fiff: accepts a synthetic FIFF_FILE_ID-only buffer', () => {
  // Minimal valid FIFF: a single FIFF_FILE_ID tag with next=-1.
  // Asserts that endianness + termination logic work without any
  // payload data following the header.
  const ab = new ArrayBuffer(36);
  const v = new DataView(ab);
  v.setInt32(0, 100, false);   // kind = FIFF_FILE_ID
  v.setInt32(4, 31, false);    // type = FIFFT_ID_STRUCT
  v.setInt32(8, 20, false);    // size = 20
  v.setInt32(12, -1, false);   // next = -1 (end)
  // 20 bytes of payload follow; content does not matter.
  const meas = FIFFReader.read(ab);
  assert.ok(meas && typeof meas === 'object');
  assert.deepEqual(meas.blocks, []);
});

// ─── api.open ─────────────────────────────────────────────────────
// open() is the wrapper viewer.js + worker.js call. It fetches the
// file via HttpRange.fetchBuffer, parses, and returns a reader-shaped
// object matching the EDFReader/EEGLABReader/BrainVisionReader
// contract. Tests use file:// URLs that HttpRange should fetch via
// fetch() — node:test 22+ supports the global fetch.

test('fiff: open(meta) returns a reader-shaped object for events file', async () => {
  // Mock HttpRange via globalThis since the production module uses it.
  const fs = await import('node:fs');
  globalThis.HttpRange = globalThis.HttpRange || {
    async fetchBuffer(url) {
      const path = url.replace(/^file:\/\//, '');
      const buf = fs.readFileSync(path);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  };
  const reader = await FIFFReader.open({
    eeg_url: 'file://' + process.cwd() + '/tests/fixtures/meg/test-eve.fif',
  });
  assert.ok(reader, 'open() must return a non-null reader');
  assert.equal(typeof reader.n_channels, 'number');
  assert.equal(typeof reader.sampling_frequency, 'number');
  assert.equal(typeof reader.duration_s, 'number');
  assert.equal(typeof reader.readWindow, 'function');
});

test('fiff: readWindow throws on metadata-only files (no FIFFB_RAW_DATA)', async () => {
  // test-eve.fif is an events-only file — it has FIFFB_EVENTS but no
  // raw data block. readWindow must throw with a clear message rather
  // than silently returning empty arrays.
  globalThis.HttpRange = globalThis.HttpRange || {};
  if (!globalThis.HttpRange.fetchBuffer) {
    const fs = await import('node:fs');
    globalThis.HttpRange.fetchBuffer = async (url) => {
      const path = url.replace(/^file:\/\//, '');
      const buf = fs.readFileSync(path);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    };
  }
  const reader = await FIFFReader.open({
    eeg_url: 'file://' + process.cwd() + '/tests/fixtures/meg/test-eve.fif',
  });
  await assert.rejects(
    () => reader.readWindow(0, 100),
    /no FIFFB_RAW_DATA|events\/projections\/annotations only/,
  );
});

test('fiff: open requires meta.eeg_url', async () => {
  await assert.rejects(
    () => FIFFReader.open({}),
    /eeg_url is required/,
  );
});
