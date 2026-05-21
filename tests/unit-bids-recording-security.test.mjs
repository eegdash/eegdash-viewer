// Security regression tests for bids-recording.js URL gate.
//
// Threat model (Fix A3): the ?eeg=/?ieeg= query params accept a URL
// directly and pass it to fetch(). The previous gate was a permissive
// case-sensitive scheme check that:
//   - accepted scheme-relative URLs `//evil.com/...`
//   - did not normalize uppercase `HTTP://` reliably
//   - accepted javascript:/data:/file: when the parser failed to
//     classify the protocol
// The replacement resolves the input against the document baseURI and
// accepts ONLY when the resolved protocol is http: or https:.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BIDSRecording } from './_bootstrap.mjs';

const isAllowed = BIDSRecording._isAllowedProtocol;

test('A3: accepts plain https:// URLs', () => {
  assert.equal(isAllowed('https://cdn.eegdash.org/sub-01_eeg.set'), true);
  assert.equal(isAllowed('https://s3.amazonaws.com/openneuro/x.edf'), true);
});

test('A3: accepts plain http:// URLs (localhost / dev)', () => {
  assert.equal(isAllowed('http://localhost:3000/x.edf'), true);
  assert.equal(isAllowed('http://127.0.0.1/x.set'), true);
});

test('A3: accepts plain relative paths (resolve to current origin)', () => {
  // Plain relative paths inherit the viewer's own origin/scheme via the
  // baseURI. These are the local-fixture and pre-bundled-demo cases.
  assert.equal(isAllowed('/test-data/foo.edf'), true);
  assert.equal(isAllowed('test-data/foo.edf'), true);
  assert.equal(isAllowed('./foo.edf'), true);
});

test('A3: normalizes uppercase HTTP:// (URL spec lowercases scheme)', () => {
  // HTTP://x.com is dangerous only if the legacy gate dropped it
  // through a case-sensitive comparison. After URL normalization the
  // protocol is `http:` and the destination is the same as `http://x.com`,
  // which is safe under our model.
  assert.equal(isAllowed('HTTP://example.com/x.edf'), true);
  assert.equal(isAllowed('HTTPS://example.com/x.edf'), true);
});

test('A3: REJECTS javascript: scheme', () => {
  assert.equal(isAllowed('javascript:alert(1)'), false);
  assert.equal(isAllowed('JaVaScRiPt:alert(1)'), false);
});

test('A3: REJECTS data: scheme', () => {
  assert.equal(isAllowed('data:text/html,x'), false);
  assert.equal(isAllowed('data:application/octet-stream;base64,AAAA'), false);
});

test('A3: REJECTS file: scheme', () => {
  assert.equal(isAllowed('file:///etc/passwd'), false);
  assert.equal(isAllowed('file:///c:/windows/system32/config/SAM'), false);
});

test('A3: REJECTS scheme-relative //evil.com/x', () => {
  // `//evil.com/x` would inherit the viewer's scheme but redirect the
  // browser to attacker origin with cookies/referer attached.
  assert.equal(isAllowed('//evil.com/x.edf'), false);
  assert.equal(isAllowed('///evil.com/x.edf'), false);
});

test('A3: REJECTS other non-http schemes', () => {
  assert.equal(isAllowed('ftp://attacker.com/x'), false);
  assert.equal(isAllowed('blob:https://example.com/abc-def'), false);
  assert.equal(isAllowed('chrome://settings'), false);
  assert.equal(isAllowed('ws://evil.com/socket'), false);
  assert.equal(isAllowed('vbscript:alert(1)'), false);
});

test('A3: REJECTS empty / non-string', () => {
  assert.equal(isAllowed(''), false);
  assert.equal(isAllowed(null), false);
  assert.equal(isAllowed(undefined), false);
  assert.equal(isAllowed(42), false);
  assert.equal(isAllowed({}), false);
});

test('A3: REJECTS malformed URLs', () => {
  // Some inputs are unparseable even against a base URI.
  assert.equal(isAllowed('http://[invalid'), false);
});

test('A3: integration via resolveTargets — javascript: throws', () => {
  // End-to-end: the gate is wired into resolveTargets, so a hostile
  // ?eeg= value must throw "Invalid URL protocol".
  assert.throws(
    () => BIDSRecording.resolveTargets(new URLSearchParams('eeg=javascript:alert(1)')),
    /Invalid URL protocol/,
  );
  assert.throws(
    () => BIDSRecording.resolveTargets(new URLSearchParams('eeg=//evil.com/x.edf')),
    /Invalid URL protocol/,
  );
  assert.throws(
    () => BIDSRecording.resolveTargets(new URLSearchParams('eeg=file:///etc/passwd')),
    /Invalid URL protocol/,
  );
});

test('A3: integration via resolveTargets — https: passes', () => {
  const t = BIDSRecording.resolveTargets(new URLSearchParams('eeg=https://cdn.example.com/x.edf'));
  assert.equal(t.kind, 'url');
  assert.equal(t.eeg_url, 'https://cdn.example.com/x.edf');
});
