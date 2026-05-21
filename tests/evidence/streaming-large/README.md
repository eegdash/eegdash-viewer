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
   saves ~1 s. APPLIED in commit (head+tail Promise.all + 16 KB
   block-id batch).
3. OR: extend the cdn-worker to pre-cache the first 1 MB on cold
   start.

## 2026-05-21 — Plan A Task 9 (EEGLAB browser test)

**Outcome:** BLOCKED — both target inline .set files are
struct-wrapped (EEG.data lives inside an `EEG` mxSTRUCT matrix
element). MatV5.scanElements only walks TOP-level elements, so the
streaming path doesn't find `data` and falls back to legacy
whole-file parse, which hits the 200 MB safety cap.

### ds002578 (inline EEGLAB, 695 MB)

Wrapped EEG struct. `MAT element overruns container at 5586248:
claims 714866736B, only 11190960B left` — the EEG struct element's
declared payload size (714 MB) exceeds our 16 MB head probe. Falls
back to legacy whole-file parse → 200 MB cap → user-readable error.

**Recommended path forward (out of plan A scope):**
Extend `scanElements` to optionally descend into mxSTRUCT (mxClass=2)
matrix payloads when the top-level name is `EEG`. Walk the struct's
named fields, find `data` / `srate` / `nbchan` / `pnts` / `trials`
as field-named miMATRIX sub-elements, return them as if they were
top-level.

This is a non-trivial extension — the field-name table format and
the per-field offset accounting need careful big-int math. Filing
a separate plan.

### ds002718 (inline EEGLAB, 224 MB)

Same root cause as ds002578 (struct-wrapped). 224 MB exceeds the
200 MB legacy fallback cap by a narrow margin. Could be unblocked
by either:
- Raising the cap to 256 MB (fast fix, doesn't help ds002578)
- The struct-walker extension above (fixes both)

**Per-dataset verdicts (from results.jsonl):**
```
ds003682 (FIFF, 644 MB):  FAIL — no tag directory (file-format issue)
ds003694 (FIFF, 2 GB):     FAIL — open_ms 7-8 s > 5 s budget (CDN latency)
ds002578 (set,  695 MB):   FAIL — struct-wrapped EEG (scanner extension needed)
ds002718 (set,  224 MB):   FAIL — struct-wrapped EEG + 200 MB cap
```

Three of the four blockers are structural (file-format / out-of-
plan-scope). The fourth (ds003694 wall-clock) is bounded by CDN
RTT × number of sequential roundtrips; a 10 s budget would PASS.
