# bench/ — Performance Benchmark Harness

End-to-end performance benchmarks for the eegdash-viewer hot paths.
Measures what the user actually feels, not micro-benchmarks of isolated functions.

## What is benchmarked

| File | Hot path | Network? |
|------|----------|----------|
| `filter.bench.mjs` | HP / LP / Notch / BP filtering on 32ch × 30s buffers at 250/512/1000 Hz (50 iterations) | No |
| `parse-matv5.bench.mjs` | `MatV5.parse + extractEegInline + Float32` conversion on synthetic inline .set files (10 iterations) | No |
| `readwindow.bench.mjs` | `readWindow` on real OpenNeuro recordings — EEGLAB .fdt, EDF, BrainVision (20 iterations per window size) | Yes |

All benchmarks report **p50 / p95** in milliseconds.

## Running locally

```sh
# Full suite (network required for readwindow)
npm run test:perf

# Skip network-bound readwindow benchmark
node bench/check-regression.mjs --skip-network

# Run a single bench file directly
node bench/filter.bench.mjs
node bench/parse-matv5.bench.mjs
node bench/readwindow.bench.mjs
```

The output is a formatted summary table comparing current measurements to
`bench/baseline.json`. Exit code is 0 if all metrics are within threshold,
1 if any metric regresses.

## Updating the baseline after intentional perf changes

After a deliberate performance improvement (or a known-safe regression you want
to accept), regenerate `baseline.json`:

```sh
# Run all benchmarks AND write new baseline
node bench/check-regression.mjs --update-baseline

# Or skip network if you only changed CPU-bound code:
node bench/check-regression.mjs --update-baseline --skip-network
```

Then commit the updated `bench/baseline.json`:

```sh
git add bench/baseline.json
git commit -m "perf: update baseline after <description of change>"
```

## Reading the regression output

```
Metric                                       base_p50   curr_p50     Δp50%   base_p95   curr_p95     Δp95%  Status
filter_hp_250hz                                  1.4       1.4     +0.8%       2.0       2.1     +4.2%  ok
filter_hp_1000hz                                 6.0      20.0   +233.0%       6.4      25.0   +290.0%  REGRESS (p50+233%, p95+290%)
```

- **base_p50 / curr_p50**: baseline and current p50 latency in milliseconds.
- **Δp50%**: percent change. Positive = slower (regression). Negative = faster.
- **Status**: `ok` if within threshold; `REGRESS (...)` if not.

### Thresholds

| Percentile | Threshold | Rationale |
|------------|-----------|-----------|
| p50 | > +10% | Median latency — user-perceivable on every pan |
| p95 | > +20% | Tail latency — catches occasional hitches |

Sub-millisecond metrics have an absolute noise floor of 0.5 ms before the
threshold is applied — this prevents measurement noise on near-zero metrics
from registering as a false positive.

## CI integration

The nightly workflow (`.github/workflows/perf-nightly.yml`) runs
`npm run test:perf` at 03:42 UTC and posts a summary table to the GitHub
Actions step summary.

**This workflow is nightly-only — it does not block PRs.** Network-bound
readWindow benchmarks are noisy on shared CI runners (CDN cold-cache, S3
per-connection throttling) and would produce false positives on PR workflows.
Nightly cadence is sufficient to detect genuine regressions.
