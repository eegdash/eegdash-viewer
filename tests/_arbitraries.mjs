// Shared fast-check arbitraries for the binary EEG format readers.
//
// Each arbitrary documents:
//   SHAPE:    what value comes out
//   COVERS:   the edge cases the generator deliberately reaches
//   SKIPS:    deliberate omissions so future tests don't assume coverage
//
// Property tests are checked-in regression material: keep the
// generators small, named, and reusable. Anything fancy belongs in
// the test file that needs it, not here.
// fast-check ships as CJS; bridge via createRequire so this module
// works whether the test file imports us from .mjs (most cases) or
// requires us from a CJS sandbox.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fc = require('fast-check');
export { fc };

// ---- raw bytes ----------------------------------------------------

// SHAPE:  Uint8Array, 1 - 65,536 bytes, uniform-random byte values.
// COVERS: short headers, headers near the EDF 256-byte boundary,
//         long-but-bounded buffers that exercise scanning loops.
// SKIPS:  buffers >64KB (those are integration territory) and
//         buffers of length 0 (parsers may legitimately throw before
//         a meaningful property can be checked).
export const uint8Buffer = fc
  .uint8Array({ minLength: 1, maxLength: 64 * 1024 });

// ---- EDF header fuzz ----------------------------------------------

// SHAPE:  256-byte Uint8Array of printable ASCII (space-padded).
// COVERS: header-sized buffers that LOOK structurally valid (no
//         underflow) but carry arbitrary text in every fixed field —
//         exercises every integer/float parse path in parseHeader
//         without being a hand-crafted "broken" header.
// SKIPS:  buffers ≠256 bytes (separate test covers underflow), and
//         non-ASCII bytes (the spec restricts header to ASCII).
export const edfHeaderBuffer = fc
  .string({ minLength: 256, maxLength: 256, unit: 'binary-ascii' })
  .map((s) => {
    const buf = new Uint8Array(256);
    for (let i = 0; i < 256; i++) buf[i] = s.charCodeAt(i) & 0x7f;
    return buf;
  });

// ---- BrainVision .vhdr INI fuzz -----------------------------------

// SHAPE:  arbitrary text up to 4 KB. May or may not contain INI
//         markup; the parseIni contract is "permissive — ignore what
//         you don't understand", so it must survive anything.
// COVERS: empty input, no-section input (orphan key=value lines),
//         malformed bracket lines, very long lines, embedded CR/LF.
// SKIPS:  ASCII-only generation (parseIni accepts any UTF-16 JS
//         string, so we let fast-check use its default unicode unit).
export const brainVisionFreeText = fc
  .string({ minLength: 0, maxLength: 4096 });

// SHAPE:  Well-formed BrainVision-style INI text built from N sections,
//         each with M `key=value` pairs. Output is a structured object
//         { text, sections } where `sections` is the canonical
//         lowercase map the parser is expected to return.
// COVERS: case folding of section names, multiple sections, the
//         "duplicate key keeps the last value" behaviour of the
//         single-pass parser.
// SKIPS:  comments, blank lines, escape sequences (covered by
//         existing hand-rolled tests in unit-brainvision.test.mjs).
// Names / values may not start or end with whitespace — the INI
// parser trims both sides of every key and value, so a generator
// that lets either edge be ' ' breaks the round-trip property
// (parser key "A " collapses to "A"). Single-token shapes keep the
// generator focused on cases the parser claims to preserve verbatim.
const iniName = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,20}$/);
const iniValue = fc.oneof(
  fc.constant(''),
  fc.stringMatching(/^[A-Za-z0-9_.+\-][A-Za-z0-9 _.+\-]{0,38}[A-Za-z0-9_.+\-]$/),
  fc.stringMatching(/^[A-Za-z0-9_.+\-]$/),
);
export const brainVisionVhdrText = fc
  .array(
    fc.record({
      section: iniName,
      pairs: fc.uniqueArray(
        fc.tuple(iniName, iniValue),
        { minLength: 1, maxLength: 6, selector: (t) => t[0] }
      ),
    }),
    { minLength: 1, maxLength: 4 }
  )
  // Make sure section names are also unique across the file so the
  // "last wins" rule doesn't surprise the round-trip property.
  .filter((arr) => {
    const seen = new Set();
    for (const r of arr) {
      const lc = r.section.toLowerCase();
      if (seen.has(lc)) return false;
      seen.add(lc);
    }
    return true;
  })
  .map((arr) => {
    const lines = [];
    const sections = {};
    for (const { section, pairs } of arr) {
      lines.push(`[${section}]`);
      const lc = section.toLowerCase();
      sections[lc] = sections[lc] || {};
      for (const [k, v] of pairs) {
        lines.push(`${k}=${v}`);
        sections[lc][k] = v;
      }
      lines.push('');
    }
    return { text: lines.join('\n'), sections };
  });

// ---- determinism helper -------------------------------------------

// `fc.assert(prop, withSeed(42))` reproduces a counterexample exactly
// across runs. Use when committing a regression test for a shrunk
// failure: paste the seed/path/endOnFailure values reported by
// fast-check so CI re-runs the same shrink, not a fresh search.
export function withSeed(seed, extra = {}) {
  return { seed, ...extra };
}
