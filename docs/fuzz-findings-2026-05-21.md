# Fuzz Findings — 2026-05-21 (Extreme 100k Run)

## Summary

**Result: CLEAN.** All six fuzz targets in `tests/fuzz-formats-extreme.test.mjs`
survived 100,000 iterations each (600,000 total iterations) without producing
a crash, hang, non-`Error` throw, or contract violation.

This is a one-time deep-validation pass run on top of the 10k-iteration
nightly suite (`tests/fuzz-formats.test.mjs`, the actual CI gate). Its purpose
is to surface statistically rare failure modes that the nightly might miss
through sheer iteration depth, and to provide a reproducible baseline for
future parser refactors.

## Environment

| Item | Value |
|------|-------|
| Date | 2026-05-21 |
| Branch | `main` |
| Host | macOS (Darwin 25.3.0), developer laptop |
| Node | runtime under `node --test --test-timeout=600000` |
| Suite file | `tests/fuzz-formats-extreme.test.mjs` |
| Iterations per target | 100,000 |
| Total iterations | 600,000 |
| Total wall-clock | 143.16 s (~2 min 23 s) |

## Per-target results

| # | Target | Parser file | Iterations | Wall-clock | Result |
|---|--------|-------------|-----------:|-----------:|--------|
| 1 | EDF `parseHeader` | `formats/edf.js` | 100,000 | 13.68 s | PASS |
| 2 | EDF `parseTAL` | `formats/edf.js` | 100,000 | 13.91 s | PASS |
| 3 | BrainVision `parseIni` | `formats/brainvision.js` | 100,000 | 0.26 s | PASS |
| 4 | BrainVision `parseHeader` | `formats/brainvision.js` | 100,000 | 0.74 s | PASS |
| 5 | EEGLAB `_sliceColumnMajor` | `formats/eeglab.js` | 100,000 | 114.30 s | PASS |
| 6 | FIFF `read` | `formats/fiff.js` | 100,000 | 0.15 s | PASS |

Combined: 600,000 iterations across all targets in 143.16 s.

## Notes

- **EEGLAB `_sliceColumnMajor`** dominates wall-clock (114.3 s / 80 % of
  total). This is expected: it's the only target that allocates a fresh
  `Float32Array` of up to `128 * 5000 = 640,000` elements per iteration and
  fills it. If a future tweak pushes it beyond the 10-minute
  `--test-timeout`, drop its `numRuns` to `50_000` (still 5× deeper than
  nightly) and document inline.
- **FIFF `read`** finishes in 150 ms because the current parser rejects the
  three fixture FIFF files outright (it expects literal ASCII `"FIFF"`
  magic that the real files lack — see
  `tests/fixtures/eeg/LICENSE-ATTRIBUTION.md` "Known parser issues").
  Mutated bytes around the real tag structure still exercise the
  defensive-throw path; the speed is a clue that the parser bails very
  early. When the FIFF reader is fixed to accept real files, expect this
  target's runtime to grow accordingly and revisit the iteration budget.
- **BrainVision** parsers are the fastest non-trivial targets (260 ms and
  735 ms). The wider `parseHeader` is ~3× slower than the underlying
  `parseIni` because it walks the parsed sections and coerces values.
- **EDF `parseHeader` / `parseTAL`** are both bound by the cost of the
  corpus mutator copying ~33 KB seed buffers per iteration; the parsers
  themselves are cheap. This is acceptable: we deliberately run on
  realistic input shapes, not on tiny synthetic blobs.

## Action items

None — no bugs found, no regressions to pin. The extreme suite stays in
the repo as a periodic verification tool; the nightly 10k suite remains the
CI gate.

## How to re-run

```
node --test --test-timeout=600000 tests/fuzz-formats-extreme.test.mjs \
  2>&1 | tee /tmp/fuzz-extreme.log
```

To narrow iteration count (e.g. when validating a hot-path refactor):

```
FUZZ_RUNS=50000 node --test --test-timeout=600000 \
  tests/fuzz-formats-extreme.test.mjs
```

## How to handle a future crash

If any target finds a counterexample in a later run:

1. Copy the shrunk `Uint8Array` fast-check reports (it'll print a hex
   dump in the failure message).
2. Pin it as an `examples: [shrunk]` entry on the corresponding
   `tests/prop-*.test.mjs` property so per-PR CI catches the regression
   instantly.
3. Add a new dated findings doc (`docs/fuzz-findings-YYYY-MM-DD.md`)
   describing the parser path, the failing line, the input bytes, the
   expected behaviour, and a suggested fix.
4. Mark the extreme target in `tests/fuzz-formats-extreme.test.mjs` with
   `t.skip()` and a pointer to the findings doc until the parser is
   repaired.
