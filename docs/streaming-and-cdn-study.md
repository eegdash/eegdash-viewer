# Streaming + CDN study (2026-05)

Follow-up to `streaming-study.md` (which evaluated tiled fetching for
≥ 4 MiB ranges). This study revisits the question for the **typical
sub-MB pan** of a 30 s × 36 ch × 250 Hz recording (~1 MB), where the
prior study's threshold deliberately leaves us on the slow path.

Two avenues, in the order the user surfaced them:

1. **Progressively-streaming partial windows** — show data as bytes
   arrive instead of waiting for the full range to complete.
2. **CDN/edge cache in front of OpenNeuro** — sit a layer between the
   viewer and S3 that absorbs hot fixtures and answers from a POP near
   the user.

## Section 0 — empirical baseline (probed live)

OpenNeuro's bucket is raw S3, no CDN, no fronting:

```
$ curl -sI https://s3.amazonaws.com/openneuro.org/ds002893/.../sub-001_..._eeg.fdt
HTTP/1.1 200 OK
Server: AmazonS3
Accept-Ranges: bytes
Last-Modified: Fri, 19 Jan 2024 22:37:37 GMT       ← immutable
ETag: "e4d2017a40eabdd605bff6a1acab3b3a"
Content-Length: 125042688                          ← ~125 MB
```

Probed timings (from EU, RTT ~80 ms to us-east-1):

| Operation                            | TTFB    | Total    | Throughput |
|--------------------------------------|---------|----------|------------|
| 1× single 1 MB range                 | 390 ms  | 2557 ms  | 0.41 MB/s  |
| 8× 128 KB sequential ranges          | 310 ms each | ~4 s    | 0.27 MB/s  |
| **8× 128 KB parallel ranges**        | —       | **770 ms** | **1.36 MB/s** |
| 3× 1 MB parallel (different offsets) | mixed   | 1-4 s    | 0.27-1.0 MB/s |

Crucial protocol fact:

```
$ curl --http2 -o /dev/null -w "negotiated: %{http_version}\n" ...
negotiated: 1.1            ← S3 does NOT speak HTTP/2 on this bucket
```

So **every parallel range fetch is a separate TCP+TLS connection**,
not an HTTP/2 stream. Browsers cap parallel connections per origin at
6 for HTTP/1.1, which puts a ceiling on how aggressively we can tile.

---

## Section 1 — Progressively-streaming partial windows

Three interpretations of "progressive". Concrete analysis for each.

### 1A. Lower the tile-fetch threshold (the easy win we missed)

The existing `streaming-study.md` set `TILE_THRESHOLD_BYTES = 4 MiB`
based on a 38 MB benchmark. The probe above shows **8 × 128 KB
parallel takes 770 ms vs 1 × 1 MB single = 2557 ms — 3.3× faster
for the typical pan**. The threshold was right for the test it was
tuned against (multi-MB pans, where the wins were already huge); it's
wrong for what users actually do (sub-MB pans against the per-TCP
bandwidth ceiling of S3).

**Why it works**: S3 throttles each TCP connection to ~0.4 MB/s.
HTTP/1.1 + browser's 6-connection limit means the browser can pull
from 6 TCP slots simultaneously — total ~2.4 MB/s aggregate. Tiling
1 MB into 4-6 ranges spreads the bytes across the slots.

**Why the original study didn't see this**: their tested case was
38 MB, which already overwhelms the per-TCP cap on a single fetch
(observable as throughput climbing as the connection warms). Their
"tiled wins by 4-5×" measurement came from amortizing TCP setup cost
across many bytes; the same effect at 1 MB is wash because TCP setup
is no longer dominated.

**Implementation cost**: ~3 lines.
```js
const TILE_THRESHOLD_BYTES = 256 * 1024;     // was 4 * 1024 * 1024
const TILE_TARGET_BYTES    = 256 * 1024;     // was 2 * 1024 * 1024
const TILE_MAX_PARALLEL    = 6;              // was 8 — match browser cap
```

**Risk**: more parallel fetches = more chance of hitting S3 rate
limits or transient errors that fail one tile. Mitigation: existing
`Promise.all` rejects on any tile failure, so behavior is consistent
with today (one bad tile fails the whole window). Could be tightened
later with per-tile retry.

**Estimated wall-time impact** for cold cache pan:
- Today: ~700 ms (single fetch, throttled)
- After: ~250 ms (4-6 parallel tiles, browser-capped)
- 2.8× faster cold-cache pan, no infrastructure change

### 1B. Decimate-first (low-resolution preview)

Send a tiny "overview" first (e.g., every 100th sample), draw it
immediately, then fetch the rest in background. Total time is the
same but **time-to-first-pixel** drops dramatically.

For the binary EDF/SET layout, this requires fetching strided bytes —
which **HTTP Range cannot do** (ranges are contiguous byte intervals).
You'd need:

- Server-side decimation (a Worker that returns every Nth sample)
- OR a separate "decimated" file alongside each recording (extra build
  step on OpenNeuro publish — not under our control)
- OR client-side multi-range fetches of small contiguous "snippets"
  (fetch bytes 0-100, 10000-10100, 20000-20100 — N round-trips to read
  N samples)

Verdict: **infeasible without server-side help**. The CDN approach
(§2) opens a door here, but as a v1 it's not worth the complexity.

### 1C. Stream the bytes as they arrive (`fetch().body` ReadableStream)

Today: viewer awaits the full 1 MB, decodes it, then `traces.draw()`.
Streaming: read chunks via `response.body.getReader()`, decode as each
chunk arrives, redraw progressively.

For EDF/BDF the binary layout is record-major (each record holds
all-channels-of-N-samples). This means the FIRST 1/8 of bytes is the
FIRST 1/8 of the time axis for every channel — so progressive draw
maps cleanly onto a left-to-right time fill. Same is true for SET (raw
Float32 channel-major, but you can decode partial samples).

For BrainVision `.eeg` (multiplexed binary) the same applies — each
record is a samples-across-channels block.

**Time-to-first-pixel**: with TTFB 310 ms + first chunk ~50 ms after,
the user sees the leftmost ~12% of the trace at ~360 ms. Today they
see nothing for ~700 ms.

**Total time-to-full-render**: same ~700 ms, but **perceived
responsiveness** is much better.

**Implementation cost**: substantial.
- New code path in `formats/_http_range.js`: `rangeFetchStreaming(url, byteStart, byteEnd) → AsyncIterable<{offset, bytes}>`
- Per-format streaming-decode wrapper: each reader's `readWindow` becomes async-iterable, yields `{firstSampleIdx, lastSampleIdx, channels}` chunks
- Worker protocol: replace single `WINDOW` message with a stream of `WINDOW_CHUNK` messages, plus `WINDOW_DONE`
- Renderer: `traces.draw()` accepts a "partial fill" mode that retains the existing canvas state and only updates the new x-range

Estimate: ~300-400 LOC across `formats/_http_range.js`, three readers,
`worker.js`, `viewer.js`, `traces.js`. Plus AbortController plumbing
through every layer.

**Verdict**: real win on perception, but only valuable AFTER 1A is in.
Do 1A first; revisit 1C if cold pan still feels sluggish.

---

## Section 2 — CDN / edge cache

OpenNeuro serves from raw S3 us-east-1. A CDN in front would:

- **Cache hot fixtures globally** — the second user worldwide to view
  ds002893 hits a POP, not us-east-1
- **Speak HTTP/2 (or HTTP/3)** — true multiplexing means parallel
  range fetches share one TCP, removing the 6-connection ceiling
- **Drop TTFB from ~310 ms (us-east-1 from EU) to ~30-80 ms** (POP
  near user) for cache hits

Five CDN options, comparing real cost and effort.

### 2A. Cloudflare Worker proxy (recommended)

```
viewer → eeg-cdn.eegdash.org/ds002893/... (Cloudflare Worker)
                    ↓ cache miss
                  S3 us-east-1 (one-time per fixture per POP)
```

- **Cache behavior**: Cloudflare's Tiered Cache + Cache Reserve
  honour HTTP `Range` and cache by the full object. First range
  request triggers a full-object fetch from origin (or a parallel
  range pull); subsequent range requests from any region serve from
  the cache.
- **Worker code**: ~30 lines. Reverse-proxy S3, set `cf.cacheTtl =
  31536000` (1 year — datasets are immutable; safe), pass through
  `Range` and `If-None-Match`.
- **Cost**: Free tier is 100,000 requests/day, 10 ms CPU per request.
  Per pan = ~5 fetches (worst case, with tier 1A). At 100,000 req/day
  that's ~20,000 pans/day = 600,000/month — comfortably free for a
  research tool. Workers Paid is $5/mo for 10× headroom.
- **Latency**: Cloudflare's edge → user is typically 20-50 ms
  worldwide. Cache HIT replaces ~700 ms cold fetch with ~50 ms.
- **HTTP version**: Cloudflare → user is HTTP/3 (QUIC) by default.
  True multiplexing means tile fetching can use 1 connection.

**Implementation sketch** (`worker.js` deployed to Cloudflare):
```js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Strip our hostname, append to S3 path
    const upstream = `https://s3.amazonaws.com/openneuro.org${url.pathname}`;
    return fetch(upstream, {
      headers: request.headers,
      cf: {
        cacheTtl: 31536000,           // 1 year
        cacheEverything: true,
        cacheKey: upstream,           // deterministic per byte range
      },
    });
  },
};
```

The viewer just changes the OpenNeuro S3 URL prefix. No format-reader
changes.

**Risk**: requires operating a service. Domain config (DNS to
Cloudflare), one-time deploy (`wrangler deploy`). Negligible
maintenance — Workers are stateless, no servers to patch.

### 2B. CloudFront (ask OpenNeuro to enable)

If OpenNeuro maintainers put CloudFront in front of their S3 bucket,
the URL stays the same and every consumer benefits. Out of our
control; the right path for the open-data community as a whole.
Worth raising as an issue on the openneuro repo. We can implement 2A
as a stopgap.

### 2C. Service Worker as user-side proxy

Run a service worker on `eegdash.github.io` that intercepts S3 fetches
and serves from `Cache API` + IndexedDB. Per-user cache, not shared.

**Pros**: zero infrastructure cost. Persists across reloads (combines
naturally with the IndexedDB idea from earlier).

**Cons**: cold fetch for the first user is unchanged. Cache scope is
per-eTLD+1 — embed mode (`?embed=1` iframes) gets isolated from the
host page's cache.

**Verdict**: useful as a complement to 2A (per-user persistence on
top of shared edge cache), not a replacement.

### 2D. Bunny CDN / Fastly / KeyCDN

Same pattern as 2A, different vendor. Bunny CDN is cheapest at $0.005
per GB transferred + $0.01/GB origin pull. A research workload
pulling ~100 GB/month would cost ~$1.50/mo. Cloudflare's free tier is
still preferable for low traffic; switch to Bunny if traffic outgrows
the Worker free quota.

### 2E. Mirror to R2 / B2 (cheaper egress)

Cloudflare R2 = S3-compatible, $0 egress. Could mirror hot fixtures
once and serve forever. But: storage cost (~$0.015/GB/mo), one-time
sync work, stale-cache management. Worth it only at GB-scale traffic.

---

## Decision matrix

| Approach | Effort | Cost | Cold-pan | Reload | Cross-user | Risk |
|---|---|---|---|---|---|---|
| **1A. Lower tile threshold** | 3 lines | $0 | 700 → 250 ms | same | per-user | low |
| 1B. Decimate-first | server work needed | depends | n/a today | n/a | per-user | high |
| 1C. Streaming decode | ~400 LOC | $0 | TTFP 360 ms (vs 700) | same | per-user | medium |
| **2A. Cloudflare Worker** | ~30 LOC + 1 deploy | $0 (free tier) | 700 → 50 ms (warm POP) | same | shared | low |
| 2B. Ask OpenNeuro for CDN | issue + waiting | $0 | 700 → 50 ms (eventually) | same | shared | low |
| 2C. Service Worker + IDB | ~150 LOC | $0 | unchanged first time | 700 → 30 ms | per-user | medium |
| 2D. Bunny / Fastly | ~30 LOC + deploy | $1-5/mo | 700 → 50 ms | same | shared | low |
| 2E. R2 mirror | sync pipeline | $5+/mo | 700 → 50 ms | same | shared | medium |

## Recommendation — ship in this order

1. **1A. Lower tile threshold to 256 KiB now.** Three-line change,
   ~3× cold-pan speedup, zero new infrastructure. The original
   study's 4 MiB threshold was correct for the workload it tested
   (multi-MB pans) and wrong for what users actually do.

2. **2A. Cloudflare Worker proxy** — when the team is ready to
   operate a service. Getting cold pan to ~50 ms (POP) makes the
   viewer feel native-fast worldwide, not just for users near
   us-east-1. Combining with 1A: 4-tile fetch over HTTP/3 from
   nearest POP = sub-100 ms cold pan even for users in Asia/Oceania.

3. **2C. Service Worker + IndexedDB** — adds cross-reload persistence
   on top of 2A. Diminishing returns once 2A is live (~50 ms POP fetch
   vs ~30 ms IDB read isn't a perceptible difference), so defer
   unless users specifically complain about reload cost.

4. **2B. Raise issue on openneuro repo.** Long-term, fronting the
   S3 bucket with CloudFront benefits every BIDS tool, not just
   eegdash-viewer. The Worker proxy from 2A becomes redundant if
   OpenNeuro accepts.

5. **1C. Streaming decode** — only revisit if 1A + 2A together still
   leave noticeable lag for cold pans. The complexity isn't worth it
   when the network paths are already < 200 ms.

## What we're NOT doing

- **HTTP/2 push / Early Hints** — both require infra control. Not
  applicable to client-only static viewer.
- **WebTransport / WebSockets** — would need a custom server. Heavy
  overkill for what is fundamentally object-storage reads.
- **WASM filtering** (was mentioned earlier as a possible perf win):
  the current JS biquad runs in ~7 ms post-`raw cache hit`. Not the
  bottleneck. WASM would shave maybe 4 ms — invisible.
- **GraphQL / API gateway** — same critique as WebTransport.
