# Performance runbook

Runbook for a deep performance pass on the eegdash-viewer using
chrome-devtools-mcp (https://github.com/ChromeDevTools/chrome-devtools-mcp)
and the in-app `?perf=1` benchmark mode (`perf.js`).

## Prerequisites

- chrome-devtools-mcp configured: `claude mcp add chrome-devtools-mcp -- npx -y chrome-devtools-mcp@latest`
- Local viewer running: `node scripts/serve.mjs 8011`
- New Claude Code session (MCP tools load at session start)

## Phase budgets

These derive from the spec's "real-time canvas EEG viewer" target:
60 fps paint = 16.7 ms/frame, sub-100 ms warm round-trip = imperceptible.
Encoded as machine-checkable gates inside `perf.js`.

| Phase                   | p95 budget | Why |
| ----------------------- | ---------- | --- |
| `cold_pan_rtt_ms`       | 800 ms     | S3 TCP + range header overhead dominates |
| `warm_pan_rtt_ms`       | 100 ms     | Imperceptible to user |
| `filter_apply_rtt_ms`   | 200 ms     | Filter design + applyChain + cache reset + worker round-trip |
| `pure_draw_ms`          | 8 ms       | Leaves headroom under 16.7 ms / 60 fps |
| `heap_growth_mb` (max)  | 5 MB       | After full benchmark, GC-stable |

The benchmark report includes a `gates` field that says PASS/FAIL per
phase. Treat any FAIL as a regression to investigate.

## Step-by-step

The chrome-devtools-mcp tools are listed first, then the action.

### 1. Spin up

```
new_page                 url: http://localhost:8011/index.html?dataset=ds002893&sub=001&task=AuditoryVisualShift&run=01&ext=set&perf=1
wait_for                 selector: #perf-overlay   timeout: 90_000
```

The overlay appears once `__perfReport` is assigned. While we wait, the
benchmark is doing 10 cold pans + 10 warm pans + 3 filter toggles + 100
direct draws (~75 s).

### 2. Capture a CPU trace alongside the benchmark

Run this BEFORE the benchmark completes:

```
performance_start_trace   reload: true   autoStop: false
# benchmark auto-runs after page reload
wait_for                  selector: #perf-overlay   timeout: 90_000
performance_stop_trace
performance_analyze_insight   insightName: "DocumentLatency"
performance_analyze_insight   insightName: "RenderBlocking"
performance_analyze_insight   insightName: "LongTaskBreakdown"
```

The trace covers the full benchmark window. Compare each insight's
findings against the in-app `__perfReport` for cross-validation.

### 3. Read the structured report

```
evaluate_script   function: () => window.__perfReport
```

Returns the JSON dump. Compare to budgets in the `gates` field.

### 4. Memory snapshots

```
take_memory_snapshot   filePath: tests/evidence/perf/heap-baseline.heapsnapshot
# Now click the overlay's [run again] button (or trigger another benchmark cycle)
take_memory_snapshot   filePath: tests/evidence/perf/heap-after.heapsnapshot
get_memory_snapshot_details   filePath: tests/evidence/perf/heap-after.heapsnapshot
get_nodes_by_class         className: Float32Array
```

Look at `get_nodes_by_class Float32Array` — count + total bytes. If
the count grows monotonically across snapshots without bound, the
`readCache` LRU is broken (should be capped at READ_CACHE_MAX = 8).

### 5. Network waterfall

```
list_network_requests     resourceTypes: ["xhr", "fetch"]
# For the 5 slowest, drill down:
get_network_request       url: <slowest url>
```

Look for: HTTP/2 multiplexing on the parallel range fetches
(`HttpRange.rangeFetch` tiles ≥4 MiB into 8 sub-fetches), `Range:`
header presence, response time concentration in TTFB vs body.

## Anti-pattern checks (manual — wire to perf.js as follow-ups)

These are the candidates from the perf-skill review; verify each
against the trace.

1. **Layout thrash in cursor readout** — search the CPU trace for
   forced reflows during `pointermove`. The `getBoundingClientRect()`
   call in `viewer.js`'s `updateCursor` should be cached.
2. **`meanStd` cache miss** — Float32Array references are fresh per
   FETCH_WINDOW (zero-copy transfer requires owned buffers), so the
   `_statsCache = new WeakMap()` keyed on the array reference never
   hits across pans. Trace bottom-up should show `meanStd` consuming
   a fraction proportional to N samples × N channels per pan.
3. **`prefetchNeighbours` saturating worker queue** — after the
   directional-prefetch fix (3 windows ahead in pan dir + 2 ±half),
   trace should show queue length capped. If foreground FETCH_WINDOWs
   sit behind prefetches, that's the regression.
4. **`channel_colors` rebuilt per draw** — `metaChannels.map(...)` runs
   every render. Negligible at 36 channels but at 256 channels = 256
   string lookups per frame. Consider memoising on
   `typeColors`-change.
5. **`transferList` not actually zero-copy** — the F07 worker passes
   `owned.map(a => a.buffer)` as the second `postMessage` arg. Verify
   in the trace that the WINDOW message size on receive is small
   (just metadata) — large bytes mean the transfer didn't take and
   we're paying a clone.

## Reporting back

For each FAIL gate or anti-pattern hit:

1. Open a focused diff (which file/line)
2. Quote the relevant trace sample (function name, % of frame time, call count)
3. Propose the change as a small commit
4. Re-run the benchmark; the gates flip to PASS

The benchmark output is structured JSON so this can be a one-shot CI job
(GitHub Action: load `?perf=1`, scrape `__perfReport`, fail the build
if any `gates.*` is `{fail: [...]}`).
