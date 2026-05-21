// Unit test for the EEGLAB v7.3 cross-basename .fdt fallback.
// Reproduces the test_raw_h5.set edge case from
// tests/evidence/v73-real-data/README.md: the .set is MAT v7.3 with
// /EEG/data as a CHAR string pointing at a sibling .fdt whose basename
// differs from the .set basename. Production must catch the Mat73
// CHAR-pointer error and follow the named sidecar.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Stubs to load the reader in Node. jsfive resolves via require()
// because formats/_mat73.js's getJsfive() helper checks globalThis
// first; setting it here ensures the same code path runs as in-browser.
globalThis.hdf5 = require('jsfive');

// HttpRange stub: serves file:// URLs from disk. Mirrors the stub
// patterns used in tests/unit-fiff*.test.mjs + tests/unit-eeglab-*.test.mjs.
const fileFromUrl = (url) => url.replace(/^file:\/\//, '');
globalThis.HttpRange = {
  async fetchBuffer(url) {
    const buf = fs.readFileSync(fileFromUrl(url));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },
  async probeLength(url) {
    const p = fileFromUrl(url);
    if (!fs.existsSync(p)) {
      // Mirror what real HttpRange.probeLength throws on missing files —
      // the eeglab reader looks for /HTTP 404/ to fall through to inline.
      throw new Error(`HTTP 404 on ${url}`);
    }
    return fs.statSync(p).size;
  },
  async rangeFetch(url, start, end /*, expectedBytes, opts */) {
    const fd = fs.openSync(fileFromUrl(url), 'r');
    const len = end - start + 1;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },
  async fetchTextOrNull(url) {
    try { return fs.readFileSync(fileFromUrl(url), 'utf8'); } catch (_) { return null; }
  },
  async *rangeFetchStreaming(url, start, end /*, opts */) {
    yield { bytes: new Uint8Array(await globalThis.HttpRange.rangeFetch(url, start, end)) };
  },
};

// Required globals + reader modules. Order mirrors index.html /
// worker.js script tags so cross-references resolve.
require('../formats/_buffers.js');
require('../formats/_labels.js');
require('../formats/_http_range.js'); // sets globalThis.HttpRange — we want the test stub to win
// Re-apply our test stub since _http_range.js overwrites globalThis.HttpRange.
globalThis.HttpRange = {
  async fetchBuffer(url) {
    const buf = fs.readFileSync(fileFromUrl(url));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },
  async probeLength(url) {
    const p = fileFromUrl(url);
    if (!fs.existsSync(p)) {
      // Mirror what real HttpRange.probeLength throws on missing files —
      // the eeglab reader looks for /HTTP 404/ to fall through to inline.
      throw new Error(`HTTP 404 on ${url}`);
    }
    return fs.statSync(p).size;
  },
  async rangeFetch(url, start, end) {
    const fd = fs.openSync(fileFromUrl(url), 'r');
    const len = end - start + 1;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },
  async fetchTextOrNull(url) {
    try { return fs.readFileSync(fileFromUrl(url), 'utf8'); } catch (_) { return null; }
  },
  async *rangeFetchStreaming(url, start, end) {
    yield { bytes: new Uint8Array(await globalThis.HttpRange.rangeFetch(url, start, end)) };
  },
};
require('../formats/_sidecar.js');
require('../formats/_matv5.js');
require('../formats/_mat73.js');
require('../bids-recording.js');
const EEGLABReader = require('../formats/eeglab.js');

// Real cross-basename pair (copied from test-data/v73-test/ at Task 7).
// cross_named.set is MAT v7.3 with /EEG/data as a CHAR pointing at
// "test_raw.fdt" — a sibling whose basename does NOT match the .set's
// "cross_named" basename.
const FIXTURE_DIR = path.resolve('tests/fixtures/eeg/v73-cross-basename');
const FIXTURE_SET = path.join(FIXTURE_DIR, 'cross_named.set');
const FIXTURE_FDT = path.join(FIXTURE_DIR, 'test_raw.fdt');

test('eeglab v7.3: catches CHAR-pointer error and follows named .fdt sidecar', async () => {
  assert.ok(fs.existsSync(FIXTURE_SET), `missing fixture: ${FIXTURE_SET}`);
  assert.ok(fs.existsSync(FIXTURE_FDT), `missing fixture: ${FIXTURE_FDT}`);

  // The .fdt is 3,904,512 bytes; under int32×nCh that divides cleanly
  // for several channel counts. We pick 32 channels (30,504 samples) to
  // exercise the path — the test_raw_h5.set + test_raw.fdt pair from
  // mne-testing-data doesn't ship a sidecar that pins the exact value,
  // so the test stub supplies one. The reader trusts the sidecar and
  // returns its own division of .fdt bytes — what matters here is that
  // the CHAR-pointer fallback path is taken and produces a usable
  // reader, not whether 32 is the "right" channel count.
  const N_CHANNELS = 32;
  const meta = {
    eeg_url: 'file://' + FIXTURE_SET,
    eeg_json: { sampling_frequency: 500 },
    channels: Array.from({ length: N_CHANNELS }, (_, i) => ({ name: `Ch${i + 1}` })),
    prefix: 'cross_named',
    ext: 'set',
  };
  const r = await EEGLABReader.open(meta);
  assert.equal(r.n_channels, N_CHANNELS);
  assert.equal(r.sampling_frequency, 500);
  assert.ok(r.n_samples > 0);
  // url should be the resolved test_raw.fdt sibling, NOT cross_named.fdt
  assert.match(r.url, /test_raw\.fdt$/);
  const win = await r.readWindow(0, Math.min(8, r.n_samples));
  assert.equal(win.length, N_CHANNELS);
  assert.equal(win[0].length, Math.min(8, r.n_samples));
});
