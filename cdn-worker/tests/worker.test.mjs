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

/** Preserve an unnormalized URL path to test encoded and dot-segment rejection. */
function makeRawRequest(path, { method = 'GET', headers = {} } = {}) {
  return {
    url: `https://eeg-cdn.example.com${path}`,
    method,
    headers: new Headers(headers),
  };
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
    const req = makeRequest('/data/nm000148/latest/sub-01/eeg/foo.edf', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://eegdash.org',
        'Access-Control-Request-Headers': 'Range, If-None-Match, If-Range',
      },
    });
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
    const allowed = res.headers.get('access-control-allow-headers').toLowerCase();
    for (const header of ['range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since', 'if-range']) {
      assert.ok(allowed.includes(header), `CORS must allow ${header}`);
    }
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

  // 14. NEMAR objects/ accepts on*/xx* prefixes too (OpenNeuro mirrors,
  // sandbox) — same bucket layout, same SHA-keyed addressing.
  it('proxies on* and xx* dataset ids to nemar.s3 with the same shape', async () => {
    for (const id of ['on005262', 'xx000001']) {
      let capturedUrl = null;
      const restore = mockFetch((url) => {
        capturedUrl = String(url);
        return fakeOriginResponse({ status: 200 });
      });
      try {
        const path = `/${id}/objects/SHA256E-s100--abc.edf`;
        const req = makeRequest(path);
        const res = await worker.fetch(req, {}, makeCtx());
        assert.equal(res.status, 200, `expected 200 for ${id}`);
        assert.ok(
          capturedUrl.startsWith(`https://nemar.s3.amazonaws.com/${id}/objects/SHA256E-`),
          `expected nemar.s3 upstream for ${id}, got ${capturedUrl}`
        );
      } finally {
        restore();
      }
    }
  });

  // 15. data.nemar.org metadata proxy: manifest.json. The whole point is
  // CORS — data.nemar.org sets every CORS header except Allow-Origin,
  // which the browser requires. The worker is the bridge.
  it('proxies /data/<id>/<version>/manifest.json to data.nemar.org with CORS', async () => {
    let capturedUrl = null;
    const restore = mockFetch((url) => {
      capturedUrl = String(url);
      return fakeOriginResponse({
        status: 200,
        body: '[{"path":"dataset_description.json","size":480,"checksum_algorithm":"git","checksum":"abc","url":"https://raw.githubusercontent.com/..."}]',
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      const req = makeRequest('/data/nm000148/latest/manifest.json');
      const res = await worker.fetch(req, {}, makeCtx());
      assert.equal(res.status, 200);
      assert.equal(
        capturedUrl,
        'https://data.nemar.org/nm000148/latest/manifest.json',
        '/data prefix must be stripped before forwarding'
      );
      assert.equal(res.headers.get('access-control-allow-origin'), '*',
        'CORS allow-origin must be * (that is the whole point of this proxy)');
    } finally {
      restore();
    }
  });

  // 16. metadata.json passes through too, and accepts on*/xx* prefixes.
  it('proxies /data/<id>/<version>/metadata.json for nm/on/xx', async () => {
    for (const id of ['nm000148', 'on005262', 'xx000001']) {
      let capturedUrl = null;
      const restore = mockFetch((url) => {
        capturedUrl = String(url);
        return fakeOriginResponse({
          status: 200,
          body: '{"schema_version":"0.3.0"}',
          headers: { 'content-type': 'application/json' },
        });
      });
      try {
        const req = makeRequest(`/data/${id}/latest/metadata.json`);
        const res = await worker.fetch(req, {}, makeCtx());
        assert.equal(res.status, 200, `expected 200 for ${id}`);
        assert.equal(capturedUrl, `https://data.nemar.org/${id}/latest/metadata.json`);
      } finally {
        restore();
      }
    }
  });

  // 17. Versioned access: /data/<id>/vX.Y.Z/... must also pass the regex.
  it('proxies pinned-version /data/<id>/vX.Y.Z/manifest.json', async () => {
    let capturedUrl = null;
    const restore = mockFetch((url) => {
      capturedUrl = String(url);
      return fakeOriginResponse({ status: 200, body: '[]', headers: { 'content-type': 'application/json' } });
    });
    try {
      const req = makeRequest('/data/nm000148/v1.0.0/manifest.json');
      const res = await worker.fetch(req, {}, makeCtx());
      assert.equal(res.status, 200);
      assert.equal(capturedUrl, 'https://data.nemar.org/nm000148/v1.0.0/manifest.json');
    } finally {
      restore();
    }
  });

  // 18. /data file paths are allowlisted to safe BIDS-like path segments.
  it('rejects malformed, encoded, traversing, and query-bearing /data file paths', async () => {
    const cases = [
      '/data/nm000148/latest/',
      '/data/nm000148/v1.0/manifest.json',          // version must be vX.Y.Z
      '/data/ds002893/latest/manifest.json',        // ds is OpenNeuro, not NEMAR
      '/data/nm000148/latest/sub-1//eeg/foo.edf',
      '/data/nm000148/latest/sub-1/eeg/bad name.edf',
      '/data/nm000148/latest/sub-1/eeg/foo.edf?redirect=https://evil.example',
    ];
    for (const p of cases) {
      const req = makeRequest(p);
      const res = await worker.fetch(req, {}, makeCtx());
      assert.equal(res.status, 404, `expected 404 for ${p}`);
    }
    for (const p of [
      '/data/nm000148/latest/sub-1/%2e%2e/private.edf',
      '/data/nm000148/latest/sub-1/%252e%252e/private.edf',
      '/data/nm000148/latest/sub-1%2Feeg%2Ffoo.edf',
      '/data/nm000148/latest/sub-1/../private.edf',
    ]) {
      const res = await worker.fetch(makeRawRequest(p), {}, makeCtx());
      assert.equal(res.status, 404, `expected 404 for unsafe raw path ${p}`);
    }
  });

  it('proxies stable per-file data-plane URLs with dataset, version, and BIDS path intact', async () => {
    let capturedUrl = null;
    let capturedCf = null;
    const restore = mockFetch((url, init) => {
      capturedUrl = String(url);
      capturedCf = init?.cf;
      return fakeOriginResponse({
        status: 200,
        headers: {
          'cache-control': 'public, max-age=31536000, immutable, stale-while-revalidate=3600',
        },
      });
    });
    try {
      const path = '/data/on005262/v1.2.3/sub-01/ses-02/eeg/sub-01_ses-02_task-rest%2Bface_eeg.edf';
      const res = await worker.fetch(makeRequest(path), {}, makeCtx());
      assert.equal(res.status, 200);
      assert.equal(
        capturedUrl,
        'https://data.nemar.org/on005262/v1.2.3/sub-01/ses-02/eeg/sub-01_ses-02_task-rest%2Bface_eeg.edf'
      );
      assert.equal(capturedCf?.cacheTtl, 300);
      assert.equal(
        capturedCf?.cacheKey,
        'https://data.nemar.org/on005262/v1.2.3/sub-01/ses-02/eeg/sub-01_ses-02_task-rest%2Bface_eeg.edf'
      );
      assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
      assert.equal(res.headers.get('vary'), 'Range');
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.ok(res.headers.get('access-control-expose-headers').toLowerCase().includes('content-range'));
    } finally {
      restore();
    }
  });

  it('forwards Range and conditional headers for data files and returns range metadata with CORS', async () => {
    let capturedHeaders = null;
    let capturedCf = null;
    const restore = mockFetch((_url, init) => {
      capturedHeaders = new Headers(init?.headers);
      capturedCf = init?.cf;
      return fakeOriginResponse({
        status: 206,
        body: 'bytes',
        headers: { 'content-range': 'bytes 0-4/100', 'cache-control': 'public, max-age=300' },
      });
    });
    try {
      const res = await worker.fetch(makeRequest(
        '/data/nm000148/latest/sub-01/eeg/sub-01_task-rest_eeg.edf',
        { headers: {
          Range: 'bytes=0-4',
          'If-Match': '"etag-1"',
          'If-None-Match': '"etag-1"',
          'If-Modified-Since': 'Wed, 21 Oct 2015 07:28:00 GMT',
          'If-Unmodified-Since': 'Wed, 21 Oct 2015 07:28:00 GMT',
          'If-Range': '"etag-1"',
        } }
      ), {}, makeCtx());
      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-range'), 'bytes 0-4/100');
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.equal(capturedHeaders.get('range'), 'bytes=0-4');
      assert.equal(capturedHeaders.get('if-match'), '"etag-1"');
      assert.equal(capturedHeaders.get('if-none-match'), '"etag-1"');
      assert.equal(capturedHeaders.get('if-modified-since'), 'Wed, 21 Oct 2015 07:28:00 GMT');
      assert.equal(capturedHeaders.get('if-unmodified-since'), 'Wed, 21 Oct 2015 07:28:00 GMT');
      assert.equal(capturedHeaders.get('if-range'), '"etag-1"');
      assert.equal(capturedCf?.cacheTtl, 0, 'conditional responses must not share an unconditional cache entry');
    } finally {
      restore();
    }
  });

  it('uses distinct cache keys for different Range requests to the same data file', async () => {
    const capturedKeys = [];
    const restore = mockFetch((_url, init) => {
      capturedKeys.push(init?.cf?.cacheKey);
      return fakeOriginResponse({ status: 206, headers: { 'content-range': 'bytes 0-4/100' } });
    });
    try {
      const path = '/data/nm000148/v1.0.0/sub-01/eeg/sub-01_task-rest_eeg.edf';
      for (const range of ['bytes=0-4', 'bytes=5-9']) {
        await worker.fetch(makeRequest(path, { headers: { Range: range } }), {}, makeCtx());
      }
      assert.equal(capturedKeys.length, 2);
      assert.notEqual(capturedKeys[0], capturedKeys[1]);
      assert.ok(capturedKeys[0].includes('__eegdash_range=bytes%3D0-4'));
      assert.ok(capturedKeys[1].includes('__eegdash_range=bytes%3D5-9'));
    } finally {
      restore();
    }
  });

  it('sets a browser max-age cap when the origin only supplies s-maxage', async () => {
    const restore = mockFetch(() => fakeOriginResponse({
      headers: { 'cache-control': 'public, s-maxage=3600' },
    }));
    try {
      const res = await worker.fetch(
        makeRequest('/data/nm000148/latest/sub-01/eeg/sub-01_task-rest_eeg.edf'),
        {},
        makeCtx()
      );
      assert.equal(res.headers.get('cache-control'), 'public, s-maxage=300, max-age=300');
    } finally {
      restore();
    }
  });

  // 19. Metadata response cache stays short, and per-file routes separately
  // cap lifetime to the data API's visibility authorization window.
  it('caps cache TTL at 300s for /data/ responses', async () => {
    let capturedCf = null;
    const restore = mockFetch((url, init) => {
      capturedCf = init?.cf;
      return fakeOriginResponse({ status: 200, body: '[]', headers: { 'content-type': 'application/json' } });
    });
    try {
      const req = makeRequest('/data/nm000148/latest/manifest.json');
      const res = await worker.fetch(req, {}, makeCtx());
      assert.equal(res.status, 200);
      assert.equal(capturedCf?.cacheTtl, 300, 'cacheTtl must be 300s for metadata');
      // And the cache-control we hand back to the browser must reflect that.
      const cc = res.headers.get('cache-control') || '';
      assert.ok(/max-age=(60|300)/.test(cc), `cache-control should be short for metadata, got ${cc}`);
      assert.ok(!cc.includes('immutable'),
        'mutable /data responses must not be marked immutable');
    } finally {
      restore();
    }
  });

  it('caps browser freshness at 300s for manifest and metadata responses', async () => {
    for (const path of [
      '/data/nm000148/latest/manifest.json',
      '/data/nm000148/latest/metadata.json',
    ]) {
      let capturedCf = null;
      const restore = mockFetch((_url, init) => {
        capturedCf = init?.cf;
        return fakeOriginResponse({
          headers: { 'cache-control': 'public, max-age=86400' },
        });
      });
      try {
        const res = await worker.fetch(makeRequest(path), {}, makeCtx());
        assert.equal(res.status, 200);
        assert.equal(capturedCf?.cacheTtl, 300);
        assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
      } finally {
        restore();
      }
    }
  });

  it('preserves stricter cache directives on NEMAR metadata responses', async () => {
    const restore = mockFetch(() => fakeOriginResponse({
      headers: { 'cache-control': 'private, no-store, max-age=86400' },
    }));
    try {
      const res = await worker.fetch(
        makeRequest('/data/nm000148/latest/metadata.json'),
        {},
        makeCtx()
      );
      assert.equal(res.headers.get('cache-control'), 'private, no-store, max-age=300');
    } finally {
      restore();
    }
  });
});
