/**
 * eegdash-cdn — Cloudflare Worker reverse proxy for OpenNeuro S3,
 * NEMAR S3, and the data.nemar.org metadata API (none of which
 * advertise CORS to browser clients).
 *
 * Goal: drop cold-pan latency from ~700 ms (raw S3 us-east-1, HTTP/1.1)
 * to ~50 ms (edge POP, HTTP/3, multiplexed cache hit). For NEMAR the
 * value is also CORS — direct browser fetches against
 * nemar.s3.amazonaws.com or data.nemar.org fail (the former has no
 * Access-Control-Allow-Origin at all, the latter sets every CORS
 * header *except* Allow-Origin). Proxying through this worker fixes
 * both as a side effect of the existing CORS layer.
 *
 * URL grammar:
 *   /dsNNNNNN/<bids-path>                                      → openneuro.org/dsNNNNNN/<bids-path>
 *   /(nm|on|xx)NNNNNN/objects/<sha-key>                        → nemar/<id>/objects/<sha-key>
 *   /data/(nm|on|xx)NNNNNN/(latest|vN.N.N)/(manifest|metadata) → data.nemar.org/<id>/<ver>/<file>.json
 *
 * Security model:
 *  - Only GET/HEAD allowed (no mutation proxy)
 *  - Path must match one of the three patterns above (no open-proxy risk)
 *  - The /data/ proxy is scoped to manifest.json + metadata.json only
 *    (no path wildcard) so it can't be abused as a generic data.nemar.org
 *    relay
 *  - Upstream status codes outside {200,206,304,404} → 502
 */

const UPSTREAM_OPENNEURO = 'https://s3.amazonaws.com/openneuro.org';
// NEMAR S3 lives in us-east-2; the global virtual-hosted endpoint
// auto-routes there transparently. The legacy path-style endpoint
// would 301 to the regional URL on cold lookups.
const UPSTREAM_NEMAR     = 'https://nemar.s3.amazonaws.com';
const UPSTREAM_NEMAR_API = 'https://data.nemar.org';

// Three recognised path shapes. Anything else 404s — keeps the worker
// scoped to the buckets/APIs we're explicitly proxying for.
const VALID_OPENNEURO = /^\/ds\d{6}\//;
// (nm|on|xx) covers native NEMAR, OpenNeuro mirrors, and sandbox.
// Lockstep with bids-recording.js:isNemarDatasetId.
const VALID_NEMAR     = /^\/(?:nm|on|xx)\d{6}\/objects\/[A-Za-z0-9._-]+$/;
// data.nemar.org metadata endpoints. <version> is `latest` or a
// `vX.Y.Z` tag. <file> is one of two whitelisted names.
const NEMAR_API_PREFIX = '/data';
const VALID_NEMAR_API = /^\/data\/(?:nm|on|xx)\d{6}\/(?:latest|v\d+\.\d+\.\d+)\/(?:manifest|metadata)\.json$/;

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
  // data.nemar.org content-negotiates HTML vs JSON on /<id>/ — for the
  // /data/ proxy we only forward `accept` to disambiguate. S3 ignores it.
  'accept',
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
    // Three recognised shapes (see top-of-file URL grammar). Anything
    // else → 404. The /data/ shape strips its `/data` prefix before
    // forwarding so the upstream sees data.nemar.org/<id>/<ver>/<file>.
    const url = new URL(request.url);
    let upstreamBase;
    let upstreamPath = url.pathname;
    let isNemarApi = false;
    if (VALID_OPENNEURO.test(url.pathname)) {
      upstreamBase = UPSTREAM_OPENNEURO;
    } else if (VALID_NEMAR.test(url.pathname)) {
      upstreamBase = UPSTREAM_NEMAR;
    } else if (VALID_NEMAR_API.test(url.pathname)) {
      upstreamBase = UPSTREAM_NEMAR_API;
      upstreamPath = url.pathname.slice(NEMAR_API_PREFIX.length);
      isNemarApi = true;
    } else {
      return new Response(
        'Not found — path must match /dsNNNNNN/..., ' +
        '/(nm|on|xx)NNNNNN/objects/<sha>, or ' +
        '/data/(nm|on|xx)NNNNNN/(latest|vN.N.N)/(manifest|metadata).json',
        { status: 404, headers: corsHeaders() }
      );
    }

    // --- Build upstream request ------------------------------------------
    const upstreamUrl = `${upstreamBase}${upstreamPath}`;

    const upstreamHeaders = new Headers();
    for (const h of FORWARD_REQUEST_HEADERS) {
      const v = request.headers.get(h);
      if (v) upstreamHeaders.set(h, v);
    }

    // --- Fetch from origin via Cloudflare Cache API ----------------------
    // Cache TTL split:
    //  - object bytes (OpenNeuro / NEMAR S3): 1 year (immutable, content-
    //    addressed for NEMAR; published-immutable for OpenNeuro)
    //  - data.nemar.org metadata: 5 minutes. manifest.json carries
    //    1-hour presigned URLs; capping at 5 min leaves a 55 min margin
    //    before any cached URL expires. metadata.json catalog data
    //    changes on reindex, so a short TTL is also appropriate there.
    const cacheTtl = isNemarApi ? 300 : 31536000;
    let originResponse;
    let cacheStatus = 'origin'; // will be overridden if CF cache info available
    try {
      originResponse = await fetch(upstreamUrl, {
        method,
        headers: upstreamHeaders,
        cf: {
          cacheTtl,
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

    // Ensure downstream browsers can also cache immutable responses.
    // S3 object bytes are content-addressed → safe to mark immutable.
    // data.nemar.org metadata is mutable on reindex → short TTL, no
    // immutable flag, and we prefer the upstream's own cache-control
    // (which already sets 60s/300s) when it provides one.
    if (!responseHeaders.has('cache-control')) {
      responseHeaders.set(
        'cache-control',
        isNemarApi
          ? 'public, max-age=300'
          : 'public, max-age=31536000, immutable'
      );
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
