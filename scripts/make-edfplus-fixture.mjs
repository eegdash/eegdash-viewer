#!/usr/bin/env node
/**
 * scripts/make-edfplus-fixture.mjs
 *
 * Generates a minimal EDF+ file with:
 *   - 1 EEG signal channel  (100 Hz, 4 seconds = 4 data records of 1 s each)
 *   - 1 EDF Annotations channel
 *   - 3 embedded annotations: "Stimulus" at 0.5s, "Page change" at 1.5s,
 *     "Eye blink" at 3.0s
 *
 * Output: test-data/edfplus-with-annotations.edf
 *
 * Usage:  node scripts/make-edfplus-fixture.mjs
 *
 * EDF+ header layout (from https://www.edfplus.info/specs/edfplus.html):
 *   256-byte main header
 *   256 bytes × n_signals signal-header (field-major order)
 *   followed by n_records data records
 *
 * TAL format per record:
 *   +<onset>\x14<text>\x14\x00   (annotation TAL)
 *   +<onset>\x14\x00             (timestamp anchor, always first in each record)
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT   = join(__dir, '..', 'test-data', 'edfplus-with-annotations.edf');

// ---- helpers -----------------------------------------------------------

/**
 * ASCII-pad a value to exactly `n` bytes, truncating if needed.
 * EDF fields must be exactly their declared width.
 */
function pad(v, n) {
  const s = String(v == null ? '' : v);
  if (s.length >= n) return s.slice(0, n);
  return s + ' '.repeat(n - s.length);
}

/** Encode a string into a Uint8Array (ASCII only — EDF header is 7-bit). */
function enc(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0x7f;
  return b;
}

/** Concatenate multiple Uint8Arrays. */
function concat(...parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ---- recording parameters ----------------------------------------------

const N_SIGNALS        = 2;           // 1 EEG + 1 annotation
const N_RECORDS        = 4;           // 4 data records of 1 second each
const RECORD_DURATION  = 1;           // 1 second per record
const FS               = 100;         // 100 Hz for the EEG channel
const SPR_EEG          = FS;          // samples_per_record for EEG = 100
// EDF+ annotation channel: spec says >= 4 bytes per annotation byte.
// We budget 40 bytes per record which comfortably holds our TALs.
const SPR_ANNOT        = 40;          // samples_per_record for annotation channel

const HEADER_BYTES = 256 * (N_SIGNALS + 1);  // 768 bytes

// ---- main header (256 bytes) -------------------------------------------

const mainHeader = pad('0', 8) +                       //  0: version
  pad('X X X X', 80) +                                 //  8: local patient ID
  pad('Startdate 01-JAN-2024 X X', 80) +               // 88: local recording ID
  pad('01.01.24', 8) +                                  // 168: startdate dd.mm.yy
  pad('00.00.00', 8) +                                  // 176: starttime hh.mm.ss
  pad(HEADER_BYTES, 8) +                                // 184: bytes in header record
  pad('EDF+C', 44) +                                   // 192: reserved (EDF+C = continuous)
  pad(N_RECORDS, 8) +                                   // 236: number of data records
  pad(RECORD_DURATION, 8) +                             // 244: duration of data record (s)
  pad(N_SIGNALS, 4);                                    // 252: number of signals

// ---- signal headers (field-major, 256 bytes each = 512 bytes total) ----

// Field widths per EDF spec:
const FIELDS = [
  // [fieldName, width]
  ['label',      16],
  ['transducer', 80],
  ['dim',         8],
  ['pmin',        8],
  ['pmax',        8],
  ['dmin',        8],
  ['dmax',        8],
  ['prefilter',  80],
  ['spr',         8],
  ['reserved',   32],
];

const signals = [
  {
    label:      'EEG',
    transducer: '',
    dim:        'uV',
    pmin:       '-100',
    pmax:       '100',
    dmin:       '-32768',
    dmax:       '32767',
    prefilter:  '',
    spr:        String(SPR_EEG),
    reserved:   '',
  },
  {
    label:      'EDF Annotations',
    transducer: '',
    dim:        '',
    // Annotation channels need a non-zero physical range to pass the
    // EDF validator's digital_max > digital_min check.
    pmin:       '-1',
    pmax:       '1',
    dmin:       '-32768',
    dmax:       '32767',
    prefilter:  '',
    spr:        String(SPR_ANNOT),
    reserved:   '',
  },
];

let sigHeaderAscii = '';
for (const [field, width] of FIELDS) {
  for (const s of signals) {
    sigHeaderAscii += pad(s[field] || '', width);
  }
}

// ---- TAL encoding helper ------------------------------------------------

/**
 * Encode one TAL record:
 *   +<onset>\x14[text]\x14\x00
 *   (empty text = timestamp anchor)
 *
 * Returns a Uint8Array padded/truncated to exactly `maxBytes`.
 * Padding is done with 0x00 bytes (allowed in the annotation channel —
 * they act as record terminators; extra zeros are simply ignored by parsers).
 */
function encodeTAL(onset, text, maxBytes) {
  let s = `+${onset}\x14`;
  if (text) s += `${text}\x14`;
  s += '\x00';
  const raw = enc(s);
  const out = new Uint8Array(maxBytes);   // zero-filled
  out.set(raw.slice(0, maxBytes));        // truncate if somehow > maxBytes
  return out;
}

/**
 * For a given data record index `r` (0-based), return the bytes for the
 * annotation channel (SPR_ANNOT × 2 bytes for EDF, but here we treat them
 * as raw bytes and lay them out as TAL ASCII).
 *
 * Record-level layout (EDF+ spec §2.2.5):
 *   First TAL: +<rec_onset>\x14\x00   (timestamp anchor)
 *   Subsequent TALs: +<onset>\x14<text>\x14\x00
 *
 * The annotation channel bytes are NOT int16 samples — they are raw ASCII.
 * The EDF spec allocates samples_per_record × 2 bytes per channel per record
 * (EDF uses 2 bytes/sample). For our annotation channel that is 40 × 2 = 80
 * bytes of TAL space per record.
 */
const ANNOT_CHAN_BYTES = SPR_ANNOT * 2;   // 80 bytes per record for annotation channel

// Annotations to embed:
const ANNOTATIONS = [
  { onset: 0.5, text: 'Stimulus' },
  { onset: 1.5, text: 'Page change' },
  { onset: 3.0, text: 'Eye blink' },
];

function buildAnnotationRecord(recIndex) {
  const recOnset  = recIndex * RECORD_DURATION;
  const buf       = new Uint8Array(ANNOT_CHAN_BYTES);  // zero-filled
  let off = 0;

  // Always start with the timestamp anchor.
  const anchor = enc(`+${recOnset}\x14\x00`);
  buf.set(anchor.slice(0, ANNOT_CHAN_BYTES - off), off);
  off += anchor.length;

  // Embed any annotations that fall within this record's time window.
  const recEnd = recOnset + RECORD_DURATION;
  for (const { onset, text } of ANNOTATIONS) {
    if (onset >= recOnset && onset < recEnd) {
      const tal = enc(`+${onset}\x14${text}\x14\x00`);
      if (off + tal.length <= ANNOT_CHAN_BYTES) {
        buf.set(tal, off);
        off += tal.length;
      }
    }
  }

  return buf;
}

// ---- EEG signal data -------------------------------------------------------

/**
 * Build a simple sine-wave data record (100 samples × 2 bytes = 200 bytes).
 * The exact waveform doesn't matter for functional tests; something non-trivial
 * helps catch scale/offset bugs visually.
 */
function buildEEGRecord(recIndex) {
  const buf = new Uint8Array(SPR_EEG * 2);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < SPR_EEG; i++) {
    const t = (recIndex * RECORD_DURATION) + i / FS;
    // 10 µV amplitude sine at 10 Hz → digital value ≈ 10 / (200/65535) ≈ 3277
    const phys = 10 * Math.sin(2 * Math.PI * 10 * t);
    const scale = (100 - (-100)) / (32767 - (-32768));
    const digital = Math.round((phys - (-100)) / scale + (-32768));
    view.setInt16(i * 2, Math.max(-32768, Math.min(32767, digital)), true);
  }
  return buf;
}

// ---- Assemble the file -------------------------------------------------

const headerBytes = concat(enc(mainHeader), enc(sigHeaderAscii));
if (headerBytes.length !== HEADER_BYTES) {
  throw new Error(`header length ${headerBytes.length} !== expected ${HEADER_BYTES}`);
}

const recordParts = [];
for (let r = 0; r < N_RECORDS; r++) {
  // EDF record layout: signal-major (all samples of signal 0, then signal 1, ...).
  recordParts.push(buildEEGRecord(r));
  recordParts.push(buildAnnotationRecord(r));
}

const fileBytes = concat(headerBytes, ...recordParts);
writeFileSync(OUT, fileBytes);

console.log(`Written ${fileBytes.length} bytes → ${OUT}`);
console.log(`  Header: ${HEADER_BYTES} bytes (256 × ${N_SIGNALS + 1})`);
console.log(`  Data:   ${N_RECORDS} records × ${(SPR_EEG + SPR_ANNOT) * 2} bytes = ${N_RECORDS * (SPR_EEG + SPR_ANNOT) * 2} bytes`);
console.log(`  Annotations embedded: ${ANNOTATIONS.map(a => `${a.text} @ ${a.onset}s`).join(', ')}`);
