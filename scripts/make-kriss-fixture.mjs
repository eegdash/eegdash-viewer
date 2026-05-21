#!/usr/bin/env node
/**
 * Synthesise a tiny CC0 KRISS-shaped `.kdf` file for testing the
 * formats/kriss.js stub reader.
 *
 * Why this is a stub, not a real KRISS file:
 *   The KRISS (Korea Research Institute of Standards and Science) MEG
 *   .kdf binary format is NOT publicly documented as of 2026-05.
 *   Cross-checked at authorship time:
 *     - MNE-Python contents listing
 *       https://api.github.com/repos/mne-tools/mne-python/contents/mne/io
 *       (no `kriss/` directory; KIT reader has no KRISS branch)
 *     - FieldTrip fileio/private — no `read_kriss_header.m` (404)
 *     - BIDS-MEG appendix documents only the filename convention
 *       (`.kdf` + companion `_headshape.txt`, `.chn`, `.trg`,
 *       `_digitizer.txt`), not the on-disk binary layout.
 *   So we cannot synthesise a *real* .kdf. Instead this fixture has a
 *   conservative ASCII magic-byte signature ("KDF\0") in its first 4
 *   bytes plus arbitrary plausible bytes for the rest. The fixture
 *   exists solely to exercise the stub reader's two code paths:
 *     1. KRISS magic detected → throw "not yet implemented" error
 *     2. KRISS magic NOT detected → throw "not a valid KRISS file" error
 *   When (or if) the real spec lands, this script will be rewritten to
 *   emit a structurally valid .kdf and the reader will gain a parser.
 *
 * Output: tests/fixtures/meg/kriss-tiny.kdf
 *   - 1024 bytes total
 *   - First 4 bytes: ASCII "KDF\0" (our chosen magic signature)
 *   - Bytes 4..15:    plausible 12-byte header padding (zero-filled)
 *   - Bytes 16..31:   ASCII string "KRISS MEG v0.0" + NUL padding
 *                     (a second-level signature — a future reader could
 *                     use either the 4-byte magic OR this label.)
 *   - Bytes 32..1023: arbitrary deterministic pattern (sin-byte table)
 *                     so the fixture is non-trivial without claiming any
 *                     particular structure.
 *
 * License: CC0. No upstream data was used.
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE_SIZE = 1024;
const MAGIC = 'KDF\0';
const LABEL = 'KRISS MEG v0.0';

const buf = Buffer.alloc(FILE_SIZE, 0);

// 4-byte magic signature at offset 0.
buf.write(MAGIC, 0, MAGIC.length, 'ascii');

// 16-byte label slot at offset 16 (NUL-padded). The reader checks for
// "KRISS" or "KDF" as a substring inside the first 64 bytes — either
// the 4-byte magic OR the label will satisfy detection.
buf.write(LABEL, 16, Math.min(LABEL.length, 16), 'ascii');

// Deterministic sin-byte pattern from offset 32 to end. Gives the
// fixture some structure (so it isn't 99% zeros, which would also be a
// valid "empty file" pattern). The exact values are not meaningful.
for (let i = 32; i < FILE_SIZE; i++) {
  const v = Math.round(127.5 * (1 + Math.sin((i - 32) * 0.05)));
  buf.writeUInt8(v & 0xff, i);
}

const outPath = path.resolve('tests/fixtures/meg/kriss-tiny.kdf');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, buf);

console.log(
  `wrote ${outPath} (${FILE_SIZE} bytes, stub fixture — see ` +
  `scripts/make-kriss-fixture.mjs header for details)`,
);
