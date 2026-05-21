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
