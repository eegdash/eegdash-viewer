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
