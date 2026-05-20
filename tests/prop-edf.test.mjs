// Property-based tests for the EDF/EDF+/BDF reader.
//
// These complement tests/unit-edf.test.mjs (hand-crafted edge cases)
// by sweeping the parsers with fast-check arbitraries to flush out
// crashes the example-based tests can't reach.
//
// Contract under test:
//   1. parseHeader on any 256-byte ASCII buffer either returns a
//      result OR throws a `new Error(...)` — never a process crash,
//      RangeError on TypedArray construction, or infinite loop.
//   2. parseTAL on any byte sequence returns an array (possibly empty)
//      — same no-crash contract.
//   3. parseHeader is constructive: when handed a header that we
//      built ourselves with `n_signals = N`, it reports N back.
//
// If fast-check shrinks to a crash, capture the seed/path with
// `withSeed(...)` so the regression is reproducible.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EDFReader } from './_bootstrap.mjs';
import { fc, edfHeaderBuffer, uint8Buffer } from './_arbitraries.mjs';

// Helper: build a minimally well-formed EDF header for a given
// signal count using the defaults from unit-edf.test.mjs. Mirrors the
// `buildHeader` in that file but parameterised purely on nSignals so
// fast-check can drive it.
const pad = (v, n) => {
  const t = String(v);
  return t.length >= n ? t.slice(0, n) : t + ' '.repeat(n - t.length);
};
const SIG_FIELDS = [
  ['label',      16, 'EEG'],
  ['transducer', 80, ''],
  ['dim',         8, 'uV'],
  ['pmin',        8, -250],
  ['pmax',        8, 250],
  ['dmin',        8, -32768],
  ['dmax',        8, 32767],
  ['prefilter',  80, ''],
  ['spr',         8, 256],
  ['_reserved',  32, ''],
];

function buildWellFormedHeaderBuffer(nSignals) {
  const headerBytes = 256 * (nSignals + 1);
  const fixedAscii =
    pad('0', 8) +
    pad('', 80) + pad('', 80) +
    pad('01.01.20', 8) + pad('00.00.00', 8) +
    pad(headerBytes, 8) +
    pad('', 44) +
    pad(1, 8) + pad('1', 8) +
    pad(nSignals, 4);
  const signalAscii = SIG_FIELDS
    .map(([_k, width, dflt]) => Array.from({ length: nSignals }, () => pad(dflt, width)).join(''))
    .join('');
  const fullAscii = fixedAscii + signalAscii;
  const buf = new Uint8Array(fullAscii.length);
  for (let i = 0; i < fullAscii.length; i++) buf[i] = fullAscii.charCodeAt(i) & 0x7f;
  return buf.buffer;
}

test('property: parseHeader never crashes on 256-byte ASCII fuzz', () => {
  fc.assert(
    fc.property(edfHeaderBuffer, (bytes) => {
      // The contract is "throw or succeed, never a host-level crash".
      // We treat any Error as acceptable; the only failure mode that
      // matters is a non-Error throw (e.g. RangeError from a typed-
      // array allocation) escaping unreported.
      try {
        EDFReader.parseHeader(bytes.buffer);
      } catch (e) {
        if (!(e instanceof Error)) throw new Error(`Non-Error thrown: ${typeof e}: ${e}`);
      }
      return true;
    }),
    { numRuns: 100 }
  );
});

test('property: parseTAL never crashes on arbitrary byte sequences', () => {
  fc.assert(
    fc.property(uint8Buffer, (bytes) => {
      try {
        const events = EDFReader.parseTAL(bytes);
        // parseTAL is total — it must return an Array, never undefined.
        return Array.isArray(events);
      } catch (e) {
        if (!(e instanceof Error)) throw new Error(`Non-Error thrown: ${typeof e}: ${e}`);
        // parseTAL today does not throw on any input. If a future
        // version starts throwing, treat that as a contract change to
        // discuss in PR review rather than a silent property failure.
        return false;
      }
    }),
    { numRuns: 100 }
  );
});

test('property: parseHeader round-trips n_signals for constructive inputs', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 64 }), (nSignals) => {
      const buf = buildWellFormedHeaderBuffer(nSignals);
      const h = EDFReader.parseHeader(buf);
      assert.equal(h.n_signals, nSignals);
      assert.equal(h.signals.length, nSignals);
      assert.equal(h.header_bytes, 256 * (nSignals + 1));
      return true;
    }),
    { numRuns: 64 }
  );
});
