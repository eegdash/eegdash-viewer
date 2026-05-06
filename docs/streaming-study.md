# Streaming Study

## Question

The user noticed: every BIDS EEG file has a header that pins down the
binary layout exactly (channel count, sample rate, byte stride). Each
sample's address in the file is computable. So pulling the visible
window shouldn't have to be a single big blocking fetch — it should
be possible to **stream** the data and start drawing as bytes arrive.
Is the slow 60-second window pull (0.3-0.7 MB/s observed) actually a
streaming-vs-batch problem, or something else?

## What we already had

The readers already use HTTP `Range` to pull only the visible window
— never the whole file. So we weren't downloading the whole file
ever. But: each window was pulled as ONE `Range` request, even when
the window is many megabytes.

## Bench

`scripts/bench-fetch.mjs` pulls 38.4 MB from OpenNeuro S3 three ways
against the same file (different byte offsets, so HTTP cache can't
fake any result):

| Pattern                    |  Time    | Throughput   |
|----------------------------|---------:|-------------:|
| 1× `Range: 60s`            | **52.5s**| **0.73 MB/s**|
| 6× `Range: 10s` parallel   | **11.4s**| **3.36 MB/s**|
| 6× `Range: 10s` sequential | 52.6s    | 0.73 MB/s    |

**4.6× speedup** over the same total bytes. Sequential is identical
to single, so it's not "more bytes to amortize" — it's HTTP/2
multiplexing on the same TCP connection bypassing OpenNeuro S3's
**per-connection bandwidth cap**.

## Decision

Implement **tiled range fetching** inside `HttpRange.rangeFetch`,
transparent to every reader.

```
TILE_THRESHOLD_BYTES = 4 MiB      → reads ≥ 4 MiB tile, smaller stay single
TILE_TARGET_BYTES    = 2 MiB      → ~2 MiB per tile
TILE_MAX_PARALLEL    = 8          → polite HTTP/2 client
```

A 60-second window from a 5 kHz × 64 ch recording (38 MB) splits into
8 tiles of ~5 MB. All eight fly in parallel on one TCP connection;
results are concatenated into a single `ArrayBuffer` the reader
consumes the same way it always did.

The reader API didn't change. No format-specific code changed.
`AbortController`'s `signal` propagates to every tile so cancelling a
pan still aborts every in-flight request.

## Validation

Before tiling — `integration.mjs` 60s stress test:
```
38.4 MB pulled · 142120ms · 0.3 MB/s
```

After tiling — same test:
```
38.4 MB · 7027ms · 5.5 MB/s
```

**~20× wall-time improvement** on the same recording, same bytes,
same machine, same network.

The full integration + stress suite (106 checks across 7 OpenNeuro
recordings, three formats) runs in 36s end-to-end via `npm test`.

## What we did NOT build (and why)

**Streaming decode** (`fetch().body` ReadableStream → decode chunks
as they arrive → render incrementally) was the other candidate. It
would lower **time-to-first-pixel** for huge windows, but doesn't
move total throughput — that's pinned at S3's aggregate cap whether
we batch-decode or stream-decode.

For the typical 10 s pan at 1 kHz × 64 ch = 1.3 MB, tile fetching
already gets us to first pixel in ~1.5 s on a cold cache. Streaming
decode could push that to ~200 ms but at the cost of:

- Per-format chunk-boundary handling (sample-stride alignment, 24-bit
  BDF crossing chunk edges, EDF data-record stitching)
- Renderer changes to redraw on chunk events instead of one big
  `readWindow` resolve
- AbortController semantics inside an async iterator

The complexity isn't worth it until users start asking for >30s
windows interactively. Tile fetching alone gets us 80% of the
benefit at 5% of the engineering cost.

## Threshold tuning

`TILE_THRESHOLD_BYTES = 4 MiB` is a heuristic, not an optimum. Below
that, per-fetch HTTP overhead would dominate and tiling actively
hurts. The real per-tile floor is closer to 1 MiB on cold S3
connections; lowering it further made the 0.5s windows in the
"30 disjoint reads" stress test ~10% slower because each pulled into
the tile path unnecessarily. Keep 4 MiB unless we see real per-pan
windows in that range.

## How to reproduce

```sh
# Bench (the table above)
npm run bench

# Full test + stress suite (106 checks, ~35s)
npm test

# Just one suite
npm run test:unit
npm run test:integration
```
