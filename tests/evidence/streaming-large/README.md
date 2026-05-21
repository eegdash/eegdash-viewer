# Evidence: Streaming FIFF + EEGLAB > 200 MB

## results.jsonl

One JSON line per dataset with shape:
```
{ dataset_id, format, n_bytes, open_ms, read_ms, peak_heap_mb_delta, verdict }
```

## 2026-05-21 — Plan A Task 5 (FIFF browser test)

**Outcome:** PARTIAL — read_ms and peak_heap_mb_delta both inside budget;
open_ms tight but exceeds the 5 s threshold on the largest target due to
sequential CDN round-trips and limited HTTP/2 throughput from
cdn.eegdash.org. Two architectural blockers surfaced:

### Blocker A: cdn.eegdash.org HEAD-poisons-Range cache bug

When the browser issues a `HEAD` request to a FIFF on cdn.eegdash.org,
the Cloudflare worker caches the response with cache-key = upstream URL
(see `cdn-worker/src/worker.js` ~line 151). A subsequent GET with a
`Range:` header hits the same cache slot and is served as HTTP 200 +
full body instead of HTTP 206 + the requested range. Verified via curl:

```
HEAD https://cdn.eegdash.org/ds003694/.../meg.fif   → 200 (header-only OK)
GET  Range: bytes=N-M  same URL                      → 200 + 2 GB body  ← BUG
```

A cold-cache curl with `?cache-bust` returns 206 + range correctly.

**Workaround applied (in plan scope):** `formats/fiff.js` now skips
`HttpRange.probeLength` (which HEAD-probes by default) and instead
uses a 1-byte `Range: bytes=0-0` GET, reading the total file size
from `Content-Range`. This avoids the HEAD entirely, so the CDN
cache slot is only ever populated with the (correct) byte-range
response. No `formats/_http_range.js` changes — the workaround
lives entirely inside the FIFF reader.

**Follow-up:** the cdn-worker should split HEAD and GET cache slots
(see Cloudflare Workers cache best-practice). Filing a follow-up
task.

### Blocker B: ds003682 (644 MB) has no tag directory

`FIFF_DIR_POINTER` payload = -1 on ds003682's main MEG file (stream-
writer output, common for older Elekta exports). Our range-based
`api.open` falls back to `fetchBuffer`, capped at 200 MB. The 644 MB
file exceeds the cap, so open() throws:
> `fiff: file is 615 MB and has no tag directory — cannot stream.`

This is a structural property of the file, not our code. The plan
described this fallback explicitly (Background section, "Fallback
for no-directory files") but assumed ~5 % of OpenNeuro FIFFs would
be no-directory. ds003682 is one of them.

**Recommended path forward:**
1. Re-export the file with a modern FIFF writer that emits a
   directory tag (one-time fix per dataset).
2. OR: extend the streaming fallback to do a sequential-walk + tile
   strategy when no directory is available (large effort, separate
   plan).

### ds003694 (2 GB, has directory): open_ms 7.1 s ≥ 5 s budget

Timing breakdown from a real browser run:
```
  693 ms — page load + sidecar 404 probes
 1051 ms — probeLength via Range bytes=0-0 (~360 ms)
 1715 ms — tail probe (256 KB)
 2298 ms — head probe (256 KB)
 4298 ms — block-id payload batch (9 parallel 4-byte fetches, ~2 s)
 4500 ms — meas_info fetch (~88 KB)
 5500 ms — first readWindow render
 7100 ms — stage-caption visible (test gate)
```

The 5 s plan budget assumed effectively unlimited CDN throughput.
On a cold cdn.eegdash.org connection from a local Chromium the
sequential chain costs ~5-7 s wall-clock. Subsequent loads are
faster (CDN cache hit + browser HTTP cache). Single-load wall-time
is bounded by CDN RTT × number of sequential roundtrips, not by
file size.

**Heap and readWindow budgets passed comfortably:**
- read_ms: 21 ms  (budget: 2000 ms)
- peak_heap_mb_delta: 0 MB (budget: 100 MB)

So the range-based reader DOES decode 2 GB FIFFs with minimal
memory and serves windows in milliseconds — but the cold-start
open() crosses the 5 s line.

**Recommended path forward:**
1. Loosen the plan's 5 s budget to 10 s (it conflates open + first
   render + sidecar discovery — 7 s is a fine real-world target).
2. OR: pre-fetch head+tail in parallel via Promise.all (single
   network roundtrip wall-clock instead of sequential) — likely
   saves ~1 s.
3. OR: extend the cdn-worker to pre-cache the first 1 MB on cold
   start.
