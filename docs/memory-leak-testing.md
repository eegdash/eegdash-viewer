# Memory Leak Testing Methodology

## Why this is hard

V8's garbage collector is asynchronous and lazy. A single `global.gc()` /
`window.gc()` call does NOT guarantee all dead objects are reclaimed.
Naïve memory-leak tests that diff `process.memoryUsage().heapUsed`
before-and-after a workload report enormous false positives (10+ MB of
"leak" that's actually deferred GC work).

The robust pattern, from
[Joyee Cheung's Node.js memory leak testing post (2024)](https://joyeecheung.github.io/blog/2024/03/17/memory-leak-testing-v8-node-js-1/),
is the **tryGC loop**: call GC repeatedly with a `setImmediate`-yielded
event-loop tick between each call until heap stabilises. We use up to
30 retries with a 50 KB drift floor.

## Where we apply it

### Node-side: integration-rapid-pan.test.mjs `memory:` test

Runs 1000 abort cascades on the stub worker. Asserts heap growth < 5 MB
post-tryGC. Requires `--expose-gc`; skipped otherwise. CI runs it via
`npm run test:integration:gc`.

### Browser-side: rapid-scroll.spec.mjs RAPID-5

200 keyboard pans against the live OpenNeuro fixture. Asserts heap
growth < 5 MB when `window.gc` is available, < 50 MB otherwise.
playwright.config.mjs sets `--js-flags=--expose-gc` to make gc()
available unconditionally.

## How to interpret a failure

If RAPID-5 or `memory:` fails, the heap.json artifact reports
`startHeap`, `endHeap`, `growthBytes`, and `measurementProtocol`. A
growthMb < 1 with `gcAvailable: true` is a clean run. > 5 MB is a real
retention bug — usually one of:

- AbortController not GC'd because the abort listener wasn't released
- Streaming assembler's Float32Array retained by an unfired Promise
- Canvas getImageData buffer cached unnecessarily
- Worker postMessage cycle holding references

Bisect by running with smaller iteration counts (10, 100, 1000) — the
growth should be roughly linear if it's a real leak.

## How to extend coverage

To gate more workflows: add per-iteration cleanup checks. The pattern is
always the same: `start = tryGC(); doWork(); end = tryGC(); growth = end - start;`.

Don't trust a single measurement — V8 jitter can give ±2 MB swings. Run
3x and take the median if you're investigating a borderline case.
