// Drag-drop landed in Phase 7 with a synthetic-URL local-Blob
// registry: drop a File → register against `localdrop.invalid/<name>`
// → every reader hits HttpRange.{probeLength,rangeFetch,fetchText}
// the same way it hits OpenNeuro, with an early-out branch that
// slices the in-memory Blob instead of going to the network.
import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { HttpRange } from './_bootstrap.mjs';
import { rampBlob } from './_fixtures.mjs';

beforeEach(() => HttpRange.clearLocal());

test('local-Blob: registerLocal returns a localdrop.invalid URL', () => {
  const url = HttpRange.registerLocal('sub-01_eeg.set', rampBlob(16));
  assert.match(url, /^https:\/\/localdrop\.invalid\/sub-01_eeg\.set$/);
});

test('local-Blob: probeLength returns Blob.size without network', async () => {
  const url = HttpRange.registerLocal('sample.fdt', rampBlob(12345));
  assert.equal(await HttpRange.probeLength(url), 12345);
});

test('local-Blob: rangeFetch slices match the source bytes', async () => {
  const url = HttpRange.registerLocal('sample.fdt', rampBlob(1024));
  const buf = await HttpRange.rangeFetch(url, 10, 19, 10);
  const view = new Uint8Array(buf);
  assert.equal(view.length, 10);
  for (let i = 0; i < 10; i++) {
    assert.equal(view[i], (10 + i) & 0xff);
  }
});

test('local-Blob: zero-length range short-circuits', async () => {
  const url = HttpRange.registerLocal('sample.fdt', rampBlob(100));
  const buf = await HttpRange.rangeFetch(url, 0, -1, 0);
  assert.equal(buf.byteLength, 0);
});

test('local-Blob: fetchText returns the Blob content as text', async () => {
  const text = '{"SamplingFrequency": 250}';
  const url = HttpRange.registerLocal('sample_eeg.json', new Blob([text]));
  assert.equal(await HttpRange.fetchText(url), text);
});

test('local-Blob: fetchTextOrNull returns null for unregistered URLs', async () => {
  const url = 'https://localdrop.invalid/nope.json';
  assert.equal(await HttpRange.fetchTextOrNull(url), null);
});

test('local-Blob: fetchText throws for unregistered URLs', async () => {
  await assert.rejects(
    () => HttpRange.fetchText('https://localdrop.invalid/nope.json'),
    /Local drop missing/);
});

test('local-Blob: rangeFetch with a pre-aborted signal throws AbortError', async () => {
  const url = HttpRange.registerLocal('sample.fdt', rampBlob(100));
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    () => HttpRange.rangeFetch(url, 0, 9, 10, { signal: ctrl.signal }),
    (e) => e.name === 'AbortError');
});

test('local-Blob: clearLocal evicts every entry', async () => {
  const url = HttpRange.registerLocal('sample.fdt', rampBlob(100));
  assert.equal(await HttpRange.probeLength(url), 100);
  HttpRange.clearLocal();
  await assert.rejects(
    () => HttpRange.probeLength(url),
    /Local drop missing/);
});

test('local-Blob: re-registering same filename overwrites', async () => {
  const url1 = HttpRange.registerLocal('sample.fdt', rampBlob(100));
  HttpRange.registerLocal('sample.fdt', rampBlob(200));
  assert.equal(await HttpRange.probeLength(url1), 200);
});

test('local-Blob: filenames with spaces / unicode get URL-encoded', () => {
  const url = HttpRange.registerLocal('sub 01_eeg.set', rampBlob(1));
  // Encoded so URL parsers don't choke; the registry maps the encoded URL.
  assert.match(url, /sub%2001_eeg\.set$/);
});

test('local-Blob: localEntries lists registered files by original name', () => {
  HttpRange.registerLocal('sub-01_ses-02_task-a_emg.bdf', rampBlob(8));
  HttpRange.registerLocal('sub-01_ses-02_task-a_channels.tsv', rampBlob(4));
  const entries = HttpRange.localEntries();
  assert.deepEqual(entries.map(e => e.name), ['sub-01_ses-02_task-a_emg.bdf', 'sub-01_ses-02_task-a_channels.tsv']);
  assert.equal(entries[0].blob.size, 8);
});

test('local-Blob: a missing entry reads as an HTTP 404 so optional siblings fall back', async () => {
  // eeglab.js probes `<prefix>_eeg.fdt` and only tolerates /HTTP 404/; an
  // inline-data .set handed over the bridge has no .fdt to register.
  await assert.rejects(HttpRange.probeLength('https://localdrop.invalid/x_eeg.fdt'), /HTTP 404.*Local drop missing/);
  await assert.rejects(HttpRange.rangeFetch('https://localdrop.invalid/x_eeg.fdt', 0, 1, 2), /HTTP 404/);
});
