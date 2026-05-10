// Truncation and edge-case tests for the EDF/BDF header parser.
// Tests mid-channel truncation, mid-physical-min truncation, and
// mid-spr (samples_per_record) truncation — all of which should
// fail with a clear error rather than silently returning corrupt data.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EDFReader } from './_bootstrap.mjs';

// Re-use the buildHeader helper from unit-edf.test.mjs.
// Since we can't import from another test file, we duplicate it here
// (short enough to inline).
const pad = (v, n) => {
  const t = String(v);
  return t.length >= n ? t.slice(0, n) : t + ' '.repeat(n - t.length);
};

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
  ['_reserved',  32, ''],
];

function buildHeader({ isBDF = false, reserved = '', nRecords = 1, recDur = '1', signals }) {
  const ns = signals.length;
  const headerBytes = 256 * (ns + 1);
  const fixedAscii =
    pad(isBDF ? '\x00BIOSEMI' : '0', 8) +
    pad('', 80) + pad('', 80) +
    pad('01.01.20', 8) + pad('00.00.00', 8) +
    pad(headerBytes, 8) +
    pad(reserved, 44) +
    pad(nRecords, 8) + pad(recDur, 8) +
    pad(ns, 4);
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

// 1. Truncated header-only (fewer than 256 bytes)

test('EDF truncation: header-only buffer (< 256 bytes) throws header underflow', () => {
  const buf = new Uint8Array(200).buffer;
  assert.throws(() => EDFReader.parseHeader(buf), /header underflow/);
});

// 2. Truncated at exactly 256 bytes (fixed header only, signal fields missing)

test('EDF truncation: 256-byte buffer with n_signals=2 throws buffer underflow', () => {
  // Build a valid 512-byte header (for 2 signals), then truncate to 256.
  const full = buildHeader({ signals: TWO_EEG });
  const truncated = full.slice(0, 256);
  // The parser sees 256 bytes, reads n_signals=2, expects 512 bytes → throws
  assert.throws(() => EDFReader.parseHeader(truncated), /header buffer.*< declared/);
});

// 3. Truncated mid-channel (after labels but before physical-min field)

test('EDF truncation: buffer truncated mid-physical-min field throws', () => {
  // A 2-signal header has 512 bytes total.
  // Byte 256 = start of signal headers. Each field is field-major.
  // Labels start at 256, each 16 bytes. Two labels = 32 bytes → ends at 288.
  // Transducers = 2 × 80 = 160 bytes → ends at 448.
  // Physical dimensions (dim) = 2 × 8 = 16 → ends at 464.
  // Physical min starts at 464, each 8 bytes for 2 signals = 16 bytes.
  // Truncating at 470 (mid-way through physical_min) yields incomplete data.
  const full = buildHeader({ signals: TWO_EEG });
  // Truncate at 270 = well into the label field area for the second signal
  // but before transducer / pmin / pmax / dmin / dmax — the parser will see
  // garbage ASCII values in the numeric fields.
  // Better: build with declared headerBytes = 512 but only provide 270 bytes.
  // The parser checks v.length < headerBytes → throws buffer underflow.
  const truncated = full.slice(0, 270);
  assert.throws(() => EDFReader.parseHeader(truncated), /header buffer.*< declared/);
});

// 4. Truncated mid-samples-per-record (spr field)

test('EDF truncation: buffer truncated just before spr field throws', () => {
  // Calculate byte offset of the spr field:
  // Signal header fields in order: label(16), transducer(80), dim(8),
  // pmin(8), pmax(8), dmin(8), dmax(8), prefilter(80), spr(8), reserved(32)
  // For 2 signals:
  //   label: 2×16=32, transducer: 2×80=160, dim: 2×8=16,
  //   pmin: 2×8=16, pmax: 2×8=16, dmin: 2×8=16, dmax: 2×8=16,
  //   prefilter: 2×80=160, spr starts at 256+32+160+16+16+16+16+16+160=688
  // Total header = 512 bytes, so spr offset=256+32+160+16+16+16+16+16+160=488
  // Truncate at 490 (mid spr for first signal): spr field reads garbage,
  // but the buffer check (v.length < headerBytes=512) triggers first.
  const full = buildHeader({ signals: TWO_EEG });
  const truncated = full.slice(0, 490);
  assert.throws(() => EDFReader.parseHeader(truncated), /header buffer.*< declared/);
});

// 5. One-byte under the full header size

test('EDF truncation: one byte missing from a 2-signal header rejects', () => {
  const full = buildHeader({ signals: TWO_EEG });
  const truncated = full.slice(0, full.byteLength - 1);
  assert.throws(() => EDFReader.parseHeader(truncated), /header buffer.*< declared/);
});

// 6. A well-formed 3-signal header truncated to 2 signals' worth of bytes

test('EDF truncation: 3-signal header truncated to 2-signal byte count throws', () => {
  const THREE_EEG = [
    ...TWO_EEG,
    { label: 'Cz', dim: 'uV', pmin: -250, pmax: 250, dmin: -32768, dmax: 32767, spr: 256 },
  ];
  const full = buildHeader({ signals: THREE_EEG });
  // A 3-signal header = 4 × 256 = 1024 bytes. Truncate to 768 (3 × 256).
  const truncated = full.slice(0, 768);
  // The buffer says n_signals=3 and headerBytes=1024, but v.length=768 < 1024.
  assert.throws(() => EDFReader.parseHeader(truncated), /header buffer.*< declared/);
});

// 7. BrainVision header truncation tests

import { BrainVisionReader } from './_bootstrap.mjs';

const BASE_VHDR = `Brain Vision Data Exchange Header File Version 1.0
[Common Infos]
Codepage=UTF-8
DataFile=sample_eeg.eeg
DataFormat=BINARY
DataOrientation=MULTIPLEXED
NumberOfChannels=4
SamplingInterval=2000

[Binary Infos]
BinaryFormat=INT_16

[Channel Infos]
Ch1=Fp1,,0.5,µV
Ch2=Fp2,,0.5,µV
Ch3=Cz,,0.5,µV
Ch4=Pz,,0.5,µV
`;

test('BrainVision truncation: header truncated mid-channel entry throws (missing Ch3)', () => {
  // Remove channel Ch3 entirely — the parser expects channels 1..N to all exist.
  const txt = BASE_VHDR.replace('Ch3=Cz,,0.5,µV\n', '');
  assert.throws(() => BrainVisionReader.parseHeader(txt), /missing Ch3/);
});

test('BrainVision truncation: empty channel infos section throws', () => {
  const txt = BASE_VHDR.replace(/Ch1=.*\nCh2=.*\nCh3=.*\nCh4=.*\n/, '');
  assert.throws(() => BrainVisionReader.parseHeader(txt), /missing Ch1/);
});

test('BrainVision truncation: SamplingInterval=0 rejects with Invalid SamplingInterval', () => {
  const txt = BASE_VHDR.replace('SamplingInterval=2000', 'SamplingInterval=0');
  assert.throws(() => BrainVisionReader.parseHeader(txt), /Invalid SamplingInterval/);
});

test('BrainVision truncation: missing [Binary Infos] section throws', () => {
  const txt = BASE_VHDR.replace('[Binary Infos]\nBinaryFormat=INT_16\n', '');
  assert.throws(() => BrainVisionReader.parseHeader(txt), /missing required section/);
});

test('BrainVision truncation: missing [Common Infos] section throws', () => {
  const txt = BASE_VHDR.replace(/\[Common Infos\][\s\S]*?\n\n/, '');
  assert.throws(() => BrainVisionReader.parseHeader(txt), /missing required section/);
});
