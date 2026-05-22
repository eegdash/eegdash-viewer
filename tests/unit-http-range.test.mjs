// HttpRange paths beyond what tile-fetching.test.mjs covers:
//  - probeLength HEAD-blocked fallback (a 405 on HEAD → bytes=0-0
//    range probe). Some S3 access policies do this in production.
//  - Range-not-honoured detection (a server returning 200 with the
//    full body when we asked for a sub-range): we should fail loud
//    rather than overrun a buffer.
//  - HTTP 4xx / 5xx surface a clear error.
import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { HttpRange } from './_bootstrap.mjs';

let originalFetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach (() => { globalThis.fetch = originalFetch; });

const URL = 'https://example.invalid/file.bin';

test('probeLength: HEAD with content-length returns immediately', async () => {
  globalThis.fetch = async (url, init) => {
    if (init && init.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': '12345' } });
    }
    throw new Error('should not GET');
  };
  assert.equal(await HttpRange.probeLength(URL), 12345);
});

test('probeLength: HEAD blocked → falls back to Range bytes=0-0', async () => {
  // Some S3 buckets reject HEAD outright. Our helper should re-issue
  // a zero-byte Range GET and parse the Content-Range total.
  let calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(init?.method || 'GET');
    if (init && init.method === 'HEAD') {
      return new Response(null, { status: 405 });
    }
    // Range fallback should match.
    assert.equal(init.headers.Range, 'bytes=0-0');
    return new Response(new Uint8Array([0]), {
      status: 206,
      headers: { 'Content-Range': 'bytes 0-0/9876' },
    });
  };
  assert.equal(await HttpRange.probeLength(URL), 9876);
  assert.deepEqual(calls, ['HEAD', 'GET']);
});

test('probeLength: HEAD 200 without content-length → falls back to Range', async () => {
  // Servers behind chunked encoding sometimes 200-without-length.
  // We treat that the same as "HEAD failed" and fall through.
  let didRange = false;
  globalThis.fetch = async (url, init) => {
    if (init && init.method === 'HEAD') {
      return new Response(null, { status: 200 });   // no content-length
    }
    didRange = true;
    return new Response(new Uint8Array([0]), {
      status: 206,
      headers: { 'Content-Range': 'bytes 0-0/100' },
    });
  };
  assert.equal(await HttpRange.probeLength(URL), 100);
  assert.ok(didRange);
});

test('probeLength: Range fallback 416 → throws clearly', async () => {
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'HEAD') return new Response(null, { status: 405 });
    return new Response(null, { status: 416 });
  };
  await assert.rejects(() => HttpRange.probeLength(URL), /Cannot determine length/);
});

test('probeLength: Range fallback returns 206 with no Content-Range header', async () => {
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'HEAD') return new Response(null, { status: 405 });
    return new Response(new Uint8Array([0]), { status: 206 });   // missing Content-Range
  };
  await assert.rejects(() => HttpRange.probeLength(URL), /no Content-Range total/);
});

// ----- rangeFetch behaviour --------------------------------

test('rangeFetch: server returns 200 (Range ignored) → stream-reads enough + slices the requested window', async () => {
  // cdn.eegdash.org sometimes serves HTTP 200 + full body when asked for
  // a Range (intermittent edge-cache behaviour, observed on .meg4 CTF
  // files). Rather than throw and lose the request, stream-read enough
  // bytes to cover the requested range and slice. Burns the prefix
  // [0, byteStart) of bandwidth but saves the (much larger) suffix.
  const FULL = new Uint8Array(1000);
  for (let i = 0; i < FULL.length; i++) FULL[i] = i & 0xff;  // recognisable pattern
  globalThis.fetch = async () => new Response(FULL, { status: 200 });
  const result = await HttpRange.rangeFetch(URL, 100, 199, 100);
  assert.equal(result.byteLength, 100);
  // Bytes [100..199] of FULL should match (100, 101, 102, ...).
  const view = new Uint8Array(result);
  assert.equal(view[0], 100);
  assert.equal(view[50], 150);
  assert.equal(view[99], 199);
});

test('rangeFetch: server returns 200 but body too short to cover range → throws clearly', async () => {
  const FULL = new Uint8Array(50);  // body shorter than requested range
  globalThis.fetch = async () => new Response(FULL, { status: 200 });
  await assert.rejects(
    () => HttpRange.rangeFetch(URL, 100, 199, 100),
    /Range-ignored fallback: response body had only 50B, requested range starts at byteStart=100/);
});

test('rangeFetch: server returns 200 with response shorter than expectedBytes → throws clearly', async () => {
  const FULL = new Uint8Array(150);  // covers byteStart but slice is shorter than expected
  globalThis.fetch = async () => new Response(FULL, { status: 200 });
  await assert.rejects(
    () => HttpRange.rangeFetch(URL, 100, 199, 100),
    /Range-ignored fallback: sliced 50B from 150B body, expected 100B/);
});

test('rangeFetch: server 4xx → throws with status', async () => {
  globalThis.fetch = async () => new Response(null, { status: 403 });
  await assert.rejects(
    () => HttpRange.rangeFetch(URL, 0, 99, 100),
    /HTTP 403/);
});

test('rangeFetch: server 5xx → throws with status', async () => {
  globalThis.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(
    () => HttpRange.rangeFetch(URL, 0, 99, 100),
    /HTTP 503/);
});

test('rangeFetch: aborted signal propagates to fetch', async () => {
  let signalSeen = null;
  globalThis.fetch = async (url, init) => {
    signalSeen = init.signal;
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return new Response(new Uint8Array(100), { status: 206 });
  };
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    () => HttpRange.rangeFetch(URL, 0, 99, 100, { signal: ctrl.signal }),
    (e) => e.name === 'AbortError');
});

// ----- fetchText / fetchTextOrNull -------------------------

test('fetchTextOrNull: 404 returns null (sidecar absent is fine)', async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  assert.equal(await HttpRange.fetchTextOrNull('https://example.invalid/x.json'), null);
});

test('fetchTextOrNull: 5xx returns null and warns (sidecar is optional)', async () => {
  // Behavior change (2026-05-22, generosity pass): sidecars are optional
  // by BIDS spec, so a CDN 502/503/504 on an optional sidecar shouldn't
  // kill the load. Treat any non-2xx as missing. Strict mode (fetchText
  // without allowMissing) still throws — see below.
  globalThis.fetch = async () => new Response(null, { status: 503 });
  const origWarn = console.warn;
  let warned = '';
  console.warn = (m) => { warned = m; };
  try {
    const out = await HttpRange.fetchTextOrNull('https://example.invalid/x.json');
    assert.equal(out, null);
    assert.match(warned, /503/);
  } finally {
    console.warn = origWarn;
  }
});

test('fetchText (strict) throws on 404', async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  await assert.rejects(
    () => HttpRange.fetchText('https://example.invalid/x.vhdr'),
    /404/);
});
