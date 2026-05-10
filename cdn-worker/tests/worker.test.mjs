/**
 * Unit tests for cdn-worker/src/worker.js
 *
 * Strategy: import the worker's default export and call its fetch() handler
 * directly, mocking globalThis.fetch to simulate origin responses.  This
 * avoids the need for a running wrangler dev server or Cloudflare account
 * while still exercising all branch logic in the worker code.
 *
 * Run with: node --test tests/worker.test.mjs
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// --------------------------------------------------------------------------
// Minimal shims so the worker module can be imported in plain Node.js
// (Workers runtime globals not present in Node 20+)
// --------------------------------------------------------------------------

// URL is already global in Node 18+.  Nothing else from the worker module
// requires special shimming when we mock `fetch` at the global level.

// --------------------------------------------------------------------------
// Import worker
// --------------------------------------------------------------------------

// We use a dynamic import so we can set up any global shims first.
let worker;

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Build a minimal Request-like object the worker can consume. */
function makeRequest(path, { method = 'GET', headers = {} } = {}) {
  return new Request(`https://eeg-cdn.example.com${path}`, {
    method,
    headers,
  });
}

/** Build a minimal ExecutionContext mock (waitUntil is a no-op). */
function makeCtx() {
  return { waitUntil: () => {} };
}

/**
 * Install a one-shot global fetch mock that returns the given Response.
 * Restores the original fetch after each test via the returned teardown fn.
 */
function mockFetch(responseFn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    return responseFn(url, init);
  };
  return () => { globalThis.fetch = original; };
}

/** Create a fake origin Response that looks like what S3 / CF return. */
function fakeOriginResponse({
  status = 200,
  body = 'fake-bytes',
  headers = {},
} = {}) {
  const defaultHeaders = {
    'content-type': 'application/octet-stream',
    'content-length': String(body.length),
    'etag': '"abc123"',
    'last-modified': 'Fri, 19 Jan 2024 22:37:37 GMT',
    'accept-ranges': 'bytes',
    'cf-cache-status': 'MISS',
    ...headers,
  };
  return new Response(body, { status, headers: defaultHeaders });
}

// --------------------------------------------------------------------------
// Test suite
// --------------------------------------------------------------------------

describe('eegdash-cdn worker', async () => {
  before(async () => {
    // Import after shims are in place
    const mod = await import('../src/worker.js');
    worker = mod.default;
  });

  // 1. Bad path → 404 (open-proxy guard) -----------------------------------
  it('rejects a path that does not start with /dsNNNNNN/', async () => {
    const req = makeRequest('/some/arbitrary/path.edf');
    const res = await worker.fetch(req, {}, makeCtx());
    assert.equal(res.status, 404, 'expected 404 for invalid path');
    const text = await res.text();
    assert.match(text, /Not found/i);
  });

  // 2. Valid GET → proxied, x-eegdash-cdn present --------------------------
  it('proxies GET /ds002893/sub-001/eeg/foo.edf and returns x-eegdash-cdn header', async () => {
    const restore = mockFetch(() => fakeOriginResponse({ status: 200 }));
    try {
      const req = makeRequest('/ds002893/sub-001/eeg/foo.edf');
      const res = await worker.fetch(req, {}, makeCtx());
      assert.equal(res.status, 200);
      assert.ok(
        res.headers.has('x-eegdash-cdn'),
        'x-eegdash-cdn header must be present'
      );
    } finally {
      restore();
    }
  });

  // 3. HEAD forwarded as HEAD ----------------------------------------------
  it('forwards HEAD requests to origin as HEAD', async () => {
    let capturedMethod;
    const restore = mockFetch((url, init) => {
      capturedMethod = init?.method ?? 'GET';
      return fakeOriginResponse({ status: 200, body: '' });
    });
    try {
      const req = makeRequest('/ds002893/sub-001/eeg/foo.edf', { method: 'HEAD' });
      const res = await worker.fetch(req, {}, makeCtx());
      assert.equal(res.status, 200);
      assert.equal(capturedMethod, 'HEAD', 'origin must receive HEAD, not GET');
    } finally {
      restore();
    }
  });

  // 4. Range header passed through, Content-Range returned -----------------
  it('passes Range header upstream and reflects Content-Range in response', async () => {
    let capturedRange;
    const restore = mockFetch((url, init) => {
      capturedRange = init?.headers?.get?.('range') ?? new Headers(init?.headers).get('range');
      return fakeOriginResponse({
        status: 206,
        body: 'x'.repeat(1024),
        headers: {
          'content-range': 'bytes 0-1023/125042688',
          'cf-cache-status': 'HIT',
        },
      });
    });
    try {
      const req = makeRequest('/ds002893/sub-001/eeg/foo.edf', {
        headers: { Range: 'bytes=0-1023' },
      });
      const res = await worker.fetch(req, {}, makeCtx());
      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-range'), 'bytes 0-1023/125042688');
      // Verify Range was forwarded upstream
      assert.equal(capturedRange, 'bytes=0-1023', 'Range header must reach origin');
    } finally {
      restore();
    }
  });

  // 5. OPTIONS → CORS preflight 204 ----------------------------------------
  it('returns 204 with CORS headers for OPTIONS preflight', async () => {
    const req = makeRequest('/ds002893/sub-001/eeg/foo.edf', { method: 'OPTIONS' });
    const res = await worker.fetch(req, {}, makeCtx());
    assert.equal(res.status, 204);
    assert.ok(
      res.headers.get('access-control-allow-origin') === '*',
      'CORS allow-origin must be *'
    );
    assert.ok(
      res.headers.has('access-control-expose-headers'),
      'CORS expose-headers must be present'
    );
  });

  // 6. Origin fetch throws → 502 -------------------------------------------
  it('returns 502 when origin fetch throws a network error', async () => {
    const restore = mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    try {
      const req = makeRequest('/ds002893/sub-001/eeg/data.edf');
      const res = await worker.fetch(req, {}, makeCtx());
      assert.equal(res.status, 502);
      const text = await res.text();
      assert.match(text, /Bad gateway/i);
    } finally {
      restore();
    }
  });

  // 7. Origin returns unexpected status (e.g. 500) → 502 -------------------
  it('returns 502 when origin responds with an unexpected status code (500)', async () => {
    const restore = mockFetch(() => fakeOriginResponse({ status: 500 }));
    try {
      const req = makeRequest('/ds002893/sub-001/eeg/data.edf');
      const res = await worker.fetch(req, {}, makeCtx());
      assert.equal(res.status, 502);
      const text = await res.text();
      assert.match(text, /unexpected upstream status 500/i);
    } finally {
      restore();
    }
  });

  // 8. Non-GET/HEAD method → 405 -------------------------------------------
  it('returns 405 for POST requests', async () => {
    const req = makeRequest('/ds002893/sub-001/eeg/foo.edf', { method: 'POST' });
    const res = await worker.fetch(req, {}, makeCtx());
    assert.equal(res.status, 405);
    assert.ok(res.headers.has('Allow'));
  });

  // 9. CF-Cache-Status HIT reflected in x-eegdash-cdn ----------------------
  it('reflects CF-Cache-Status HIT as "hit" in x-eegdash-cdn header', async () => {
    const restore = mockFetch(() =>
      fakeOriginResponse({ headers: { 'cf-cache-status': 'HIT' } })
    );
    try {
      const req = makeRequest('/ds002893/sub-001/eeg/foo.edf');
      const res = await worker.fetch(req, {}, makeCtx());
      assert.equal(res.headers.get('x-eegdash-cdn'), 'hit');
    } finally {
      restore();
    }
  });

  // 10. CORS headers present on successful response -------------------------
  it('includes Access-Control-Allow-Origin: * on normal GET response', async () => {
    const restore = mockFetch(() => fakeOriginResponse());
    try {
      const req = makeRequest('/ds002893/sub-001/eeg/foo.edf');
      const res = await worker.fetch(req, {}, makeCtx());
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      // Viewer needs these to read ETag for conditional requests
      const exposed = res.headers.get('access-control-expose-headers') ?? '';
      assert.ok(exposed.toLowerCase().includes('etag'), 'ETag must be in expose-headers');
      assert.ok(exposed.toLowerCase().includes('content-range'), 'Content-Range must be exposed');
    } finally {
      restore();
    }
  });

  // 11. NEMAR routing: SHA-keyed path → nemar.s3.amazonaws.com -------------
  // The viewer's loadNemarRecording produces URLs of the form
  //   https://cdn.eegdash.org/nm000148/objects/SHA256E-s.../...bdf
  // The worker must rewrite to the NEMAR bucket (different host than
  // OpenNeuro's path-style endpoint) and add CORS, since NEMAR's S3
  // has no CORS configured itself.
  it('proxies NEMAR /nmNNNNNN/objects/<sha> to nemar.s3.amazonaws.com', async () => {
    let capturedUrl = null;
    const restore = mockFetch((url) => {
      capturedUrl = String(url);
      return fakeOriginResponse({ status: 200, body: 'fake-bdf' });
    });
    try {
      const path = '/nm000148/objects/SHA256E-s15851104--74283925ddb8087a9561e2be85ddadd0f44518c120287318c05662b0072b6b1b.bdf';
      const req = makeRequest(path);
      const res = await worker.fetch(req, {}, makeCtx());
      assert.equal(res.status, 200);
      assert.ok(
        capturedUrl.startsWith('https://nemar.s3.amazonaws.com/nm000148/objects/SHA256E-'),
        `expected NEMAR upstream, got ${capturedUrl}`
      );
      // CORS must be added — that's the whole point of the NEMAR proxy.
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
    } finally {
      restore();
    }
  });

  // 12. NEMAR shape guard: paths that don't match /nmNNNNNN/objects/<sha>
  // should 404, even if they start with /nm... (open-proxy guard for
  // the new bucket).
  it('rejects NEMAR-shaped path missing /objects/<sha>', async () => {
    const req = makeRequest('/nm000148/sub-1/eeg/data.bdf');
    const res = await worker.fetch(req, {}, makeCtx());
    assert.equal(res.status, 404);
  });

  // 13. NEMAR Range request — same plumbing as OpenNeuro Range. Critical
  // for tiled streaming; worker must forward Range and surface the
  // 206 + Content-Range back to the viewer.
  it('passes Range upstream for NEMAR objects too', async () => {
    let capturedRange;
    const restore = mockFetch((url, init) => {
      capturedRange = init?.headers?.get?.('range') ?? new Headers(init?.headers).get('range');
      return fakeOriginResponse({
        status: 206,
        body: 'x'.repeat(1024),
        headers: { 'content-range': 'bytes 0-1023/15851104' },
      });
    });
    try {
      const path = '/nm000148/objects/SHA256E-s15851104--abc.bdf';
      const req = makeRequest(path, { headers: { Range: 'bytes=0-1023' } });
      const res = await worker.fetch(req, {}, makeCtx());
      assert.equal(res.status, 206);
      assert.equal(capturedRange, 'bytes=0-1023');
      assert.equal(res.headers.get('content-range'), 'bytes 0-1023/15851104');
    } finally {
      restore();
    }
  });
});
