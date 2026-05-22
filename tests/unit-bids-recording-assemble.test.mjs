// Unit tests for assembleRecordingMetadata — the internal helper in
// bids-recording.js that converts {text,url} hit objects into the
// viewer's metadata bundle.
//
// Strategy: loadRecordingMetadata drives fetchInheritedSidecar, which
// walks 4 inheritance levels. The `fetchTextOrNull` function it uses
// is the one captured from HttpRange at module load time — it's not
// patchable after the fact. Instead, we:
//
//   1. Use a BIDS-structured localdrop URL so all candidate paths are
//      localdrop.invalid/* and the local-blob branch handles them.
//   2. Register sidecar blobs at the ROOT-level paths the walker probes
//      at inheritance level 3 (https://localdrop.invalid/<filename>),
//      which HttpRange.registerLocal can create directly.
//   3. Any path the walker probes that is NOT registered → null (the
//      local-blob branch returns null for unregistered localdrop URLs).
//
// EEG URL: https://localdrop.invalid/ds000/sub-01/eeg/sub-01_task-rest_eeg.set
// The walker generates level-3 root paths:
//   https://localdrop.invalid/sub-01_task-rest_eeg.json  (most specific)
//   https://localdrop.invalid/sub-01_eeg.json
//   https://localdrop.invalid/task-rest_eeg.json
//   https://localdrop.invalid/eeg.json
// We register at the most specific: sub-01_task-rest_eeg.json.
import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { BIDSRecording, HttpRange } from './_bootstrap.mjs';

beforeEach(() => HttpRange.clearLocal());

// EEG URL: 3-level hierarchy under localdrop.invalid so all inheritance
// candidates stay within the localdrop.invalid domain.
const EEG_URL = 'https://localdrop.invalid/ds000/sub-01/eeg/sub-01_task-rest_eeg.set';
const PREFIX  = 'sub-01_task-rest';

// The first (most-specific) candidate path at the root level (level 3)
// that the inheritance walker will probe. Registering here means all
// 4 levels get null at first, then the root level finds it.
function regSidecar(suffix, text) {
  // registerLocal('sub-01_task-rest_eeg.json', blob)
  // → url = https://localdrop.invalid/sub-01_task-rest_eeg.json
  // which matches what the walker generates at level 3.
  const filename = `${PREFIX}${suffix}`;
  const blob = new Blob([text], { type: 'text/plain' });
  return HttpRange.registerLocal(filename, blob);
}

const VALID_EEG_JSON = JSON.stringify({ SamplingFrequency: 256 });
const VALID_CHANNELS_TSV = 'name\ttype\tunits\nFp1\tEEG\tuV\nFp2\tEEG\tuV\n';
const VALID_EVENTS_TSV   = 'onset\tduration\ttrial_type\n1.0\t0.5\tStimulus\n';

// ----- test 1: all 5 hits null → stub with sampling_frequency=null --

test('assembleRecordingMetadata: all sidecars null → sampling_frequency=null stub, no throw', async () => {
  // No sidecars registered — all return null.
  const meta = await BIDSRecording.loadRecordingMetadata(EEG_URL);
  assert.equal(meta.eeg_json.sampling_frequency, null,
    'stub should have null sampling_frequency when _eeg.json is absent');
  assert.equal(meta.channels, null, 'channels should be null when _channels.tsv absent');
  assert.deepEqual(meta.events, [], 'events should be empty array when _events.tsv absent');
  assert.equal(meta.electrodes, null);
  assert.equal(meta.coordsystem, null);
});

// ----- test 2: only eeg_json present → channels/events/electrodes null --

test('assembleRecordingMetadata: only _eeg.json hit → channels/events/electrodes null', async () => {
  regSidecar('_eeg.json', VALID_EEG_JSON);
  // No _channels.tsv, _events.tsv, _electrodes.tsv, _coordsystem.json.
  const meta = await BIDSRecording.loadRecordingMetadata(EEG_URL);
  assert.equal(meta.eeg_json.sampling_frequency, 256,
    'sampling_frequency should come from the registered _eeg.json');
  assert.equal(meta.channels, null);
  assert.deepEqual(meta.events, []);
  assert.equal(meta.electrodes, null);
  assert.equal(meta.coordsystem, null);
});

// ----- test 3: bad JSON in eeg_json hit → throws Bad _eeg.json --

test('assembleRecordingMetadata: malformed _eeg.json throws with URL in message', async () => {
  regSidecar('_eeg.json', '{not valid json}');
  await assert.rejects(
    () => BIDSRecording.loadRecordingMetadata(EEG_URL),
    (err) => {
      assert.match(err.message, /Bad _eeg\.json at/);
      return true;
    }
  );
});

// ----- test 4: _eeg.json with invalid SamplingFrequency → lenient (warn) --

test('assembleRecordingMetadata: _eeg.json with non-positive SamplingFrequency now warns (lenient)', async () => {
  // Behavior change: invalid sidecar SamplingFrequency was previously
  // fatal. Now we warn and pass null sampling_frequency to the reader,
  // which derives sfreq from the file itself. Unblocks ds006466 where
  // the sidecar value is `null` but the .set has EEG.srate=1000.
  regSidecar('_eeg.json', JSON.stringify({ SamplingFrequency: -1 }));
  const origWarn = console.warn;
  let warned = '';
  console.warn = (m) => { warned = m; };
  try {
    const meta = await BIDSRecording.loadRecordingMetadata(EEG_URL);
    assert.equal(meta.eeg_json.sampling_frequency, null);
    assert.match(warned, /invalid/);
  } finally {
    console.warn = origWarn;
  }
});

// ----- test 5: electrodes hit but BIDSLoader not loaded → silently skip --

test('assembleRecordingMetadata: electrodes hit but BIDSLoader absent → electrodes:null', async () => {
  regSidecar('_eeg.json', VALID_EEG_JSON);
  // Minimal valid TSV (≥4 electrodes required by BIDSLoader)
  const eTsv = 'name\tx\ty\tz\nFp1\t0\t0\t1\nFp2\t0\t0\t2\nCz\t0\t0\t3\nPz\t0\t0\t4\n';
  regSidecar('_electrodes.tsv', eTsv);

  // Temporarily hide BIDSLoader so the guard
  // `if (electrodesHit && typeof BIDSLoader !== 'undefined')` is false.
  const savedLoader = globalThis.BIDSLoader;
  globalThis.BIDSLoader = undefined;
  try {
    const meta = await BIDSRecording.loadRecordingMetadata(EEG_URL);
    assert.equal(meta.electrodes, null,
      'electrodes should be null when BIDSLoader is unavailable');
    assert.equal(meta.eeg_json.sampling_frequency, 256,
      'eeg_json should still be parsed normally');
  } finally {
    globalThis.BIDSLoader = savedLoader;
  }
});

// ----- test 5b: electrodes present + BIDSLoader IS loaded → electrodes parsed --

test('assembleRecordingMetadata: electrodes hit + BIDSLoader present → electrodes non-null', async () => {
  // BIDSLoader is loaded via _bootstrap.mjs. Verify that when it IS available
  // and an electrodes.tsv is registered, the electrodes field is populated.
  regSidecar('_eeg.json', VALID_EEG_JSON);
  // BIDSLoader.parseElectrodesTSV requires ≥4 electrodes with finite x,y,z.
  const electrodesTsv = [
    'name\tx\ty\tz',
    'Fp1\t0.1\t0.2\t0.3',
    'Fp2\t0.4\t0.5\t0.6',
    'Cz\t0.0\t0.7\t0.8',
    'Pz\t0.0\t-0.5\t0.7',
  ].join('\n') + '\n';
  regSidecar('_electrodes.tsv', electrodesTsv);

  const meta = await BIDSRecording.loadRecordingMetadata(EEG_URL);
  // If BIDSLoader.parseElectrodesTSV is called, we get an array; if not, null.
  // This specifically catches the mutation that removes the BIDSLoader guard
  // (which causes the uncaught TypeError → swallowed → electrodes stays null).
  assert.notEqual(meta.electrodes, null,
    'electrodes should be parsed when BIDSLoader is present and electrodes.tsv is registered');
  assert.ok(Array.isArray(meta.electrodes) || typeof meta.electrodes === 'object',
    'electrodes should be an array or object from BIDSLoader.parseElectrodesTSV');
});

// ----- test 6: sidecar_sources mirrors hit URLs --

test('assembleRecordingMetadata: sidecar_sources records hit URLs for found sidecars', async () => {
  regSidecar('_eeg.json', VALID_EEG_JSON);
  regSidecar('_channels.tsv', VALID_CHANNELS_TSV);
  // events / electrodes / coordsystem deliberately absent

  const meta = await BIDSRecording.loadRecordingMetadata(EEG_URL);
  assert.ok(meta.sidecar_sources.eeg_json,
    'eeg_json source should be a non-null URL string');
  assert.ok(meta.sidecar_sources.channels,
    'channels source should be a non-null URL string');
  assert.equal(meta.sidecar_sources.events, null,
    'events source should be null (not registered)');
  assert.equal(meta.sidecar_sources.electrodes, null);
  assert.equal(meta.sidecar_sources.coordsystem, null);
});

// ----- test 7: channels + events both present → parsed correctly --

test('assembleRecordingMetadata: channels + events both present → parsed arrays', async () => {
  regSidecar('_eeg.json', VALID_EEG_JSON);
  regSidecar('_channels.tsv', VALID_CHANNELS_TSV);
  regSidecar('_events.tsv', VALID_EVENTS_TSV);

  const meta = await BIDSRecording.loadRecordingMetadata(EEG_URL);
  assert.ok(Array.isArray(meta.channels) && meta.channels.length === 2,
    'should have 2 channels from _channels.tsv');
  assert.ok(Array.isArray(meta.events) && meta.events.length === 1,
    'should have 1 event from _events.tsv');
  assert.equal(meta.events[0].onset, 1.0);
  assert.equal(meta.events[0].label, 'Stimulus');
  assert.equal(meta.eeg_json.sampling_frequency, 256);
});
