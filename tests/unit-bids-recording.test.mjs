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
  // bids-recording.js parseEegUrl delegates to parsePhysioUrl, whose
  // error message reads "URL is not a BIDS *_{suffix}.<ext> path: ..."
  // — `{suffix}` is the literal placeholder, not interpolated.
  assert.throws(
    () => BIDSRecording.parseEegUrl('https://example.com/random.bin'),
    /URL is not a BIDS \*_/);
});

// ----- buildOpenNeuroEegUrl --------------------------------------

// Default URL routes through cdn.eegdash.org (Cloudflare Worker proxy
// in front of OpenNeuro S3, ~10× cold-cache speedup). Pass ?direct=1
// to force raw S3 for debugging.
test('buildOpenNeuroEegUrl: full entity set (CDN-routed by default)', () => {
  assert.equal(
    BIDSRecording.buildOpenNeuroEegUrl({
      dataset: 'ds002034', sub: '01', ses: '01', task: 'offline', run: '01', ext: 'edf',
    }),
    'https://cdn.eegdash.org/ds002034/sub-01/ses-01/eeg/sub-01_ses-01_task-offline_run-01_eeg.edf');
});

test('buildOpenNeuroEegUrl: no ses, no run (CDN-routed by default)', () => {
  assert.equal(
    BIDSRecording.buildOpenNeuroEegUrl({ dataset: 'ds002336', sub: 'xp101', task: 'motorloc', ext: 'vhdr' }),
    'https://cdn.eegdash.org/ds002336/sub-xp101/eeg/sub-xp101_task-motorloc_eeg.vhdr');
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

// ============================================================
// Iteration 8 (PR 14): golden-output assertions
// ------------------------------------------------------------
// The c8 line coverage on bids-recording.js is 98% but the mutation
// score is 36.71% — tests execute the code but assert too loosely.
// These tests pin the EXACT output of each parser so mutations on
// regexes, slice indexes, conditional branches, and string literals
// stop being equivalent under our assertions.
// ============================================================

// ----- parseEegUrl / parsePhysioUrl: full deepEqual --------------

test('parseEegUrl: deepEqual full BIDS path → {dir, prefix, suffix, ext}', () => {
  // Kills Regex mutants on line 53 (the canonical BIDS suffix regex)
  // and StringLiteral / MethodExpression mutants on lines 54, 63.
  const u = BIDSRecording.parseEegUrl(
    'https://s3.amazonaws.com/openneuro.org/ds002034/sub-01/ses-01/eeg/sub-01_ses-01_task-offline_run-01_eeg.EDF');
  assert.deepEqual(u, {
    dir: 'https://s3.amazonaws.com/openneuro.org/ds002034/sub-01/ses-01/eeg/',
    prefix: 'sub-01_ses-01_task-offline_run-01',
    suffix: 'eeg',
    ext: 'edf',  // .toLowerCase() pinned
  });
});

test('parsePhysioUrl: ieeg suffix → full deepEqual', () => {
  // The canonical regex must match ieeg (and emg/meg/nirs). Mutating the
  // suffix alternation drops these.
  const u = BIDSRecording.parsePhysioUrl(
    'https://s3.amazonaws.com/openneuro.org/ds003688/sub-01/ieeg/sub-01_task-rest_ieeg.edf');
  assert.deepEqual(u, {
    dir: 'https://s3.amazonaws.com/openneuro.org/ds003688/sub-01/ieeg/',
    prefix: 'sub-01_task-rest',
    suffix: 'ieeg',
    ext: 'edf',
  });
});

test('parsePhysioUrl: meg .fif → full deepEqual', () => {
  const u = BIDSRecording.parsePhysioUrl(
    'https://example.com/ds/sub-01/meg/sub-01_task-rest_meg.fif');
  assert.deepEqual(u, {
    dir: 'https://example.com/ds/sub-01/meg/',
    prefix: 'sub-01_task-rest',
    suffix: 'meg',
    ext: 'fif',
  });
});

test('parsePhysioUrl: nirs .snirf via fallback (no _nirs suffix) → suffix="eeg"', () => {
  // Fallback path: filename uses the KNOWN_EXT regex (line 59-63), not
  // the BIDS suffix regex. suffix defaults to 'eeg'. Pins the slice
  // math at line 63: prefix = filename without ".ext", ext = the ext
  // after the last dot, lowercased.
  const u = BIDSRecording.parsePhysioUrl('https://localdrop.invalid/myrecording.snirf');
  assert.deepEqual(u, {
    dir: 'https://localdrop.invalid/',
    prefix: 'myrecording',
    suffix: 'eeg',
    ext: 'snirf',
  });
});

test('parsePhysioUrl: extension lowercased even when uppercase in URL', () => {
  // Pins the .toLowerCase() call on line 54 (BIDS path).
  const u = BIDSRecording.parsePhysioUrl(
    'https://s3/ds/sub-01_eeg.VHDR');
  assert.equal(u.ext, 'vhdr');
  assert.equal(u.suffix, 'eeg');
});

test('parsePhysioUrl: throws with literal `*_{suffix}.<ext>` placeholder in message', () => {
  // Kills StringLiteral mutants on the error message (line 65) — the
  // placeholder `{suffix}` is literal, not interpolated. The throw also
  // includes the offending URL.
  assert.throws(
    () => BIDSRecording.parsePhysioUrl('https://example.com/random.bin'),
    (err) => {
      assert.match(err.message, /URL is not a BIDS \*_\{suffix\}\.<ext> path: https:\/\/example\.com\/random\.bin/);
      return true;
    });
});

// ----- isNemarDatasetId: full truth table -------------------------

test('isNemarDatasetId: nm/on/xx + exactly 6 digits → true', () => {
  // Kills the line 176 regex mutants (anchor, digit class, prefix
  // alternation). Each true case is one full bullet of the contract.
  assert.equal(BIDSRecording.isNemarDatasetId('nm000001'), true);
  assert.equal(BIDSRecording.isNemarDatasetId('on999999'), true);
  assert.equal(BIDSRecording.isNemarDatasetId('xx123456'), true);
});

test('isNemarDatasetId: wrong digit count → false', () => {
  // The `\d{6}` quantifier mutation (e.g. \d{5,} or \d+) would survive
  // without these. 5-digit, 7-digit, and 0-digit shapes all reject.
  assert.equal(BIDSRecording.isNemarDatasetId('nm00001'), false, '5 digits');
  assert.equal(BIDSRecording.isNemarDatasetId('nm0000001'), false, '7 digits');
  assert.equal(BIDSRecording.isNemarDatasetId('nm'), false, 'no digits');
});

test('isNemarDatasetId: wrong prefix → false', () => {
  // The `(?:nm|on|xx)` group mutation (e.g. dropping `xx`) is killed.
  assert.equal(BIDSRecording.isNemarDatasetId('ds000001'), false, 'ds prefix (OpenNeuro)');
  assert.equal(BIDSRecording.isNemarDatasetId('ab000001'), false, 'arbitrary prefix');
});

test('isNemarDatasetId: digits with trailing junk → false (anchor)', () => {
  // Kills the `^…$` anchor mutation: without the trailing $, this would
  // match `nm000001x`. With the anchor, it doesn't.
  assert.equal(BIDSRecording.isNemarDatasetId('nm000001x'), false);
  assert.equal(BIDSRecording.isNemarDatasetId('xnm000001'), false);
});

test('isNemarDatasetId: non-string → false', () => {
  // The `typeof id === "string"` guard MUST short-circuit. Without it,
  // null/undefined would NPE on `.test()`.
  assert.equal(BIDSRecording.isNemarDatasetId(null), false);
  assert.equal(BIDSRecording.isNemarDatasetId(undefined), false);
  assert.equal(BIDSRecording.isNemarDatasetId(123456), false);
});

// ----- buildOpenNeuroEegUrl: deepEqual full URL string -----------

test('buildOpenNeuroEegUrl: ieeg suffix routes to /ieeg/ datatype', () => {
  // Kills line 100-108 mutants (datatype map lookup, segment join,
  // _eeg vs _ieeg suffix in entity string).
  assert.equal(
    BIDSRecording.buildOpenNeuroEegUrl({
      dataset: 'ds003688', sub: '01', task: 'rest', ext: 'edf', suffix: 'ieeg',
    }),
    'https://cdn.eegdash.org/ds003688/sub-01/ieeg/sub-01_task-rest_ieeg.edf');
});

test('buildOpenNeuroEegUrl: meg suffix + .fif → /meg/ + _meg.fif', () => {
  assert.equal(
    BIDSRecording.buildOpenNeuroEegUrl({
      dataset: 'ds004388', sub: '01', task: 'rest', ext: 'fif', suffix: 'meg',
    }),
    'https://cdn.eegdash.org/ds004388/sub-01/meg/sub-01_task-rest_meg.fif');
});

test('buildOpenNeuroEegUrl: default ext is "set" when omitted', () => {
  // Kills the StringLiteral mutant on `'set'` (line 90).
  const u = BIDSRecording.buildOpenNeuroEegUrl({ dataset: 'ds', sub: '01', task: 'rest' });
  assert.match(u, /\.set$/);
});

test('buildOpenNeuroEegUrl: ext is lowercased', () => {
  // Kills .toLowerCase() mutant on line 90.
  const u = BIDSRecording.buildOpenNeuroEegUrl({
    dataset: 'ds', sub: '01', task: 'rest', ext: 'EDF',
  });
  assert.match(u, /\.edf$/);
});

test('buildOpenNeuroEegUrl: empty sub throws with key name in message', () => {
  // Kills line 136 error message mutant.
  assert.throws(
    () => BIDSRecording.buildOpenNeuroEegUrl({ dataset: 'ds' }),
    /missing required URL param: sub/);
});

// ----- parseEegJson: full deepEqual ------------------------------

test('parseEegJson: full set of fields → deepEqual including raw passthrough', () => {
  // Kills mutants on the entire object literal at lines 551-559:
  //   - field renames (sampling_frequency vs samplingFrequency)
  //   - numericOrNull vs raw passthrough on RecordingDuration / PowerLineFrequency
  //   - || null on EEGReference / SoftwareFilters / Manufacturer
  //   - raw: obj (the unmodified original)
  const r = BIDSRecording.parseEegJson({
    SamplingFrequency: 256,
    RecordingDuration: 600,
    EEGReference: 'Cz',
    PowerLineFrequency: 60,
    SoftwareFilters: 'n/a',  // truthy → kept; numericOrNull NOT applied here
    Manufacturer: 'BrainProducts',
    Extra: 'kept-in-raw',
  });
  assert.deepEqual(r, {
    sampling_frequency: 256,
    recording_duration: 600,
    eeg_reference: 'Cz',
    power_line_frequency: 60,
    software_filters: 'n/a',   // string passes the `|| null` truthy guard
    manufacturer: 'BrainProducts',
    raw: {
      SamplingFrequency: 256,
      RecordingDuration: 600,
      EEGReference: 'Cz',
      PowerLineFrequency: 60,
      SoftwareFilters: 'n/a',
      Manufacturer: 'BrainProducts',
      Extra: 'kept-in-raw',  // unknown keys preserved in raw
    },
  });
});

test('parseEegJson: only SamplingFrequency → all optionals are null, raw is minimal', () => {
  // Kills the `|| null` fallback mutants (lines 554-557) — without them,
  // missing fields would be `undefined`, not `null`.
  const r = BIDSRecording.parseEegJson({ SamplingFrequency: 500 });
  assert.deepEqual(r, {
    sampling_frequency: 500,
    recording_duration: null,
    eeg_reference: null,
    power_line_frequency: null,
    software_filters: null,
    manufacturer: null,
    raw: { SamplingFrequency: 500 },
  });
});

test('parseEegJson: SamplingFrequency=0 → throws with exact "positive number" wording', () => {
  // Kills the `<= 0` predicate mutation (line 548) AND the error
  // message StringLiteral mutants.
  assert.throws(
    () => BIDSRecording.parseEegJson({ SamplingFrequency: 0 }),
    /_eeg\.json: SamplingFrequency must be a positive number \(got 0\)/);
});

test('parseEegJson: SamplingFrequency=NaN → throws (isFinite guard)', () => {
  // Kills the `!isFinite(fs)` guard mutation.
  assert.throws(
    () => BIDSRecording.parseEegJson({ SamplingFrequency: NaN }),
    /must be a positive number/);
});

test('parseEegJson: null input → throws "not an object"', () => {
  // Kills the `!obj` guard mutation (line 546).
  assert.throws(
    () => BIDSRecording.parseEegJson(null),
    /_eeg\.json is not an object/);
});

test('parseEegJson: RecordingDuration=NaN/Infinity → recording_duration:null', () => {
  // Kills numericOrNull line 563: the isFinite check rejects NaN/Inf.
  assert.equal(
    BIDSRecording.parseEegJson({ SamplingFrequency: 256, RecordingDuration: NaN }).recording_duration,
    null);
  assert.equal(
    BIDSRecording.parseEegJson({ SamplingFrequency: 256, RecordingDuration: Infinity }).recording_duration,
    null);
  // String "120" is NOT a number → null (the `typeof v === 'number'` guard).
  assert.equal(
    BIDSRecording.parseEegJson({ SamplingFrequency: 256, RecordingDuration: '120' }).recording_duration,
    null);
});

// ----- parseChannelsTsv: full deepEqual --------------------------

test('parseChannelsTsv: full column set → exact channels array via deepEqual', () => {
  // Kills the entire `channels.push({...})` object-literal mutants
  // (lines 590-599): each field rename, drop, or swap is caught.
  // Especially:
  //   - index = channels.length (NOT the row index)
  //   - status defaults to 'good' when bidsCell returns null
  //   - low_cutoff/high_cutoff/sampling_frequency use parseFloatOrNull
  const tsv = [
    'name\ttype\tunits\tstatus\tlow_cutoff\thigh_cutoff\tsampling_frequency',
    'Fp1\tEEG\tuV\tgood\t0.1\t100\t256',
    'Fp2\tEEG\tuV\tbad\t0.1\t100\t256',
    'O1\tEEG\tn/a\tn/a\tn/a\tn/a\tn/a',
  ].join('\n');
  const channels = BIDSRecording.parseChannelsTsv(tsv);
  assert.deepEqual(channels, [
    { index: 0, name: 'Fp1', type: 'EEG', units: 'uV', status: 'good',
      low_cutoff: 0.1, high_cutoff: 100, sampling_frequency: 256 },
    { index: 1, name: 'Fp2', type: 'EEG', units: 'uV', status: 'bad',
      low_cutoff: 0.1, high_cutoff: 100, sampling_frequency: 256 },
    // status='n/a' → bidsCell returns null → `|| 'good'` makes it 'good'.
    // units='n/a' → null (no fallback).
    // low/high/fs are 'n/a' strings → parseFloatOrNull → null.
    { index: 2, name: 'O1', type: 'EEG', units: null, status: 'good',
      low_cutoff: null, high_cutoff: null, sampling_frequency: null },
  ]);
});

test('parseChannelsTsv: missing optional columns → null fields, no crash', () => {
  // Kills mutants on the `iX >= 0 ? … : null` guards (lines 593-598):
  // without those guards the parser would index a negative position
  // and either NPE or get the wrong column.
  const tsv = 'name\nFp1\nFp2\nCz';
  const channels = BIDSRecording.parseChannelsTsv(tsv);
  assert.deepEqual(channels, [
    { index: 0, name: 'Fp1', type: null, units: null, status: 'good',
      low_cutoff: null, high_cutoff: null, sampling_frequency: null },
    { index: 1, name: 'Fp2', type: null, units: null, status: 'good',
      low_cutoff: null, high_cutoff: null, sampling_frequency: null },
    { index: 2, name: 'Cz', type: null, units: null, status: 'good',
      low_cutoff: null, high_cutoff: null, sampling_frequency: null },
  ]);
});

test('parseChannelsTsv: empty-name row skipped (channel index gap closed)', () => {
  // Kills the `if (!name) continue` mutation (line 589) — without it,
  // the empty-name row would be pushed as an empty channel with index=1,
  // and Fp2 would become index 2.
  const tsv = 'name\nFp1\n\nFp2';
  const channels = BIDSRecording.parseChannelsTsv(tsv);
  assert.equal(channels.length, 2);
  assert.equal(channels[0].index, 0);
  assert.equal(channels[1].index, 1);  // NOT 2 — the empty row is dropped
});

test('parseChannelsTsv: zero data rows → throws', () => {
  // Kills the `< 2` predicate (line 574).
  assert.throws(
    () => BIDSRecording.parseChannelsTsv('name\ttype'),  // header only
    /_channels\.tsv has no data rows/);
});

test('parseChannelsTsv: missing required name column → throws', () => {
  assert.throws(
    () => BIDSRecording.parseChannelsTsv('type\tunits\nEEG\tuV'),
    /missing required column: name/);
});

// ----- parseEventsTsv: full deepEqual ----------------------------

test('parseEventsTsv: full set → exact events array via deepEqual', () => {
  // Kills line 624-629 object-literal mutants + line 616 iLabel
  // priority (trial_type beats value), + line 626 `|| 0` fallback.
  const tsv = [
    'onset\tduration\ttrial_type\tsample',
    '1.0\t0.5\tStim\t256',
    '2.5\t0\tResp\t640',
  ].join('\n');
  const events = BIDSRecording.parseEventsTsv(tsv);
  assert.deepEqual(events, [
    { onset: 1.0, duration: 0.5, label: 'Stim', sample: 256 },
    { onset: 2.5, duration: 0,   label: 'Resp', sample: 640 },
  ]);
});

test('parseEventsTsv: trial_type beats value column', () => {
  // The iLabel selection prefers trial_type when both are present.
  // Kills the `idx('trial_type') >= 0 ? … : idx('value')` mutation.
  const tsv = 'onset\ttrial_type\tvalue\n1.0\tT_LABEL\tV_LABEL';
  const events = BIDSRecording.parseEventsTsv(tsv);
  assert.equal(events[0].label, 'T_LABEL');
});

test('parseEventsTsv: only value column (no trial_type) → label from value', () => {
  // Kills the fallback-to-value mutation.
  const tsv = 'onset\tvalue\n1.0\tV_LABEL';
  const events = BIDSRecording.parseEventsTsv(tsv);
  assert.equal(events[0].label, 'V_LABEL');
});

test('parseEventsTsv: non-finite onset row dropped', () => {
  // Kills the `if (!isFinite(onset)) continue` line 623 mutation.
  const tsv = 'onset\tduration\nNaN\t0.5\n1.0\t0.5';
  const events = BIDSRecording.parseEventsTsv(tsv);
  assert.equal(events.length, 1);
  assert.equal(events[0].onset, 1.0);
});

test('parseEventsTsv: empty input → empty array (not throw)', () => {
  // Kills the `< 2` predicate mutation on line 610.
  assert.deepEqual(BIDSRecording.parseEventsTsv(''), []);
  assert.deepEqual(BIDSRecording.parseEventsTsv('onset'), []); // header only
});

test('parseEventsTsv: missing onset column → throws', () => {
  assert.throws(
    () => BIDSRecording.parseEventsTsv('duration\n0.5'),
    /missing required column: onset/);
});

test('parseEventsTsv: missing duration column → duration:0 in output', () => {
  // Kills the `iDur >= 0 ? … : 0` mutation (line 626).
  const events = BIDSRecording.parseEventsTsv('onset\n1.0');
  assert.equal(events[0].duration, 0);
});

// ----- resolveTargets: deepEqual full descriptor -----------------

test('resolveTargets: ?ieeg= → kind:url with ieeg URL passed through', () => {
  // Kills the line 775 suffix-array mutants (dropping 'ieeg') and
  // the line 777 return-object shape.
  const t = BIDSRecording.resolveTargets(new URLSearchParams(
    'ieeg=https://s/foo_ieeg.edf'));
  assert.deepEqual(t, { kind: 'url', eeg_url: 'https://s/foo_ieeg.edf' });
});

test('resolveTargets: ?meg= → kind:url with meg URL', () => {
  const t = BIDSRecording.resolveTargets(new URLSearchParams(
    'meg=https://s/foo_meg.fif'));
  assert.deepEqual(t, { kind: 'url', eeg_url: 'https://s/foo_meg.fif' });
});

test('resolveTargets: ?nirs= → kind:url with nirs URL', () => {
  const t = BIDSRecording.resolveTargets(new URLSearchParams(
    'nirs=https://s/foo_nirs.snirf'));
  assert.deepEqual(t, { kind: 'url', eeg_url: 'https://s/foo_nirs.snirf' });
});

test('resolveTargets: ?demo= → kind:demo with demo_id passed through', () => {
  // Kills the line 808 return-object shape mutants.
  const t = BIDSRecording.resolveTargets(new URLSearchParams('demo=fixture-1'));
  assert.deepEqual(t, { kind: 'demo', demo_id: 'fixture-1' });
});

test('resolveTargets: ?dataset=nm000001 → kind:nemar with params including version', () => {
  // Kills line 799-801 NEMAR-branch mutants. Includes the version
  // passthrough so the manifest URL builder validates it.
  const t = BIDSRecording.resolveTargets(new URLSearchParams(
    'dataset=nm000001&sub=01&task=rest&version=v1.2.3'));
  assert.deepEqual(t, {
    kind: 'nemar',
    nemar_params: {
      dataset: 'nm000001',
      sub: '01',
      ses: null,
      task: 'rest',
      run: null,
      ext: null,
      version: 'v1.2.3',
      suffix: 'eeg',
    },
  });
});

test('resolveTargets: ?dataset=on000001 → kind:nemar (NEMAR-style prefix)', () => {
  // Kills the `isNemarDatasetId` regex branch coverage for the `on`
  // prefix that joined the family in nemar-cli sprint #514.
  const t = BIDSRecording.resolveTargets(new URLSearchParams(
    'dataset=on000001&sub=01&task=rest'));
  assert.equal(t.kind, 'nemar');
  assert.equal(t.nemar_params.dataset, 'on000001');
});

test('resolveTargets: ?dataset=ds001 (OpenNeuro) → kind:bids-path with full URL', () => {
  // Kills the `if (api.isNemarDatasetId(ds))` branch on line 799 —
  // OpenNeuro datasets must NOT go through the NEMAR path.
  const t = BIDSRecording.resolveTargets(new URLSearchParams(
    'dataset=ds001&sub=01&task=rest&ext=edf'));
  assert.deepEqual(t, {
    kind: 'bids-path',
    eeg_url: 'https://cdn.eegdash.org/ds001/sub-01/eeg/sub-01_task-rest_eeg.edf',
  });
});

test('resolveTargets: ?dataset= + ?suffix=ieeg → builds /ieeg/ URL', () => {
  // Kills line 795 `'eeg'` default StringLiteral.
  const t = BIDSRecording.resolveTargets(new URLSearchParams(
    'dataset=ds003688&sub=01&task=rest&ext=edf&suffix=ieeg'));
  assert.deepEqual(t, {
    kind: 'bids-path',
    eeg_url: 'https://cdn.eegdash.org/ds003688/sub-01/ieeg/sub-01_task-rest_ieeg.edf',
  });
});

// ----- loadNemarRecording: drives transformManifestUrl / version --

test('loadNemarRecording: invalid version → throws with exact wording', () => {
  // Kills line 193 `_NEMAR_VERSION_SHAPE` regex mutants + line 224-226
  // error message StringLiteral mutants. The shape is exactly
  // /^(?:latest|v\d+\.\d+\.\d+)$/.
  return assert.rejects(
    () => BIDSRecording.loadNemarRecording({
      dataset: 'nm000001', sub: '01', task: 'rest', version: 'v1.2',
    }),
    /NEMAR version param "v1\.2" is invalid — expected "latest" or "vMAJOR\.MINOR\.PATCH"/);
});

test('loadNemarRecording: non-NEMAR dataset id → throws "not a NEMAR-style"', () => {
  // Kills line 243-244 mutants.
  return assert.rejects(
    () => BIDSRecording.loadNemarRecording({
      dataset: 'ds000001', sub: '01', task: 'rest',
    }),
    /not a NEMAR-style dataset id: ds000001/);
});

test('loadNemarRecording: stubbed manifest → annex S3 url transformed to cdn.eegdash.org', async () => {
  // Drives transformManifestUrl (lines 208-220) end-to-end:
  //   - git-tree URL with matching dsId → returned as-is (sidecars).
  //   - annex S3 URL with matching dsId → rewritten to
  //     `https://cdn.eegdash.org/<ds>/objects/<sha>` (presigned query
  //     stripped).
  //   - sibling_urls collects every same-directory entry.
  // Also pins line 248-260: innerPath / dir / basename / prefix / ext
  // slicing arithmetic.
  const MANIFEST = [
    { path: 'sub-01/eeg/sub-01_task-rest_eeg.edf',
      url: 'https://nemar.s3.us-west-2.amazonaws.com/nm000001/objects/SHA256E-s100--abc.edf?X-Amz-Signature=xyz' },
    { path: 'sub-01/eeg/sub-01_task-rest_eeg.json',
      url: 'https://raw.githubusercontent.com/nemarDatasets/nm000001/v1.0.0/sub-01/eeg/sub-01_task-rest_eeg.json' },
    { path: 'sub-01/eeg/sub-01_task-rest_channels.tsv',
      url: 'https://raw.githubusercontent.com/nemarDatasets/nm000001/v1.0.0/sub-01/eeg/sub-01_task-rest_channels.tsv' },
  ];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async function (url) {
    const u = String(url);
    if (u.includes('manifest.json')) {
      return { ok: true, status: 200,
               headers: { get: () => null },
               json: async () => MANIFEST };
    }
    if (u.endsWith('_eeg.json')) {
      return { ok: true, status: 200, text: async () => '{"SamplingFrequency": 256}' };
    }
    if (u.endsWith('_channels.tsv')) {
      return { ok: true, status: 200, text: async () => 'name\ttype\nFp1\tEEG' };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  try {
    const meta = await BIDSRecording.loadNemarRecording({
      dataset: 'nm000001', sub: '01', task: 'rest', ext: 'edf',
    });
    // Annex S3 URL → cdn.eegdash.org/<ds>/objects/<sha> (presigned query
    // stripped). This kills the line 213-219 mutants on annex-S3 routing.
    assert.equal(meta.eeg_url,
      'https://cdn.eegdash.org/nm000001/objects/SHA256E-s100--abc.edf');
    // Git-tree URL passthrough for sidecars — pins the line 211 return
    // `entryUrl` (must NOT route through cdn).
    assert.equal(meta.sidecar_sources.eeg_json,
      'https://raw.githubusercontent.com/nemarDatasets/nm000001/v1.0.0/sub-01/eeg/sub-01_task-rest_eeg.json');
    // sibling_urls collects same-dir entries with their transformed
    // URLs. Three entries because three manifest paths sit in
    // sub-01/eeg/.
    assert.deepEqual(Object.keys(meta.sibling_urls).sort(), [
      'sub-01_task-rest_channels.tsv',
      'sub-01_task-rest_eeg.edf',
      'sub-01_task-rest_eeg.json',
    ]);
    // The annex S3 sibling is also routed through cdn.
    assert.equal(meta.sibling_urls['sub-01_task-rest_eeg.edf'],
      'https://cdn.eegdash.org/nm000001/objects/SHA256E-s100--abc.edf');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('loadNemarRecording: missing manifest entry → throws with innerPath', async () => {
  // Kills lines 280-285 error-message StringLiteral mutants.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async function () {
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => [] };
  };
  try {
    await assert.rejects(
      () => BIDSRecording.loadNemarRecording({
        dataset: 'nm000001', sub: '01', task: 'rest', ext: 'edf',
      }),
      /NEMAR manifest has no entry for sub-01\/eeg\/sub-01_task-rest_eeg\.edf/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('loadNemarRecording: foreign-host URL in manifest → throws "unrecognised shape"', async () => {
  // Kills lines 287-290 + transformManifestUrl return-null branch:
  // a manifest pointing at an untrusted host MUST be refused.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async function () {
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => [{
        path: 'sub-01/eeg/sub-01_task-rest_eeg.edf',
        url: 'https://evil.example.com/random.edf',
      }],
    };
  };
  try {
    await assert.rejects(
      () => BIDSRecording.loadNemarRecording({
        dataset: 'nm000001', sub: '01', task: 'rest', ext: 'edf',
      }),
      /NEMAR manifest url has unrecognised shape: https:\/\/evil\.example\.com\/random\.edf/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('loadNemarRecording: cross-dataset annex URL → also rejected', async () => {
  // The trust-boundary check (annex[1] === dsId) MUST reject a URL
  // pointing at another dataset's bucket. Kills the line 213 dsId
  // comparison.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async function () {
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => [{
        path: 'sub-01/eeg/sub-01_task-rest_eeg.edf',
        url: 'https://nemar.s3.us-west-2.amazonaws.com/nm999999/objects/abc.edf',
      }],
    };
  };
  try {
    await assert.rejects(
      () => BIDSRecording.loadNemarRecording({
        dataset: 'nm000001', sub: '01', task: 'rest', ext: 'edf',
      }),
      /unrecognised shape/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('loadNemarRecording: malformed JSON manifest → throws "not valid JSON"', async () => {
  // Kills the JSON.parse catch path (lines 353-358).
  const origFetch = globalThis.fetch;
  globalThis.fetch = async function () {
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => { throw new SyntaxError('Unexpected token'); },
    };
  };
  try {
    await assert.rejects(
      () => BIDSRecording.loadNemarRecording({
        dataset: 'nm000001', sub: '01', task: 'rest', ext: 'edf',
      }),
      /NEMAR manifest for nm000001 is not valid JSON/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('loadNemarRecording: manifest is not an array → throws', async () => {
  // Kills the line 360 `!Array.isArray` guard mutation.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async function () {
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ entries: [] }),  // object, not array
    };
  };
  try {
    await assert.rejects(
      () => BIDSRecording.loadNemarRecording({
        dataset: 'nm000001', sub: '01', task: 'rest', ext: 'edf',
      }),
      /NEMAR manifest for nm000001 is not a JSON array/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('loadNemarRecording: manifest 404 → throws "unpublished, private, or has no minted version"', async () => {
  // Kills lines 331-335 error wording.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async function () {
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => null };
  };
  try {
    await assert.rejects(
      () => BIDSRecording.loadNemarRecording({
        dataset: 'nm000001', sub: '01', task: 'rest', ext: 'edf',
      }),
      /NEMAR manifest 404 for nm000001: dataset is unpublished, private, or has no minted version yet/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('loadNemarRecording: manifest too large (content-length) → throws byte cap message', async () => {
  // Kills lines 345-350 mutants (size guard + error wording).
  const origFetch = globalThis.fetch;
  globalThis.fetch = async function () {
    return {
      ok: true, status: 200,
      headers: { get: (k) => k === 'content-length' ? String(64 * 1024 * 1024) : null },
      json: async () => [],
    };
  };
  try {
    await assert.rejects(
      () => BIDSRecording.loadNemarRecording({
        dataset: 'nm000001', sub: '01', task: 'rest', ext: 'edf',
      }),
      /refusing to parse/);
  } finally {
    globalThis.fetch = origFetch;
  }
});


// ============================================================
// Iteration 9 (PR 15): kill `iX >= 0` → `iX > 0` survivors
// ============================================================
// 12 EqualityOperator mutants on parseChannelsTsv / parseEventsTsv
// (`iType >= 0` etc.) survived because every existing test puts
// `name` (or `onset`) as the FIRST column, so optional columns land
// at index ≥ 1 — where `>= 0` and `> 0` behave identically. The tests
// below put each optional column at index 0 so the boundary matters.

test('iter9 parseChannelsTsv: type at col 0 (iType=0) — kills `iType >= 0` → `iType > 0`', () => {
  // Header order is intentionally `type, name`. iName=1, iType=0.
  // Under the mutated `iType > 0 ? bidsCell(c[iType]) : null`, type
  // would be NULL because iType=0 fails `> 0` — but the correct code
  // returns 'EEG'.
  const tsv = 'type\tname\nEEG\tFp1';
  const channels = BIDSRecording.parseChannelsTsv(tsv);
  assert.equal(channels.length, 1, 'one data row → one channel');
  assert.equal(channels[0].name, 'Fp1', 'name from col 1');
  assert.equal(channels[0].type, 'EEG',
    'type at col 0 must be picked up; mutant `iType > 0` would yield null');
});

test('iter9 parseChannelsTsv: units at col 0 (iUnits=0) — kills `iUnits >= 0` → `iUnits > 0`', () => {
  const tsv = 'units\tname\nuV\tFp1';
  const channels = BIDSRecording.parseChannelsTsv(tsv);
  assert.equal(channels[0].units, 'uV',
    'units at col 0 must be picked up; mutant `iUnits > 0` would yield null');
});

test('iter9 parseChannelsTsv: status at col 0 (iStatus=0) — kills `iStatus >= 0` → `iStatus > 0`', () => {
  // status absent → defaults to 'good'. status at col 0 with value 'bad'
  // must produce status='bad'. Under the mutated guard, status would
  // fall to the default 'good' instead.
  const tsv = 'status\tname\nbad\tFp1';
  const channels = BIDSRecording.parseChannelsTsv(tsv);
  assert.equal(channels[0].status, 'bad',
    'status at col 0 must override the "good" default; mutant would return "good"');
});

test('iter9 parseChannelsTsv: low_cutoff at col 0 (iLow=0) — kills `iLow >= 0` → `iLow > 0`', () => {
  const tsv = 'low_cutoff\tname\n0.5\tFp1';
  const channels = BIDSRecording.parseChannelsTsv(tsv);
  assert.equal(channels[0].low_cutoff, 0.5,
    'low_cutoff at col 0 must be parsed; mutant would yield null');
});

test('iter9 parseChannelsTsv: high_cutoff + sampling_frequency at col 0 in two TSVs', () => {
  // Cover the remaining two `>= 0` guards (iHigh, iFs).
  const tsv1 = 'high_cutoff\tname\n70\tFp1';
  assert.equal(BIDSRecording.parseChannelsTsv(tsv1)[0].high_cutoff, 70,
    'high_cutoff at col 0 must be parsed');

  const tsv2 = 'sampling_frequency\tname\n512\tFp1';
  assert.equal(BIDSRecording.parseChannelsTsv(tsv2)[0].sampling_frequency, 512,
    'sampling_frequency at col 0 must be parsed');
});

test('iter9 parseEventsTsv: duration at col 0 (iDur=0) — kills `iDur >= 0` → `iDur > 0`', () => {
  // Header `duration, onset`. iOnset=1, iDur=0. Under mutant, duration
  // would fall to 0 instead of 0.75.
  const tsv = 'duration\tonset\n0.75\t2.0';
  const events = BIDSRecording.parseEventsTsv(tsv);
  assert.equal(events.length, 1);
  assert.equal(events[0].onset, 2.0, 'onset still parsed (col 1)');
  assert.equal(events[0].duration, 0.75,
    'duration at col 0 must be parsed; mutant would default to 0');
});

test('iter9 parseEventsTsv: trial_type at col 0 (iLabel=0) — kills `iLabel >= 0` → `iLabel > 0`', () => {
  // Header `trial_type, onset`. iOnset=1, iLabel=0. Under mutant, label
  // would be null.
  const tsv = 'trial_type\tonset\nStim\t1.0';
  const events = BIDSRecording.parseEventsTsv(tsv);
  assert.equal(events[0].label, 'Stim',
    'trial_type at col 0 must be picked up; mutant would yield null');
});

test('iter9 parseEventsTsv: sample at col 0 (iSample=0) — kills `iSample >= 0` → `iSample > 0`', () => {
  const tsv = 'sample\tonset\n512\t2.0';
  const events = BIDSRecording.parseEventsTsv(tsv);
  assert.equal(events[0].sample, 512,
    'sample at col 0 must be parsed; mutant would yield null');
});

test('iter9 parseEventsTsv: value at col 0 (iLabel=0 via value-fallback)', () => {
  // No trial_type, value at col 0. Tests the iLabel fallback chain plus
  // the boundary on idx('value').
  const tsv = 'value\tonset\nresponse\t1.0';
  const events = BIDSRecording.parseEventsTsv(tsv);
  assert.equal(events[0].label, 'response',
    'value-as-iLabel at col 0 must be picked up');
});

// ---- TSV plumbing: whitespace vs tab separator -----

test('iter9 parseTsv: header without tab uses whitespace split (kills sep ternary mutant)', () => {
  // `const sep = lines[0].includes('\t') ? /\t/ : /\s+/;`  The "false"
  // branch (whitespace fallback) is documented for ds002336 but no
  // existing test confirms it parses correctly. Mutant flipping to
  // always-tab would treat the multi-space line as ONE cell.
  const tsv = 'name type\nFp1 EEG\nFp2 EEG';   // space-separated, no tabs
  const channels = BIDSRecording.parseChannelsTsv(tsv);
  assert.equal(channels.length, 2, 'whitespace fallback should give 2 channels');
  assert.equal(channels[0].name, 'Fp1');
  assert.equal(channels[0].type, 'EEG');
  assert.equal(channels[1].name, 'Fp2');
  assert.equal(channels[1].type, 'EEG');
});

test('iter9 parseTsv: comment lines (#) are dropped before sep detection', () => {
  // `lines.filter(l => l.length > 0 && !l.startsWith('#'))`. Mutant
  // changing the filter would either keep the # line (parse error) or
  // drop the header (different parse error).
  const tsv = '# this is a comment\nname\tunits\nFp1\tuV';
  const channels = BIDSRecording.parseChannelsTsv(tsv);
  assert.equal(channels.length, 1);
  assert.equal(channels[0].name, 'Fp1');
  assert.equal(channels[0].units, 'uV');
});

test('iter9 parseTsv: stripQuotes handles single and double quotes', () => {
  // `stripQuotes` is module-private but tested via the parsers.
  // Mutant `s.length >= 2` → `s.length > 2` would fail to strip 2-char
  // tokens like `""`; mutant on the q-character set would miss `'` or `"`.
  // Below: single-quoted Fp1, double-quoted Fp2.
  const tsv = "name\tunits\n'Fp1'\t'uV'\n\"Fp2\"\t\"uV\"";
  const channels = BIDSRecording.parseChannelsTsv(tsv);
  assert.equal(channels.length, 2);
  assert.equal(channels[0].name, 'Fp1', 'single quotes stripped');
  assert.equal(channels[0].units, 'uV');
  assert.equal(channels[1].name, 'Fp2', 'double quotes stripped');
  assert.equal(channels[1].units, 'uV');
});

// ============================================================
// End iteration 9 additions
// ============================================================

// ─── resolveTargets URL protocol validation (SAST P2 fix) ────────

test('resolveTargets: rejects data: URL in ?eeg= param', () => {
  const params = new URLSearchParams('eeg=data:text/plain;base64,SGVsbG8=');
  assert.throws(
    () => BIDSRecording.resolveTargets(params),
    /Invalid URL protocol/,
  );
});

test('resolveTargets: rejects file: URL in ?eeg= param', () => {
  const params = new URLSearchParams('eeg=file:///etc/passwd');
  assert.throws(
    () => BIDSRecording.resolveTargets(params),
    /Invalid URL protocol/,
  );
});

test('resolveTargets: rejects javascript: URL in ?eeg= param', () => {
  const params = new URLSearchParams('eeg=javascript:alert(1)');
  assert.throws(
    () => BIDSRecording.resolveTargets(params),
    /Invalid URL protocol/,
  );
});

test('resolveTargets: rejects blob: URL in ?eeg= param', () => {
  const params = new URLSearchParams('eeg=blob:https://example.com/abc-123');
  assert.throws(
    () => BIDSRecording.resolveTargets(params),
    /Invalid URL protocol/,
  );
});

test('resolveTargets: accepts https URL in ?eeg= param', () => {
  const params = new URLSearchParams('eeg=https://s3.amazonaws.com/openneuro.org/ds002034/sub-01/eeg/sub-01_eeg.edf');
  const t = BIDSRecording.resolveTargets(params);
  assert.equal(t.kind, 'url');
});

test('resolveTargets: accepts http URL (dev/localhost) in ?eeg= param', () => {
  const params = new URLSearchParams('eeg=http://localhost:8011/sub-01_eeg.edf');
  const t = BIDSRecording.resolveTargets(params);
  assert.equal(t.kind, 'url');
});

test('resolveTargets: rejects malformed URL gracefully', () => {
  const params = new URLSearchParams('eeg=not-a-url');
  assert.throws(
    () => BIDSRecording.resolveTargets(params),
    /Invalid URL protocol/,
  );
});

test('resolveTargets: protocol check applies to ?ieeg=, ?emg=, ?meg=, ?nirs= too', () => {
  for (const suffix of ['ieeg', 'emg', 'meg', 'nirs']) {
    const params = new URLSearchParams(`${suffix}=data:text/plain,evil`);
    assert.throws(
      () => BIDSRecording.resolveTargets(params),
      /Invalid URL protocol/,
      `${suffix} param must also be protocol-validated`,
    );
  }
});
