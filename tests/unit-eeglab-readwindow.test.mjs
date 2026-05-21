// tests/unit-eeglab-readwindow.test.mjs
//
// Fixture-driven coverage for EEGLABReader.open() + readWindow() +
// readWindowStreaming() exercising the split .set+.fdt path.
//
// Why a synthetic .fdt rather than the committed `.set` fixture:
// the committed `sub-001_task-AuditoryVisualShift_run-01_eeg.set` is
// a MAT v7.3 (HDF5) file. _matv5.js only understands MAT v5/v6, so
// the inline-data parse path throws before any meaningful work
// happens. The split layout — `.set` (we skip parsing) + sibling
// `.fdt` (flat float32 interleaved frames) — is the actually-reachable
// path with our committed test inputs.
//
// We build a small in-memory float32 .fdt (nCh × nS) with deterministic
// non-zero content so readWindow() returns finite numbers and the
// streaming generator yields ≥ 2 chunks. The mock HttpRange.probeLength
// reports the synthetic length; rangeFetch slices the synthetic buffer;
// rangeFetchStreaming bisects to force the streaming decode boundary
// path (same trick T5 uses for EDF/BDF).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EEGLABReader } from './_bootstrap.mjs';

const N_CHANNELS = 8;
const SAMPLING_FREQUENCY = 250;
const N_SAMPLES = 1000;
const BPS = 4;

// Build a deterministic interleaved float32 buffer:
//   data[s * nCh + c] = sin(2π·(c+1)·s / nS) + 0.1·c
// This guarantees every channel has non-zero finite content and the
// values are distinguishable per channel (useful for any future
// channel-ordering regression).
function buildSynthFdt() {
  const flat = new Float32Array(N_CHANNELS * N_SAMPLES);
  for (let s = 0; s < N_SAMPLES; s++) {
    for (let c = 0; c < N_CHANNELS; c++) {
      flat[s * N_CHANNELS + c] = Math.sin((2 * Math.PI * (c + 1) * s) / N_SAMPLES) + 0.1 * c;
    }
  }
  return new Uint8Array(flat.buffer);
}

const SYNTH_FDT = buildSynthFdt();
const SYNTH_BYTES = SYNTH_FDT.length;

const FDT_URL = 'https://example.com/sub-01_task-test_eeg.fdt';
const SET_URL = 'https://example.com/sub-01_task-test_eeg.set';

const _origHttpRange = globalThis.HttpRange;

function installMock() {
  globalThis.HttpRange = {
    async probeLength(url) {
      if (url === FDT_URL) return SYNTH_BYTES;
      throw new Error(`probeLength: unexpected url ${url}`);
    },
    async rangeFetch(url, byteStart, byteEndInclusive, _expectedBytes /*, opts */) {
      if (url !== FDT_URL) throw new Error(`rangeFetch: unexpected url ${url}`);
      const slice = SYNTH_FDT.subarray(byteStart, byteEndInclusive + 1);
      return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    },
    async *rangeFetchStreaming(url, byteStart, byteEndInclusive /*, opts */) {
      if (url !== FDT_URL) throw new Error(`rangeFetchStreaming: unexpected url ${url}`);
      const total = byteEndInclusive - byteStart + 1;
      if (total <= 0) return;
      // Bisect on a frame boundary so the first yield is one or more
      // complete frames; this forces decodeChunkBoundary to handle a
      // real continuation rather than a single-chunk no-op.
      const frameSize = N_CHANNELS * BPS;
      const halfFrames = Math.max(1, Math.floor(total / frameSize / 2));
      const halfBytes = halfFrames * frameSize;
      const slice = SYNTH_FDT.subarray(byteStart, byteEndInclusive + 1);
      const first = slice.subarray(0, halfBytes);
      yield {
        offset: 0,
        bytes: new Uint8Array(first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength)),
      };
      if (halfBytes < slice.length) {
        const rest = slice.subarray(halfBytes);
        yield {
          offset: halfBytes,
          bytes: new Uint8Array(rest.buffer.slice(rest.byteOffset, rest.byteOffset + rest.byteLength)),
        };
      }
    },
    // Not used by the .fdt path but provided so unrelated reader calls
    // never explode on undefined.
    async fetchText() { return ''; },
    async fetchTextOrNull() { return null; },
  };
}

function restoreMock() {
  globalThis.HttpRange = _origHttpRange;
}

// Minimal meta shape EEGLABReader.open() consumes for the split path.
// sibling_urls is set so resolveFdtUrl() returns FDT_URL directly
// (avoids touching api.fdtUrlFor for the open-path tests; fdtUrlFor
// itself is exercised in its own test).
function buildMeta() {
  const channels = [];
  for (let i = 0; i < N_CHANNELS; i++) {
    channels.push({ index: i, name: `Ch${i + 1}`, type: 'EEG', units: 'uV' });
  }
  return {
    eeg_url: SET_URL,
    ext: 'set',
    dir: 'https://example.com/',
    prefix: 'sub-01_task-test',
    channels,
    eeg_json: {
      sampling_frequency: SAMPLING_FREQUENCY,
      recording_duration: N_SAMPLES / SAMPLING_FREQUENCY,
    },
    sibling_urls: {
      'sub-01_task-test_eeg.fdt': FDT_URL,
    },
  };
}

test('eeglab.open: returns reader with positive channels + rate + samples', async () => {
  installMock();
  try {
    const reader = await EEGLABReader.open(buildMeta());
    assert.equal(reader.n_channels, N_CHANNELS);
    assert.equal(reader.sampling_frequency, SAMPLING_FREQUENCY);
    assert.equal(reader.n_samples, N_SAMPLES);
    assert.equal(reader.bytes_per_sample, 4);
    assert.equal(reader.url, FDT_URL);
  } finally {
    restoreMock();
  }
});

test('eeglab.readWindow(0, 500): nCh × Float32Array[500] with finite non-zero data', async () => {
  installMock();
  try {
    const reader = await EEGLABReader.open(buildMeta());
    const n = 500;
    const win = await reader.readWindow(0, n);
    assert.equal(win.length, reader.n_channels);
    for (let c = 0; c < win.length; c++) {
      assert.equal(win[c].length, n);
      assert.ok(
        win[c].some(v => v !== 0 && isFinite(v)),
        `channel ${c} must have at least one non-zero finite sample`,
      );
    }
    // Spot-check channel 0 sample 0: sin(0) + 0 = 0 → fall back to sample 1
    // which must be sin(2π/N) + 0 ≈ 0.0314 (not exactly 0).
    assert.ok(Math.abs(win[0][1]) > 1e-4);
  } finally {
    restoreMock();
  }
});

test('eeglab: channel_labels match n_channels and come from sidecar', async () => {
  installMock();
  try {
    const reader = await EEGLABReader.open(buildMeta());
    assert.ok(Array.isArray(reader.channel_labels));
    assert.equal(reader.channel_labels.length, reader.n_channels);
    assert.equal(reader.channel_labels[0], 'Ch1');
    assert.equal(reader.channel_labels[N_CHANNELS - 1], `Ch${N_CHANNELS}`);
  } finally {
    restoreMock();
  }
});

test('eeglab.readWindow tail clamp at n_samples (request past EOF)', async () => {
  installMock();
  try {
    const reader = await EEGLABReader.open(buildMeta());
    // Start 50 samples before EOF, ask for 1000 → clamp to 50.
    const win = await reader.readWindow(reader.n_samples - 50, 1000);
    assert.equal(win.length, reader.n_channels);
    assert.equal(win[0].length, 50);
    // Past-EOF start returns empty buffers (one per channel).
    const empty = await reader.readWindow(reader.n_samples + 100, 200);
    assert.equal(empty.length, reader.n_channels);
    assert.equal(empty[0].length, 0);
  } finally {
    restoreMock();
  }
});

test('eeglab.fdtUrlFor: returns sibling .fdt URL when given a .set URL', () => {
  const fdt = EEGLABReader.fdtUrlFor('https://example.com/sub-01_task-test_eeg.set');
  assert.equal(fdt, 'https://example.com/sub-01_task-test_eeg.fdt');
  assert.throws(
    () => EEGLABReader.fdtUrlFor('https://example.com/sub-01_eeg.edf'),
    /expects \*_eeg\.set/,
  );
});

test('eeglab.readWindowStreaming: yields ≥1 chunk summing to requested n', async () => {
  installMock();
  try {
    const reader = await EEGLABReader.open(buildMeta());
    assert.equal(typeof reader.readWindowStreaming, 'function');
    const n = 800;
    let totalSamples = 0;
    let chunkCount = 0;
    let firstIdx = null;
    let lastIdx = -1;
    for await (const chunk of reader.readWindowStreaming(0, n)) {
      chunkCount++;
      assert.equal(chunk.channels.length, reader.n_channels);
      assert.equal(chunk.channels[0].length, chunk.lastSampleIdx - chunk.firstSampleIdx + 1);
      if (firstIdx === null) firstIdx = chunk.firstSampleIdx;
      assert.equal(chunk.firstSampleIdx, lastIdx + 1);
      lastIdx = chunk.lastSampleIdx;
      totalSamples += chunk.channels[0].length;
    }
    assert.ok(chunkCount >= 1, `expected ≥1 chunk, got ${chunkCount}`);
    assert.equal(totalSamples, n);
    assert.equal(firstIdx, 0);
    assert.equal(lastIdx, n - 1);
  } finally {
    restoreMock();
  }
});

test('eeglab._classifyDurationMismatch: ok / epoched / mismatch / no-declared', () => {
  assert.deepEqual(EEGLABReader._classifyDurationMismatch(10, 10), { kind: 'ok' });
  assert.deepEqual(EEGLABReader._classifyDurationMismatch(10, null), { kind: 'no-declared' });
  assert.deepEqual(EEGLABReader._classifyDurationMismatch(30, 10), { kind: 'epoched', trials: 3 });
  assert.deepEqual(EEGLABReader._classifyDurationMismatch(13, 10), { kind: 'mismatch' });
});

test('eeglab._sliceColumnMajor: extracts the requested window from a flat array', () => {
  // 3 channels × 4 samples interleaved: [s0c0,s0c1,s0c2, s1c0,s1c1,s1c2, ...]
  const flat = new Float32Array([
    0, 10, 20,
    1, 11, 21,
    2, 12, 22,
    3, 13, 23,
  ]);
  const win = EEGLABReader._sliceColumnMajor(flat, 3, 1, 2); // start=1, n=2
  assert.equal(win.length, 3);
  assert.equal(win[0].length, 2);
  assert.deepEqual(Array.from(win[0]), [1, 2]);
  assert.deepEqual(Array.from(win[1]), [11, 12]);
  assert.deepEqual(Array.from(win[2]), [21, 22]);
});
