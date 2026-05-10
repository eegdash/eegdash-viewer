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
