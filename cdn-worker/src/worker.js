/**
 * eegdash-cdn — Cloudflare Worker reverse proxy for OpenNeuro S3
 *
 * Goal: drop cold-pan latency from ~700 ms (raw S3 us-east-1, HTTP/1.1)
 * to ~50 ms (edge POP, HTTP/3, multiplexed cache hit).
 *
 * Security model:
 *  - Only GET/HEAD allowed (no mutation proxy)
 *  - Only paths matching /ds\d{6}/ are forwarded (no open-proxy risk)
 *  - Upstream status codes outside {200,206,304,404} → 502
 */

const UPSTREAM_BASE = 'https://s3.amazonaws.com/openneuro.org';

// Regex: must start with /dsNNNNNN/ (six digits, OpenNeuro convention)
const VALID_PATH = /^\/ds\d{6}\//;

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

    // --- Validate path (prevent open-proxy abuse) ------------------------
    const url = new URL(request.url);
    if (!VALID_PATH.test(url.pathname)) {
      return new Response('Not found — path must match /dsNNNNNN/...', {
        status: 404,
        headers: corsHeaders(),
      });
    }

    // --- Build upstream request ------------------------------------------
    const upstreamUrl = `${UPSTREAM_BASE}${url.pathname}`;

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
