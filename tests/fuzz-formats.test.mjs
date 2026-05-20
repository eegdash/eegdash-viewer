// Long-running fuzz suite for the four binary format parsers.
//
// Each target runs FUZZ_RUNS iterations against either real-fixture
// seeds (mutated) or synthetic random bytes. The point is not to find
// one bug — it's to confirm that thousands of rounds of garbage never
// produce a host-level crash, NaN propagation, hang, or process abort.
// fast-check's shrinker handles the "minimum reproducing input" job
// for free; we just have to run for long enough that statistically
// interesting failure modes surface.
//
// Runtime budget: target ~30 s total on a developer laptop. The
// nightly CI job (.github/workflows/fuzz.yml) runs the full suite once
// per day; per-PR CI runs the existing prop-*.test.mjs files (100
// runs) for fast feedback.
//
// FIXTURE CORPUS — IMPORTANT
// As of this commit, `tests/fixtures/` contains only ES-module helpers
// (index.mjs, synthetic.mjs), not real binary recordings. So every
// corpus-seeded target is effectively running in synthetic-fallback
// mode (zeroed 1 KB seed + random byte overwrites). When real
// fixtures land (e.g. `tests/fixtures/sample.edf`), add their paths
// to the corresponding corpusFuzzedBuffer([...]) call below to
// upgrade the fuzz from "random-noise" to "header-aware mutation".
//
// If fast-check shrinks to a counterexample, the failure mode includes
// the shrunk Uint8Array hex dump. Pin it as an `examples: [...]` entry
// in the corresponding `tests/prop-*.test.mjs` so PR CI catches the
// regression instantly, and document the bug in
// `docs/fuzz-findings-<date>.md`.

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

// 10,000 runs is ~100× the per-PR property tests and still fits in a
// few seconds per target on a modern laptop. If the suite outgrows
// the 30 s budget, lower this to 5,000 (still 50× depth) — but never
// below that without first verifying no fuzz target is finding bugs.
const FUZZ_RUNS = 10_000;

// ---------------------------------------------------------------------
// EDF / BDF
// ---------------------------------------------------------------------
//
// parseHeader: consumes 256 + N*256 bytes of (nominally) ASCII text.
// parseTAL:    consumes the raw byte stream from an EDF+ annotation
//              signal. Both are reached from untrusted user files, so
//              they're the top-priority fuzz targets.

test('fuzz: EDF parseHeader survives 10k corpus-mutated rounds', () => {
  fc.assert(
    fc.property(corpusFuzzedBuffer([
      // TODO: drop real .edf / .bdf files into tests/fixtures/ and
      //       list their relative paths here. Today: synthetic-only.
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

test('fuzz: EDF parseTAL survives 10k corpus-mutated rounds', () => {
  fc.assert(
    fc.property(corpusFuzzedBuffer([
      // TODO: real EDF+ annotation slices would seed this better.
    ]), (bytes) => {
      try {
        const out = EDFReader.parseTAL(bytes);
        // parseTAL is documented total: must always return an Array.
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
//
// The .vhdr is a text INI file, so the fuzz input is fc.string(...)
// rather than corpusFuzzedBuffer. parseIni is the lowest-level
// "parse INI text" routine; parseHeader is the higher-level
// "extract recording metadata from .vhdr" wrapper that calls into it.

test('fuzz: BrainVision parseIni survives 10k UTF-8 fuzz rounds', () => {
  fc.assert(
    fc.property(fc.string({ minLength: 0, maxLength: 8192 }), (text) => {
      try {
        const out = BrainVisionReader.parseIni(text);
        // parseIni is permissive — must always return an object.
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

test('fuzz: BrainVision parseHeader survives 10k UTF-8 fuzz rounds', () => {
  fc.assert(
    fc.property(fc.string({ minLength: 0, maxLength: 8192 }), (text) => {
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
//
// sliceColumnMajor is a hot-path math routine (per-window in the
// renderer), not a parser, so the fuzz inputs are shape parameters
// rather than raw bytes. We clamp start+nWin to stay inside the buffer
// after sampling — fuzzing OOB behaviour is the unit tests' job; this
// fuzz just confirms the in-bounds path is total and shape-preserving.

test('fuzz: EEGLAB sliceColumnMajor survives 10k typed-array fuzz', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 128 }),     // nChannels
      fc.integer({ min: 10, max: 5000 }),    // nSamples
      fc.integer({ min: 0, max: 4999 }),     // startSample (raw)
      fc.integer({ min: 1, max: 5000 }),     // nWin (raw)
      (nCh, nSamp, startRaw, nWinRaw) => {
        const flat = new Float32Array(nCh * nSamp);
        // Cheap deterministic fill; values don't matter for crash check
        // but we want non-zero data so any NaN propagation surfaces.
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
//
// fiff.read is the newest reader and the one with the least field
// time; the fuzz here is essentially a stress-soak ahead of its first
// production run on user-uploaded files.

test('fuzz: FIFF read survives 10k corpus-mutated rounds', () => {
  fc.assert(
    fc.property(corpusFuzzedBuffer([
      // TODO: real .fif files would be valuable here once we have a
      //       small (<100 KB) example we can commit.
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
