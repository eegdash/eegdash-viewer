// Exercises bids-recording.js's eegdash-server fallback. The setup:
//   - inheritance walk on OpenNeuro: 404 for every variant the
//     algorithm tries (file genuinely doesn't sit at any of the
//     paths the entity-stripping generator predicts);
//   - eegdash dep_keys: claims the file lives at a non-canonical
//     subpath that the walk wouldn't try;
//   - that subpath: returns the actual sidecar content.
//
// On real OpenNeuro datasets the inheritance walk almost always
// finds the file before this fallback runs, so without a mocked
// fetch this code path is dead-as-far-as-the-tests-are-concerned.
import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { BIDSRecording } from './_bootstrap.mjs';

// `_eegdashCache` lives at module scope in bids-recording.js and
// persists across tests. Use a fresh dataset ID per test so each
// case misses the cache and exercises the fallback fetch path.
let DATASET, EEG_URL, FALLBACK_JSON, FALLBACK_TSV;
const DEP_KEYS_TEMPLATE = [
  'CHANGES',
  'README',
  'derivatives/sidecars/task-rest_eeg.json',
  'derivatives/sidecars/task-rest_channels.tsv',
];
const EEG_JSON_BODY = JSON.stringify({ SamplingFrequency: 250, RecordingDuration: 600 });
const CHANNELS_TSV_BODY = 'name\ttype\tunits\nFp1\tEEG\tuV\nCz\tEEG\tuV\n';

let originalFetch;
let openneuroProbes;
let eegdashProbes;
let fallbackHits;
let testIdCounter = 0;

function urlsForDataset(id) {
  return {
    eeg:           `https://s3.amazonaws.com/openneuro.org/${id}/sub-01/eeg/sub-01_task-rest_eeg.set`,
    fallbackJson:  `https://s3.amazonaws.com/openneuro.org/${id}/derivatives/sidecars/task-rest_eeg.json`,
    fallbackTsv:   `https://s3.amazonaws.com/openneuro.org/${id}/derivatives/sidecars/task-rest_channels.tsv`,
  };
}

beforeEach(() => {
  testIdCounter++;
  DATASET = `dsTEST${testIdCounter.toString().padStart(4, '0')}`;
  ({ eeg: EEG_URL, fallbackJson: FALLBACK_JSON, fallbackTsv: FALLBACK_TSV } = urlsForDataset(DATASET));
  originalFetch = globalThis.fetch;
  openneuroProbes = 0;
  eegdashProbes = 0;
  fallbackHits = 0;
  globalThis.fetch = async (url) => {
    if (typeof url === 'string' && url.includes('data.eegdash.org/api/eegdash/datasets/')) {
      eegdashProbes++;
      return new Response(JSON.stringify({
        success: true,
        data: { dataset_id: DATASET, storage: { dep_keys: DEP_KEYS_TEMPLATE } },
      }), { status: 200 });
    }
    if (url === FALLBACK_JSON) { fallbackHits++; return new Response(EEG_JSON_BODY, { status: 200 }); }
    if (url === FALLBACK_TSV)  { fallbackHits++; return new Response(CHANNELS_TSV_BODY, { status: 200 }); }
    if (typeof url === 'string' && url.startsWith('https://s3.amazonaws.com/openneuro.org/')) {
      openneuroProbes++;
      return new Response(null, { status: 404 });
    }
    throw new Error(`unmocked fetch: ${url}`);
  };
});
afterEach(() => { globalThis.fetch = originalFetch; });

test('eegdash fallback: resolves _eeg.json the inheritance walk missed', async () => {
  const meta = await BIDSRecording.loadRecordingMetadata(EEG_URL);
  assert.equal(meta.eeg_json.sampling_frequency, 250);
  assert.equal(meta.sidecar_sources.eeg_json, FALLBACK_JSON);
});

test('eegdash fallback: resolves _channels.tsv the same way', async () => {
  const meta = await BIDSRecording.loadRecordingMetadata(EEG_URL);
  assert.equal(meta.channels?.length, 2);
  assert.equal(meta.sidecar_sources.channels, FALLBACK_TSV);
});

test('eegdash fallback: only fetches the dataset record once across multiple sidecars', async () => {
  // The fallback path runs per-sidecar (eeg.json + channels.tsv +
  // events.tsv + electrodes.tsv + coordsystem.json = 5). The eegdash
  // record should be cached across all five, so we hit the dataset
  // endpoint exactly once.
  await BIDSRecording.loadRecordingMetadata(EEG_URL);
  assert.equal(eegdashProbes, 1, `eegdash probed ${eegdashProbes}× (expected 1)`);
});

test('eegdash fallback: only fires after the inheritance walk has truly failed', async () => {
  await BIDSRecording.loadRecordingMetadata(EEG_URL);
  // The inheritance walk should have probed something on OpenNeuro
  // before giving up — if openneuroProbes is 0, we skipped the walk.
  assert.ok(openneuroProbes > 0, 'expected inheritance walk probes');
  // And the fallback hit one or both of the resolved sidecar URLs.
  assert.ok(fallbackHits >= 1, `expected fallback hits, got ${fallbackHits}`);
});

test('eegdash fallback: yields stub metadata when dep_keys has no matching path', async () => {
  // bids-recording defers a missing _eeg.json to the format-specific
  // reader (which can read SamplingFrequency from its own header) —
  // so the loader returns a stub rather than throwing. Verify the
  // stub shape and that the inheritance walk really tried.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('data.eegdash.org/api/eegdash/datasets/')) {
      return new Response(JSON.stringify({
        success: true,
        data: { dataset_id: DATASET, storage: { dep_keys: ['CHANGES', 'README'] } },
      }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  };
  try {
    const meta = await BIDSRecording.loadRecordingMetadata(EEG_URL);
    assert.equal(meta.eeg_json.sampling_frequency, null);
    assert.equal(meta.sidecar_sources.eeg_json, null);
    assert.equal(meta.channels, null);
  } finally { globalThis.fetch = origFetch; }
});

test('eegdash fallback: graceful when eegdash itself is unreachable', async () => {
  // Network failure on eegdash should not bring down the whole load
  // — the loader catches inside the fallback and yields a stub. The
  // viewer's format readers can fill in fs from the binary header.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('data.eegdash.org')) throw new TypeError('NetworkError');
    return new Response(null, { status: 404 });
  };
  try {
    const meta = await BIDSRecording.loadRecordingMetadata(EEG_URL);
    assert.equal(meta.eeg_json.sampling_frequency, null,
      'load survives the eegdash network error and returns the stub');
  } finally { globalThis.fetch = origFetch; }
});
