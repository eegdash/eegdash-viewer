// Unit tests for formats/kit.js — both api.read(full buffer) and
// the wrapper api.open(meta) + readWindow(start, n).
//
// Fixture: tests/fixtures/meg/kit-tiny.con (synthesised — see
// scripts/make-kit-fixture.mjs). 4 channels × 500 samples @ 1000 Hz.
//
// Pairs with tests/unit-fiff-realworld.test.mjs in shape — we use a
// file:// HttpRange shim so api.open exercises the production range
// path. Unlike FIFF this test ships only a synthetic fixture; real-
// world KIT files in BIDS aren't routinely re-distributable, and the
// reader's complete byte arithmetic is exercised by the synth.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
// Helpers attach to globalThis on require — load before kit.js.
require('../formats/_buffers.js');
require('../formats/_labels.js');
require('../formats/_decode.js');
const KitReader = require('../formats/kit.js');

const FIXTURE = path.resolve('tests/fixtures/meg/kit-tiny.con');
const EEG_URL = 'file://' + FIXTURE;

function readBuf(rel) {
  const b = fs.readFileSync(rel);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

// ─── api.read(.con buf) ──────────────────────────────────────────────

test('kit: read() parses the synthetic fixture into a header', () => {
  const ab = readBuf(FIXTURE);
  const h = KitReader.read(ab);
  assert.ok(h && typeof h === 'object');
  assert.equal(h.n_channels, 4);
  assert.equal(h.sampling_frequency, 1000);
  assert.equal(h.n_samples, 500);
  assert.equal(h.adc_allocated, 16);
  assert.equal(h.adc_stored, 12);
  assert.equal(h.sample_width, 2);
});

test('kit: read() rejects a tiny / corrupt buffer with a regular Error', () => {
  assert.throws(() => KitReader.read(new ArrayBuffer(8)), Error);
  assert.throws(() => KitReader.read(null), Error);
  assert.throws(() => KitReader.read(undefined), Error);
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
      return fs.statSync(url.replace(/^file:\/\//, '')).size;
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

test('kit: open() returns a reader-shaped object', async () => {
  installLocalHttpRange();
  const r = await KitReader.open({ eeg_url: EEG_URL });
  assert.ok(r, 'open() returned null');
  assert.equal(r.n_channels, 4);
  assert.equal(r.sampling_frequency, 1000);
  assert.equal(r.n_samples, 500);
  // 500 / 1000 = 0.5 s. Float math is exact at this magnitude, but
  // keep a tolerance for safety.
  assert.ok(Math.abs(r.duration_s - 0.5) < 1e-9);
  assert.equal(r.channel_labels.length, 4);
  // The initial port falls back to indexed labels Ch1..ChN — KIT
  // channel-table parsing is deferred (see formats/kit.js header).
  assert.equal(r.channel_labels[0], 'Ch1');
  assert.equal(r.channel_labels[3], 'Ch4');
  assert.equal(r.bytes_per_sample, 2);
  assert.equal(typeof r.readWindow, 'function');
  assert.equal(typeof r.readWindowStreaming, 'function');
});

test('kit: open() requires meta.eeg_url', async () => {
  installLocalHttpRange();
  await assert.rejects(() => KitReader.open({}), /eeg_url is required/);
});

test('kit: readWindow(0, 100) returns 4 × Float32Array[100] with finite data', async () => {
  installLocalHttpRange();
  const r = await KitReader.open({ eeg_url: EEG_URL });
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

test('kit: readWindow value contract — channels differ + per-channel sine [#G2]', async () => {
  installLocalHttpRange();
  const r = await KitReader.open({ eeg_url: EEG_URL });
  const w = await r.readWindow(0, 100);
  // The synth fixture stamps a per-channel-scaled sine wave. Channel 0
  // is sin(2π*t*1/1000), channel 1 is sin(2π*t*2/1000), etc. So at
  // t=10 the four channels MUST produce four distinct values (mod
  // ADC quantisation). Identical values at t=10 would signal the
  // de-interleave loop is reading the same byte across channels —
  // exactly the mutant the matching CTF test was designed to kill.
  const distinct = new Set(w.map((ch) => ch[10]));
  assert.ok(distinct.size > 1,
    `channels at t=10 must differ; got ${[...distinct].join(',')} — interleave likely collapsed`);
  // Sample 0 should be ≈ 0 for every channel (sin(0)=0 → int16(0)
  // → 0 × ad_to_volt = 0).
  for (let c = 0; c < w.length; c++) {
    assert.equal(w[c][0], 0,
      `channel ${c} sample 0 must be exactly 0 (sin(0)=0)`);
  }
});

test('kit: readWindow tail clamps to n_samples (boundary at start = n_samples - 1)', async () => {
  installLocalHttpRange();
  const r = await KitReader.open({ eeg_url: EEG_URL });
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

test('kit: readWindow tail-clamp returns nCh empty arrays when fully past EOF', async () => {
  installLocalHttpRange();
  const r = await KitReader.open({ eeg_url: EEG_URL });
  const win = await r.readWindow(r.n_samples + 100, 5);
  // The contract is one Float32Array per channel — even when empty.
  // This pins the ChannelBuffers.empty(nCh) fallback.
  assert.equal(win.length, r.n_channels);
  for (let c = 0; c < win.length; c++) {
    assert.ok(win[c] instanceof Float32Array);
    assert.equal(win[c].length, 0);
  }
});

test('kit: readWindow(start, nWin) returns exactly nWin samples when fully in-bounds', async () => {
  installLocalHttpRange();
  const r = await KitReader.open({ eeg_url: EEG_URL });
  const win = await r.readWindow(100, 50);
  for (let c = 0; c < win.length; c++) {
    assert.equal(win[c].length, 50,
      `channel ${c}: in-bounds window must return exactly nWin samples`);
  }
});

// ─── format-rejection contract ────────────────────────────────────
// Non-continuous KIT (epoched / evoked) is intentionally NOT supported
// by this initial reader. Pin the rejection so a future regression that
// removes the acq_type guard fails loudly.

test('kit: open() rejects non-continuous acq_type with a clean error [#G2]', async () => {
  // Build an in-memory KIT-like buffer with the SAME structure as the
  // fixture but acq_type = 2 (KIT.EVOKED). We mutate a copy of the
  // fixture in place — its ACQ_COND block lives at a known offset.
  const raw = fs.readFileSync(FIXTURE);
  const copy = Buffer.from(raw);

  // Read the directory directly out of the copy so the patched buffer
  // and our mutation share the same offset arithmetic the reader uses.
  // ACQ_COND is dir entry 8 — offset of acq_type within the block is 0.
  const acqDirEntryBase = 8 * 16;
  const acqOffset = copy.readUInt32LE(acqDirEntryBase + 0);
  copy.writeInt32LE(2, acqOffset);  // acq_type = KIT.EVOKED

  // Local HttpRange shim that serves this in-memory buffer.
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
    () => KitReader.open({ eeg_url: 'file://kit-evoked.con' }),
    /non-continuous|acq_type=2/,
    'evoked KIT must be rejected with a clean error',
  );
});

// ─── api.open via globalThis (registration sanity) ────────────────
// The IIFE attaches to globalThis.KitReader; the viewer/worker
// dispatch tables reach through this name. Pin it so an accidental
// rename in formats/kit.js breaks loudly.

test('kit: module attaches globalThis.KitReader', () => {
  assert.ok(globalThis.KitReader, 'globalThis.KitReader missing');
  assert.equal(typeof globalThis.KitReader.read, 'function');
  assert.equal(typeof globalThis.KitReader.open, 'function');
});
