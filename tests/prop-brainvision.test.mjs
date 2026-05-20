// Property-based tests for the BrainVision .vhdr parser.
//
// Complements tests/unit-brainvision.test.mjs by:
//   - Hammering parseIni with arbitrary UTF-8 text to confirm it
//     stays a total function (the parser is documented as permissive,
//     "ignore what you don't understand" — that has to be true under
//     any input, not just the hand-crafted ones).
//   - Round-tripping well-formed structured INI through the parser
//     to pin down the case-folding and "last wins" semantics for
//     arbitrary section / key shapes.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BrainVisionReader } from './_bootstrap.mjs';
import { fc, brainVisionFreeText, brainVisionVhdrText } from './_arbitraries.mjs';

test('property: parseIni never crashes on arbitrary text', () => {
  fc.assert(
    fc.property(brainVisionFreeText, (text) => {
      try {
        const out = BrainVisionReader.parseIni(text);
        // Permissive parser must always return an object — even for
        // text with zero sections. A null/undefined return would
        // break the downstream `sec['common infos']` lookups.
        return out !== null && typeof out === 'object';
      } catch (e) {
        if (!(e instanceof Error)) {
          throw new Error(`Non-Error thrown: ${typeof e}: ${e}`);
        }
        // parseIni is documented as permissive — it should not throw
        // for any input. Treat a throw as a property failure so we
        // notice if that contract drifts.
        return false;
      }
    }),
    { numRuns: 100 }
  );
});

test('property: parseIni round-trips well-formed sections and keys', () => {
  fc.assert(
    fc.property(brainVisionVhdrText, ({ text, sections }) => {
      const parsed = BrainVisionReader.parseIni(text);

      // Every section we wrote must appear under its lowercase name
      // (the parser canonicalises section names but preserves key
      // capitalisation).
      for (const [lcName, expectedPairs] of Object.entries(sections)) {
        const got = parsed[lcName];
        assert.ok(got, `missing section "${lcName}" in parsed output`);
        for (const [key, value] of Object.entries(expectedPairs)) {
          assert.equal(got[key], value, `section "${lcName}" key "${key}"`);
        }
      }
      return true;
    }),
    { numRuns: 100 }
  );
});
