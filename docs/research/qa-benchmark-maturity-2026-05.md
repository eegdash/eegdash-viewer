# QA and Performance-Benchmark Maturity for Browser Signal Libraries
*Research date: 2026-05-20 — primary sources verified at that date*

Target audience: mid/senior engineers evaluating a test suite (eegdash-viewer or similar: Canvas 2D rendering, streaming chunk decoding, binary format readers) against the state of the art.

---

## Part A — Modern QA Maturity for JS/TS Libraries

### A1. Property-Based Testing with fast-check

**What it is.** fast-check generates hundreds of random inputs, runs them against an invariant, and — when it finds a failure — shrinks the counterexample to the minimal reproducible case. The shrinking step is the practical differentiator from fuzzing: you get a one-line failing case, not a 4 MB binary blob.

**Who trusts it in production.** According to the fast-check README, the library is "trusted for years" by jest, jasmine, fp-ts, io-ts, ramda, js-yaml, and query-string — and has found real bugs in jest and query-string that example tests missed.  
Source: [dubzzz/fast-check README](https://github.com/dubzzz/fast-check)

**When is it justified vs. example tests?**

Use property-based tests when you can phrase an *invariant* stronger than any particular example:

| Pattern | Example invariant | Applies to eegdash-viewer |
|---|---|---|
| Round-trip | `decode(encode(x)) === x` | EDF/BDF/BrainVision frame packing |
| Commutativity | `filter(a, b) === filter(b, a)` | Bandpass + notch order |
| Idempotence | `normalize(normalize(x)) === normalize(x)` | Sample-rate conversion |
| No-crash | `parse(anyUint8Array)` never throws uncaught | All format readers |
| Monotonicity | larger chunk → same-length or longer decoded signal | Streaming decoder |

Example tests remain better for: known edge cases (empty file, zero channels), regression pins for specific bugs, and anything where the invariant is "output matches this exact reference trace."

**Idiomatic adoption pattern.** Start with a shared `arbitraries.ts` file that exports domain generators once and imports them everywhere:

```ts
// test/arbitraries.ts
import fc from 'fast-check';

export const uint8Chunk = fc.uint8Array({ minLength: 1, maxLength: 65536 });

export const edfHeader = fc.record({
  nChannels:    fc.integer({ min: 1, max: 256 }),
  sampleRate:   fc.oneof(fc.constant(256), fc.constant(512), fc.constant(1024)),
  durationSecs: fc.integer({ min: 1, max: 30 }),
});

export const validTimestamp = fc.float({ min: 0, noNaN: true, noDefaultInfinity: true });
```

Then in tests:

```ts
import fc from 'fast-check';
import { uint8Chunk } from '../arbitraries.js';
import { parseEdf } from '../../src/formats/edf.js';

it('parse never throws on arbitrary bytes', () => {
  fc.assert(fc.property(uint8Chunk, (buf) => {
    try { parseEdf(buf.buffer); } catch (e) { /* expected */ }
    return true; // the property is "does not crash Node"
  }));
});
```

fast-check ships `fc.uint8Array()` and `fc.int16Array()` as first-class composite arbitraries (documented at [fast-check.dev/docs](https://fast-check.dev/)). For more complex structures, `.map()` and `.chain()` let you derive typed records from primitives while preserving shrinking.

The fp-ts-laws library ([gcanti/fp-ts-laws](https://github.com/gcanti/fp-ts-laws)) shows the pattern of passing arbitraries as function parameters so the same law-test can be re-run for any type instance: `laws.semigroup(semigroupSpace, eqString, fc.string())`. This is the idiomatic way to share generators — inject them, don't import a global.

**Integration with node:test.** fast-check works with any runner: `fc.assert(fc.property(...))` is a synchronous or async call that throws on failure, so it composes with `test()` from `node:test` with no adapter needed.

---

### A2. Mutation Testing with Stryker

**What it is.** Stryker modifies your source code (changes `>` to `>=`, removes a branch, negates a boolean) and runs your tests against each mutated version. A mutant is "killed" if at least one test fails. The ratio of killed to total mutants is your *mutation score*.

**Kill-ratio targets.** The Stryker dashboard shows three badge colors:
- Green: ≥ 80 (score: 82.3 on stryker-js itself)
- Orange: 60–79 (score: 72.3)
- Red: < 60 (score: 59.6)

A score above 80% is considered a strong indicator of test-suite quality. The suggested `stryker.config.json` threshold block:

```json
{
  "thresholds": {
    "high": 80,
    "low": 60,
    "break": 50
  }
}
```

`break: 50` exits non-zero in CI, blocking merges below that floor.  
Source: [stryker-mutator.io/blog/get-your-mutation-score-badge-now](https://stryker-mutator.io/blog/get-your-mutation-score-badge-now/)

**Cost management: incremental mode.** Running all mutants on every PR is expensive (minutes to hours for large files). Stryker's `--incremental` flag tracks which files and tests changed, reuses previous results for unchanged code, and only re-runs mutants touching the diff. Results persist in `reports/stryker-incremental.json` (commit this file). Combined with parallelism, PR-level incremental runs take 1–5 minutes for most codebases.  
Source: [stryker-mutator.io/docs/stryker-js/incremental](https://stryker-mutator.io/docs/stryker-js/incremental/)

**Recommended CI pattern:**

```yaml
# .github/workflows/mutation.yml
- name: Mutation test (incremental)
  run: npx stryker run --incremental
  env:
    STRYKER_DASHBOARD_API_KEY: ${{ secrets.STRYKER_KEY }}
```

Commit `reports/stryker-incremental.json` so the cache persists across runs. The Stryker dashboard ([dashboard.stryker-mutator.io](https://dashboard.stryker-mutator.io)) hosts public mutation scores and generates shield.io-compatible badge URLs — free for open-source.

**Where it pays off in eegdash-viewer.** Mutation testing is most valuable for the decision-dense parts of a codebase: the abort-cascade logic, the timestamp normalization, and the channel-range clamp expressions. If `< startSample` is mutated to `<= startSample` and no test fails, your boundary tests are absent.

---

### A3. Visual Regression Testing

**The canvas problem.** DOM-based visual testing compares HTML structure. Canvas renders to a pixel buffer — there is no queryable element tree. The only valid comparison is pixel-level screenshot diffing.

**Playwright's native approach.** `page.toHaveScreenshot()` uses [pixelmatch](https://github.com/mapbox/pixelmatch) under the hood. It stores baselines in `*.spec.ts-snapshots/` directories, suffixed with `{browser}-{os}` (e.g., `render-1-chromium-linux.png`). You must commit these files to git. On update, run `--update-snapshots`.

Options:
```ts
await expect(canvas).toHaveScreenshot('render.png', {
  maxDiffPixels: 50,         // absolute pixel count
  maxDiffPixelRatio: 0.001,  // or as a fraction
  threshold: 0.2,            // per-pixel color distance 0-1
});
```

Source: [playwright.dev/docs/test-snapshots](https://playwright.dev/docs/test-snapshots)

**Handling per-OS rendering differences.** Playwright automatically namespaces baselines by `{browser}-{platform}`. A test run on macOS produces `chromium-darwin` baselines; the same test run on the CI Ubuntu runner produces `chromium-linux` baselines. You need both committed to the repository, or you run all baseline generation inside Docker using the official `mcr.microsoft.com/playwright` image to pin the rendering environment.

The practical recommendation from multiple teams: generate and update baselines only in CI (via a dedicated `update-snapshots` workflow) so the committed baselines always match the environment that will run them.

**Alternatives for scale:**
- [Percy](https://percy.io/) / [Chromatic](https://www.chromatic.com/) — commercial, stores baselines in cloud, handles approval workflows. Chromatic is Storybook-native; Percy is framework-agnostic.
- [reg-suit](https://github.com/reg-viz/reg-suit) + [reg-actions](https://github.com/reg-viz/reg-actions) — open-source, stores diffs as GitHub PR comments, baselines in S3/GCS. Lower cost, more setup.
- BackstopJS — older, heavyweight, not worth new adoption in 2025.

**What canvas-heavy libraries actually do:**
- *Plotly.js* stores raw PNG baselines in [`test/image/baselines/`](https://github.com/plotly/plotly.js/tree/master/test/image). They use `make_baseline.py` / `make_baseline.mjs` to re-generate baselines, and `compare_pixels_test.mjs` for pixel-level comparison — a fully custom pipeline, not Playwright. The comparison is driven by `compare_pixels_collections.json`.
- *Chart.js* runs browser tests in Chrome and Firefox using `xvfb-run` on Linux, uploads coverage to Coveralls, but the visual comparison is done via their `chartjs-test-utils` package rather than a managed visual regression service.
- *Pixi.js* does not currently have an official standardized visual testing strategy ([GitHub discussion #10788](https://github.com/pixijs/pixijs/discussions/10788) confirms this). Canvas automated testing remains an open problem in that ecosystem.
- *D3.js* (d3-shape) tests SVG *path strings* rather than pixel bitmaps: `assertPathEqual(line(data), "M0,1L2,3")`. This is the simplest possible visual test — compare the serialized path output, not a rendered image. Deterministic, fast, zero flakiness. It works because D3 generates SVG, not pixels.

**The D3 lesson for eegdash-viewer:** where you can express the output as a string or numeric array (e.g., "rendered pixel column at x=100 is [r0, r1, r2, ...]"), do that instead of a screenshot. Reserve screenshots for the final integration test that captures the full viewport.

---

### A4. Fuzz Testing for JS

**Coverage-guided fuzzing vs. property-based testing.** Property tests check specified invariants; fuzz tests look for *crashes and panics* by exploring input space guided by coverage feedback. They are complementary: PBT finds logic bugs in code you've thought about; fuzzing finds crashes in code paths you haven't.

**Jazzer.js** is the leading option. It wraps libFuzzer, instruments Node.js code for coverage, and drives mutations toward unexplored branches. In 2023, Code Intelligence partnered with Google to add JavaScript support to OSS-Fuzz.

Setup:
```bash
npm install --save-dev @jazzer.js/core
```

Jest integration:
```ts
// fuzz/edf-parser.fuzz.ts
import { parseEdf } from '../src/formats/edf.js';

it.fuzz('parseEdf does not crash on arbitrary input', (data: Buffer) => {
  try { parseEdf(data.buffer); } catch (_) {}
});
```

Run locally for 60 seconds with `npx jazzer fuzz/edf-parser.fuzz.ts`, or integrate into CI as an overnight job seeded from a corpus of real EDF files.

Source: [CodeIntelligenceTesting/jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js/)

**Where fuzzing pays off in eegdash-viewer specifically:**
- EDF/BDF header parser — malformed `num_data_records` field
- BrainVision `.vhdr` text parser — encoding edge cases
- EEGLAB `.set` reader — nested structure parsing
- The byte-range `DataView` slicing in the streaming decoder — bounds-check invariants

The argument for fuzzing format readers rather than the renderer: inputs to format readers come from untrusted files and network responses. The attack surface is real. Property-based `no-crash` tests catch the same class of bugs for lower setup cost, but a fuzzer with coverage guidance will explore deeper code paths.

**jsfuzz** ([fuzzitdev/jsfuzz](https://github.com/fuzzitdev/jsfuzz)) is an alternative with a simpler API and no libFuzzer dependency, but lower coverage guidance sophistication. For new projects, prefer Jazzer.js.

---

### A5. Coverage Standards

**Tools.** The modern options in JS/TS:
- `c8` — uses V8's native coverage API. Fast, no instrumentation step. Source: [bcoe/c8](https://github.com/bcoe/c8)
- `istanbul` / `nyc` — instruments source code. Better branch tracking historically.
- Vitest's built-in coverage — since v3.2.0, Vitest uses AST-based remapping for V8 coverage, producing "identical reports to Istanbul while offering the speed of V8." Both `v8` and `istanbul` providers are supported.

Source: [vitest.dev/guide/coverage](https://vitest.dev/guide/coverage)

**Coverage types, ranked by signal quality:**
1. *Line* — weakest. A line covered once counts the same as a line covered by 100 tests.
2. *Branch* — better. Catches `if (a || b)` where only the `a=true` path was tested.
3. *Function* — simple but useful for dead-code detection.
4. *Statement* — similar to line for most code.
5. *MC/DC (Modified Condition/Decision Coverage)* — required in aviation (DO-178C). Not natively supported by c8 or istanbul; requires specialist tools (e.g., [cppcoverage](https://github.com/nicowillis/cppcoverage) or manual assertion patterns). Not worth pursuing for a browser viewer.

**Real-world thresholds.** These numbers are from the Vitest documentation examples and mainstream CI configs. The industry has not converged on a single number; libraries differ by risk profile:

| Library | Approach | Reported coverage |
|---|---|---|
| React | Istanbul + CI gate | ~90%+ lines reported on codecov |
| Chart.js | Coveralls, per-browser | ~85-90% |
| MNE-Python | codecov, multi-platform | High (~90%) via comprehensive pytest suite |
| Vitest docs example | v8 thresholds config | `lines: 80, branches: 75, functions: 80` |

A practical starting gate: `lines: 80, branches: 70`. The branches threshold is harder to reach for rendering code full of guard clauses.

Vitest threshold config:

```ts
// vitest.config.ts
coverage: {
  provider: 'v8',
  thresholds: {
    lines:     80,
    branches:  70,
    functions: 85,
    statements: 80,
  },
  exclude: ['**/*.test.ts', '**/fixtures/**'],
}
```

---

### A6. Contract Testing

**Applicability.** Contract testing (Pact, schema-based) is designed for *service boundaries* — consumer/provider pairs where both sides evolve independently. For a library that ships as a module (no network boundary), the equivalent is *API surface testing*: verifying that your TypeScript types, function signatures, and exported constants don't silently break across releases.

The JS ecosystem handles this with:
- **TypeScript `--strict` compilation** on the public API typings — catches breaking changes at the type level.
- **`attw` / `are-the-types-wrong`** ([arethetypeswrong.github.io](https://arethetypeswrong.github.io)) — checks that the published package's exports map, `.d.ts` files, and module conditions are consistent across toolchains (CJS, ESM, bundlers).
- **`publint`** — lints `package.json` exports fields for correctness.
- **API extractor** (from rushstack) — generates API surface snapshots and diffs them on PR, blocking undocumented breaking changes.

For network-boundary consumer-driven contracts, Pact.js ([pact-foundation/pact-js](https://github.com/pact-foundation/pact-js)) is the reference implementation. Apollo and tRPC do not use Pact; they rely on TypeScript end-to-end type safety (tRPC) or schema introspection testing (Apollo) to verify their public APIs. Source: [docs.pact.io](https://docs.pact.io/)

**For eegdash-viewer:** the most practical contract test is a snapshot of the public module's exported names and types (via API extractor or a simple `tsd` test), combined with `are-the-types-wrong` in CI.

---

### A7. Snapshot Testing

**When snapshots are an asset.** Snapshots work well when:
- The output format is stable and text-representable (JSON, SVG paths, serialized AST).
- The output is too large to hand-write but you need regression detection.
- The primary author is making changes and wants to review diffs before approving them.

**When snapshots become noise.** From the 2025 community consensus:
- Large component snapshots (500+ lines of HTML) fail on every cosmetic change and developers start auto-updating without reviewing.
- Dynamic content (timestamps, random IDs) makes every run fail unless masked.
- Testing implementation details (internal class names, attribute order) couples tests to internals rather than behavior.

The TigerBeetle team's "Snapshot Testing for the Masses" (2024) argues for what they call *characterization tests*: take a snapshot of complex algorithmic output, then treat snapshot updates as an explicit code-review step rather than a nuisance. This works well for things like "serialized binary record layout for format X." Source: [tigerbeetle.com/blog/2024-05-14](https://tigerbeetle.com/blog/2024-05-14-snapshot-testing-for-the-masses/)

**2025 consensus:** Use snapshots for *serialized data structures and API shapes*, not for UI trees or rendered output. Prefer inline snapshots (`.toMatchInlineSnapshot(...)`) for short outputs so the expected value is readable in-line. For canvas outputs, a screenshot is the only option — but treat that separately as visual regression, not snapshot testing.

---

## Part B — Performance Benchmark Maturity

### B1. Statistical Microbenchmarking

**The problem with means alone.** A benchmark that reports `mean: 1.2ms` tells you nothing about whether that number is reproducible. A 30% standard deviation means the "result" is noise. The Rust community solved this with criterion.rs, which uses bootstrapped confidence intervals and reports slope (throughput), not just mean.

**JS tools in 2025/2026:**

*tinybench* ([tinylibs/tinybench](https://github.com/tinylibs/tinybench)) — 10KB, zero dependencies. Reports mean, median, standard deviation, relative margin of error (RME), and ops/sec. Output format: `63768 ± 4.02%` (mean ± RME). No p-values or effect size. Vitest uses tinybench as its bench() implementation.

*mitata* — used by Deno's `Deno.bench()`. Better precision for sub-microsecond measurements. Reports similar stats.

*Benchmark.js* — older, more statistical (reports `ops/sec ±2.34% (97 runs sampled)`), still maintained, but heavier. The `±%` is a 95% confidence interval expressed as relative error.

**What "report with confidence intervals" looks like in practice:**

```ts
// vitest bench
import { bench } from 'vitest';
import { decodeEdfChunk } from '../src/decoder.js';

const chunk = new Uint8Array(4096).fill(0); // representative fixture

bench('decodeEdfChunk 4KB', () => {
  decodeEdfChunk(chunk.buffer, { channels: 16, sampleRate: 256 });
}, { iterations: 1000, warmupIterations: 100 });
```

Vitest bench outputs: mean, min, max, p75, p99, RME. To get criterion.rs-level statistics (bootstrapped CIs, effect size between runs), you need a CI platform like Bencher that compares across runs statistically (Student's t-test).

**The honest gap:** JavaScript lacks a direct criterion.rs equivalent that runs entirely locally. The closest is Bencher (cloud) or writing your own bootstrap sampler using tinybench's raw sample arrays.

---

### B2. Continuous Benchmarking Platforms

**CodSpeed** ([codspeed.io](https://codspeed.io)): Uses a Callgrind/Valgrind-based CPU simulation instrument — benchmarks run as instruction counts, not wall time. This eliminates cloud-runner noise entirely. Variance: **0.56% coefficient of variation** vs. 2.66% on standard GitHub-hosted runners. With a 1.5% regression gate, false positive rate is 0.04% (1 in 2500 runs).

For wall-time scenarios (I/O-heavy benchmarks), CodSpeed added a "Walltime" instrument in November 2024 running on bare-metal AWS Graviton runners.

Vitest integration:
```bash
npm install --save-dev @codspeed/vitest-plugin
```

```ts
// vitest.config.ts
import { codspeedPlugin } from '@codspeed/vitest-plugin';
export default { plugins: [codspeedPlugin()] };
```

```yaml
# .github/workflows/benchmarks.yml
- uses: CodSpeedHQ/action@v3
  with:
    run: pnpm vitest bench
    token: ${{ secrets.CODSPEED_TOKEN }}
```

Source: [codspeed.io/blog/vitest-bench-performance-regressions](https://codspeed.io/blog/vitest-bench-performance-regressions)

**Bencher** ([bencher.dev](https://bencher.dev)): Uses Student's t-test (configurable α). Stores benchmark history, detects regressions relative to base branch. Posts results as GitHub Checks. The `--error-on-alert` flag exits non-zero when a regression is detected.

```yaml
- uses: bencherdev/bencher@main
- name: Track PR Benchmarks
  run: |
    bencher run \
      --project my-project \
      --branch "$GITHUB_HEAD_REF" \
      --start-point "$GITHUB_BASE_REF" \
      --start-point-clone-thresholds \
      --threshold-test t_test \
      --threshold-upper-boundary 0.99 \
      --error-on-alert \
      --github-actions '${{ secrets.GITHUB_TOKEN }}'
```

Source: [bencher.dev/docs/how-to/github-actions](https://bencher.dev/docs/how-to/github-actions/)

**github-action-benchmark** — open-source, simpler, no CI service required. Stores benchmark results as JSON in a `gh-pages` branch and posts alert comments. Tolerates only percentage-based thresholds, no statistical testing.

**Noise floor guidance.** Standard GitHub-hosted runners have ~2–3% CoV. Useful regression gates on those runners: 5–10% (fine for catching big regressions). For catching 2% regressions reliably, you need CodSpeed's CPU simulation or bare-metal runners.

---

### B3. Memory Leak Detection

**The maturity ladder:**

*Level 0 — Manual.* Open Chrome DevTools, take three heap snapshots (baseline, after load, after 10 cycles), compare retained object counts. Finds gross leaks, time-consuming, not reproducible.

*Level 1 — `--expose-gc` + assertion.* Node.js flag exposes `global.gc()`. Pattern from Node.js core itself (Joyee Cheung, 2024):

```js
// Run with: node --expose-gc test.mjs
async function gcAndCheck(fn, maxBytes) {
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setImmediate(r));
    gc();
  }
  const baseline = process.memoryUsage().heapUsed;
  await fn();
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setImmediate(r));
    gc();
  }
  const after = process.memoryUsage().heapUsed;
  assert(after - baseline < maxBytes, `heap grew by ${after - baseline} bytes`);
}
```

The key insight from Joyee's post: GC is asynchronous; use `setImmediate` loops to let finalizers run before measuring. Adding delays "makes the test run slightly slower, but it is still acceptable and the updated test has been stable enough in CI."  
Source: [joyeecheung.github.io/blog/2024/03/17](https://joyeecheung.github.io/blog/2024/03/17/memory-leak-testing-v8-node-js-1/)

*Level 2 — Heap-pressure test.* Set a small heap limit (`--max-old-space-size=64`) and run 1000 iterations of the suspected leaky operation. If the process crashes OOM, a leak exists. Fast, CI-friendly, no flakiness from GC timing.

*Level 3 — Playwright `performance.memory`.* In browser tests: `page.evaluate(() => performance.memory.usedJSHeapSize)` before and after a workflow. Coarse (reports committed heap, not retained objects) but catches large leaks in the actual browser environment where canvas and AudioContext live.

*Level 4 — Automated heap-snapshot diff in CI.* Use Chrome DevTools Protocol (CDP) to take heap snapshots programmatically via Playwright's `client.send('HeapProfiler.takeHeapSnapshot')`. Diff the `retainedSize` of suspect classes between baseline and post-operation. This is what professional memory profilers do; it requires significant setup and is fragile across Chrome versions. Only worth it if you have a confirmed memory leak you're trying to gate.

**For eegdash-viewer:** Level 1 (expose-gc + assertion on Worker heap) combined with Level 3 (Playwright `performance.memory` on a 5-minute panning scenario) covers the most likely leak vectors (off-screen canvas accumulation, unreleased AbortController, streaming worker buffers).

---

### B4. Flame Graphs and CPU Profiling

**The state of automation.** Flame-graph diffs are not yet automated in mainstream JS library CI. They are used as *manual performance review artifacts*:

- `npx 0x app.js` — wraps `--prof`, generates an interactive SVG flame graph.
- `node --inspect --prof` + `node --prof-process` — raw V8 profiling.
- Platformatic's `@platformatic/flame` — generates a self-contained HTML flame graph; designed to be attached to GitHub PR comments.

The recommended practice from several performance-focused teams (2024): before merging a change suspected to affect hot paths, record a 60-second `0x` profile, save the HTML artifact, link it in the PR description. Not automated blocking — manual review.

CodSpeed's CPU simulation instrument generates flame graphs automatically and embeds them in PR comments as a side effect of benchmark runs, making this the closest thing to automated flame-graph diffs available in 2025.

**For eegdash-viewer:** the Canvas `drawImage` + typed array memcpy in the render loop is the obvious profiling target. A `0x` profile of a 60-second panning session will immediately show whether pixel manipulation, DataView access, or the Worker message overhead dominates.

---

### B5. Real User Monitoring (RUM)

**Applicability for library authors.** RUM instruments the browser on real-user devices and reports Core Web Vitals (LCP, INP, CLS) back to a collector. For a library author, RUM is useful if and only if you ship something directly to production (a SAAS product, a CDN-hosted script). For a component library or viewer SDK consumed by other applications, the end-user application's RUM setup is what matters.

If eegdash-viewer becomes a deployed application (not just a library), the adoption path:

1. Cloudflare Web Analytics — zero-config, privacy-preserving, reports Core Web Vitals.
2. Sentry Performance — captures INP/LCP per route with trace context.
3. Custom `PerformanceObserver` on `largest-contentful-paint` / `event` entries in the viewer's main thread.

For a canvas-heavy viewer, INP (Interaction to Next Paint) from the new Chromium event timing API is the most actionable metric: it captures pointer-down → first canvas frame latency.

---

## Part C — Exemplars

### C1. MNE-Python — Gold Standard for EEG/MEG Software

MNE-Python is the most mature open-source EEG/MEG analysis library and sets the benchmark for signal-processing correctness testing.

**Test data repository.** MNE maintains a separate repository ([mne-tools/mne-testing-data](https://github.com/mne-tools/mne-testing-data)) with hundreds of small reference recordings in every supported format: EDF, BrainVision, CTF, KIT, BTi, EEGLAB, NIRx, SNIRF. The guiding principle: files should be "as small as possible while ensuring proper testing" — typically 1–5 second recordings with 8–32 channels. These are committed to git and downloaded on demand in CI.

**Numerical correctness pattern.** Tests use `numpy.testing.assert_allclose` with domain-calibrated tolerances:

```python
# From test_interpolation.py
assert_allclose(data[:n_channels], raw2._data[:n_channels], rtol=1e-10, atol=1e-15)
# After spline interpolation:
assert_allclose(interp_data, ref_data, atol=3e-6)  # µV scale tolerance
# For EEG vs MEG:
atol = 1e-12 if 'eeg' in picks else 1e-20
```

The choice of tolerance is *documented as a deliberate decision* (EEG is on the µV scale; MEG magnetometers on the fT scale). This is the gold standard: not `1e-6` everywhere but per-modality reasoning.

**Additional patterns:**
- Correlation coefficients as weaker tests: `np.corrcoef(interpolated, original)` with threshold 0.68–0.85 for methods with inherent smoothing.
- Before/after guards: verify that non-target channels remain exactly unchanged after a channel operation.
- `@pytest.mark.slowtest` and `@pytest.mark.pgtest` markers to separate fast unit tests from expensive integration tests.

**CI:** 4 OS × 4 Python version matrix, plus conda and pip-pre builds. Security scanning via Bandit. Type checking via mypy. Dead-code via vulture. Source: [mne-python/.github/workflows/tests.yml](https://github.com/mne-tools/mne-python/blob/main/.github/workflows/tests.yml)

**Takeaway for eegdash-viewer:** maintain a `test/fixtures/` directory of real EDF/BDF/BrainVision files (each < 100KB), and use `assert_allclose`-equivalent patterns (e.g., `expect(decoded).toBeCloseTo(expected, 5)` per sample) rather than exact equality.

---

### C2. Plotly.js — Large Browser Visualization Library

**Visual regression approach.** Plotly.js does not use Playwright or Percy. They maintain a fully custom pixel comparison pipeline:
- `test/image/baselines/` — PNG reference images committed to the repository
- `test/image/make_baseline.mjs` — Node.js script to regenerate baselines (also Python version)
- `test/image/compare_pixels_test.mjs` — pixel-level comparison driven by `compare_pixels_collections.json`

This predates modern Playwright visual testing and reflects a browser-server architecture (their tests render via a headless server). For new projects, Playwright's `toHaveScreenshot` is simpler and more maintainable.

**Unit testing:** Jasmine, run in-browser. Test files are in `test/jasmine/`.

Source: [github.com/plotly/plotly.js/tree/master/test/image](https://github.com/plotly/plotly.js/tree/master/test/image)

---

### C3. Pixi.js — 2D Rendering Library

**Current state:** Pixi.js does not have an established standardized visual testing strategy. A 2024 GitHub discussion ([#10788](https://github.com/pixijs/pixijs/discussions/10788)) confirms there is no official guidance. Maintainers directed questions to Discord.

**Parallel work:** A research group built [canvas-visual-bugs-testbed](https://github.com/asgaardlab/canvas-visual-bugs-testbed) — a Playwright-based framework for Pixi.js that captures screenshots paired with scene graphs. This is academic/community work, not official Pixi.js tooling.

**Takeaway:** For canvas rendering, Playwright `toHaveScreenshot` with a tight fixture (known test scene, deterministic state) is currently the most practical approach — even if Pixi.js itself hasn't standardized on it.

---

### C4. D3.js — Math-Heavy Visualization Library

**Testing approach:** D3 uses Node's built-in `assert` module with custom assertion helpers. No Jest, no Mocha, no Vitest — just `node --test` (d3 packages moved to native node:test in 2022–2023).

For `d3-shape`, the [test/line-test.js](https://github.com/d3/d3-shape/blob/main/test/line-test.js) file tests path generation by comparing serialized SVG path strings:

```js
import assert from 'assert';
import { assertPathEqual } from './asserts.js';

assertPathEqual(line(data), "M0,1L2,3L4,5");
assert.strictEqual(line.x()(d), d.x);
assert.deepStrictEqual(line.defined.call(...), [true, false]);
```

This avoids all visual regression tooling complexity: the output is a deterministic string, tested with string equality (with floating-point-aware path comparison in `asserts.js`).

**For d3-hierarchy** ([test/](https://github.com/d3/d3-hierarchy/tree/main/test)): layout algorithm correctness is tested by comparing computed `x`, `y`, `width`, `height` properties of tree nodes against known reference values.

**Takeaway:** if any part of eegdash-viewer has a computable, deterministic text/numeric output (e.g., the tick label generation, the viewport-to-sample mapping, the channel grid layout), test it with numeric equality, not screenshots.

---

### C5. Chart.js — Popular Chart Library

**CI structure:** The [Chart.js CI workflow](https://github.com/chartjs/Chart.js/blob/master/.github/workflows/ci.yml) runs:
1. Lint (`pnpm run lint`)
2. Build (`pnpm run build`)
3. Browser tests on Chrome (Linux with xvfb-run) and Safari (macOS)
4. Coverage uploaded to Coveralls for both Chrome and Firefox runs
5. Documentation generation on doc-file changes

Tests live in `test/specs/` (unit), `test/integration/` (integration), and `test/fixtures/` (data). Their `chartjs-test-utils` npm package provides Canvas mocking utilities for JSDOM-based unit tests.

**Key insight:** Chart.js separates "does the math compute correctly" (JSDOM + canvas mock, fast) from "does it render correctly" (real browser, slower). The visual verification is done via browser-based tests, not screenshot comparison services.

---

### C6. fast-check — Meta-Example

The fast-check project itself ([dubzzz/fast-check](https://github.com/dubzzz/fast-check)) uses fast-check to test its own property machinery — a meta-test that verifies shrinking correctness and arbitrary combinators. This confirms the library is production-stable.

Shared generator pattern from fp-ts-laws (built on fast-check):
```ts
// Pass arbitraries as parameters to law functions
laws.semigroup(semigroupSpace, eqString, fc.string())
laws.functor(arrayFunctor, eqArray(eqNumber), fc.array(fc.integer()))
```

This injection pattern means the same law test runs against any type instance without duplicating the test body.

---

### C7. Stryker — Meta-Example

Stryker-js publishes its own mutation score badge ([mutation score: 82.3, green](https://stryker-mutator.io/blog/get-your-mutation-score-badge-now/)) — dogfooding the tool on itself. The project is organized as a pnpm monorepo on TypeScript (85%), with CI via GitHub Actions.

Source: [stryker-mutator/stryker-js](https://github.com/stryker-mutator/stryker-js)

---

## Part D — Maturity Ladder

### The Ladder

| Level | QA Approach | Benchmark Approach | Effort to Adopt |
|---|---|---|---|
| 0 | None | None | — |
| 1 | Unit tests only (node:test / Vitest) | Ad-hoc `console.time()` | Low |
| 2 | + Integration tests with worker stubs | + tinybench microbenchmarks (single mean) | Low |
| 3 | + E2E (Playwright) + visual regression (toHaveScreenshot) | + Statistical reporting (mean ± RME, p75, p99) | Medium |
| 4 | + Property-based tests (fast-check) + coverage gate (c8/v8, ≥ 80%) | + Continuous benchmarking in CI (Bencher or github-action-benchmark) | Medium |
| 5 | + Mutation testing (Stryker, incremental, ≥ 80% kill ratio) | + Memory-leak gate (--expose-gc + assertion per PR) | Medium-high |
| 6 | + Fuzz testing on format parsers (Jazzer.js) | + Noise-free CI benchmarks (CodSpeed instrumented) | High |
| 7 | + API contract/surface testing (API extractor, are-the-types-wrong) | + Flame-graph artifacts on hot-path PRs (0x or CodSpeed) | High |

*eegdash-viewer current position: solid Level 3 (Playwright E2E + screenshot evidence + worker-stub integration). One ghost-pixel bench puts a toe in Level 4 benchmarks.*

---

### Prescriptive Transitions: Smallest Next Step per Level

**Level 3 → 4 (property-based + coverage gate)**

Smallest step — one sprint:
1. `npm install --save-dev fast-check` and add one property test against the EDF reader: `fc.assert(fc.property(fc.uint8Array({minLength: 512}), buf => { parseEdf(buf.buffer); return true; }))`. This catches any crash on malformed input.
2. Add `coverage: { provider: 'v8', thresholds: { lines: 80, branches: 70 } }` to `vitest.config.ts`. Run `vitest --coverage` and see the current score. Set the threshold at current − 5% to start, then tighten quarterly.

**Level 4 → 5 (mutation testing + memory leak gate)**

Smallest step — one sprint:
1. Run `npx stryker run` once on the `src/formats/` directory only (not the whole codebase) to get a baseline score and a sense of cost. Add `--incremental` to the CI step and commit `reports/stryker-incremental.json`.
2. Add a single memory assertion to the Playwright suite: `const before = await page.evaluate(() => performance.memory.usedJSHeapSize); await doPanningWorkflow(); const after = ...; expect(after - before).toBeLessThan(10 * 1024 * 1024)`. This is not rigorous but catches 10 MB+ leaks reliably.

**Level 5 → 6 (fuzzing + noise-free CI benchmarks)**

Smallest step — one sprint:
1. Install Jazzer.js and write one fuzz target for `parseEdf`. Run it locally for 10 minutes with a corpus of 3 real EDF files (`--corpus=test/fixtures/edf/`). If it finds a crash, you get a minimal reproducing buffer. Add the target to CI as a nightly job.
2. Sign up for CodSpeed (free tier), add `@codspeed/vitest-plugin` to `vitest.config.ts`, and add the `CodSpeedHQ/action@v3` step to the benchmark workflow. The first run establishes a baseline; subsequent PRs get automatic regression comments.

**Level 6 → 7 (API contract + flame-graph artifacts)**

Smallest step — one sprint:
1. Add `publint` and `are-the-types-wrong` as CI checks on the published package output. These run in seconds and catch the most common publishing mistakes.
2. Establish a norm: any PR that modifies `src/render/` or `src/decoder/` must include a `0x` flame-graph HTML file attached to the PR description. Not automated; enforced by PR template checklist.

---

## Primary Sources

- [dubzzz/fast-check](https://github.com/dubzzz/fast-check)
- [dubzzz/fast-check-examples](https://github.com/dubzzz/fast-check-examples)
- [fast-check.dev](https://fast-check.dev/)
- [gcanti/fp-ts-laws](https://github.com/gcanti/fp-ts-laws)
- [stryker-mutator/stryker-js](https://github.com/stryker-mutator/stryker-js)
- [stryker-mutator.io/docs/stryker-js/incremental](https://stryker-mutator.io/docs/stryker-js/incremental/)
- [stryker-mutator.io/blog/get-your-mutation-score-badge-now](https://stryker-mutator.io/blog/get-your-mutation-score-badge-now/)
- [playwright.dev/docs/test-snapshots](https://playwright.dev/docs/test-snapshots)
- [CodeIntelligenceTesting/jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js/)
- [google/oss-fuzz — jazzer.js issue #8324](https://github.com/google/oss-fuzz/issues/8324)
- [tinylibs/tinybench](https://github.com/tinylibs/tinybench)
- [vitest.dev/guide/coverage](https://vitest.dev/guide/coverage)
- [bcoe/c8](https://github.com/bcoe/c8)
- [pact-foundation/pact-js](https://github.com/pact-foundation/pact-js)
- [codspeed.io/blog/vitest-bench-performance-regressions](https://codspeed.io/blog/vitest-bench-performance-regressions)
- [codspeed.io/blog/benchmarks-in-ci-without-noise](https://codspeed.io/blog/benchmarks-in-ci-without-noise)
- [bencher.dev/docs/how-to/github-actions](https://bencher.dev/docs/how-to/github-actions/)
- [joyeecheung.github.io/blog/2024/03/17 — memory leak testing](https://joyeecheung.github.io/blog/2024/03/17/memory-leak-testing-v8-node-js-1/)
- [mne-tools/mne-testing-data](https://github.com/mne-tools/mne-testing-data)
- [mne-tools/mne-python test_interpolation.py](https://github.com/mne-tools/mne-python/blob/main/mne/channels/tests/test_interpolation.py)
- [mne-tools/mne-python test_ica.py](https://github.com/mne-tools/mne-python/blob/main/mne/preprocessing/tests/test_ica.py)
- [mne-tools/mne-python CI workflow](https://github.com/mne-tools/mne-python/blob/main/.github/workflows/tests.yml)
- [plotly/plotly.js test/image](https://github.com/plotly/plotly.js/tree/master/test/image)
- [pixijs/pixijs discussion #10788](https://github.com/pixijs/pixijs/discussions/10788)
- [d3/d3-shape test/](https://github.com/d3/d3-shape/tree/main/test)
- [d3/d3-hierarchy test/](https://github.com/d3/d3-hierarchy/tree/main/test)
- [chartjs/Chart.js CI workflow](https://github.com/chartjs/Chart.js/blob/master/.github/workflows/ci.yml)
- [tigerbeetle.com/blog/2024-05-14-snapshot-testing-for-the-masses](https://tigerbeetle.com/blog/2024-05-14-snapshot-testing-for-the-masses/)
- [fuzzitdev/jsfuzz](https://github.com/fuzzitdev/jsfuzz)
- [bheisler/criterion.rs](https://github.com/bheisler/criterion.rs)
