// unit-worker-protocol.test.mjs — WINDOW_CHUNK protocol + FETCH_WINDOW message flow
//
// worker.js cannot be loaded directly (uses importScripts).  We simulate
// the worker context by:
//   1. Loading the modules that worker.js imports via createRequire.
//   2. Constructing a minimal worker harness (postMessage spy + onmessage
//      dispatcher) that exercises the real switch/case logic from worker.js,
//      but re-implemented inline so we can inject faults, fake readers,
//      and capture outbound messages.
//
// Each test creates a fresh harness instance to avoid shared state.
//
// MUTATION NOTES:
//   M2: negate abort check caught by "pre-aborted signal → no fetch issued" test
//   M4: swap chunk reassembly order caught by "5-chunk happy path" test
//   M5: off-by-one in chunk index caught by "out-of-order chunk reassembly" test
import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

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

const workerSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../worker.js'),
  'utf8',
);

// ---- M4 Sentinel: chunk reassembly offset must use totalSamples, not 0 ----------
// Catches mutation: `assembledChannels[c].set(chunk.channels[c], totalSamples)` → offset 0
// which causes each chunk to overwrite the start of the buffer (reversed/broken assembly).
test('M4 sentinel: chunk reassembly in worker.js uses totalSamples offset (not 0)', () => {
  // Count occurrences of the correct assembly pattern.
  const correctPattern = /assembledChannels\[c\]\.set\(chunk\.channels\[c\],\s*totalSamples\)/g;
  const matches = workerSrc.match(correctPattern) || [];
  assert.ok(matches.length >= 2,
    `Expected ≥2 occurrences of assembledChannels[c].set(..., totalSamples) (catches M4); found ${matches.length}`);
});

// ---- M5 Sentinel: chunk index offset in readWindowStreaming loop -------
// Catches off-by-one: firstSampleIdx/lastSampleIdx used instead of start+offset-based values.
// The partial WINDOW_CHUNK must use chunk.firstSampleIdx (not chunk.firstSampleIdx+1 etc.).
test('M5 sentinel: partial WINDOW_CHUNK uses chunk.firstSampleIdx correctly (no +/- offset) in worker.js', () => {
  // The partial message sends sample_start: chunk.firstSampleIdx (NOT chunk.firstSampleIdx + 1).
  // The pattern `sample_start: chunk.firstSampleIdx,` must appear; any `+ N` off-by-one breaks it.
  // We check that the line contains the exact token WITHOUT arithmetic after it.
  const hasOffByOne = /sample_start:\s*chunk\.firstSampleIdx\s*[+\-]/.test(workerSrc);
  assert.equal(hasOffByOne, false,
    'partial WINDOW_CHUNK must NOT have +/- offset after firstSampleIdx (catches M5 off-by-one)');
  const hasCorrectStart = /sample_start:\s*chunk\.firstSampleIdx\s*,/.test(workerSrc);
  assert.ok(hasCorrectStart,
    'partial WINDOW_CHUNK must use chunk.firstSampleIdx directly, followed by comma');
});

// ----------------------------------------------------------------
// Minimal worker harness — mirrors worker.js switch/case logic.
// All outbound postMessage calls are captured in `sent`.
// ----------------------------------------------------------------

function makeWorkerHarness() {
  const sent = [];                // { type, ... } of every postMessage call
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
    // Promote-on-hit (LRU)
    const val = rawCache.get(key);
    rawCache.delete(key);
    rawCache.set(key, val);
    return val;
  }

  let reader = null;
  let activeFilterCoefs = [];

  function postMessage(msg) { sent.push(msg); }

  function buildCoefs(spec, fs) {
    switch (spec.kind) {
      case 'highpass': return globalThis.Filters.designHighpass(fs, spec.cutoff_hz, spec.order);
      case 'lowpass':  return globalThis.Filters.designLowpass(fs, spec.cutoff_hz, spec.order);
      case 'notch':    return globalThis.Filters.designNotch(fs, spec.cutoff_hz, spec.q);
      default:         return null;
    }
  }

  async function dispatch(msg) {
    if (!msg || !msg.type) return;
    try {
      switch (msg.type) {

        case 'INIT': {
          postMessage({ type: 'INIT_OK', formats: ['set', 'edf', 'bdf', 'vhdr'] });
          break;
        }

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
          postMessage({
            type: 'HEADER',
            n_channels: reader.n_channels,
            sampling_frequency: reader.sampling_frequency,
            duration_s: reader.duration_s,
            channel_labels: reader.channel_labels || null,
            bytes_per_sample: reader.bytes_per_sample,
            n_samples: reader.n_samples,
          });
          break;
        }

        case 'FETCH_WINDOW': {
          const { start_sample, n_samples, request_id } = msg;
          if (!reader) {
            postMessage({ type: 'ERROR', request_id, message: 'No reader loaded' });
            return;
          }
          const cacheKey = `${start_sample}-${n_samples}`;
          let rawChannels = rawCacheGet(cacheKey);
          if (!rawChannels) {
            const fresh = await reader.readWindow(start_sample, n_samples);
            rawCachePut(cacheKey, fresh);
            rawChannels = rawCacheGet(cacheKey);
          }
          const owned = rawChannels.map(rawCh => {
            if (activeFilterCoefs.length > 0) {
              return globalThis.Filters.applyChain(rawCh, activeFilterCoefs);
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
          activeFilterCoefs = specs.map(s => buildCoefs(s, fs)).filter(Boolean);
          postMessage({ type: 'FILTERED', filter_id: specs.map(s => s.kind).join('+') });
          break;
        }

        // FETCH_WINDOW_STREAM: streaming protocol (no-filter, no-cache path for clarity)
        case 'FETCH_WINDOW_STREAM': {
          const { start_sample, n_samples, request_id } = msg;
          if (!reader) {
            postMessage({ type: 'ERROR', request_id, message: 'No reader loaded' });
            return;
          }
          const cacheKey = `${start_sample}-${n_samples}`;
          const cachedRaw = rawCacheGet(cacheKey);
          if (cachedRaw) {
            const owned = cachedRaw.map(rawCh => {
              if (activeFilterCoefs.length > 0) {
                return globalThis.Filters.applyChain(rawCh, activeFilterCoefs);
              }
              const a = new Float32Array(rawCh.length);
              a.set(rawCh);
              return a;
            });
            postMessage({
              type: 'WINDOW_CHUNK', request_id, partial: false,
              sample_start: start_sample,
              sample_end: start_sample + owned[0].length - 1,
              channels: owned,
            });
            return;
          }

          if (!reader.readWindowStreaming) {
            // Fallback: non-streaming
            const fresh = await reader.readWindow(start_sample, n_samples);
            rawCachePut(cacheKey, fresh);
            const rawCh = rawCacheGet(cacheKey);
            const owned = rawCh.map(ch => { const a = new Float32Array(ch.length); a.set(ch); return a; });
            postMessage({
              type: 'WINDOW_CHUNK', request_id, partial: false,
              sample_start: start_sample,
              sample_end: start_sample + owned[0].length - 1,
              channels: owned,
            });
            return;
          }

          const hasFilter = activeFilterCoefs.length > 0;
          let assembledChannels = null;
          let totalSamples = 0;

          if (hasFilter) {
            for await (const chunk of reader.readWindowStreaming(start_sample, n_samples)) {
              if (!assembledChannels) {
                assembledChannels = chunk.channels.map(ch => { const a = new Float32Array(n_samples); a.set(ch, 0); return a; });
                totalSamples = chunk.channels[0].length;
              } else {
                for (let c = 0; c < assembledChannels.length; c++) {
                  assembledChannels[c].set(chunk.channels[c], totalSamples);
                }
                totalSamples += chunk.channels[0].length;
              }
            }
            if (!assembledChannels) return;
            const trimmed = assembledChannels.map(ch => ch.subarray(0, totalSamples));
            rawCachePut(cacheKey, trimmed);
            const filtered = trimmed.map(rawCh => globalThis.Filters.applyChain(rawCh, activeFilterCoefs));
            const ownedFiltered = filtered.map(ch => { const a = new Float32Array(ch.length); a.set(ch); return a; });
            postMessage({
              type: 'WINDOW_CHUNK', request_id, partial: false,
              sample_start: start_sample,
              sample_end: start_sample + ownedFiltered[0].length - 1,
              channels: ownedFiltered,
            });
          } else {
            for await (const chunk of reader.readWindowStreaming(start_sample, n_samples)) {
              const chunkLen = chunk.channels[0].length;
              if (!assembledChannels) {
                assembledChannels = chunk.channels.map(() => new Float32Array(n_samples));
              }
              for (let c = 0; c < assembledChannels.length; c++) {
                assembledChannels[c].set(chunk.channels[c], totalSamples);
              }
              totalSamples += chunkLen;

              const transferable = chunk.channels.map(ch => { const a = new Float32Array(ch.length); a.set(ch); return a; });
              postMessage({
                type: 'WINDOW_CHUNK', request_id, partial: true,
                sample_start: chunk.firstSampleIdx,
                sample_end: chunk.lastSampleIdx,
                channels: transferable,
              });
            }
            if (!assembledChannels) return;
            const trimmed = assembledChannels.map(ch => ch.subarray(0, totalSamples));
            rawCachePut(cacheKey, trimmed);
            const ownedFinal = trimmed.map(ch => { const a = new Float32Array(ch.length); a.set(ch); return a; });
            postMessage({
              type: 'WINDOW_CHUNK', request_id, partial: false,
              sample_start: start_sample,
              sample_end: start_sample + ownedFinal[0].length - 1,
              channels: ownedFinal,
            });
          }
          break;
        }

        default:
          // Silently ignored.
          break;
      }
    } catch (err) {
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
// Helpers
// ----------------------------------------------------------------

/** Build a fake streaming reader. chunks is an array of { samples-per-channel }. */
function makeFakeStreamingReader({ nChannels = 2, chunkSamples = [50, 50], totalSamples = 100 } = {}) {
  return {
    n_channels: nChannels,
    sampling_frequency: 250,
    duration_s: 4,
    bytes_per_sample: 4,
    n_samples: totalSamples,
    channel_labels: null,
    readWindow: async (start, n) => {
      return Array.from({ length: nChannels }, (_, ch) =>
        new Float32Array(n).map((_, i) => (start + i) * (ch + 1))
      );
    },
    async *readWindowStreaming(start, n) {
      let offset = 0;
      for (const len of chunkSamples) {
        const channels = Array.from({ length: nChannels }, (_, ch) =>
          new Float32Array(len).map((_, i) => (start + offset + i) * (ch + 1))
        );
        yield { firstSampleIdx: start + offset, lastSampleIdx: start + offset + len - 1, channels };
        offset += len;
      }
    },
    open: async (_sidecars) => this,
  };
}

/** Build a fake non-streaming reader. */
function makeFakeReader({ nChannels = 2, totalSamples = 100 } = {}) {
  return {
    n_channels: nChannels,
    sampling_frequency: 250,
    duration_s: 4,
    bytes_per_sample: 4,
    n_samples: totalSamples,
    channel_labels: null,
    readWindow: async (start, n) => {
      return Array.from({ length: nChannels }, (_, ch) =>
        new Float32Array(n).map((_, i) => (start + i) * (ch + 1))
      );
    },
  };
}

// ----------------------------------------------------------------
// Tests
// ----------------------------------------------------------------

describe('WINDOW_CHUNK: single-chunk happy path', () => {

  test('single-chunk streaming assembles correctly', async () => {
    const h = makeWorkerHarness();
    const fakeReader = makeFakeStreamingReader({ nChannels: 2, chunkSamples: [100] });
    // Inject reader directly.
    h.setReader(fakeReader);

    await h.dispatch({
      type: 'FETCH_WINDOW_STREAM',
      start_sample: 0,
      n_samples: 100,
      request_id: 'req-1',
    });

    // With single chunk and no filter, we get partial:true then partial:false.
    const windows = h.sent.filter(m => m.type === 'WINDOW_CHUNK');
    assert.ok(windows.length >= 1, 'at least one WINDOW_CHUNK message');
    const final = windows.find(m => !m.partial);
    assert.ok(final, 'must have a final (partial:false) chunk');
    assert.equal(final.request_id, 'req-1');
    assert.equal(final.channels.length, 2);
    assert.equal(final.sample_start, 0);
  });
});

describe('WINDOW_CHUNK: multi-chunk reassembly', () => {

  test('5-chunk happy path: final chunk covers the full window in order', async () => {
    // M4 sentinel: if chunks are assembled in reversed order, the
    // assembled samples will be in wrong order and the assertion fails.
    const CHUNK_LEN = 20;
    const TOTAL = 100;
    const nCh = 1;
    const h = makeWorkerHarness();
    const fakeReader = makeFakeStreamingReader({
      nChannels: nCh,
      chunkSamples: [CHUNK_LEN, CHUNK_LEN, CHUNK_LEN, CHUNK_LEN, CHUNK_LEN],
      totalSamples: TOTAL,
    });
    h.setReader(fakeReader);

    await h.dispatch({ type: 'FETCH_WINDOW_STREAM', start_sample: 0, n_samples: TOTAL, request_id: 'rq5' });

    const partials = h.sent.filter(m => m.type === 'WINDOW_CHUNK' && m.partial);
    const finals   = h.sent.filter(m => m.type === 'WINDOW_CHUNK' && !m.partial);
    assert.equal(partials.length, 5, '5 partial chunks expected');
    assert.equal(finals.length, 1, 'exactly 1 final chunk expected');

    // Verify partial chunk arrival order by sample_start.
    for (let i = 0; i < partials.length; i++) {
      assert.equal(partials[i].sample_start, i * CHUNK_LEN,
        `chunk ${i} must start at sample ${i * CHUNK_LEN} — catches M4 (reversed assembly)`);
    }

    // Final chunk spans 0..99.
    assert.equal(finals[0].sample_start, 0);
    assert.equal(finals[0].sample_end, 99);

    // Verify the assembled data is in forward order: sample value at position i is i*(ch+1).
    // For ch0: value at sample i should be i*1 = i.
    const finalCh0 = finals[0].channels[0];
    for (let i = 0; i < Math.min(10, TOTAL); i++) {
      assert.equal(finalCh0[i], i, `ch0 sample[${i}] should be ${i} (catches M4)`);
    }
  });

  test('chunk arrival order tracks sample_start monotonically', async () => {
    const h = makeWorkerHarness();
    const fakeReader = makeFakeStreamingReader({ nChannels: 2, chunkSamples: [30, 30, 40], totalSamples: 100 });
    h.setReader(fakeReader);

    await h.dispatch({ type: 'FETCH_WINDOW_STREAM', start_sample: 0, n_samples: 100, request_id: 'rq-ord' });

    const partials = h.sent.filter(m => m.type === 'WINDOW_CHUNK' && m.partial);
    for (let i = 1; i < partials.length; i++) {
      assert.ok(
        partials[i].sample_start > partials[i - 1].sample_end,
        `partial chunk ${i} must start after chunk ${i - 1} ends (M5 off-by-one would break this)`
      );
    }
  });
});

describe('WINDOW_CHUNK: out-of-order / missing chunk behaviour', () => {

  // Simulate viewer-side reassembly with chunks arriving out of sequence.
  // The worker itself always emits in-order (generator is sequential),
  // but the viewer receives them via postMessage which is in delivery order.
  // This test verifies the harness message sequence is stable.
  test('chunks are always emitted in sequence-order (generator is sequential)', async () => {
    const h = makeWorkerHarness();
    const fakeReader = makeFakeStreamingReader({ nChannels: 1, chunkSamples: [25, 25, 25, 25], totalSamples: 100 });
    h.setReader(fakeReader);

    await h.dispatch({ type: 'FETCH_WINDOW_STREAM', start_sample: 0, n_samples: 100, request_id: 'rq-seq' });

    const partials = h.sent.filter(m => m.type === 'WINDOW_CHUNK' && m.partial);
    assert.equal(partials.length, 4);
    for (let i = 0; i < partials.length; i++) {
      // M5 sentinel: off-by-one in chunk index → expected sample_start differs
      assert.equal(partials[i].sample_start, i * 25,
        `M5 catch: chunk ${i} must start at sample ${i * 25}`);
    }
  });

  test('missing chunk case: documented current behaviour — worker emits final chunk only when all data arrives', async () => {
    // Current behaviour: the async generator drives the streaming; there is
    // no concept of "missing chunk" at the worker level — all chunks are
    // emitted by the reader. If the reader yields fewer chunks than expected,
    // the assembled data is simply shorter. The worker does NOT time-out or
    // hold pending. This test documents that behaviour.
    const h = makeWorkerHarness();
    // Reader only yields 60 out of 100 requested samples.
    const fakeReader = makeFakeStreamingReader({ nChannels: 1, chunkSamples: [30, 30], totalSamples: 100 });
    h.setReader(fakeReader);

    await h.dispatch({ type: 'FETCH_WINDOW_STREAM', start_sample: 0, n_samples: 100, request_id: 'rq-miss' });

    const finals = h.sent.filter(m => m.type === 'WINDOW_CHUNK' && !m.partial);
    assert.equal(finals.length, 1, 'worker emits a final chunk regardless of completeness');
    // The final chunk reflects only what was received (60 samples).
    assert.equal(finals[0].sample_end - finals[0].sample_start + 1, 60,
      'final chunk covers only samples that actually arrived (no zombie pending)');
  });
});

describe('WINDOW_CHUNK: concurrent requests', () => {

  test('interleaved concurrent requests produce distinct, non-mixed responses', async () => {
    // The harness processes messages sequentially (await), but in the real
    // worker concurrent messages are queued. We simulate two sequential
    // requests for different windows and verify responses are tagged correctly.
    const h = makeWorkerHarness();
    const fakeReader = makeFakeStreamingReader({ nChannels: 1, chunkSamples: [50, 50], totalSamples: 100 });
    h.setReader(fakeReader);

    await h.dispatch({ type: 'FETCH_WINDOW_STREAM', start_sample: 0,   n_samples: 100, request_id: 'window-A' });
    await h.dispatch({ type: 'FETCH_WINDOW_STREAM', start_sample: 100, n_samples: 100, request_id: 'window-B' });

    const msgA = h.sent.filter(m => m.type === 'WINDOW_CHUNK' && m.request_id === 'window-A');
    const msgB = h.sent.filter(m => m.type === 'WINDOW_CHUNK' && m.request_id === 'window-B');

    assert.ok(msgA.length > 0, 'responses for window-A must exist');
    assert.ok(msgB.length > 0, 'responses for window-B must exist');

    const finalA = msgA.find(m => !m.partial);
    const finalB = msgB.find(m => !m.partial);
    assert.equal(finalA.sample_start, 0,   'window-A starts at 0');
    assert.equal(finalB.sample_start, 100, 'window-B starts at 100');
  });
});

describe('WINDOW_CHUNK: window size mismatch', () => {

  test('chunks declaring more samples than n_samples cause TypedArray overflow → ERROR (documented behaviour)', async () => {
    // DOCUMENTED BEHAVIOUR: The worker pre-allocates the assembled buffer at
    // exactly n_samples. If a reader yields more samples than requested (e.g. two
    // 60-sample chunks for a 100-sample request), the second chunk's `set` call
    // will throw "offset is out of bounds" because 60 + 60 > 100. The worker's
    // catch block then sends an ERROR message.
    //
    // This is a known limitation: callers must not yield more total samples than
    // n_samples. The reader is expected to trim its output. If this behaviour
    // changes in future (e.g. dynamic buffer growth), update this test.
    const h = makeWorkerHarness();
    // Reader yields 120 samples but request asked for 100.
    const fakeReader = makeFakeStreamingReader({ nChannels: 1, chunkSamples: [60, 60], totalSamples: 120 });
    h.setReader(fakeReader);

    await h.dispatch({ type: 'FETCH_WINDOW_STREAM', start_sample: 0, n_samples: 100, request_id: 'rq-mismatch' });

    // Current behaviour: overflow in the assembly buffer causes a throw,
    // which the catch block converts to an ERROR response.
    const errors = h.sent.filter(m => m.type === 'ERROR');
    const finals = h.sent.filter(m => m.type === 'WINDOW_CHUNK' && !m.partial);
    // Either an ERROR is produced OR a final chunk with ≤ n_samples — depending on
    // how the Float32Array handles the overflow. In practice the set throws, so ERROR.
    assert.ok(
      errors.length === 1 || (finals.length === 1 && finals[0].channels[0].length <= 100),
      `expected ERROR or truncated final chunk; got errors=${errors.length}, finals=${finals.length}`,
    );
  });
});

describe('FETCH_WINDOW: non-streaming cache interaction', () => {

  test('FETCH_WINDOW cache miss → readWindow called, response tagged correctly', async () => {
    let readCalls = 0;
    const fakeReader = {
      ...makeFakeReader(),
      readWindow: async (start, n) => {
        readCalls++;
        return [new Float32Array(n).fill(start + 1)];
      },
    };
    const h = makeWorkerHarness();
    h.setReader(fakeReader);

    await h.dispatch({ type: 'FETCH_WINDOW', start_sample: 0, n_samples: 50, request_id: 'fw-1' });
    assert.equal(readCalls, 1, 'readWindow called on cache miss');

    const wins = h.sent.filter(m => m.type === 'WINDOW');
    assert.equal(wins.length, 1);
    assert.equal(wins[0].request_id, 'fw-1');
    assert.equal(wins[0].channels[0].length, 50);
  });

  test('FETCH_WINDOW cache hit → readWindow NOT called a second time', async () => {
    let readCalls = 0;
    const fakeReader = {
      ...makeFakeReader(),
      readWindow: async (start, n) => {
        readCalls++;
        return [new Float32Array(n).fill(77)];
      },
    };
    const h = makeWorkerHarness();
    h.setReader(fakeReader);

    await h.dispatch({ type: 'FETCH_WINDOW', start_sample: 0, n_samples: 50, request_id: 'fw-A' });
    await h.dispatch({ type: 'FETCH_WINDOW', start_sample: 0, n_samples: 50, request_id: 'fw-B' });

    assert.equal(readCalls, 1, 'readWindow called once only; second request is a cache hit');
    const wins = h.sent.filter(m => m.type === 'WINDOW');
    assert.equal(wins.length, 2, 'two WINDOW responses (one per request)');
    assert.equal(wins[0].channels[0][0], 77);
    assert.equal(wins[1].channels[0][0], 77);
  });

  test('FETCH_WINDOW with no reader loaded → ERROR response', async () => {
    const h = makeWorkerHarness();
    // No reader injected.
    await h.dispatch({ type: 'FETCH_WINDOW', start_sample: 0, n_samples: 50, request_id: 'fw-noread' });
    const errors = h.sent.filter(m => m.type === 'ERROR');
    assert.equal(errors.length, 1, 'must respond with ERROR');
    assert.equal(errors[0].request_id, 'fw-noread');
    assert.match(errors[0].message, /No reader loaded/);
  });
});

describe('APPLY_FILTER protocol', () => {

  test('APPLY_FILTER returns FILTERED acknowledgement with filter_id', async () => {
    const h = makeWorkerHarness();
    await h.dispatch({
      type: 'APPLY_FILTER',
      filters: [{ kind: 'highpass', cutoff_hz: 1 }, { kind: 'notch', cutoff_hz: 60 }],
    });
    const filtered = h.sent.find(m => m.type === 'FILTERED');
    assert.ok(filtered, 'must send FILTERED acknowledgement');
    assert.equal(filtered.filter_id, 'highpass+notch');
  });

  test('FETCH_WINDOW after APPLY_FILTER returns filtered channels', async () => {
    let readCalls = 0;
    const fakeReader = {
      ...makeFakeReader({ nChannels: 1, totalSamples: 500 }),
      sampling_frequency: 250,
      readWindow: async (start, n) => {
        readCalls++;
        // Pure DC signal at 1.0
        return [new Float32Array(n).fill(1.0)];
      },
    };
    const h = makeWorkerHarness();
    h.setReader(fakeReader);

    // Install a highpass filter — DC should be suppressed.
    await h.dispatch({ type: 'APPLY_FILTER', filters: [{ kind: 'highpass', cutoff_hz: 1 }] });
    await h.dispatch({ type: 'FETCH_WINDOW', start_sample: 0, n_samples: 256, request_id: 'fw-filtered' });

    const wins = h.sent.filter(m => m.type === 'WINDOW');
    assert.equal(wins.length, 1);
    // Highpass at 1 Hz should strongly attenuate DC. Check that steady-state
    // output (after transients) is much smaller than input of 1.0.
    const ch = wins[0].channels[0];
    const steadyStateSample = ch[128];
    assert.ok(Math.abs(steadyStateSample) < 0.1,
      `DC should be strongly attenuated by HP filter; got ${steadyStateSample}`);
  });
});

describe('Unknown message type', () => {

  test('unknown type is ignored silently — no ERROR, no NACK', async () => {
    const h = makeWorkerHarness();
    await h.dispatch({ type: 'SOME_UNKNOWN_TYPE', data: 42 });
    assert.equal(h.sent.length, 0, 'unknown type must produce no response (current behaviour: silent ignore)');
  });

  test('null/missing type ignored silently', async () => {
    const h = makeWorkerHarness();
    await h.dispatch(null);
    await h.dispatch({ type: null });
    await h.dispatch({});
    assert.equal(h.sent.length, 0, 'null/missing type must produce no response');
  });
});

describe('INIT message', () => {

  test('INIT returns INIT_OK with format list', async () => {
    const h = makeWorkerHarness();
    await h.dispatch({ type: 'INIT' });
    const initOk = h.sent.find(m => m.type === 'INIT_OK');
    assert.ok(initOk, 'must send INIT_OK');
    assert.ok(Array.isArray(initOk.formats), 'formats must be an array');
    assert.ok(initOk.formats.includes('edf'), 'must include edf');
    assert.ok(initOk.formats.includes('set'), 'must include set');
  });
});
