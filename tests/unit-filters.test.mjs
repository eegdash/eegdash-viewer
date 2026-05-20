/**
 * tests/unit-filters.test.mjs — Numerical unit tests for filters.js (F08).
 *
 * Four test cases:
 *   1. HP coefficients match RBJ formula (assert b, a to 1e-9).
 *   2. LP roundtrip — lowpass on (1 + α·sin(2π·100·t)) attenuates
 *      the 100 Hz component by ≥ 30 dB.
 *   3. Notch — pure 60 Hz sinusoid through notch 60 Hz → RMS ≥ 20 dB down.
 *   4. filtfilt zero-phase — Gaussian pulse peak position survives HP
 *      filter to ±1 sample.
 *
 * Oracle approach: the expected_output values in tests/oracle/filter-cases.json
 * were computed with the SAME filters.js implementation (regression approach).
 * The coefficient formulas were independently verified against the RBJ Audio
 * EQ Cookbook (§ "HPF"/"LPF"/"Notch filter") by hand.  Tolerance is 1e-6
 * (float64 arithmetic gives sub-1e-14 round-trip error on 1024-sample signals
 * so any discrepancy > 1e-6 would indicate a formula change).
 *
 * Run:  node --test tests/unit-filters.test.mjs
 * Expected: # pass 4
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

// Load filters.js as a CommonJS IIFE module using createRequire.
const require = createRequire(import.meta.url);
const Filters = require('../filters.js');

const ORACLE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'oracle/filter-cases.json',
);
const oracle = JSON.parse(readFileSync(ORACLE_PATH, 'utf8'));

// ---- helpers ------------------------------------------------

function rmsOf(arr, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += arr[i] * arr[i];
  return Math.sqrt(sum / (end - start));
}

function maxAbsDiff(a, b) {
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
  }
  return max;
}

// ---- Test 1: HP coefficient formula -------------------------

test('HP 1 Hz at 250 Hz: coefficients match RBJ formula to 1e-9', () => {
  // Hand-derived from RBJ Audio EQ Cookbook "HPF":
  //   w0    = 2π × 1 / 250
  //   alpha = sin(w0) / (2 × (1/√2))    [Q = 1/√2 for Butterworth]
  //   a0    = 1 + alpha
  //   b0 = b2 = (1 + cos(w0)) / 2 / a0
  //   b1      = -(1 + cos(w0)) / a0
  //   a1      = -2 cos(w0) / a0
  //   a2      = (1 − alpha) / a0

  const fs = 250, f0 = 1;
  const w0    = 2 * Math.PI * f0 / fs;
  const cosw0 = Math.cos(w0);
  const Q     = Math.SQRT1_2;          // 1/√2
  const alpha = Math.sin(w0) / (2 * Q);
  const a0    = 1 + alpha;

  const expected = {
    b: [
      (1 + cosw0) / 2 / a0,
      -(1 + cosw0)      / a0,
      (1 + cosw0) / 2 / a0,
    ],
    a: [1, -2 * cosw0 / a0, (1 - alpha) / a0],
  };

  const got = Filters.designHighpass(fs, f0);

  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(got.b[i] - expected.b[i]) < 1e-9,
      `b[${i}] differs: got ${got.b[i]}, expected ${expected.b[i]}`,
    );
  }
  for (let i = 1; i < 3; i++) {
    assert.ok(
      Math.abs(got.a[i] - expected.a[i]) < 1e-9,
      `a[${i}] differs: got ${got.a[i]}, expected ${expected.a[i]}`,
    );
  }
});

// ---- Test 2: LP roundtrip — 100 Hz attenuation ≥ 30 dB -----

test('LP 45 Hz at 250 Hz: 100 Hz component attenuated by ≥ 30 dB', () => {
  const fs = 250, n = 2048;
  // Signal: DC + α·sin(2π·100·t) with α = 1
  const alpha = 1;
  const signal = new Float64Array(n).map(
    (_, i) => 1 + alpha * Math.sin(2 * Math.PI * 100 * i / fs),
  );

  const coefs = Filters.designLowpass(fs, 45);
  const out   = Filters.filtfilt(signal, coefs);

  // Skip the first and last 256 samples to avoid edge artefacts.
  const guard = 256;
  // RMS of the 100 Hz component in the input (after subtracting DC 1).
  // The pure sinusoid has RMS = α/√2.
  const rmsIn = alpha / Math.SQRT2;

  // Extract the 100 Hz component from the output by subtracting the
  // mean (DC pass-through).
  const mean = out.slice(guard, n - guard).reduce((s, v) => s + v, 0) / (n - 2 * guard);
  let rmsOut = 0;
  for (let i = guard; i < n - guard; i++) {
    const v = out[i] - mean;
    rmsOut += v * v;
  }
  rmsOut = Math.sqrt(rmsOut / (n - 2 * guard));

  const dB = 20 * Math.log10(rmsOut / rmsIn);
  assert.ok(dB <= -30, `100 Hz not attenuated by ≥ 30 dB; got ${dB.toFixed(2)} dB`);
});

// ---- Test 3: Notch 60 Hz — RMS reduced by ≥ 20 dB ----------

test('Notch 60 Hz at 250 Hz: pure 60 Hz sinusoid RMS reduced by ≥ 20 dB', () => {
  const fs = 250, n = 1024;
  const sine60 = new Float64Array(n).map(
    (_, i) => Math.sin(2 * Math.PI * 60 * i / fs),
  );

  const coefs = Filters.designNotch(fs, 60, 30);
  const out   = Filters.filtfilt(sine60, coefs);

  // Measure on the middle 512 samples to avoid transient edges.
  const rmsBefore = rmsOf(sine60, 256, 768);
  const rmsAfter  = rmsOf(out,    256, 768);
  const dB = 20 * Math.log10(rmsAfter / rmsBefore);

  assert.ok(dB <= -20, `Notch 60 Hz: RMS not reduced by ≥ 20 dB; got ${dB.toFixed(2)} dB`);
});

// ---- Test 4: filtfilt zero-phase — peak position ±1 sample --

test('filtfilt zero-phase: Gaussian pulse peak position preserved to ±1 sample', () => {
  // Oracle approach — the expected output lives in filter-cases.json.
  const c4 = oracle[3];
  assert.ok(c4, 'oracle case 4 missing');

  const input    = new Float64Array(c4.input);
  const expected = new Float64Array(c4.expected_output);
  const coefs    = c4.coefs;
  const centre   = c4.peak_centre_idx;   // 512

  const got = Filters.filtfilt(input, coefs);

  // Oracle regression: max abs diff must be < 1e-6.
  const diff = maxAbsDiff(got, expected);
  assert.ok(
    diff < 1e-6,
    `filtfilt output deviates from oracle by ${diff}; expected < 1e-6`,
  );

  // Peak should remain at or within ±1 sample of centre.
  let maxVal = -Infinity, maxIdx = 0;
  for (let i = 0; i < got.length; i++) {
    if (Math.abs(got[i]) > maxVal) { maxVal = Math.abs(got[i]); maxIdx = i; }
  }
  assert.ok(
    Math.abs(maxIdx - centre) <= 1,
    `Pulse peak moved to sample ${maxIdx} (centre = ${centre}), expected within ±1`,
  );
});

// ============================================================
// Iteration 9 (PR 15): coefficient-formula & loop-bound mutants
// ============================================================
// The pre-iter-9 unit suite only verified designHighpass coefficients
// to 1e-9. designLowpass / designNotch were exercised only through
// magnitude-attenuation tests, which tolerate small coefficient drift —
// so Stryker reported 15 surviving ArithmeticOperator mutants on
// w0/alpha/a0/b0 lines and 6 surviving EqualityOperator + 1 surviving
// q-default mutant. The tests below pin every coefficient to the
// hand-derived RBJ formula at 1e-9 tolerance for LP+Notch, exercise
// the default-Q path, and assert numerical-output finiteness so
// loop-bound mutations (`i < n` → `i <= n`) get caught by reading
// out-of-range `undefined → NaN`.

// ---- LP coefficient formula (was untested) ------------------

test('iter9: LP 45 Hz at 250 Hz: coefficients match RBJ LPF formula to 1e-9', () => {
  // Hand-derived from RBJ Audio EQ Cookbook "LPF":
  //   w0    = 2π × 45 / 250
  //   alpha = sin(w0) / (2 × (1/√2))    [Q = 1/√2 for Butterworth]
  //   a0    = 1 + alpha
  //   b0 = b2 = (1 − cos(w0)) / 2 / a0
  //   b1      = (1 − cos(w0)) / a0
  //   a1      = −2 cos(w0) / a0
  //   a2      = (1 − alpha) / a0

  const fs = 250, f0 = 45;
  const w0    = 2 * Math.PI * f0 / fs;
  const cosw0 = Math.cos(w0);
  const Q     = Math.SQRT1_2;
  const alpha = Math.sin(w0) / (2 * Q);
  const a0    = 1 + alpha;

  const expected = {
    b: [
      (1 - cosw0) / 2 / a0,
      (1 - cosw0)      / a0,
      (1 - cosw0) / 2 / a0,
    ],
    a: [1, -2 * cosw0 / a0, (1 - alpha) / a0],
  };

  const got = Filters.designLowpass(fs, f0);

  // Compare every coefficient. The (1-cosw0) numerator distinguishes LP
  // from HP (which is (1+cosw0)) and the symmetry b0===b2 plus the
  // exact value of b1 catches ArithmeticOperator mutations on lines 58
  // and 60 (e.g. `*` ↔ `/`, `+` ↔ `-`, `(1+cosw0)` instead of `(1-cosw0)`).
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(got.b[i] - expected.b[i]) < 1e-9,
      `LP b[${i}] differs: got ${got.b[i]}, expected ${expected.b[i]}`,
    );
  }
  for (let i = 1; i < 3; i++) {
    assert.ok(
      Math.abs(got.a[i] - expected.a[i]) < 1e-9,
      `LP a[${i}] differs: got ${got.a[i]}, expected ${expected.a[i]}`,
    );
  }
  assert.equal(got.a[0], 1, 'a[0] must be normalised to 1');
});

// ---- LP coefficient formula at a second (fs, f0) ------------

test('iter9: LP 20 Hz at 500 Hz: coefficient w0 uses *cutoff/fs (not /cutoff or *fs)', () => {
  // Two-point test: mutants `cutoff_hz / fs` → `cutoff_hz * fs` or
  // `2 * Math.PI / cutoff_hz` change w0 by >2 orders of magnitude.
  // At fs=500 / f0=20 the correct w0 is 0.2513… ; the mutated forms
  // would give w0 ≈ 6283 (cutoff*fs) or w0 ≈ 0.314 (PI/cutoff) — both
  // would change every cos/sin and yield very different coefficients.
  const fs = 500, f0 = 20;
  const w0    = 2 * Math.PI * f0 / fs;       // 0.251327...
  const cosw0 = Math.cos(w0);                 // 0.968583...
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0    = 1 + alpha;

  const got = Filters.designLowpass(fs, f0);
  // Pin b[0] to 8 decimals — the mutated formulas would land >1e-3 away.
  const expected_b0 = (1 - cosw0) / 2 / a0;
  assert.ok(
    Math.abs(got.b[0] - expected_b0) < 1e-9,
    `w0-formula mutation: got b[0]=${got.b[0]}, expected ${expected_b0}`,
  );
  // Spot-check a numerically large coefficient: a[1] is -2*cos(w0)/a0
  // ≈ -1.5611 at this design — far from any plausible mutated value.
  const expected_a1 = -2 * cosw0 / a0;
  assert.ok(
    Math.abs(got.a[1] - expected_a1) < 1e-9,
    `a[1] mutation: got ${got.a[1]}, expected ${expected_a1}`,
  );
});

// ---- HP coefficient formula at a second (fs, f0) ------------

test('iter9: HP 0.5 Hz at 1000 Hz: coefficient sign-correct (1+cosw0, not 1-cosw0)', () => {
  // Existing unit test only verifies HP at (250, 1). A second design
  // point with different fs distinguishes "*fs" vs "/fs" mutants on
  // line 32 and pins the (1+cosw0) numerator (vs LP's (1-cosw0)).
  const fs = 1000, f0 = 0.5;
  const w0    = 2 * Math.PI * f0 / fs;        // 0.003141...
  const cosw0 = Math.cos(w0);                 // ≈ 0.9999951
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0    = 1 + alpha;
  const expected_b0 = (1 + cosw0) / 2 / a0;   // very close to 1

  const got = Filters.designHighpass(fs, f0);
  assert.ok(
    Math.abs(got.b[0] - expected_b0) < 1e-9,
    `HP at (1000, 0.5): b[0] = ${got.b[0]}, expected ${expected_b0}`,
  );
  // b[1] = -(1+cosw0)/a0 — sign matters: an ArithmeticOperator mutant
  // changing `-(1+cosw0)` to `+(1+cosw0)` would flip the sign.
  assert.ok(got.b[1] < 0, `HP b[1] must be negative; got ${got.b[1]}`);
  assert.ok(
    Math.abs(got.b[1] - (-(1 + cosw0) / a0)) < 1e-9,
    `HP b[1] differs: got ${got.b[1]}, expected ${-(1+cosw0)/a0}`,
  );
});

// ---- Notch coefficient formula (was untested) ----------------

test('iter9: Notch 60 Hz Q=30 at 250 Hz: coefficients match RBJ Notch formula to 1e-9', () => {
  // RBJ "notching EQ":
  //   w0    = 2π × 60 / 250
  //   alpha = sin(w0) / (2 × Q)
  //   a0    = 1 + alpha
  //   b0 = b2 = 1 / a0
  //   b1      = −2 cos(w0) / a0
  //   a1      = −2 cos(w0) / a0
  //   a2      = (1 − alpha) / a0

  const fs = 250, freq = 60, Q = 30;
  const w0    = 2 * Math.PI * freq / fs;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  const a0    = 1 + alpha;

  const expected = {
    b: [1 / a0, -2 * cosw0 / a0, 1 / a0],
    a: [1, -2 * cosw0 / a0, (1 - alpha) / a0],
  };
  const got = Filters.designNotch(fs, freq, Q);

  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(got.b[i] - expected.b[i]) < 1e-9,
      `Notch b[${i}] differs: got ${got.b[i]}, expected ${expected.b[i]}`,
    );
  }
  for (let i = 1; i < 3; i++) {
    assert.ok(
      Math.abs(got.a[i] - expected.a[i]) < 1e-9,
      `Notch a[${i}] differs: got ${got.a[i]}, expected ${expected.a[i]}`,
    );
  }
  // b[0] === b[2] is structural — kills MethodExpression / array
  // mutations that would swap entries.
  assert.equal(got.b[0], got.b[2], 'Notch b[0] must equal b[2]');
});

// ---- Notch: default Q (no arg) → Q=30 ------------------------

test('iter9: Notch default Q (no arg) → Q=30 (kills q==null mutants)', () => {
  // Existing tests always pass Q=30 explicitly. The default-Q branch
  // (`Q = (q != null) ? q : 30`) is never exercised, so ConditionalExpression
  // mutants on line 75 (`q != null` → `true` / `false`) and the
  // EqualityOperator mutant (`q != null` → `q == null`) all survive.
  //
  // Strategy: call designNotch(fs, freq) with NO third arg and verify
  // the returned coefficients equal those for Q=30 exactly. If the
  // default were Q=undefined (true branch) or Q=q (false branch),
  // `alpha = sin(w0) / (2*Q)` would produce NaN/Infinity, not the
  // Q=30 coefficient.
  const fs = 250, freq = 60;
  const explicit = Filters.designNotch(fs, freq, 30);
  const defaulted = Filters.designNotch(fs, freq);  // no q arg

  for (let i = 0; i < 3; i++) {
    assert.equal(defaulted.b[i], explicit.b[i],
      `default Q: b[${i}] differs from Q=30 explicit`);
    assert.equal(defaulted.a[i], explicit.a[i],
      `default Q: a[${i}] differs from Q=30 explicit`);
  }
  // Sanity: every coefficient must be finite (kills "true" → Q=undefined
  // which yields NaN).
  for (const v of defaulted.b) assert.ok(Number.isFinite(v), 'b coefficient must be finite');
  for (const v of defaulted.a) assert.ok(Number.isFinite(v), 'a coefficient must be finite');
});

test('iter9: Notch null Q → Q=30 (kills q==null === flip)', () => {
  // The check is `q != null` — explicit `null` should trigger the
  // default. EqualityOperator mutation `!=` → `==` would swap the
  // branches.
  const fs = 250, freq = 60;
  const explicit = Filters.designNotch(fs, freq, 30);
  const passedNull = Filters.designNotch(fs, freq, null);
  for (let i = 0; i < 3; i++) {
    assert.equal(passedNull.b[i], explicit.b[i],
      `q=null: b[${i}] should equal Q=30 explicit`);
  }
});

// ---- Notch Q variation: higher Q → narrower notch -----------

test('iter9: Notch Q=100 yields different alpha than Q=30 (kills 2/Q mutant)', () => {
  // ArithmeticOperator mutant `2 * Q` → `2 / Q` on line 78 makes alpha
  // depend on Q the wrong way. With Q=100 the correct alpha is much
  // smaller than with Q=30, so the (1-alpha) term in a[2] should be
  // closer to 1.
  const fs = 250, freq = 60;
  const lowQ  = Filters.designNotch(fs, freq, 30);
  const highQ = Filters.designNotch(fs, freq, 100);

  // a[2] = (1-alpha)/a0. With higher Q, alpha shrinks and a[2] grows
  // (closer to 1). If the mutant changed `2*Q` to `2/Q`, increasing Q
  // would shrink (2/Q) and grow alpha — reversing the relationship.
  assert.ok(
    highQ.a[2] > lowQ.a[2],
    `Q=100 should give larger a[2] than Q=30; got ${highQ.a[2]} vs ${lowQ.a[2]}`,
  );
  // Exact hand-derived value for Q=100:
  const w0    = 2 * Math.PI * freq / fs;
  const alpha = Math.sin(w0) / (2 * 100);
  const a0    = 1 + alpha;
  const expected_a2 = (1 - alpha) / a0;
  assert.ok(
    Math.abs(highQ.a[2] - expected_a2) < 1e-9,
    `Q=100 a[2] formula: got ${highQ.a[2]}, expected ${expected_a2}`,
  );
});

// ---- apply: loop covers exactly [0, n) — out-of-bound reads are NaN ----

test('iter9: apply produces N finite samples (kills loop-bound `i <= n` mutant)', () => {
  // Mutant on line 103: `i < n` → `i <= n` reads samples[n] which is
  // `undefined`. `undefined - a[1]*w1` is NaN, so the last sample of
  // output would be NaN. Filtfilt then doubles the contamination.
  const fs = 250, n = 1024;
  const signal = new Float64Array(n).map((_, i) => Math.sin(2*Math.PI*5*i/fs));
  const coefs = Filters.designHighpass(fs, 1);
  const out = Filters.filtfilt(signal, coefs);

  assert.equal(out.length, n, `output length must equal input length (${n})`);
  // Every sample must be a finite number — this is the load-bearing
  // assertion that kills the loop-bound mutants on apply (line 103),
  // filtfilt forward-reverse (line 127), and filtfilt back-reverse
  // (line 131). Each off-by-one read introduces an `undefined` that
  // propagates as NaN through the rest of the pipeline.
  let nanCount = 0;
  for (let i = 0; i < out.length; i++) {
    if (!Number.isFinite(out[i])) nanCount++;
  }
  assert.equal(nanCount, 0,
    `all ${n} output samples must be finite; found ${nanCount} NaN/Infinity`);
});

test('iter9: filtfilt reversal preserves index 0 and N-1 (kills reverse-loop mutants)', () => {
  // The reverse loops in filtfilt are: `for (let i = 0; i < fwd.length; i++)
  // rev[i] = fwd[fwd.length - 1 - i]`. An EqualityOperator mutant
  // `i < fwd.length` → `i <= fwd.length` reads index -1 which yields
  // `undefined`, giving NaN at rev[N]. Both reverse loops have the same
  // shape. Below we feed a known signal and assert that the OUTPUT
  // first/last samples are still close to their forward-reverse
  // expected magnitude (not NaN, not zero — a proxy for the loop
  // covering exactly [0, N)).
  const n = 256;
  const signal = new Float64Array(n);
  // A short pulse near the middle so edge artefacts are small.
  for (let i = 100; i < 156; i++) signal[i] = 1.0;
  const coefs = Filters.designLowpass(250, 50);
  const out = Filters.filtfilt(signal, coefs);

  assert.equal(out.length, n);
  // First and last samples must be finite (would be NaN under the
  // off-by-one mutant).
  assert.ok(Number.isFinite(out[0]), `out[0] should be finite; got ${out[0]}`);
  assert.ok(Number.isFinite(out[n-1]), `out[n-1] should be finite; got ${out[n-1]}`);
  // For a centered pulse with LP filtering, the peak should be in the
  // middle of the array, NOT at the boundary. If the reverse-loop is
  // miswired, the response would be reflected and the peak shifts.
  let peakIdx = 0, peakVal = -Infinity;
  for (let i = 0; i < n; i++) {
    if (out[i] > peakVal) { peakVal = out[i]; peakIdx = i; }
  }
  assert.ok(peakIdx > 100 && peakIdx < 156,
    `LP pulse peak should be in [100, 156); got ${peakIdx} (val=${peakVal})`);
});

// ---- applyChain: empty/null guards --------------------------

test('iter9: applyChain returns samples unchanged when coefsList is empty', () => {
  // Mutants on line 144 (`if (!coefsList || coefsList.length === 0)`):
  //   - ConditionalExpression `true`/`false` → always-return or never-return
  //   - LogicalOperator `||` → `&&` (would crash on null since both must hold)
  //   - EqualityOperator `=== 0` → `!== 0` (would return samples for ANY chain)
  const samples = new Float32Array([1, 2, 3, 4, 5]);
  const out = Filters.applyChain(samples, []);
  // Empty chain: must return the SAME reference (not a copy) — that's
  // the only observable signature of the early-return path.
  assert.strictEqual(out, samples,
    'applyChain([]) should return the SAME samples reference (early-return path)');
});

test('iter9: applyChain returns samples unchanged when coefsList is null', () => {
  const samples = new Float32Array([1, 2, 3, 4, 5]);
  const out = Filters.applyChain(samples, null);
  assert.strictEqual(out, samples,
    'applyChain(samples, null) should return the SAME samples reference');
});

test('iter9: applyChain with one stage applies it (kills early-return-always mutant)', () => {
  // Kills `if (!coefsList || …)` → `true` mutant which would short-circuit
  // and return samples unchanged regardless of chain contents.
  const n = 256;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = Math.sin(2 * Math.PI * 60 * i / 250);

  const notchCoefs = Filters.designNotch(250, 60, 30);
  const out = Filters.applyChain(samples, [notchCoefs]);

  // Output must be a Float32Array (kills `Float32Array.from(buf)` mutation
  // that would leave it as Float64Array).
  assert.ok(out instanceof Float32Array,
    `applyChain must return Float32Array; got ${out.constructor.name}`);
  assert.equal(out.length, n, 'applyChain output length must match input');

  // The notch should have substantially reduced the 60 Hz energy. If the
  // early-return mutant fires, `out === samples` and RMS would be
  // unchanged (1/√2 ≈ 0.707). With notch applied, RMS should be much
  // smaller on the middle window.
  let rmsIn = 0, rmsOut = 0;
  for (let i = 64; i < n - 64; i++) {
    rmsIn  += samples[i] * samples[i];
    rmsOut += out[i] * out[i];
  }
  rmsIn  = Math.sqrt(rmsIn  / (n - 128));
  rmsOut = Math.sqrt(rmsOut / (n - 128));
  const dB = 20 * Math.log10(rmsOut / rmsIn);
  assert.ok(dB < -15,
    `applyChain([notch]) should attenuate 60 Hz by >15 dB; got ${dB.toFixed(2)} dB`);
});

test('iter9: applyChain with two stages applies BOTH (kills BlockStatement loop-body mutant)', () => {
  // Mutant on line 146: `for (const coefs of coefsList) { buf = filtfilt(buf, coefs) }`
  // → block replaced with `{}`, so no stages are actually applied. The
  // test below puts a HP that removes DC and a notch that removes 60 Hz,
  // then checks BOTH removal markers — only an unblocked loop body
  // can satisfy both.
  const fs = 250, n = 1024;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    samples[i] = 1.5 + Math.sin(2 * Math.PI * 60 * i / fs);  // DC=1.5 + 60Hz
  }
  const chain = [
    Filters.designHighpass(fs, 1),   // kills DC
    Filters.designNotch(fs, 60, 30), // kills 60Hz
  ];
  const out = Filters.applyChain(samples, chain);

  // Middle window stats:
  const guard = 256;
  let mean = 0;
  for (let i = guard; i < n - guard; i++) mean += out[i];
  mean /= (n - 2 * guard);
  let rms60 = 0;
  for (let i = guard; i < n - guard; i++) {
    const v = out[i] - mean;
    rms60 += v * v;
  }
  rms60 = Math.sqrt(rms60 / (n - 2 * guard));

  // If the loop body is mutated to `{}`, samples pass through unchanged:
  // mean ≈ 1.5 (DC), rms60 ≈ 0.707.  After both stages: mean ≪ 0.1, rms60 ≪ 0.1.
  assert.ok(Math.abs(mean) < 0.1,
    `HP stage must remove DC; got mean=${mean.toFixed(3)} (untouched would be ≈1.5)`);
  assert.ok(rms60 < 0.1,
    `Notch stage must remove 60Hz; got rms=${rms60.toFixed(3)} (untouched would be ≈0.707)`);
});

test('iter9: apply does not mutate the input array', () => {
  // Pure-function contract: the docstring says "samples unchanged".
  // Defends against any future loop-body mutant that writes back to
  // samples instead of out.
  const input = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
  const snapshot = Array.from(input);
  const coefs = Filters.designLowpass(250, 50);
  Filters.filtfilt(input, coefs);
  assert.deepEqual(Array.from(input), snapshot,
    'filtfilt must not mutate the input array');
});

// ============================================================
// End iteration 9 additions
// ============================================================
