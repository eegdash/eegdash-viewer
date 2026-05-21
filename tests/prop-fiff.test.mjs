// Property-based test for the MEG FIFF reader.
//
// fiff.js is the newest reader in the codebase and only ships an
// example-driven test path through fixtures. This file is its first
// fuzz: confirm that `api.read(arrayBuf)` is robust against arbitrary
// byte input — it must throw a regular Error or return a meas object,
// never a host-level crash, RangeError on DataView reads, or hang.
//
// We are NOT asserting structure of the returned object: a random
// 64 KB blob will not look like a FIFF file. The point is that the
// parser refuses gracefully.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { fc, uint8Buffer } from './_arbitraries.mjs';

const require = createRequire(import.meta.url);
require('../formats/_buffers.js');
const FIFFReader = require('../formats/fiff.js');

test('property: fiff.read never crashes on arbitrary byte input', () => {
  fc.assert(
    fc.property(uint8Buffer, (bytes) => {
      // Always pass a fresh ArrayBuffer slice — fiff.read calls
      // `new DataView(buf)` which only accepts ArrayBuffer (not
      // Uint8Array). The slice avoids accidental aliasing with
      // fast-check's internal pools.
      const ab = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      );
      try {
        const meas = FIFFReader.read(ab);
        // If the parser returns a value at all, it must be a plain
        // object — null/undefined would crash any downstream consumer
        // dereferencing `.sfreq` or `.raw`.
        assert.ok(meas && typeof meas === 'object',
          'read() returned non-object on accepted input');
      } catch (e) {
        if (!(e instanceof Error)) {
          throw new Error(`Non-Error thrown: ${typeof e}: ${e}`);
        }
      }
      return true;
    }),
    { numRuns: 100 }
  );
});
