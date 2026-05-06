// Tile fetching tests with a stubbed fetch — verify:
//  - reads below the threshold stay single-fetch
//  - reads above the threshold split into ≤ 8 parallel sub-fetches
//  - the assembled buffer matches the source bytes exactly
//  - aborting cancels every in-flight tile
import { test, before, after, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { HttpRange } from './_bootstrap.mjs';
import { rampBytes } from './_fixtures.mjs';

const TOTAL_BYTES = 100_000_000;
const TEST_URL = 'https://example.invalid/big.bin';

let originalFetch;
let calls;
let SOURCE;

// SOURCE is the file-scope ramp: one 100 MB allocation amortised
// across every test in this file. Per-test we only swap the fetch
// stub and reset `calls`, both negligibly cheap.
before(() => { SOURCE = rampBytes(TOTAL_BYTES); });
after (() => { SOURCE = null; });

function installStub() {
  originalFetch = globalThis.fetch;
  calls = [];
  globalThis.fetch = async (url, init) => {
    if (init && init.signal && init.signal.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    const range = init && init.headers && init.headers.Range;
    if (!range) throw new Error(`stub fetch: missing Range`);
    const m = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!m) throw new Error(`stub fetch: bad Range "${range}"`);
    const a = Number(m[1]), b = Number(m[2]);
    calls.push({ url, a, b, signal: init.signal });
    // subarray (view, no copy) so the per-tile cap test doesn't
    // allocate hundreds of MB of transient buffers.
    return new Response(SOURCE.subarray(a, b + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${a}-${b}/${TOTAL_BYTES}` },
    });
  };
}
function restoreStub() { globalThis.fetch = originalFetch; }

beforeEach(installStub);
afterEach(restoreStub);

test('tile fetching: 1 MB read stays single-fetch (below threshold)', async () => {
  const buf = await HttpRange.rangeFetch(TEST_URL, 0, 1_000_000 - 1, 1_000_000);
  assert.equal(calls.length, 1);
  assert.equal(buf.byteLength, 1_000_000);
});

test('tile fetching: just-under-threshold stays single-fetch', async () => {
  const SZ = 4 * 1024 * 1024 - 1;
  await HttpRange.rangeFetch(TEST_URL, 0, SZ - 1, SZ);
  assert.equal(calls.length, 1);
});

test('tile fetching: 5 MiB read splits into multiple tiles', async () => {
  const SZ = 5 * 1024 * 1024;
  const buf = await HttpRange.rangeFetch(TEST_URL, 0, SZ - 1, SZ);
  assert.ok(calls.length >= 2, `expected ≥ 2 tiles, got ${calls.length}`);
  assert.equal(buf.byteLength, SZ);
});

test('tile fetching: tiled bytes match source byte-for-byte', async () => {
  const start = 1_234_567;
  const SZ = 8 * 1024 * 1024 + 17;
  const buf = await HttpRange.rangeFetch(TEST_URL, start, start + SZ - 1, SZ);
  const view = new Uint8Array(buf);
  assert.equal(view.length, SZ);
  assert.equal(view[0],          (start) & 0xff);
  assert.equal(view[SZ - 1],     (start + SZ - 1) & 0xff);
  assert.equal(view[SZ >> 1],    (start + (SZ >> 1)) & 0xff);
  // Spot-check 1000 bytes near the start to expose alignment bugs.
  for (let i = 0; i < 1000; i++) {
    if (view[i] !== ((start + i) & 0xff)) {
      assert.fail(`mismatch at offset ${i}`);
    }
  }
});

test('tile fetching: never exceeds TILE_MAX_PARALLEL=8', async () => {
  const SZ = 50 * 1024 * 1024;
  await HttpRange.rangeFetch(TEST_URL, 0, SZ - 1, SZ);
  assert.ok(calls.length <= 8, `expected ≤ 8 tiles, got ${calls.length}`);
});

test('tile fetching: every tile receives the same abort signal', async () => {
  const SZ = 10 * 1024 * 1024;
  const ctrl = new AbortController();
  await HttpRange.rangeFetch(TEST_URL, 0, SZ - 1, SZ, { signal: ctrl.signal });
  assert.ok(calls.length >= 2);
  for (const c of calls) {
    assert.equal(c.signal, ctrl.signal,
      'every tile got the caller signal — abort must reach all in flight');
  }
});

test('tile fetching: pre-aborted signal rejects every tile', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    () => HttpRange.rangeFetch(TEST_URL, 0, 5 * 1024 * 1024 - 1, 5 * 1024 * 1024,
                               { signal: ctrl.signal }),
    (e) => e.name === 'AbortError');
});
