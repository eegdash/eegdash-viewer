// tests/unit-viewer-api.test.mjs
//
// Direct tests against window.Viewer.* exported helpers. Each helper
// is a pure function or DOM-touching function; we exercise it through
// the public api surface so Stryker mutations are observable.
//
// Pairs with tests/unit-viewer-jsdom.test.mjs (already covers
// clampStart + module-load smoke). This file covers the other 10
// exports.

import './_jsdom-bootstrap.mjs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../formats/_buffers.js');
require('../formats/_http_range.js');
require('../formats/_streaming.js');
require('../formats/_sidecar.js');
require('../formats/_matv5.js');
require('../bids-recording.js');
require('../formats/eeglab.js');
require('../formats/edf.js');
require('../formats/brainvision.js');
require('../formats/fiff.js');
require('../traces.js');
require('../filters.js');
require('../viewer.js');

const V = globalThis.window.Viewer;

// ─── el / setChildren ────────────────────────────────────────────
// NOTE: el(tag, cls, text) creates a NEW element (it does NOT look
// up an element by id — that's $(id) internally). The task spec
// confused el with $; tests adjusted to the real contract.

test('viewer.el: creates a new element with the given tag', () => {
  const e = V.el('div');
  assert.equal(e.tagName, 'DIV');
  assert.equal(e.className, '');
  assert.equal(e.textContent, '');
});

test('viewer.el: applies className when provided', () => {
  const e = V.el('span', 'prov-key');
  assert.equal(e.tagName, 'SPAN');
  assert.equal(e.className, 'prov-key');
});

test('viewer.el: applies text content when provided', () => {
  const e = V.el('code', null, 'hello');
  assert.equal(e.tagName, 'CODE');
  assert.equal(e.textContent, 'hello');
});

test('viewer.setChildren: replaces children with the provided nodes (variadic)', () => {
  const host = globalThis.document.createElement('div');
  const a = globalThis.document.createElement('span');
  const b = globalThis.document.createElement('span');
  a.textContent = 'A';
  b.textContent = 'B';
  V.setChildren(host, a, b);
  assert.equal(host.children.length, 2);
  assert.equal(host.children[0].textContent, 'A');
  assert.equal(host.children[1].textContent, 'B');
});

test('viewer.setChildren: filters out falsy nodes', () => {
  const host = globalThis.document.createElement('div');
  host.appendChild(globalThis.document.createElement('span'));
  const a = globalThis.document.createElement('p');
  a.textContent = 'kept';
  V.setChildren(host, a, null, undefined, false);
  assert.equal(host.children.length, 1);
  assert.equal(host.children[0].textContent, 'kept');
});

test('viewer.setChildren: no nodes clears the host', () => {
  const host = globalThis.document.createElement('div');
  host.appendChild(globalThis.document.createElement('span'));
  V.setChildren(host);
  assert.equal(host.children.length, 0);
});

// ─── deriveChannelLabels ─────────────────────────────────────────
// Real contract: deriveChannelLabels(reader, metaChannels).
// Priority: reader.channel_labels → metaChannels names → Ch{i+1}.

test('viewer.deriveChannelLabels: uses reader.channel_labels when present', () => {
  const reader = { channel_labels: ['Cz', 'Pz'], n_channels: 2 };
  const metaChannels = [{ name: 'IGNORED' }];
  const out = V.deriveChannelLabels(reader, metaChannels);
  assert.deepEqual(out, ['Cz', 'Pz']);
});

test('viewer.deriveChannelLabels: falls back to metaChannels names when reader lacks labels', () => {
  const reader = { channel_labels: null, n_channels: 2 };
  const metaChannels = [{ name: 'Fp1' }, { name: 'Fp2' }];
  const out = V.deriveChannelLabels(reader, metaChannels);
  assert.deepEqual(out, ['Fp1', 'Fp2']);
});

test('viewer.deriveChannelLabels: synthesizes Ch{i+1} when no labels anywhere', () => {
  const reader = { channel_labels: null, n_channels: 3 };
  const out = V.deriveChannelLabels(reader, null);
  assert.deepEqual(out, ['Ch1', 'Ch2', 'Ch3']);
});

// ─── deriveBadMask ───────────────────────────────────────────────
// Real contract: deriveBadMask(metaChannels, nChannels) — pads with
// `false` up to nChannels.

test('viewer.deriveBadMask: marks channels whose status === "bad"', () => {
  const channels = [
    { name: 'Fp1' },
    { name: 'Fp2', status: 'bad' },
    { name: 'Cz' },
  ];
  const mask = V.deriveBadMask(channels, 3);
  assert.deepEqual(mask, [false, true, false]);
});

test('viewer.deriveBadMask: pads with false up to nChannels', () => {
  const channels = [{ name: 'Fp1', status: 'bad' }];
  const mask = V.deriveBadMask(channels, 4);
  assert.deepEqual(mask, [true, false, false, false]);
});

test('viewer.deriveBadMask: null channels → all false, length nChannels', () => {
  const mask = V.deriveBadMask(null, 3);
  assert.deepEqual(mask, [false, false, false]);
});

// ─── pickDefaultWindowSec ────────────────────────────────────────
// Real contract: byte-budget driven over preset list [2,5,10,20,30].
// Largest preset whose (n_ch × Hz × bps × preset) ≤ 1.5 MiB wins.

test('viewer.pickDefaultWindowSec: low-Hz cheap recording picks max preset (30s)', () => {
  const reader = { n_channels: 36, sampling_frequency: 250, bytes_per_sample: 4 };
  assert.equal(V.pickDefaultWindowSec(reader), 30);
});

test('viewer.pickDefaultWindowSec: dense 5 kHz × 64 ch picks 2s', () => {
  const reader = { n_channels: 64, sampling_frequency: 5000, bytes_per_sample: 2 };
  assert.equal(V.pickDefaultWindowSec(reader), 2);
});

test('viewer.pickDefaultWindowSec: invalid byte rate falls back to 10s', () => {
  // n_channels = 0 → bytesPerSec = 0 → not > 0 → safe default 10.
  const reader = { n_channels: 0, sampling_frequency: 250, bytes_per_sample: 4 };
  assert.equal(V.pickDefaultWindowSec(reader), 10);
});

// ─── [#D2] budget boundary + invalid-bytesPerSec branches ───────
// Pins the predicate `WINDOW_PRESETS_SEC[i] * bytesPerSec <= WINDOW_BYTE_BUDGET`
// (viewer.js:251) at the just-passes / just-fails boundary, AND the
// `!Number.isFinite(bytesPerSec) || bytesPerSec <= 0` guard at viewer.js:246.
//
// WINDOW_BYTE_BUDGET = 1.5 * 1024 * 1024 = 1572864 bytes.
// WINDOW_PRESETS_SEC = [2, 5, 10, 20, 30].

test('viewer.pickDefaultWindowSec: budget just-passes preset 5 (kills `<=` → `<` only when integer-exact) [#D2]', () => {
  // bytesPerSec = 314572 (just below budget/5 = 314572.8). Preset 5
  // passes: 5 * 314572 = 1572860 ≤ 1572864. Preset 10 fails:
  // 10 * 314572 = 3145720 > 1572864. So pickDefaultWindowSec must
  // return 5. A mutant flipping the predicate (e.g. `<=` → `>`, or
  // the loop direction) would land on a different preset.
  const reader = { n_channels: 1, sampling_frequency: 78643, bytes_per_sample: 4 };
  // n_ch × fs × bps = 1 × 78643 × 4 = 314572.
  assert.equal(V.pickDefaultWindowSec(reader), 5);
});

test('viewer.pickDefaultWindowSec: budget just-fails preset 5 → falls to 2 [#D2]', () => {
  // bytesPerSec = 314573 (just above budget/5). Preset 5: 5 * 314573 =
  // 1572865 > 1572864 → fails. Preset 2: 2 * 314573 = 629146 ≤ budget
  // → passes. The loop must select 2. This is the symmetric kill of
  // the just-passes case above.
  const reader = { n_channels: 1, sampling_frequency: 78643.25, bytes_per_sample: 4 };
  // 1 × 78643.25 × 4 = 314573. 5 * 314573 = 1572865 > 1572864.
  assert.equal(V.pickDefaultWindowSec(reader), 2);
});

test('viewer.pickDefaultWindowSec: negative n_channels → bytesPerSec ≤ 0 → 10s default [#D2]', () => {
  // Kills the `bytesPerSec <= 0` half of the guard at viewer.js:246.
  // n_ch = -1 → bytesPerSec = -1000 → must short-circuit to 10s.
  const reader = { n_channels: -1, sampling_frequency: 250, bytes_per_sample: 4 };
  assert.equal(V.pickDefaultWindowSec(reader), 10);
});

test('viewer.pickDefaultWindowSec: NaN n_channels → !isFinite branch → 10s default [#D2]', () => {
  // Kills the `!Number.isFinite(bytesPerSec)` half of the guard. NaN
  // propagates through arithmetic; isFinite(NaN) is false.
  const reader = { n_channels: NaN, sampling_frequency: 250, bytes_per_sample: 4 };
  assert.equal(V.pickDefaultWindowSec(reader), 10);
});

// ─── [#D2] clampStart null-duration branch + end-of-recording boundary
// Pins both halves of `if (durationSec == null) return 0;` at viewer.js:212
// AND the off-by-one boundary at `max = durationSec - windowSec` (line 213).
// The existing tests in unit-viewer-jsdom.test.mjs cover the happy-path
// clamp but NOT the null/undefined branch or the exact end-of-recording
// equality.

test('viewer.clampStart: null durationSec → always 0 regardless of seconds [#D2]', () => {
  // The guard `if (durationSec == null) return 0;` short-circuits on
  // BOTH null and undefined (`==` loose equality). A mutant flipping
  // `==` to `===` would slip undefined through and try to compute
  // `undefined - windowSec = NaN`.
  assert.equal(V.clampStart(42, null, 10), 0);
  assert.equal(V.clampStart(-99, null, 10), 0);
  assert.equal(V.clampStart(0, undefined, 10), 0);
  assert.equal(V.clampStart(1e9, null, 10), 0);
});

test('viewer.clampStart: end-of-recording boundary at max = durationSec - windowSec [#D2]', () => {
  // For durationSec=100, windowSec=10 → max = 90.
  // Mutants on the subtraction (`-` → `+`, sign flip) or the Math.min
  // direction all change the boundary.
  assert.equal(V.clampStart(90, 100, 10), 90,
    'at the exact max, must return max (90)');
  assert.equal(V.clampStart(90.0001, 100, 10), 90,
    'just past max → clamp to max');
  assert.equal(V.clampStart(89.9999, 100, 10), 89.9999,
    'just below max → return input');
  // Past-end with very large seconds still clamps to max.
  assert.equal(V.clampStart(1e6, 100, 10), 90);
  // Negative input clamps to 0 (lower bound via Math.max(0, ...)).
  assert.equal(V.clampStart(-5, 100, 10), 0);
});

// ─── renderProvenance ────────────────────────────────────────────
// Real contract: iterates meta.sidecar_sources entries. Each truthy
// value gets one row with key + stripped URL. Empty → 'no sidecars
// resolved' message.

test('viewer.renderProvenance: lists each resolved sidecar key + stripped path', () => {
  const meta = {
    sidecar_sources: {
      channels: 'https://example.com/path/sub-01_channels.tsv',
      events: 'https://example.com/path/sub-01_events.tsv',
    },
  };
  const host = globalThis.document.createElement('div');
  V.renderProvenance(meta, host);
  const text = host.textContent;
  assert.ok(text.includes('channels'), 'must include channels key');
  assert.ok(text.includes('events'), 'must include events key');
  assert.ok(text.includes('path/sub-01_channels.tsv'), 'must strip the origin');
  assert.ok(!text.includes('example.com'), 'origin should be stripped');
  // Two rows = two children
  assert.equal(host.children.length, 2);
});

test('viewer.renderProvenance: empty sidecar_sources → "no sidecars resolved" placeholder', () => {
  const host = globalThis.document.createElement('div');
  V.renderProvenance({ sidecar_sources: {} }, host);
  assert.equal(host.children.length, 1);
  assert.ok(host.textContent.includes('no sidecars resolved'));
});

test('viewer.renderProvenance: ignores falsy sidecar entries', () => {
  const meta = {
    sidecar_sources: {
      channels: 'https://x.com/c.tsv',
      events: null,
      electrodes: undefined,
      coordsystem: '',
    },
  };
  const host = globalThis.document.createElement('div');
  V.renderProvenance(meta, host);
  // Only `channels` is truthy.
  assert.equal(host.children.length, 1);
  assert.ok(host.textContent.includes('channels'));
  assert.ok(!host.textContent.includes('events'));
});

// ─── renderChannels ──────────────────────────────────────────────
// Real contract: null channels → muted placeholder + count '?'.
// Otherwise count = String(length), rows = one div per channel,
// 'is-bad' class + bad-dot when status === 'bad'.

test('viewer.renderChannels: lists 3 channels into the host + writes count', () => {
  const channels = [{ name: 'Fp1' }, { name: 'Fp2' }, { name: 'Cz' }];
  const list = globalThis.document.createElement('ul');
  const count = globalThis.document.createElement('span');
  V.renderChannels(channels, list, count);
  assert.equal(list.children.length, 3);
  assert.equal(count.textContent, '3');
});

test('viewer.renderChannels: empty array → 0 rows, count "0"', () => {
  const list = globalThis.document.createElement('ul');
  const count = globalThis.document.createElement('span');
  V.renderChannels([], list, count);
  assert.equal(list.children.length, 0);
  assert.equal(count.textContent, '0');
});

test('viewer.renderChannels: null channels → muted placeholder + count "?"', () => {
  const list = globalThis.document.createElement('ul');
  const count = globalThis.document.createElement('span');
  V.renderChannels(null, list, count);
  assert.equal(list.children.length, 1);
  assert.equal(count.textContent, '?');
  assert.ok(list.children[0].className.includes('muted'));
});

test('viewer.renderChannels: bad channels get the is-bad row class', () => {
  const channels = [
    { name: 'Fp1' },
    { name: 'Fp2', status: 'bad' },
  ];
  const list = globalThis.document.createElement('div');
  const count = globalThis.document.createElement('span');
  V.renderChannels(channels, list, count);
  assert.ok(!list.children[0].className.includes('is-bad'));
  assert.ok(list.children[1].className.includes('is-bad'));
});

// ─── renderEvents ────────────────────────────────────────────────
// Real contract: events is treated as a non-null array; count =
// String(length); empty → muted placeholder; otherwise rows.

test('viewer.renderEvents: lists events + writes count', () => {
  const events = [{ onset: 1.0, label: 'A' }, { onset: 2.5, label: 'B' }];
  const list = globalThis.document.createElement('ul');
  const count = globalThis.document.createElement('span');
  V.renderEvents(events, list, count);
  assert.equal(list.children.length, 2);
  assert.equal(count.textContent, '2');
});

test('viewer.renderEvents: empty events → "no events" placeholder, count "0"', () => {
  const list = globalThis.document.createElement('ul');
  const count = globalThis.document.createElement('span');
  V.renderEvents([], list, count);
  assert.equal(count.textContent, '0');
  assert.equal(list.children.length, 1);
  assert.ok(list.textContent.includes('no events'));
});

test('viewer.renderEvents: caps at 50 rows when given more', () => {
  const events = Array.from({ length: 75 }, (_, i) => ({ onset: i * 0.1, label: 'evt' + i }));
  const list = globalThis.document.createElement('div');
  const count = globalThis.document.createElement('span');
  V.renderEvents(events, list, count);
  // Count uses full length; rendered rows cap at 50.
  assert.equal(count.textContent, '75');
  assert.equal(list.children.length, 50);
});

// ─── updateElectrodeLink ─────────────────────────────────────────
// Real contract: reads meta.sidecar_sources.electrodes. If present,
// builds an electrode-explorer link with the tsv (+ optional coords)
// query param and clears `hidden`. Otherwise sets hidden=true.

test('viewer.updateElectrodeLink: shows link when electrodes sidecar is resolved', () => {
  const meta = {
    sidecar_sources: { electrodes: 'https://example.com/sub-01_electrodes.tsv' },
  };
  const link = globalThis.document.createElement('a');
  link.hidden = true;
  V.updateElectrodeLink(meta, link);
  assert.equal(link.hidden, false);
  assert.ok(link.href.includes('electrodes.eegdash.org'),
    'href must point to the electrode explorer');
  assert.ok(decodeURIComponent(link.href).includes('sub-01_electrodes.tsv'),
    'href must include the electrodes tsv as a query param');
});

test('viewer.updateElectrodeLink: appends coords param when coordsystem is present', () => {
  const meta = {
    sidecar_sources: {
      electrodes: 'https://example.com/elec.tsv',
      coordsystem: 'https://example.com/coords.json',
    },
  };
  const link = globalThis.document.createElement('a');
  V.updateElectrodeLink(meta, link);
  const decoded = decodeURIComponent(link.href);
  assert.ok(decoded.includes('coords='), 'coords param must be set');
  assert.ok(decoded.includes('coords.json'));
});

test('viewer.updateElectrodeLink: hides link when no electrodes sidecar', () => {
  const meta = { sidecar_sources: {} };
  const link = globalThis.document.createElement('a');
  link.hidden = false;
  V.updateElectrodeLink(meta, link);
  assert.equal(link.hidden, true);
});

// ─── renderStageCaption ──────────────────────────────────────────
// Real contract: reads reader.{n_channels, sampling_frequency,
// duration_s} and meta.ext; emits "{n} ch · {Hz} Hz · {dur} s ·
// {EXT}" and clears hidden.

test('viewer.renderStageCaption: includes channel count, sampling rate, duration, ext', () => {
  const meta = { ext: 'edf' };
  const reader = { n_channels: 32, duration_s: 60, sampling_frequency: 250 };
  const caption = globalThis.document.createElement('div');
  caption.hidden = true;
  V.renderStageCaption(meta, reader, caption);
  const text = caption.textContent;
  assert.ok(text.includes('32 ch'), `must include channel count, got: ${text}`);
  assert.ok(text.includes('250 Hz'), `must include sampling rate, got: ${text}`);
  assert.ok(text.includes('60.0 s'), `must include duration, got: ${text}`);
  assert.ok(text.includes('EDF'), `must include uppercased extension, got: ${text}`);
  assert.equal(caption.hidden, false);
});
