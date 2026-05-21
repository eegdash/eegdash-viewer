// Unit tests for formats/bti.js — exercises api.read on the full PDF
// buffer + api.open against a local file:// HttpRange shim.
//
// Fixture: tests/fixtures/meg/bti-tiny/ (synthesised — see
// scripts/make-bti-fixture.mjs). 4 channels × 500 samples @ 100 Hz,
// float32 BE per-sample interleaved, PDF tail header per MNE.
//
// Shape mirrors tests/unit-kit.test.mjs + tests/unit-fiff-realworld.test.mjs.
// Like KIT, BTi ships only a synthetic fixture (re-distributable BTi
// recordings are scarce); the reader's full byte arithmetic is exercised
// by the synth.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
// Helpers attach to globalThis on require — load before bti.js so the
// reader can reach for them at open() time.
require('../formats/_buffers.js');
require('../formats/_labels.js');
require('../formats/_decode.js');
const BtiReader = require('../formats/bti.js');

const BUNDLE_DIR = path.resolve('tests/fixtures/meg/bti-tiny');
const PDF_PATH = path.join(BUNDLE_DIR, 'c,rfDC');
const PDF_URL = 'file://' + PDF_PATH;

function readBuf(rel) {
  const b = fs.readFileSync(rel);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

// ─── api.read(pdf buf) ──────────────────────────────────────────────

test('bti: read() parses the synthetic PDF tail header', () => {
  const ab = readBuf(PDF_PATH);
  const h = BtiReader.read(ab);
  assert.ok(h && typeof h === 'object');
  assert.equal(h.n_channels, 4);
  // sample_period is stored as float32 BE in the PDF header; 1/100
  // doesn't round-trip exactly through float32 (0.01 → 0x3c23d70a →
  // ~0.0099999998), so 1/sample_period is 100.0000022..., not exactly
  // 100. This is a property of the on-disk format, not the reader.
  assert.ok(Math.abs(h.sampling_frequency - 100) < 1e-4,
    `sampling_frequency ≈ 100, got ${h.sampling_frequency}`);
  assert.equal(h.n_samples, 500);
  assert.equal(h.data_format, 3, 'fixture writes float32 BE → data_format=3');
  assert.equal(h.sample_size, 4);
  assert.equal(h.total_epochs, 1);
});

test('bti: read() rejects a tiny / corrupt buffer with a regular Error', () => {
  assert.throws(() => BtiReader.read(new ArrayBuffer(4)), Error);
  assert.throws(() => BtiReader.read(null), Error);
  assert.throws(() => BtiReader.read(undefined), Error);
});

test('bti: read() rejects unsupported data_format with a clean error', () => {
  // Clone the fixture and corrupt data_format → 99 (unsupported).
  const raw = fs.readFileSync(PDF_PATH);
  const copy = Buffer.from(raw);
  const fileLen = copy.length;
  // Read header_position from the last 8 bytes (mirrors what the reader
  // does so the offsets line up with whatever the fixture wrote).
  const hi = copy.readUInt32BE(fileLen - 8);
  const lo = copy.readUInt32BE(fileLen - 4);
  const ptr = (BigInt(hi) << 32n) | BigInt(lo);
  const FILE_MASK = 2147483647n;
  let headerPos = Number(ptr & FILE_MASK);
  if (headerPos % 8 !== 0) headerPos += 8 - (headerPos % 8);
  // data_format lives at header + 8 (after version + file_type + pad).
  copy.writeInt16BE(99, headerPos + 8);
  assert.throws(
    () => BtiReader.read(copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)),
    /unsupported data_format 99/,
  );
});

// ─── api.open + readWindow ──────────────────────────────────────────
// Install a local file:// HttpRange shim — same interface as production
// formats/_http_range.js. Exercises the range-based open() + readWindow
// without spinning up an HTTP server.

function installLocalHttpRange() {
  globalThis.HttpRange = {
    async probeLength(url) {
      return fs.statSync(url.replace(/^file:\/\//, '')).size;
    },
    async probeLengthNoHead(url) {
      const p = url.replace(/^file:\/\//, '');
      if (!fs.existsSync(p)) {
        throw new Error(`local shim: 404 ${p}`);
      }
      return fs.statSync(p).size;
    },
    async fetchBuffer(url) {
      const b = fs.readFileSync(url.replace(/^file:\/\//, ''));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    async rangeFetch(url, start, endIncl) {
      const b = fs.readFileSync(url.replace(/^file:\/\//, ''));
      const slice = b.slice(start, endIncl + 1);
      return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    },
  };
}

test('bti: open() returns a reader-shaped object', async () => {
  installLocalHttpRange();
  const r = await BtiReader.open({ eeg_url: PDF_URL });
  assert.ok(r, 'open() returned null');
  assert.equal(r.n_channels, 4);
  // sample_period rounds through float32 — see api.read test above.
  assert.ok(Math.abs(r.sampling_frequency - 100) < 1e-4);
  assert.equal(r.n_samples, 500);
  // 500 / sampling_frequency ≈ 5 s — tolerance loosened to match the
  // float32 quantisation of sample_period.
  assert.ok(Math.abs(r.duration_s - 5) < 1e-4);
  assert.equal(r.channel_labels.length, 4);
  // The initial port falls back to indexed labels Ch1..ChN — channel
  // labels live in the `config` user blocks (parser deferred — see
  // formats/_bti-config.js).
  assert.equal(r.channel_labels[0], 'Ch1');
  assert.equal(r.channel_labels[3], 'Ch4');
  assert.equal(r.bytes_per_sample, 4);
  assert.equal(typeof r.readWindow, 'function');
});

test('bti: open() requires meta.eeg_url', async () => {
  installLocalHttpRange();
  await assert.rejects(() => BtiReader.open({}), /eeg_url is required/);
});

test('bti: open() resolves the PDF URL when caller passes the bundle dir', async () => {
  // Caller hands us the bundle directory (or `config`) — we should
  // probe the standard PDF filenames and find `c,rfDC`.
  installLocalHttpRange();
  // Directory URL form.
  const r = await BtiReader.open({ eeg_url: 'file://' + BUNDLE_DIR + '/' });
  assert.equal(r.n_channels, 4);
  assert.equal(r._bti.pdf_url, PDF_URL, 'open() should resolve to c,rfDC');
});

test('bti: open() resolves the PDF URL when caller passes config', async () => {
  installLocalHttpRange();
  const configUrl = 'file://' + path.join(BUNDLE_DIR, 'config');
  const r = await BtiReader.open({ eeg_url: configUrl });
  assert.equal(r._bti.pdf_url, PDF_URL);
});

test('bti: readWindow(0, 100) returns 4 × Float32Array[100] with finite data', async () => {
  installLocalHttpRange();
  const r = await BtiReader.open({ eeg_url: PDF_URL });
  const win = await r.readWindow(0, 100);
  assert.equal(win.length, 4, 'one Float32Array per channel');
  for (let c = 0; c < win.length; c++) {
    assert.ok(win[c] instanceof Float32Array, `channel ${c} must be Float32Array`);
    assert.equal(win[c].length, 100, `channel ${c} must have 100 samples`);
    for (let i = 0; i < win[c].length; i++) {
      assert.ok(
        Number.isFinite(win[c][i]),
        `channel ${c} sample ${i} is not finite: ${win[c][i]}`,
      );
    }
  }
});

test('bti: readWindow value contract — channels differ + sin(0)=0', async () => {
  installLocalHttpRange();
  const r = await BtiReader.open({ eeg_url: PDF_URL });
  const w = await r.readWindow(0, 100);
  // The synth fixture stamps a per-channel-scaled sine wave. Channel 0
  // is sin(2π*t*1/100), channel 1 is sin(2π*t*2/100), etc. So at t=10
  // the four channels MUST produce four distinct values — identical
  // values at t=10 would signal the de-interleave loop is reading the
  // same bytes across channels (the mutant we want to kill).
  const distinct = new Set(w.map((ch) => ch[10]));
  assert.ok(
    distinct.size > 1,
    `channels at t=10 must differ; got ${[...distinct].join(',')} — interleave likely collapsed`,
  );
  // Sample 0 must be exactly 0 for every channel (sin(0)=0 → 0 in
  // float32 → 0 in Float32Array; no quantisation in the float path).
  for (let c = 0; c < w.length; c++) {
    assert.equal(w[c][0], 0, `channel ${c} sample 0 must be exactly 0`);
  }
});

test('bti: readWindow values match the underlying sine waves', async () => {
  // Pin the exact decoded value at one sample so a future regression
  // that swaps the BE decode for LE (or off-by-one in the per-channel
  // stride) fails loudly. The fixture writes
  //   v(t, c) = sin(2π * (t/100) * (c+1))
  // as float32 BE — read back as Float32 we expect bit-identical values
  // because the rounding happens in the float32 store, not in our path.
  installLocalHttpRange();
  const r = await BtiReader.open({ eeg_url: PDF_URL });
  const w = await r.readWindow(0, 50);
  const SR = 100;
  for (let t of [1, 10, 25, 49]) {
    for (let c = 0; c < 4; c++) {
      const expected = Math.fround(Math.sin(2 * Math.PI * (t / SR) * (c + 1)));
      assert.ok(
        Math.abs(w[c][t] - expected) < 1e-6,
        `bti: at t=${t} c=${c} expected ≈ ${expected}, got ${w[c][t]}`,
      );
    }
  }
});

test('bti: readWindow tail clamps to n_samples (boundary at start = n_samples - 1)', async () => {
  installLocalHttpRange();
  const r = await BtiReader.open({ eeg_url: PDF_URL });
  // Exactly 1 sample remains at start = n_samples - 1.
  const tailMinus1 = await r.readWindow(r.n_samples - 1, 5);
  assert.equal(
    tailMinus1[0].length,
    1,
    'exactly 1 sample remains at start = n_samples - 1',
  );
  // Start = n_samples (exact end-of-file): 0 samples.
  const atEnd = await r.readWindow(r.n_samples, 5);
  assert.equal(atEnd[0].length, 0, 'must return 0 samples at exactly start = n_samples');
  // Beyond EOF: still 0 (no negative indexing into the data section).
  const past = await r.readWindow(r.n_samples + 100, 5);
  assert.equal(past[0].length, 0, 'past-end must also return 0 samples');
});

test('bti: readWindow tail-clamp returns nCh empty arrays when fully past EOF', async () => {
  installLocalHttpRange();
  const r = await BtiReader.open({ eeg_url: PDF_URL });
  const win = await r.readWindow(r.n_samples + 100, 5);
  // The contract is one Float32Array per channel — even when empty.
  // This pins the ChannelBuffers.empty(nCh) fallback.
  assert.equal(win.length, r.n_channels);
  for (let c = 0; c < win.length; c++) {
    assert.ok(win[c] instanceof Float32Array);
    assert.equal(win[c].length, 0);
  }
});

test('bti: readWindow(start, nWin) returns exactly nWin samples when fully in-bounds', async () => {
  installLocalHttpRange();
  const r = await BtiReader.open({ eeg_url: PDF_URL });
  const win = await r.readWindow(100, 50);
  for (let c = 0; c < win.length; c++) {
    assert.equal(
      win[c].length,
      50,
      `channel ${c}: in-bounds window must return exactly nWin samples`,
    );
  }
});

// ─── format-rejection contract ────────────────────────────────────
// Multi-epoch / evoked BTi files are intentionally NOT supported by
// this initial reader. Pin the rejection so a future regression that
// removes the guard fails loudly.

test('bti: open() rejects multi-epoch PDFs with a clean error', async () => {
  // Clone the fixture, mutate total_epochs (offset header_position + 12)
  // to 2. Don't bother regenerating epoch records — the rejection
  // happens before we walk them, so the synthetic mismatch is fine.
  const raw = fs.readFileSync(PDF_PATH);
  const copy = Buffer.from(raw);
  const fileLen = copy.length;
  const hi = copy.readUInt32BE(fileLen - 8);
  const lo = copy.readUInt32BE(fileLen - 4);
  const ptr = (BigInt(hi) << 32n) | BigInt(lo);
  let headerPos = Number(ptr & 2147483647n);
  if (headerPos % 8 !== 0) headerPos += 8 - (headerPos % 8);
  copy.writeInt32BE(2, headerPos + 12);  // total_epochs = 2

  // Local HttpRange shim that serves this in-memory buffer.
  globalThis.HttpRange = {
    async probeLengthNoHead() {
      return copy.length;
    },
    async probeLength() {
      return copy.length;
    },
    async fetchBuffer() {
      return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
    },
    async rangeFetch(_url, start, endIncl) {
      const slice = copy.slice(start, endIncl + 1);
      return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    },
  };

  await assert.rejects(
    () => BtiReader.open({ eeg_url: PDF_URL }),
    /total_epochs=2.*multi-epoch|multi-epoch.*not supported/i,
    'multi-epoch BTi must be rejected with a clean error',
  );
});

// ─── api.open via globalThis (registration sanity) ────────────────
// The IIFE attaches to globalThis.BtiReader; the viewer/worker
// dispatch tables reach through this name. Pin it so an accidental
// rename in formats/bti.js breaks loudly.

test('bti: module attaches globalThis.BtiReader', () => {
  assert.ok(globalThis.BtiReader, 'globalThis.BtiReader missing');
  assert.equal(typeof globalThis.BtiReader.read, 'function');
  assert.equal(typeof globalThis.BtiReader.open, 'function');
});
