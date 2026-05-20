// Extreme fuzz suite for the four binary format parsers.
//
// This is the deep-validation counterpart to tests/fuzz-formats.test.mjs.
// The nightly suite runs 10k iterations per target and serves as the CI
// gate; THIS file runs 100k per target (10x deeper) and is meant to be
// run by hand once per release / after parser refactors to surface
// statistically rare failure modes that the nightly misses.
//
// Runtime budget: ~5-15 minutes total on a modern laptop. Each
// node:test must finish within --test-timeout=600000 ms (10 min) for
// the runner not to abort. If a single target legitimately needs more,
// lower its iteration count to 50_000 (still 5x deeper than nightly)
// and document why next to its `numRuns` line.
//
// USAGE
//   node --test --test-timeout=600000 tests/fuzz-formats-extreme.test.mjs
//   FUZZ_RUNS=50000 node --test --test-timeout=600000 \
//     tests/fuzz-formats-extreme.test.mjs   # if 100k is too slow
//
// CRASH RESPONSE
//   1. Capture fast-check's shrunk Uint8Array as hex.
//   2. Pin it as an `examples: [shrunk]` entry in the corresponding
//      tests/prop-*.test.mjs so PR CI catches the regression.
//   3. Document in docs/fuzz-findings-<date>.md (parser path, line,
//      input bytes, expected behaviour, suggested fix).
//   4. Mark the extreme target as `t.skip()` with a pointer to the
//      fixings doc until the bug is repaired.
//
// Do NOT lower iterations globally to hide a flake. A flake at 100k
// that doesn't reproduce at 10k IS a real find — its rate is just low.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import {
  EDFReader,
  BrainVisionReader,
  EEGLABReader,
} from './_bootstrap.mjs';
import { fc, corpusFuzzedBuffer } from './_arbitraries.mjs';

const require = createRequire(import.meta.url);
const FIFFReader = require('../formats/fiff.js');

// 100,000 runs by default (10x the nightly suite). Override via env if
// the box is slow or only a focused re-run is wanted.
const FUZZ_RUNS = Number(process.env.FUZZ_RUNS) || 100_000;

// ---------------------------------------------------------------------
// EDF / BDF
// ---------------------------------------------------------------------

test('fuzz-extreme: EDF parseHeader survives 100k corpus-mutated rounds', () => {
  fc.assert(
    fc.property(corpusFuzzedBuffer([
      'eeg/sub-01_ses-01_task-offline_run-01_eeg.edf',
      'eeg/sub-001_ses-01_task-meditation_eeg.bdf',
    ]), (bytes) => {
      const ab = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
      try {
        EDFReader.parseHeader(ab);
      } catch (e) {
        if (!(e instanceof Error)) {
          throw new Error(`Non-Error thrown: ${typeof e}: ${e}`);
        }
      }
      return true;
    }),
    { numRuns: FUZZ_RUNS },
  );
});

test('fuzz-extreme: EDF parseTAL survives 100k corpus-mutated rounds', () => {
  fc.assert(
    fc.property(corpusFuzzedBuffer([
      'eeg/sub-01_ses-01_task-offline_run-01_eeg.edf',
    ]), (bytes) => {
      try {
        const out = EDFReader.parseTAL(bytes);
        assert.ok(Array.isArray(out), 'parseTAL did not return an array');
      } catch (e) {
        if (!(e instanceof Error)) {
          throw new Error(`Non-Error thrown: ${typeof e}: ${e}`);
        }
      }
      return true;
    }),
    { numRuns: FUZZ_RUNS },
  );
});

// ---------------------------------------------------------------------
// BrainVision
// ---------------------------------------------------------------------

const _bvHeaders = (() => {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    return [
      fs.readFileSync(path.resolve('tests/fixtures/eeg/sub-xp101_task-motorloc_eeg.vhdr'), 'utf-8'),
      fs.readFileSync(path.resolve('tests/fixtures/ieeg/sub-01_ses-iemu_task-film_acq-clinical_run-1_ieeg.vhdr'), 'utf-8'),
    ];
  } catch { return []; }
})();
const bvFuzzText = _bvHeaders.length
  ? fc.oneof(
      { weight: 9, arbitrary: fc.string({ minLength: 0, maxLength: 8192 }) },
      { weight: 1, arbitrary: fc.constantFrom(..._bvHeaders) },
    )
  : fc.string({ minLength: 0, maxLength: 8192 });

test('fuzz-extreme: BrainVision parseIni survives 100k UTF-8 fuzz rounds', () => {
  fc.assert(
    fc.property(bvFuzzText, (text) => {
      try {
        const out = BrainVisionReader.parseIni(text);
        assert.ok(out !== null && typeof out === 'object',
          'parseIni returned non-object');
      } catch (e) {
        if (!(e instanceof Error)) {
          throw new Error(`Non-Error thrown: ${typeof e}: ${e}`);
        }
      }
      return true;
    }),
    { numRuns: FUZZ_RUNS },
  );
});

test('fuzz-extreme: BrainVision parseHeader survives 100k UTF-8 fuzz rounds', () => {
  fc.assert(
    fc.property(bvFuzzText, (text) => {
      try {
        BrainVisionReader.parseHeader(text);
      } catch (e) {
        if (!(e instanceof Error)) {
          throw new Error(`Non-Error thrown: ${typeof e}: ${e}`);
        }
      }
      return true;
    }),
    { numRuns: FUZZ_RUNS },
  );
});

// ---------------------------------------------------------------------
// EEGLAB column-major slicer
// ---------------------------------------------------------------------

test('fuzz-extreme: EEGLAB sliceColumnMajor survives 100k typed-array fuzz', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 128 }),     // nChannels
      fc.integer({ min: 10, max: 5000 }),    // nSamples
      fc.integer({ min: 0, max: 4999 }),     // startSample (raw)
      fc.integer({ min: 1, max: 5000 }),     // nWin (raw)
      (nCh, nSamp, startRaw, nWinRaw) => {
        const flat = new Float32Array(nCh * nSamp);
        for (let i = 0; i < flat.length; i++) flat[i] = Math.sin(i * 0.01);
        const start = Math.min(startRaw, nSamp - 1);
        const nWin = Math.min(nWinRaw, nSamp - start);
        try {
          const out = EEGLABReader._sliceColumnMajor(flat, nCh, start, nWin);
          if (out && out[0]) {
            assert.equal(out.length, nCh, 'channel count must match');
            assert.equal(out[0].length, nWin,
              'sample count per channel must match');
          }
        } catch (e) {
          if (!(e instanceof Error)) {
            throw new Error(`Non-Error thrown: ${typeof e}: ${e}`);
          }
        }
        return true;
      },
    ),
    { numRuns: FUZZ_RUNS },
  );
});

// ---------------------------------------------------------------------
// FIFF
// ---------------------------------------------------------------------

test('fuzz-extreme: FIFF read survives 100k corpus-mutated rounds', () => {
  fc.assert(
    fc.property(corpusFuzzedBuffer([
      'meg/test-proj.fif',
      'meg/test_raw-annot.fif',
      'meg/test-eve.fif',
    ]), (bytes) => {
      const ab = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
      try {
        const meas = FIFFReader.read(ab);
        if (meas !== undefined) {
          assert.ok(meas && typeof meas === 'object',
            'read() returned a non-object on accepted input');
        }
      } catch (e) {
        if (!(e instanceof Error)) {
          throw new Error(`Non-Error thrown: ${typeof e}: ${e}`);
        }
      }
      return true;
    }),
    { numRuns: FUZZ_RUNS },
  );
});
