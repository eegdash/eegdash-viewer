// unit-traces-time-axis.test.mjs
//
// Direct unit tests against the time-axis + scale-bar helpers exposed
// via debug surface (_secToHHMMSS, _isoToSecOfDay, _computeTimeTicks,
// _formatScale). Each test targets a specific surviving-mutant cluster
// per docs/mutation-survivors-2026-05.md iteration-3 plan.
//
// Clusters being attacked:
//   - lines 200-249 (drawScaleBar geometry, formatScale µV/mV split)
//   - lines 250-299 (drawEventMarkers body + secToHHMMSS / isoToSecOfDay)
//   - lines 300-349 (computeTimeTicks + drawTimeAxis)
//   - lines 350-399 (drawTimeAxis clock-mode HH:MM:SS branches)
//
// These helpers are pure (no canvas, no DOM) so each test pins a
// deterministic string or number — no tolerances allowed.

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
// Sanity: all four helpers are exported.
// ---------------------------------------------------------------------------

test('all four time-axis helpers are exported on the api surface', () => {
  // Catches any future refactor that quietly drops a debug export and
  // revives the corresponding mutant cluster.
  assert.equal(typeof T._secToHHMMSS, 'function', '_secToHHMMSS must be a function');
  assert.equal(typeof T._isoToSecOfDay, 'function', '_isoToSecOfDay must be a function');
  assert.equal(typeof T._computeTimeTicks, 'function', '_computeTimeTicks must be a function');
  assert.equal(typeof T._formatScale, 'function', '_formatScale must be a function');
});

// ---------------------------------------------------------------------------
// A. _secToHHMMSS — kills `% 86400`, `% 3600`, `% 60`, `% 24`, padStart,
//    Math.floor arithmetic mutants.
// ---------------------------------------------------------------------------

test('secToHHMMSS(0) → "00:00:00"', () => {
  // Baseline: 0 seconds should produce zero-padded zeroes. Mutants that
  // flip `% 86400` to `* 86400` or drop padStart go NaN/"0:0:0" here.
  assert.strictEqual(T._secToHHMMSS(0), '00:00:00');
});

test('secToHHMMSS(3599) → "00:59:59"', () => {
  // Just below the hour boundary. Catches off-by-one mutants on the
  // hour division (3599/3600 = 0.999 → floor 0, 3599%3600 = 3599,
  // 3599/60 = 59.98 → floor 59, 3599%60 = 59).
  assert.strictEqual(T._secToHHMMSS(3599), '00:59:59');
});

test('secToHHMMSS(3600) → "01:00:00"', () => {
  // Exactly one hour. Mutants that swap `Math.floor(s / 3600)` to
  // `Math.ceil` or `Math.round` would still pass at 3600, but mutants
  // changing the divisor (e.g. 3600 → 7200) break here.
  assert.strictEqual(T._secToHHMMSS(3600), '01:00:00');
});

test('secToHHMMSS(7322) → "02:02:02"', () => {
  // 2*3600 + 2*60 + 2 = 7322. Every digit-extraction branch matters
  // for this number; any single arithmetic flip yields a different
  // string.
  assert.strictEqual(T._secToHHMMSS(7322), '02:02:02');
});

test('secToHHMMSS(86399) → "23:59:59"', () => {
  // One second before midnight wrap. `s = 86399 % 86400 = 86399`,
  // hh = floor(86399/3600) % 24 = 23, mm = floor((86399%3600)/60) = 59,
  // ss = 86399 % 60 = 59.
  assert.strictEqual(T._secToHHMMSS(86399), '23:59:59');
});

test('secToHHMMSS(86400) → "00:00:00" (midnight wrap)', () => {
  // Exactly 24 hours. The `% 86400` modulo is critical — without it
  // hh would be 24, producing "24:00:00" (the mutant signature).
  assert.strictEqual(T._secToHHMMSS(86400), '00:00:00');
});

test('secToHHMMSS(90000) → "01:00:00" (wraps past midnight)', () => {
  // 25 hours = 86400 + 3600. After the % 86400 wrap, we get 3600 →
  // "01:00:00". Catches mutants that drop the modulo entirely.
  assert.strictEqual(T._secToHHMMSS(90000), '01:00:00');
});

test('secToHHMMSS(45.7) → "00:00:45" (floors fractional)', () => {
  // The leading Math.floor(totalSec) keeps the formatter integer-
  // bounded; without it we'd get "00:00:45.7" or worse. Mutants that
  // flip Math.floor → Math.ceil would yield "00:00:46".
  assert.strictEqual(T._secToHHMMSS(45.7), '00:00:45');
});

// ---------------------------------------------------------------------------
// B. _isoToSecOfDay — kills regex mutants, null-guard mutants, and the
//    parseInt radix mutants.
// ---------------------------------------------------------------------------

test('isoToSecOfDay(null) → null', () => {
  // Front guard `if (!isoStr) return null` — falsy-bypass mutants caught.
  assert.strictEqual(T._isoToSecOfDay(null), null);
});

test('isoToSecOfDay("") → null', () => {
  // Empty string is also falsy → same guard branch.
  assert.strictEqual(T._isoToSecOfDay(''), null);
});

test('isoToSecOfDay("not-an-iso") → null', () => {
  // Regex match fails → return null. Mutants that flip `if (!m)` to
  // `if (m)` would throw on m[1] access.
  assert.strictEqual(T._isoToSecOfDay('not-an-iso'), null);
});

test('isoToSecOfDay("2024-01-15T00:00:00") → 0', () => {
  // Midnight: 0*3600 + 0*60 + 0 = 0.
  assert.strictEqual(T._isoToSecOfDay('2024-01-15T00:00:00'), 0);
});

test('isoToSecOfDay("2024-01-15T01:00:00") → 3600', () => {
  // 1 hour. Catches multiplier mutants (e.g. 3600 → 60).
  assert.strictEqual(T._isoToSecOfDay('2024-01-15T01:00:00'), 3600);
});

test('isoToSecOfDay("2024-01-15T23:59:59") → 86399', () => {
  // 23*3600 + 59*60 + 59 = 86399. Exercises all three regex capture
  // groups against the max-of-day value.
  assert.strictEqual(T._isoToSecOfDay('2024-01-15T23:59:59'), 86399);
});

test('isoToSecOfDay("2024-01-15T12:34:56.789") → 45296 (truncates ms)', () => {
  // The regex `/T(\d{2}):(\d{2}):(\d{2})/` does not capture the .789
  // fractional component — milliseconds are intentionally dropped.
  // 12*3600 + 34*60 + 56 = 45296.
  assert.strictEqual(T._isoToSecOfDay('2024-01-15T12:34:56.789'), 45296);
});

// ---------------------------------------------------------------------------
// C. _computeTimeTicks — kills the niceSteps table boundary mutants and
//    the `target = span / 7` mutants and the `Math.ceil(t0Sec / step)`
//    first-tick math.
// ---------------------------------------------------------------------------

test('computeTimeTicks(0,10) numeric mode → step=1', () => {
  // span=10, target=10/7≈1.428. Largest niceSteps entry ≤ 1.428 is 1.
  // Mutants that flip `s <= target` to `s < target` would still produce 1
  // here (1 < 1.428), but mutants that drop the table entries would not.
  const r = T._computeTimeTicks(0, 10, 'relative', null);
  assert.strictEqual(r.step, 1);
});

test('computeTimeTicks(0,100) numeric → step=10', () => {
  // span=100, target≈14.28, largest ≤ 14.28 in {…,10,30,60} is 10.
  // Catches mutants on the upper-end niceSteps entries.
  const r = T._computeTimeTicks(0, 100, 'relative', null);
  assert.strictEqual(r.step, 10);
});

test('computeTimeTicks(0,0.7) numeric → step=0.05 (float-imprecise target)', () => {
  // ACTUAL CONTRACT: span=0.7, target=0.7/7 = 0.09999999999999999 in
  // IEEE 754 (NOT exactly 0.1). So `0.1 <= target` is FALSE and the
  // loop falls back to step=0.05. This is a real artefact of the
  // implementation, not a bug to fix — pinning it here prevents a
  // future "tighten the table" mutant from sliding to step=0.1 when
  // it shouldn't, and also catches `target = span / 6` mutants
  // (which would give 0.7/6 ≈ 0.117 → step=0.1).
  const r = T._computeTimeTicks(0, 0.7, 'relative', null);
  assert.strictEqual(r.step, 0.05);
});

test('computeTimeTicks(0,0.7000001) numeric → step=0.1 (above-boundary)', () => {
  // Sister case: nudging span slightly above 0.7 brings target above 0.1
  // and pulls step up to 0.1. Pairs with the above test to pin both
  // sides of the floating-point boundary on the niceSteps table.
  const r = T._computeTimeTicks(0, 0.7000001, 'relative', null);
  assert.strictEqual(r.step, 0.1);
});

test('computeTimeTicks(0,0.07) numeric → step=0.01 (smallest in table)', () => {
  // span=0.07, target=0.01. The smallest niceSteps entry. Catches
  // mutants that drop the lowest entry.
  const r = T._computeTimeTicks(0, 0.07, 'relative', null);
  assert.strictEqual(r.step, 0.01);
});

test('computeTimeTicks(5,15) numeric → first tick at 5', () => {
  // span=10, step=1, first = ceil(5/1)*1 = 5. Catches Math.ceil → floor
  // mutants (which would still yield 5, but the next tick would shift).
  const r = T._computeTimeTicks(5, 15, 'relative', null);
  assert.strictEqual(r.ticks[0].t, 5);
});

test('computeTimeTicks(5.5,10.5) → step=0.5, first tick at 5.5', () => {
  // ACTUAL CONTRACT: span=5, target=5/7≈0.714. niceSteps entries
  // ≤ 0.714 are {0.01,0.02,0.05,0.1,0.2,0.5}, so step=0.5 — NOT 1 as
  // the iteration-3 plan initially assumed. first = ceil(5.5/0.5)*0.5
  // = 11*0.5 = 5.5. This test pins the actual behaviour; the plan's
  // expected value (first tick at 6 with step 1) was off because it
  // assumed target = span / 5 instead of span / 7.
  const r = T._computeTimeTicks(5.5, 10.5, 'relative', null);
  assert.strictEqual(r.step, 0.5);
  assert.strictEqual(r.ticks[0].t, 5.5);
});

test('computeTimeTicks numeric mode → useClock=false, labels stringified', () => {
  // time_mode != 'clock' → useClock=false branch. Labels for step>=1
  // are toFixed(0) — plain integer strings.
  const r = T._computeTimeTicks(0, 10, 'relative', null);
  assert.strictEqual(r.useClock, false);
  assert.strictEqual(r.ticks[0].label, '0');
  assert.strictEqual(r.ticks[r.ticks.length - 1].label, '10');
});

test('computeTimeTicks clock mode with valid ISO → useClock=true, HH:MM:SS labels', () => {
  // time_mode='clock' AND recording_start_iso truthy AND parseable →
  // useClock branch taken. startSecOfDay = isoToSecOfDay("…T10:00:00")
  // = 36000. First tick t=0 → label = secToHHMMSS(36000) = "10:00:00".
  const r = T._computeTimeTicks(0, 10, 'clock', '2024-01-15T10:00:00');
  assert.strictEqual(r.useClock, true);
  assert.strictEqual(r.ticks[0].label, '10:00:00');
  // step=1 here, last tick is at t=10 → label = secToHHMMSS(36010)
  // = "10:00:10".
  assert.strictEqual(r.ticks[r.ticks.length - 1].label, '10:00:10');
});

test('computeTimeTicks clock mode with null ISO → useClock=false fallback', () => {
  // time_mode='clock' but recording_start_iso is null → useClock=false
  // (the `&& !!recording_start_iso` short-circuit). Labels revert to
  // numeric. Catches mutants on the && operator.
  const r = T._computeTimeTicks(0, 10, 'clock', null);
  assert.strictEqual(r.useClock, false);
  assert.strictEqual(r.ticks[0].label, '0');
});

test('computeTimeTicks(0,10,step=1) → 11 ticks at t=0..10 inclusive', () => {
  // The loop is `t <= t1Sec + 1e-9` so the endpoint IS included.
  // Mutants that flip <= to < would yield 10 ticks (drop t=10).
  const r = T._computeTimeTicks(0, 10, 'relative', null);
  assert.strictEqual(r.ticks.length, 11);
  assert.strictEqual(r.ticks[0].t, 0);
  assert.strictEqual(r.ticks[10].t, 10);
});

// ---------------------------------------------------------------------------
// D. _formatScale — kills the 1/1000 boundary mutants and the toFixed
//    digit mutants.
// ---------------------------------------------------------------------------

test('formatScale(0.5) → "0.50 µV" (sub-microvolt branch)', () => {
  // microvolts < 1 → toFixed(2). Mutants that flip `< 1` to `< 0` or
  // `<= 1` change which branch fires at the boundary.
  assert.strictEqual(T._formatScale(0.5), '0.50 µV');
});

test('formatScale(50) → "50 µV" (mid-µV branch, rounded)', () => {
  // 1 ≤ 50 < 1000 → Math.round + ' µV'. Mutants flipping the upper
  // bound (1000 → 100) would push 50 into the mV branch incorrectly.
  assert.strictEqual(T._formatScale(50), '50 µV');
});

test('formatScale(999) → "999 µV" (just under mV boundary)', () => {
  // 999 < 1000 → still µV. The < 1000 boundary is critical; any
  // flip to <= 1000 would change behaviour at exactly 1000.
  assert.strictEqual(T._formatScale(999), '999 µV');
});

test('formatScale(1000) → "1.0 mV" (exact mV boundary)', () => {
  // 1000 is NOT < 1000 → falls through to the mV branch:
  // (1000/1000).toFixed(1) = "1.0". Catches the off-by-one boundary
  // mutant explicitly.
  assert.strictEqual(T._formatScale(1000), '1.0 mV');
});

test('formatScale(5500) → "5.5 mV"', () => {
  // 5500/1000 = 5.5, toFixed(1) = "5.5". Catches digit-count mutants
  // (e.g. toFixed(1) → toFixed(0) would produce "6" or "5").
  assert.strictEqual(T._formatScale(5500), '5.5 mV');
});

// D. plotWidthPx-aware step widening (narrow-viewport axis density).
// computeTimeTicks targets a tick COUNT (span/7) and then snaps to a nice
// step, so a narrow plot could end up with labels a couple of dozen pixels
// apart. Passing the plot width lets it widen the step until the labels
// fit. Two invariants matter:
//   1. Omitting the width must reproduce the historical spacing exactly.
//   2. Widening must never strand the axis with fewer than two labels --
//      a failure mode the old rule could not produce, because its step
//      never exceeded span/7.

test('computeTimeTicks without a width matches the historical spacing', () => {

  for (const [t0, t1] of [[0, 4], [0, 10], [5.5, 10.5], [0, 100], [10, 40]]) {
    const bare = T._computeTimeTicks(t0, t1, 'relative', null);
    const wide = T._computeTimeTicks(t0, t1, 'relative', null, Infinity);
    assert.equal(bare.step, wide.step, `step drifted for [${t0},${t1}]`);
    assert.deepEqual(
      bare.ticks.map(t => t.label),
      wide.ticks.map(t => t.label),
      `labels drifted for [${t0},${t1}]`,
    );
  }
});

test('computeTimeTicks widens the step on a narrow plot', () => {

  const wide   = T._computeTimeTicks(0, 4, 'relative', null, 954);   // desktop
  const narrow = T._computeTimeTicks(0, 4, 'relative', null, 224);   // phone
  assert.equal(wide.step, T._computeTimeTicks(0, 4, 'relative', null).step,
    'a wide plot must keep the historical step');
  assert.ok(narrow.step > wide.step,
    `narrow plot should widen the step (got ${narrow.step} vs ${wide.step})`);
  assert.ok(narrow.ticks.length < wide.ticks.length,
    'narrow plot should draw fewer labels');
});

test('computeTimeTicks never widens into fewer than two labels', () => {

  const offsets = [0, 3.7, 10, 55.5, 120, 723];
  for (const w of [1114, 954, 646, 466, 334, 224, 150, 80, 60, 20]) {
    for (const win of [2, 5, 10, 20, 30]) {
      for (const t0 of offsets) {
        const r = T._computeTimeTicks(t0, t0 + win, 'relative', null, w);
        assert.ok(r.ticks.length >= 2,
          `plotWidth=${w} window=${win}s t0=${t0} produced ${r.ticks.length} label(s)`);
      }
    }
  }
});

test('computeTimeTicks step does not change as the window pans', () => {
  // The widening bound must be independent of t0. A t0-dependent test (e.g.
  // counting multiples that land inside [t0,t1]) lets the label density flip
  // between two steps as the user pans a fixed-width window, which reads as
  // the axis flickering. Note t0+win drifts by an ulp for some offsets, so
  // the bound carries an epsilon.
  for (const w of [1114, 954, 646, 466, 334, 224, 150, 80, 60, 20]) {
    for (const win of [2, 5, 10, 20, 30]) {
      const steps = new Set();
      for (const t0 of [0, 1.3, 3.7, 5, 10, 55.5, 120, 723]) {
        steps.add(T._computeTimeTicks(t0, t0 + win, 'relative', null, w).step);
      }
      assert.equal(steps.size, 1,
        `plotWidth=${w} window=${win}s picked steps ${[...steps].join(', ')} depending on pan offset`);
    }
  }
});
