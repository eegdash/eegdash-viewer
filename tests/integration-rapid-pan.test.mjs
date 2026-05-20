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

    // CRITICAL invariant: every resolution path must null BOTH _resolve and
    // _reject. If we only null _resolve, the stale _reject still points at
    // the already-settled promise — and the abort handler checks `if (_reject)`
    // first, so it would call rj() on a dead promise (no-op) and skip the
    // `_error` assignment. The next next() then returns a fresh Promise that
    // nobody resolves, and the iterator hangs forever. Always-set _error
    // makes the path order-independent.
    pendingRequests.set(id, {
      onChunk(chunk) {
        if (_resolve) {
          const r = _resolve;
          _resolve = null; _reject = null;
          r({ value: chunk, done: false });
        } else {
          _queue.push(chunk);
        }
      },
      onDone() {
        _done = true;
        if (_resolve) {
          const r = _resolve;
          _resolve = null; _reject = null;
          r({ value: undefined, done: true });
        }
      },
      onError(err) {
        _error = err;
        if (_reject) {
          const rj = _reject;
          _resolve = null; _reject = null;
          rj(err);
        }
      },
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        if (pendingRequests.has(id)) pendingRequests.delete(id);
        cancelledRequests.add(id);
        const e = new Error('aborted');
        e.name = 'AbortError';
        _error = e;
        if (_reject) {
          const rj = _reject;
          _resolve = null; _reject = null;
          rj(e);
        }
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

test('filter+pan interleave: toggling hp/lp/notch mid-pan aborts in-flight stream cleanly', async () => {
  // GAP: STREAMING-E2E-3 covers filter-after-pan (settled state), and the
  // abort-cascade tests cover pan-pan-pan. But filter+pan INTERLEAVE — where
  // the user pans, then toggles a filter while the first pan stream is still
  // emitting chunks, then pans again, then toggles another filter — is not
  // covered. Every filter toggle issues a fresh fetch and must abort the
  // currently in-flight stream (whether it's a pan stream or an earlier
  // filter stream). This is the protocol-level invariant: no leaked
  // pendingRequests after the sequence settles, and exactly N-1 entries
  // marked cancelled when N total fetches are issued.
  const client = makeStreamingClient();
  const operations = [
    { kind: 'pan',    label: 'pan-right-1' },
    { kind: 'filter', label: 'hp-on'       },
    { kind: 'pan',    label: 'pan-right-2' },
    { kind: 'filter', label: 'lp-on'       },
    { kind: 'pan',    label: 'pan-left-1'  },
    { kind: 'filter', label: 'notch-on'    },
    { kind: 'pan',    label: 'pan-right-3' },
  ];

  const controllers = [];
  const consumers = [];
  let prevCtrl = null;

  for (const op of operations) {
    if (prevCtrl) prevCtrl.abort();
    const ctrl = new AbortController();
    controllers.push(ctrl);
    // Each op kicks off a worker stream. Filter ops would use a single chunk
    // (filter path collapses to one chunk in the real worker) but the abort
    // contract is identical so we use the same shape here.
    const total = op.kind === 'filter' ? 800 : 1200;
    const nChunks = op.kind === 'filter' ? 1 : 4;
    const stream = client.fetchStream(total, nChunks, 8, ctrl.signal);
    consumers.push(consumeStream(stream, ctrl.signal));
    prevCtrl = ctrl;
  }

  // Let only the FINAL operation complete.
  await consumers[consumers.length - 1];
  await new Promise(r => setTimeout(r, 100));

  assert.equal(
    client.pendingRequests.size, 0,
    `filter+pan interleave must leave no leaked pendingRequests; got ${client.pendingRequests.size}. ` +
    `If non-zero, a filter or pan path is not cancelling its in-flight stream.`,
  );
  assert.equal(
    client.cancelledRequests.size, operations.length - 1,
    `expected ${operations.length - 1} cancelled requests (every op except the last); ` +
    `got ${client.cancelledRequests.size}.`,
  );
});

test('prefetch gate: prefetch is skipped while worker has in-flight requests', async () => {
  // Mirrors viewer.js prefetchNeighbours() gate:
  //   if (pendingRequests.size > 0) return;
  // We assert the gate behaves as documented: while a stream is in flight,
  // the queue is non-empty and prefetch must be skipped; once the stream is
  // aborted/drained, the queue empties and prefetch is allowed again.
  const client = makeStreamingClient();
  const ctrl = new AbortController();
  client.fetchStream(1000, 10, 5, ctrl.signal);

  function shouldPrefetch() { return client.pendingRequests.size === 0; }

  assert.equal(shouldPrefetch(), false, 'must not prefetch while a stream is in flight');

  ctrl.abort();
  // Settle one event-loop tick so the abort handler removes the pending entry.
  await new Promise(r => setTimeout(r, 30));
  assert.equal(shouldPrefetch(), true, 'must allow prefetch once stream is aborted/drained');
});

test('memory: 1000 abort cascades on stub worker do not leak heap', async (t) => {
  // Node-side memory gate. Requires `node --expose-gc`. Without it, GC is
  // lazy enough that a real leak vs noise can't be distinguished — we skip
  // rather than report a flaky number.
  if (typeof global.gc !== 'function') {
    t.skip('run with `node --expose-gc` to enable memory leak detection');
    return;
  }

  // Joyee Cheung pattern — retry GC + setImmediate until heap stabilises.
  // We bail out early once two consecutive measurements drift less than
  // 50KB (essentially noise floor of allocation churn from setImmediate
  // itself), or fall through at 30 retries.
  const stableGc = async () => {
    let lastHeap = process.memoryUsage().heapUsed;
    for (let i = 0; i < 30; i++) {
      global.gc();
      await new Promise(r => setImmediate(r));
      const curr = process.memoryUsage().heapUsed;
      if (Math.abs(curr - lastHeap) < 50_000) return curr;
      lastHeap = curr;
    }
    return lastHeap;
  };

  const start = await stableGc();

  // 1000 abort cascades. Each iteration: create client, start stream,
  // abort 90% of the way through, drop references. The worker stub's
  // pendingRequests/cancelledRequests sets must not retain anything.
  for (let i = 0; i < 1000; i++) {
    const client = makeStreamingClient();
    const ctrl = new AbortController();
    const stream = client.fetchStream(1000, 5, 1, ctrl.signal);
    const iter = stream[Symbol.asyncIterator]();
    // Pull 2 chunks then abort.
    await iter.next();
    await iter.next();
    ctrl.abort();
    // Give the stub's queued setTimeouts a chance to noop on the cancel.
    await new Promise(r => setImmediate(r));
  }

  const end = await stableGc();
  const growth = end - start;
  const growthMb = (growth / 1024 / 1024).toFixed(2);

  // 5 MB is a generous gate for 1000 iterations. A real retention bug
  // (every cascade keeping its AbortController / iterator state alive)
  // would balloon 1000 × ~10KB = ~10 MB easily.
  assert.ok(
    growth < 5 * 1024 * 1024,
    `heap grew ${growthMb} MB across 1000 abort cascades (limit 5 MB); possible leak`,
  );
});

test('interleave race: consumer skips draw after abort fires mid-body', async () => {
  // Locks down the viewer.js defensive recheck: even when a chunk has been
  // dequeued and the body has started processing, if the abort signal flips
  // BEFORE the body reaches its paint call, the paint must be skipped. This
  // simulates the rare-but-real scenario where a chunk arrives via the
  // iterator's _queue path (back-to-back enqueues from the worker), the body
  // does some pre-paint work that includes an async edge, abort fires during
  // that edge, and the body resumes to paint a stale frame from the now-
  // superseded controller.
  const ctrl = new AbortController();
  const queue = [{ id: 1 }, { id: 2 }];
  // Manual async iterator over a synchronous queue — each next() resolves on
  // a microtask, so the for-await body gets a clean yield point.
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length === 0) return Promise.resolve({ value: undefined, done: true });
          return Promise.resolve({ value: queue.shift(), done: false });
        },
      };
    },
  };

  const paints = [];
  let firedAbortInBody = false;
  const consume = (async () => {
    try {
      for await (const chunk of stream) {
        if (ctrl.signal.aborted) break;
        // Simulated pre-paint async edge. The real viewer body is sync today,
        // but a tiny await opens the window in which an abort firing
        // concurrently must still be honored.
        await Promise.resolve();
        // While processing the FIRST chunk, fire the abort. The defensive
        // recheck below MUST observe it and skip the paint.
        if (!firedAbortInBody) {
          firedAbortInBody = true;
          ctrl.abort();
        }
        // Defensive recheck — this is the contract the fix enforces.
        if (ctrl.signal.aborted) break;
        paints.push(chunk.id);
      }
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
    }
  })();

  await consume;

  // Chunk 1's body started, fired abort, then the recheck caught it → no paint.
  // Chunk 2 was queued but the top-of-iteration check stops it.
  assert.deepEqual(paints, [], `expected no paints after abort; got ${JSON.stringify(paints)}`);
});
