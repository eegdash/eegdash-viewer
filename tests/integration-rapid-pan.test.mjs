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
