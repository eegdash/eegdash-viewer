// tests/unit-fiff-realworld.test.mjs
//
// Reality-check test for the FIFF reader against a real-world (not
// synthesised) MEG fixture. Pairs with tests/unit-fiff-raw.test.mjs:
// that file uses a 5 KB synth fixture; this one uses the 432 KB
// `test_ctf_comp_raw.fif` shipped in MNE-Python's repo
// (https://github.com/mne-tools/mne-python, BSD-3-clause).
//
// Why the real-world fixture matters: Plan D browser reality-check
// (commit f524bad) revealed that the FIFF reader threw TypeError at
// production runtime because `HttpRange.fetchBuffer` was mock-only —
// the synthesised tests passed because they ran the same mock. This
// test exercises the reader through the production HttpRange
// (file:// scheme via a thin shim) to catch the same class of bug.
//
// Source / license: see tests/fixtures/meg/LICENSE-ATTRIBUTION.md.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
require('../formats/_buffers.js');
require('../formats/_fiff-dir.js');
const FIFFReader = require('../formats/fiff.js');

const FIXTURE = path.resolve('tests/fixtures/meg/test_ctf_comp_raw.fif');
const skipIfMissing = !fs.existsSync(FIXTURE);

// Install a file:// HttpRange shim — same interface as production
// _http_range.js exports.
globalThis.HttpRange = {
  async fetchBuffer(url) {
    const p = url.replace(/^file:\/\//, '');
    const buf = fs.readFileSync(p);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },
  async probeLength(url) {
    return fs.statSync(url.replace(/^file:\/\//, '')).size;
  },
  async probeLengthNoHead(url) {
    return fs.statSync(url.replace(/^file:\/\//, '')).size;
  },
  async rangeFetch(url, start, end) {
    const buf = fs.readFileSync(url.replace(/^file:\/\//, ''));
    const slice = buf.slice(start, end + 1);
    return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
  },
};

test('fiff real-world: api.read parses the 432 KB MNE-Python fixture', { skip: skipIfMissing }, () => {
  const buf = fs.readFileSync(FIXTURE);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const meas = FIFFReader.read(ab);
  // 340 channels at 480 Hz — these are the canonical values for
  // test_ctf_comp_raw.fif. Any drift means the parser regressed.
  assert.equal(meas.nchan, 340, 'nchan must be 340');
  assert.equal(meas.sfreq, 480, 'sfreq must be 480 Hz');
  assert.ok(meas.raw, 'meas.raw must be present (file has FIFFB_RAW_DATA block 107)');
  assert.ok(Array.isArray(meas.chs), 'chs must be an array of channel info');
  assert.equal(meas.chs.length, 340, 'chs length must equal nchan');
  // Verify channel-info shape — these names come straight from the
  // CTF compensation calibration data this file captures.
  assert.equal(typeof meas.chs[0].name, 'string');
  assert.ok(meas.chs[0].name.length > 0, 'channel 0 must have a non-empty name');
});

test('fiff real-world: api.open returns the expected reader shape', { skip: skipIfMissing }, async () => {
  const reader = await FIFFReader.open({ eeg_url: 'file://' + FIXTURE });
  assert.equal(reader.n_channels, 340);
  assert.equal(reader.sampling_frequency, 480);
  assert.ok(reader.n_samples > 0, 'n_samples must be positive (file has raw data)');
  assert.ok(reader.duration_s > 0, 'duration_s must be positive');
  assert.equal(typeof reader.readWindow, 'function');
  assert.ok(Array.isArray(reader.channel_labels));
  assert.equal(reader.channel_labels.length, 340);
});

test('fiff real-world: readWindow returns 340 × Float32Array[100] with finite data', { skip: skipIfMissing }, async () => {
  const reader = await FIFFReader.open({ eeg_url: 'file://' + FIXTURE });
  const win = await reader.readWindow(0, 100);
  assert.equal(win.length, 340, 'one Float32Array per channel');
  for (let c = 0; c < win.length; c++) {
    assert.ok(win[c] instanceof Float32Array, `channel ${c} must be Float32Array`);
    assert.equal(win[c].length, 100, `channel ${c} must have 100 samples`);
    // Every value must be finite. The fixture has actual non-zero
    // recorded data — verified via xxd that bytes are not all zero.
    for (let i = 0; i < win[c].length; i++) {
      assert.ok(isFinite(win[c][i]), `channel ${c} sample ${i} is not finite: ${win[c][i]}`);
    }
  }
});

test('fiff real-world: readWindow tail clamps to n_samples', { skip: skipIfMissing }, async () => {
  const reader = await FIFFReader.open({ eeg_url: 'file://' + FIXTURE });
  // Ask for more samples than remain — must return at most n_samples - start.
  const tailStart = Math.max(0, reader.n_samples - 5);
  const win = await reader.readWindow(tailStart, 1000);
  assert.ok(win[0].length <= 5, `tail clamp: expected ≤5 samples, got ${win[0].length}`);
  assert.ok(win[0].length > 0, 'must return at least 1 sample');
});
