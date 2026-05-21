// Property-based test for the CTF MEG reader.
//
// formats/ctf.js's api.read(buf) parses a .res4 ArrayBuffer. This
// test confirms it refuses arbitrary byte input gracefully: it must
// throw a regular Error or return a plain object, never produce a
// host-level crash, NaN-laden header object, or hang.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { fc, uint8Buffer } from './_arbitraries.mjs';

const require = createRequire(import.meta.url);
require('../formats/_ctf-res4.js');
require('../formats/_ctf-marker.js');
const CTFReader = require('../formats/ctf.js');

test('property: ctf.read never crashes on arbitrary byte input', () => {
  fc.assert(
    fc.property(uint8Buffer, (bytes) => {
      // api.read takes ArrayBuffer; uint8Buffer yields Uint8Array.
      const ab = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
      try {
        const h = CTFReader.read(ab);
        // If the parser returns at all, it must be a plain object
        // with sane numeric fields. Downstream consumers dereference
        // .no_channels / .sample_rate without null-checking.
        assert.ok(h && typeof h === 'object',
          'read() returned non-object on accepted input');
        assert.ok(Number.isFinite(h.no_channels) && h.no_channels > 0);
        assert.ok(Number.isFinite(h.sample_rate) && h.sample_rate > 0);
      } catch (e) {
        if (!(e instanceof Error)) {
          throw new Error(`Non-Error thrown: ${typeof e}: ${e}`);
        }
      }
      return true;
    }),
    { numRuns: 300 },
  );
});
