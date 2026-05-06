// Unit tests for the BIDS-side helpers in bids-recording.js. These
// catch regressions in the algorithm-shaped pieces (inheritance walk
// variant generation, tokeniser, permissive TSV parser) where an
// end-to-end network test would only fail if a real dataset happened
// to exercise the broken case.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BIDSRecording } from './_bootstrap.mjs';

// ----- tokenizePrefix --------------------------------------------

test('tokenizePrefix: full sub_ses_task_run', () => {
  assert.deepEqual(
    BIDSRecording._tokenizePrefix('sub-01_ses-1_task-rest_run-1'),
    ['sub-01', 'ses-1', 'task-rest', 'run-1']);
});

test('tokenizePrefix: sub-only', () => {
  assert.deepEqual(BIDSRecording._tokenizePrefix('sub-01'), ['sub-01']);
});

test('tokenizePrefix: sub_task (the ds002336 shape)', () => {
  assert.deepEqual(
    BIDSRecording._tokenizePrefix('sub-xp101_task-eegfmriNF'),
    ['sub-xp101', 'task-eegfmriNF']);
});

test('tokenizePrefix: hyphenated entity values survive', () => {
  // Unusual but legal: a value can contain a hyphen as long as the
  // entity key precedes the first one. The key-tokenizer splits at
  // `_`, not `-`, so this is preserved.
  assert.deepEqual(
    BIDSRecording._tokenizePrefix('sub-01_task-multi-word_run-1'),
    ['sub-01', 'task-multi-word', 'run-1']);
});

test('tokenizePrefix: empty', () => {
  assert.deepEqual(BIDSRecording._tokenizePrefix(''), []);
});

test('tokenizePrefix: non-BIDS prefix falls back to underscore split', () => {
  // Defensive — if the prefix doesn't start with sub-, we don't drop
  // it on the floor, we split on `_` so the inheritance walk still
  // produces something usable.
  assert.deepEqual(
    BIDSRecording._tokenizePrefix('weird_blob_name'),
    ['weird', 'blob', 'name']);
});

// ----- entityVariants --------------------------------------------

test('entityVariants: drops from the right (chain 1)', () => {
  const v = BIDSRecording._entityVariants('sub-01_ses-1_task-rest_run-1');
  assert.ok(v.includes('sub-01_ses-1_task-rest_run-1'));
  assert.ok(v.includes('sub-01_ses-1_task-rest'));
  assert.ok(v.includes('sub-01_ses-1'));
  assert.ok(v.includes('sub-01'));
});

test('entityVariants: drops leading sub (chain 2 — the ds002336 fix)', () => {
  // This was the bug: entity stripping never reached the leading
  // sub- because it has no underscore prefix. Without these
  // variants, `task-eegfmriNF_eeg.json` at the dataset root never
  // gets probed.
  const v = BIDSRecording._entityVariants('sub-xp101_task-eegfmriNF');
  assert.ok(v.includes('task-eegfmriNF'),
    `expected 'task-eegfmriNF' in ${JSON.stringify(v)}`);
});

test('entityVariants: drops leading sub for full prefix (chain 2 long)', () => {
  const v = BIDSRecording._entityVariants('sub-01_ses-1_task-rest_run-1');
  assert.ok(v.includes('ses-1_task-rest_run-1'));
  assert.ok(v.includes('ses-1_task-rest'));
  assert.ok(v.includes('ses-1'));
});

test('entityVariants: most-specific first (priority order)', () => {
  const v = BIDSRecording._entityVariants('sub-01_task-rest_run-1');
  assert.equal(v[0], 'sub-01_task-rest_run-1', 'full prefix is first');
  // The single-token variant ('sub-01' or 'task-rest') comes after
  // the multi-token ones so the inheritance walk takes deeper hits.
  const subIdx = v.indexOf('sub-01');
  const fullIdx = v.indexOf('sub-01_task-rest_run-1');
  assert.ok(subIdx > fullIdx);
});

test('entityVariants: deduplicates (sub-01 appears once even from both chains)', () => {
  const v = BIDSRecording._entityVariants('sub-01');
  assert.equal(v.length, 1);
  assert.equal(v[0], 'sub-01');
});

// ----- parseTsv (permissive) -------------------------------------

test('parseTsv: tab-separated', () => {
  const rows = BIDSRecording._parseTsv('name\ttype\tunits\nFp1\tEEG\tuV');
  assert.deepEqual(rows, [['name', 'type', 'units'], ['Fp1', 'EEG', 'uV']]);
});

test('parseTsv: whitespace-separated (the ds002336 case)', () => {
  // No tabs anywhere; multiple spaces between columns.
  const rows = BIDSRecording._parseTsv('name   type   units\nFp1   EEG   microV');
  assert.deepEqual(rows, [['name', 'type', 'units'], ['Fp1', 'EEG', 'microV']]);
});

test('parseTsv: strips surrounding single quotes from cells', () => {
  // ds002336 has channel names quoted as 'Fp1'.
  const rows = BIDSRecording._parseTsv("name\ttype\n'Fp1'\tEEG");
  assert.deepEqual(rows[1], ['Fp1', 'EEG']);
});

test('parseTsv: strips surrounding double quotes from cells', () => {
  const rows = BIDSRecording._parseTsv('name\ttype\n"Fp1"\tEEG');
  assert.deepEqual(rows[1], ['Fp1', 'EEG']);
});

test('parseTsv: ignores comment lines starting with #', () => {
  const rows = BIDSRecording._parseTsv('# comment\nname\ttype\nFp1\tEEG');
  assert.equal(rows.length, 2);
});

test('parseTsv: handles CRLF line endings', () => {
  const rows = BIDSRecording._parseTsv('name\ttype\r\nFp1\tEEG\r\n');
  assert.equal(rows.length, 2);
});

test('parseTsv: empty lines dropped', () => {
  const rows = BIDSRecording._parseTsv('name\ttype\n\n\nFp1\tEEG');
  assert.equal(rows.length, 2);
});

// ----- parseEegUrl -----------------------------------------------

test('parseEegUrl: standard OpenNeuro path', () => {
  const u = BIDSRecording.parseEegUrl(
    'https://s3.amazonaws.com/openneuro.org/ds002893/sub-001/eeg/sub-001_task-Rest_eeg.set');
  assert.equal(u.dir, 'https://s3.amazonaws.com/openneuro.org/ds002893/sub-001/eeg/');
  assert.equal(u.prefix, 'sub-001_task-Rest');
  assert.equal(u.ext, 'set');
});

test('parseEegUrl: localdrop (drag-drop) path', () => {
  const u = BIDSRecording.parseEegUrl('https://localdrop.invalid/sub-01_eeg.vhdr');
  assert.equal(u.dir, 'https://localdrop.invalid/');
  assert.equal(u.prefix, 'sub-01');
  assert.equal(u.ext, 'vhdr');
});

test('parseEegUrl: rejects URLs that are not BIDS *_eeg.<ext>', () => {
  assert.throws(
    () => BIDSRecording.parseEegUrl('https://example.com/random.bin'),
    /not a BIDS \*_eeg/);
});

// ----- buildOpenNeuroEegUrl --------------------------------------

test('buildOpenNeuroEegUrl: full entity set', () => {
  assert.equal(
    BIDSRecording.buildOpenNeuroEegUrl({
      dataset: 'ds002034', sub: '01', ses: '01', task: 'offline', run: '01', ext: 'edf',
    }),
    'https://s3.amazonaws.com/openneuro.org/ds002034/sub-01/ses-01/eeg/sub-01_ses-01_task-offline_run-01_eeg.edf');
});

test('buildOpenNeuroEegUrl: no ses, no run', () => {
  assert.equal(
    BIDSRecording.buildOpenNeuroEegUrl({ dataset: 'ds002336', sub: 'xp101', task: 'motorloc', ext: 'vhdr' }),
    'https://s3.amazonaws.com/openneuro.org/ds002336/sub-xp101/eeg/sub-xp101_task-motorloc_eeg.vhdr');
});

test('buildOpenNeuroEegUrl: missing required dataset throws', () => {
  assert.throws(
    () => BIDSRecording.buildOpenNeuroEegUrl({ sub: '01' }),
    /missing required URL param: dataset/);
});

// ----- resolveTargets -------------------------------------------

test('resolveTargets: ?eeg= takes priority', () => {
  const t = BIDSRecording.resolveTargets(new URLSearchParams(
    'eeg=https://s3/foo.set&dataset=dsX&sub=01&task=rest'));
  assert.equal(t.kind, 'url');
  assert.equal(t.eeg_url, 'https://s3/foo.set');
});

test('resolveTargets: ?dataset= builds OpenNeuro URL', () => {
  const t = BIDSRecording.resolveTargets(new URLSearchParams(
    'dataset=ds002336&sub=xp101&task=motorloc&ext=vhdr'));
  assert.equal(t.kind, 'bids-path');
  assert.match(t.eeg_url, /ds002336.*sub-xp101.*motorloc.*\.vhdr$/);
});

test('resolveTargets: nothing → null', () => {
  assert.equal(BIDSRecording.resolveTargets(new URLSearchParams('')), null);
});
