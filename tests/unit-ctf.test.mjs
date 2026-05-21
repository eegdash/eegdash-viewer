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

// ─── [#D1] readWindow value correctness + tail-clamp boundary ───
// Pins per-channel sample[10] is finite and channels DIFFER (kills
// interleave-swap mutants like c → c+1 in the de-interleave loop at
// ctf.js:199-202). Tail-clamp tests pin the boundary behaviour at
// exactly n_samples-1, n_samples, and past-end so off-by-one mutants
// on the `start >= n_samples` guard (ctf.js:171) are killed.

test('ctf: readWindow value contract — sample[10] finite + channels differ + tail clamps [#D1]', async () => {
  installLocalHttpRange();
  const reader = await CTFReader.open({ eeg_url: EEG_URL });
  const w0 = await reader.readWindow(0, 100);

  // Per-channel sample[10] must be finite. A mutant that swapped
  // de-interleave indices (e.g. c → c+1) would mostly still produce
  // finite values from the synth fixture, but ALL-channel-same is the
  // signature of a missing interleave loop.
  for (let c = 0; c < reader.n_channels; c++) {
    assert.ok(Number.isFinite(w0[c][10]),
      `channel ${c}: sample 10 was ${w0[c][10]}, expected finite`);
  }
  // Channels must produce different values at t=10. The synth fixture
  // stamps a per-channel-scaled sine wave, so cal[c]*amplitude differs
  // per channel — identical values at t=10 would mean the interleave
  // loop is reading the SAME byte across channels.
  const distinctValues = new Set(w0.map(ch => ch[10]));
  assert.ok(distinctValues.size > 1,
    `channels at t=10 must produce distinct values; got ${[...distinctValues].join(',')} — interleave likely collapsed`);

  // Tail-clamp boundaries.
  const tailMinus1 = await reader.readWindow(reader.n_samples - 1, 5);
  assert.equal(tailMinus1[0].length, 1,
    'exactly 1 sample remains at start = n_samples - 1');

  const atEnd = await reader.readWindow(reader.n_samples, 5);
  assert.equal(atEnd[0].length, 0,
    'must return 0 samples at exactly start = n_samples (guard at ctf.js:171)');

  const past = await reader.readWindow(reader.n_samples + 100, 5);
  assert.equal(past[0].length, 0,
    'past-end (start > n_samples) must also return 0 samples');
});

// ─── [#D4] CTF magic-byte regex boundary ────────────────────────
// Pins the magic-byte check at ctf.js:159 — `/^MEG4[12]CP$/`. Mutants
// on the character class [12] (e.g. [123]), the anchors (^…$), or the
// literal "MEG4...CP" sub-strings would survive without this test.
// We build a fake .meg4 with a synthesized header that has the wrong
// magic and verify open() rejects with "bad magic".

test('ctf: open() rejects .meg4 with non-MEG4[12]CP magic [#D4]', async () => {
  const realRes4 = readBuf('tests/fixtures/meg/ctf-tiny.ds/ctf-tiny_meg.res4');
  // 4 channels × 250 samples × 4 bytes + 8-byte magic header.
  const FAKE_BODY_SAMPLES = 250;
  const FAKE_NCH = 4;
  const FAKE_BPS = 4;
  const fakeMeg4Size = 8 + FAKE_NCH * FAKE_BPS * FAKE_BODY_SAMPLES;

  function makeFakeMeg4(magicStr) {
    const ab = new ArrayBuffer(fakeMeg4Size);
    const bytes = new Uint8Array(ab);
    // Write the magic (8 bytes including trailing NUL).
    const encoded = new TextEncoder().encode(magicStr);
    bytes.set(encoded.slice(0, 8));
    if (encoded.length < 8) bytes[encoded.length] = 0; // NUL-terminate
    return ab;
  }

  function installMagicShim(fakeMeg4) {
    globalThis.HttpRange = {
      async probeLength(url) {
        if (url.endsWith('.res4')) return realRes4.byteLength;
        if (url.endsWith('.meg4')) return fakeMeg4.byteLength;
        return 0;
      },
      async fetchBuffer(url) {
        if (url.endsWith('.res4')) return realRes4;
        if (url.endsWith('.meg4')) return fakeMeg4;
        return new ArrayBuffer(0);
      },
      async fetchTextOrNull() { return null; },
      async rangeFetch() { return fakeMeg4; },
    };
  }

  // Case 1: "MEG43CP\0" — character class [12] mutated to admit 3.
  installMagicShim(makeFakeMeg4('MEG43CP\0'));
  await assert.rejects(
    () => CTFReader.open({ eeg_url: EEG_URL }),
    /bad magic/,
    'MEG43CP must be rejected — character class [12] boundary',
  );

  // Case 2: leading space breaks the ^ anchor — " MEG41CP" must reject.
  // Without the ^ anchor, `.test(magStr)` would match the substring
  // and let this slip through.
  installMagicShim(makeFakeMeg4(' MEG41CP'));
  await assert.rejects(
    () => CTFReader.open({ eeg_url: EEG_URL }),
    /bad magic/,
    'leading whitespace must be rejected — ^ anchor boundary',
  );

  // Case 3: trailing junk would slip past without $ anchor. The .meg4
  // magic at offset 0..7 is replaced with "MEG41CPX" (no NUL at byte 7
  // so the strip-after-NUL preserves the 'X' suffix → test rejects).
  installMagicShim(makeFakeMeg4('MEG41CPX'));
  await assert.rejects(
    () => CTFReader.open({ eeg_url: EEG_URL }),
    /bad magic/,
    'trailing junk must be rejected — $ anchor boundary',
  );
});
