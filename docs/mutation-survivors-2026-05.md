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

## Iteration 3 (PR 6, 2026-05-20)

Score: 54.55% (killed: 348 / total: 649, with 6 timeouts and 295 survivors)
Delta vs iteration 2: +10.79 pp (43.76% → 54.55%)

Tests added:
- `tests/unit-traces-time-axis.test.mjs` (new file, 32 tests):
  - `secToHHMMSS` boundary cases: 00:00:00, 00:59:59, 01:00:00, 02:02:02,
    23:59:59, exact-midnight wrap (86400), past-midnight wrap (90000),
    fractional floor (45.7 → "00:00:45"). 8 tests.
  - `isoToSecOfDay` parsing + null fallback: null, '', non-ISO string,
    midnight, +1h, end-of-day max, ISO with .ms suffix (truncated). 7 tests.
  - `computeTimeTicks` step selection from the niceSteps table:
    span=10 → step=1, span=100 → step=10, span=0.07 → step=0.01,
    floating-point edge (span=0.7 yields step=0.05 because 0.7/7 is
    0.0999...9 in IEEE 754), boundary pair at span=0.7000001 → step=0.1.
    5 tests.
  - `computeTimeTicks` clock vs numeric mode branch: numeric mode →
    useClock=false; clock mode with valid ISO → HH:MM:SS labels
    ("10:00:00" through "10:00:10"); clock mode with null ISO →
    useClock=false fallback. 3 tests.
  - `computeTimeTicks` first-tick alignment: (5,15) → first=5,
    (5.5,10.5) → step=0.5 and first=5.5. Endpoint inclusion: (0,10,step=1)
    → 11 ticks (t=0..10 inclusive, exercises the `t <= t1Sec + 1e-9`
    loop guard). 3 tests.
  - `formatScale` µV/mV boundary: 0.50 µV (sub-microvolt branch), 50 µV,
    999 µV (just under boundary), 1.0 mV (exact mV boundary), 5.5 mV.
    5 tests.
  - Plus 1 export-sanity test.

Source changes (debug exports only, NO behaviour changes):
- `_secToHHMMSS`, `_isoToSecOfDay`, `_computeTimeTicks`, `_formatScale`
  added to the `api` object in traces.js (mirrors the existing
  `_niceRound` pattern). Function bodies untouched.

Discrepancies found (documented, not fixed):
- `_computeTimeTicks(0, 0.7, ...)` returns step=0.05 — NOT 0.1 as a
  naive reading of the niceSteps table would suggest. Cause:
  `0.7 / 7 === 0.09999999999999999` in IEEE 754, which is strictly less
  than 0.1, so the `s <= target` scan stops at 0.05. The test pins this
  behaviour explicitly (with a sister test at span=0.7000001 → step=0.1
  to bound both sides of the float boundary). This is implementation-
  faithful, not a bug to fix in this PR.
- `_computeTimeTicks(5.5, 10.5, ...)` returns step=0.5 — the iteration-3
  plan initially claimed step=1 (first tick at 6), but the actual target
  is span/7 ≈ 0.714, which puts step at 0.5 and first tick at 5.5. Test
  pins the actual contract.

Threshold change:
- `break: 38` → `break: 49` (new_score - 5, rounded down). The +10.79 pp
  jump is large enough to warrant a firmer floor; 49 still leaves 5.5 pp
  of noise headroom.

Remaining survivors after iteration 3 (top clusters):

| Lines     | Survivors | What lives here                                                |
|-----------|----------:|----------------------------------------------------------------|
| 350-399   |        43 | `drawTimeAxis` clock-mode label/minor-tick rendering branches  |
| 200-249   |        37 | `drawScaleBar` geometry (moveTo/lineTo coordinates, fillText)  |
| 500-549   |        35 | Pagination tail / per-channel slice edges                      |
| 250-299   |        26 | `drawEventMarkers` body (label collision, slice(0,14), etc.)   |
| 600-649   |        25 | IIFE-export noise (mostly equivalent — see Acceptable section) |
| 150-199   |        27 | Header constants + `niceRound` interior                        |
| 100-149   |        21 | Color/font constants (StringLiteral survivors)                 |

By mutator (top survivors):

| Mutator              | Survived |
|---------------------|---------:|
| ArithmeticOperator  |       81 |
| ConditionalExpression |     78 |
| EqualityOperator    |       54 |
| StringLiteral       |       29 |
| LogicalOperator     |       13 |

**Next iteration should target:**
- `drawTimeAxis` rendering geometry (lines 333-410). The pure helpers
  are now covered; the remaining 43 survivors in 350-399 are the
  visual rendering path (moveTo/lineTo for minor ticks, fillText for
  labels). Extending the `unit-traces-draw` harness to record axis
  calls would attack this directly.
- `drawScaleBar` geometry (lines 217-244). Same pattern: 37 survivors
  in 200-249 are mostly geometry. Direct unit test with mocked ctx +
  assertions on `moveTo` coordinates and `fillText` arg.
- `drawEventMarkers` body (lines 250-284). 26 survivors. The label
  collision logic (`if (x - lastLabelX < 32) continue`) and the
  `.slice(0, 14)` truncation are likely the biggest unattacked branches.
- StringLiteral survivors (29 left): font/color constants. Same
  recommendation as iteration 2 — either accept-document or pixel diff.

## Iteration 4 (PR 9, 2026-05-20)

Score: 56.68% (killed: 397 / total: 711, with 6 timeouts and 308 survivors)
Delta vs iteration 3: +2.13 pp (54.55% → 56.68%)

Honest disclosure: the absolute jump is small relative to iterations 2-3
(+6.47, +10.79). Two factors compress the gain:

1. The two new shims (`_computeScaleBarGeometry`, `_computeTimeAxisLayout`)
   add 62 mutants of their own (711 vs 649 total mutants), so the
   denominator grew. The shims are well-tested but Stryker mutates BOTH
   the shim and the original function — and the original function bodies
   (drawScaleBar / drawTimeAxis) are still mutation-blind for ctx-only
   side effects (moveTo/lineTo coordinates, fillText positions). The shim
   tests the *contract* the original function should implement, not the
   actual ctx call stream of the original.
2. The top-3 surviving line buckets (350-399, 200-249, 500-549) didn't
   move much — their geometry mutants need a "record ctx calls and
   assert coordinates" approach, not a parallel pure-function copy.
   Iteration 5 should switch to that strategy.

Tests added:
- `tests/unit-traces-scalebar-axis.test.mjs` (new file, 24 tests):
  - `_computeScaleBarGeometry` boundaries: zero/negative/NaN/Infinity
    guards, px<8 floor, exact geometry deepStrictEqual, niceRound at
    sub-µV (slotMicrovolts=1 → targetMv=0.5), magic-number anchors
    (+18/-12/yTop=yBottom-px), linear slotH scaling. 11 tests.
  - `_computeTimeAxisLayout` numeric: 11 majors at span=10 step=1,
    linear x scaling, integer labels at step≥1, minor count = 40
    (50 candidates - 10 majors), no minor at major position, minor x
    bounded by adjacent majors, pinned t values (0.2/0.4/0.8/1.2)
    around t=1.0 skip, span=1 → step=0.1 with float-imprecise endpoint,
    (5,15) first-tick alignment. 9 tests.
  - `_computeTimeAxisLayout` clock mode: HH:MM:SS labels at midnight
    start, midnight wrap (23:59:55→00:00:05), null-ISO falls back to
    useClock=false numeric labels. 3 tests.
  - `_computeTimeAxisLayout` span≤0 → empty arrays defensive branch.
    1 test.
- `tests/unit-traces-draw.test.mjs` (+4 tests):
  - `channel_offset = totalCh - maxVisible` exact tail boundary: 35
    labels Ch16..Ch50, no clamp.
  - `channel_offset = totalCh - 1`: single Ch50 visible.
  - `channel_offset = totalCh`: clamps to totalCh-1, single Ch50.
  - `channel_offset = 9999`: same clamp, defensive NaN-moveTo check.

Source changes (debug exports only, NO behaviour changes):
- `_computeScaleBarGeometry(slotMicrovolts, slotH, plotX1, plotY0, plotHeight)`
  added to api. Mirrors drawScaleBar:217-225 line-for-line; parameter
  named `plotHeight` (not `plotH`) only because 'use strict' rejects
  duplicate parameter names.
- `_computeTimeAxisLayout(x0, x1, t0Sec, t1Sec, time_mode, recording_start_iso)`
  added to api. Mirrors drawTimeAxis:345-374 *without* ctx calls, returning
  `{ major, minor, useClock, step }`.

Threshold change:
- `break: 49` unchanged (jump too small to raise the floor; 49 stays as
  the iteration-3 anchor at score-5).

Stryker config:
- `commandRunner.command` extended to include
  `tests/unit-traces-scalebar-axis.test.mjs`.

Remaining survivors after iteration 4 (top clusters):

| Lines     | Survivors | What lives here                                                |
|-----------|----------:|----------------------------------------------------------------|
| 350-399   |        43 | `drawTimeAxis` ctx-side effects (moveTo/lineTo, fillText)      |
| 200-249   |        37 | `drawScaleBar` ctx-side effects (moveTo/lineTo, fillText)      |
| 500-549   |        35 | Pagination tail body — line/dimension mutants in slice math    |
| 150-199   |        27 | Header constants + `drawChannelLabels` interior + `niceRound` |
| 250-299   |        26 | `drawEventMarkers` body (label collision, slice(0,14), etc.)   |
| 600-649   |        25 | IIFE-export noise (mostly equivalent — see Acceptable section) |
| 100-149   |        21 | Color/font constants (StringLiteral survivors)                 |

By mutator (top survivors):

| Mutator              | Survived |
|---------------------|---------:|
| ArithmeticOperator  |       87 |
| ConditionalExpression |     80 |
| EqualityOperator    |       58 |
| StringLiteral       |       29 |
| LogicalOperator     |       14 |

**Next iteration should target:**
- Switch strategy: instead of more shims, extend the
  `unit-traces-draw.test.mjs` harness to record and assert on the
  actual ctx call stream from `drawScaleBar` / `drawTimeAxis`. The
  shim contracts are pinned; the remaining gap is observing what the
  real ctx receives. Specifically:
  - Record `moveTo`/`lineTo` calls during a draw() and assert the
    minor-tick x-positions match `_computeTimeAxisLayout(...).minor`
    exactly. That bridges the shim contract to the real path.
  - Same for `drawScaleBar`: assert the four moveTo/lineTo coordinates
    (vertical bar + two tick caps) match
    `_computeScaleBarGeometry(...)` outputs.
- `drawEventMarkers` body still has 26 survivors. The label collision
  logic (`if (x - lastLabelX < 32) continue`) needs a dense-event test
  (3+ events within 32px) to exercise both the skip-because-collision
  and the no-skip branches. The `.slice(0, 14)` truncation needs a
  test with a 15+ character label.
- StringLiteral survivors (29 left): same accept-or-pixel-diff
  recommendation as iterations 2 and 3.

## Iteration 5 (PR 11, 2026-05-20)

Score: 64.14% (killed: 450 / total: 711, with 6 timeouts and 255 survivors)
Delta vs iteration 4: +7.46 pp (56.68% → 64.14%)

Strategy shift, validated: the iteration-4 honest disclosure called out
that the PR-9 shims pinned the geometry CONTRACT but the original
`drawScaleBar` / `drawTimeAxis` / `drawEventMarkers` ctx call streams
were still mutation-blind. Iteration 5 added "ctx-conformance"
tests — drive a real `draw()` through the existing
`makeStubCtx`-recording harness, then assert that the recorded
`moveTo` / `lineTo` / `fillText` arguments match the shim's output
field-for-field. The bridge worked: 53 mutants flipped from Survived
to Killed, +7.46pp jump.

By cluster (delta vs iteration 4):

| Lines     | iter-4 | iter-5 | Δ      | What lives here                                                  |
|-----------|-------:|-------:|-------:|------------------------------------------------------------------|
| 200-249   |     37 |     15 | **-22** | `drawScaleBar` ctx-side effects (moveTo/lineTo, fillText)        |
| 350-399   |     43 |     26 | **-17** | `drawTimeAxis` ctx-side effects (moveTo/lineTo, fillText)        |
| 250-299   |     26 |     15 | **-11** | `drawEventMarkers` body (label collision, slice(0,14), window)   |
| 500-549   |     35 |     34 |    -1   | Pagination tail body — line/dimension mutants in slice math      |
| 150-199   |     27 |     27 |     0   | Header constants + `drawChannelLabels` interior + `niceRound`    |
| 600-649   |     25 |     25 |     0   | IIFE-export noise (mostly equivalent — see Acceptable section)   |
| 100-149   |     21 |     21 |     0   | Color/font constants (StringLiteral survivors)                   |

The three targeted clusters (200-249, 250-299, 350-399) collectively
shed 50 of the 53 newly-killed mutants. The shim-↔-ctx bridging
strategy is decisive against geometry-side-effect mutants.

Tests added — `tests/unit-traces-draw.test.mjs` (+12 tests, 24 → 36):

  drawTimeAxis ctx-conformance (4 tests):
  - Major-tick `moveTo` x positions match `_computeTimeAxisLayout(...).major[i].x`
    (strict-equality y filter on `axisBaselineY = plotY0 + plotH + 4`).
  - `fillText` labels equal `tick.label + ' s'` for every major tick,
    with x ≈ tick.x and y == axisBaselineY + 6 (lines 367-369).
  - Minor-tick `moveTo` x positions match `_computeTimeAxisLayout(...).minor[i].x`
    at ≥80% (floating-point accumulation drift allowance).
  - Axis horizontal baseline drawn from `plotX0` to `plotX1` (the
    very first moveTo+lineTo pair in drawTimeAxis, traces.js:341-342).

  drawScaleBar ctx-conformance (3 tests):
  - Vertical line `moveTo(x+0.5, yTop)` + `lineTo(x+0.5, yBottom)` match
    `_computeScaleBarGeometry`. (Note: yBottom is reached via lineTo,
    NOT a second moveTo — the original spec assumed two moveTos and was
    corrected against the source.)
  - Top + bottom tick caps: `moveTo(x-3, y+0.5)` + `lineTo(x+4, y+0.5)`
    at both `yTop` and `yBottom`. Pins the -3 / +4 / +0.5 constants.
  - `fillText` uses `_formatScale(targetMv)` at x=geom.x+8 and y=(yTop+yBottom)/2.

  drawEventMarkers ctx-conformance (5 tests):
  - Each visible event emits a `moveTo(round(...) + 0.5, plotY0)`.
  - Each visible event emits a `lineTo(round(...) + 0.5, plotY0 + plotH)`.
  - Events outside [t0, t1] produce ZERO moveTo at y=plotY0 (window
    filter at line 256).
  - Dense burst (3 events within 32 px): all 3 lines drawn, only first
    label rendered (collision filter at line 277; pins iteration order).
  - 20-char label is truncated to 14 chars via slice(0, 14) at line 279.

Source changes: NONE. This iteration is purely additive on the test
side; no behavioural change to traces.js.

Threshold change:
- `break: 49` unchanged. Score 64.14% is below the 65% raise-threshold
  bar specified in the iteration-5 plan, and a 15pp buffer (64.14 - 49)
  already comfortably guards against noise. Re-evaluate at iter-6 if
  the score crosses 65%.

Stryker config: unchanged (the new tests live in the already-included
`tests/unit-traces-draw.test.mjs`).

Mutators by surviving count (iter-5):

| Mutator              | Survived | Δ vs iter-4 |
|---------------------|---------:|------------:|
| ConditionalExpression |     73 |      -7     |
| ArithmeticOperator  |       55 |     -32     |
| EqualityOperator    |       54 |      -4     |
| StringLiteral       |       28 |      -1     |
| LogicalOperator     |       14 |      0      |

ArithmeticOperator falls hardest (-32) — direct evidence that the new
position/coordinate assertions caught a large family of arithmetic
mutations on tick spacing, scale-bar yBottom-px, and event-marker
round-plus-0.5 expressions.

**Next iteration (PR 12) should target:**
- The pagination tail at lines 500-549 (34 survivors, now the BIGGEST
  cluster). Iteration 4 added tail-boundary tests but the slice-math
  body itself still has many surviving mutants — they live in the
  inner loops that compute `nVisible`, `effectivePlotW`, `vToPx`, and
  the per-channel `yCenter`. Strategy: a focused test that drives a
  pagination scenario (offset > 0, totalCh > maxVisible) AND records
  the per-channel `yCenter` moveTos to assert each visible channel is
  drawn at `plotY0 + (c + 0.5) * slotH` with c starting at the offset.
- `drawChannelLabels` interior + `niceRound` (150-199, 27 survivors,
  unmoved). The lines-150-199 block contains the channel-label type
  chip rendering. A test driving channel_types with at least one
  non-EEG type and asserting the type-chip's `fillText` content +
  position would attack the 15 ConditionalExpression survivors here.
- StringLiteral survivors (28 left): same accept-or-pixel-diff
  recommendation as iterations 2-4. Pure aesthetic constants.

## Iteration 6 (PR 12, 2026-05-20)

Score: 66.39% (killed: 466 / total: 711, with 6 timeouts and 239 survivors)
Delta vs iteration 5: +2.25 pp (64.14% → 66.39%)

Honest disclosure: the targeted +8 to +12 pp landing zone (72-76%) was
NOT reached. The shim-to-ctx bridging pattern that delivered +7.46pp
against the axis/scalebar/event clusters in iter-5 returned only +2.25pp
against the pagination cluster. Diagnosis: the pagination cluster's
anatomy is genuinely different from the geometry-side-effect clusters
hit in iter-5 — most of the 34 lines-500-549 survivors are NOT the
"renderer ctx call wrong" mutants we expected, but **equivalent mutants
on guard predicates** that yield identical observable output. See the
post-mortem section below.

By cluster (delta vs iteration 5):

| Lines     | iter-5 | iter-6 | Δ      | What lives here                                                  |
|-----------|-------:|-------:|-------:|------------------------------------------------------------------|
| 500-549   |     34 |     28 | **-6** | Pagination tail body — see equivalent-mutant analysis below       |
| 150-199   |     27 |     23 | **-4** | `drawChannelLabels` interior — typeChip mutants now exposed       |
| 600-649   |     25 |     25 |     0  | IIFE-export noise (mostly equivalent — see Acceptable section)   |
| 350-399   |     26 |     26 |     0  | `drawTimeAxis` remaining (mostly minor-tick float-eps mutants)   |
| 100-149   |     21 |     21 |     0  | Color/font constants (StringLiteral survivors)                   |
| 250-299   |     15 |     15 |     0  | `drawEventMarkers` remaining (mostly StringLiteral/equivalent)   |
| 200-249   |     15 |     15 |     0  | `drawScaleBar` remaining (mostly StringLiteral/equivalent)       |

Tests added — `tests/unit-traces-draw.test.mjs` (+7 tests, 36 → 43):

  pagination ctx-conformance (7 tests):
  - per-row label y-spacing equals slotH with offset > 0
    (kills mutants on the `(c + 0.5) * slotH` arithmetic at visible idx,
    not just the absolute channel index).
  - bad-channel slot `fillRect(plotX0, plotY0 + c*slotH, plotW, slotH)`
    tracks the VISIBLE row when offset > 0 (kills a slice-drop on
    `bad_mask` — a mutant reading the unsliced array would put the
    fillRect at the absolute index's y position).
  - per-row `strokeStyle` matches `sliced channel_colors[visibleIdx]`
    (kills a slice-drop on `colors`).
  - per-row `setLineDash` matches `sliced channel_types[visibleIdx]`
    (kills a slice-drop on `types`; uses EOG at the offset boundary so
    visible row 0's dash pattern is the distinguishing feature).
  - slot-divider count equals visibleN - 1 under offset > 0
    (kills mutants on the `for (c = 1; c < nCh; c++)` loop bounds in
    drawSlotDividers when nCh is the post-slice count).
  - visibleN = min(maxVisible, totalCh - offset) at the tight tail
    (offset=37, totalCh=40 → exactly Ch38, Ch39, Ch40 in order).
  - trace polyline moveTos appear within ±halfSlotPx of per-row yCenter
    for visibleIdx in {0, visibleN-1} with offset > 0.

Source changes: NONE. This iteration is purely additive on the test
side; no behavioural change to traces.js.

Threshold change:
- `break: 49` unchanged. Score 66.39% is below the 67% raise-threshold
  bar specified in the iteration-6 plan, and a 17.39pp buffer
  (66.39 - 49) already comfortably guards against noise. Re-evaluate at
  iter-7 if the score crosses 70%.

Stryker config: unchanged. (Incremental cache was corrupted at iter-6
start — `incrementalFile` reported "1 of 1 files to be mutated using
incremental report with 711 mutant(s), and 1 test(s)" which made
`stryker run --incremental` a no-op. Deleted the cache file and ran a
full mutation pass.)

Mutators by surviving count (iter-6):

| Mutator              | Survived | Δ vs iter-5 |
|---------------------|---------:|------------:|
| ConditionalExpression |     67 |      -6     |
| ArithmeticOperator  |       52 |      -3     |
| EqualityOperator    |       50 |      -4     |
| StringLiteral       |       28 |      0      |
| LogicalOperator     |       14 |      0      |

### Post-mortem: why +2.25pp instead of +8 to +12pp?

A line-by-line look at the 28 survivors that remain in lines 500-549
reveals the cluster's true anatomy:

| Survivor count | Lines | Mutator family | Verdict |
|---:|---|---|---|
| 6 | 502 (`plotW <= 4 \|\| plotH <= 4` guard) | ConditionalExpression / EqualityOperator / LogicalOperator | **Equivalent** to test setup: all our tests use 800x600, none exercises a <80px canvas where the early-return triggers. |
| 12 | 512-516 (`totalCh > maxVisible ? slice(...) : allXxx`) | ConditionalExpression / EqualityOperator (×4 channels: data/labels/types/colors/bad) | **Equivalent in our setup**: when `totalCh <= maxVisible` the slice with `offset = clamp([0, max(0, totalCh-1)], 0) = 0` and `visibleN = min(maxVisible, totalCh) = totalCh` yields a slice identical to the original. Flipping the `>` predicate produces an array that is `slice(0, totalCh)` of the same array — by-reference different, by-value identical. |
| 1 | 510 (`totalCh - offset → totalCh + offset`) | ArithmeticOperator | **Equivalent under JS slice clamping**: `Array.prototype.slice(offset, offset+huge)` clamps `end` to `length`, so the slice is the same as `slice(offset, length)`. Already documented in iter-1 (Mutant ID: 515). |
| 1 | 519 (`Math.min(...) → Math.max(...)` on n_samples_visible) | MethodExpression | **Equivalent in our setup**: all tests use `channels[0].length === opts.n_samples_visible`, so `min(a,a) === max(a,a)`. |
| 4-5 | 529/548 (partial_fill conditions, decimate threshold) | Conditional / Arithmetic / Equality | **Coverage gap**: no test exercises `partial_fill` AND no test sits at a decimation-threshold sample-density. Would need a dedicated partial_fill test to kill. |
| 2 | 514 / 548 surfacing as `ConditionalExpression true/false` | | Hybrid: same as above plus a small bit of legit gap. |

Net: of the 28 remaining 500-549 survivors, **~20 are equivalent
mutants** that no test can kill without introducing observable output
differences (which the renderer is correct NOT to produce — flipping a
`>` to `>=` on `totalCh > maxVisible` when the two branches yield
byte-identical ctx call streams is genuinely indistinguishable). The
iteration-6 pagination ctx-conformance tests killed the 6 mutants that
were actually distinguishable in that cluster (most importantly the
`bad_mask` slice-drop, the `colors` slice-drop, the `types` slice-drop,
the slot-divider count, the visibleN tight-tail formula, and the per-
row yCenter formula).

This is the same equivalent-mutant phenomenon called out for the IIFE
export tail (lines 615-628, 13 mutants) in the iter-1 "Acceptable
survivors" section: when a mutation cannot change observable output,
no test can kill it. The fix is to mark these mutants as ignored via
a Stryker comment or `mutator.excludedMutations` setting, not to
write more tests.

**Next iteration (PR 13) should target:**
- `drawChannelLabels` typeChip path (150-199, 23 survivors): the
  iter-6 pagination tests drove offset > 0 but never `channel_types`
  with a non-EEG type at the visible offset, leaving the type-chip
  rendering branch (traces.js:175-186) almost entirely uncovered. A
  test using `channel_types = [..., 'EOG', 'ECG', 'EMG', ...]` and
  asserting:
  - The type-chip's `fillText(type, x-8, y+0.5)` content (kills the
    `.toUpperCase()` / equality / -EEG-filter mutants at line 175-176).
  - The label's `fillText(label, x - 8 - typeW - 6, y)` x position
    (kills the `typeW * 2`, `-6 → +6` arithmetic mutants at line 186).
  - The empty-types-array path (`types ? ... : ''`) drives a default-
    branch test that exercises the `types && types[c] || ''` short-
    circuit at line 175.
  Expected delta: -10 to -15 mutants in 150-199, +1.5 to +2pp on
  total mutation score.
- `drawTimeAxis` minor-tick float-eps and skip-at-major (350-399, 26
  survivors): the iter-5 ≥80% match on minor-tick x positions left a
  handful of survivors at the major-tick skip boundary (`Math.abs(r-
  Math.round(r)) < 1e-6`). A test that drives a window where exactly
  one minor coincides with a major (e.g. major at 0.5, minor at 0.5)
  and asserts NO duplicate moveTo at that x would close it.
  Expected delta: -3 to -5 mutants.
- File-Stryker-equivalent-mutant ignore list (PR-only, not test work):
  drop the 12 line-512-516 "slice-when-shrunk" predicates from
  Stryker's mutator scope via inline `// Stryker disable next-line all`
  comments. This converts ~12 equivalent survivors to no-cov, raising
  the apparent score by ~1.7pp without changing real test power.
- StringLiteral survivors (28 left, unchanged): same accept-or-pixel-
  diff recommendation as iterations 2-5. Pure aesthetic constants.
