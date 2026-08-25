// unit-bids-recording-walk.test.mjs
// The BIDS inheritance walk must stop at the URL origin. Before the
// guard, `https://localdrop.invalid/` climbed to `https://` and probed
// `https://<sidecar>/` hostnames — DNS failures that sank every
// drag-drop / host-bridge load whose name carried entities.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BIDSRecording, HttpRange } from './_bootstrap.mjs';

const levels = (dir) => [...BIDSRecording._eachInheritanceLevel(dir, 'sub-01_ses-02_task-x', '_eeg.json')];

test('walk: a localdrop file has exactly one level and never leaves the host', () => {
  const ls = levels('https://localdrop.invalid/');
  assert.equal(ls.length, 1);
  for (const p of ls[0].paths) assert.match(p, /^https:\/\/localdrop\.invalid\/[^/]+$/);
});

test('walk: a nested BIDS path climbs sub/ses/eeg → ses → sub → root and stops', () => {
  const ls = levels('https://s3.amazonaws.com/openneuro.org/ds1/sub-01/ses-02/eeg/');
  assert.deepEqual(ls.map(l => l.here), [
    'https://s3.amazonaws.com/openneuro.org/ds1/sub-01/ses-02/eeg/',
    'https://s3.amazonaws.com/openneuro.org/ds1/sub-01/ses-02/',
    'https://s3.amazonaws.com/openneuro.org/ds1/sub-01/',
    'https://s3.amazonaws.com/openneuro.org/ds1/',
  ]);
});

test('fetchTextOrNull: a thrown network error is "missing", not fatal', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  try {
    assert.equal(await HttpRange.fetchTextOrNull('https://nope.invalid/x_eeg.json'), null);
  } finally { globalThis.fetch = orig; }
});
