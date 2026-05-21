// tests/unit-edf-readwindow.test.mjs
//
// Fixture-driven coverage for EDFReader.open() + readWindow() +
// readWindowStreaming() against both EDF and BDF committed
// fixtures. Exercises the full binary-read path (EDF Int16 +
// BDF Int24 sign-extension + record-major deinterleave) that
// synthetic header-only tests don't reach.
//
// The committed fixtures (tests/fixtures/eeg/*.edf and *.bdf) are
// 32 KiB truncations of real recordings — their declared record
// size (n_signals × samples_per_record × bps) is larger than the
// remaining data bytes, so EDFReader.open()'s guard
// `dataBytes % recordSize !== 0` would throw on the raw file.
//
// Mitigation: the mock probeLength() reports an extended length
// of headerBytes + recordSize (exactly one full record), and the
// mock rangeFetch() synthesises the missing tail bytes by
// repeating the real partial-data bytes from the fixture. This
// preserves real non-zero binary content (so the scale + offset
// decode actually produces finite non-zero floats) while
// satisfying the record-size alignment invariant.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { EDFReader } from './_bootstrap.mjs';

const EDF_PATH = path.resolve('tests/fixtures/eeg/sub-01_ses-01_task-offline_run-01_eeg.edf');
const BDF_PATH = path.resolve('tests/fixtures/eeg/sub-001_ses-01_task-meditation_eeg.bdf');

const skipEdf = !fs.existsSync(EDF_PATH);
const skipBdf = !fs.existsSync(BDF_PATH);

// Build a padded synthetic file: real fixture + repeated tail bytes
// to reach exactly headerBytes + recordSize total. Computed once per
// fixture so we don't re-pad on every range fetch.
function buildSynth(filePath) {
  const real = fs.readFileSync(filePath);
  // Parse the fixed-256-byte field "header_bytes" (offset 184, len 8).
  let hbStr = '';
  for (let i = 184; i < 192; i++) {
    const c = real[i];
    if (c === 0) break;
    hbStr += String.fromCharCode(c);
  }
  const headerBytes = parseInt(hbStr.trim(), 10);
  // Parse the full header to learn record size.
  const hdrAb = real.buffer.slice(real.byteOffset, real.byteOffset + headerBytes);
  const hdr = EDFReader.parseHeader(hdrAb);
  const bps = hdr.isBDF ? 3 : 2;
  const samplesPerRecord = hdr.signals.reduce((s, sig) => s + sig.samples_per_record, 0);
  const recordSize = samplesPerRecord * bps;
  const fullSize = headerBytes + recordSize;

  const synth = new Uint8Array(fullSize);
  synth.set(real, 0);
  // Pad missing tail by repeating the real partial-data section.
  const dataStart = headerBytes;
  const existingDataLen = real.length - dataStart;
  const missingLen = fullSize - real.length;
  for (let i = 0; i < missingLen; i++) {
    synth[real.length + i] = real[dataStart + (i % existingDataLen)];
  }
  return { synth, fullSize, headerBytes, recordSize, hdr };
}

const _origHttpRange = globalThis.HttpRange;

function installMock(filePath, synthBytes, fullSize) {
  const basename = path.basename(filePath);
  globalThis.HttpRange = {
    async probeLength(url) {
      if (!url.includes(basename)) throw new Error(`probeLength: unknown url ${url}`);
      return fullSize;
    },
    async rangeFetch(url, byteStart, byteEndInclusive, expectedBytes /*, opts */) {
      if (byteEndInclusive < byteStart) return new ArrayBuffer(0);
      const slice = synthBytes.subarray(byteStart, byteEndInclusive + 1);
      // .buffer.slice() — return a freshly-owned ArrayBuffer so callers
      // can wrap it in Int16Array without aliasing the synth buffer.
      return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    },
    async *rangeFetchStreaming(url, byteStart, byteEndInclusive /*, opts */) {
      const total = byteEndInclusive - byteStart + 1;
      if (total <= 0) return;
      // Emit in two chunks to actually exercise the streaming
      // decodeChunkBoundary path rather than degenerating to a
      // single-chunk no-op. Chunk size rounded down to a record
      // boundary so the first yield gets one complete record.
      const slice = synthBytes.subarray(byteStart, byteEndInclusive + 1);
      const half = Math.max(1, Math.floor(slice.length / 2));
      const first = slice.subarray(0, half);
      yield { offset: 0, bytes: new Uint8Array(first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength)) };
      if (half < slice.length) {
        const rest = slice.subarray(half);
        yield { offset: half, bytes: new Uint8Array(rest.buffer.slice(rest.byteOffset, rest.byteOffset + rest.byteLength)) };
      }
    },
    async fetchText(url) {
      return fs.readFileSync(url.replace(/^file:\/\//, ''), 'utf-8');
    },
    async fetchTextOrNull(url) {
      try { return fs.readFileSync(url.replace(/^file:\/\//, ''), 'utf-8'); }
      catch { return null; }
    },
  };
}
function restoreMock() { globalThis.HttpRange = _origHttpRange; }

function buildMeta(filePath) {
  return {
    eeg_url: 'file://' + filePath,
    eeg_json: {},
    channels: null,
  };
}

// --- EDF (Int16) tests ----------------------------------------------------

test('edf.open(.edf): returns reader with positive channels + rate + samples', { skip: skipEdf }, async () => {
  const { synth, fullSize } = buildSynth(EDF_PATH);
  installMock(EDF_PATH, synth, fullSize);
  try {
    const reader = await EDFReader.open(buildMeta(EDF_PATH));
    assert.ok(reader.n_channels > 0, 'must have >=1 channel');
    assert.ok(reader.sampling_frequency > 0, 'must have sampling rate > 0');
    assert.ok(reader.n_samples > 0, 'must have sample count > 0');
    assert.equal(typeof reader.readWindow, 'function');
    assert.equal(reader.bytes_per_sample, 2, 'EDF is 16-bit');
    assert.ok(Array.isArray(reader.channel_labels));
    assert.equal(reader.channel_labels.length, reader.n_channels);
  } finally { restoreMock(); }
});

test('edf.readWindow(.edf, 0, 500): Float32Arrays with non-zero finite data', { skip: skipEdf }, async () => {
  const { synth, fullSize } = buildSynth(EDF_PATH);
  installMock(EDF_PATH, synth, fullSize);
  try {
    const reader = await EDFReader.open(buildMeta(EDF_PATH));
    const n = Math.min(500, reader.n_samples);
    const win = await reader.readWindow(0, n);
    assert.equal(win.length, reader.n_channels);
    for (let c = 0; c < win.length; c++) {
      assert.ok(win[c] instanceof Float32Array, `ch ${c} must be Float32Array`);
      assert.equal(win[c].length, n);
    }
    // Proves the binary read + Int16 deinterleave + scale path actually ran.
    let sawNonZero = false;
    for (let c = 0; c < win.length && !sawNonZero; c++) {
      for (let s = 0; s < win[c].length; s++) {
        if (win[c][s] !== 0 && Number.isFinite(win[c][s])) { sawNonZero = true; break; }
      }
    }
    assert.ok(sawNonZero, 'at least one channel/sample must be non-zero finite');
  } finally { restoreMock(); }
});

test('edf.readWindow(.edf): tail clamp to n_samples', { skip: skipEdf }, async () => {
  const { synth, fullSize } = buildSynth(EDF_PATH);
  installMock(EDF_PATH, synth, fullSize);
  try {
    const reader = await EDFReader.open(buildMeta(EDF_PATH));
    // Ask for 1000 samples starting at n_samples - 10 → clamp to 10.
    const win = await reader.readWindow(Math.max(0, reader.n_samples - 10), 1000);
    assert.equal(win.length, reader.n_channels);
    assert.ok(win[0].length > 0, 'must return at least 1 sample');
    assert.ok(win[0].length <= 10, `tail clamp expected <=10, got ${win[0].length}`);
  } finally { restoreMock(); }
});

test('edf+ annotation_events shape contract (array of {onset, label})', { skip: skipEdf }, async () => {
  const { synth, fullSize } = buildSynth(EDF_PATH);
  installMock(EDF_PATH, synth, fullSize);
  try {
    const reader = await EDFReader.open(buildMeta(EDF_PATH));
    // The reader returns an array (possibly empty) — never null.
    // For files with no "EDF Annotations" channel the array is empty;
    // when present each entry has onset:number + label:string fields.
    assert.ok(Array.isArray(reader.annotation_events),
      'annotation_events must be an array, even if empty');
    for (const ev of reader.annotation_events) {
      assert.equal(typeof ev.onset, 'number');
      assert.equal(typeof ev.label, 'string');
    }
  } finally { restoreMock(); }
});

test('edf.readWindowStreaming: emits chunks summing to requested n', { skip: skipEdf }, async () => {
  const { synth, fullSize } = buildSynth(EDF_PATH);
  installMock(EDF_PATH, synth, fullSize);
  try {
    const reader = await EDFReader.open(buildMeta(EDF_PATH));
    assert.equal(typeof reader.readWindowStreaming, 'function');
    const n = Math.min(reader.n_samples, 500);
    let totalSamples = 0;
    let chunkCount = 0;
    for await (const chunk of reader.readWindowStreaming(0, n)) {
      chunkCount++;
      assert.ok(Array.isArray(chunk.channels) || chunk.channels.length === reader.n_channels);
      assert.equal(chunk.channels.length, reader.n_channels);
      assert.ok(chunk.channels[0] instanceof Float32Array);
      assert.equal(typeof chunk.firstSampleIdx, 'number');
      assert.equal(typeof chunk.lastSampleIdx, 'number');
      totalSamples += chunk.channels[0].length;
    }
    assert.ok(chunkCount >= 1, 'must emit at least one chunk');
    assert.equal(totalSamples, n, 'sum of chunk lengths must equal requested n');
  } finally { restoreMock(); }
});

// --- BDF (Int24) tests ----------------------------------------------------

test('edf.open(.bdf): BDF binary path returns reader with 24-bit samples', { skip: skipBdf }, async () => {
  const { synth, fullSize } = buildSynth(BDF_PATH);
  installMock(BDF_PATH, synth, fullSize);
  try {
    const reader = await EDFReader.open(buildMeta(BDF_PATH));
    assert.ok(reader.n_channels > 0, 'must have >=1 channel');
    assert.ok(reader.sampling_frequency > 0, 'must have sampling rate > 0');
    assert.ok(reader.n_samples > 0, 'must have sample count > 0');
    assert.equal(reader.bytes_per_sample, 3, 'BDF is 24-bit');
  } finally { restoreMock(); }
});

test('edf.readWindow(.bdf, 0, 200): Float32Arrays with non-zero finite data (24-bit decode)', { skip: skipBdf }, async () => {
  const { synth, fullSize } = buildSynth(BDF_PATH);
  installMock(BDF_PATH, synth, fullSize);
  try {
    const reader = await EDFReader.open(buildMeta(BDF_PATH));
    const n = Math.min(200, reader.n_samples);
    const win = await reader.readWindow(0, n);
    assert.equal(win.length, reader.n_channels);
    for (let c = 0; c < win.length; c++) {
      assert.ok(win[c] instanceof Float32Array, `BDF ch ${c} must be Float32Array`);
      assert.equal(win[c].length, n);
    }
    // The 24-bit sign-extend + scale path must produce finite non-zero floats.
    let sawNonZero = false;
    for (let c = 0; c < win.length && !sawNonZero; c++) {
      for (let s = 0; s < win[c].length; s++) {
        if (win[c][s] !== 0 && Number.isFinite(win[c][s])) { sawNonZero = true; break; }
      }
    }
    assert.ok(sawNonZero, 'BDF must produce at least one non-zero finite sample');
  } finally { restoreMock(); }
});
