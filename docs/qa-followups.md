# QA follow-ups

Real bugs and design issues uncovered by the multi-agent QA pass
(see `docs/qa-strategy.md` for the test-pyramid context).

These are **not** broken tests — the test suite passes today. They
are issues the new test coverage exposed in the production code or
in the test infrastructure itself, that are out of scope for the
QA pass and need their own fix PRs.

## Production code

### 1. `worker.js` — `rawCache` is FIFO, not LRU
**Severity**: medium · **Owner**: TBD · **Discovered by**: Agent C

The cache is documented as LRU ("Bounded LRU; size matches the
viewer's cache") but is implemented as pure FIFO. `rawCache.get(key)`
in the `FETCH_WINDOW` path doesn't move the key to the MRU tail —
`Map.prototype.get` does not affect insertion order. Consequently,
a pan pattern that cycles between 5 windows while a 6th was loaded
first will evict one of the recently-touched windows instead of the
oldest.

Fix: in the post-`get` path, `rawCache.delete(key); rawCache.set(key, val)`
to bump the entry to MRU position. Add a regression test asserting
LRU order rather than FIFO. The replica-based LRU test in
`tests/unit-worker-cache.test.mjs` exercises the *intended* semantics
— make the source match.

### 2. `worker.js` — concurrent same-window requests not deduplicated
**Severity**: low · **Owner**: TBD · **Discovered by**: Agent C

If two `FETCH_WINDOW_STREAM` messages arrive for the exact same
`(start_sample, n_samples)` window before the first finishes, both
pay the full streaming download cost and both write to the cache.
The second `rawCachePut` quietly evicts an older entry.

Fix: keep an in-flight `Map<cacheKey, Promise<chunks>>` and have
the second request `.then(...)` the existing promise. Add a test
that fires two identical requests and asserts only one upstream
fetch happens.

### 3. `topo2d.js` — no `destroy()` / unmount path
**Severity**: medium (only affects embedders that re-mount) · **Discovered by**: Agent A

Once `init()` is called, `isReady()` is permanently `true`. There
is no way to tear down listeners, clear electrode state, or detach
from the container — re-mounting Topo2D into a different DOM node
leaks listeners + closure state from the previous instance.
Additionally, `setMontage` mutates the caller's montage objects
in-place via back-references (`el._px`, `el._py`, `el._dot`,
`el._label`), which is surprising if the same montage is shared
across instances.

Fix: add `Topo2D.destroy()` that removes all event listeners,
clears the SVG, and resets `isReady()` to `false`. Don't mutate
caller-provided montage objects — keep a parallel `Map<el, internal>`
for the back-references.

### 4. `bids-recording.js` — redundant `BIDSLoader` guard
**Severity**: trivial (cosmetic) · **Discovered by**: Agent D

The `typeof BIDSLoader !== 'undefined'` guard inside
`assembleRecordingMetadata` is redundant — the `try/catch` block
immediately inside it catches the `TypeError` that would fire on
`undefined.parseElectrodesTSV`. Removing the guard doesn't change
behaviour.

Fix: drop the guard; the inner try/catch already handles it.

### 5. `eeglab.js openInlineSet` — `Float32Array.from` is a perf no-op
**Severity**: trivial (misleading comment) · **Discovered by**: Agent D

The `Float32Array.from(eeg.data)` conversion for double-class data
appears to keep the in-memory buffer type consistent. It actually
doesn't change observable behaviour because `sliceColumnMajor`
writes into a `ChannelBuffers.alloc(...)` Float32Array output
either way (the conversion happens at element assignment). The
upfront conversion does reduce peak memory by avoiding a
simultaneous Float64 + Float32 buffer during the slice loop.

Fix: update the comment to reflect what the conversion actually
buys us (peak-memory reduction, not type-safety for callers).

## Test infrastructure

### 6. Playwright `toBeHidden()` is deceptive on `#traces` canvas
**Severity**: high (silent test green when canvas is visible) · **Discovered by**: Agent F

`#traces` has explicit CSS layout properties that override the HTML
`hidden` attribute. Playwright's `toBeHidden()` is CSS-based, so it
returned "visible" even when `hidden=""` was set. The fix in this
PR uses `evaluate(el => el.hasAttribute('hidden'))` for the canvas.
Audit other `toBeHidden` calls in the e2e suite for the same trap.

### 7. `traces.test.mjs` — `meanStd` cache identity test is fragile
**Severity**: low · **Discovered by**: validator

A test asserts `strictEqual(r1, r2)` (same object reference) for
the `meanStd` `WeakMap` cache. If the cache is ever removed for
memory reasons, the test becomes a false negative without surfacing
why. Either anchor the cache as a public contract (and document
it) or relax the test to value-equality.

### 8. `streaming.spec.mjs` — pixel-stability threshold is unanchored
**Severity**: low · **Discovered by**: validator

The replacement for `waitForTimeout(8000)` polls for canvas pixel
stability with `Math.abs(curr - prev) < 50`. The 50-pixel delta is
a magic number — on a small canvas or sparse EEG, normal frame-to-
frame variation could exceed it, triggering false "unstable" reads.
Use a relative threshold (e.g. <0.5% of total non-bg pixels) or
make it a configurable constant per-test.

### 9. Visual baselines are macOS-only
**Severity**: medium (blocks Linux CI) · **Discovered by**: Agent B

The 6 PNG baselines under `tests/e2e/__snapshots__/` were generated
on macOS Chromium and will diff against Linux Skia/FreeType
rendering. The `tests/e2e/visual-regression.spec.mjs` header
documents the Docker-based regeneration workflow; before enabling
visual regression in GitHub Actions, regenerate the baselines on
Linux via:

```bash
docker run --rm -v $(pwd):/work -w /work \
  mcr.microsoft.com/playwright:v1.59.1-noble \
  npx playwright test tests/e2e/visual-regression.spec.mjs --update-snapshots
```

Commit the resulting `*-linux.png` files alongside the existing
`*-darwin.png` ones.
