# Multi-Run Audit: data.eegdash.org Loadability

**Date:** 2026-05-21
**Runs:** 5 (seeds: 1, 2, 3, 4, 5)
**Catalog total:** 800 datasets
**Sample size per run:** 100

## Overall Loadability

| Statistic | Value |
| --- | --- |
| Mean loadable rate | **85.0%** |
| Min | 78.0% |
| Max | 94.0% |
| Std deviation | 5.7% |
| 95% CI (half-width) | ±7.1% |
| Per-run rates | 85.0%, 78.0%, 94.0%, 84.0%, 84.0% |

## Loadability by Datatype

| Datatype | Runs | Mean | Min | Max | Std | 95% CI | Avg n |
| --- | ---:| ---:| ---:| ---:| ---:| ---:| ---:|
| eeg | 5 | **95.6%** | 92.0% | 97.3% | 2.1% | ±2.7% | 71.6 |
| meg | 5 | **55.1%** | 32.1% | 78.9% | 17.1% | ±21.2% | 24.0 |
| ieeg | 4 | **84.6%** | 75.0% | 100.0% | 10.8% | ±17.2% | 5.5 |

## Verdict Counts (mean across runs)

| Verdict | Mean | Min | Max | Std |
| --- | ---:| ---:| ---:| ---:|
| loadable | 85.0 | 78 | 94 | 5.74 |
| no-recording-found | 15.0 | 6 | 22 | 5.74 |

## Methodology

- Audit script: `scripts/audit-100-datasets.mjs` (commit-pinned).
- Sampling: reservoir sampling (Algorithm R) seeded with Mulberry32 PRNG.
- Per-dataset probe: list S3 keys for the first subject's recording, then range-GET via cdn.eegdash.org.
- Verdicts: `loadable`, `cdn-missing-file`, `no-recording-found`, `unsupported-datatype`.
- 95% CI uses Student's t for small n (n=5 → t=2.776).
- Per-run JSON: `reports/audit/run-<seed>.json` (gitignored).

## Full Catalog Result (n=800)

A single deterministic pass over the entire catalog (seed=0) gives the exact ground-truth numbers:

| Verdict | Count | Share |
| --- | ---:| ---:|
| loadable | 672 | 84.0% |
| no-recording-found | 128 | 16.0% |

| Datatype | Loadable | Total | Rate |
| --- | ---:| ---:| ---:|
| eeg | 552 | 584 | 94.5% |
| meg | 80 | 168 | 47.6% |
| ieeg | 40 | 48 | 83.3% |
