// tests/unit-brainvision-readwindow.test.mjs
//
// Fixture-driven coverage for BrainVisionReader.open() + readWindow()
// + readWindowStreaming() against the committed iEEG fixture
// (tests/fixtures/ieeg/sub-01_ses-iemu_task-film_acq-clinical_run-1_ieeg.vhdr).
//
// Exercises the .vhdr parser, .eeg binary read, multiplexed deinterleave
// hot path, and the streaming generator path in one round-trip per test.
//
// The committed .eeg is a 32 KiB truncation of a real iEEG recording
// (111 channels × IEEE_FLOAT_32 → 444 bytes/frame). Since 32768 is not
// a multiple of 444, the mock probeLength() returns the largest
// multiple-of-frame-size that fits (32412 B → 73 samples). Without
// this clamp, BrainVisionReader.open() would throw the
// "size not a multiple of n_channels·bps" guard.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { BrainVisionReader } from './_bootstrap.mjs';

const FIXTURE_DIR = path.resolve('tests/fixtures/ieeg');
const VHDR = path.join(FIXTURE_DIR, 'sub-01_ses-iemu_task-film_acq-clinical_run-1_ieeg.vhdr');
const EEG  = path.join(FIXTURE_DIR, 'sub-01_ses-iemu_task-film_acq-clinical_run-1_ieeg.eeg');
const skipIfMissing = !fs.existsSync(VHDR) || !fs.existsSync(EEG);

// Parse the .vhdr header once up-front so the mock can clamp probeLength
// to a multiple of n_channels · bps even when the committed .eeg is a
// raw byte-truncation. The reader requires totalBytes % recordBytes ==0.
let RECORD_BYTES = 0;
let CLAMPED_TOTAL = 0;
if (!skipIfMissing) {
  const text = fs.readFileSync(VHDR, 'utf-8');
  const hdr = BrainVisionReader.parseHeader(text);
  RECORD_BYTES = hdr.n_channels * hdr.bytes_per_sample;
  const realSize = fs.statSync(EEG).size;
  CLAMPED_TOTAL = Math.floor(realSize / RECORD_BYTES) * RECORD_BYTES;
}

// Swap HttpRange for a local-file shim. The reader only uses these four
// methods (plus rangeFetchStreaming which we proxy through rangeFetch
// since streaming on local files has no benefit — readWindowStreaming
// will still emit at least one chunk via the small-range fallback).
const _origHttpRange = globalThis.HttpRange;
function installMock() {
  globalThis.HttpRange = {
    async probeLength(url) {
      const p = url.replace(/^file:\/\//, '');
      if (p.endsWith('.eeg')) return CLAMPED_TOTAL;
      return fs.statSync(p).size;
    },
    async fetchText(url) {
      return fs.readFileSync(url.replace(/^file:\/\//, ''), 'utf-8');
    },
    async fetchTextOrNull(url) {
      try { return fs.readFileSync(url.replace(/^file:\/\//, ''), 'utf-8'); }
      catch { return null; }
    },
    async rangeFetch(url, byteStart, byteEndInclusive, expectedBytes /*, opts */) {
      if (byteEndInclusive < byteStart || expectedBytes === 0) return new ArrayBuffer(0);
      const p = url.replace(/^file:\/\//, '');
      const buf = fs.readFileSync(p);
      const slice = buf.subarray(byteStart, byteEndInclusive + 1);
      return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    },
    async *rangeFetchStreaming(url, byteStart, byteEndInclusive /*, opts */) {
      const total = byteEndInclusive - byteStart + 1;
      if (total <= 0) return;
      const buf = await this.rangeFetch(url, byteStart, byteEndInclusive, total);
      yield { offset: 0, bytes: new Uint8Array(buf) };
    },
  };
}
function restoreMock() { globalThis.HttpRange = _origHttpRange; }

// Minimal meta shape the reader expects. eeg_json must exist (the
// reader unconditionally reads .sampling_frequency off it); channels
// can be null because crossCheckChannelOrder bails on falsy bidsChannels.
function buildMeta() {
  return {
    eeg_url: 'file://' + VHDR,
    eeg_json: {},
    channels: null,
  };
}

test('brainvision.open: returns reader with non-zero channels + sampling rate', { skip: skipIfMissing }, async () => {
  installMock();
  try {
    const reader = await BrainVisionReader.open(buildMeta());
    assert.ok(reader.n_channels > 0, 'must have >=1 channel');
    assert.ok(reader.sampling_frequency > 0, 'must have sampling rate > 0');
    assert.ok(reader.n_samples > 0, 'must have sample count > 0');
    assert.equal(typeof reader.readWindow, 'function');
    assert.equal(reader.binary_format, 'IEEE_FLOAT_32');
    assert.equal(reader.bytes_per_sample, 4);
  } finally { restoreMock(); }
});

test('brainvision.readWindow: returns nCh Float32Arrays of requested length', { skip: skipIfMissing }, async () => {
  installMock();
  try {
    const reader = await BrainVisionReader.open(buildMeta());
    const N = Math.min(50, reader.n_samples);
    const win = await reader.readWindow(0, N);
    assert.equal(win.length, reader.n_channels);
    for (let c = 0; c < win.length; c++) {
      assert.ok(win[c] instanceof Float32Array, `ch ${c} must be Float32Array`);
      assert.equal(win[c].length, N);
    }
    // At least one channel must have at least one non-zero finite sample —
    // proves the binary read + deinterleave + scale path actually ran.
    let sawNonZero = false;
    for (let c = 0; c < win.length && !sawNonZero; c++) {
      for (let s = 0; s < win[c].length; s++) {
        if (win[c][s] !== 0 && Number.isFinite(win[c][s])) { sawNonZero = true; break; }
      }
    }
    assert.ok(sawNonZero, 'at least one channel/sample must be non-zero finite');
  } finally { restoreMock(); }
});

test('brainvision.readWindow: tail clamp to n_samples', { skip: skipIfMissing }, async () => {
  installMock();
  try {
    const reader = await BrainVisionReader.open(buildMeta());
    // Ask for 1000 samples starting at n_samples - 10 → clamp to 10.
    const win = await reader.readWindow(reader.n_samples - 10, 1000);
    assert.equal(win.length, reader.n_channels);
    assert.ok(win[0].length > 0, 'must return at least 1 sample');
    assert.ok(win[0].length <= 10, `tail clamp expected <=10, got ${win[0].length}`);
  } finally { restoreMock(); }
});

test('brainvision.readWindowStreaming: chunks sum to requested n', { skip: skipIfMissing }, async () => {
  installMock();
  try {
    const reader = await BrainVisionReader.open(buildMeta());
    assert.equal(typeof reader.readWindowStreaming, 'function');
    const N = Math.min(50, reader.n_samples);
    let totalSamples = 0;
    let chunkCount = 0;
    for await (const chunk of reader.readWindowStreaming(0, N)) {
      chunkCount++;
      assert.equal(chunk.channels.length, reader.n_channels);
      assert.ok(chunk.channels[0] instanceof Float32Array);
      totalSamples += chunk.channels[0].length;
    }
    assert.ok(chunkCount >= 1, 'must emit at least one chunk');
    assert.equal(totalSamples, N, 'sum of chunk lengths must equal requested n');
  } finally { restoreMock(); }
});

test('brainvision: channel_labels match the .vhdr declared count', { skip: skipIfMissing }, async () => {
  installMock();
  try {
    const reader = await BrainVisionReader.open(buildMeta());
    assert.ok(Array.isArray(reader.channel_labels), 'labels must be an array');
    assert.equal(reader.channel_labels.length, reader.n_channels);
    for (const label of reader.channel_labels) {
      assert.equal(typeof label, 'string');
      assert.ok(label.length > 0, 'label must be non-empty');
    }
  } finally { restoreMock(); }
});
