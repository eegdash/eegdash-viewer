// tests/unit-network-retry.test.mjs
//
// Network resilience tests for the retry helper in bids-recording.js.
// Monkey-patches globalThis.fetch with a programmable mock that returns
// a configured sequence of responses, then restores the original after
// each test so sibling test files aren't poisoned.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BIDSRecording } from './_bootstrap.mjs';

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(responses) {
  let i = 0;
  return async () => {
    const r = responses[i++];
    if (r instanceof Error) throw r;
    return r;
  };
}

function fakeResponse(status, body = 'ok') {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body; },
    async json() { return JSON.parse(body); },
  };
}

test('retry: 200 returned without retry', async (t) => {
  t.after(() => { globalThis.fetch = ORIGINAL_FETCH; });
  globalThis.fetch = mockFetch([fakeResponse(200, 'good')]);
  const res = await BIDSRecording._fetchWithRetry('https://example.com/x');
  assert.equal(res.status, 200);
});

test('retry: 503 retried, eventual 200 succeeds', async (t) => {
  t.after(() => { globalThis.fetch = ORIGINAL_FETCH; });
  globalThis.fetch = mockFetch([
    fakeResponse(503), fakeResponse(503), fakeResponse(200, 'good'),
  ]);
  const res = await BIDSRecording._fetchWithRetry('https://example.com/x');
  assert.equal(res.status, 200);
});

test('retry: 404 returned terminal, no retry', async (t) => {
  t.after(() => { globalThis.fetch = ORIGINAL_FETCH; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return fakeResponse(404); };
  const res = await BIDSRecording._fetchWithRetry('https://example.com/x');
  assert.equal(res.status, 404);
  assert.equal(calls, 1, '404 must not be retried');
});

test('retry: 429 IS retried (rate-limit)', async (t) => {
  t.after(() => { globalThis.fetch = ORIGINAL_FETCH; });
  globalThis.fetch = mockFetch([
    fakeResponse(429), fakeResponse(429), fakeResponse(200, 'good'),
  ]);
  const res = await BIDSRecording._fetchWithRetry('https://example.com/x');
  assert.equal(res.status, 200);
});

test('retry: network error retried, then thrown after 3 attempts', async (t) => {
  t.after(() => { globalThis.fetch = ORIGINAL_FETCH; });
  const netErr = new TypeError('fetch failed');
  globalThis.fetch = mockFetch([netErr, netErr, netErr, netErr]);
  await assert.rejects(
    () => BIDSRecording._fetchWithRetry('https://example.com/x'),
    /fetch failed/,
  );
});

test('retry: network error recovers on 2nd attempt', async (t) => {
  t.after(() => { globalThis.fetch = ORIGINAL_FETCH; });
  globalThis.fetch = mockFetch([new TypeError('fetch failed'), fakeResponse(200)]);
  const res = await BIDSRecording._fetchWithRetry('https://example.com/x');
  assert.equal(res.status, 200);
});
