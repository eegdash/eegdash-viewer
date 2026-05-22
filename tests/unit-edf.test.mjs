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

// Trailing-bytes tolerance: ds003343 in the wild has a BDF data section
// that's 768B short of a complete final record (29232B trailing — about
// 1 record's worth). MNE-Python rejects; we floor to complete records
// and warn. This integration test exercises the open() path end-to-end
// via the in-memory HttpRange registry to confirm:
//   1. open() does NOT throw on trailing bytes
//   2. n_samples reflects floor(data_bytes / record_size), not the
//      declared n_records, when they disagree
//   3. A warning fires
import { HttpRange } from './_bootstrap.mjs';

test('open: tolerates trailing partial record (ds003343 in the wild)', async () => {
  const sig = TWO_EEG;
  // Build a valid header, then append data: 5 complete records + 17
  // trailing bytes. record_size = 2 sigs × 256 spr × 2 bytes/sample = 1024B.
  const headerAB = buildHeader({ signals: sig, nRecords: 5, recDur: '1' });
  const recordSize = 2 * 256 * 2;
  const dataBytes = 5 * recordSize + 17;     // 17 trailing
  const data = new Uint8Array(dataBytes);    // zeros are fine for layout test
  // Mark each record's first int16 differently so we can verify slicing.
  const dv = new DataView(data.buffer);
  for (let r = 0; r < 5; r++) {
    dv.setInt16(r * recordSize, 1000 + r, true);
  }
  const total = new Uint8Array(headerAB.byteLength + data.byteLength);
  total.set(new Uint8Array(headerAB), 0);
  total.set(data, headerAB.byteLength);
  const blob = new Blob([total], { type: 'application/octet-stream' });
  const url = HttpRange.registerLocal('trailing-record-test.edf', blob);

  const origWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(msg);
  try {
    const rec = await EDFReader.open({ eeg_url: url, ext: 'edf', sibling_urls: {}, eeg_json: { raw: {} } });
    assert.equal(rec.n_channels, 2);
    // 5 complete records × 256 samples/record = 1280 samples.
    assert.equal(rec.n_samples, 1280, 'should floor to complete records');
    assert.ok(
      warnings.some(w => /trailing|not a multiple/.test(w)),
      `expected trailing-bytes warning, got: ${warnings.join(' | ')}`
    );
  } finally {
    console.warn = origWarn;
  }
});

test('parseHeader: warns on header_bytes / n_signals mismatch and uses spec formula', () => {
  // Hand-build a header where the declared header_bytes (999) contradicts
  // 256·(n_signals+1)=768. As of the ds003343 fix, the parser WARNS but
  // uses the spec-formula value rather than throwing — observed in the
  // wild on BIOSEMI BDF files that mis-declare header_bytes.
  // Use buildHeader to get valid signal records so parseHeader can complete.
  const sig = [TWO_EEG[0], TWO_EEG[1]];
  const headerBuf = buildHeader({ signals: sig });
  // buildHeader returns an ArrayBuffer; overwrite bytes 184-191
  // (header_bytes field) with bogus value "999".
  const view = new Uint8Array(headerBuf);
  const bogus = '999     ';
  for (let i = 0; i < 8; i++) view[184 + i] = bogus.charCodeAt(i);
  const origWarn = console.warn;
  let warned = '';
  console.warn = (msg) => { warned = msg; };
  try {
    const hdr = EDFReader.parseHeader(headerBuf);
    assert.equal(hdr.header_bytes_declared, 999);
    assert.equal(hdr.header_bytes_used, 256 * (sig.length + 1));
    assert.equal(hdr.header_bytes, hdr.header_bytes_used);
    assert.match(warned, /header_bytes field declares 999B but spec formula 256·\(2\+1\)=768B/);
  } finally {
    console.warn = origWarn;
  }
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
