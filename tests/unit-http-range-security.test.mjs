// Security regression tests for formats/_http_range.js
//
// Threat model (Fix A4):
//   - Negative byteStart turns the outgoing Range header into a SUFFIX
//     range — `bytes=-N-…` — which S3 (and most CDNs) interpret as
//     "fetch the trailing N bytes of the object". An attacker who can
//     influence a reader's sampleIdx → byteStart math (e.g. an
//     underflowed signed-integer scratch in a malformed header) would
//     silently receive end-of-file bytes instead of an error.
//   - Unbounded / inverted byteEndInclusive should never reach the
//     wire either; readers expect zero-length results when their math
//     collapses (nSamplesWindow=0 or end-of-stream).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { HttpRange } from './_bootstrap.mjs';

const URL = 'https://example.invalid/file.bin';

test('A4: rangeFetch throws on negative byteStart', async () => {
  // Spy: if validation runs, fetch must NOT be called.
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return new Response(); };
  try {
    await assert.rejects(
      () => HttpRange.rangeFetch(URL, -1, 1023, 1024),
      /bad byteStart/,
    );
    await assert.rejects(
      () => HttpRange.rangeFetch(URL, -1000, -500, 500),
      /bad byteStart/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalled, false, 'fetch must not be called for invalid start');
});

test('A4: rangeFetch throws on non-integer byteStart', async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return new Response(); };
  try {
    await assert.rejects(() => HttpRange.rangeFetch(URL, NaN, 1023, 1024), /bad byteStart/);
    await assert.rejects(() => HttpRange.rangeFetch(URL, Infinity, 1023, 1024), /bad byteStart/);
    await assert.rejects(() => HttpRange.rangeFetch(URL, 1.5, 1023, 1024), /bad byteStart/);
    await assert.rejects(() => HttpRange.rangeFetch(URL, '0', 1023, 1024), /bad byteStart/);
    await assert.rejects(() => HttpRange.rangeFetch(URL, undefined, 1023, 1024), /bad byteStart/);
    await assert.rejects(() => HttpRange.rangeFetch(URL, null, 1023, 1024), /bad byteStart/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalled, false);
});

test('A4: rangeFetch returns zero-length when end < start (no fetch)', async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return new Response(); };
  try {
    const buf = await HttpRange.rangeFetch(URL, 100, 50, 0);
    assert.ok(buf instanceof ArrayBuffer);
    assert.equal(buf.byteLength, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalled, false, 'inverted range must not hit the network');
});

test('A4: rangeFetch returns zero-length when end is non-integer', async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return new Response(); };
  try {
    const buf1 = await HttpRange.rangeFetch(URL, 0, NaN, 1024);
    assert.equal(buf1.byteLength, 0);
    const buf2 = await HttpRange.rangeFetch(URL, 0, Infinity, 1024);
    assert.equal(buf2.byteLength, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalled, false);
});

test('A4: rangeFetch with byteStart=0 still works (boundary case)', async () => {
  // The validator must NOT reject 0 — it's the canonical first-byte
  // start. We mock the fetch path to confirm the request is allowed.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.match(init.headers.Range, /^bytes=0-\d+$/);
    return new Response(new Uint8Array(10).buffer, {
      status: 206,
      headers: {
        'content-length': '10',
        'content-range': 'bytes 0-9/1000',
      },
    });
  };
  try {
    const buf = await HttpRange.rangeFetch(URL, 0, 9, 10);
    assert.equal(buf.byteLength, 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
