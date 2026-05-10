// worker-cache.bench.mjs — synthetic cache-behaviour benchmarks.
//
// Measures the gains from worker.js's LRU semantics + concurrent
// in-flight dedup. These wins don't show up in readwindow.bench.mjs
// because that bench is single-shot cold-cache. Here we simulate a
// realistic pan/replay cycle where an S3 "fetch" takes a fixed
// amount of time, and count both elapsed wall-time AND the number
// of upstream fetches issued.
//
// We replicate the worker's cache + dedup logic in-process — the
// worker itself can't be loaded under node:test (it's a Web Worker
// that uses importScripts). The replica mirrors the production code
// exactly; the unit-worker-cache.test.mjs sentinels guarantee the
// production code matches.
//
// Output is appended to bench/baseline.json by the harness.

import { performance } from 'node:perf_hooks';

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
      // Re-insert to MRU tail.
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

// Pan cycle: visit windows W0..W9 then return to W0..W2 (a common
// "scrub forward, then back" interaction). With CACHE_MAX=6:
//   - LRU + promote-on-hit: W4,W5,W6,W7,W8,W9 in cache after first pass;
//     then on revisit W0-W2 are misses (3 fetches). Total: 13 fetches.
//   - FIFO (no promote): same end state — Map insertion order isn't
//     touched by .get() so FIFO behaves identically here when there's
//     no MRU-revisit during the first pass.
// To highlight the LRU win we add a re-access to W0 mid-cycle:
//   sequence: 0,1,2,3,4,5, [touch 0], 6,7, [revisit 0]
//   - FIFO:  0 was at the head, 6 evicts it. Touch-0 forces refetch.
//            Then 7 evicts 1, revisit-0 sees 0 in cache (just refetched).
//            Total: 0 + 6 cold + 1 (touch refetch) + 7 cold + (0 hit) = 9 fetches.
//   - LRU:   touch-0 promotes 0 to MRU; 6 then evicts 1 instead.
//            Revisit-0 is a hit. Total: 0 + 6 cold + (0 hit) + 7 cold + (0 hit) = 8 fetches.
const SCRUB_THEN_REVISIT = ['W0','W1','W2','W3','W4','W5','W0','W6','W7','W0'];

async function benchScrubReplay(promoteOnHit) {
  const c = makeCache({ promoteOnHit });
  const t0 = performance.now();
  for (const k of SCRUB_THEN_REVISIT) {
    await c.request(k, { dedup: false });
  }
  const wall = performance.now() - t0;
  return { wall, fetches: c.stats.upstreamFetches };
}

// Concurrent same-window: 5 callers ask for W0 simultaneously.
// Without dedup: 5 fetches. With dedup: 1 fetch.
async function benchConcurrentDedup(dedup) {
  const c = makeCache({ promoteOnHit: true });
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: 5 }, () => c.request('W0', { dedup })),
  );
  const wall = performance.now() - t0;
  return { wall, fetches: c.stats.upstreamFetches };
}

// p50/p95 over N runs of an async metric-producing fn.
async function repeat(label, n, fn) {
  const walls = [];
  let lastFetches = -1;
  for (let i = 0; i < n; i++) {
    const r = await fn();
    walls.push(r.wall);
    lastFetches = r.fetches;
  }
  walls.sort((a, b) => a - b);
  const p50 = walls[Math.floor(walls.length / 2)];
  const p95 = walls[Math.floor(walls.length * 0.95)];
  return { label, p50_ms: +p50.toFixed(2), p95_ms: +p95.toFixed(2), upstream_fetches: lastFetches };
}

const N = 20;
const out = await Promise.all([
  repeat('cache_scrub_lru',   N, () => benchScrubReplay(true)),
  repeat('cache_scrub_fifo',  N, () => benchScrubReplay(false)),
  repeat('cache_concurrent_dedup',    N, () => benchConcurrentDedup(true)),
  repeat('cache_concurrent_no_dedup', N, () => benchConcurrentDedup(false)),
]);

// Emit one JSON object per metric so check-regression can ingest.
const result = {};
for (const r of out) {
  result[r.label] = {
    p50_ms: r.p50_ms,
    p95_ms: r.p95_ms,
    upstream_fetches: r.upstream_fetches,
    captured_at: new Date().toISOString(),
    host_arch: process.arch,
  };
}
// `results` is what bench/check-regression.mjs imports.
// `meta` is informational only (not consumed by the harness today).
export const results = result;
export const meta = {
  description: 'Synthetic worker.js cache + dedup behaviour bench. Replicates the rawCache + inflightRawFetches logic in-process and measures (a) upstream fetches saved by LRU promote-on-hit vs FIFO during a scrub-replay pan pattern, (b) upstream fetches saved by inflight dedup of concurrent same-window requests.',
  sim_fetch_ms: SIM_FETCH_MS,
  cache_max: CACHE_MAX,
};
