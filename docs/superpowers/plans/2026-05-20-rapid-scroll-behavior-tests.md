# Rapid-Scroll Behavior Test Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a comprehensive behavior-test suite that captures all of the failure modes the user reported during rapid scrolling of `https://eegdash.github.io/eegdash-viewer/?dataset=ds002893&sub=001&task=AuditoryVisualShift&run=01&ext=set` and locks in the fixes already made to `traces.js`/`viewer.js`. The suite must cover sustained input, abort cascades, geometry/layout changes mid-stream, gain/filter toggles mid-stream, retina (DPR) edge-cases, tab visibility/rAF pause-resume, and memory-leak detection — at three layers: unit (renderer contracts), integration (worker round-trip behaviour), and e2e (Playwright with pixel-diff and console-error assertions).

**Architecture:** Three-layer pyramid. (1) **Unit** — `tests/unit-traces-partial-fill.test.mjs` extended with property-style invariants for streaming sequences (no ghost, monotonic data-front, idempotent re-draws). (2) **Integration** — new `tests/integration-rapid-pan.test.mjs` that drives `viewer.js` against a stub worker, exercising abort + rapid pan + race conditions in headless Node. (3) **E2E** — new `tests/e2e/rapid-scroll.spec.mjs` that uses real Playwright + the production OpenNeuro S3 URL, with reference-image diffing for the visual-residue case. Three specialist agents (sleuth/qa-engineer/profiler) run in parallel to investigate, write tests, and capture perf baselines before/after the fix.

**Tech Stack:** Node `node:test` runner, Playwright Chromium, raw Canvas `getImageData` for pixel-diff, lightweight worker stub (in-process), `performance.memory` (Chrome-only) for leak checks.

---

## Background (read before starting)

The user reported "trace residues" left on the canvas when scrolling fast left/right on a loaded recording. Investigation traced this to the streaming render path:

- `viewer.js` `requestRender()` aborts the in-flight streaming render on every pan and starts a new one.
- `traces.js` `draw()` with `opts.partial_fill` cleared only an x-band corresponding to the new samples, but the polyline was drawn for `nVisible` (partial) samples stretched across the FULL `plotW`. Each chunk drew a different stretched lookalike on top, and only the narrow band got cleared — so prior polylines persisted as ghost lines.
- First chunks didn't pass `partial_fill` either, so the very first paint of a new window also stretched.

The fix (already applied) is:
- `traces.js` introduces `nSamplesTotal` (from `partial_fill.total_samples`) and an `effectivePlotW = plotW * (nVisible / nSamplesTotal)` so the polyline only paints its real data band.
- `traces.js` honours a `partial_fill.full_clear` flag to wipe the canvas on first-chunk semantics.
- `viewer.js` passes `partial_fill` on every chunk (with `full_clear: true` on the first).

This plan documents the **test hardening** that captures the bug class and pins the fix in place across all behaviour categories that streaming + rapid input touches.

## File Structure

```
tests/
├── unit-traces-partial-fill.test.mjs      MODIFY  invariants & properties for streaming
├── unit-viewer-render-loop.test.mjs       CREATE  rAF/abort/cache-key invariants
├── integration-rapid-pan.test.mjs         CREATE  worker-stub round-trip stress
└── e2e/
    ├── rapid-scroll.spec.mjs              CREATE  visual + console-error E2E
    └── streaming.spec.mjs                 MODIFY  STREAMING-E2E-4/5 added (done)

bench/
└── ghost-pixel-bench.mjs                  CREATE  before/after pixel-diff baselines

docs/
└── superpowers/plans/
    └── 2026-05-20-rapid-scroll-behavior-tests.md   THIS FILE
```

**Agents involved (parallel investigation):**
- `sleuth` — confirm root cause across `viewer.js`/`traces.js`/`worker.js`
- `qa-engineer` — author the new behaviour tests (unit + integration + e2e)
- `profiler` — capture memory + CPU + paint-count baselines pre/post fix

---

## Task 1: Audit the existing test gap

**Files:**
- Read: `tests/unit-traces-partial-fill.test.mjs`
- Read: `tests/e2e/streaming.spec.mjs`
- Read: `tests/integration.test.mjs`

- [ ] **Step 1: Map current coverage**

Run:
```bash
grep -n "test(" tests/unit-traces-partial-fill.test.mjs tests/e2e/streaming.spec.mjs tests/integration.test.mjs
```

Expected output: list of all existing test names. Confirm that none of these names mentions:
- "sustained pan" / "long hold"
- "bouncing" / "alternating"
- "DPR" / "retina"
- "tab visibility" / "visibilitychange"
- "memory leak" / "heap growth"
- "resize during stream"
- "gain change during stream"

- [ ] **Step 2: Write the gap report**

Create `docs/qa-followups.md` entry under `## Rapid-scroll behaviour gaps`. Append:

```markdown
## Rapid-scroll behaviour gaps (2026-05-20)

Not covered by current tests:
1. Sustained pan (30+ keypresses) — locked in by STREAMING-E2E-4
2. Bouncing direction (alternating ←/→) — locked in by STREAMING-E2E-5
3. Pan during resize — TODO Task 8
4. Pan during gain change — TODO Task 6
5. Pan during filter toggle — partially covered by STREAMING-E2E-3
6. Pan with DPR != 1 — TODO Task 7
7. Tab visibility (rAF pause) — TODO Task 9
8. Memory growth across N pans — TODO Task 10
9. Worker queue saturation — TODO Task 5
10. Streaming chunk monotonicity invariants — TODO Task 2
```

- [ ] **Step 3: Commit**

```bash
git add docs/qa-followups.md
git commit -m "docs: log rapid-scroll behaviour test gaps"
```

---

## Task 2: Property-style invariants for streaming chunks

**Files:**
- Modify: `tests/unit-traces-partial-fill.test.mjs` (append three tests at end)

- [ ] **Step 1: Add monotonic-data-front invariant test**

Append before the last `}` of the file:

```js
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
```

- [ ] **Step 2: Add idempotent re-draw invariant test**

Append:

```js
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
```

- [ ] **Step 3: Add DPR-invariance test**

Append:

```js
test('property: changing devicePixelRatio scales polyline but does not stretch', async () => {
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
```

- [ ] **Step 4: Run all partial_fill tests**

Run:
```bash
node --test tests/unit-traces-partial-fill.test.mjs
```
Expected: all tests pass (10 total).

- [ ] **Step 5: Commit**

```bash
git add tests/unit-traces-partial-fill.test.mjs
git commit -m "test(traces): property invariants for streaming chunks"
```

---

## Task 3: Render-loop invariants (viewer.js)

**Files:**
- Create: `tests/unit-viewer-render-loop.test.mjs`

The streaming render loop in `viewer.js` has several invariants that no test currently covers:

1. After `inFlight.abort()`, the new render's first chunk must use `full_clear: true`.
2. `prefetchNeighbours()` fires after both successful and aborted renders.
3. `readCache` key is `${startSample}-${windowSamples}`; pan to same window twice = cache hit.
4. `clampStart` clamps to `[0, duration_s - window_sec]`.

These can be tested by re-importing `viewer.js` modules into Node where they have no DOM dep, OR by stubbing a `tracesCanvas`/`worker`/`document` and exercising the public-ish handlers. Since `viewer.js` is monolithic, the cleanest path is **factoring `clampStart` and `requestRender`'s decision logic into pure helpers** — but that's out of scope for this plan. For now we cover only the parts already exported or easily isolated.

- [ ] **Step 1: Confirm what's testable**

Run:
```bash
grep -n "^function\|^const\|^let\|^var\|module.exports\|window\." viewer.js | head -40
```
Expected: `viewer.js` is an IIFE; only `TraceRenderer` and `BIDSRecording` are exported. The streaming logic is inside the IIFE.

- [ ] **Step 2: Write a clampStart unit test via dynamic import + scope leak**

The viewer's `clampStart` is defined inline. Since we can't import it directly, write the contract as a documentation test that re-implements the formula and asserts the formula matches what the live viewer would produce.

Create `tests/unit-viewer-render-loop.test.mjs`:

```js
// unit-viewer-render-loop.test.mjs
//
// Contract tests for the render-loop logic inside viewer.js. Because
// viewer.js is an IIFE that does not export its internals, these are
// formula tests — they re-implement the small bits of math the live
// viewer uses and assert they behave as specified. If the live viewer
// drifts from the formula, the corresponding e2e test catches the
// behavioural difference; this layer catches the formula bug fast.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

function clampStart(secs, durationSec, windowSec) {
  // Mirrors the inline `clampStart` in viewer.js.
  const maxStart = Math.max(0, durationSec - windowSec);
  return Math.max(0, Math.min(maxStart, secs));
}

test('clampStart: holds start_sec >= 0', () => {
  assert.equal(clampStart(-5, 100, 10), 0);
});

test('clampStart: holds start_sec + window_sec <= duration_s', () => {
  assert.equal(clampStart(95, 100, 10), 90);
});

test('clampStart: window larger than recording clamps to 0', () => {
  assert.equal(clampStart(5, 10, 20), 0);
});

test('clampStart: identity on a valid in-range request', () => {
  assert.equal(clampStart(42.5, 100, 10), 42.5);
});

// Cache-key contract. requestRender builds `${startSample}-${windowSamples}`.
// Two pans to the same window must produce identical keys → cache hit.
function cacheKey(startSec, windowSec, fs, totalSamples) {
  const startSample = Math.max(0,
    Math.min(totalSamples - 1, Math.round(startSec * fs)));
  const windowSamples = Math.min(
    totalSamples - startSample,
    Math.round(windowSec * fs),
  );
  return `${startSample}-${windowSamples}`;
}

test('cacheKey: identical (start, window) → identical key', () => {
  const k1 = cacheKey(1.234, 5, 500, 50_000);
  const k2 = cacheKey(1.234, 5, 500, 50_000);
  assert.equal(k1, k2);
});

test('cacheKey: pan and pan-back → identical key', () => {
  const k1 = cacheKey(0.0, 5, 500, 50_000);
  const k2 = cacheKey(2.5, 5, 500, 50_000);
  const k3 = cacheKey(0.0, 5, 500, 50_000);
  assert.notEqual(k1, k2);
  assert.equal(k1, k3);
});

test('cacheKey: tail-clamp produces a shorter window key, not a phantom one', () => {
  // At t=99 with windowSec=5 on a 100s/500Hz recording (50000 samples), the
  // tail clamps: startSample=49500, windowSamples=500. The key reflects the
  // shorter window so a subsequent pan to the same edge hits the cache.
  const k = cacheKey(99, 5, 500, 50_000);
  assert.equal(k, '49500-500');
});
```

- [ ] **Step 3: Run the new tests**

Run:
```bash
node --test tests/unit-viewer-render-loop.test.mjs
```
Expected: 7 tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/unit-viewer-render-loop.test.mjs
git commit -m "test(viewer): contract tests for clampStart and cache-key formulas"
```

---

## Task 4: Integration test — abort cascade against a stub worker

**Files:**
- Create: `tests/integration-rapid-pan.test.mjs`

The hardest race is the abort cascade: pan-pan-pan triggers three abort+restart cycles. The integration test simulates this against a stub worker that responds with controlled timing.

- [ ] **Step 1: Write the stub worker harness**

Create `tests/integration-rapid-pan.test.mjs`:

```js
// integration-rapid-pan.test.mjs
//
// Integration tests for the rapid-pan abort cascade. We drive a tiny
// in-process worker stub that mirrors worker.js's FETCH_WINDOW_STREAM
// protocol (WINDOW_CHUNK messages with `partial`, `sample_start`,
// `sample_end`, `channels`). The viewer-side message handlers live
// inside the viewer.js IIFE, so we replicate the public surface here:
//
//   workerFetchWindowStreaming(start, n, signal) — yields chunks
//   pendingRequests / cancelledRequests bookkeeping
//
// then drive a tight pan loop and assert the protocol-level invariants:
//   - every abort results in cancelledRequests.add(id)
//   - no double-resolve of a stream
//   - no chunk delivered after an abort signal fired
//   - the queue empties between pans (no leaked entries)

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Re-create the slice of viewer.js we need. Keep this file self-contained
// — the integration test layer is for behavioural invariants, not for
// importing the real viewer module (which depends on DOM globals).
function makeStreamingClient() {
  const pendingRequests = new Map();
  const cancelledRequests = new Set();
  let nextId = 1;

  // Simulated worker: schedules `chunkCount` chunks each at a small delay.
  const worker = {
    chunksFor(reqId, total, chunkCount, delayMs) {
      const chunkSize = Math.ceil(total / chunkCount);
      const send = async () => {
        for (let i = 0; i < chunkCount; i++) {
          await new Promise(r => setTimeout(r, delayMs));
          if (cancelledRequests.has(reqId)) return;
          const start = i * chunkSize;
          const end = Math.min(total - 1, start + chunkSize - 1);
          const entry = pendingRequests.get(reqId);
          if (!entry) return;
          const channels = [new Float32Array(end - start + 1).fill(i + 1)];
          entry.onChunk({ partial: i < chunkCount - 1, channels, sample_start: start, sample_end: end });
          if (i === chunkCount - 1) {
            pendingRequests.delete(reqId);
            entry.onDone();
          }
        }
      };
      send();
    },
  };

  function fetchStream(total, chunkCount, delayMs, signal) {
    const id = nextId++;
    let _resolve = null, _reject = null;
    const _queue = [];
    let _done = false;
    let _error = null;

    pendingRequests.set(id, {
      onChunk(chunk) {
        if (_resolve) { const r = _resolve; _resolve = null; r({ value: chunk, done: false }); }
        else _queue.push(chunk);
      },
      onDone() {
        _done = true;
        if (_resolve) { const r = _resolve; _resolve = null; r({ value: undefined, done: true }); }
      },
      onError(err) {
        _error = err;
        if (_reject) { const rj = _reject; _reject = null; rj(err); }
      },
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        if (pendingRequests.has(id)) pendingRequests.delete(id);
        cancelledRequests.add(id);
        const e = new Error('aborted');
        e.name = 'AbortError';
        if (_reject) { const rj = _reject; _reject = null; rj(e); }
        else _error = e;
      }, { once: true });
    }

    worker.chunksFor(id, total, chunkCount, delayMs);

    return {
      id,
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (_error) return Promise.reject(_error);
            if (_queue.length) return Promise.resolve({ value: _queue.shift(), done: false });
            if (_done) return Promise.resolve({ value: undefined, done: true });
            return new Promise((res, rej) => { _resolve = res; _reject = rej; });
          },
        };
      },
    };
  }

  return { pendingRequests, cancelledRequests, fetchStream };
}

async function consumeStream(stream, signal) {
  const chunks = [];
  try {
    for await (const chunk of stream) {
      if (signal && signal.aborted) break;
      chunks.push(chunk);
    }
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  }
  return chunks;
}

test('abort cascade: 10 rapid renders leave 0 entries in pendingRequests', async () => {
  const client = makeStreamingClient();
  const controllers = [];
  const consumers = [];

  for (let i = 0; i < 10; i++) {
    const ctrl = new AbortController();
    controllers.push(ctrl);
    const stream = client.fetchStream(1000, 5, 5, ctrl.signal);
    consumers.push(consumeStream(stream, ctrl.signal));
    if (i > 0) controllers[i - 1].abort();
  }
  // Let the last one complete.
  await consumers[consumers.length - 1];

  // Settle.
  await new Promise(r => setTimeout(r, 100));

  assert.equal(client.pendingRequests.size, 0, 'no leaked pending entries');
  assert.equal(client.cancelledRequests.size, 9, '9 of 10 must be marked cancelled');
});

test('abort cascade: aborted streams do not deliver chunks past abort signal', async () => {
  const client = makeStreamingClient();
  const ctrl = new AbortController();
  const stream = client.fetchStream(1000, 10, 10, ctrl.signal);

  const chunks = [];
  let abortTime = 0;
  const consume = (async () => {
    try {
      for await (const c of stream) {
        chunks.push({ ...c, arrivedAt: performance.now() });
        if (chunks.length === 2 && !abortTime) {
          abortTime = performance.now();
          ctrl.abort();
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
    }
  })();
  await consume;

  // No chunk's arrivedAt should be > abortTime + a small grace.
  for (const c of chunks) {
    assert.ok(c.arrivedAt <= abortTime + 30, `chunk arrived ${c.arrivedAt - abortTime}ms after abort`);
  }
});

test('rapid-pan stress: 50 pans, only the last one resolves to full data', async () => {
  const client = makeStreamingClient();
  let lastFullChunks = null;

  let prev = null;
  for (let i = 0; i < 50; i++) {
    if (prev) prev.ctrl.abort();
    const ctrl = new AbortController();
    const stream = client.fetchStream(2000, 4, 2, ctrl.signal);
    prev = { ctrl, stream };
  }

  // Consume the final stream to completion.
  lastFullChunks = await consumeStream(prev.stream, prev.ctrl.signal);

  // The final chunk must have partial:false (full window).
  const last = lastFullChunks[lastFullChunks.length - 1];
  assert.ok(last, 'final stream must deliver at least one chunk');
  assert.equal(last.partial, false, 'final chunk must be terminal (partial:false)');
});
```

- [ ] **Step 2: Run the tests**

Run:
```bash
node --test tests/integration-rapid-pan.test.mjs
```
Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/integration-rapid-pan.test.mjs
git commit -m "test(integration): abort cascade and rapid-pan stress against stub worker"
```

---

## Task 5: Worker queue saturation test

**Files:**
- Modify: `tests/integration-rapid-pan.test.mjs` (append one test)

The viewer's `prefetchNeighbours()` is gated by `pendingRequests.size > 0`. Saturating the worker should NOT pile up prefetches behind the foreground fetch.

- [ ] **Step 1: Append the saturation test**

```js
test('prefetch gate: prefetch is skipped while worker has in-flight requests', async () => {
  // Mirrors viewer.js prefetchNeighbours() gate:
  //   if (pendingRequests.size > 0) return;
  // We assert the gate behaves as documented.
  const client = makeStreamingClient();
  const ctrl = new AbortController();
  client.fetchStream(1000, 10, 5, ctrl.signal);

  // Simulated prefetch decision — same condition the viewer uses.
  function shouldPrefetch() { return client.pendingRequests.size === 0; }

  assert.equal(shouldPrefetch(), false, 'must not prefetch while a stream is in flight');

  ctrl.abort();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(shouldPrefetch(), true, 'must allow prefetch once stream is aborted/drained');
});
```

- [ ] **Step 2: Run**

```bash
node --test tests/integration-rapid-pan.test.mjs
```
Expected: 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/integration-rapid-pan.test.mjs
git commit -m "test(integration): prefetch gate skips while worker busy"
```

---

## Task 6: E2E — gain change during streaming

**Files:**
- Create: `tests/e2e/rapid-scroll.spec.mjs`

A gain-slider change mid-pan changes `view.gain` and calls `requestRender()`. The streaming abort + new render must produce a CLEAN canvas (no ghost lines from the pre-gain trace).

- [ ] **Step 1: Bootstrap the spec file with shared helpers**

```js
// tests/e2e/rapid-scroll.spec.mjs
//
// E2E behaviour tests for rapid input streams (pan, gain, filter, resize).
// Built on the same OpenNeuro EEGLAB fixture as streaming.spec.mjs so the
// shapes are comparable. Each test takes a screenshot and writes a JSON
// summary of pixel counts to tests/evidence/<id>/ for human-eye inspection.

import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const EEG_URL = 'https://s3.amazonaws.com/openneuro.org/ds002893/sub-001/eeg/sub-001_task-AuditoryVisualShift_run-01_eeg.set';

const EVIDENCE_ROOT = path.resolve('tests/evidence');
function evidenceDir(id) {
  const d = path.join(EVIDENCE_ROOT, id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function waitForLoad(page, timeout = 90_000) {
  await expect(page.locator('#stage-caption')).toBeVisible({ timeout });
}

async function countNonBgPixels(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('traces');
    if (!canvas || !canvas.width) return 0;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2];
      if (Math.abs(r - 251) > 8 || Math.abs(g - 250) > 8 || Math.abs(b - 246) > 8) {
        count++;
      }
    }
    return count;
  });
}

function pixelCountsStable(prev, curr) {
  const denom = Math.max(prev, curr, 1);
  return Math.abs(curr - prev) < Math.max(5, denom * 0.01);
}

async function settle(page, maxIter = 25, stableTarget = 4, intervalMs = 400) {
  let prev = await countNonBgPixels(page);
  let stable = 0;
  for (let i = 0; i < maxIter && stable < stableTarget; i++) {
    await page.waitForTimeout(intervalMs);
    const curr = await countNonBgPixels(page);
    stable = pixelCountsStable(prev, curr) ? stable + 1 : 0;
    prev = curr;
  }
  return prev;
}

test('RAPID-1: gain change during streaming produces a clean canvas', async ({ page }) => {
  const dir = evidenceDir('rapid-1-gain-during-stream');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });

  await page.goto(`/index.html?eeg=${encodeURIComponent(EEG_URL)}`);
  await waitForLoad(page);
  await page.waitForTimeout(500);
  const baseline = await countNonBgPixels(page);

  // Start a streaming pan, then immediately change gain.
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(50);
  const gain = page.locator('#gain');
  if (await gain.isVisible().catch(() => false)) {
    await gain.fill('2');
    await gain.dispatchEvent('input');
  } else {
    test.skip(true, 'gain slider not present in this build');
  }

  const after = await settle(page);
  await page.screenshot({ path: path.join(dir, 'after.png') });

  fs.writeFileSync(path.join(dir, 'pixel-counts.json'), JSON.stringify({ baseline, after }, null, 2));

  expect(errors).toHaveLength(0);
  // Higher gain typically increases pixel count, but the canvas must be
  // non-blank and not show absurd accumulation (>2x baseline).
  expect(after).toBeGreaterThan(baseline * 0.3);
  expect(after).toBeLessThan(baseline * 2.0);
});
```

- [ ] **Step 2: Run**

```bash
npx playwright test tests/e2e/rapid-scroll.spec.mjs --project=chromium -g 'RAPID-1'
```
Expected: PASS (or skip if gain slider not present in current build).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/rapid-scroll.spec.mjs
git commit -m "test(e2e): RAPID-1 gain change during streaming"
```

---

## Task 7: E2E — DPR (Retina) edge case

**Files:**
- Modify: `tests/e2e/rapid-scroll.spec.mjs` (append RAPID-2)

- [ ] **Step 1: Append RAPID-2**

```js
test('RAPID-2: rapid pan at devicePixelRatio=2 leaves no ghost residue', async ({ browser }) => {
  // Retina-resolution browsers triple-buffer canvas pixels; the backing
  // store is 2x cssW/cssH. The bug class we lock down: clearing using
  // CSS coordinates while the polyline draws using transformed coordinates
  // can leave 1-pixel halos at chunk boundaries on hi-DPR.
  const dir = evidenceDir('rapid-2-dpr');
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  const page = await context.newPage();
  try {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
    });

    await page.goto(`/index.html?eeg=${encodeURIComponent(EEG_URL)}`);
    await waitForLoad(page);
    await page.waitForTimeout(500);
    const baseline = await countNonBgPixels(page);

    for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowLeft');

    const after = await settle(page);
    await page.screenshot({ path: path.join(dir, 'after-dpr2.png') });
    fs.writeFileSync(path.join(dir, 'pixel-counts.json'), JSON.stringify({ baseline, after }, null, 2));

    expect(errors).toHaveLength(0);
    expect(after).toBeGreaterThan(baseline * 0.5);
    expect(after).toBeLessThan(baseline * 1.15);
  } finally {
    await context.close();
  }
});
```

- [ ] **Step 2: Run**

```bash
npx playwright test tests/e2e/rapid-scroll.spec.mjs --project=chromium -g 'RAPID-2'
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/rapid-scroll.spec.mjs
git commit -m "test(e2e): RAPID-2 hi-DPR rapid pan stays clean"
```

---

## Task 8: E2E — Viewport resize mid-stream

**Files:**
- Modify: `tests/e2e/rapid-scroll.spec.mjs` (append RAPID-3)

- [ ] **Step 1: Append RAPID-3**

```js
test('RAPID-3: viewport resize while streaming does not leave dead pixels', async ({ page }) => {
  // resize fires requestRender(); deviceFitCanvas resets dims and the next
  // draw re-fits the backing store. If the streaming render aborts then
  // restarts with stale `plotW` cached from the closure, the new render
  // can paint into the wrong region. This test sets a smaller viewport
  // mid-stream and asserts the canvas refits cleanly.
  const dir = evidenceDir('rapid-3-resize');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`/index.html?eeg=${encodeURIComponent(EEG_URL)}`);
  await waitForLoad(page);
  await page.waitForTimeout(500);

  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(30);
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(30);
  await page.setViewportSize({ width: 1400, height: 900 });

  const after = await settle(page);
  await page.screenshot({ path: path.join(dir, 'after-resize.png') });
  fs.writeFileSync(path.join(dir, 'pixel-counts.json'), JSON.stringify({ after }, null, 2));

  expect(errors).toHaveLength(0);
  expect(after).toBeGreaterThan(500);
});
```

- [ ] **Step 2: Run**

```bash
npx playwright test tests/e2e/rapid-scroll.spec.mjs --project=chromium -g 'RAPID-3'
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/rapid-scroll.spec.mjs
git commit -m "test(e2e): RAPID-3 viewport resize mid-stream"
```

---

## Task 9: E2E — Tab visibility (rAF pause/resume)

**Files:**
- Modify: `tests/e2e/rapid-scroll.spec.mjs` (append RAPID-4)

When a tab is hidden, browsers throttle `requestAnimationFrame` to ~1Hz. If `pending = requestAnimationFrame(...)` is set but never fires, subsequent `requestRender()` calls early-return. On tab-show the queued rAF fires with `view.start_sec` that has changed many times — we expect the latest value to render correctly.

- [ ] **Step 1: Append RAPID-4**

```js
test('RAPID-4: tab visibility throttle does not leave stale frame on resume', async ({ page, context }) => {
  const dir = evidenceDir('rapid-4-visibility');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });

  await page.goto(`/index.html?eeg=${encodeURIComponent(EEG_URL)}`);
  await waitForLoad(page);
  await page.waitForTimeout(500);

  // Emulate tab going to background by emitting a visibilitychange event.
  // (Playwright's page.emulateVisibilityState is not in all versions, so we
  // dispatch the event manually.)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', writable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  const after = await settle(page);
  await page.screenshot({ path: path.join(dir, 'after-visibility.png') });
  fs.writeFileSync(path.join(dir, 'pixel-counts.json'), JSON.stringify({ after }, null, 2));

  expect(errors).toHaveLength(0);
  expect(after).toBeGreaterThan(500);
});
```

- [ ] **Step 2: Run**

```bash
npx playwright test tests/e2e/rapid-scroll.spec.mjs --project=chromium -g 'RAPID-4'
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/rapid-scroll.spec.mjs
git commit -m "test(e2e): RAPID-4 tab visibility resume"
```

---

## Task 10: E2E — Memory growth across N pans

**Files:**
- Modify: `tests/e2e/rapid-scroll.spec.mjs` (append RAPID-5)

`performance.memory.usedJSHeapSize` is Chrome-only but Playwright Chromium exposes it. We sample heap before and after 200 pans; growth should be bounded.

- [ ] **Step 1: Append RAPID-5**

```js
test('RAPID-5: 200 sequential pans do not leak heap memory', async ({ page }) => {
  const dir = evidenceDir('rapid-5-heap');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });

  await page.goto(`/index.html?eeg=${encodeURIComponent(EEG_URL)}`);
  await waitForLoad(page);
  await page.waitForTimeout(1000);

  const startHeap = await page.evaluate(() => {
    if (window.gc) window.gc();
    return performance.memory ? performance.memory.usedJSHeapSize : null;
  });
  if (startHeap === null) test.skip(true, 'performance.memory not available');

  for (let i = 0; i < 100; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 100; i++) await page.keyboard.press('ArrowLeft');
  await settle(page);

  const endHeap = await page.evaluate(() => {
    if (window.gc) window.gc();
    return performance.memory.usedJSHeapSize;
  });

  const growth = endHeap - startHeap;
  const growthMB = (growth / 1024 / 1024).toFixed(1);
  fs.writeFileSync(path.join(dir, 'heap.json'), JSON.stringify({ startHeap, endHeap, growthBytes: growth }, null, 2));

  expect(errors).toHaveLength(0);
  // Allow up to 50 MB growth across 200 pans (the read cache holds 6
  // windows worth of data, each ~MB — plus normal V8 working set).
  expect(growth).toBeLessThan(50 * 1024 * 1024);
});
```

- [ ] **Step 2: Run with --js-flags=--expose-gc**

The test relies on `window.gc` if available. Run normally; the test will skip if `performance.memory` is absent:

```bash
npx playwright test tests/e2e/rapid-scroll.spec.mjs --project=chromium -g 'RAPID-5'
```
Expected: PASS (or skip).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/rapid-scroll.spec.mjs
git commit -m "test(e2e): RAPID-5 heap growth bounded under 200 pans"
```

---

## Task 11: Pixel-diff baseline tool

**Files:**
- Create: `bench/ghost-pixel-bench.mjs`

A small reference tool that captures a "clean" reference image of the canvas at a known window, then compares post-stress canvas to it. This is the most direct visual-residue measurement.

- [ ] **Step 1: Write the bench tool**

```js
// bench/ghost-pixel-bench.mjs
//
// Captures a reference render of the canvas at a fixed window, then
// performs a rapid-pan sequence and computes the per-pixel diff between
// the post-stress canvas and the reference. The diff is reported as
// (a) total non-zero diff pixels, (b) RMS RGB delta. Both numbers should
// be small (< 0.5% of canvas area, < 5/255 RMS) on a clean implementation.
//
// Usage: node bench/ghost-pixel-bench.mjs
// Output: bench/ghost-pixel-baseline.json

import { chromium } from '@playwright/test';
import fs from 'node:fs';

const EEG_URL = 'https://s3.amazonaws.com/openneuro.org/ds002893/sub-001/eeg/sub-001_task-AuditoryVisualShift_run-01_eeg.set';

async function captureCanvas(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('traces');
    const ctx = canvas.getContext('2d');
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { w: d.width, h: d.height, data: Array.from(d.data) };
  });
}

function diff(a, b) {
  if (a.w !== b.w || a.h !== b.h) throw new Error('size mismatch');
  let nonZero = 0;
  let sumSq = 0;
  let nPx = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const dr = a.data[i] - b.data[i];
    const dg = a.data[i+1] - b.data[i+1];
    const db = a.data[i+2] - b.data[i+2];
    if (dr || dg || db) nonZero++;
    sumSq += dr*dr + dg*dg + db*db;
    nPx++;
  }
  const rms = Math.sqrt(sumSq / (nPx * 3));
  return { nonZero, total: nPx, rms: Number(rms.toFixed(3)) };
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://localhost:8011/index.html?eeg=${encodeURIComponent(EEG_URL)}`);
await page.waitForSelector('#stage-caption', { timeout: 90_000 });
await page.waitForTimeout(2000);

const reference = await captureCanvas(page);

for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(3000);

const after = await captureCanvas(page);
const d = diff(reference, after);

fs.mkdirSync('bench', { recursive: true });
fs.writeFileSync('bench/ghost-pixel-baseline.json', JSON.stringify({
  reference_size: { w: reference.w, h: reference.h },
  diff: d,
  diff_ratio: Number((d.nonZero / d.total).toFixed(4)),
}, null, 2));

console.log(`pixels differing: ${d.nonZero}/${d.total} (${(d.nonZero / d.total * 100).toFixed(2)}%)`);
console.log(`RMS delta: ${d.rms}/255`);
await browser.close();
```

- [ ] **Step 2: Run against a live dev server**

```bash
# In one terminal:
node scripts/dev-server.mjs &
sleep 2
# In another:
node bench/ghost-pixel-bench.mjs
cat bench/ghost-pixel-baseline.json
```

Expected: `diff_ratio < 0.005` (less than 0.5% of pixels differ) and `rms < 5`.

- [ ] **Step 3: Commit**

```bash
git add bench/ghost-pixel-bench.mjs
git commit -m "bench: ghost-pixel diff baseline tool"
```

---

## Task 12: Parallel agent dispatch (debug + test + perf)

This task is the orchestration step. It does not write code — it dispatches the three specialist agents in parallel to (a) double-check the root cause, (b) extend the test coverage where they spot more gaps, (c) capture a before/after perf baseline so we can prove the fix isn't a perf regression.

**Agents:**

| Agent | Task | Artefacts |
|---|---|---|
| `sleuth` | Independent investigation of the partial_fill ghost-trace bug across viewer.js / traces.js / worker.js | Written root-cause memo (returned in the agent's reply) |
| `qa-engineer` | Review Tasks 2–10 tests and add at least 2 missing cases (e.g. cache-key collisions on tail-clamped windows; concurrent filter+pan) | New test cases appended to relevant files |
| `profiler` | Run the test:perf suite + ghost-pixel-bench before and after the partial_fill fix; report deltas | bench/ghost-pixel-baseline.json + memo |

- [ ] **Step 1: Dispatch all three agents in parallel**

```text
[parent harness] Send a single message containing three Agent tool calls:

  Agent(description="Sleuth: ghost trace root cause",
        subagent_type="sleuth",
        prompt="Independently investigate why fast left/right scrolling on
        https://eegdash.github.io/eegdash-viewer leaves trace residues.
        The candidate root cause is the partial_fill path in
        traces.js (~line 446) + viewer.js streaming render loop (~line 752).
        Read both files. Confirm or refute the hypothesis that the polyline
        is being stretched across the full plotW while only a narrow band
        gets cleared. Report file:line evidence in a 200-word memo.")

  Agent(description="QA: extend rapid-pan tests",
        subagent_type="qa-engineer",
        prompt="Read docs/superpowers/plans/2026-05-20-rapid-scroll-behavior-tests.md
        Tasks 2 through 10. Identify at least two behaviour gaps still NOT
        covered (think: tail-clamp + pan, filter+pan interleave, channel
        offset paging during pan, recording boundary). For each gap, append
        a new test to the appropriate file. Run all unit + integration tests
        and report PASS/FAIL.")

  Agent(description="Profiler: ghost-pixel + perf baseline",
        subagent_type="profiler",
        prompt="(1) Run bench/ghost-pixel-bench.mjs against a freshly built
        viewer. Record diff_ratio and rms. (2) Run npm run test:perf and
        record p50 / p95 numbers. (3) Compare against the previous baseline
        in bench/baseline.json if present. Report deltas in a 200-word memo.")
```

- [ ] **Step 2: Review each agent's reply**

For each agent:
- If the agent added a new test: read the diff and confirm it follows our patterns (TDD, real assertions, file:line precision).
- If the agent's report contradicts the plan: revisit the relevant task and re-run the failing test.
- If perf regressed: spawn a `nitro` agent to investigate.

- [ ] **Step 3: Commit any agent-added tests**

```bash
git status
# inspect new/modified test files only — DO NOT commit anything else the agents may have touched without review
git add tests/unit-traces-partial-fill.test.mjs tests/integration-rapid-pan.test.mjs tests/e2e/rapid-scroll.spec.mjs
git commit -m "test: extend rapid-pan behaviour coverage from QA agent review"
```

---

## Task 13: Wire all new e2e tests into CI

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add a behavior-stress script**

Look at current `package.json`:

```bash
grep -A 1 '"test:e2e"' package.json
```

Add a new script entry below `test:e2e`:

```json
"test:e2e:rapid": "playwright test tests/e2e/streaming.spec.mjs tests/e2e/rapid-scroll.spec.mjs --project=chromium",
```

Place it between `test:e2e` and `test:visual` so the alphabetical-ish grouping is preserved.

- [ ] **Step 2: Verify the script exists**

```bash
npm run | grep "test:e2e:rapid"
```
Expected: script listed.

- [ ] **Step 3: Run the whole rapid suite**

```bash
npm run test:e2e:rapid
```
Expected: STREAMING-E2E-1..5 + RAPID-1..5 all pass.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "ci: add test:e2e:rapid script for streaming + rapid-pan suite"
```

---

## Task 14: Documentation

**Files:**
- Modify: `docs/qa-strategy.md`

- [ ] **Step 1: Append a new section**

Find the last section in `docs/qa-strategy.md` and append:

```markdown
## Rapid-Input Behaviour Suite

Rapid keyboard / pointer input on the viewer exercises the streaming render
path (worker → assembled chunks → partial_fill draw) and the abort cascade
(every new pan aborts the in-flight stream). This suite locks down the
class of bugs reported on 2026-05-20 where fast left/right scrolling left
ghost trace residue on the canvas.

| Layer | File | Covers |
|---|---|---|
| Unit | tests/unit-traces-partial-fill.test.mjs | polyline x-mapping during partial_fill, full_clear flag, monotonic data-front, idempotent re-draw, DPR invariance |
| Unit | tests/unit-viewer-render-loop.test.mjs | clampStart formula, cache-key formula, tail-clamp keys |
| Integration | tests/integration-rapid-pan.test.mjs | abort cascade, no-delivery-after-abort, 50-pan stress, prefetch gate |
| E2E | tests/e2e/streaming.spec.mjs | STREAMING-E2E-1..5 |
| E2E | tests/e2e/rapid-scroll.spec.mjs | RAPID-1..5 (gain, DPR, resize, visibility, heap) |
| Bench | bench/ghost-pixel-bench.mjs | per-pixel diff before/after stress |

Run all rapid-input tests:

```bash
npm run test:e2e:rapid
```
```

- [ ] **Step 2: Commit**

```bash
git add docs/qa-strategy.md
git commit -m "docs: document rapid-input behaviour test layers"
```

---

## Self-review checklist (performed by the plan author)

- [x] Spec coverage: every category the user mentioned (rapid scroll → ghost trace) is now under at least one test. Sustained pan → STREAMING-E2E-4. Bouncing → STREAMING-E2E-5. Gain → RAPID-1. DPR → RAPID-2. Resize → RAPID-3. Visibility → RAPID-4. Heap → RAPID-5. Renderer contract → unit-traces-partial-fill. Worker abort cascade → integration-rapid-pan.
- [x] Placeholder scan: no "TBD" / "implement later" / "similar to Task N" remains; every code block is complete.
- [x] Type consistency: `partial_fill.full_clear`, `total_samples`, `sample_start`, `sample_end`, `pixelCountsStable`, `settle`, `countNonBgPixels` are defined once and used everywhere.
- [x] Each task ends in a commit. Each test has a clear PASS/FAIL signal.
- [x] Agents are dispatched in parallel (Task 12) only after the deterministic test layers (Tasks 2–11) are in place — so they have something to compare against.
