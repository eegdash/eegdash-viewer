// unit-traces-nice-round.test.mjs
//
// Boundary-case tests for the niceRound() helper inside traces.js.
//
// niceRound is normally module-private (it lives inside the IIFE that
// wraps the renderer). It was exposed as api._niceRound specifically so
// this file can pin its contract without driving it through the full
// draw() pipeline. The mutation that motivated the export was #131 at
// traces.js:199 — `if (v <= 0) return 1;` → `if (v < 0) return 1;`,
// which only differs at v === 0 (the mutant returns NaN there because
// Math.log10(0) = -Infinity and 0 * Math.pow(10, -Infinity) = NaN).
//
// We also cover the 1/2/5×10^N partitioning boundaries (1.5, 3.5, 7.5)
// and the human-scale µV values the scale bar will actually feed it.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
globalThis.ResizeObserver = globalThis.ResizeObserver || class {
  observe() {} unobserve() {} disconnect() {}
};

const TraceRenderer = require('../traces.js');
const niceRound = TraceRenderer._niceRound;

test('niceRound is exported on the api surface', () => {
  // Sanity: catches any future refactor that quietly drops the export
  // and brings mutant 131 back to life.
  assert.equal(typeof niceRound, 'function', '_niceRound must be a function');
});

test('niceRound(0) returns 1 (the v<=0 guard)', () => {
  // Mutation 131 guard: `v <= 0` vs `v < 0`. At v=0 the mutant falls
  // through and returns niceF * Math.pow(10, exp) where exp =
  // Math.floor(Math.log10(0)) = -Infinity, so the result is NaN.
  // The original returns the literal 1.
  const r = niceRound(0);
  assert.equal(r, 1, `niceRound(0) must be 1, got ${r}`);
  assert.ok(!Number.isNaN(r), 'niceRound(0) must not be NaN');
});

test('niceRound(-5) returns 1 (negative guard)', () => {
  // Both the original and the mutant return 1 here, but we still pin
  // the contract — a future "tighten the guard" refactor that removed
  // the negative branch would be caught.
  assert.equal(niceRound(-5), 1);
});

test('niceRound(1) returns 1 (lowest 1/2/5 bucket at f<1.5)', () => {
  assert.equal(niceRound(1), 1);
});

test('niceRound(1.5) returns 2 (boundary between 1 and 2 buckets)', () => {
  // f = 1.5 falls into the `f < 3.5 ? 2` branch — round up to 2.
  // Mutation cluster around the ternary boundaries lives here.
  assert.equal(niceRound(1.5), 2);
});

test('niceRound(3.5) returns 5 (boundary between 2 and 5 buckets)', () => {
  // At exactly f = 3.5 the condition `f < 3.5` is false, so we take
  // the `f < 7.5 ? 5` branch.
  assert.equal(niceRound(3.5), 5);
});

test('niceRound(7.5) returns 10 (boundary between 5 and 10 buckets)', () => {
  // At exactly f = 7.5 the condition `f < 7.5` is false, so we take
  // the `: 10` branch.
  assert.equal(niceRound(7.5), 10);
});

test('niceRound(50) returns 50 (no rounding needed for a clean value)', () => {
  // f = 5.0 → falls into `f < 7.5 ? 5` → 5 * 10^1 = 50.
  assert.equal(niceRound(50), 50);
});

test('niceRound(173) returns 200 (real-world EEG µV example)', () => {
  // From the docstring above niceRound: "human-friendly (50/100/200/500
  // µV, never 173 µV)". 173 → f=1.73 → `f < 3.5 ? 2` → 2 * 100 = 200.
  assert.equal(niceRound(173), 200);
});

test('niceRound(0.005) returns 0.005 (sub-unit precision)', () => {
  // f = 5.0 (since 0.005 / 10^-3 = 5.0) → `f < 7.5 ? 5` → 5 * 10^-3.
  // Uses approxEqual for float safety.
  const r = niceRound(0.005);
  assert.ok(Math.abs(r - 0.005) < 1e-9, `niceRound(0.005) ≈ 0.005, got ${r}`);
});

test('niceRound preserves the 1/2/5 invariant across scales', () => {
  // Property: every output's mantissa (output / 10^floor(log10(output)))
  // must be exactly 1, 2, 5, or (the next decade's) 1.  niceRound is
  // a nearest-1/2/5 snap, NOT a strict ceiling — values just above the
  // threshold (e.g. 3.0 → 2, since f=3.0 < 3.5) snap down. We assert
  // shape, not direction.
  const samples = [0.3, 0.7, 1.2, 2.4, 4.1, 8.6, 12, 47, 99, 250, 720, 1500, 4800];
  for (const v of samples) {
    const r = niceRound(v);
    assert.ok(r > 0 && Number.isFinite(r), `niceRound(${v}) must be positive finite, got ${r}`);
    const exp = Math.floor(Math.log10(r));
    const mantissa = Math.round(r / Math.pow(10, exp));
    assert.ok(
      mantissa === 1 || mantissa === 2 || mantissa === 5,
      `niceRound(${v}) = ${r} has mantissa ${mantissa}, not in {1,2,5}`,
    );
  }
});
