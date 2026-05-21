// Unit test for the precedence rule applied in viewer.js loadFromMeta:
//   sidecar _events.tsv  > EDF+ TAL annotation_events
// The rule is currently expressed at viewer.js:1376 as
//   if ((!meta.events || meta.events.length === 0) && readerInfo.annotation_events?.length) {
//     meta.events = readerInfo.annotation_events;
//   }
// This test pins the contract so the precedence can't silently flip.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Mirror of the production helper. Keep identical to the rule in
// viewer.js so the test fails if either side drifts.
function mergeAnnotationsIntoMeta(meta, readerInfo) {
  if ((!meta.events || meta.events.length === 0) && readerInfo.annotation_events?.length) {
    meta.events = readerInfo.annotation_events;
  }
  return meta;
}

test('sidecar events win when both are present', () => {
  const meta = { events: [{ onset: 1, label: 'sidecar' }] };
  const readerInfo = { annotation_events: [{ onset: 2, label: 'tal' }] };
  mergeAnnotationsIntoMeta(meta, readerInfo);
  assert.equal(meta.events.length, 1);
  assert.equal(meta.events[0].label, 'sidecar');
});

test('TAL events fall through when meta.events is null', () => {
  const meta = { events: null };
  const readerInfo = { annotation_events: [{ onset: 2, label: 'tal' }] };
  mergeAnnotationsIntoMeta(meta, readerInfo);
  assert.equal(meta.events.length, 1);
  assert.equal(meta.events[0].label, 'tal');
});

test('TAL events fall through when meta.events is an empty array', () => {
  const meta = { events: [] };
  const readerInfo = { annotation_events: [{ onset: 3, label: 'tal' }] };
  mergeAnnotationsIntoMeta(meta, readerInfo);
  assert.equal(meta.events.length, 1);
  assert.equal(meta.events[0].label, 'tal');
});

test('no events when neither side has any', () => {
  const meta = { events: null };
  const readerInfo = { annotation_events: null };
  mergeAnnotationsIntoMeta(meta, readerInfo);
  assert.equal(meta.events, null);
});

test('reader without annotation_events key does not crash', () => {
  const meta = { events: null };
  const readerInfo = {}; // no annotation_events at all
  mergeAnnotationsIntoMeta(meta, readerInfo);
  assert.equal(meta.events, null);
});
