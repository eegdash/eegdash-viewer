// unit-api-surface.test.mjs
//
// API-surface contract tests for the public-ish modules of the viewer.
// We're a private webapp, not a published library — but we still rely
// on stable cross-module signatures (worker ↔ viewer ↔ format readers
// ↔ filters). This file snapshots the exported keys of each module
// and fails when a key disappears or a new public key is added without
// intent. Catches accidental refactoring that would break tests in CI.
//
// To add a new public export: update the relevant fixture set + add a
// commit message explaining why. To remove one: same dance. Both
// require an explicit step — that's the point.
//
// Adapted from the are-the-types-wrong / publint pattern for libraries,
// scaled down to "is the JS shape stable" for an internal app where
// we have no .d.ts to check.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
globalThis.ResizeObserver = globalThis.ResizeObserver || class {
  observe() {} unobserve() {} disconnect() {}
};
globalThis.window.devicePixelRatio = 1;

// ─── Expected surfaces ───────────────────────────────────────────
//
// Each entry: module path → sorted array of expected public keys.
// Internal _-prefixed exports (debug helpers for tests) are NOT
// snapshotted — they're explicitly meant to change as test needs
// evolve. Adding/removing a _-prefixed key doesn't require a doc
// change; adding/removing a public one does.

const EXPECTED = {
  '../formats/edf.js': [
    'open',
    'parseHeader',
    'parseTAL',
  ],
  '../formats/brainvision.js': [
    'open',
    'parseHeader',
    'parseIni',
  ],
  '../formats/eeglab.js': [
    'fdtUrlFor',
    'open',
  ],
  // MAT v7.3 (HDF5) reader for modern EEGLAB .set files. Mirrors
  // MatV5's surface — extractEegInline is reused; we only add parse()
  // + isHdf5() probe. Wired by formats/eeglab.js after v5 vs v7.3
  // detection.
  '../formats/_mat73.js': [
    'isHdf5',
    'parse',
  ],
  '../formats/fiff.js': [
    'open',
    'read',
  ],
  '../formats/ctf.js': [
    'open',
    'read',
  ],
  '../filters.js': [
    'applyChain',
    'designHighpass',
    'designLowpass',
    'designNotch',
    'filtfilt',
  ],
  '../traces.js': [
    'MIN_SLOT_PX',
    'PAD_BOTTOM',
    'PAD_LEFT',
    'PAD_RIGHT',
    'PAD_TOP',
    'decimateMinMax',
    'draw',
    'lastChannelOffset',
    'lastDrawnXLabels',
    'lastMaxVisibleChannels',
    'lastSlotMicrovolts',
    'lastTotalChannels',
    'meanStd',
  ],
  // topo2d.js was archived 2026-05-21 to archive/topo2d/topo2d.js
  // (janitor F2 closure — file was tested but never instantiated by
  // production index.html). If a future PR wires topo2d into the
  // viewer UI, restore per archive/topo2d/README.md and re-add the
  // entry here. The original export pattern (window.EEGTopo2D = api,
  // no module.exports fallback) was the same as fiff.js pre-c57dc88.
  '../bids-loader.js': [
    'parseCoordsystem',
    'parseElectrodesTSV',
  ],
  '../bids-recording.js': [
    'buildOpenNeuroEegUrl',
    'discoverSubject',
    'discoverSuffix',
    'isNemarDatasetId',
    'loadNemarRecording',
    'loadRecordingMetadata',
    'parseChannelsTsv',
    'parseEegJson',
    'parseEegUrl',
    'parseEventsTsv',
    'parsePhysioUrl',
    'resolveTargets',
  ],
};

function publicKeys(mod) {
  return Object.keys(mod).filter(k => !k.startsWith('_')).sort();
}

for (const [modPath, expected] of Object.entries(EXPECTED)) {
  test(`api-surface: ${modPath} public keys are stable`, () => {
    // Some modules require bootstrap globals; load them defensively.
    if (modPath.includes('brainvision') || modPath.includes('eeglab') || modPath.includes('edf')) {
      require('../formats/_buffers.js');
    }
    if (modPath.includes('bids-recording')) {
      // bids-recording.js consumes HttpRange off globalThis at module
      // init (line 41); load the side-effect modules used in real tests.
      require('../bids-loader.js');
      require('../formats/_buffers.js');
      require('../formats/_http_range.js');
    }
    const mod = require(modPath);
    const actual = publicKeys(mod);
    assert.deepEqual(actual, expected,
      `${modPath} public keys drifted.\n` +
      `  expected: ${JSON.stringify(expected)}\n` +
      `  actual:   ${JSON.stringify(actual)}\n` +
      `  added:    ${JSON.stringify(actual.filter(k => !expected.includes(k)))}\n` +
      `  removed:  ${JSON.stringify(expected.filter(k => !actual.includes(k)))}`,
    );
  });
}

// ─── Cross-module contract: every format reader's open() returns the same shape ───

test('api-surface: format readers share the open() return shape', async () => {
  // viewer.js + worker.js both call READERS[ext].open(meta) and expect:
  //   n_channels, sampling_frequency, duration_s, channel_labels,
  //   bytes_per_sample, n_samples, recording_start_iso, readWindow
  //
  // Format-specific extras (annotation_events, readWindowStreaming, etc.)
  // are also allowed; this test pins the minimum surface.
  //
  // For each reader, mock the network layer (HttpRange.fetchBuffer) so
  // open() resolves without a real fetch. We only check that the
  // returned object has the keys; values can be anything.

  require('../formats/_buffers.js');
  const fs = await import('node:fs');

  // Mock HttpRange so open() doesn't actually network-fetch.
  globalThis.HttpRange = {
    async fetchBuffer(url) {
      const path = url.replace(/^file:\/\//, '');
      const buf = fs.readFileSync(path);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    async fetchText(url) {
      const path = url.replace(/^file:\/\//, '');
      return fs.readFileSync(path, 'utf-8');
    },
    async fetchTextOrNull(url) {
      try { return await this.fetchText(url); }
      catch { return null; }
    },
    async fetchRange(url, start, end) {
      const path = url.replace(/^file:\/\//, '');
      const buf = fs.readFileSync(path);
      const slice = buf.slice(start, end + 1);
      return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    },
    async rangeFetch(url, start, endIncl) {
      const path = url.replace(/^file:\/\//, '');
      const buf = fs.readFileSync(path);
      const slice = buf.slice(start, endIncl + 1);
      return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    },
    async probeLength(url) {
      const path = url.replace(/^file:\/\//, '');
      return fs.statSync(path).size;
    },
  };

  // FIFF — known shape, smallest fixture
  const FIFFReader = require('../formats/fiff.js');
  const fiffReader = await FIFFReader.open({
    eeg_url: 'file://' + process.cwd() + '/tests/fixtures/meg/test-eve.fif',
  });

  const REQUIRED_KEYS = [
    'n_channels', 'sampling_frequency', 'duration_s',
    'channel_labels', 'bytes_per_sample', 'n_samples',
    'recording_start_iso',
  ];
  for (const k of REQUIRED_KEYS) {
    assert.ok(k in fiffReader, `fiff reader missing required key: ${k}`);
  }
  assert.equal(typeof fiffReader.readWindow, 'function',
    'fiff reader must expose readWindow function');

  // CTF — synth .ds/ fixture
  require('../formats/_ctf-res4.js');
  require('../formats/_ctf-marker.js');
  const CTFReader = require('../formats/ctf.js');
  const ctfReader = await CTFReader.open({
    eeg_url: 'file://' + process.cwd() + '/tests/fixtures/meg/ctf-tiny.ds/ctf-tiny_meg.meg4',
  });
  for (const k of REQUIRED_KEYS) {
    assert.ok(k in ctfReader, `ctf reader missing required key: ${k}`);
  }
  assert.equal(typeof ctfReader.readWindow, 'function',
    'ctf reader must expose readWindow function');
});
