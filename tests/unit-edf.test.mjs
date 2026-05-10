// Synthetic-input unit tests for the EDF/BDF header parser.
// Constructs a hand-built header buffer so we can exercise edge
// cases (zero digital range, header-byte mismatch, BDF marker,
// EDF+ continuous/discontinuous flags) without going to the
// network for one specific dataset per case.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EDFReader } from './_bootstrap.mjs';

// Build a 256+ns·256-byte EDF/BDF header buffer with the given
// fields. ASCII-padded to spec, signal headers in field-major
// order. `isBDF` flips byte 0 to 0xFF (the BioSemi marker).
const pad = (v, n) => {
  const t = String(v);
  return t.length >= n ? t.slice(0, n) : t + ' '.repeat(n - t.length);
};

// Per-signal fields in EDF spec order: [key, byte width, default].
// `dim` defaults to 'uV' so most tests can omit it; everything else
// either has no sane default or comes from the test signal.
const SIG_FIELDS = [
  ['label',      16, ''],
  ['transducer', 80, ''],
  ['dim',         8, 'uV'],
  ['pmin',        8, ''],
  ['pmax',        8, ''],
  ['dmin',        8, ''],
  ['dmax',        8, ''],
  ['prefilter',  80, ''],
  ['spr',         8, ''],
  ['_reserved',  32, ''],     // 32-byte trailing reserved per signal
];

function buildHeader({ isBDF = false, reserved = '', nRecords = 1, recDur = '1', signals }) {
  const ns = signals.length;
  const headerBytes = 256 * (ns + 1);
  const fixedAscii =
    pad(isBDF ? '\x00BIOSEMI' : '0', 8) +     // version (byte 0 patched below for BDF)
    pad('', 80) + pad('', 80) +               // patient + recording id
    pad('01.01.20', 8) + pad('00.00.00', 8) +
    pad(headerBytes, 8) +
    pad(reserved, 44) +
    pad(nRecords, 8) + pad(recDur, 8) +
    pad(ns, 4);
  // Field-major signal headers: all labels first, then all
  // transducers, etc. Driven by SIG_FIELDS so adding/reordering a
  // field is a one-line edit.
  const signalAscii = SIG_FIELDS
    .map(([key, width, dflt]) =>
      signals.map(s => pad(s[key] != null ? s[key] : dflt, width)).join(''))
    .join('');
  const fullAscii = fixedAscii + signalAscii;
  const buf = new Uint8Array(fullAscii.length);
  for (let i = 0; i < fullAscii.length; i++) buf[i] = fullAscii.charCodeAt(i) & 0x7f;
  if (isBDF) buf[0] = 0xff;
  return buf.buffer;
}

const TWO_EEG = [
  { label: 'Fp1', dim: 'uV', pmin: -250, pmax: 250, dmin: -32768, dmax: 32767, spr: 256 },
  { label: 'Fp2', dim: 'uV', pmin: -250, pmax: 250, dmin: -32768, dmax: 32767, spr: 256 },
];

test('parseHeader: well-formed EDF', () => {
  const h = EDFReader.parseHeader(buildHeader({ signals: TWO_EEG }));
  assert.equal(h.isBDF, false);
  assert.equal(h.n_signals, 2);
  assert.equal(h.n_records, 1);
  assert.equal(h.record_duration, 1);
  assert.equal(h.signals[0].label, 'Fp1');
  assert.equal(h.signals[0].samples_per_record, 256);
});

test('parseHeader: BDF (byte 0 = 0xFF)', () => {
  const h = EDFReader.parseHeader(buildHeader({ isBDF: true, signals: TWO_EEG }));
  assert.equal(h.isBDF, true);
});

test('parseHeader: scale + offset derived from physical/digital min/max', () => {
  const h = EDFReader.parseHeader(buildHeader({ signals: TWO_EEG }));
  const expectedScale = (250 - (-250)) / (32767 - (-32768));
  // Offset isn't exactly zero — int16 has 65536 steps over the
  // 65535-step "symmetric" range, so digital=0 maps to ~½ scale.
  // The check that matters is round-trip: digital ↔ physical at
  // the endpoints, which the formula scale·d + offset must satisfy.
  // Float64 round-trip leaves a few ULPs of noise (~1e-13); 1e-6 µV
  // is well below any plausible measurement precision.
  for (const s of h.signals) {
    assert.ok(Math.abs(s.scale - expectedScale) < 1e-9);
    assert.ok(Math.abs(s.digital_min * s.scale + s.offset - s.physical_min) < 1e-6);
    assert.ok(Math.abs(s.digital_max * s.scale + s.offset - s.physical_max) < 1e-6);
  }
});

test('parseHeader: EDF+C continuous flag detected', () => {
  const h = EDFReader.parseHeader(buildHeader({ reserved: 'EDF+C', signals: TWO_EEG }));
  assert.equal(h.isEdfPlus, true);
  assert.equal(h.isContinuous, true);
});

test('parseHeader: EDF+D discontinuous flag detected', () => {
  const h = EDFReader.parseHeader(buildHeader({ reserved: 'EDF+D', signals: TWO_EEG }));
  assert.equal(h.isEdfPlus, true);
  assert.equal(h.isContinuous, false);
});

test('parseHeader: rejects zero digital range (would silently emit 0/0)', () => {
  const broken = [
    { ...TWO_EEG[0], dmin: 0, dmax: 0 },
    TWO_EEG[1],
  ];
  assert.throws(
    () => EDFReader.parseHeader(buildHeader({ signals: broken })),
    /non-positive digital range/);
});

test('parseHeader: rejects inverted digital range (would silently flip polarity)', () => {
  const broken = [
    { ...TWO_EEG[0], dmin: 32767, dmax: -32768 },
    TWO_EEG[1],
  ];
  assert.throws(
    () => EDFReader.parseHeader(buildHeader({ signals: broken })),
    /non-positive digital range/);
});

test('parseHeader: rejects underflow (truncated header buffer)', () => {
  const buf = new Uint8Array(100).buffer;
  assert.throws(() => EDFReader.parseHeader(buf), /header underflow/);
});

test('parseHeader: rejects header_bytes / n_signals mismatch', () => {
  // Hand-build a header where the declared header_bytes contradicts
  // 256·(n_signals+1). The validator should refuse it rather than
  // walk off the end of the buffer.
  const ns = 2;
  let s = pad('0', 8) + pad('', 80) + pad('', 80) + pad('01.01.20', 8) + pad('00.00.00', 8);
  s += pad(999, 8);                                              // declared header_bytes (wrong)
  s += pad('', 44) + pad(1, 8) + pad('1', 8) + pad(ns, 4);
  // Pad to 256 bytes to satisfy the buffer-length precheck.
  s = s.padEnd(256, ' ');
  const buf = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i) & 0x7f;
  assert.throws(() => EDFReader.parseHeader(buf.buffer), /header_bytes \(999\)/);
});

test('parseHeader: annotation channel flagged via label match', () => {
  const sig = [
    TWO_EEG[0],
    { label: 'EDF Annotations', dim: '', pmin: -1, pmax: 1, dmin: -32768, dmax: 32767, spr: 30 },
  ];
  const h = EDFReader.parseHeader(buildHeader({ signals: sig }));
  assert.equal(h.signals[0].is_annotation, false);
  assert.equal(h.signals[1].is_annotation, true);
});

test('parseHeader: parsing junk integer fields throws clearly', () => {
  const broken = [
    { ...TWO_EEG[0], dmin: 'XX', dmax: 32767 },
    TWO_EEG[1],
  ];
  assert.throws(
    () => EDFReader.parseHeader(buildHeader({ signals: broken })),
    /digital_min not an integer/);
});

test('parseHeader: BDF "BDF Annotations" channel flagged (not EDF Annotations)', () => {
  const sig = [
    TWO_EEG[0],
    { label: 'BDF Annotations', dim: '', pmin: -1, pmax: 1, dmin: -32768, dmax: 32767, spr: 30 },
  ];
  // BDF flag enables the BDF_ANNOTATION_LABEL match; on EDF the label
  // would NOT be recognised (preserves bit-identical EDF behaviour).
  const bdf = EDFReader.parseHeader(buildHeader({ isBDF: true, signals: sig }));
  assert.equal(bdf.signals[1].is_annotation, true, 'BDF: matches BDF Annotations');
  const edf = EDFReader.parseHeader(buildHeader({ isBDF: false, signals: sig }));
  assert.equal(edf.signals[1].is_annotation, false, 'EDF: does NOT match BDF Annotations');
});

test('pickModalSamplesPerRecord: most-frequent rate wins', () => {
  const signals = [
    { samples_per_record: 512 },
    { samples_per_record: 512 },
    { samples_per_record: 512 },
    { samples_per_record: 16 },
  ];
  assert.equal(EDFReader._pickModalSamplesPerRecord([0, 1, 2, 3], signals), 512);
});

test('pickModalSamplesPerRecord: ties resolved by largest spr (favours EEG over markers)', () => {
  const signals = [
    { samples_per_record: 100 },
    { samples_per_record: 500 },
  ];
  assert.equal(EDFReader._pickModalSamplesPerRecord([0, 1], signals), 500);
});

test('pickModalSamplesPerRecord: single signal trivially wins', () => {
  const signals = [{ samples_per_record: 250 }];
  assert.equal(EDFReader._pickModalSamplesPerRecord([0], signals), 250);
});
