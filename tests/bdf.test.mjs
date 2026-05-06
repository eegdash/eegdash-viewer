// BDF (24-bit BioSemi) reader bitwise-equal to mne. The shared
// EDF reader handles BDF too, but the int24 sign-extension path
// is format-specific and not exercised by smoke-edf.mjs (which
// uses an int16 EDF). This test is what would catch a mistake
// like dropping the arithmetic-shift in `((packed << 8) >> 8)`.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maxAbsDiff } from '../scripts/_smoke_lib.mjs';
import { BIDSRecording, EDFReader } from './_bootstrap.mjs';

const REF_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cross_check_bdf.json');

test('BDF reader vs mne (24-bit sign-extension path)', { skip: !existsSync(REF_PATH) && 'no cross_check_bdf.json' }, async (t) => {
  const ref = JSON.parse(readFileSync(REF_PATH, 'utf8'));
  const meta = await BIDSRecording.loadRecordingMetadata(ref.source);
  const reader = await EDFReader.open(meta);

  await t.test('opened as BDF (3-byte samples)',
    () => assert.equal(reader.bytes_per_sample, 3));
  await t.test('shape matches mne', () => {
    assert.equal(reader.n_channels, ref.n_channels);
    assert.equal(reader.sampling_frequency, ref.sampling_frequency);
    assert.equal(reader.n_samples, ref.n_samples_total);
  });

  const win = await reader.readWindow(0, ref.first_n);
  await t.test('voltage values bitwise-equal to mne (the int24 path)', () => {
    // ref.skip flags stim AND non-voltage channels (GSR, Temp, …)
    // — those have their own native units and aren't comparable
    // through the volts↔µV scaling axis.
    const { max, argmax, nCompared } = maxAbsDiff(win, ref, { skip: ref.skip });
    assert.ok(max <= 1e-3,
      `max |Δ| = ${max.toExponential(3)} µV across ${nCompared} voltage channels` +
      (max > 1e-3 ? ` @ ${ref.channel_names[argmax.ch]}[${argmax.s}]` : ''));
  });

  // Pull a window across a small offset to verify the record-stitching
  // path works for BDF too. (1s records means sample 254 is near the
  // first record's end; 4 samples there crosses into record 2 if fs >= 256.)
  await t.test('cross-record window reads the right length', async () => {
    const cross = await reader.readWindow(254, 4);
    assert.equal(cross[0].length, 4);
  });
});
