// Security regression tests for formats/eeglab.js
//
// Threat model: a hostile .set v7.3 file can embed an arbitrary string
// as the /EEG/data CHAR pointer (the "named sidecar filename"). The
// fallback path concatenates `dir + namedFdt` and fetches the URL —
// so an attacker who controls the .set can force the viewer to fetch
// "../../../etc/passwd", "//evil.com/x", "data:...", "javascript:...",
// etc., escaping the .set's directory.
//
// Fix A1: only accept BASENAMEs (no slash/backslash, no leading dot,
// no scheme). Validator is exported as _validateCrossFdtName so it
// can be unit-tested in isolation.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const EEGLABReader = require('../formats/eeglab.js');

test('eeglab security: _validateCrossFdtName accepts plain basenames', () => {
  assert.equal(
    EEGLABReader._validateCrossFdtName('test_raw_h5.fdt'),
    'test_raw_h5.fdt',
  );
  assert.equal(
    EEGLABReader._validateCrossFdtName('eeg_data.fdt'),
    'eeg_data.fdt',
  );
  // Underscores, digits, hyphens are all fine.
  assert.equal(
    EEGLABReader._validateCrossFdtName('sub-01_task-rest_eeg.fdt'),
    'sub-01_task-rest_eeg.fdt',
  );
});

test('eeglab security: rejects path-traversal via forward slash', () => {
  assert.throws(
    () => EEGLABReader._validateCrossFdtName('../../../etc/passwd'),
    /path separator or scheme/,
  );
  assert.throws(
    () => EEGLABReader._validateCrossFdtName('subdir/data.fdt'),
    /path separator or scheme/,
  );
});

test('eeglab security: rejects path-traversal via backslash', () => {
  assert.throws(
    () => EEGLABReader._validateCrossFdtName('..\\..\\etc\\passwd'),
    /path separator or scheme/,
  );
  assert.throws(
    () => EEGLABReader._validateCrossFdtName('subdir\\data.fdt'),
    /path separator or scheme/,
  );
});

test('eeglab security: rejects scheme-relative cross-origin', () => {
  assert.throws(
    () => EEGLABReader._validateCrossFdtName('//evil.com/x.fdt'),
    /path separator or scheme/,
  );
});

test('eeglab security: rejects absolute URLs with scheme', () => {
  assert.throws(
    () => EEGLABReader._validateCrossFdtName('http://evil.com/x.fdt'),
    /path separator or scheme/,
  );
  assert.throws(
    () => EEGLABReader._validateCrossFdtName('https://evil.com/x.fdt'),
    /path separator or scheme/,
  );
  assert.throws(
    () => EEGLABReader._validateCrossFdtName('file:///etc/passwd'),
    /path separator or scheme/,
  );
  assert.throws(
    () => EEGLABReader._validateCrossFdtName('javascript:alert(1)'),
    /path separator or scheme/,
  );
  assert.throws(
    () => EEGLABReader._validateCrossFdtName('data:text/html,x'),
    /path separator or scheme/,
  );
});

test('eeglab security: rejects uppercase scheme (regex is case-insensitive)', () => {
  assert.throws(
    () => EEGLABReader._validateCrossFdtName('HTTP://evil.com/x.fdt'),
    /path separator or scheme/,
  );
});

test('eeglab security: rejects leading dot (hidden file or relative)', () => {
  assert.throws(
    () => EEGLABReader._validateCrossFdtName('.env'),
    /path separator or scheme/,
  );
  assert.throws(
    () => EEGLABReader._validateCrossFdtName('.'),
    /path separator or scheme/,
  );
  assert.throws(
    () => EEGLABReader._validateCrossFdtName('..'),
    /path separator or scheme/,
  );
});

// ---------------------------------------------------------------
// Fix A2: integer overflow / OOM guard on (nbchan, pnts, trials).
// A hostile .set advertising pnts=1e9, nbchan=10000 would push
// nbchan*pnts*trials*4 ≥ 4e13 → instant OOM at the allocator.
// ---------------------------------------------------------------

test('eeglab security A2: accepts realistic EEG dimensions', () => {
  // Typical: 64 channels, 1 hour at 1 kHz, 1 trial
  assert.doesNotThrow(() => EEGLABReader._validateScalars(64, 3_600_000, 1));
  // Typical epoched: 32 channels, 1024 samples, 200 trials
  assert.doesNotThrow(() => EEGLABReader._validateScalars(32, 1024, 200));
  // HD-EEG: 256 channels, modest length
  assert.doesNotThrow(() => EEGLABReader._validateScalars(256, 100_000, 1));
});

test('eeglab security A2: rejects nbchan > MAX_CH', () => {
  const { MAX_CH } = EEGLABReader._SCALAR_CAPS;
  assert.throws(
    () => EEGLABReader._validateScalars(MAX_CH + 1, 1000, 1),
    /rejecting nbchan/,
  );
  assert.throws(
    () => EEGLABReader._validateScalars(10000, 1000, 1),
    /rejecting nbchan/,
  );
});

test('eeglab security A2: rejects pnts > MAX_SAMPLES', () => {
  const { MAX_SAMPLES } = EEGLABReader._SCALAR_CAPS;
  assert.throws(
    () => EEGLABReader._validateScalars(1, MAX_SAMPLES + 1, 1),
    /rejecting pnts/,
  );
  assert.throws(
    () => EEGLABReader._validateScalars(1, 1e10, 1),
    /rejecting pnts/,
  );
});

test('eeglab security A2: rejects trials > MAX_TRIALS', () => {
  const { MAX_TRIALS } = EEGLABReader._SCALAR_CAPS;
  assert.throws(
    () => EEGLABReader._validateScalars(1, 1000, MAX_TRIALS + 1),
    /rejecting trials/,
  );
});

test('eeglab security A2: rejects non-positive / non-integer', () => {
  assert.throws(() => EEGLABReader._validateScalars(0, 1000, 1), /rejecting nbchan/);
  assert.throws(() => EEGLABReader._validateScalars(-1, 1000, 1), /rejecting nbchan/);
  assert.throws(() => EEGLABReader._validateScalars(64, 0, 1), /rejecting pnts/);
  assert.throws(() => EEGLABReader._validateScalars(64, 1000, 0), /rejecting trials/);
  assert.throws(() => EEGLABReader._validateScalars(NaN, 1000, 1), /rejecting nbchan/);
  assert.throws(() => EEGLABReader._validateScalars(64, NaN, 1), /rejecting pnts/);
  assert.throws(() => EEGLABReader._validateScalars(64, 1000, NaN), /rejecting trials/);
  assert.throws(() => EEGLABReader._validateScalars(64.5, 1000, 1), /rejecting nbchan/);
  assert.throws(() => EEGLABReader._validateScalars(64, 1000.5, 1), /rejecting pnts/);
});

test('eeglab security A2: rejects total samples product over cap', () => {
  // Each scalar in range, but the product blows past MAX_SAMPLES.
  // 4096 ch × 1e6 samples × 1 trial = 4.1e9 > 2^30 (~1.07e9).
  assert.throws(
    () => EEGLABReader._validateScalars(4096, 1_000_000, 1),
    /exceeds cap/,
  );
  // 100 ch × 100k samples × 2000 trials = 2e10 ≫ cap
  assert.throws(
    () => EEGLABReader._validateScalars(100, 100_000, 2000),
    /exceeds cap/,
  );
});

test('eeglab security: rejects empty / non-string', () => {
  assert.throws(
    () => EEGLABReader._validateCrossFdtName(''),
    /empty or non-string/,
  );
  assert.throws(
    () => EEGLABReader._validateCrossFdtName(null),
    /empty or non-string/,
  );
  assert.throws(
    () => EEGLABReader._validateCrossFdtName(undefined),
    /empty or non-string/,
  );
  assert.throws(
    () => EEGLABReader._validateCrossFdtName(42),
    /empty or non-string/,
  );
});
