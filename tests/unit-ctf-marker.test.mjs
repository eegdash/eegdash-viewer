import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const CTFMarker = require('../formats/_ctf-marker.js');

test('ctf-marker: parses synth MarkerFile.mrk into 2 events', () => {
  const text = fs.readFileSync('tests/fixtures/meg/ctf-tiny.ds/MarkerFile.mrk', 'utf-8');
  const events = CTFMarker.parseMarkerFile(text);
  assert.ok(Array.isArray(events), 'parseMarkerFile must return array');
  assert.equal(events.length, 2, `expected 2 events, got ${events.length}`);
  assert.equal(events[0].label, 'Trigger1');
  assert.ok(Math.abs(events[0].onset - 0.5) < 0.0001);
  assert.ok(Math.abs(events[1].onset - 1.25) < 0.0001);
  // duration defaults to 0 for markers (point events).
  assert.equal(events[0].duration, 0);
});

test('ctf-marker: parseMarkerFile returns [] on empty / non-marker text', () => {
  assert.deepEqual(CTFMarker.parseMarkerFile(''), []);
  assert.deepEqual(CTFMarker.parseMarkerFile('garbage with no markers'), []);
});

test('ctf-marker: parses synth BadChannels into a list', () => {
  const text = fs.readFileSync('tests/fixtures/meg/ctf-tiny.ds/BadChannels', 'utf-8');
  const bad = CTFMarker.parseBadChannels(text);
  assert.deepEqual(bad, ['EEG001']);
});

test('ctf-marker: BadChannels ignores blanks and # comments', () => {
  const bad = CTFMarker.parseBadChannels('# header\nMLT11-1609\n\n#noise\nMLT12-1609\n');
  assert.deepEqual(bad, ['MLT11-1609', 'MLT12-1609']);
});
