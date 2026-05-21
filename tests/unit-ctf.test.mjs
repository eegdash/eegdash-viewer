// Unit tests for formats/ctf.js — both api.read(.res4 buffer) and
// the wrapper api.open(meta) + readWindow(start, n).
//
// Fixture: tests/fixtures/meg/ctf-tiny.ds/ (synthesised — see
// scripts/make-ctf-fixture.mjs). 4 channels × 250 samples @ 100 Hz.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
// Helper modules attach to globalThis on require — load them first.
require('../formats/_ctf-res4.js');
require('../formats/_ctf-marker.js');
const CTFReader = require('../formats/ctf.js');

function readBuf(rel) {
  const b = fs.readFileSync(rel);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

// ─── api.read(.res4 buf) ─────────────────────────────────────────

test('ctf: read() parses the .res4 fixture into a header', () => {
  const ab = readBuf('tests/fixtures/meg/ctf-tiny.ds/ctf-tiny_meg.res4');
  const h = CTFReader.read(ab);
  assert.ok(h && typeof h === 'object');
  assert.equal(h.no_channels, 4);
  assert.equal(h.sample_rate, 100);
});

test('ctf: read() rejects a truncated buffer with a regular Error', () => {
  assert.throws(() => CTFReader.read(new ArrayBuffer(50)), Error);
});

test('ctf: read() rejects null/undefined input with a regular Error', () => {
  assert.throws(() => CTFReader.read(null), Error);
  assert.throws(() => CTFReader.read(undefined), Error);
});

test('ctf: read() never returns null/undefined for accepted input', () => {
  const ab = readBuf('tests/fixtures/meg/ctf-tiny.ds/ctf-tiny_meg.res4');
  const h = CTFReader.read(ab);
  assert.notEqual(h, null);
  assert.notEqual(h, undefined);
});

// ─── api.open + readWindow ─────────────────────────────────────────
// Mock HttpRange so open() resolves against the local .ds/ fixture.
// The reader is told the eeg_url is .../<entities>_meg.meg4 (inside
// the bundle) — exactly what bids-recording.js's ext=ds branch builds.

const FIXTURE_DS = path.resolve('tests/fixtures/meg/ctf-tiny.ds');
const EEG_URL    = 'file://' + FIXTURE_DS + '/ctf-tiny_meg.meg4';

function installLocalHttpRange() {
  globalThis.HttpRange = {
    async probeLength(url) {
      const p = url.replace(/^file:\/\//, '');
      return fs.statSync(p).size;
    },
    async fetchBuffer(url) {
      const p = url.replace(/^file:\/\//, '');
      const b = fs.readFileSync(p);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    async rangeFetch(url, start, endIncl) {
      const p = url.replace(/^file:\/\//, '');
      const b = fs.readFileSync(p);
      const slice = b.slice(start, endIncl + 1);
      return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    },
    async fetchText(url) {
      const p = url.replace(/^file:\/\//, '');
      return fs.readFileSync(p, 'utf-8');
    },
    async fetchTextOrNull(url) {
      try { return await this.fetchText(url); }
      catch { return null; }
    },
  };
}

test('ctf: open() returns a reader-shaped object', async () => {
  installLocalHttpRange();
  const reader = await CTFReader.open({ eeg_url: EEG_URL });
  assert.ok(reader, 'open() returned null');
  assert.equal(reader.n_channels, 4);
  assert.equal(reader.sampling_frequency, 100);
  assert.equal(reader.n_samples, 250);
  assert.ok(Math.abs(reader.duration_s - 2.5) < 0.001);
  assert.equal(reader.channel_labels.length, 4);
  assert.equal(reader.channel_labels[0], 'MLT11-1609');
  // CTF .meg4 samples are int32 BE per MNE — see formats/ctf.js.
  assert.equal(reader.bytes_per_sample, 4);
  assert.equal(typeof reader.readWindow, 'function');
});

test('ctf: open() surfaces MarkerFile.mrk as annotation_events', async () => {
  installLocalHttpRange();
  const reader = await CTFReader.open({ eeg_url: EEG_URL });
  assert.ok(Array.isArray(reader.annotation_events));
  assert.equal(reader.annotation_events.length, 2);
  assert.equal(reader.annotation_events[0].label, 'Trigger1');
});

test('ctf: readWindow(0, 100) returns nCh Float32Arrays of length 100', async () => {
  installLocalHttpRange();
  const reader = await CTFReader.open({ eeg_url: EEG_URL });
  const win = await reader.readWindow(0, 100);
  assert.equal(win.length, reader.n_channels);
  for (let c = 0; c < win.length; c++) {
    assert.ok(win[c] instanceof Float32Array,
      `channel ${c} window must be Float32Array`);
    assert.equal(win[c].length, 100);
  }
});

test('ctf: readWindow at tail clamps to n_samples', async () => {
  installLocalHttpRange();
  const reader = await CTFReader.open({ eeg_url: EEG_URL });
  const win = await reader.readWindow(reader.n_samples - 10, 1000);
  assert.equal(win.length, reader.n_channels);
  assert.ok(win[0].length <= 10);
  assert.ok(win[0].length > 0);
});

test('ctf: readWindow applies per-channel calibration (non-zero gain)', async () => {
  installLocalHttpRange();
  const reader = await CTFReader.open({ eeg_url: EEG_URL });
  const win = await reader.readWindow(0, 50);
  // The synth fixture stamps a sine wave with amplitude ≈ 1000 ints.
  // After calibration (cal = 1e12), samples should be ≈ 1e15 in
  // magnitude — at minimum, *some* value must be finite-non-zero.
  let nonZero = 0;
  for (const v of win[0]) if (v !== 0 && Number.isFinite(v)) nonZero++;
  assert.ok(nonZero > 0, 'calibration produced all-zero or non-finite values');
});

test('ctf: open() requires meta.eeg_url', async () => {
  installLocalHttpRange();
  await assert.rejects(() => CTFReader.open({}), /eeg_url is required/);
});
