// Verifies the CTF-specific URL routing in bids-recording.js.
//
// CTF is the only format whose `ext` URL parameter names a *directory*
// (the .ds/ bundle), not a single file. The path builder must expand
// `ext=ds` into `<entities>_meg.ds/<entities>_meg.meg4` so HttpRange
// can stream the actual binary.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BIDSRecording } from './_bootstrap.mjs';

test('bids-recording: ext=ds builds a path ending in .ds/<entities>_meg.meg4', () => {
  const url = BIDSRecording.buildOpenNeuroEegUrl({
    dataset: 'ds003633',
    sub: '01',
    ses: 'movie',
    task: 'movie',
    run: '01',
    ext: 'ds',
    suffix: 'meg',
  });
  assert.match(url, /sub-01_ses-movie_task-movie_run-01_meg\.ds\/sub-01_ses-movie_task-movie_run-01_meg\.meg4$/,
    `expected .ds/<entities>_meg.meg4 tail, got: ${url}`);
});

test('bids-recording: ext=ds threads the bundle path into the meg directory', () => {
  const url = BIDSRecording.buildOpenNeuroEegUrl({
    dataset: 'ds003633',
    sub: '01',
    ses: 'movie',
    ext: 'ds',
    suffix: 'meg',
  });
  // Must still slot under sub-01/ses-movie/meg/.
  assert.match(url, /\/ds003633\/sub-01\/ses-movie\/meg\//);
});

test('bids-recording: parsePhysioUrl accepts a URL pointing inside a .ds bundle', () => {
  const u = 'https://example.com/ds/sub-01/ses-movie/meg/sub-01_ses-movie_task-movie_run-01_meg.ds/sub-01_ses-movie_task-movie_run-01_meg.meg4';
  const p = BIDSRecording.parsePhysioUrl(u);
  // The reader extension is 'ds' (the bundle), not 'meg4'. This is
  // what viewer.js + worker.js dispatch on — READERS['ds'] === CTFReader.
  assert.equal(p.ext, 'ds');
  assert.equal(p.prefix, 'sub-01_ses-movie_task-movie_run-01');
  assert.equal(p.suffix, 'meg');
  // dir is the *meg directory*, NOT the .ds/ bundle — sidecar
  // inheritance walks above the bundle, not inside it.
  assert.match(p.dir, /\/meg\/$/);
});
