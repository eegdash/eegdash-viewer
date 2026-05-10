/**
 * eegdash-cdn — Cloudflare Worker reverse proxy for OpenNeuro S3
 * (and NEMAR S3, which has no CORS configuration of its own).
 *
 * Goal: drop cold-pan latency from ~700 ms (raw S3 us-east-1, HTTP/1.1)
 * to ~50 ms (edge POP, HTTP/3, multiplexed cache hit). For NEMAR the
 * value is also CORS — direct browser fetches against
 * nemar.s3.amazonaws.com fail (no Access-Control-Allow-Origin in the
 * response, OPTIONS preflight returns 403). Proxying through this
 * worker fixes that as a side effect of the existing CORS layer.
 *
 * URL grammar:
 *   /dsNNNNNN/<bids-path>           → openneuro.org/dsNNNNNN/<bids-path>
 *   /nmNNNNNN/objects/<sha-key>     → nemar/nmNNNNNN/objects/<sha-key>
 *
 * Security model:
 *  - Only GET/HEAD allowed (no mutation proxy)
 *  - Path must match one of the two patterns above (no open-proxy risk)
 *  - Upstream status codes outside {200,206,304,404} → 502
 */

const UPSTREAM_OPENNEURO = 'https://s3.amazonaws.com/openneuro.org';
// NEMAR S3 lives in us-east-2; the global virtual-hosted endpoint
// auto-routes there transparently. The legacy path-style endpoint
// would 301 to the regional URL on cold lookups.
const UPSTREAM_NEMAR = 'https://nemar.s3.amazonaws.com';

// Two recognised path shapes. Anything else 404s — keeps the worker
// scoped to the two buckets we're explicitly proxying for.
const VALID_OPENNEURO = /^\/ds\d{6}\//;
const VALID_NEMAR     = /^\/nm\d{6}\/objects\/[A-Za-z0-9._-]+$/;

// Status codes we are willing to pass through to the client
const ALLOWED_STATUS = new Set([200, 206, 304, 404]);

// Headers from the upstream response we want to forward to the client
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'etag',
  'last-modified',
  'accept-ranges',
  'cache-control',
];

// Headers from the client request we pass upstream
const FORWARD_REQUEST_HEADERS = [
  'range',
  'if-none-match',
  'if-modified-since',
  'if-range',
];

export default {
  /**
   * @param {Request} request
   * @param {object} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const { method } = request;

    // --- OPTIONS preflight (CORS) ----------------------------------------
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // --- Only allow GET / HEAD -------------------------------------------
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD, OPTIONS', ...corsHeaders() },
      });
    }

    // --- Validate path + pick upstream bucket ----------------------------
    // Two recognised shapes:
    //   /dsNNNNNN/...                 → OpenNeuro (BIDS-pathed)
    //   /nmNNNNNN/objects/<sha-key>   → NEMAR (git-annex SHA-keyed)
    // Anything else → 404. This keeps the worker scoped to known
    // buckets (no open-proxy risk) while transparently bridging
    // NEMAR's missing CORS.
    const url = new URL(request.url);
    let upstreamBase;
    if (VALID_OPENNEURO.test(url.pathname)) {
      upstreamBase = UPSTREAM_OPENNEURO;
    } else if (VALID_NEMAR.test(url.pathname)) {
      upstreamBase = UPSTREAM_NEMAR;
    } else {
      return new Response(
        'Not found — path must match /dsNNNNNN/... or /nmNNNNNN/objects/<sha>',
        { status: 404, headers: corsHeaders() }
      );
    }

    // --- Build upstream request ------------------------------------------
    const upstreamUrl = `${upstreamBase}${url.pathname}`;

    const upstreamHeaders = new Headers();
    for (const h of FORWARD_REQUEST_HEADERS) {
      const v = request.headers.get(h);
      if (v) upstreamHeaders.set(h, v);
    }

    // --- Fetch from S3 via Cloudflare Cache API --------------------------
    let originResponse;
    let cacheStatus = 'origin'; // will be overridden if CF cache info available
    try {
      originResponse = await fetch(upstreamUrl, {
        method,
        headers: upstreamHeaders,
        cf: {
          // Cache for 1 year — OpenNeuro datasets are published immutable
          cacheTtl: 31536000,
          cacheEverything: true,
          // Use the full upstream URL as cache key so Range sub-requests
          // each get their own slot while the full object is also cacheable
          cacheKey: upstreamUrl,
        },
      });

      // Cloudflare sets CF-Cache-Status on the response from its own cache
      const cfStatus = originResponse.headers.get('cf-cache-status');
      if (cfStatus) {
        cacheStatus = cfStatus.toLowerCase(); // HIT → "hit", MISS → "miss", etc.
      }
    } catch (err) {
      return new Response(`Bad gateway: origin unreachable (${err.message})`, {
        status: 502,
        headers: corsHeaders(),
      });
    }

    // --- Guard against unexpected upstream status codes ------------------
    if (!ALLOWED_STATUS.has(originResponse.status)) {
      return new Response(
        `Bad gateway: unexpected upstream status ${originResponse.status}`,
        { status: 502, headers: corsHeaders() }
      );
    }

    // --- Build client response -------------------------------------------
    const responseHeaders = new Headers(corsHeaders());
    for (const h of FORWARD_RESPONSE_HEADERS) {
      const v = originResponse.headers.get(h);
      if (v) responseHeaders.set(h, v);
    }

    // Instrument cache hit rate — the viewer (or devtools) can read this
    responseHeaders.set('x-eegdash-cdn', cacheStatus);

    // Ensure downstream browsers can also cache immutable responses
    if (!responseHeaders.has('cache-control')) {
      responseHeaders.set('cache-control', 'public, max-age=31536000, immutable');
    }

    return new Response(originResponse.body, {
      status: originResponse.status,
      headers: responseHeaders,
    });
  },
};

/** Returns the CORS headers required by the viewer (cross-origin fetch). */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, If-None-Match, If-Modified-Since, If-Range',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, ETag, Last-Modified, Accept-Ranges, X-EEGDash-CDN',
    'Access-Control-Max-Age': '86400',
  };
}
