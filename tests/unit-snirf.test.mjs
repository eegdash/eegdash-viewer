// Unit tests for formats/snirf.js — the SNIRF (HDF5-backed) fNIRS reader.
// Fixture is tests/fixtures/nirs/snirf-tiny.snirf (Simple_Probe.snirf
// from github.com/fNIRS/snirf-samples, public domain).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

// jsfive sets globalThis.hdf5 in the browser bundle but in Node we
// pull it in directly through require. The reader's getJsfive() helper
// (mirrors _mat73.js) handles both.
globalThis.hdf5 = require('jsfive');

// HttpRange's fetchBuffer is used by the production reader. For Node
// tests, stub it to read the local file straight from disk so the
// reader's `open()` works without a real HTTP server.
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

// ChannelBuffers shim — production has formats/_buffers.js; the
// reader uses ChannelBuffers.alloc(nCh, nSamples) to produce one
// Float32Array per channel. Stub it for the test.
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

const SnirfReader = require('../formats/snirf.js');

const FIXTURE = 'file://' + path.resolve('tests/fixtures/nirs/snirf-tiny.snirf');

test('snirf.open: returns a reader with the cross-format contract', async () => {
  const r = await SnirfReader.open({ eeg_url: FIXTURE });
  assert.ok(r.n_channels > 0, 'n_channels');
  assert.ok(r.sampling_frequency > 0, 'sampling_frequency');
  assert.ok(r.n_samples > 0, 'n_samples');
  assert.ok(r.duration_s > 0, 'duration_s');
  assert.equal(r.bytes_per_sample, 8, 'snirf stores float64');
  assert.equal(typeof r.readWindow, 'function');
  assert.equal(Array.isArray(r.channel_labels), true);
  assert.equal(r.channel_labels.length, r.n_channels);
});

test('snirf.readWindow: returns one Float32Array per channel with the requested length', async () => {
  const r = await SnirfReader.open({ eeg_url: FIXTURE });
  const win = await r.readWindow(0, Math.min(10, r.n_samples));
  assert.equal(Array.isArray(win), true);
  assert.equal(win.length, r.n_channels);
  assert.equal(win[0].length, Math.min(10, r.n_samples));
});

test('snirf.readWindow: clamps to EOF gracefully', async () => {
  const r = await SnirfReader.open({ eeg_url: FIXTURE });
  // Ask for more samples than exist — should return what's available, not throw.
  const win = await r.readWindow(0, r.n_samples + 10);
  assert.equal(win[0].length, r.n_samples);
});

test('snirf.open: throws clearly when the file is not SNIRF (HDF5)', async () => {
  // Tiny non-HDF5 fixture: 24 bytes that don't match the HDF5 magic.
  const tmp = path.join('tests/fixtures/nirs', 'not-snirf.bin');
  fs.writeFileSync(tmp, Buffer.from('DEFINITELY_NOT_SNIRF\0\0\0'));
  await assert.rejects(
    SnirfReader.open({ eeg_url: 'file://' + path.resolve(tmp) }),
    /SNIRF|HDF5|not.*valid/i,
  );
  fs.unlinkSync(tmp);
});

test('snirf.open: surfaces /nirs/stim* groups as annotation_events when present', async () => {
  const r = await SnirfReader.open({ eeg_url: FIXTURE });
  // Simple_Probe.snirf ships a /nirs/stim1 with 2 rows of [onset,duration,value].
  assert.equal(Array.isArray(r.annotation_events), true);
  assert.ok(r.annotation_events.length >= 1, 'expected at least one stim event');
  assert.ok(typeof r.annotation_events[0].onset === 'number');
});
