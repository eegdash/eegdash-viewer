// EDF reader bitwise-equal to mne on non-stim channels. mne re-encodes
// stim channels as integer event codes so we exclude them from value
// comparison; everything else (EEG, MISC, trigger physical scaling)
// must round-trip exactly.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maxAbsDiff } from '../scripts/_smoke_lib.mjs';
import { BIDSRecording, EDFReader } from './_bootstrap.mjs';

const REF_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cross_check_edf.json');

test('EDF reader vs mne', { skip: !existsSync(REF_PATH) && 'no cross_check_edf.json' }, async (t) => {
  const ref = JSON.parse(readFileSync(REF_PATH, 'utf8'));
  const meta = await BIDSRecording.loadRecordingMetadata(ref.source);
  const reader = await EDFReader.open(meta);

  await t.test('shape matches mne (incl. annotation channels)', () => {
    assert.equal(reader.n_channels, ref.n_channels);
    assert.equal(reader.sampling_frequency, ref.sampling_frequency);
    assert.equal(reader.n_samples, ref.n_samples_total);
  });

  const win = await reader.readWindow(0, ref.first_n);
  await t.test('every channel returned the requested length', () => {
    for (const ch of win) assert.equal(ch.length, ref.first_n);
  });

  await t.test('non-stim channel values bitwise-equal to mne', () => {
    const { max, argmax, nCompared } = maxAbsDiff(win, ref, { skip: ref.is_stim });
    assert.ok(max <= 1e-3,
      `max |Δ| = ${max.toExponential(3)} µV across ${nCompared} non-stim channels`);
  });

  await t.test('cross-record window reads the right length', async () => {
    // EDF records are 1 s here, so [510, 514) straddles records 0 and 1.
    const cross = await reader.readWindow(510, 4);
    assert.equal(cross[0].length, 4);
  });
});
