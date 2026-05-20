// Property-based tests for the EEGLAB column-major slicing helper.
//
// `sliceColumnMajor(flat, nChannels, startSample, nWin)` is the
// hot path for inline .set windowing. The contract:
//
//   - Input `flat` is a Float32Array laid out as in MATLAB's
//     column-major storage of an [nChannels × nSamples] matrix.
//     The element at row=channel `c`, column=sample `s` lives at
//     index  s * nChannels + c  (column index changes slowest, i.e.
//     channels are contiguous within a sample).
//   - Output is one Float32Array per channel of length `nWin`,
//     where `out[c][k] === flat[(startSample + k) * nChannels + c]`.
//
// We test the two invariants that matter for the renderer:
//   1. Length: every output channel is exactly `nWin` long.
//   2. Values: every emitted sample equals the source element at
//      the correct flat-array index.
//
// Property-based sweeping lets us cover the corners (start=0,
// start=nSamples-nWin, nChannels=1) without hand-coding each case.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EEGLABReader } from './_bootstrap.mjs';
import { fc } from './_arbitraries.mjs';

const slice = EEGLABReader._sliceColumnMajor;

// Bounded sizes keep each property run cheap (<500 ms locally) while
// still spanning the realistic shapes: a handful to a few dozen
// channels, hundreds to a few thousand samples per window.
const sliceShape = fc
  .record({
    nChannels: fc.integer({ min: 1, max: 64 }),
    nSamples:  fc.integer({ min: 100, max: 4096 }),
  })
  .chain(({ nChannels, nSamples }) =>
    fc.record({
      nChannels: fc.constant(nChannels),
      nSamples:  fc.constant(nSamples),
      startSample: fc.integer({ min: 0, max: nSamples - 1 }),
    }).chain(({ nChannels: nc, nSamples: ns, startSample }) =>
      fc.record({
        nChannels:   fc.constant(nc),
        nSamples:    fc.constant(ns),
        startSample: fc.constant(startSample),
        nWin:        fc.integer({ min: 1, max: ns - startSample }),
      })
    )
  );

// Build a deterministic Float32Array of length nChannels*nSamples
// whose value at flat index i is i — that way every assertion is
// "out[c][k] should be (startSample+k)*nChannels + c" and a failure
// reads naturally.
function makeFlat(nChannels, nSamples) {
  const flat = new Float32Array(nChannels * nSamples);
  for (let i = 0; i < flat.length; i++) flat[i] = i;
  return flat;
}

test('property: sliceColumnMajor output channel length equals nWin', () => {
  fc.assert(
    fc.property(sliceShape, ({ nChannels, nSamples, startSample, nWin }) => {
      const flat = makeFlat(nChannels, nSamples);
      const out = slice(flat, nChannels, startSample, nWin);
      assert.equal(out.length, nChannels, 'channel count');
      for (let c = 0; c < nChannels; c++) {
        assert.equal(out[c].length, nWin, `channel ${c} length`);
      }
      return true;
    }),
    { numRuns: 50 }
  );
});

test('property: sliceColumnMajor extracted values match column-major layout', () => {
  fc.assert(
    fc.property(sliceShape, ({ nChannels, nSamples, startSample, nWin }) => {
      const flat = makeFlat(nChannels, nSamples);
      const out = slice(flat, nChannels, startSample, nWin);
      // Sample a few interior + edge points rather than the full
      // grid; a wrong layout would diverge on the first probe so we
      // don't need the full Cartesian sweep to flush bugs.
      const sampleK = [0, Math.floor(nWin / 2), nWin - 1];
      const sampleC = [0, Math.floor(nChannels / 2), nChannels - 1];
      for (const c of sampleC) {
        for (const k of sampleK) {
          const expected = flat[(startSample + k) * nChannels + c];
          assert.equal(out[c][k], expected,
            `c=${c} k=${k} start=${startSample} nCh=${nChannels} nSamp=${nSamples}`);
        }
      }
      return true;
    }),
    { numRuns: 50 }
  );
});
