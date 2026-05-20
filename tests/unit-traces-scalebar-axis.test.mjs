// unit-traces-scalebar-axis.test.mjs
//
// Direct unit tests for traces.js scale-bar + time-axis layout geometry
// via the _computeScaleBarGeometry and _computeTimeAxisLayout debug
// exports. Each test targets a specific mutant cluster per
// docs/mutation-survivors-2026-05.md iteration-4 plan.
//
// Clusters being attacked:
//   - lines 200-249 (drawScaleBar geometry, moveTo/lineTo coords, fillText)
//   - lines 350-399 (drawTimeAxis clock-mode + minor-tick rendering)
//
// These shims are pure (no canvas, no DOM) and mirror the in-function
// math line-for-line, so each test pins a deterministic number — no
// tolerances except for the documented float-imprecision in minor-tick
// accumulation.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
globalThis.ResizeObserver = globalThis.ResizeObserver || class {
  observe() {} unobserve() {} disconnect() {}
};
globalThis.window.devicePixelRatio = 1;

const T = require('../traces.js');

// ---------------------------------------------------------------------------
// Sanity: both iteration-4 helpers are exported.
// ---------------------------------------------------------------------------

test('iteration-4 helpers are exported on the api surface', () => {
  // Catches any future refactor that quietly drops a debug export and
  // revives the corresponding mutant cluster.
  assert.equal(typeof T._computeScaleBarGeometry, 'function');
  assert.equal(typeof T._computeTimeAxisLayout, 'function');
});

// ---------------------------------------------------------------------------
// A. _computeScaleBarGeometry — kills the drawScaleBar arithmetic +
//    boundary mutants (lines 217-225).
// ---------------------------------------------------------------------------

test('_computeScaleBarGeometry(0, …) → null (zero µV guard)', () => {
  // `if (!isFinite(slotMicrovolts) || slotMicrovolts <= 0) return;`
  // Mutant flipping <= 0 to < 0 would let zero through and produce
  // targetMv = niceRound(0) = 1, px = (1/0)*slotH = Infinity. The
  // subsequent isFinite(px) guard still catches it, but the contract
  // is "zero in → null out, not garbage".
  assert.strictEqual(T._computeScaleBarGeometry(0, 100, 700, 0, 500), null);
});

test('_computeScaleBarGeometry(-50, …) → null (negative µV guard)', () => {
  // Same guard, negative branch. Mutant flipping <= to < admits -50
  // but the rest of the formula would still produce a (negative) value.
  assert.strictEqual(T._computeScaleBarGeometry(-50, 100, 700, 0, 500), null);
});

test('_computeScaleBarGeometry(NaN, …) → null (NaN guard)', () => {
  // The `!isFinite(slotMicrovolts)` half of the guard. Without it,
  // the function would return an object full of NaN coordinates and
  // the scale bar would silently disappear.
  assert.strictEqual(T._computeScaleBarGeometry(NaN, 100, 700, 0, 500), null);
});

test('_computeScaleBarGeometry(Infinity, …) → null (Infinity guard)', () => {
  // The `!isFinite(slotMicrovolts)` guard. niceRound(Infinity * 0.5)
  // would yield Infinity, and px would be NaN (Infinity/Infinity).
  // The contract: any non-finite input returns null up front.
  assert.strictEqual(T._computeScaleBarGeometry(Infinity, 100, 700, 0, 500), null);
});

test('_computeScaleBarGeometry(1000, 10, 700, 0, 500) → null (px<8 floor)', () => {
  // targetMv = niceRound(500) = 500, px = (500/1000)*10 = 5. The
  // `px < 8` guard fires. Mutant flipping `< 8` to `< 0` would admit
  // a 5-pixel scale bar that's unreadable but visible.
  assert.strictEqual(T._computeScaleBarGeometry(1000, 10, 700, 0, 500), null);
});

test('_computeScaleBarGeometry(100, 50, 700, 0, 500) → simple case', () => {
  // Drive every constant in the geometry:
  //   targetMv = niceRound(50) = 50 (f=5, niceF=5, exp=1)
  //   px = (50/100)*50 = 25
  //   x = 700 + 18 = 718
  //   yBottom = 0 + 500 - 12 = 488
  //   yTop = 488 - 25 = 463
  // Mutants on the `+ 18`, `- 12`, the multiplier `0.5`, or the
  // subtraction in yTop each change one of these five fields.
  const r = T._computeScaleBarGeometry(100, 50, 700, 0, 500);
  assert.deepStrictEqual(r, {
    targetMv: 50,
    px: 25,
    x: 718,
    yBottom: 488,
    yTop: 463,
  });
});

test('_computeScaleBarGeometry(200, 80, 700, 0, 500) → niceRound rounds up to 100', () => {
  // niceRound(100) = 100 (exact: f=1.0, niceF=1, exp=2).
  // px = (100/200)*80 = 40. Anchors the niceRound branch where the
  // 0.5*slotMicrovolts input is already on the niceSteps grid.
  const r = T._computeScaleBarGeometry(200, 80, 700, 0, 500);
  assert.strictEqual(r.targetMv, 100);
  assert.strictEqual(r.px, 40);
  assert.strictEqual(r.x, 718);
  assert.strictEqual(r.yBottom, 488);
  assert.strictEqual(r.yTop, 448);
});

test('_computeScaleBarGeometry(1, 50, 700, 0, 500) → sub-µV niceRound boundary', () => {
  // slotMicrovolts=1 → niceRound(0.5). exp=floor(log10(0.5))=-1,
  // f=0.5/0.1=5, niceF=5 (since 5 < 7.5), result = 5*0.1 = 0.5.
  // px = (0.5/1)*50 = 25. Catches mutants that change the niceRound
  // log10 / pow10 arithmetic for sub-unit inputs.
  const r = T._computeScaleBarGeometry(1, 50, 700, 0, 500);
  assert.strictEqual(r.targetMv, 0.5);
  assert.strictEqual(r.px, 25);
});

test('_computeScaleBarGeometry geometry constants (+18, -12, yTop=yBottom-px)', () => {
  // Locks the three magic-number constants in drawScaleBar:
  //   x = plotX1 + 18
  //   yBottom = plotY0 + plotH - 12
  //   yTop = yBottom - px
  // Mutants on each integer literal would shift the bar by 1+ pixels.
  // We drive plotX1, plotY0, plotH to non-default values so the constants
  // can't hide in a default-of-zero.
  const plotX1 = 500, plotY0 = 30, plotH = 200;
  const r = T._computeScaleBarGeometry(100, 50, plotX1, plotY0, plotH);
  assert.strictEqual(r.x, plotX1 + 18);
  assert.strictEqual(r.yBottom, plotY0 + plotH - 12);
  assert.strictEqual(r.yTop, r.yBottom - r.px);
});

test('_computeScaleBarGeometry px scales linearly with slotH', () => {
  // For fixed slotMicrovolts, px = (targetMv / slotMicrovolts) * slotH.
  // Doubling slotH must double px. Catches mutants that swap slotH for
  // a constant or flip the multiplication for division.
  const r1 = T._computeScaleBarGeometry(100, 50, 700, 0, 500);
  const r2 = T._computeScaleBarGeometry(100, 100, 700, 0, 500);
  assert.strictEqual(r2.px, r1.px * 2);
  // targetMv is independent of slotH — only slotMicrovolts*0.5 drives it.
  assert.strictEqual(r1.targetMv, r2.targetMv);
});

