# eegdash-cdn — Cloudflare Worker proxy for OpenNeuro S3

Reverse-proxies `s3.amazonaws.com/openneuro.org` through Cloudflare's global
edge network, dropping cold-pan latency from ~700 ms (raw S3 us-east-1,
HTTP/1.1) to ~50 ms (edge POP, HTTP/3, multiplexed cache hit).

**This is a standalone deploy — it does NOT modify the viewer source.**

---

## How it works

```
Viewer (browser)
    ↓  GET https://eeg-cdn.example.com/ds002893/.../sub-001_eeg.edf
         Range: bytes=0-262143
Cloudflare Worker (nearest POP, HTTP/3)
    ↓  cache MISS only: GET https://s3.amazonaws.com/openneuro.org/ds002893/...
S3 us-east-1  (hit once per fixture per POP, then served from edge cache)
```

- First request per fixture (any POP worldwide): ~700 ms — origin fetch.
- All subsequent requests: ~50 ms from the edge cache.
- HTTP/3 (QUIC) between browser and Cloudflare means parallel Range fetches
  share one connection, removing the 6-TCP-connection ceiling imposed by
  raw S3 + HTTP/1.1.

---

## Prerequisites

- A Cloudflare account (free tier is sufficient).
- Node.js >= 20 and npm.
- Wrangler CLI:

```bash
npm install -g wrangler@latest
```

---

## One-time setup

```bash
wrangler login           # opens browser → authenticate with your Cloudflare account
```

---

## Deploy preview (workers.dev subdomain)

```bash
cd cdn-worker
npm install              # installs wrangler locally as devDependency
npm run deploy           # wrangler deploy
```

Wrangler prints a URL like:
```
https://eegdash-cdn.<your-account>.workers.dev
```

That URL is live immediately and you can use it as your CDN prefix for testing.

---

## Add a custom domain (optional)

1. Point a domain (or subdomain) at Cloudflare's nameservers in your DNS
   registrar.

2. Uncomment and fill in the `routes` block in `wrangler.toml`:

```toml
routes = [
  { pattern = "eeg-cdn.example.com/*", zone_name = "example.com" }
]
```

3. At your DNS registrar (or Cloudflare DNS dashboard), add:

```
eeg-cdn   CNAME   eegdash-cdn.<your-account>.workers.dev
```

4. Redeploy:

```bash
npm run deploy
```

Your worker is now reachable at `https://eeg-cdn.example.com/ds002893/...`.

---

## Verify the worker

### Cache-Control and x-eegdash-cdn header

```bash
# First request (MISS or ORIGIN)
curl -si "https://eegdash-cdn.<account>.workers.dev/ds002893/sub-001/eeg/sub-001_task-rest_eeg.edf" \
  | grep -E "^(HTTP|x-eegdash-cdn|cache-control|cf-cache-status)"

# Second request — should show x-eegdash-cdn: hit
curl -si "https://eegdash-cdn.<account>.workers.dev/ds002893/sub-001/eeg/sub-001_task-rest_eeg.edf" \
  | grep -E "^(HTTP|x-eegdash-cdn|cf-cache-status)"
```

### Range (partial fetch) support

```bash
curl -si \
  -H "Range: bytes=0-1023" \
  "https://eegdash-cdn.<account>.workers.dev/ds002893/sub-001/eeg/sub-001_task-rest_eeg.edf" \
  | grep -E "^(HTTP|content-range|content-length)"
# Expect: HTTP/2 206 and content-range: bytes 0-1023/<total>
```

### CORS (viewer can read response headers cross-origin)

```bash
curl -si -X OPTIONS \
  -H "Origin: https://eegdash.github.io" \
  -H "Access-Control-Request-Headers: Range" \
  "https://eegdash-cdn.<account>.workers.dev/ds002893/sub-001/eeg/foo.edf" \
  | grep -i "access-control"
# Expect: access-control-allow-origin: *
#         access-control-expose-headers: Content-Range, ETag, ...
```

---

## Wire into the viewer (two-line change — your call)

The viewer constructs S3 URLs in two places. Once you have your CDN deployed,
swap the S3 prefix for your CDN URL:

**`bids-recording.js`** — search for the string `s3.amazonaws.com/openneuro.org`.
Replace it with your CDN hostname, for example using a module-level constant:

```js
// bids-recording.js  (near the top, or driven by a URL param)
const CDN_BASE = typeof EEG_CDN_URL !== 'undefined'
  ? EEG_CDN_URL                                    // injected at build time
  : 'https://s3.amazonaws.com/openneuro.org';      // default (raw S3)
```

Then wherever the file builds the fetch URL:
```js
// before:  `https://s3.amazonaws.com/openneuro.org/${datasetId}/...`
// after:
`${CDN_BASE}/${datasetId}/...`
```

**`viewer.js`** — if it also hard-codes the S3 prefix for sidecar JSON fetches,
apply the same substitution.

A simple way to toggle without touching source code: add `?cdn=https://eeg-cdn.example.com`
to the viewer URL, and read `new URLSearchParams(location.search).get('cdn')` to
override `CDN_BASE` at runtime.

---

## Cost analysis

| Tier | Requests/day | Approx. pans/day | Monthly cost |
|---|---|---|---|
| Free | 100,000 | ~20,000 | $0 |
| Workers Paid | 10,000,000 | ~2,000,000 | $5/mo + $0.30/M over |

A typical research session = ~50 pans. Free tier comfortably handles
~400 concurrent researchers/day. Switch to Workers Paid ($5/mo) if you
expect wider public use.

Egress from Cloudflare to users: **free** (Cloudflare does not charge for
outbound bandwidth from Workers). Origin pull (Cloudflare → S3): charged
by S3 at $0.09/GB — but each fixture is pulled only once per POP, so for
a 125 MB EDF viewed 1,000 times, that's $0.011 origin bandwidth total.

---

## Cache invalidation

OpenNeuro datasets are **published immutable** — a `ds002893` file never
changes after publication. The 1-year `cacheTtl` is safe.

If you ever need to purge (e.g., you redeploy the worker or a dataset
correction is issued through OpenNeuro's own system):

**Via Cloudflare dashboard:**
Dashboard → your zone → Caching → Cache Purge → Purge by URL or Purge Everything.

**Via Wrangler (purge by tag is Workers Paid+):**
```bash
# Purge a specific URL:
wrangler pages deployment tail   # not applicable; use dashboard instead
```

**Via API:**
```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/purge_cache" \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  --data '{"files":["https://eeg-cdn.example.com/ds002893/sub-001/eeg/foo.edf"]}'
```

In practice, since datasets are immutable, cache invalidation should
never be necessary in normal operation.

---

## Running tests locally

Tests do not require a Cloudflare account or a running wrangler dev server.
They import the worker module directly in Node.js and mock `globalThis.fetch`
to simulate origin responses.

```bash
cd cdn-worker
npm install
npm test
```
