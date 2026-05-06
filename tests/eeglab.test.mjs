// EEGLAB .fdt reader bitwise-equal to mne. Cross-check JSON is
// produced by `python scripts/cross_check_eeglab.py`; the test
// is skipped if the reference is missing so the suite still runs
// in environments without mne installed.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maxAbsDiff } from '../scripts/_smoke_lib.mjs';
import { BIDSRecording, EEGLABReader } from './_bootstrap.mjs';

const REF_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cross_check_eeglab.json');

test('EEGLAB .fdt reader vs mne', { skip: !existsSync(REF_PATH) && 'no cross_check_eeglab.json' }, async (t) => {
  const ref = JSON.parse(readFileSync(REF_PATH, 'utf8'));
  const meta = await BIDSRecording.loadRecordingMetadata(ref.source);
  const reader = await EEGLABReader.open(meta);

  await t.test('shape matches mne', () => {
    assert.equal(reader.n_channels, ref.n_channels);
    assert.equal(reader.sampling_frequency, ref.sampling_frequency);
    assert.equal(reader.n_samples, ref.n_samples_total);
  });

  const win = await reader.readWindow(0, ref.first_n);
  await t.test('every channel returned the requested length', () => {
    for (const ch of win) assert.equal(ch.length, ref.first_n);
  });

  await t.test('values bitwise-equal to mne', () => {
    const { max, argmax } = maxAbsDiff(win, ref);
    assert.ok(max <= 1e-3,
      `max |Δ| = ${max.toExponential(3)} µV at ${ref.channel_names[argmax.ch]}[${argmax.s}]`);
  });

  await t.test('disjoint windows differ', async () => {
    const win2 = await reader.readWindow(1000, 100);
    const differs = win.some((ch, c) => ch.some((v, s) => v !== win2[c][s]));
    assert.ok(differs);
  });
});
