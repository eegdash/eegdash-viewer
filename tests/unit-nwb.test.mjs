// Unit tests for formats/nwb.js — the NWB (HDF5-backed) iEEG reader.
// Fixture is tests/fixtures/ieeg/nwb-tiny.nwb (synthetic, CC0; produced
// by scripts/make-nwb-fixture.mjs via Python h5py).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

// jsfive sets globalThis.hdf5 in the browser bundle but in Node we
// pull it in directly through require. The reader's getJsfive() helper
// (mirrors _mat73.js and snirf.js) handles both.
globalThis.hdf5 = require('jsfive');

// HttpRange.fetchBuffer / probeLength shim — production wires these via
// formats/_http_range.js. For Node tests, read straight from disk so
// open() works without a real HTTP server. Mirrors unit-snirf.test.mjs.
function installLocalHttpRange() {
  globalThis.HttpRange = {
    fetchBuffer: async (url) => {
      const filePath = url.replace(/^file:\/\//, '');
      const b = fs.readFileSync(filePath);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    probeLength: async (url) => {
      const filePath = url.replace(/^file:\/\//, '');
      return fs.statSync(filePath).size;
    },
  };
}
installLocalHttpRange();

// ChannelBuffers shim — production has formats/_buffers.js; the reader
// uses ChannelBuffers.alloc(nCh, n) to produce one Float32Array per
// channel. Stub it for the test.
globalThis.ChannelBuffers = {
  alloc: (nCh, n) => Array.from({ length: nCh }, () => new Float32Array(n)),
  empty: (nCh) => Array.from({ length: nCh }, () => new Float32Array(0)),
  clampWindow: (startSample, nWin, nSamples) => {
    const start = Math.max(0, startSample | 0);
    const n = Math.max(0, nWin | 0);
    if (start >= nSamples || n === 0) return null;
    const end = Math.min(start + n, nSamples);
    return { start, end, nWin: end - start };
  },
};
// ChannelLabels shim — production has formats/_labels.js.
globalThis.ChannelLabels = {
  indexed: (n) => {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = 'Ch' + (i + 1);
    return out;
  },
};

const NwbReader = require('../formats/nwb.js');

const FIXTURE_PATH = path.resolve('tests/fixtures/ieeg/nwb-tiny.nwb');
const FIXTURE = 'file://' + FIXTURE_PATH;
const HAS_FIXTURE = fs.existsSync(FIXTURE_PATH);

// The fixture is byte-stable from scripts/make-nwb-fixture.mjs:
// 4 channels at 1000 Hz for 5 s (= 5000 samples). Channel labels
// LFP1..LFP4. Sample c is sin(2π(c+1)t).
const EXPECTED_CHANNELS = 4;
const EXPECTED_FS = 1000;
const EXPECTED_SAMPLES = 5000;
const EXPECTED_LABELS = ['LFP1', 'LFP2', 'LFP3', 'LFP4'];

test('nwb.open: returns a reader with the cross-format contract', { skip: !HAS_FIXTURE && 'fixture missing — run scripts/make-nwb-fixture.mjs' }, async () => {
  const r = await NwbReader.open({ eeg_url: FIXTURE });
  assert.equal(r.n_channels, EXPECTED_CHANNELS, 'n_channels');
  assert.equal(r.sampling_frequency, EXPECTED_FS, 'sampling_frequency');
  assert.equal(r.n_samples, EXPECTED_SAMPLES, 'n_samples');
  assert.equal(r.duration_s, EXPECTED_SAMPLES / EXPECTED_FS, 'duration_s');
  assert.equal(typeof r.readWindow, 'function', 'readWindow is a function');
  assert.equal(Array.isArray(r.channel_labels), true, 'channel_labels is array');
  assert.equal(r.channel_labels.length, r.n_channels, 'one label per channel');
  assert.deepEqual(r.channel_labels, EXPECTED_LABELS, 'electrodes table label column resolved');
  assert.equal(Array.isArray(r.channel_types), true, 'channel_types is array');
  assert.equal(r.channel_types[0], 'ieeg', 'channels report as ieeg');
  assert.equal(r.bytes_per_sample, 4, 'fixture stores float32');
  assert.equal(Array.isArray(r.annotation_events), true, 'annotation_events present');
});

test('nwb.readWindow: returns one Float32Array per channel with the requested length', { skip: !HAS_FIXTURE && 'fixture missing' }, async () => {
  const r = await NwbReader.open({ eeg_url: FIXTURE });
  const n = Math.min(10, r.n_samples);
  const win = await r.readWindow(0, n);
  assert.equal(Array.isArray(win), true, 'returns array');
  assert.equal(win.length, r.n_channels, 'one buffer per channel');
  assert.equal(win[0] instanceof Float32Array, true, 'channel buffer is Float32Array');
  assert.equal(win[0].length, n, 'window length matches request');
  // First sample of channel 0 is sin(2π * 1 * 0) == 0 in the synthetic
  // fixture. All values finite.
  for (let c = 0; c < r.n_channels; c++) {
    for (let s = 0; s < n; s++) {
      assert.equal(Number.isFinite(win[c][s]), true,
        `non-finite at c=${c} s=${s}: ${win[c][s]}`);
    }
  }
  // Channel 0 sample 0 should equal sin(0) = 0 (within float epsilon).
  assert.ok(Math.abs(win[0][0]) < 1e-6, `chan 0 sample 0 ≈ 0, got ${win[0][0]}`);
});

test('nwb.readWindow: mid-file window returns continuous slice', { skip: !HAS_FIXTURE && 'fixture missing' }, async () => {
  const r = await NwbReader.open({ eeg_url: FIXTURE });
  // Read 100 samples starting at 1000 (= t=1.0 s). The fixture's
  // channel c carries sin(2π(c+1)t), so we know exactly what each
  // sample should be — verify a couple to make sure indexing is right.
  const win = await r.readWindow(1000, 100);
  assert.equal(win.length, r.n_channels);
  assert.equal(win[0].length, 100);
  // At t = 1.0 s with f=1 Hz, sin(2π * 1) ≈ 0. Floats can be a touch off.
  assert.ok(Math.abs(win[0][0]) < 1e-3, `at t=1, chan 0 ≈ 0, got ${win[0][0]}`);
  // Channel 1 at t=1.0 s is sin(2π * 2 * 1) ≈ 0 as well.
  assert.ok(Math.abs(win[1][0]) < 1e-3, `at t=1, chan 1 ≈ 0, got ${win[1][0]}`);
});

test('nwb.readWindow: tail-clamp at n_samples-1 returns exactly 1 sample', { skip: !HAS_FIXTURE && 'fixture missing' }, async () => {
  const r = await NwbReader.open({ eeg_url: FIXTURE });
  const win = await r.readWindow(r.n_samples - 1, 10);
  assert.equal(win[0].length, 1, 'one sample remaining at the EOF');
});

test('nwb.readWindow: clamps to EOF gracefully when start is past end', { skip: !HAS_FIXTURE && 'fixture missing' }, async () => {
  const r = await NwbReader.open({ eeg_url: FIXTURE });
  // start == n_samples is degenerate — clampWindow returns null, the
  // reader returns empty per-channel buffers. Must not throw.
  const win = await r.readWindow(r.n_samples, 10);
  assert.equal(win.length, r.n_channels);
  assert.equal(win[0].length, 0, 'empty buffer when window is fully past EOF');
});

test('nwb.readWindow: clamps to EOF when window straddles the end', { skip: !HAS_FIXTURE && 'fixture missing' }, async () => {
  const r = await NwbReader.open({ eeg_url: FIXTURE });
  // Ask for more samples than exist starting from 0 — should return all
  // n_samples, not throw and not pad.
  const win = await r.readWindow(0, r.n_samples + 10);
  assert.equal(win[0].length, r.n_samples);
});

test('nwb.readWindow: clamps to EOF when window straddles partway', { skip: !HAS_FIXTURE && 'fixture missing' }, async () => {
  const r = await NwbReader.open({ eeg_url: FIXTURE });
  // Ask for 100 samples starting at n_samples-50 — get exactly 50 back.
  const win = await r.readWindow(r.n_samples - 50, 100);
  assert.equal(win[0].length, 50);
});

test('nwb.open: throws clearly when the file is not HDF5', async () => {
  const tmp = path.join('tests/fixtures/ieeg', 'not-nwb.bin');
  fs.writeFileSync(tmp, Buffer.from('DEFINITELY_NOT_NWB_OR_HDF5_____'));
  await assert.rejects(
    NwbReader.open({ eeg_url: 'file://' + path.resolve(tmp) }),
    /NWB|HDF5|not.*valid/i,
  );
  fs.unlinkSync(tmp);
});

test('nwb.read: works directly on an ArrayBuffer (no URL needed)', { skip: !HAS_FIXTURE && 'fixture missing' }, async () => {
  // Mirrors SnirfReader.read — used by callers that have the bytes
  // already (e.g. drag-drop, integration tests that mock the network).
  const b = fs.readFileSync(FIXTURE_PATH);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const r = await NwbReader.read(ab);
  assert.equal(r.n_channels, EXPECTED_CHANNELS);
  assert.equal(r.n_samples, EXPECTED_SAMPLES);
});

test('nwb._isHdf5AtZero: rejects buffers with no HDF5 magic at offset 0', () => {
  assert.equal(NwbReader._isHdf5AtZero(new Uint8Array(0)), false, 'empty buffer');
  assert.equal(NwbReader._isHdf5AtZero(new Uint8Array(4)), false, 'too short');
  // HDF5 magic offset by one byte — common MAT v7.3 confusion.
  const offset = new Uint8Array(16);
  offset[1] = 0x89; offset[2] = 0x48; offset[3] = 0x44; offset[4] = 0x46;
  offset[5] = 0x0d; offset[6] = 0x0a; offset[7] = 0x1a; offset[8] = 0x0a;
  assert.equal(NwbReader._isHdf5AtZero(offset), false, 'must be at byte 0');
  // Correct magic at offset 0.
  const ok = new Uint8Array([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  assert.equal(NwbReader._isHdf5AtZero(ok), true);
});

test('nwb._normaliseShape: rejects garbage shapes', () => {
  assert.throws(() => NwbReader._normaliseShape(null), /2-D/);
  assert.throws(() => NwbReader._normaliseShape([100]), /2-D/);
  assert.throws(() => NwbReader._normaliseShape([0, 4]), /empty/);
  assert.throws(() => NwbReader._normaliseShape([5000, 0]), /empty/);
  // Both dims above the 4096 cap → refuse.
  assert.throws(() => NwbReader._normaliseShape([8192, 8192]), /exceed/);
});

test('nwb._normaliseShape: detects canonical vs transposed layout', () => {
  // Canonical NWB [n_samples=5000, n_channels=4]
  const a = NwbReader._normaliseShape([5000, 4]);
  assert.equal(a.nSamples, 5000);
  assert.equal(a.nChannels, 4);
  assert.equal(a.transposed, false);
  // EEGLAB-style [n_channels=4, n_samples=5000]
  const b = NwbReader._normaliseShape([4, 5000]);
  assert.equal(b.nSamples, 5000);
  assert.equal(b.nChannels, 4);
  assert.equal(b.transposed, true);
});

test('nwb._trimNulString: strips trailing NULs from fixed-length HDF5 strings', () => {
  assert.equal(NwbReader._trimNulString('LFP1    '), 'LFP1');
  assert.equal(NwbReader._trimNulString('clean'), 'clean');
  assert.equal(NwbReader._trimNulString(''), '');
  assert.equal(NwbReader._trimNulString('  '), '');  // whitespace too
});
