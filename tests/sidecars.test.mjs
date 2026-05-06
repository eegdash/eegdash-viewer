// BIDS sidecar resolution across formats. Uses Node's built-in
// test runner (node --test) so we get TAP output, parallel tests,
// watch mode, and structured assertions for free.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BIDSRecording } from './_bootstrap.mjs';

// Each case is one OpenNeuro recording across the format space.
// `expect` lists which sidecars MUST resolve; everything else is
// allowed to be absent without failing the test.
const CASES = [
  {
    name: 'EEGLAB ds002893 (run-level sidecars)',
    url: 'https://s3.amazonaws.com/openneuro.org/ds002893/sub-001/eeg/sub-001_task-AuditoryVisualShift_run-01_eeg.set',
    expect: { ext: 'set', fs: 250, n_channels: 36, has_events: true, has_electrodes: true },
  },
  {
    name: 'EEGLAB ds003478 (run-level sidecars)',
    url: 'https://s3.amazonaws.com/openneuro.org/ds003478/sub-001/eeg/sub-001_task-Rest_run-01_eeg.set',
    expect: { ext: 'set', fs: 500, n_channels: 66, has_events: true },
  },
  {
    name: 'EDF ds002034 (run-level sidecars)',
    url: 'https://s3.amazonaws.com/openneuro.org/ds002034/sub-01/ses-01/eeg/sub-01_ses-01_task-offline_run-01_eeg.edf',
    expect: { ext: 'edf', fs: 512, n_channels: 81, has_events: true },
  },
  {
    name: 'BrainVision ds002336 (dataset-root inheritance)',
    url: 'https://s3.amazonaws.com/openneuro.org/ds002336/sub-xp101/eeg/sub-xp101_task-eegfmriNF_eeg.vhdr',
    expect: { ext: 'vhdr', fs: 5000, n_channels: 64, has_events: true },
  },
];

for (const c of CASES) {
  test(c.name, async (t) => {
    const meta = await BIDSRecording.loadRecordingMetadata(c.url);
    await t.test('ext matches', () => assert.equal(meta.ext, c.expect.ext));
    if (c.expect.fs != null) {
      await t.test('SamplingFrequency from _eeg.json',
        () => assert.equal(meta.eeg_json.sampling_frequency, c.expect.fs));
    }
    if (c.expect.n_channels != null) {
      await t.test(`channels.tsv has ${c.expect.n_channels} rows`,
        () => assert.equal(meta.channels?.length, c.expect.n_channels));
    }
    if (c.expect.has_events) {
      await t.test('events.tsv has rows',
        () => assert.ok(meta.events.length > 0, `events: ${meta.events.length}`));
    }
    if (c.expect.has_electrodes) {
      await t.test('electrodes.tsv resolves',
        () => assert.ok(meta.electrodes && meta.electrodes.length > 0));
    }
  });
}
