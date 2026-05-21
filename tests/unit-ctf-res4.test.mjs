// Unit tests for formats/_ctf-res4.js — the CTF .res4 binary header
// parser. Fixture is the deterministic synth at tests/fixtures/meg/
// ctf-tiny.ds/ctf-tiny_meg.res4 (see scripts/make-ctf-fixture.mjs).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const CTFRes4 = require('../formats/_ctf-res4.js');

function readBuf(rel) {
  const b = fs.readFileSync(rel);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

test('ctf-res4: parses synth fixture without throwing', () => {
  const ab = readBuf('tests/fixtures/meg/ctf-tiny.ds/ctf-tiny_meg.res4');
  const h = CTFRes4.parse(ab);
  assert.ok(h && typeof h === 'object', 'parse() returned non-object');
});

test('ctf-res4: header fields match the synth values', () => {
  const ab = readBuf('tests/fixtures/meg/ctf-tiny.ds/ctf-tiny_meg.res4');
  const h = CTFRes4.parse(ab);
  assert.equal(h.no_channels, 4);
  assert.equal(h.no_samples, 250);
  assert.equal(h.sample_rate, 100);
  assert.equal(h.no_trials, 1);
  assert.equal(h.channels.length, 4);
  assert.equal(h.channels[0].name, 'MLT11-1609');
  assert.equal(h.channels[3].name, 'EEG001');
  // sensorTypeIndex from the synth: 9, 9, 9, 14
  assert.equal(h.channels[0].sensor_type, 9);
  assert.equal(h.channels[3].sensor_type, 14);
  // Calibration scalar: 1 / (properGain * qGain * ioGain)
  // synth uses properGain=1e-12, qGain=1, ioGain=1 → 1e12
  assert.ok(Math.abs(h.channels[0].cal - 1e12) < 1, 'cal mismatch');
});

test('ctf-res4: rejects buffer smaller than header', () => {
  const ab = new ArrayBuffer(100);
  assert.throws(() => CTFRes4.parse(ab), /too small|res4/i);
});

test('ctf-res4: rejects buffer with wrong magic', () => {
  // 1844 + 4*(32+1328) = 7284 bytes — large enough; bad magic only.
  const ab = new ArrayBuffer(7284);
  const v = new Uint8Array(ab);
  v.set(new TextEncoder().encode('NOTAMAG\x00'));
  // Set required fields so size checks pass but magic fails.
  // (Corrected offsets per MNE-Python — see _ctf-res4.js for layout.)
  const dv = new DataView(ab);
  dv.setInt32(1288, 1, false);       // no_samples
  dv.setInt16(1292, 4, false);       // no_channels
  dv.setFloat64(1296, 100, false);   // sample_rate
  dv.setFloat64(1304, 0.01, false);  // epoch_time
  dv.setInt16(1312, 1, false);       // no_trials
  assert.throws(() => CTFRes4.parse(ab), /magic|MEG4\dRS/);
});
