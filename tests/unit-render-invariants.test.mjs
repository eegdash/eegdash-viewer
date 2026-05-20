// tests/unit-render-invariants.test.mjs
//
// Systematic detection of the CLASS of rendering bug we've hit twice:
// alpha-compound paint on streaming chunks. Uses the generic invariants
// in tests/_render-invariants.mjs against the real renderer.
//
// Each test:
//   1. Simulates the streaming pattern — N partial_fill chunks of a
//      single window.
//   2. Records every ctx op into a single shared call log.
//   3. Runs the alpha-compound / partial-subset / band-locality
//      invariants against the log.
//   4. Asserts zero violations.
//
// Adding a new rendering primitive to traces.js with a semi-transparent
// color must come with either (a) a band-locality check in the
// primitive's draw fn (like drawEventMarkers' clearedBand) or (b) an
// entry in the SKIP_PRIMITIVES list below documenting why it's safe.
// Otherwise the existing tests fail.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import {
  makeRecordingCanvas,
  findAlphaCompounds,
  findRepeatedOutsideBand,
  assertNoAlphaCompound,
} from './_render-invariants.mjs';

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
globalThis.ResizeObserver = globalThis.ResizeObserver || class {
  observe() {} unobserve() {} disconnect() {}
};
globalThis.window.devicePixelRatio = 1;
const TraceRenderer = require('../traces.js');

function buildChannel(n) {
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = Math.sin(i * 0.1) * 30 + ((i * 7) % 13) * 0.3;
  return d;
}

function buildOptsStreaming(channels, opts = {}) {
  return {
    channels,
    channel_labels: channels.map((_, i) => `Ch${i + 1}`),
    channel_types: channels.map(() => 'EEG'),
    n_samples_visible: channels[0].length,
    fs: 250,
    start_sec: 0,
    gain: 1,
    transparent: false,
    ...opts,
  };
}

// ─── Test 1: 10-chunk stream with NO events — no alpha-compounds ───

test('invariant: 10-chunk stream with no events produces zero alpha compounds', () => {
  const total = 2000;
  const fullCh = buildChannel(total);
  const { canvas, calls } = makeRecordingCanvas(800, 600);

  for (let k = 0; k < 10; k++) {
    const visible = (k + 1) * 200;
    TraceRenderer.draw(canvas, buildOptsStreaming([fullCh.subarray(0, visible)], {
      n_samples_visible: visible,
      partial_fill: {
        sample_start: k * 200,
        sample_end: visible - 1,
        total_samples: total,
        full_clear: k === 0,
      },
    }));
  }
  assertNoAlphaCompound(calls, 'streaming 10 chunks with no events');
});

// ─── Test 2: 10-chunk stream WITH events — no alpha-compounds ───
// (regression for the bug fixed in commit 4ebac6e)

test('invariant: 10-chunk stream WITH events produces zero alpha compounds', () => {
  const total = 2000;
  const fullCh = buildChannel(total);
  const events = [
    { onset: 0.5, label: 'A' },
    { onset: 2.0, label: 'B' },
    { onset: 4.0, label: 'C' },
    { onset: 6.0, label: 'D' },
    { onset: 7.5, label: 'E' },
  ];
  const { canvas, calls } = makeRecordingCanvas(800, 600);

  for (let k = 0; k < 10; k++) {
    const visible = (k + 1) * 200;
    TraceRenderer.draw(canvas, buildOptsStreaming([fullCh.subarray(0, visible)], {
      events,
      n_samples_visible: visible,
      partial_fill: {
        sample_start: k * 200,
        sample_end: visible - 1,
        total_samples: total,
        full_clear: k === 0,
      },
    }));
  }
  // Locks the event-ghost fix: no event label/line should appear at
  // identical (text, x, y, color) more than once across 10 chunks.
  assertNoAlphaCompound(calls,
    'streaming 10 chunks WITH events (regression for ghost-trace bug)');
});

// ─── Test 3: high-density events (20+) over 5 chunks — no compounds ───

test('invariant: 5-chunk stream with 20 events still produces zero alpha compounds', () => {
  const total = 1000;
  const fullCh = buildChannel(total);
  const events = Array.from({ length: 20 }, (_, i) => ({
    onset: 0.2 * (i + 1),       // 0.2, 0.4, ..., 4.0 s
    label: `Ev${i + 1}`,
  }));
  const { canvas, calls } = makeRecordingCanvas(800, 600);

  for (let k = 0; k < 5; k++) {
    const visible = (k + 1) * 200;
    TraceRenderer.draw(canvas, buildOptsStreaming([fullCh.subarray(0, visible)], {
      events,
      n_samples_visible: visible,
      partial_fill: {
        sample_start: k * 200,
        sample_end: visible - 1,
        total_samples: total,
        full_clear: k === 0,
      },
    }));
  }
  assertNoAlphaCompound(calls, 'high-density events × 5 chunks');
});

// ─── Test 4: repeat non-streaming draw 5× — no alpha compounds ───

test('invariant: 5 successive full draws (no partial_fill) produce zero alpha compounds', () => {
  // The non-streaming path (cache hit, filter active, no worker) does a
  // full clear every draw. Successive draws at the same window are
  // SAFE because each draw() is a separate render cycle and the
  // canvas was cleared between them.
  //
  // The detector is per-cycle: it splits the call log on `setTransform`
  // (every draw() emits one) and checks for compounds WITHIN each
  // cycle only. Across cycles, the renderer's own clears handle the
  // reset and the detector ignores cross-cycle repeats by design.
  const events = [{ onset: 0.1, label: 'A' }, { onset: 0.3, label: 'B' }];
  const ch = buildChannel(500);
  const { canvas, calls } = makeRecordingCanvas(800, 600);
  for (let k = 0; k < 5; k++) {
    TraceRenderer.draw(canvas, buildOptsStreaming([ch], { events }));
  }
  assertNoAlphaCompound(calls, 'cross-cycle repeats must NOT trigger detector');
});

// ─── Test 5: per-cycle detector (single chunk) — clean ───

test('invariant: a SINGLE full draw with events produces zero alpha compounds', () => {
  // The lossless check: one render cycle, even with many events, must
  // never compound at the same pixel.
  const events = Array.from({ length: 30 }, (_, i) => ({
    onset: 0.1 * (i + 1),
    label: `e${i}`,
  }));
  const ch = buildChannel(800);
  const { canvas, calls } = makeRecordingCanvas(800, 600);
  TraceRenderer.draw(canvas, buildOptsStreaming([ch], { events, fs: 100 }));
  assertNoAlphaCompound(calls, '30 events in a single draw');
});

// ─── Test 6: outside-band repeats locality check ───

test('invariant: partial_fill repeats limited to the cleared band', () => {
  // For a partial_fill that clears band [40%, 60%] of plotW, any paint
  // outside [band - slack, band + slack] should NOT be drawn more than
  // once across multiple chunks at the same window. Catches "renderer
  // forgot to filter — drew outside the band" regression.
  const total = 1000;
  const fullCh = buildChannel(total);
  const events = [
    { onset: 0.5, label: 'far-left' },
    { onset: 2.0, label: 'mid' },
    { onset: 3.5, label: 'far-right' },
  ];
  const { canvas, calls } = makeRecordingCanvas(800, 600);

  // Chunk 1 (full_clear) draws everything; chunk 2 (band clear) should
  // only redraw events inside the band.
  TraceRenderer.draw(canvas, buildOptsStreaming([fullCh.subarray(0, 400)], {
    events,
    n_samples_visible: 400,
    partial_fill: { sample_start: 0, sample_end: 399, total_samples: total, full_clear: true },
  }));
  TraceRenderer.draw(canvas, buildOptsStreaming([fullCh.subarray(0, 600)], {
    events,
    n_samples_visible: 600,
    partial_fill: { sample_start: 400, sample_end: 599, total_samples: total },
  }));

  // Band from sample 400..599 of total=1000 → 40%..60% of plotW.
  // plotW = 800 - 96 - 70 = 634. Band x ≈ [96+253.6, 96+380.4] = [349.6, 480.4]
  const band = { xStart: 349.6, xEnd: 480.4 };
  const violations = findRepeatedOutsideBand(calls, band, /*slack=*/100);
  assert.equal(violations.length, 0,
    `partial_fill paints outside band:\n${JSON.stringify(violations, null, 2)}`);
});

// ─── Test 7: meta-test for the detector itself ───

test('invariant: detector catches a synthesized alpha-compound', () => {
  // Sanity: if we feed the detector a known-bad log (two identical
  // fillTexts at the same coord with rgba<1 alpha), it must flag.
  const calls = [
    { op: 'set:fillStyle', args: ['rgba(0,0,0,0.3)'], state: {} },
    { op: 'fillText', args: ['X', 100, 50], state: { fillStyle: 'rgba(0,0,0,0.3)' } },
    { op: 'fillText', args: ['X', 100, 50], state: { fillStyle: 'rgba(0,0,0,0.3)' } },
  ];
  const v = findAlphaCompounds(calls);
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, 'fillText');
  assert.equal(v[0].count, 2);
});
