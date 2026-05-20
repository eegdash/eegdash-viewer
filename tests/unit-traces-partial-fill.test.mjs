// unit-traces-partial-fill.test.mjs
//
// Streaming-render correctness tests for TraceRenderer.draw().
//
// Background: viewer.js streams a window in N progressive chunks (1C). The
// first chunk does a full clear+draw; subsequent chunks set opts.partial_fill
// = { sample_start, sample_end, total_samples } and call draw() again with
// the partial subarray. Only the x-band corresponding to the new samples is
// supposed to be repainted, leaving previously-painted regions intact.
//
// The bug this file pins down: the polyline drawer maps `nVisible` samples
// across the FULL plotW regardless of partial_fill. So during streaming the
// partial data is stretched to fill the whole plot — and on the next chunk a
// different-shape stretched polyline is drawn on top, with only a narrow band
// cleared. The result is "ghost traces" left over from earlier chunks. This
// is what shows up when the user scrolls fast: every fast pan triggers a
// streaming render, every chunk leaves a ghost line, the user perceives the
// canvas as smeared / corrupted.
//
// These tests assert the *intended* contract: when partial_fill is set, the
// polyline must only paint inside the x-band corresponding to the data we
// actually have, not the full plot width.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
globalThis.ResizeObserver = globalThis.ResizeObserver || class {
  observe() {} unobserve() {} disconnect() {}
};
globalThis.window.devicePixelRatio = 1;

const TraceRenderer = require('../traces.js');

// ── Stub canvas that records lineTo/moveTo X positions ──────────────────────
function makeTrackingCanvas(cssW = 800, cssH = 600) {
  const lineTos = [];
  const moveTos = [];
  const fillRects = [];
  const ctx = new Proxy({
    measureText(t) { return { width: t.length * 6 }; },
    beginPath() {},
    moveTo(x, y) { moveTos.push({ x, y }); },
    lineTo(x, y) { lineTos.push({ x, y }); },
    stroke() {},
    rect() {},
    clip() {},
    fillRect(x, y, w, h) { fillRects.push({ x, y, w, h }); },
    clearRect() {},
    fillText() {},
    setTransform() {},
    save() {},
    restore() {},
    setLineDash() {},
  }, {
    set(t, p, v) { t[p] = v; return true; },
    get(t, p) { return t[p]; },
  });
  return {
    canvas: {
      width: 0, height: 0,
      clientWidth: cssW, clientHeight: cssH,
      getContext() { return ctx; },
    },
    lineTos, moveTos, fillRects,
  };
}

function buildChannel(n) {
  const d = new Float32Array(n);
  // Modest sine + noise — meanStd returns a non-trivial std so vToPx is finite.
  for (let i = 0; i < n; i++) {
    d[i] = Math.sin(i * 0.1) * 30 + ((i * 7) % 13) * 0.3;
  }
  return d;
}

const PAD_LEFT  = TraceRenderer.PAD_LEFT;
const PAD_RIGHT = TraceRenderer.PAD_RIGHT;
const PAD_TOP   = TraceRenderer.PAD_TOP;
const PAD_BOTTOM = TraceRenderer.PAD_BOTTOM;

// Only X coords inside the plot band AND Y inside the plot band count as
// trace samples. Filtering by Y is required because the time-axis baseline
// (drawn at y = plotY0 + plotH + 4) also issues a lineTo(plotX1, y), which
// would otherwise show up as a spurious polyline endpoint at the right edge.
function tracePolylineX(lineTos, plotX0, plotX1, plotY0, plotY1) {
  return lineTos
    .filter(p =>
      p.x >= plotX0 - 1 && p.x <= plotX1 + 1 &&
      p.y >= plotY0 - 1 && p.y <= plotY1 + 1,
    )
    .map(p => p.x);
}

test('partial_fill: polyline X-range is bounded by the partial data ratio', async () => {
  // Set up: a window of 1000 samples; the streaming layer hands us only 250.
  // The remaining 750 samples (75% of plot width) must be left blank — the
  // polyline must NOT extend past plotX0 + (250/1000) * plotW.
  const total = 1000;
  const partial = 250;
  const fullCh = buildChannel(total);
  const partialCh = fullCh.subarray(0, partial);

  const cssW = 800, cssH = 600;
  const plotX0 = PAD_LEFT;
  const plotX1 = cssW - PAD_RIGHT;
  const plotW = plotX1 - plotX0;
  const expectedMaxX = plotX0 + (partial / total) * plotW;

  const { canvas, lineTos } = makeTrackingCanvas(cssW, cssH);
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

  const plotY0 = PAD_TOP;
  const plotY1 = cssH - PAD_BOTTOM;
  const xs = tracePolylineX(lineTos, plotX0, plotX1, plotY0, plotY1);
  assert.ok(xs.length > 0, 'expected polyline lineTo calls in plot band');

  const maxX = Math.max(...xs);
  // The bug: with current impl, maxX ≈ plotX1 (stretched across full plotW).
  // The contract: maxX should be ≈ plotX0 + (250/1000)*plotW ≈ 256.5.
  assert.ok(
    maxX <= expectedMaxX + 4,
    `partial_fill polyline must stay within sample range; expected maxX ≤ ${expectedMaxX.toFixed(1)}, got ${maxX.toFixed(1)}. ` +
    `Ghost-trace bug: partial data is being stretched across the full plot width.`,
  );
});

test('partial_fill: cleared band corresponds to the NEW samples only', async () => {
  // sample_start=500, sample_end=749 (the latest chunk added samples 500–749
  // of a 1000-sample window). The cleared band must cover [plotX0 + 0.5*plotW,
  // plotX0 + 0.75*plotW] — the band where the new samples live. The polyline
  // must reach at most plotX0 + (sample_end+1)/total * plotW.
  const total = 1000;
  const partial = 750; // we have samples 0..749
  const fullCh = buildChannel(total);
  const partialCh = fullCh.subarray(0, partial);

  const cssW = 800, cssH = 600;
  const plotX0 = PAD_LEFT;
  const plotW = (cssW - PAD_RIGHT) - PAD_LEFT;

  const { canvas, lineTos, fillRects } = makeTrackingCanvas(cssW, cssH);
  TraceRenderer.draw(canvas, {
    channels: [partialCh],
    channel_labels: ['Ch1'],
    channel_types: ['EEG'],
    n_samples_visible: partial,
    fs: 250,
    start_sec: 0,
    gain: 1,
    transparent: false,
    partial_fill: { sample_start: 500, sample_end: 749, total_samples: total },
  });

  // Band-clear assertion (current behaviour — kept to lock down behaviour we like).
  const expectedBandX0 = plotX0 + (500 / total) * plotW;
  const expectedBandX1 = plotX0 + (750 / total) * plotW;
  const bandClear = fillRects.find(r =>
    Math.abs(r.x - expectedBandX0) < 4 &&
    Math.abs((r.x + r.w) - expectedBandX1) < 4,
  );
  assert.ok(bandClear, `expected band fillRect near [${expectedBandX0.toFixed(0)}, ${expectedBandX1.toFixed(0)}]`);

  // Polyline reach assertion.
  const plotY0 = PAD_TOP;
  const plotY1 = cssH - PAD_BOTTOM;
  const xs = tracePolylineX(lineTos, plotX0, plotX0 + plotW, plotY0, plotY1);
  const maxX = Math.max(...xs);
  const limit = plotX0 + (partial / total) * plotW;
  assert.ok(
    maxX <= limit + 4,
    `polyline must end at the data front (${limit.toFixed(1)}), not the plot edge; got ${maxX.toFixed(1)}.`,
  );
});

test('partial_fill: tiny first chunk does NOT span full plot width', async () => {
  // Reproduces the worst-case visual of the ghost-trace bug: a first chunk
  // with just 5% of the data. Stretched across the full plotW, the polyline
  // becomes a smeared lookalike of the final shape that *stays painted*
  // (only the next chunk's narrow band gets cleared, not the rest). This
  // test pins the contract: even a 5% chunk paints only ~5% of the plot.
  const total = 2000;
  const partial = 100;
  const fullCh = buildChannel(total);
  const partialCh = fullCh.subarray(0, partial);

  const cssW = 800, cssH = 600;
  const plotX0 = PAD_LEFT;
  const plotW  = (cssW - PAD_RIGHT) - PAD_LEFT;
  const expectedMaxX = plotX0 + (partial / total) * plotW;

  const { canvas, lineTos } = makeTrackingCanvas(cssW, cssH);
  TraceRenderer.draw(canvas, {
    channels: [partialCh],
    channel_labels: ['Ch1'],
    channel_types: ['EEG'],
    n_samples_visible: partial,
    fs: 500,
    start_sec: 0,
    gain: 1,
    transparent: false,
    partial_fill: { sample_start: 0, sample_end: partial - 1, total_samples: total },
  });

  const plotY0 = PAD_TOP;
  const plotY1 = cssH - PAD_BOTTOM;
  const xs = tracePolylineX(lineTos, plotX0, plotX0 + plotW, plotY0, plotY1);
  const maxX = Math.max(...xs);
  assert.ok(
    maxX <= expectedMaxX + 4,
    `5% partial polyline must stay near the left edge; expected maxX ≤ ${expectedMaxX.toFixed(1)}, got ${maxX.toFixed(1)}.`,
  );
});

test('non-partial draw still spans full plot width (no regression)', async () => {
  // Sanity: when partial_fill is absent the polyline must use the whole plot
  // band. This is the steady-state path for cache-hit / non-streaming draws.
  const n = 1000;
  const ch = buildChannel(n);
  const cssW = 800, cssH = 600;
  const plotX0 = PAD_LEFT;
  const plotX1 = cssW - PAD_RIGHT;
  const plotW = plotX1 - plotX0;

  const { canvas, lineTos } = makeTrackingCanvas(cssW, cssH);
  TraceRenderer.draw(canvas, {
    channels: [ch],
    channel_labels: ['Ch1'],
    channel_types: ['EEG'],
    n_samples_visible: n,
    fs: 250,
    start_sec: 0,
    gain: 1,
    transparent: false,
  });

  const plotY0 = PAD_TOP;
  const plotY1 = cssH - PAD_BOTTOM;
  const xs = tracePolylineX(lineTos, plotX0, plotX1, plotY0, plotY1);
  const maxX = Math.max(...xs);
  // Full draw: the polyline must reach within ~1px of the right plot edge.
  assert.ok(
    maxX >= plotX0 + plotW - 4,
    `full draw polyline must reach the right plot edge; expected maxX ≥ ${(plotX0 + plotW - 4).toFixed(1)}, got ${maxX.toFixed(1)}.`,
  );
});

test('streaming: sequence of 5 partial_fill chunks never paints past the data front', async () => {
  // Simulates the actual streaming pipeline: a 1000-sample window arrives in
  // 5 chunks of 200 each. We replay the sequence into the same canvas stub,
  // grouping lineTos by chunk index and asserting that chunk K's polyline
  // ends at plotX0 + (K+1)*200/1000 * plotW (≈ data front), not past it.
  //
  // Why: this is exactly the streaming sequence the user triggers when
  // panning into a cache miss. Pre-fix, each chunk stretched its data across
  // the full plotW — successive chunks left ghost polylines because only the
  // narrow new-samples band got cleared. Post-fix, each polyline ends at its
  // data front and band-clearing is a no-op for already-clean regions.
  const total = 1000;
  const chunkSize = 200;
  const fullCh = buildChannel(total);

  const cssW = 800, cssH = 600;
  const plotX0 = PAD_LEFT;
  const plotW = (cssW - PAD_RIGHT) - PAD_LEFT;
  const plotY0 = PAD_TOP;
  const plotY1 = cssH - PAD_BOTTOM;

  const { canvas, lineTos } = makeTrackingCanvas(cssW, cssH);

  // First chunk: no partial_fill (full clear + draw).
  TraceRenderer.draw(canvas, {
    channels: [fullCh.subarray(0, chunkSize)],
    channel_labels: ['Ch1'],
    channel_types: ['EEG'],
    n_samples_visible: chunkSize,
    fs: 250,
    start_sec: 0,
    gain: 1,
    transparent: false,
    // First chunk also needs total_samples for x-mapping (no partial_fill
    // metadata otherwise — caller passes via top-level `window_samples_total`
    // or via partial_fill anyway; here we set partial_fill since that's what
    // the viewer would set on the 1st chunk in the post-fix world).
    partial_fill: { sample_start: 0, sample_end: chunkSize - 1, total_samples: total },
  });

  const chunkMaxX = [];
  chunkMaxX.push(Math.max(...tracePolylineX(lineTos, plotX0, plotX0 + plotW, plotY0, plotY1)));

  // Chunks 2..5: partial_fill mode.
  for (let k = 1; k < 5; k++) {
    lineTos.length = 0;
    const visible = (k + 1) * chunkSize;
    TraceRenderer.draw(canvas, {
      channels: [fullCh.subarray(0, visible)],
      channel_labels: ['Ch1'],
      channel_types: ['EEG'],
      n_samples_visible: visible,
      fs: 250,
      start_sec: 0,
      gain: 1,
      transparent: false,
      partial_fill: {
        sample_start: k * chunkSize,
        sample_end: visible - 1,
        total_samples: total,
      },
    });
    chunkMaxX.push(Math.max(...tracePolylineX(lineTos, plotX0, plotX0 + plotW, plotY0, plotY1)));
  }

  // Each chunk's polyline must end at its data front (within rounding).
  for (let k = 0; k < 5; k++) {
    const visible = (k + 1) * chunkSize;
    const limit = plotX0 + (visible / total) * plotW;
    assert.ok(
      chunkMaxX[k] <= limit + 4,
      `chunk ${k} polyline must end at data front (${limit.toFixed(1)}), got ${chunkMaxX[k].toFixed(1)}`,
    );
    // The polyline must also REACH at least most of the way to its data
    // front — guards against accidentally drawing too little.
    assert.ok(
      chunkMaxX[k] >= limit - chunkSize * (plotW / total),
      `chunk ${k} polyline must reach near its data front; got ${chunkMaxX[k].toFixed(1)}, limit ${limit.toFixed(1)}`,
    );
  }
});

test('partial_fill.full_clear: clears the entire canvas (first-chunk path)', async () => {
  // First-chunk semantics: full canvas clear + partial polyline mapping.
  // The streaming caller flags `full_clear: true` on the first chunk so any
  // pixels from a previously-painted (now superseded) window are wiped.
  // Test contract: a fillRect spanning roughly the full canvas must appear.
  const total = 1000;
  const partial = 200;
  const cssW = 800, cssH = 600;
  const ch = buildChannel(total).subarray(0, partial);

  const { canvas, fillRects } = makeTrackingCanvas(cssW, cssH);
  TraceRenderer.draw(canvas, {
    channels: [ch],
    channel_labels: ['Ch1'],
    channel_types: ['EEG'],
    n_samples_visible: partial,
    fs: 250,
    start_sec: 0,
    gain: 1,
    transparent: false,
    partial_fill: { sample_start: 0, sample_end: partial - 1, total_samples: total, full_clear: true },
  });

  // A full-canvas fillRect at (0,0,cssW,cssH) is the BG paint after clearRect.
  const fullCanvas = fillRects.find(r =>
    r.x === 0 && r.y === 0 && r.w === cssW && r.h === cssH,
  );
  assert.ok(fullCanvas, 'full_clear=true must paint the BG over the full canvas');
});

test('streaming: chunk N+1 paints over chunk N (no ghost trace residue)', async () => {
  // Direct ghost-trace check: two consecutive chunks of the SAME data range
  // [0..400] but the second chunk's data has been mutated (simulates the
  // case where partial chunks arrive but data values differ — e.g., gain
  // change, filter toggle mid-stream). Track all lineTos painted during
  // chunk 2 and assert that NO lineTo lands outside chunk 2's data band.
  //
  // The bug we're locking out: if chunk 2 used a different shape and only
  // a narrow band was cleared, chunk 1's polyline pixels would survive
  // outside that band. With the post-fix mapping, chunk 2's polyline only
  // paints inside its [plotX0, plotX0 + 400/1000*plotW] band, so the assertion
  // that NOTHING outside that band changed holds.
  const total = 1000;
  const partial = 400;
  const ch1 = buildChannel(total).subarray(0, partial);
  const ch2 = new Float32Array(ch1);
  // Mutate so chunk 2 shape differs from chunk 1.
  for (let i = 0; i < ch2.length; i++) ch2[i] *= -1.5;

  const cssW = 800, cssH = 600;
  const plotX0 = PAD_LEFT;
  const plotW = (cssW - PAD_RIGHT) - PAD_LEFT;
  const plotY0 = PAD_TOP;
  const plotY1 = cssH - PAD_BOTTOM;
  const dataFront = plotX0 + (partial / total) * plotW;

  const { canvas, lineTos } = makeTrackingCanvas(cssW, cssH);

  // Chunk 1 (initial render).
  TraceRenderer.draw(canvas, {
    channels: [ch1],
    channel_labels: ['Ch1'],
    channel_types: ['EEG'],
    n_samples_visible: partial,
    fs: 250,
    start_sec: 0,
    gain: 1,
    transparent: false,
    partial_fill: { sample_start: 0, sample_end: partial - 1, total_samples: total },
  });
  // Clear log; only track chunk 2.
  lineTos.length = 0;

  // Chunk 2 (same x-range, different shape).
  TraceRenderer.draw(canvas, {
    channels: [ch2],
    channel_labels: ['Ch1'],
    channel_types: ['EEG'],
    n_samples_visible: partial,
    fs: 250,
    start_sec: 0,
    gain: 1,
    transparent: false,
    partial_fill: { sample_start: 0, sample_end: partial - 1, total_samples: total },
  });

  const xs = tracePolylineX(lineTos, plotX0, plotX0 + plotW, plotY0, plotY1);
  const maxX = Math.max(...xs);
  assert.ok(
    maxX <= dataFront + 4,
    `chunk 2 polyline must stay within its data front (${dataFront.toFixed(1)}); got ${maxX.toFixed(1)}.`,
  );
});

test('property: data front is monotonically non-decreasing across chunks', async () => {
  // Replay 20 chunks of an arbitrary 5000-sample window in random sizes and
  // assert that each chunk's polyline maxX is >= the previous chunk's maxX.
  // Catches regressions where a chunk under-paints (drops a region painted
  // by an earlier chunk).
  const total = 5000;
  const fullCh = buildChannel(total);
  const cssW = 1000, cssH = 600;
  const plotX0 = PAD_LEFT;
  const plotW = (cssW - PAD_RIGHT) - PAD_LEFT;
  const plotY0 = PAD_TOP;
  const plotY1 = cssH - PAD_BOTTOM;

  // Deterministic pseudo-random sequence so failures reproduce.
  let seed = 17;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const { canvas, lineTos } = makeTrackingCanvas(cssW, cssH);

  let cumulative = 0;
  let prevMaxX = plotX0;
  for (let k = 0; k < 20; k++) {
    if (cumulative >= total) break;
    const remaining = total - cumulative;
    const chunkSize = Math.min(remaining, 100 + Math.floor(rand() * 400));
    const newCumulative = cumulative + chunkSize;
    lineTos.length = 0;
    TraceRenderer.draw(canvas, {
      channels: [fullCh.subarray(0, newCumulative)],
      channel_labels: ['Ch1'],
      channel_types: ['EEG'],
      n_samples_visible: newCumulative,
      fs: 500,
      start_sec: 0,
      gain: 1,
      transparent: false,
      partial_fill: {
        sample_start: cumulative,
        sample_end: newCumulative - 1,
        total_samples: total,
        full_clear: k === 0,
      },
    });
    const xs = tracePolylineX(lineTos, plotX0, plotX0 + plotW, plotY0, plotY1);
    const maxX = Math.max(...xs);
    assert.ok(
      maxX >= prevMaxX - 1,
      `chunk ${k}: data front receded — prev=${prevMaxX.toFixed(1)} new=${maxX.toFixed(1)}`,
    );
    prevMaxX = maxX;
    cumulative = newCumulative;
  }
});

test('property: drawing the same opts twice produces the same lineTo trace', async () => {
  // Idempotence: a deterministic draw must produce the SAME canvas op log on
  // a fresh canvas. Catches mutation-leak bugs where module-scope scratch
  // buffers in traces.js (e.g. _scratchMn/_scratchMx) corrupt subsequent
  // renders.
  const ch = buildChannel(2000);
  const opts = {
    channels: [ch],
    channel_labels: ['Ch1'],
    channel_types: ['EEG'],
    n_samples_visible: 2000,
    fs: 250,
    start_sec: 1.0,
    gain: 1.5,
    transparent: false,
  };

  const { canvas: c1, lineTos: l1 } = makeTrackingCanvas(800, 600);
  const { canvas: c2, lineTos: l2 } = makeTrackingCanvas(800, 600);
  TraceRenderer.draw(c1, opts);
  TraceRenderer.draw(c2, opts);

  assert.equal(l1.length, l2.length, 'lineTo count must be deterministic');
  for (let i = 0; i < l1.length; i++) {
    assert.equal(l1[i].x, l2[i].x, `lineTo[${i}].x differs: ${l1[i].x} vs ${l2[i].x}`);
    assert.equal(l1[i].y, l2[i].y, `lineTo[${i}].y differs: ${l1[i].y} vs ${l2[i].y}`);
  }
});

test('property: changing devicePixelRatio scales backing store but does not stretch polyline', async () => {
  // Set DPR=2 and confirm: (a) canvas.width/height doubles, (b) lineTo x
  // coordinates are unchanged (we use the CSS-pixel transform), (c) the
  // polyline still stays within partial_fill bounds.
  const prev = globalThis.window.devicePixelRatio;
  try {
    globalThis.window.devicePixelRatio = 2;
    const total = 1000;
    const partial = 250;
    const ch = buildChannel(total).subarray(0, partial);
    const cssW = 800, cssH = 600;
    const { canvas, lineTos } = makeTrackingCanvas(cssW, cssH);

    TraceRenderer.draw(canvas, {
      channels: [ch],
      channel_labels: ['Ch1'],
      channel_types: ['EEG'],
      n_samples_visible: partial,
      fs: 250,
      start_sec: 0,
      gain: 1,
      transparent: false,
      partial_fill: { sample_start: 0, sample_end: partial - 1, total_samples: total },
    });

    // Backing store doubles.
    assert.equal(canvas.width, cssW * 2);
    assert.equal(canvas.height, cssH * 2);

    // X coords still in CSS-pixel space.
    const plotX0 = PAD_LEFT;
    const plotW = (cssW - PAD_RIGHT) - PAD_LEFT;
    const plotY0 = PAD_TOP;
    const plotY1 = cssH - PAD_BOTTOM;
    const xs = tracePolylineX(lineTos, plotX0, plotX0 + plotW, plotY0, plotY1);
    const maxX = Math.max(...xs);
    const limit = plotX0 + (partial / total) * plotW + 4;
    assert.ok(maxX <= limit, `DPR=2 partial polyline must stay within band ≤${limit.toFixed(1)}; got ${maxX.toFixed(1)}.`);
  } finally {
    globalThis.window.devicePixelRatio = prev;
  }
});
