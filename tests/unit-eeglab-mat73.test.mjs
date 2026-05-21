// Round-trip tests for MAT v7.3 (HDF5) EEGLAB .set support.
//
// MAT v7.3 has been MATLAB's default save format since R2014b, so
// most modern EEGLAB exports + most third-party tools that write
// .set files now produce v7.3-flavoured HDF5 blobs wrapped in a
// vestigial 128-byte MAT v5 header stub. Before this work, the
// viewer threw a clean "MAT v7.3 detected" error on those files;
// after, it round-trips real fixtures end-to-end.
//
// Fixtures live in /tmp (mne-testing-data, ~3 MB total) and are
// fetched by the surrounding shell. Tests skip-with-message when
// they're missing so dev machines without the downloads still get
// a clean test run.
//
// Ground truth (sampling rate, channel count, first sample values)
// is taken from mne-python's eeglab reader against the same files;
// see PR description for the exact verification commands.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { EEGLABReader, HttpRange, Mat73, MatV5 } from './_bootstrap.mjs';

const FIXTURE_DIR = '/tmp/eegdash-fixtures/EEGLAB';
const INLINE_FIXTURE  = `${FIXTURE_DIR}/test_raw_hdf5.set`; // inline data
const SIDECAR_FIXTURE = `${FIXTURE_DIR}/test_raw_h5.set`;   // expects .fdt
const SIDECAR_FDT     = `${FIXTURE_DIR}/test_raw.fdt`;
const FDT_NCH = 32;
const FDT_FS  = 128;
const FDT_PNTS = 30504;

// Committed deterministic fixture — see scripts/build_tiny_v73_fixture.py.
// Lives in the repo so the bare unit-test pass exercises the v7.3 path
// even on dev machines that haven't populated /tmp/eegdash-fixtures.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const TINY_V73 = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures', 'eeg', 'tiny_v73_eeg.set',
);

function fixtureExists(p) {
  try { fs.statSync(p); return true; } catch (_) { return false; }
}

// Register the fixture file as a local blob so HttpRange.rangeFetch
// resolves without hitting the network. The viewer's runtime path
// uses the same registry for drag-and-drop. We can't import the
// raw bytes — the reader pulls them via the HttpRange abstraction.
function registerFixture(path, filename) {
  const buf = fs.readFileSync(path);
  const blob = new Blob([buf], { type: 'application/octet-stream' });
  return HttpRange.registerLocal(filename, blob);
}

const skipIfMissing = (p) =>
  !fixtureExists(p) ? { skip: `fixture missing: ${p}` } : {};

// ─── Mat73 unit tests against the committed tiny fixture ────────
//
// The tiny fixture rides in the repo (~6 KB) so the v7.3 path runs
// in every CI invocation; the bigger mne-testing-data fixtures stay
// out-of-tree and skip when absent.

test('Mat73.parse round-trips the committed tiny_v73_eeg.set fixture', async () => {
  const buf = fs.readFileSync(TINY_V73);
  assert.equal(Mat73.isHdf5(buf), true, 'tiny fixture must be v7.3');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const vars = await Mat73.parse(ab);
  const eeg = MatV5.extractEegInline(vars);
  // Matches scripts/build_tiny_v73_fixture.py — seed=42, fs=100,
  // nch=4, nsamp=50, channel data ~N(0, 10).
  assert.equal(eeg.srate,  100);
  assert.equal(eeg.nbchan, 4);
  assert.equal(eeg.pnts,   50);
  assert.equal(eeg.trials, 1);
  assert.equal(eeg.dataClass, 'single');
  assert.equal(eeg.data.length, 4 * 50);
  // First float is deterministic across runs — guards against a
  // dtype-decoding regression that would silently shift bytes.
  assert.ok(Math.abs(eeg.data[0] - 4.967) < 0.01,
    `unexpected first sample ${eeg.data[0]}`);
});

test('EEGLABReader.open: tiny_v73 fixture serves windows end-to-end', async () => {
  const buf = fs.readFileSync(TINY_V73);
  const blob = new Blob([buf], { type: 'application/octet-stream' });
  const url = HttpRange.registerLocal('tiny_v73_eeg.set', blob);
  const rec = await EEGLABReader.open({
    eeg_url: url,
    prefix:  'tiny_v73',
    dir:     'https://localdrop.invalid/',
    ext:     'set',
    sibling_urls: {},
    channels: null,
    eeg_json: { sampling_frequency: null, recording_duration: null, raw: {} },
  });
  assert.equal(rec.n_channels, 4);
  assert.equal(rec.sampling_frequency, 100);
  assert.equal(rec.n_samples, 50);
  // readWindow with explicit bounds — ch 0 sample 0 is the first
  // sample emitted by the np.random seed=42 stream.
  const win = await rec.readWindow(0, 3);
  assert.equal(win.length, 4);
  assert.equal(win[0].length, 3);
  assert.ok(Math.abs(win[0][0] - 4.967) < 0.01);
});

// ─── Mat73 unit tests against synthesised + real buffers ─────────

test(
  'Mat73.isHdf5 detects v7.3 marker + HDF5 magic',
  skipIfMissing(INLINE_FIXTURE),
  () => {
    const buf = fs.readFileSync(INLINE_FIXTURE);
    assert.equal(Mat73.isHdf5(buf), true, 'real v7.3 file should be detected');

    // A vanilla MAT v5 buffer (0x0100 at byte 124) should NOT be
    // mis-detected as v7.3 even when bytes 512+ happen to look like
    // HDF5 magic (they won't in real files, but verify the version
    // check is required).
    const v5 = new Uint8Array(1024);
    new DataView(v5.buffer).setUint16(124, 0x0100, true);
    new DataView(v5.buffer).setUint16(126, 0x4D49, true);
    assert.equal(Mat73.isHdf5(v5), false, 'v5 file must not be detected as v7.3');

    // Too-short buffer — isHdf5 must short-circuit, not throw.
    assert.equal(Mat73.isHdf5(new Uint8Array(100)), false);
  },
);

test(
  'Mat73.parse extracts EEG fields from real test_raw_hdf5.set',
  skipIfMissing(INLINE_FIXTURE),
  async () => {
    const buf = fs.readFileSync(INLINE_FIXTURE);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const vars = await Mat73.parse(ab);
    // The Map should carry both the wrapped (EEG struct) and flat
    // (top-level scalars) views — MatV5.extractEegInline can consume
    // either path without caring which producer wrote them.
    assert.ok(vars.has('EEG'), 'vars must include EEG wrapper');
    assert.ok(vars.has('data'),  'vars must include flat data entry');
    assert.ok(vars.has('srate'), 'vars must include flat srate entry');

    const eeg = MatV5.extractEegInline(vars);
    // Ground truth from mne-python: sfreq=1024, nchan=271, pnts=256.
    assert.equal(eeg.srate,  1024);
    assert.equal(eeg.nbchan, 271);
    assert.equal(eeg.pnts,   256);
    assert.equal(eeg.trials, 1);
    assert.equal(eeg.dataClass, 'single');
    assert.equal(eeg.data.length, 271 * 256);
    // ch0 sample 0 ≈ 12221.68 μV (mne-python reports same value × 1e-6
    // because it returns SI units; .set on disk is μV).
    assert.ok(Math.abs(eeg.data[0] - 12221.68) < 1.0,
      `unexpected ch0 sample 0 = ${eeg.data[0]}`);
  },
);

// ─── EEGLABReader integration: inline path ───────────────────────

test(
  'EEGLABReader.open: test_raw_hdf5.set inline v7.3 round-trips',
  skipIfMissing(INLINE_FIXTURE),
  async () => {
    const url = registerFixture(INLINE_FIXTURE, 'test_raw_hdf5.set');
    const rec = await EEGLABReader.open({
      eeg_url: url,
      prefix:  'test_raw_hdf5',
      dir:     'https://localdrop.invalid/',
      ext:     'set',
      sibling_urls: {},
      channels: null,
      eeg_json: { sampling_frequency: null, recording_duration: null, raw: {} },
    });
    assert.equal(rec.n_channels, 271);
    assert.equal(rec.sampling_frequency, 1024);
    assert.equal(rec.n_samples, 256);
    assert.equal(rec.duration_s, 256 / 1024);
    assert.equal(rec.channel_labels.length, 271);
    assert.equal(rec.channel_labels[0], 'Ch1', 'fallback labels when no _channels.tsv');

    const win = await rec.readWindow(0, 5);
    assert.equal(win.length, 271, 'window returns one Float32Array per channel');
    assert.equal(win[0].length, 5);
    // Cross-check against mne-python: ch0 sample 0 = 12221.6806...
    assert.ok(Math.abs(win[0][0] - 12221.68) < 1.0);
    // ch1 sample 0 = 6137.47... (verifies the column-major slicing
    // matches MATLAB's on-disk order — if dims were transposed the
    // wrong way, ch1's value would land on a different sample).
    assert.ok(Math.abs(win[1][0] - 6137.47) < 1.0);
  },
);

// ─── EEGLABReader integration: split-file path with v7.3 .set ────

test(
  'EEGLABReader.open: test_raw_h5.set + sidecar .fdt picks the .fdt path',
  skipIfMissing(SIDECAR_FIXTURE),
  async () => {
    // test_raw_h5.set is itself a v7.3 file whose /EEG/data is a CHAR
    // string ("test_raw.fdt") — i.e. a metadata-only sidecar. Make
    // sure we resolve that to the actual .fdt blob and serve windows
    // from there (Mat73.parse() refuses to inline-fake the path).
    if (!fixtureExists(SIDECAR_FDT)) {
      assert.fail(`sibling .fdt missing: ${SIDECAR_FDT} (download from mne-testing-data)`);
    }
    const setUrl = registerFixture(SIDECAR_FIXTURE, 'test_raw_h5.set');
    const fdtUrl = registerFixture(SIDECAR_FDT, 'test_raw.fdt');
    const rec = await EEGLABReader.open({
      eeg_url: setUrl,
      prefix:  'test_raw_h5',
      dir:     'https://localdrop.invalid/',
      ext:     'set',
      // Provide the sibling explicitly: in the real wire-up,
      // bids-recording.js resolves it via the NEMAR map or the BIDS
      // string-derived URL; either way the reader sees a sibling URL.
      sibling_urls: { 'test_raw_h5_eeg.fdt': fdtUrl },
      // .fdt is a headerless float32 blob — we need _channels.tsv + json.
      channels: Array.from({ length: FDT_NCH }, (_, i) => ({
        name: `Ch${i + 1}`, index: i, type: 'EEG', units: 'uV', status: 'good',
      })),
      eeg_json: { sampling_frequency: FDT_FS, recording_duration: null, raw: {} },
    });
    assert.equal(rec.n_channels, FDT_NCH);
    assert.equal(rec.sampling_frequency, FDT_FS);
    assert.equal(rec.n_samples, FDT_PNTS);

    const win = await rec.readWindow(0, 5);
    assert.equal(win.length, FDT_NCH);
    assert.equal(win[0].length, 5);
    assert.ok(Number.isFinite(win[0][0]), 'first sample must be finite');
  },
);

test(
  'Mat73.parse: surfacing CHAR sidecar misroute with a clear error',
  skipIfMissing(SIDECAR_FIXTURE),
  async () => {
    // If someone misroutes a sidecar .set to the inline parser (e.g.
    // a future test that bypasses the sibling-resolution branch),
    // Mat73.parse must throw a message naming the situation rather
    // than returning a garbled Var.
    const buf = fs.readFileSync(SIDECAR_FIXTURE);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    await assert.rejects(
      () => Mat73.parse(ab),
      /CHAR sidecar filename/,
      'must reject a sidecar-only .set with a recognisable message',
    );
  },
);

// ─── Sanity: v5 fixture still parses through MatV5, not Mat73 ────

test(
  'EEGLABReader.open: test_raw_2021.set (MAT v5) still uses MatV5 path',
  skipIfMissing(`${FIXTURE_DIR}/test_raw_2021.set`),
  async () => {
    // The v5 fixture is small (75 KB) and uses the legacy MAT v5
    // format — no HDF5 wrapper. Confirms the version dispatch in
    // openInlineSet didn't accidentally route v5 through Mat73.
    const url = registerFixture(`${FIXTURE_DIR}/test_raw_2021.set`, 'test_raw_2021.set');
    const rec = await EEGLABReader.open({
      eeg_url: url,
      prefix:  'test_raw_2021',
      dir:     'https://localdrop.invalid/',
      ext:     'set',
      sibling_urls: {},
      channels: null,
      eeg_json: { sampling_frequency: null, recording_duration: null, raw: {} },
    });
    assert.ok(rec.n_channels > 0);
    assert.ok(rec.sampling_frequency > 0);
    assert.ok(rec.n_samples > 0);
  },
);
