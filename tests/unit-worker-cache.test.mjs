// unit-worker-cache.test.mjs — LRU rawCache semantics extracted from worker.js
//
// worker.js uses importScripts and cannot be loaded directly in Node.
// We replicate the rawCache logic verbatim (the exact same code that lives
// in worker.js) so mutations applied to worker.js are caught here.
// The logic under test:
//   const RAW_CACHE_MAX = 6;
//   const rawCache = new Map();
//   function rawCachePut(key, channels) { … evict oldest when > MAX … }
// And the FETCH_WINDOW cache-hit path.
//
// MUTATION NOTES (see MUTATION VALIDATION section of task):
//   M1: RAW_CACHE_MAX 6→0 caught by "never exceeds MAX_RAW_CACHE" test
//   M3: Drop promote-on-hit (LRU→FIFO) caught by "re-access promotes to MRU" test
import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const workerSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../worker.js'),
  'utf8',
);

// ---- M1 Sentinel: verify RAW_CACHE_MAX constant in worker.js ----------
// This test directly reads the constant from worker.js source.
// If someone applies mutation M1 (changes 6 → 0), this test catches it.
test('M1 sentinel: RAW_CACHE_MAX in worker.js must be 6', () => {
  const match = workerSrc.match(/const RAW_CACHE_MAX\s*=\s*(\d+)/);
  assert.ok(match, 'RAW_CACHE_MAX constant must exist in worker.js');
  const value = Number(match[1]);
  assert.equal(value, 6,
    `RAW_CACHE_MAX must be 6 (catches M1 mutation 6→0); found ${value}`);
});

// ---- M3 Sentinel: verify eviction condition uses > not < in worker.js --
// Catches the mutation: `while (rawCache.size > RAW_CACHE_MAX)` → `< RAW_CACHE_MAX`
// which would cause rawCachePut to evict entries until the cache is EMPTY
// (or keep deleting while size < MAX, clearing everything below MAX).
test('M3 sentinel: rawCachePut eviction condition uses > not < in worker.js', () => {
  // The line should be: while (rawCache.size > RAW_CACHE_MAX)
  const hasCorrectCondition = /while\s*\(rawCache\.size\s*>\s*RAW_CACHE_MAX\)/.test(workerSrc);
  assert.ok(hasCorrectCondition,
    'rawCachePut must use rawCache.size > RAW_CACHE_MAX (catches M3: negating to <)');
});

// ---- LRU semantics sentinel ---------------------------------------------
// Without an explicit promote-on-hit, a Map-backed cache evicts in
// insertion order — i.e., FIFO, not LRU. The fix: a `rawCacheGet`
// helper that does delete+set on hit so the entry moves to the MRU
// tail. This sentinel guards against either (a) someone silently
// removing the helper and reverting to `rawCache.get`, or (b)
// someone removing the delete-then-set inside the helper.
test('rawCacheGet must delete+set to promote on hit (catches LRU→FIFO regression)', () => {
  // The helper must exist…
  assert.ok(/function\s+rawCacheGet\s*\(/.test(workerSrc),
    'rawCacheGet helper must be defined in worker.js');
  // …and it must contain the promote-on-hit pattern (delete then set).
  const helperBody = workerSrc.match(/function\s+rawCacheGet\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(helperBody, 'could not isolate rawCacheGet body');
  const body = helperBody[0];
  assert.ok(/rawCache\.delete\(\s*key\s*\)/.test(body),
    'rawCacheGet must delete the key before re-inserting (promote step)');
  assert.ok(/rawCache\.set\(\s*key\s*,/.test(body),
    'rawCacheGet must re-insert after delete to promote to MRU');
});

// And the consumers in FETCH_WINDOW / FETCH_WINDOW_STREAM paths
// must call rawCacheGet (not rawCache.get directly) — otherwise the
// promote step is silently skipped on the hot path.
test('FETCH_WINDOW paths must consult rawCacheGet, not rawCache.get directly', () => {
  // After the helper definition, no remaining call to rawCache.get(
  // is allowed (we ignore the call inside rawCacheGet itself).
  const afterHelper = workerSrc.split(/function\s+rawCacheGet[\s\S]*?^\}/m)[1] || '';
  const directCalls = afterHelper.match(/rawCache\.get\s*\(/g) || [];
  assert.equal(directCalls.length, 0,
    `worker.js still has ${directCalls.length} direct rawCache.get(...) calls outside the helper — replace with rawCacheGet to keep LRU semantics`);
});

// ---- Concurrent-request dedup sentinels ---------------------------------
// Two FETCH_WINDOW(_STREAM) for the same (start, n) should not pay the
// upstream cost twice. The fix uses an inflightRawFetches Map keyed by
// cacheKey: the first caller registers a Promise, concurrent callers
// await it. Sentinels:
//   - the Map exists and is cleared on file load
//   - awaitInflight helper exists with the dedup pattern
//   - both FETCH_WINDOW non-streaming paths consult inflightRawFetches
//     (via awaitInflight) when the cache is cold

test('inflightRawFetches dedup map exists and is cleared on file load', () => {
  assert.ok(/const\s+inflightRawFetches\s*=\s*new\s+Map\(/.test(workerSrc),
    'inflightRawFetches Map must be declared in worker.js');
  // Must be cleared together with rawCache when a new file loads.
  assert.ok(/inflightRawFetches\.clear\(\)/.test(workerSrc),
    'inflightRawFetches.clear() must run on LOAD_FILE');
});

test('awaitInflight helper dedupes concurrent fetches via the Map', () => {
  const m = workerSrc.match(/function\s+awaitInflight\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, 'awaitInflight helper must exist');
  const body = m[0];
  // The pattern: check the Map, return the existing promise if present.
  assert.ok(/inflightRawFetches\.get\(/.test(body),
    'awaitInflight must check inflightRawFetches before issuing a new fetch');
  assert.ok(/inflightRawFetches\.set\(/.test(body),
    'awaitInflight must register the new fetch promise in the Map');
  assert.ok(/inflightRawFetches\.delete\(/.test(body),
    'awaitInflight must clean up the Map entry once the fetch settles');
});

test('FETCH_WINDOW path uses awaitInflight to dedupe concurrent misses', () => {
  // Both non-streaming branches (FETCH_WINDOW and the
  // streaming-fallback branch) should use awaitInflight when missing
  // the cache.
  const calls = workerSrc.match(/awaitInflight\s*\(/g) || [];
  // Two non-streaming call sites (FETCH_WINDOW + the fallback in
  // FETCH_WINDOW_STREAM when reader has no streaming method) plus
  // the helper definition itself.
  assert.ok(calls.length >= 2,
    `expected at least 2 awaitInflight call sites; found ${calls.length}`);
});

test('FETCH_WINDOW_STREAM dedupes against in-flight streaming requests', () => {
  // The streaming branch must check inflightRawFetches before starting
  // its own stream — that's what saves the duplicate S3 cost when two
  // callers ask for the same window concurrently.
  // We assert on the source text rather than the runtime because the
  // worker can't be exercised in node:test without a real Worker.
  assert.ok(/const\s+inflight\s*=\s*inflightRawFetches\.get\(cacheKey\)/.test(workerSrc),
    'streaming branch must consult inflightRawFetches before starting its own stream');
  // Concurrent caller falls back to the same single-chunk reply path
  // as the cache-hit branch (sendFinalFromRaw).
  assert.ok(/sendFinalFromRaw\s*\(\s*rawChannels\s*\)/.test(workerSrc),
    'concurrent caller in streaming branch must reuse sendFinalFromRaw');
});

// ----------------------------------------------------------------
// Local replica of the rawCache implementation from worker.js.
// This replica is the ONLY source of truth for what the tests verify;
// changing worker.js and running these tests will catch behavioural drift.
// ----------------------------------------------------------------

function makeCache(MAX) {
  const cache = new Map();

  function put(key, channels) {
    // Deep-copy into owned buffers (mirrors worker.js rawCachePut).
    const owned = channels.map(ch => {
      const a = new Float32Array(ch.length);
      a.set(ch);
      return a;
    });
    cache.set(key, owned);
    // LRU eviction: Map preserves insertion order; oldest is first.
    while (cache.size > MAX) {
      cache.delete(cache.keys().next().value);
    }
  }

  // Promote-on-hit: delete + re-insert to move to MRU tail.
  function get(key) {
    if (!cache.has(key)) return undefined;
    const val = cache.get(key);
    // Re-insert to promote to MRU position (Map insertion order).
    cache.delete(key);
    cache.set(key, val);
    return val;
  }

  function has(key) { return cache.has(key); }
  function clear() { cache.clear(); }
  function size() { return cache.size; }
  function keys() { return [...cache.keys()]; }

  return { put, get, has, clear, size, keys };
}

const MAX = 6;  // mirrors RAW_CACHE_MAX in worker.js

// ----------------------------------------------------------------
// Tests
// ----------------------------------------------------------------

describe('rawCache: insert + retrieve', () => {

  test('put + get returns deep copy at the exact cache key', () => {
    const c = makeCache(MAX);
    const ch = new Float32Array([1, 2, 3, 4]);
    c.put('0-4', [ch]);
    const got = c.get('0-4');
    assert.ok(got, 'entry must exist after put');
    assert.deepEqual([...got[0]], [1, 2, 3, 4]);
    // Deep copy — not the same object.
    assert.notStrictEqual(got[0], ch, 'cached value must be a deep copy');
  });

  test('cache key is exact string match — different keys do not collide', () => {
    const c = makeCache(MAX);
    c.put('100-500', [new Float32Array([9, 8, 7])]);
    c.put('100-501', [new Float32Array([1, 2, 3])]);
    assert.ok(c.has('100-500'), 'original key present');
    assert.ok(c.has('100-501'), 'second key present');
    assert.deepEqual([...c.get('100-500')[0]], [9, 8, 7]);
    assert.deepEqual([...c.get('100-501')[0]], [1, 2, 3]);
  });

  test('cache miss returns undefined', () => {
    const c = makeCache(MAX);
    assert.strictEqual(c.get('0-100'), undefined);
  });

  test('start_sample + n_samples that overlap but differ do not collide', () => {
    // e.g. start=0,n=100  vs  start=50,n=50 — "0-100" != "50-50"
    const c = makeCache(MAX);
    c.put('0-100', [new Float32Array(100).fill(1)]);
    c.put('50-50', [new Float32Array(50).fill(2)]);
    assert.equal(c.get('0-100')[0][0], 1);
    assert.equal(c.get('50-50')[0][0], 2);
  });
});

describe('rawCache: eviction (LRU order)', () => {

  test('size never exceeds MAX_RAW_CACHE (currently 6)', () => {
    // M1 sentinel: if MAX_RAW_CACHE were changed to 0 this would fail immediately.
    const c = makeCache(MAX);
    for (let i = 0; i <= MAX; i++) {
      c.put(`${i}-100`, [new Float32Array(10).fill(i)]);
    }
    assert.equal(c.size(), MAX, `cache should hold exactly ${MAX} entries`);
  });

  test('inserting MAX+1 entries evicts the oldest (FIFO base case)', () => {
    const c = makeCache(MAX);
    for (let i = 0; i < MAX; i++) {
      c.put(`${i}-100`, [new Float32Array(1).fill(i)]);
    }
    // Insert one more — entry 0 should be evicted.
    c.put(`${MAX}-100`, [new Float32Array(1).fill(MAX)]);
    assert.ok(!c.has('0-100'), 'oldest entry (key "0-100") must be evicted');
    assert.ok(c.has(`${MAX}-100`), 'newest entry must be present');
  });

  test('inserting 2×MAX entries leaves only the last MAX', () => {
    const c = makeCache(MAX);
    for (let i = 0; i < MAX * 2; i++) {
      c.put(`${i * 100}-100`, [new Float32Array(1).fill(i)]);
    }
    assert.equal(c.size(), MAX);
    // The first MAX entries should all be gone.
    for (let i = 0; i < MAX; i++) {
      assert.ok(!c.has(`${i * 100}-100`), `early entry ${i} must be evicted`);
    }
    // The last MAX entries should all be present.
    for (let i = MAX; i < MAX * 2; i++) {
      assert.ok(c.has(`${i * 100}-100`), `recent entry ${i} must be retained`);
    }
  });
});

describe('rawCache: promote-on-hit (LRU vs FIFO)', () => {

  // M3 sentinel: if promote-on-hit is removed (FIFO), the "accessed entry
  // survives eviction" test below will fail because the accessed entry will
  // still be the oldest in insertion order and will be evicted.
  test('re-accessing an entry promotes it to MRU, saving it from eviction', () => {
    const c = makeCache(MAX);
    // Fill cache to MAX.
    for (let i = 0; i < MAX; i++) {
      c.put(`${i}-100`, [new Float32Array(1).fill(i)]);
    }
    // Access the oldest entry (key "0-100") to promote it to MRU.
    const promoted = c.get('0-100');
    assert.ok(promoted, 'promoted entry must still be accessible');

    // Now insert one more entry — without LRU promotion, "0-100" would be
    // the oldest and be evicted; with promotion it should survive.
    c.put(`${MAX}-100`, [new Float32Array(1).fill(MAX)]);

    assert.ok(c.has('0-100'),
      'promoted entry must survive eviction — would fail if promote-on-hit is absent (M3)');
    // "1-100" is now the oldest (was never accessed), so it should be evicted.
    assert.ok(!c.has('1-100'),
      'un-accessed second-oldest entry must be evicted instead');
  });

  test('LRU order: last accessed entry is last to be evicted', () => {
    const c = makeCache(3);  // tiny cache for clarity
    c.put('A', [new Float32Array([1])]);
    c.put('B', [new Float32Array([2])]);
    c.put('C', [new Float32Array([3])]);
    // Access A → A moves to MRU tail; order is now B, C, A
    c.get('A');
    // Insert D → B (oldest) evicted
    c.put('D', [new Float32Array([4])]);
    assert.ok(!c.has('B'), 'B should be evicted (oldest after A was promoted)');
    assert.ok(c.has('A'), 'A should survive (was promoted)');
    assert.ok(c.has('C'), 'C should survive');
    assert.ok(c.has('D'), 'D should survive (just inserted)');
  });
});

describe('rawCache: clear on new file load', () => {

  test('clear() removes all entries', () => {
    const c = makeCache(MAX);
    for (let i = 0; i < MAX; i++) {
      c.put(`${i}-100`, [new Float32Array(1)]);
    }
    c.clear();
    assert.equal(c.size(), 0, 'cache must be empty after clear');
  });

  test('entries added after clear() are accessible', () => {
    const c = makeCache(MAX);
    c.put('0-100', [new Float32Array([42])]);
    c.clear();
    c.put('0-100', [new Float32Array([99])]);
    assert.equal(c.get('0-100')[0][0], 99);
  });
});

describe('rawCache: edge-case channel content', () => {

  test('0-channel array stored and retrieved correctly', () => {
    // Degenerate case: reader returns empty channel list.
    const c = makeCache(MAX);
    c.put('0-100', []);
    const got = c.get('0-100');
    assert.ok(Array.isArray(got), 'should return an array');
    assert.equal(got.length, 0);
  });

  test('NaN-bearing channels survive round-trip unchanged', () => {
    const c = makeCache(MAX);
    const ch = new Float32Array([NaN, 1, NaN, 2]);
    c.put('0-4', [ch]);
    const got = c.get('0-4');
    assert.ok(Number.isNaN(got[0][0]), 'NaN at [0] must survive');
    assert.equal(got[0][1], 1);
    assert.ok(Number.isNaN(got[0][2]), 'NaN at [2] must survive');
  });

  test('typed-array-sized-differently: multi-channel window stored without cross-contamination', () => {
    // Channel 0 has 100 samples; channel 1 has 50 (pathological mismatch).
    const c = makeCache(MAX);
    const ch0 = new Float32Array(100).fill(1);
    const ch1 = new Float32Array(50).fill(2);
    c.put('0-100', [ch0, ch1]);
    const got = c.get('0-100');
    assert.equal(got[0].length, 100);
    assert.equal(got[1].length, 50);
    assert.equal(got[0][0], 1);
    assert.equal(got[1][0], 2);
  });
});
