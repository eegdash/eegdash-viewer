// Unit tests for the F09 EDF+ TAL annotation parser.
//
// Test 1: hand-coded TAL byte string → 3 expected events.
// Test 2: load the checked-in fixture edfplus-with-annotations.edf via
//         EDFReader.open(), verify annotation_events.length === 3 and
//         labels match the fixture's embedded annotations.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ---- Bootstrap globals (same order as _bootstrap.mjs) ----------------
require('../bids-loader.js');
require('../formats/_buffers.js');

// Patch HttpRange so the test can read local files without a network.
// The production HttpRange lives at formats/_http_range.js; we shadow
// globalThis.HttpRange before loading formats/_sidecar.js and edf.js
// so those modules pick up our file-backed implementation.
function makeFileHttpRange(filePath) {
  const data = readFileSync(filePath);
  return {
    rangeFetch: async (_url, start, end, _expected) => {
      const slice = data.slice(start, end + 1);
      return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    },
    probeLength: async (_url) => data.length,
    fetchTextOrNull: async (_url) => null,
    registerLocal: () => {},
    clearLocal: () => {},
  };
}

// Load _sidecar first (it registers SidecarChecks on globalThis).
// We need to provide HttpRange on globalThis BEFORE loading _sidecar,
// because _sidecar.js reads HttpRange.fetchTextOrNull at module init time.
const fixturePath = join(__dir, '..', 'test-data', 'edfplus-with-annotations.edf');
globalThis.HttpRange = makeFileHttpRange(fixturePath);

require('../formats/_sidecar.js');
const EDFReader = require('../formats/edf.js');

// ---- Test 1: synthetic TAL byte string → event array -----------------

test('parseTAL: hand-coded TAL bytes produce expected events', () => {
  // Build a TAL byte sequence by hand:
  //   +0.5\x14Stimulus\x14\x00
  //   +1.5\x14Page change\x14\x00
  //   +3.0\x14Eye blink\x14\x00
  // The encoder uses 0x14 = U+0014 (information separator four).
  const SEP = '\x14';
  const END = '\x00';
  const raw =
    `+0.5${SEP}Stimulus${SEP}${END}` +
    `+1.5${SEP}Page change${SEP}${END}` +
    `+3.0${SEP}Eye blink${SEP}${END}`;

  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 0xff;

  const events = EDFReader.parseTAL(bytes);

  assert.equal(events.length, 3, `expected 3 events, got ${events.length}`);

  assert.equal(events[0].onset, 0.5);
  assert.equal(events[0].label, 'Stimulus');

  assert.equal(events[1].onset, 1.5);
  assert.equal(events[1].label, 'Page change');

  assert.equal(events[2].onset, 3.0);
  assert.equal(events[2].label, 'Eye blink');
});

// ---- Test 2: load fixture via EDFReader.open() -----------------------

test('EDFReader.open: annotation_events from edfplus-with-annotations.edf', async () => {
  // Re-install the file-backed HttpRange for the fixture (it was already
  // installed above but we reinforce it here for clarity).
  globalThis.HttpRange = makeFileHttpRange(fixturePath);

  const meta = {
    eeg_url: 'localdrop.invalid/edfplus-with-annotations.edf',
    eeg_json: { sampling_frequency: 100 },
    channels: null,
  };

  const reader = await EDFReader.open(meta);

  // The fixture has 1 EEG channel + 1 annotation channel.
  // Only the EEG channel counts as a display channel.
  assert.equal(reader.n_channels, 1, `n_channels should be 1 (annotation excluded), got ${reader.n_channels}`);

  // The fixture embeds exactly 3 annotations.
  assert.ok(Array.isArray(reader.annotation_events), 'annotation_events should be an array');
  assert.equal(reader.annotation_events.length, 3,
    `expected 3 annotation events, got ${reader.annotation_events.length}`);

  // Check labels (sorted by onset).
  const labels = reader.annotation_events.map(e => e.label);
  assert.ok(labels.includes('Stimulus'),    `missing "Stimulus" in ${labels}`);
  assert.ok(labels.includes('Page change'), `missing "Page change" in ${labels}`);
  assert.ok(labels.includes('Eye blink'),   `missing "Eye blink" in ${labels}`);

  // Check onsets match spec.
  const onsets = reader.annotation_events.map(e => e.onset);
  assert.ok(Math.abs(onsets[0] - 0.5) < 0.001, `onset[0] should be ~0.5, got ${onsets[0]}`);
  assert.ok(Math.abs(onsets[1] - 1.5) < 0.001, `onset[1] should be ~1.5, got ${onsets[1]}`);
  assert.ok(Math.abs(onsets[2] - 3.0) < 0.001, `onset[2] should be ~3.0, got ${onsets[2]}`);
});
