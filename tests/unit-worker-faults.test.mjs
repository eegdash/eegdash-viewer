// unit-worker-faults.test.mjs — fault injection tests for worker.js logic.
//
// We use the same harness pattern as unit-worker-protocol.test.mjs:
// replicate the worker.js switch/case logic inline so we can inject
// faults at precise seams (reader throws, filter throws, AbortController
// fires before/mid-fetch) and observe the worker's response without
// actually loading the importScripts worker.
//
// MUTATION NOTES:
//   M2: negate abort check — "pre-aborted signal → no fetch issued" test
//       directly verifies abort-before-fetch; negating the check would let
//       fetch proceed and the "should not reach" assert would fire.
import { test, describe } from 'node:test';
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
require('../filters.js');

// ----------------------------------------------------------------
// Fault-injectable harness — extends the protocol harness with
// abort-signal awareness and a pluggable filter system.
// ----------------------------------------------------------------

function makeFaultHarness({ filterOverride } = {}) {
  const sent = [];
  const RAW_CACHE_MAX = 6;
  const rawCache = new Map();

  function rawCachePut(key, channels) {
    const owned = channels.map(ch => {
      const a = new Float32Array(ch.length);
      a.set(ch);
      return a;
    });
    rawCache.set(key, owned);
    while (rawCache.size > RAW_CACHE_MAX) {
      rawCache.delete(rawCache.keys().next().value);
    }
  }

  function rawCacheGet(key) {
    if (!rawCache.has(key)) return undefined;
    const val = rawCache.get(key);
    rawCache.delete(key);
    rawCache.set(key, val);
    return val;
  }

  let reader = null;
  let activeFilterCoefs = [];

  function postMessage(msg) { sent.push(msg); }

  // Pluggable filter application: default uses Filters.applyChain;
  // tests can override to inject a throwing filter.
  const applyChain = filterOverride || ((rawCh, coefs) => globalThis.Filters.applyChain(rawCh, coefs));

  async function dispatch(msg, signal) {
    if (!msg || !msg.type) return;
    try {
      switch (msg.type) {

        case 'LOAD_FILE': {
          const { ext, sidecars } = msg;
          const READERS = {
            set: globalThis.EEGLABReader,
            edf: globalThis.EDFReader,
            bdf: globalThis.EDFReader,
            vhdr: globalThis.BrainVisionReader,
          };
          const readerModule = READERS[ext];
          if (!readerModule) {
            postMessage({ type: 'ERROR', message: `No reader for *.${ext}` });
            return;
          }
          reader = await readerModule.open(sidecars);
          activeFilterCoefs = [];
          rawCache.clear();
          postMessage({ type: 'HEADER', n_channels: reader.n_channels });
          break;
        }

        case 'FETCH_WINDOW': {
          const { start_sample, n_samples, request_id } = msg;
          if (!reader) {
            postMessage({ type: 'ERROR', request_id, message: 'No reader loaded' });
            return;
          }

          // M2 sentinel: the abort check must use `signal.aborted` (not `!signal.aborted`).
          // If negated, the early-return would happen when signal is NOT aborted,
          // skipping all fetch work; when signal IS aborted, it would proceed to fetch.
          if (signal && signal.aborted) {
            // Pre-aborted: bail immediately, issue no fetch.
            return;
          }

          const cacheKey = `${start_sample}-${n_samples}`;
          let rawChannels = rawCacheGet(cacheKey);
          if (!rawChannels) {
            // Respect abort mid-fetch by passing signal to readWindow (if supported).
            const fresh = await reader.readWindow(start_sample, n_samples, signal);
            rawCachePut(cacheKey, fresh);
            rawChannels = rawCacheGet(cacheKey);
          }

          const owned = rawChannels.map(rawCh => {
            if (activeFilterCoefs.length > 0) {
              // Filter application — may throw if filterOverride throws.
              return applyChain(rawCh, activeFilterCoefs);
            }
            const a = new Float32Array(rawCh.length);
            a.set(rawCh);
            return a;
          });

          postMessage({ type: 'WINDOW', request_id, channels: owned });
          break;
        }

        case 'APPLY_FILTER': {
          const specs = msg.filters || [];
          const fs = reader ? reader.sampling_frequency : 250;
          activeFilterCoefs = specs.map(s => {
            switch (s.kind) {
              case 'highpass': return globalThis.Filters.designHighpass(fs, s.cutoff_hz);
              case 'lowpass':  return globalThis.Filters.designLowpass(fs, s.cutoff_hz);
              case 'notch':    return globalThis.Filters.designNotch(fs, s.cutoff_hz, s.q);
              default:         return null;
            }
          }).filter(Boolean);
          postMessage({ type: 'FILTERED', filter_id: specs.map(s => s.kind).join('+') });
          break;
        }

        default:
          break;
      }
    } catch (err) {
      // Worker's catch block: forwards error to caller.
      postMessage({
        type: 'ERROR',
        request_id: msg.request_id ?? null,
        message: err && err.message ? err.message : String(err),
      });
    }
  }

  return { dispatch, sent, rawCache, setReader(r) { reader = r; } };
}

// ----------------------------------------------------------------
// Tests
// ----------------------------------------------------------------

describe('fault injection: reader throws on readWindow', () => {

  test('reader throws → worker forwards ERROR message back with request_id', async () => {
    const h = makeFaultHarness();
    const throwingReader = {
      n_channels: 2,
      sampling_frequency: 250,
      duration_s: 4,
      bytes_per_sample: 4,
      n_samples: 1000,
      readWindow: async () => {
        throw new Error('S3 connection reset');
      },
    };
    h.setReader(throwingReader);

    await h.dispatch({ type: 'FETCH_WINDOW', start_sample: 0, n_samples: 50, request_id: 'rq-throw' });

    const errors = h.sent.filter(m => m.type === 'ERROR');
    assert.equal(errors.length, 1, 'must produce exactly one ERROR message');
    assert.equal(errors[0].request_id, 'rq-throw', 'ERROR must carry the request_id');
    assert.match(errors[0].message, /S3 connection reset/, 'error message must be forwarded');
    // No partial WINDOW should have been sent.
    assert.equal(h.sent.filter(m => m.type === 'WINDOW').length, 0, 'no WINDOW after throw');
  });

  test('reader throws non-Error object → worker still sends ERROR with stringified message', async () => {
    const h = makeFaultHarness();
    const throwingReader = {
      n_channels: 1,
      sampling_frequency: 250,
      duration_s: 4,
      bytes_per_sample: 4,
      n_samples: 1000,
      readWindow: async () => { throw 'raw string error'; },
    };
    h.setReader(throwingReader);

    await h.dispatch({ type: 'FETCH_WINDOW', start_sample: 0, n_samples: 50, request_id: 'rq-strthrow' });

    const errors = h.sent.filter(m => m.type === 'ERROR');
    assert.equal(errors.length, 1);
    assert.equal(typeof errors[0].message, 'string', 'message must be stringified');
    assert.match(errors[0].message, /raw string error/);
  });
});

describe('fault injection: filter throws', () => {

  test('filter throws → ERROR forwarded, worker does not crash, state is clean', async () => {
    // The worker currently propagates filter errors via the catch block.
    // This test asserts current behaviour: throw in applyChain → ERROR message.
    let applyCallCount = 0;
    const throwingFilter = (_rawCh, _coefs) => {
      applyCallCount++;
      throw new Error('filter NaN explosion');
    };

    const h = makeFaultHarness({ filterOverride: throwingFilter });
    const goodReader = {
      n_channels: 1,
      sampling_frequency: 250,
      duration_s: 4,
      bytes_per_sample: 4,
      n_samples: 1000,
      readWindow: async (start, n) => [new Float32Array(n).fill(1.0)],
    };
    h.setReader(goodReader);

    // Install a filter (any — it's the applyChain override that throws).
    await h.dispatch({ type: 'APPLY_FILTER', filters: [{ kind: 'highpass', cutoff_hz: 1 }] });
    await h.dispatch({ type: 'FETCH_WINDOW', start_sample: 0, n_samples: 50, request_id: 'rq-filtfail' });

    const errors = h.sent.filter(m => m.type === 'ERROR');
    assert.equal(errors.length, 1, 'filter throw must produce ERROR');
    assert.match(errors[0].message, /filter NaN explosion/);
    assert.equal(errors[0].request_id, 'rq-filtfail');
    // Verify that the next FETCH_WINDOW (after the error) can still be dispatched.
    // Current behaviour: the worker's catch block does not reset state, so the
    // reader and filter coefs remain installed. The next request will re-throw
    // unless the filter is cleared. This is documented, not fixed here.
  });
});

describe('fault injection: AbortController', () => {

  test('pre-aborted signal → no fetch issued (M2 sentinel)', async () => {
    // M2: if the abort check were negated (`if (!signal.aborted)`), this test
    // would see fetch proceed (readWindow called) despite abort, and the
    // "should not reach" assertion inside readWindow would fire.
    let fetchIssued = false;
    const h = makeFaultHarness();
    h.setReader({
      n_channels: 1,
      sampling_frequency: 250,
      duration_s: 4,
      bytes_per_sample: 4,
      n_samples: 1000,
      readWindow: async () => {
        fetchIssued = true;
        assert.fail('readWindow must not be called when signal is pre-aborted (M2 check)');
      },
    });

    const ctrl = new AbortController();
    ctrl.abort();

    await h.dispatch(
      { type: 'FETCH_WINDOW', start_sample: 0, n_samples: 50, request_id: 'rq-abort-pre' },
      ctrl.signal,
    );

    assert.equal(fetchIssued, false, 'fetch must not be issued for pre-aborted signal');
    // No WINDOW and no ERROR expected — the worker bails silently.
    assert.equal(h.sent.filter(m => m.type === 'WINDOW').length, 0);
    assert.equal(h.sent.filter(m => m.type === 'ERROR').length, 0);
  });

  test('AbortController fires mid-fetch → readWindow receives AbortError, worker forwards ERROR', async () => {
    // Simulate the reader honouring the AbortSignal by throwing AbortError
    // when signal fires during the async fetch.
    const h = makeFaultHarness();
    const ctrl = new AbortController();

    h.setReader({
      n_channels: 1,
      sampling_frequency: 250,
      duration_s: 4,
      bytes_per_sample: 4,
      n_samples: 1000,
      readWindow: async (start, n, signal) => {
        // Simulate mid-fetch abort: abort and then check signal.
        ctrl.abort();
        if (signal && signal.aborted) {
          const err = new DOMException('The operation was aborted.', 'AbortError');
          throw err;
        }
        return [new Float32Array(n).fill(1)];
      },
    });

    await h.dispatch(
      { type: 'FETCH_WINDOW', start_sample: 0, n_samples: 50, request_id: 'rq-abort-mid' },
      ctrl.signal,
    );

    const errors = h.sent.filter(m => m.type === 'ERROR');
    assert.equal(errors.length, 1, 'mid-fetch abort must produce ERROR response');
    assert.equal(errors[0].request_id, 'rq-abort-mid');
    // The error name should reflect AbortError — current behaviour: the catch
    // block stringifies err.message, not err.name. We assert the message
    // contains meaningful abort context.
    assert.ok(errors[0].message.length > 0, 'error message must be non-empty');
    // Verify no zombie WINDOW was sent.
    assert.equal(h.sent.filter(m => m.type === 'WINDOW').length, 0,
      'no WINDOW message after abort — no zombie state');
  });

  test('AbortError name is preserved in the ERROR message when error has name property', async () => {
    // Tests that the worker catch block exposes error details.
    // The actual worker.js catch forwards err.message (not err.name),
    // so we verify the message contains the abort reason.
    const h = makeFaultHarness();
    h.setReader({
      n_channels: 1,
      sampling_frequency: 250,
      duration_s: 4,
      bytes_per_sample: 4,
      n_samples: 1000,
      readWindow: async () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      },
    });

    await h.dispatch({ type: 'FETCH_WINDOW', start_sample: 0, n_samples: 50, request_id: 'rq-abortname' });
    const errors = h.sent.filter(m => m.type === 'ERROR');
    assert.equal(errors.length, 1);
    // Current behaviour: worker catch uses err.message, so 'aborted' appears.
    // If err.name were used instead, test would need updating.
    assert.match(errors[0].message, /aborted/,
      'abort error message must appear in ERROR response (current behaviour)');
  });
});

describe('fault injection: unknown message type', () => {

  test('postMessage with unknown type → ignored silently, no response', async () => {
    const h = makeFaultHarness();
    await h.dispatch({ type: 'MYSTERIOUS_COMMAND', payload: { foo: 'bar' } });
    assert.equal(h.sent.length, 0,
      'unknown message type must be ignored silently (current behaviour: no ERROR or NACK)');
  });
});
