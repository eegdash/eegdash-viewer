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
