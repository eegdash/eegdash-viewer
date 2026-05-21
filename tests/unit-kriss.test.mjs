// Unit tests for formats/kriss.js — the KRISS MEG .kdf STUB reader.
//
// Pairs with tests/unit-kit.test.mjs in shape (file:// HttpRange shim,
// IIFE-on-globalThis discovery), but the assertions are fundamentally
// different: kriss.js is a stub that throws on every input. Tests pin
// the TWO distinct error paths so a future Tier-2 implementation can
// keep the same detect-and-throw contract while it grows a real
// parser body.
//
// Fixture: tests/fixtures/meg/kriss-tiny.kdf (synthesised — see
// scripts/make-kriss-fixture.mjs). The fixture has the conservative
// "KDF\0" magic at offset 0 plus "KRISS MEG v0.0" at offset 16, so it
// triggers the "KRISS-shaped" branch and the stub's not-yet-implemented
// error path.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const KrissReader = require('../formats/kriss.js');

const FIXTURE = path.resolve('tests/fixtures/meg/kriss-tiny.kdf');
const EEG_URL = 'file://' + FIXTURE;

function readBuf(rel) {
  const b = fs.readFileSync(rel);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

// ─── api.read(buf) — synchronous detect-and-throw ────────────────────

test('kriss: read() throws ERR_NOT_IMPLEMENTED on the synthetic fixture (KRISS-shaped)', () => {
  const ab = readBuf(FIXTURE);
  assert.throws(
    () => KrissReader.read(ab),
    (err) => {
      // The fixture carries the "KDF" magic + "KRISS" label, so the
      // detector must fire and the reader must throw the SPECIFIC
      // "not yet implemented" error — NOT the "not KRISS" error.
      assert.ok(err instanceof Error, 'must throw an Error');
      assert.match(err.message, /not yet implemented/i,
        `expected ERR_NOT_IMPLEMENTED; got: ${err.message}`);
      // Pin a few user-facing words so the message stays informative
      // across refactors (an over-shortened message would hurt the
      // viewer's error dialog).
      assert.match(err.message, /KRISS/);
      assert.match(err.message, /\.kdf|kdf/i);
      return true;
    },
  );
});

test('kriss: read() throws ERR_NOT_KRISS on clearly-non-KRISS bytes', () => {
  // 256 bytes of all-zero — no "KDF" or "KRISS" anywhere in the
  // first 64 B. Must produce the "not a valid KRISS .kdf" error,
  // NOT the "not yet implemented" error.
  const empty = new Uint8Array(256);  // all zeros
  assert.throws(
    () => KrissReader.read(empty.buffer),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /does not appear to be a valid KRISS/i,
        `expected ERR_NOT_KRISS; got: ${err.message}`);
      // Crucially must NOT be the "not yet implemented" message —
      // that would mean the detector mis-fired on zero bytes.
      assert.doesNotMatch(err.message, /not yet implemented/i);
      return true;
    },
  );
});

test('kriss: read() rejects tiny / null buffers with a regular Error', () => {
  // < 8 bytes — too short to inspect the header. The error message
  // doesn't have to be one of the two stable strings; only that an
  // Error is thrown is contractual here.
  assert.throws(() => KrissReader.read(new ArrayBuffer(4)), Error);
  assert.throws(() => KrissReader.read(null), Error);
  assert.throws(() => KrissReader.read(undefined), Error);
});

// ─── magic-byte detector ─────────────────────────────────────────────
// Exposed via api._detect so the routing layer (future) and tests can
// ask "is this a KRISS file?" without going through the throw-on-
// success api.read path.

test('kriss: _detect() returns true for the "KDF\\0" magic at offset 0', () => {
  const buf = new Uint8Array(64);
  buf[0] = 0x4b; buf[1] = 0x44; buf[2] = 0x46;  // "KDF"
  assert.equal(KrissReader._detect(buf), true);
});

test('kriss: _detect() returns true for "KRISS" anywhere in the first 64 B', () => {
  const buf = new Uint8Array(64);
  // Place "KRISS" at offset 20 — a plausible label position the real
  // vendor binary could use. Must still detect.
  const sig = 'KRISS';
  for (let i = 0; i < sig.length; i++) buf[20 + i] = sig.charCodeAt(i);
  assert.equal(KrissReader._detect(buf), true);
});

test('kriss: _detect() returns false for all-zero / unrelated bytes', () => {
  assert.equal(KrissReader._detect(new Uint8Array(64)), false);
  // ASCII "EDF" — a real EDF file would start with "0       " (eight
  // ASCII spaces version string) so a real EDF can't false-positive
  // here, but pin the lowercase / wrong-letter rejection just to be
  // sure.
  const edflike = new Uint8Array(64);
  edflike[0] = 0x45; edflike[1] = 0x44; edflike[2] = 0x46;  // "EDF"
  assert.equal(KrissReader._detect(edflike), false);
});

test('kriss: _detect() is case-sensitive (lowercase "kdf" does NOT match)', () => {
  // Lowercase signature must be rejected. This guards against false
  // positives on EEG/iEEG annotation text blocks that might contain
  // the substring "kdf" in metadata fields.
  const buf = new Uint8Array(64);
  buf[0] = 0x6b; buf[1] = 0x64; buf[2] = 0x66;  // "kdf" lowercase
  assert.equal(KrissReader._detect(buf), false);
});

test('kriss: _detect() returns false on buffers shorter than 3 bytes', () => {
  assert.equal(KrissReader._detect(new Uint8Array(0)), false);
  assert.equal(KrissReader._detect(new Uint8Array(2)), false);
});

// ─── api.open + HttpRange shim — async path ──────────────────────────

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
      return slice.buffer.slice(
        slice.byteOffset, slice.byteOffset + slice.byteLength,
      );
    },
  };
}

test('kriss: open() throws ERR_NOT_IMPLEMENTED on the KRISS-shaped fixture', async () => {
  installLocalHttpRange();
  await assert.rejects(
    () => KrissReader.open({ eeg_url: EEG_URL }),
    /not yet implemented/i,
    'open() must reach the "support pending" path on a KRISS-shaped fixture',
  );
});

test('kriss: open() throws ERR_NOT_KRISS on a non-KRISS file', async () => {
  // Write an in-memory non-KRISS buffer (all zeros) and serve via the
  // HttpRange shim. open() must reject with the "not KRISS" error so
  // the future viewer routing layer can tell "wrong reader" apart
  // from "right reader, support pending".
  const fake = Buffer.alloc(1024, 0);
  globalThis.HttpRange = {
    async probeLengthNoHead() { return fake.length; },
    async probeLength() { return fake.length; },
    async fetchBuffer() {
      return fake.buffer.slice(
        fake.byteOffset, fake.byteOffset + fake.byteLength,
      );
    },
    async rangeFetch(_url, start, endIncl) {
      const slice = fake.slice(start, endIncl + 1);
      return slice.buffer.slice(
        slice.byteOffset, slice.byteOffset + slice.byteLength,
      );
    },
  };
  await assert.rejects(
    () => KrissReader.open({ eeg_url: 'file://not-kriss.kdf' }),
    /does not appear to be a valid KRISS/i,
    'open() must reject non-KRISS bytes with ERR_NOT_KRISS',
  );
});

test('kriss: open() requires meta.eeg_url', async () => {
  installLocalHttpRange();
  await assert.rejects(() => KrissReader.open({}), /eeg_url is required/);
});

test('kriss: open() rejects files smaller than 8 bytes with a clean error', async () => {
  // Write a 4-byte buffer to a temp file and shim it through HttpRange.
  // The reader's totalBytes < 8 check must fire BEFORE the rangeFetch
  // — verified by the rangeFetch shim throwing if it's ever called.
  const tiny = Buffer.from([0x4b, 0x44, 0x46, 0x00]);  // "KDF\0" — would
                                                       // be detected if the
                                                       // size check were
                                                       // skipped.
  globalThis.HttpRange = {
    async probeLengthNoHead() { return tiny.length; },
    async probeLength() { return tiny.length; },
    async fetchBuffer() {
      throw new Error('fetchBuffer should not be called for tiny files');
    },
    async rangeFetch() {
      throw new Error('rangeFetch should not be called for tiny files');
    },
  };
  await assert.rejects(
    () => KrissReader.open({ eeg_url: 'file://tiny.kdf' }),
    /too small/i,
    'open() must reject sub-8-byte files before issuing a range request',
  );
});

// ─── globalThis registration ─────────────────────────────────────────
// Pin the name so a rename in formats/kriss.js fails loudly. The
// future viewer/worker wiring will reach through this exact name.

test('kriss: module attaches globalThis.KrissReader with the expected surface', () => {
  assert.ok(globalThis.KrissReader, 'globalThis.KrissReader missing');
  assert.equal(typeof globalThis.KrissReader.read, 'function');
  assert.equal(typeof globalThis.KrissReader.open, 'function');
  // Internal helpers — exposed for tests, kept stable for future Tier-2
  // refactors that swap the throw for a real parser body.
  assert.equal(typeof globalThis.KrissReader._detect, 'function');
  assert.equal(typeof globalThis.KrissReader._ERR_NOT_KRISS, 'string');
  assert.equal(typeof globalThis.KrissReader._ERR_NOT_IMPLEMENTED, 'string');
});

// ─── error-message stability ─────────────────────────────────────────
// The two error messages are part of the public contract — the viewer's
// error dialog will substring-match on them once KRISS routing is wired
// in. Pin a few key phrases so an unrelated copy-edit can't silently
// drop the user-actionable bits.

test('kriss: ERR_NOT_IMPLEMENTED message contains user-actionable guidance', () => {
  const msg = KrissReader._ERR_NOT_IMPLEMENTED;
  assert.match(msg, /KRISS/);
  assert.match(msg, /not yet implemented/i);
  assert.match(msg, /open an issue|github|maintainer|spec/i,
    'message should point users toward a next step');
});

test('kriss: ERR_NOT_KRISS message identifies what is missing', () => {
  const msg = KrissReader._ERR_NOT_KRISS;
  assert.match(msg, /KRISS|KDF/i);
  assert.match(msg, /signature|magic|valid/i,
    'message should explain WHY this isn\'t recognised as KRISS');
});
