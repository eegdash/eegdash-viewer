# Surviving mutants in traces.js (baseline 2026-05-20)

Score: 37.29% (killed: 236 / total: 649, with 6 timeouts and 407 survivors)

Run config: `stryker.conf.json` (test runner: `node --test` over the three
traces test files — unit-traces-draw, unit-traces-partial-fill, traces).

Baseline mutant distribution (largest categories):

| Mutator              | Killed | Survived |
|---------------------|-------:|---------:|
| ArithmeticOperator  |     43 |      111 |
| ConditionalExpression |   72 |      105 |
| EqualityOperator    |     35 |       72 |
| BlockStatement      |     35 |       19 |
| StringLiteral       |      3 |       37 |

The 37% score reflects two structural realities: (a) traces.js draws
into a canvas and most "visual correctness" survives node:test because
the existing harness records only a subset of the ctx call stream; (b)
the lower half of the file (pagination + per-channel rendering loop)
is exercised mostly through partial-fill streaming tests that don't
hit every branch. The survivors below highlight the biggest gaps.

## Genuinely surviving (test gap candidates)

### Mutant ID: 515
- Location: traces.js:510
- Original: `const visibleN = Math.min(maxVisible, totalCh - offset);`
- Mutated:  `const visibleN = Math.min(maxVisible, totalCh + offset);`
- Why it survived: pagination (channel_offset) is not tested. The mutant
  reverses the visible-channel slice when offset > 0, but every test
  uses the default offset = 0, where `totalCh - 0 === totalCh + 0`.
- Suggested follow-up: add a draw test with `channel_offset: 5` and
  more channels than `maxVisible` so the slice bounds matter.

### Mutant ID: 572
- Location: traces.js:559
- Original: `const vToPx = (halfSlotPx * gain) / (ampl / 2);`
- Mutated:  `const vToPx = halfSlotPx / gain;`
- Why it survived: the per-channel amplitude → pixel scale formula has
  no assertion on slope. Tests check that polyline x-range stays
  bounded but never that the y-deflection of a known sinusoid matches
  the expected pixel amplitude.
- Suggested follow-up: feed a sample buffer with known std and assert
  that the recorded `lineTo` y-values span the expected pixel range
  for a given gain (e.g. gain=2 should double the deflection of gain=1).

### Mutant ID: 234
- Location: traces.js:276
- Original: `const x = Math.round(plotX0 + ((ev.onset - t0) / span) * (plotX1 - plotX0));`
- Mutated:  `const x = Math.round(plotX0 - (ev.onset - t0) / span * (plotX1 - plotX0));`
- Why it survived: the event-marker placement code path is not driven
  by any test (no `opts.events` in the draw fixtures). The mutant
  reflects events to the opposite side of plotX0 but is never observed.
- Suggested follow-up: add a draw test that supplies one or two events
  inside the visible window and asserts that the resulting `fillText`
  x-position lies between plotX0 and plotX1.

### Mutant ID: 103
- Location: traces.js:174
- Original: `const y = y0 + (c + 0.5) * slotH;`
- Mutated:  `const y = y0 + (c + 0.5) / slotH;`
- Why it survived: `drawChannelLabels` is invoked in real draws but
  the test harness's mock ctx does not record the y argument of label
  `fillText` calls (or, if it does, the assertions don't check it).
  So a division-instead-of-multiplication on the y-coordinate produces
  a different label position but the test doesn't notice.
- Suggested follow-up: assert that the y-values of `fillText` label
  calls are evenly spaced and inside the plot region; equivalently,
  assert `y[c+1] - y[c] ≈ slotH`.

### Mutant ID: 131
- Location: traces.js:199
- Original: `if (v <= 0) return 1;` (in `niceRound`)
- Mutated:  `if (v < 0) return 1;`
- Why it survived: `niceRound(0)` is never tested. The mutant returns
  `niceF * Math.pow(10, exp)` with `v=0`, which yields NaN, but
  `niceRound` is only invoked from `drawScaleBar` where the input is
  already guarded by `slotMicrovolts <= 0` earlier (line 218), so the
  NaN never propagates to an observable.
- Suggested follow-up: a direct unit test of the `niceRound` boundary
  at 0 would kill this immediately if niceRound were exported. Today
  it is module-private inside the IIFE, so this is also a refactor
  signal — promote niceRound to the exported test surface.

## Acceptable survivors (equivalent / IIFE-export noise)

### Mutant ID: 388
- Location: traces.js:397
- Original: `if (v < lo) lo = v;`
- Mutated:  `if (v <= lo) lo = v;`
- Why equivalent: when `v === lo`, both branches assign the same value
  to `lo`. The mutation is observationally indistinguishable on the
  decimator output. (Stryker's EqualityOperator class produces a known
  cluster of these in min/max scans.)

### Mutant IDs: ~13 mutants at traces.js:640–645 (StringLiteral / ConditionalExpression / EqualityOperator on the IIFE export tail)
- Location: traces.js:640–645
- Why equivalent: the trailing IIFE-export block (`if (typeof window
  !== 'undefined') window.TraceRenderer = api;` and its module/globalThis
  variants) exists purely so the file works in both browser and Node
  loaders. The tests already use the `globalThis.TraceRenderer` path,
  so mutating the `window` / `module.exports` guards leaves all tests
  green by design. Excluding this block from the mutator scope would
  inflate the score artificially; we leave them as documented noise.

### Mutant ID: ~13 survivors on `ArrayDeclaration` for cache fields (e.g. `lastDrawnXLabels: []`)
- Location: traces.js:630–639
- Why equivalent: these declare empty caches that are populated on the
  first draw call. Mutating `[]` → `["Stryker was here"]` introduces a
  spurious initial entry that is immediately overwritten, with no
  observable difference in any test.

## Notes for the next iteration

- Lines 200–349 hold ~140 of the surviving mutants (axis ticks, event
  markers, scale bar, channel labels). All five "test gap candidates"
  above target this band.
- Adding a single test for `channel_offset > 0` (mutant 515) and a
  single test for `opts.events` (mutant 234) would together kill an
  estimated 25–40 mutants — both code paths today are mutation-blind.
- A gain-scaling test (mutant 572) would kill another cluster around
  lines 540–600 (vToPx, halfSlotPx, ampl).

## Iteration 2 (PR 5, 2026-05-20)

Score: 43.76% (killed: 278 / total: 649, with 6 timeouts and 365 survivors)

Delta vs baseline: **+6.47 percentage points** (37.29% → 43.76%), 42 additional
mutants killed.

Tests added:

- `tests/unit-traces-nice-round.test.mjs` (new file, 11 tests) — direct
  unit tests against the newly exposed `_niceRound` debug export. Kills
  mutant 131 and its cluster around the 1/2/5×10^N ternary boundaries
  (1.5, 3.5, 7.5).
- `tests/unit-traces-draw.test.mjs` (+4 tests):
  - Channel label y-spacing (slotH invariant): kills mutant 103 plus
    the divide-vs-multiply cluster on `(c+0.5)*slotH`.
  - Event marker x-position: kills mutant 234 (sign-flip on the onset
    fraction) plus surrounding ArithmeticOperator mutants in
    `drawEventMarkers`.
  - Pagination — labels start at offset, tail-clamped offset, and
    different-offset-different-data: together cover mutant 515 and the
    surrounding `channel_offset` mutation cluster.
- `tests/unit-traces-partial-fill.test.mjs` (+1 test) — gain slope
  assertion at gain=0.5/1/2. Kills mutant 572 and the surrounding
  ArithmeticOperator mutants on `vToPx = (halfSlotPx * gain) / (ampl/2)`.

Source change (only one):

- `traces.js` — added `_niceRound: niceRound` to the api export so the
  module-private helper can be unit-tested directly. This is the single
  source modification allowed by this iteration; no behavioural change.

Stryker config:

- `stryker.conf.json` testRunner command updated to include the new
  `unit-traces-nice-round.test.mjs` file.
- Break threshold lifted from 32 → 38 (new floor — anchored 5 pts below
  the new score so honest regressions fail CI but trivial fluctuations
  do not).

### Remaining survivor clusters (next iteration targets)

Survivors by 50-line bucket of `traces.js` (top buckets):

| Lines     | Survivors | What lives here                                                |
|-----------|----------:|----------------------------------------------------------------|
| 300-349   |        56 | `computeTimeTicks` + `drawTimeAxis` (tick math, label format)  |
| 200-249   |        49 | `drawScaleBar` (geometry + label format) + niceRound boundary |
| 350-399   |        43 | `drawTimeAxis` + clock-mode HH:MM:SS branches                  |
| 250-299   |        38 | `drawEventMarkers` + `secToHHMMSS`/`isoToSecOfDay`             |
| 500-549   |        35 | Pagination tail (still has slice-edge mutants)                 |
| 600-649   |        34 | IIFE-export noise (mostly equivalent, see Acceptable below)    |

By mutator (top survivors):

| Mutator              | Killed | Survived |
|---------------------|-------:|---------:|
| ArithmeticOperator  |     56 |       98 |
| ConditionalExpression |   83 |       94 |
| EqualityOperator    |     44 |       63 |
| StringLiteral       |      3 |       37 |
| ArrayDeclaration    |      2 |       13 |

**Next iteration should target:**
- `computeTimeTicks` / `drawTimeAxis` (lines 300-399, ~100 survivors).
  Add tests that exercise the `niceSteps` table edges, the clock-mode
  vs numeric-mode branch, and the `Math.ceil(t0Sec / step) * step`
  first-tick alignment.
- `drawScaleBar` geometry (lines 215-244). Drive it directly with a
  known slotMicrovolts and assert the resulting moveTo/lineTo geometry.
- `secToHHMMSS` / `isoToSecOfDay` (lines 286-305). Pure functions —
  expose them via the same `_secToHHMMSS` / `_isoToSecOfDay` debug
  pattern used for `_niceRound` and add boundary-case unit tests.
- StringLiteral survivors (37 of them) are mostly font/color constants
  that the visual tests don't actually verify. Either accept-document
  them or add a pixel-level visual diff.
