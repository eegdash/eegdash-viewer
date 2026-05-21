// Unit tests for formats/itab.js — both api.read(full buffer) and
// the wrapper api.open(meta) + readWindow(start, n).
//
// Fixture: tests/fixtures/meg/itab-tiny.raw + itab-tiny.mhd
// (synthesised — see scripts/make-itab-fixture.mjs). 4 channels × 500
// samples @ 1000 Hz, float32 LE samples.
//
// Pairs with tests/unit-kit.test.mjs + tests/unit-ctf.test.mjs in shape:
// a file:// HttpRange shim exercises api.open / readWindow without
// spinning up an HTTP server.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
// Helper modules attach to globalThis on require — load before itab.js.
require('../formats/_buffers.js');
require('../formats/_labels.js');
require('../formats/_decode.js');
const ItabReader = require('../formats/itab.js');

const FIXTURE_RAW = path.resolve('tests/fixtures/meg/itab-tiny.raw');
const FIXTURE_MHD = path.resolve('tests/fixtures/meg/itab-tiny.mhd');
const EEG_URL     = 'file://' + FIXTURE_RAW;

function readBuf(rel) {
  const b = fs.readFileSync(rel);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

// ─── api.read(.raw buf) ──────────────────────────────────────────────

test('itab: read() parses the synthetic fixture into a header', () => {
  const ab = readBuf(FIXTURE_RAW);
  const h = ItabReader.read(ab);
  assert.ok(h && typeof h === 'object');
  assert.equal(h.n_channels, 4);
  assert.equal(h.sampling_frequency, 1000);
  assert.equal(h.n_samples, 500);
  assert.equal(h.data_type, 5);      // LE_FLOAT
  assert.equal(h.sample_width, 4);   // float32 → 4 bytes
  assert.equal(h.isns, 153);         // ARGOS-153 sensor code
});

test('itab: read() also accepts the .mhd sidecar (same binary layout)', () => {
  // The .mhd sidecar is the same binary structure as the .raw's header
  // prefix — FieldTrip's read_itab_mhd.m is one parser used for both.
  // Pin that we can parse the standalone sidecar through api.read.
  const ab = readBuf(FIXTURE_MHD);
  const h = ItabReader.read(ab);
  assert.equal(h.n_channels, 4);
  assert.equal(h.sampling_frequency, 1000);
  // n_samples lives at OFF_NTPDATA = 748 and the .mhd carries the same
  // recording-time value as the .raw, so this MUST match.
  assert.equal(h.n_samples, 500);
});

test('itab: read() rejects null/undefined input with a regular Error', () => {
  assert.throws(() => ItabReader.read(null), Error);
  assert.throws(() => ItabReader.read(undefined), Error);
});

test('itab: read() rejects a tiny buffer with a clean error', () => {
  // < PROBE_INITIAL_BYTES (85,772) — too small to expose the first
  // per-channel record. Must throw without dereferencing past EOF.
  assert.throws(() => ItabReader.read(new ArrayBuffer(64)), /too small/i);
});

test('itab: read() rejects non-ITAB bytes with a clean error', () => {
  // 100 KB of zeros — no "FORMAT: AT" signature. Must reject with the
  // "not ITAB" message instead of producing garbage scalars.
  const big = new ArrayBuffer(100 * 1024);
  assert.throws(
    () => ItabReader.read(big),
    /does not appear to be a valid ITAB/i,
  );
});

test('itab: read() rejects the legacy "[HeaderType]" variant with a specific error', () => {
  // Build a buffer big enough to clear PROBE_INITIAL_BYTES with the
  // legacy ASCII magic at offset 0. The reader must produce the
  // "legacy variant" error, NOT the "not ITAB" or generic Error.
  const buf = Buffer.alloc(100 * 1024, 0);
  buf.write('[HeaderType]', 0, 12, 'ascii');
  assert.throws(
    () => ItabReader.read(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
    /legacy/i,
  );
});

test('itab: read() per-channel labels + types are parsed', () => {
  const ab = readBuf(FIXTURE_RAW);
  const h = ItabReader.read(ab);
  assert.equal(h.chs.length, 4);
  // Labels from scripts/make-itab-fixture.mjs:
  assert.equal(h.chs[0].name, 'MAG001');
  assert.equal(h.chs[1].name, 'MAG002');
  assert.equal(h.chs[2].name, 'MAG003');
  assert.equal(h.chs[3].name, 'AUX001');
  // Channel types: 2 = mag, 16 = aux per ITAB convention.
  assert.equal(h.chs[0].type, 2);
  assert.equal(h.chs[3].type, 16);
  // Calib = 1.0 per the fixture — pinned so a future calib-scaling
  // mutant that drops the field gets caught.
  for (const ch of h.chs) {
    assert.equal(ch.calib, 1.0);
  }
});

// ─── api.open + readWindow ───────────────────────────────────────────
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
      // Simulate a 404 for missing .mhd files (some fixtures don't
      // ship one, and the reader must tolerate that).
      if (!fs.existsSync(p)) throw new Error('ENOENT');
      return fs.statSync(p).size;
    },
    async fetchBuffer(url) {
      const b = fs.readFileSync(url.replace(/^file:\/\//, ''));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    async rangeFetch(url, start, endIncl) {
      const p = url.replace(/^file:\/\//, '');
      const b = fs.readFileSync(p);
      const slice = b.slice(start, endIncl + 1);
      return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    },
  };
}

test('itab: open() returns a reader-shaped object', async () => {
  installLocalHttpRange();
  const r = await ItabReader.open({ eeg_url: EEG_URL });
  assert.ok(r, 'open() returned null');
  assert.equal(r.n_channels, 4);
  assert.equal(r.sampling_frequency, 1000);
  assert.equal(r.n_samples, 500);
  // 500 / 1000 = 0.5 s. Float math is exact at this magnitude, but
  // keep a tolerance for safety.
  assert.ok(Math.abs(r.duration_s - 0.5) < 1e-9);
  assert.equal(r.channel_labels.length, 4);
  assert.equal(r.channel_labels[0], 'MAG001');
  assert.equal(r.channel_labels[3], 'AUX001');
  assert.equal(r.bytes_per_sample, 4);     // float32 LE
  assert.equal(typeof r.readWindow, 'function');
  assert.equal(typeof r.readWindowStreaming, 'function');
});

test('itab: open() exposes channel_types per ITAB type byte', async () => {
  installLocalHttpRange();
  const r = await ItabReader.open({ eeg_url: EEG_URL });
  assert.deepEqual(r.channel_types, ['mag', 'mag', 'mag', 'misc']);
});

test('itab: open() requires meta.eeg_url', async () => {
  installLocalHttpRange();
  await assert.rejects(() => ItabReader.open({}), /eeg_url is required/);
});

test('itab: readWindow(0, 100) returns 4 × Float32Array[100] with finite data', async () => {
  installLocalHttpRange();
  const r = await ItabReader.open({ eeg_url: EEG_URL });
  const win = await r.readWindow(0, 100);
  assert.equal(win.length, 4, 'one Float32Array per channel');
  for (let c = 0; c < win.length; c++) {
    assert.ok(win[c] instanceof Float32Array, `channel ${c} must be Float32Array`);
    assert.equal(win[c].length, 100, `channel ${c} must have 100 samples`);
    for (let i = 0; i < win[c].length; i++) {
      assert.ok(Number.isFinite(win[c][i]),
        `channel ${c} sample ${i} is not finite: ${win[c][i]}`);
    }
  }
});

test('itab: readWindow value contract — channels differ + per-channel sine [#H4]', async () => {
  installLocalHttpRange();
  const r = await ItabReader.open({ eeg_url: EEG_URL });
  const w = await r.readWindow(0, 100);
  // The synth fixture stamps a per-channel-scaled sine wave. Channel 0
  // is sin(2π*t*1/1000), channel 1 is sin(2π*t*2/1000), etc. So at
  // t=10 the four channels MUST produce four distinct values. Identical
  // values at t=10 would signal the de-interleave loop is reading the
  // same byte across channels — exactly the mutant the matching KIT /
  // CTF tests were designed to kill.
  const distinct = new Set(w.map((ch) => ch[10]));
  assert.ok(distinct.size > 1,
    `channels at t=10 must differ; got ${[...distinct].join(',')} — interleave likely collapsed`);
  // Sample 0 should be exactly 0 for every channel (sin(0)=0 stamped
  // verbatim by float32 LE, with unity calib).
  for (let c = 0; c < w.length; c++) {
    assert.equal(w[c][0], 0,
      `channel ${c} sample 0 must be exactly 0 (sin(0)=0)`);
  }
});

test('itab: readWindow tail clamps to n_samples (boundary at start = n_samples - 1)', async () => {
  installLocalHttpRange();
  const r = await ItabReader.open({ eeg_url: EEG_URL });
  // Exactly 1 sample remains at start = n_samples - 1.
  const tailMinus1 = await r.readWindow(r.n_samples - 1, 5);
  assert.equal(tailMinus1[0].length, 1,
    'exactly 1 sample remains at start = n_samples - 1');
  // Start = n_samples (exact end-of-file): 0 samples.
  const atEnd = await r.readWindow(r.n_samples, 5);
  assert.equal(atEnd[0].length, 0,
    'must return 0 samples at exactly start = n_samples');
  // Beyond EOF: still 0 (no negative indexing into RAW_DATA).
  const past = await r.readWindow(r.n_samples + 100, 5);
  assert.equal(past[0].length, 0,
    'past-end (start > n_samples) must also return 0 samples');
});

test('itab: readWindow tail-clamp returns nCh empty arrays when fully past EOF', async () => {
  installLocalHttpRange();
  const r = await ItabReader.open({ eeg_url: EEG_URL });
  const win = await r.readWindow(r.n_samples + 100, 5);
  // The contract is one Float32Array per channel — even when empty.
  assert.equal(win.length, r.n_channels);
  for (let c = 0; c < win.length; c++) {
    assert.ok(win[c] instanceof Float32Array);
    assert.equal(win[c].length, 0);
  }
});

test('itab: readWindow(start, nWin) returns exactly nWin samples when fully in-bounds', async () => {
  installLocalHttpRange();
  const r = await ItabReader.open({ eeg_url: EEG_URL });
  const win = await r.readWindow(100, 50);
  for (let c = 0; c < win.length; c++) {
    assert.equal(win[c].length, 50,
      `channel ${c}: in-bounds window must return exactly nWin samples`);
  }
});

test('itab: readWindowStreaming yields one chunk covering the whole window', async () => {
  installLocalHttpRange();
  const r = await ItabReader.open({ eeg_url: EEG_URL });
  const chunks = [];
  for await (const c of r.readWindowStreaming(0, 50)) chunks.push(c);
  assert.equal(chunks.length, 1, 'streaming variant yields one chunk');
  assert.equal(chunks[0].offset, 0);
  assert.equal(chunks[0].data.length, r.n_channels);
  assert.equal(chunks[0].data[0].length, 50);
});

// ─── magic-byte detection ────────────────────────────────────────────
// Exposed via api._detect so the future routing layer can ask "is this
// an ITAB file?" without going through the throw-on-failure read path.

test('itab: _detect() returns "binary" for "FORMAT: AT" prefix', () => {
  const buf = new Uint8Array(64);
  const sig = 'FORMAT: AT';
  for (let i = 0; i < sig.length; i++) buf[i] = sig.charCodeAt(i);
  assert.equal(ItabReader._detect(buf), 'binary');
});

test('itab: _detect() returns "legacy" for "[HeaderTyp" prefix', () => {
  const buf = new Uint8Array(64);
  const sig = '[HeaderTyp';
  for (let i = 0; i < sig.length; i++) buf[i] = sig.charCodeAt(i);
  assert.equal(ItabReader._detect(buf), 'legacy');
});

test('itab: _detect() returns null for unrelated / zero / short bytes', () => {
  assert.equal(ItabReader._detect(new Uint8Array(64)), null);
  assert.equal(ItabReader._detect(new Uint8Array(5)), null);
  // ASCII "FORMAT" but truncated — must NOT mis-classify.
  const partial = new Uint8Array(8);
  for (let i = 0; i < 6; i++) partial[i] = 'FORMAT'.charCodeAt(i);
  assert.equal(ItabReader._detect(partial), null);
});

test('itab: _detect() is case-sensitive (lowercase "format: at" does NOT match)', () => {
  const buf = new Uint8Array(64);
  const sig = 'format: at';
  for (let i = 0; i < sig.length; i++) buf[i] = sig.charCodeAt(i);
  assert.equal(ItabReader._detect(buf), null);
});

// ─── unsupported-format rejection ────────────────────────────────────
// data_type ∉ {3,4,5} (LE branches) is intentionally NOT supported by
// this initial reader. Pin the rejection so a future regression that
// adds half-baked BE support without testing it fails loudly.

test('itab: open() rejects unsupported data_type with a clean error [#H4]', async () => {
  // Mutate a copy of the fixture: flip data_type from 5 (LE_FLOAT) to
  // 0 (BE_SHORT, HP-PA legacy). The reader must reject with a clean
  // error mentioning data_type — not produce garbage by treating BE
  // bytes as LE.
  const raw = fs.readFileSync(FIXTURE_RAW);
  const copy = Buffer.from(raw);
  copy.writeInt32LE(0, 720);  // OFF_DATA_TYPE = 720, value = 0 = BE_SHORT

  globalThis.HttpRange = {
    async probeLengthNoHead() { return copy.length; },
    async probeLength() { return copy.length; },
    async fetchBuffer() {
      return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
    },
    async rangeFetch(_url, start, endIncl) {
      const slice = copy.slice(start, endIncl + 1);
      return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    },
  };

  await assert.rejects(
    () => ItabReader.open({ eeg_url: 'file://itab-be.raw' }),
    /unsupported data_type|data_type=0/,
    'BE-legacy ITAB must be rejected with a clean error',
  );
});

test('itab: open() rejects implausible nchan with a clean error', async () => {
  // Flip nchan to a value outside 1..640 — the reader must reject
  // before allocating a per-channel array that would consume gigabytes.
  const raw = fs.readFileSync(FIXTURE_RAW);
  const copy = Buffer.from(raw);
  copy.writeInt32LE(99999, 684);  // OFF_NCHAN = 684

  globalThis.HttpRange = {
    async probeLengthNoHead() { return copy.length; },
    async probeLength() { return copy.length; },
    async fetchBuffer() {
      return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
    },
    async rangeFetch(_url, start, endIncl) {
      const slice = copy.slice(start, endIncl + 1);
      return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    },
  };

  await assert.rejects(
    () => ItabReader.open({ eeg_url: 'file://itab-99999.raw' }),
    /implausible nchan|1\.\.640/,
    'out-of-range nchan must be rejected with a clean error',
  );
});

// ─── .mhd sidecar tolerance ──────────────────────────────────────────
// Missing sidecar must NOT block open(). Tests both the "no .mhd"
// case (real-world BIDS files where the sidecar wasn't committed) and
// the "sidecar disagrees" case (a warning, never a hard error).

test('itab: open() succeeds when the .mhd sidecar is absent', async () => {
  // Custom shim that 404s on the sidecar URL but serves the .raw.
  const rawBuf = fs.readFileSync(FIXTURE_RAW);
  globalThis.HttpRange = {
    async probeLengthNoHead(url) {
      if (url.endsWith('.mhd')) throw new Error('ENOENT');
      return rawBuf.length;
    },
    async probeLength(url) {
      if (url.endsWith('.mhd')) throw new Error('ENOENT');
      return rawBuf.length;
    },
    async fetchBuffer(url) {
      if (url.endsWith('.mhd')) throw new Error('ENOENT');
      return rawBuf.buffer.slice(rawBuf.byteOffset, rawBuf.byteOffset + rawBuf.byteLength);
    },
    async rangeFetch(url, start, endIncl) {
      if (url.endsWith('.mhd')) throw new Error('ENOENT');
      const slice = rawBuf.slice(start, endIncl + 1);
      return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    },
  };

  const r = await ItabReader.open({ eeg_url: 'file://itab-no-sidecar.raw' });
  assert.equal(r.n_channels, 4);
  assert.equal(r.n_samples, 500);
});

// ─── api.open via globalThis (registration sanity) ───────────────────
// The IIFE attaches to globalThis.ItabReader; the future viewer/worker
// dispatch tables reach through this name. Pin it so an accidental
// rename in formats/itab.js breaks loudly.

test('itab: module attaches globalThis.ItabReader with the expected surface', () => {
  assert.ok(globalThis.ItabReader, 'globalThis.ItabReader missing');
  assert.equal(typeof globalThis.ItabReader.read, 'function');
  assert.equal(typeof globalThis.ItabReader.open, 'function');
  assert.equal(typeof globalThis.ItabReader._detect, 'function');
  assert.equal(typeof globalThis.ItabReader._ERR_NOT_ITAB, 'string');
});

test('itab: ERR_NOT_ITAB message names what is missing', () => {
  const msg = ItabReader._ERR_NOT_ITAB;
  assert.match(msg, /ITAB/);
  assert.match(msg, /FORMAT: ATB-BIOMAGDATA|signature|magic/i,
    'message should explain WHY this isn\'t recognised as ITAB');
});
