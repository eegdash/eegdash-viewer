// Tinybench-based version of worker-cache.bench.mjs.
//
// Replicates the worker.js cache + dedup logic in-process and measures
// (a) upstream fetches saved by LRU promote-on-hit vs FIFO during a
//     scrub-replay pan pattern,
// (b) upstream fetches saved by inflight dedup of concurrent same-window
//     requests.
//
// Each task simulates one pan/replay cycle; tinybench samples enough of
// them to give mean ± RME. Upstream fetch counts are deterministic for
// a fresh cache, so they're not part of the statistical output — they're
// dumped to the rich JSON's `extra` field via a side channel.
//
// Output: bench/results-worker-cache.json + bench/results-worker-cache-gab.json.

import { performance } from 'node:perf_hooks';

import { makeBench, runAndEmit } from './_harness.mjs';

const SIM_FETCH_MS = 30;     // simulated upstream latency per fetch
const CACHE_MAX = 6;          // matches RAW_CACHE_MAX in worker.js

function makeCache({ promoteOnHit }) {
  const cache = new Map();
  const inflight = new Map();
  let upstreamFetches = 0;

  function put(key, value) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > CACHE_MAX) {
      cache.delete(cache.keys().next().value);
    }
  }

  function get(key) {
    if (!cache.has(key)) return undefined;
    const v = cache.get(key);
    if (promoteOnHit) {
      cache.delete(key);
      cache.set(key, v);
    }
    return v;
  }

  async function fetchSimulated(key) {
    upstreamFetches++;
    await new Promise(r => setTimeout(r, SIM_FETCH_MS));
    return { key, ts: performance.now() };
  }

  async function request(key, { dedup }) {
    const hit = get(key);
    if (hit) return hit;
    if (dedup) {
      let p = inflight.get(key);
      if (!p) {
        p = (async () => {
          try {
            const v = await fetchSimulated(key);
            put(key, v);
            return get(key);
          } finally {
            inflight.delete(key);
          }
        })();
        inflight.set(key, p);
      }
      return p;
    }
    const v = await fetchSimulated(key);
    put(key, v);
    return get(key);
  }

  return { request, get stats() { return { upstreamFetches, size: cache.size }; } };
}

// Pan sequence: scrub forward, touch W0, continue, revisit W0.
// FIFO  → 9 upstream fetches.
// LRU   → 8 upstream fetches.
const SCRUB_THEN_REVISIT = ['W0','W1','W2','W3','W4','W5','W0','W6','W7','W0'];

async function benchScrubReplay(promoteOnHit) {
  const c = makeCache({ promoteOnHit });
  for (const k of SCRUB_THEN_REVISIT) {
    await c.request(k, { dedup: false });
  }
  return c.stats.upstreamFetches;
}

async function benchConcurrentDedup(dedup) {
  const c = makeCache({ promoteOnHit: true });
  await Promise.all(
    Array.from({ length: 5 }, () => c.request('W0', { dedup })),
  );
  return c.stats.upstreamFetches;
}

// ---- bench setup ------------------------------------------------

const bench = makeBench();

bench.add('cache_scrub_lru',           async () => { await benchScrubReplay(true);  });
bench.add('cache_scrub_fifo',          async () => { await benchScrubReplay(false); });
bench.add('cache_concurrent_dedup',    async () => { await benchConcurrentDedup(true);  });
bench.add('cache_concurrent_no_dedup', async () => { await benchConcurrentDedup(false); });

console.log('=== worker-cache.tinybench.mjs ===');
console.log(`SIM_FETCH_MS=${SIM_FETCH_MS}  CACHE_MAX=${CACHE_MAX}  ` +
            `BENCH_TIME=${process.env.BENCH_TIME || '1000'}ms`);

await runAndEmit(bench, 'bench/results-worker-cache.json', 'bench/results-worker-cache-gab.json');
