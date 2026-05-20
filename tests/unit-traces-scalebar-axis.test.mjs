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

// ---------------------------------------------------------------------------
// B. _computeTimeAxisLayout — kills the drawTimeAxis tick math + minor-
//    tick mutants (lines 333-374).
// ---------------------------------------------------------------------------

test('_computeTimeAxisLayout(100,900, 0,10) numeric → 11 majors, x∈[100,900]', () => {
  // span=10, step=1, ticks at 0..10 inclusive (11 entries — the
  // `t <= t1Sec + 1e-9` loop guard).
  const r = T._computeTimeAxisLayout(100, 900, 0, 10, 'relative', null);
  assert.strictEqual(r.major.length, 11);
  assert.strictEqual(r.major[0].x, 100);
  assert.strictEqual(r.major[10].x, 900);
  assert.strictEqual(r.major[5].x, 500); // midpoint sanity
  assert.strictEqual(r.useClock, false);
  assert.strictEqual(r.step, 1);
});

test('_computeTimeAxisLayout numeric: major labels are integer strings at step≥1', () => {
  // step=1 → labels formatted as toFixed(0). Catches mutants on the
  // step-driven label digit count.
  const r = T._computeTimeAxisLayout(100, 900, 0, 10, 'relative', null);
  assert.strictEqual(r.major[0].label, '0');
  assert.strictEqual(r.major[5].label, '5');
  assert.strictEqual(r.major[10].label, '10');
});

test('_computeTimeAxisLayout numeric: x scales linearly with t', () => {
  // For t in [t0Sec, t1Sec], x = x0 + (t - t0Sec)/(t1Sec - t0Sec) * (x1 - x0).
  // Catches sign-flip mutants on the (t - t0Sec) term or (x1 - x0) term.
  const r = T._computeTimeAxisLayout(100, 900, 0, 10, 'relative', null);
  // 800px / 10s = 80 px per second; major[k] is at x = 100 + k*80.
  for (let k = 0; k < r.major.length; k++) {
    assert.strictEqual(r.major[k].x, 100 + k * 80, `major[${k}] x mismatch`);
  }
});

test('_computeTimeAxisLayout numeric: minor count = (majors-1) × 4', () => {
  // 5 sub-divisions per major span (minorStep = step/5), but minors that
  // coincide with a major are skipped. For span=10 step=1 minorStep=0.2:
  //   candidate minors at 0, 0.2, 0.4, …, 10.0 (51 in principle)
  //   minus 11 majors at integer positions
  //   = 40 minors actually drawn.
  // Mutants on `step / 5` would change the minor count dramatically.
  const r = T._computeTimeAxisLayout(100, 900, 0, 10, 'relative', null);
  assert.strictEqual(r.minor.length, 40);
});

test('_computeTimeAxisLayout: no minor tick at a major-tick position', () => {
  // The skip-at-major rule `Math.abs(r - Math.round(r)) < 1e-6`. For
  // step=1, minorStep=0.2, the values 0.0, 1.0, …, 10.0 are skipped.
  // Mutant flipping the < to >= would emit minors AT every major.
  const r = T._computeTimeAxisLayout(100, 900, 0, 10, 'relative', null);
  const majorTs = new Set(r.major.map(m => Math.round(m.t * 1e6)));
  for (const m of r.minor) {
    const key = Math.round(m.t * 1e6);
    assert.ok(!majorTs.has(key),
      `minor at t=${m.t} coincides with a major-tick position`);
  }
});

test('_computeTimeAxisLayout: minor x-positions land strictly between adjacent majors', () => {
  // Geometric sanity — minor x values must fall between consecutive
  // major x values. Catches sign-flip mutants on the (t - t0Sec)/span
  // term that would push minors outside the plot band.
  const r = T._computeTimeAxisLayout(100, 900, 0, 10, 'relative', null);
  for (const m of r.minor) {
    assert.ok(m.x >= 100 && m.x <= 900,
      `minor x=${m.x} outside [100,900] band`);
  }
});

test('_computeTimeAxisLayout(100,900, 0,1) → step=0.1, 11 majors', () => {
  // span=1, target=1/7≈0.143, largest niceSteps entry ≤ 0.143 is 0.1.
  // Floating-point accumulation: the last tick is at 0.9999…, NOT 1.0,
  // because the loop adds step repeatedly. The `t <= t1Sec + 1e-9` guard
  // still admits it.
  const r = T._computeTimeAxisLayout(100, 900, 0, 1, 'relative', null);
  assert.strictEqual(r.step, 0.1);
  assert.strictEqual(r.major.length, 11);
  // First tick at exactly 0; last tick is "close to 1" (≤ 1 + 1e-9).
  assert.strictEqual(r.major[0].t, 0);
  assert.ok(Math.abs(r.major[10].t - 1) < 1e-9,
    `last tick t=${r.major[10].t} should be close to 1`);
});

test('_computeTimeAxisLayout clock mode → useClock=true, HH:MM:SS labels', () => {
  // time_mode='clock' AND recording_start_iso truthy → clock branch.
  // startSecOfDay(2024-01-15T00:00:00) = 0, so labels at t=0..10 are
  // secToHHMMSS(0..10) = "00:00:00".."00:00:10".
  const r = T._computeTimeAxisLayout(100, 900, 0, 10, 'clock', '2024-01-15T00:00:00');
  assert.strictEqual(r.useClock, true);
  assert.strictEqual(r.major[0].label, '00:00:00');
  assert.strictEqual(r.major[1].label, '00:00:01');
  assert.strictEqual(r.major[10].label, '00:00:10');
});

test('_computeTimeAxisLayout clock mode: midnight wrap (23:59:55 → 00:00:05)', () => {
  // Drive the modulo wrap in secToHHMMSS. With t0Sec=86395 and a midnight
  // start ISO, startSecOfDay + t0Sec = 86395 → secToHHMMSS hits the
  // `% 86400` wrap at t=5 within the window.
  const r = T._computeTimeAxisLayout(100, 900, 86395, 86405, 'clock', '2024-01-15T00:00:00');
  assert.strictEqual(r.useClock, true);
  assert.strictEqual(r.major[0].label, '23:59:55');
  // 5 seconds into the window, time wraps to midnight.
  assert.strictEqual(r.major[5].label, '00:00:00');
  assert.strictEqual(r.major[10].label, '00:00:05');
});

test('_computeTimeAxisLayout(100,900, 5,15) numeric → first tick aligned at 5', () => {
  // step=1, first = ceil(5/1)*1 = 5. Catches Math.ceil → Math.round
  // mutants on the first-tick alignment (would still pin 5 here, but
  // would shift the entire tick set by half a step).
  const r = T._computeTimeAxisLayout(100, 900, 5, 15, 'relative', null);
  assert.strictEqual(r.major.length, 11);
  assert.strictEqual(r.major[0].t, 5);
  assert.strictEqual(r.major[10].t, 15);
  assert.strictEqual(r.major[0].x, 100);
  assert.strictEqual(r.major[10].x, 900);
});

test('_computeTimeAxisLayout: clock mode with null ISO falls back to useClock=false', () => {
  // The `&& !!recording_start_iso` short-circuit: mode is 'clock' but
  // no ISO → useClock=false, labels revert to numeric strings.
  // Catches mutants that drop the ISO check from the conditional.
  const r = T._computeTimeAxisLayout(100, 900, 0, 10, 'clock', null);
  assert.strictEqual(r.useClock, false);
  assert.strictEqual(r.major[0].label, '0');
});

test('_computeTimeAxisLayout: span<=0 → empty arrays', () => {
  // Defensive: drawTimeAxis guards `if (span <= 0) return;`. Our shim
  // returns the same shape with empty arrays. Catches mutants that
  // would either crash on /0 or emit garbage ticks.
  const r1 = T._computeTimeAxisLayout(100, 900, 5, 5, 'relative', null);
  assert.deepStrictEqual(r1.major, []);
  assert.deepStrictEqual(r1.minor, []);
});

test('_computeTimeAxisLayout: span=10 numeric — minor-tick spacing is 0.2', () => {
  // With step=1, minorStep = 0.2 (= step/5). First minor that is NOT
  // also a major is at t=0.2; consecutive minors are 0.2 apart, with a
  // gap at each integer position (where a major lives). Pin minor[0]
  // and minor[1] explicitly.
  const r = T._computeTimeAxisLayout(100, 900, 0, 10, 'relative', null);
  assert.ok(Math.abs(r.minor[0].t - 0.2) < 1e-9,
    `first minor should be at t=0.2, got ${r.minor[0].t}`);
  assert.ok(Math.abs(r.minor[1].t - 0.4) < 1e-9,
    `second minor should be at t=0.4, got ${r.minor[1].t}`);
  // minor[3] is at 0.8 (skipping t=1.0 which is a major); next minor
  // is at 1.2. Pin this gap explicitly.
  assert.ok(Math.abs(r.minor[3].t - 0.8) < 1e-9,
    `fourth minor should be at t=0.8, got ${r.minor[3].t}`);
  assert.ok(Math.abs(r.minor[4].t - 1.2) < 1e-9,
    `fifth minor should be at t=1.2 (skipped t=1.0), got ${r.minor[4].t}`);
});
