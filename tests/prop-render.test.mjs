// tests/prop-render.test.mjs
//
// Property-based tests for TraceRenderer.draw() geometry invariants.
// Each property must hold for any valid input regardless of channel
// count, sample count, gain, window size.
//
// Pairs with the example-based tests in unit-traces-*.test.mjs:
// examples pin specific edge cases; properties sweep the continuous
// input space looking for unanticipated failures.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { fc } from './_arbitraries.mjs';
import { makeRecordingCanvas } from './_render-invariants.mjs';

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
globalThis.ResizeObserver = globalThis.ResizeObserver || class {
  observe() {} unobserve() {} disconnect() {}
};
globalThis.window.devicePixelRatio = 1;
const TraceRenderer = require('../traces.js');

const validChannelCount = fc.integer({ min: 1, max: 64 });
const validSampleCount = fc.integer({ min: 2, max: 5000 });
const validGain = fc.float({ min: Math.fround(0.1), max: Math.fround(10), noNaN: true });
const validFs = fc.constantFrom(100, 250, 500, 1000, 2000);

function buildChannels(nCh, nSamp) {
  const out = [];
  for (let c = 0; c < nCh; c++) {
    const d = new Float32Array(nSamp);
    for (let i = 0; i < nSamp; i++) d[i] = Math.sin(i * 0.1 + c) * (10 + c);
    out.push(d);
  }
  return out;
}

test('property: every draw produces at least 1 polyline lineTo per visible channel', () => {
  fc.assert(
    fc.property(validChannelCount, validSampleCount, validGain, validFs,
      (nCh, nSamp, gain, fs) => {
        const channels = buildChannels(nCh, nSamp);
        const { canvas, calls } = makeRecordingCanvas(800, 600);
        TraceRenderer.draw(canvas, {
          channels,
          channel_labels: channels.map((_, i) => `Ch${i+1}`),
          channel_types: channels.map(() => 'EEG'),
          n_samples_visible: nSamp,
          fs,
          start_sec: 0,
          gain,
          transparent: false,
        });
        const lineToCount = calls.filter(c => c.op === 'lineTo').length;
        const maxVisible = TraceRenderer.lastMaxVisibleChannels || nCh;
        const visibleCh = Math.min(maxVisible, nCh);
        return lineToCount >= visibleCh;
      }),
    { numRuns: 100 },
  );
});

test('property: lastSlotMicrovolts is finite and positive on any draw', () => {
  fc.assert(
    fc.property(validChannelCount, validSampleCount, validGain,
      (nCh, nSamp, gain) => {
        const channels = buildChannels(nCh, nSamp);
        const { canvas } = makeRecordingCanvas(800, 600);
        TraceRenderer.draw(canvas, {
          channels,
          channel_labels: channels.map((_, i) => `Ch${i+1}`),
          channel_types: channels.map(() => 'EEG'),
          n_samples_visible: nSamp,
          fs: 250,
          start_sec: 0,
          gain,
          transparent: false,
        });
        return isFinite(TraceRenderer.lastSlotMicrovolts) &&
               TraceRenderer.lastSlotMicrovolts > 0;
      }),
    { numRuns: 100 },
  );
});

test('property: lastTotalChannels equals input nCh, lastChannelOffset clamped', () => {
  fc.assert(
    fc.property(validChannelCount, fc.integer({ min: 0, max: 1000 }),
      (nCh, offsetRaw) => {
        const channels = buildChannels(nCh, 200);
        const { canvas } = makeRecordingCanvas(800, 600);
        TraceRenderer.draw(canvas, {
          channels,
          channel_labels: channels.map((_, i) => `Ch${i+1}`),
          channel_types: channels.map(() => 'EEG'),
          channel_offset: offsetRaw,
          n_samples_visible: 200,
          fs: 250,
          start_sec: 0,
          gain: 1,
          transparent: false,
        });
        if (TraceRenderer.lastTotalChannels !== nCh) return false;
        if (TraceRenderer.lastChannelOffset < 0) return false;
        if (TraceRenderer.lastChannelOffset > Math.max(0, nCh - 1)) return false;
        return true;
      }),
    { numRuns: 100 },
  );
});

test('property: partial_fill polyline X-bounds stay within (samples_visible/total) * plotW', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 500, max: 5000 }),
      fc.float({ min: Math.fround(0.05), max: Math.fround(0.95), noNaN: true }),
      (total, ratio) => {
        const partial = Math.max(2, Math.floor(total * ratio));
        const fullCh = buildChannels(1, total)[0];
        const partialCh = fullCh.subarray(0, partial);
        const { canvas, calls } = makeRecordingCanvas(800, 600);
        TraceRenderer.draw(canvas, {
          channels: [partialCh],
          channel_labels: ['Ch1'],
          channel_types: ['EEG'],
          n_samples_visible: partial,
          fs: 250,
          start_sec: 0,
          gain: 1,
          transparent: false,
          partial_fill: { sample_start: 0, sample_end: partial - 1, total_samples: total },
        });
        const plotX0 = TraceRenderer.PAD_LEFT;
        const plotW = 800 - TraceRenderer.PAD_RIGHT - TraceRenderer.PAD_LEFT;
        const PAD_TOP = TraceRenderer.PAD_TOP;
        const PAD_BOTTOM = TraceRenderer.PAD_BOTTOM;
        const plotX1 = 800 - TraceRenderer.PAD_RIGHT;
        const plotY1 = 600 - PAD_BOTTOM;
        // Filter to polyline-only lineTos: inside the plot box on both axes.
        // Axis baselines/ticks sit at y > plotY1 (below the plot area), and
        // the scale-bar sits at x > plotX1 (right of the plot area).
        const polylineXs = calls
          .filter(c => c.op === 'lineTo'
            && c.args[0] >= plotX0 && c.args[0] <= plotX1
            && c.args[1] >= PAD_TOP && c.args[1] <= plotY1)
          .map(c => c.args[0]);
        if (polylineXs.length === 0) return true;
        const expectedMax = plotX0 + (partial / total) * plotW;
        const actualMax = Math.max(...polylineXs);
        return actualMax <= expectedMax + 4;
      }),
    { numRuns: 100 },
  );
});

test('property: events outside [t0, t1] never produce a fillText', () => {
  fc.assert(
    fc.property(
      fc.float({ min: 0, max: 100, noNaN: true }),
      fc.float({ min: 0.5, max: 30, noNaN: true }),
      (start, duration) => {
        const channels = buildChannels(2, 500);
        const fs = 250;
        const events = [
          { onset: start - 5, label: 'past1' },
          { onset: start - 1, label: 'past2' },
          { onset: start + duration + 0.1, label: 'fut1' },
          { onset: start + duration + 10, label: 'fut2' },
          { onset: start + duration * 100, label: 'fut3' },
        ];
        const { canvas, calls } = makeRecordingCanvas(800, 600);
        TraceRenderer.draw(canvas, {
          channels,
          channel_labels: channels.map((_, i) => `Ch${i+1}`),
          channel_types: channels.map(() => 'EEG'),
          n_samples_visible: Math.floor(duration * fs),
          fs,
          start_sec: start,
          gain: 1,
          transparent: false,
          events,
        });
        for (const ev of events) {
          if (calls.some(c => c.op === 'fillText' && c.args[0] === ev.label)) return false;
        }
        return true;
      }),
    { numRuns: 100 },
  );
});
