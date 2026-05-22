// Synthetic-input unit tests for the BrainVision parser. These
// exercise edge cases that only show up in pathological .vhdr files
// (comma-escaped channel names, IEEE_FLOAT_32, VECTORIZED orientation)
// without the cost of finding such a recording on OpenNeuro.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BrainVisionReader } from './_bootstrap.mjs';

// Standard well-formed .vhdr — every other test forks from this one.
const BASE_VHDR = `Brain Vision Data Exchange Header File Version 1.0
; canned for testing
[Common Infos]
Codepage=UTF-8
DataFile=sample_eeg.eeg
MarkerFile=sample_eeg.vmrk
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

test('parseIni: sections + key/value', () => {
  const sec = BrainVisionReader.parseIni(BASE_VHDR);
  assert.equal(sec['common infos'].DataFormat, 'BINARY');
  assert.equal(sec['binary infos'].BinaryFormat, 'INT_16');
  assert.equal(sec['channel infos'].Ch1, 'Fp1,,0.5,µV');
});

test('parseIni: comments stripped, blank lines ignored', () => {
  const txt = '; comment\n\n[Sec]\n; more\nKey=Value\n';
  const sec = BrainVisionReader.parseIni(txt);
  assert.equal(sec.sec.Key, 'Value');
});

test('parseIni: lower-cases section names so callers index uniformly', () => {
  const txt = '[Common Infos]\nA=1\n[BINARY infos]\nB=2\n';
  const sec = BrainVisionReader.parseIni(txt);
  assert.equal(sec['common infos'].A, '1');
  assert.equal(sec['binary infos'].B, '2');
});

test('parseHeader: derives fs from SamplingInterval (2000 µs → 500 Hz)', () => {
  const h = BrainVisionReader.parseHeader(BASE_VHDR);
  assert.equal(h.sampling_frequency, 500);
  assert.equal(h.bytes_per_sample, 2);
  assert.equal(h.binary_format, 'INT_16');
  assert.equal(h.n_channels, 4);
});

test('parseHeader: per-channel scale + name', () => {
  const h = BrainVisionReader.parseHeader(BASE_VHDR);
  assert.deepEqual(h.channels.map(c => c.name), ['Fp1', 'Fp2', 'Cz', 'Pz']);
  for (const c of h.channels) assert.equal(c.scale, 0.5);
});

test('parseHeader: comma in channel name is escaped as \\1', () => {
  // BrainVision spec allows literal commas inside fields encoded as
  // `\1`. The splitter restores them.
  const txt = BASE_VHDR.replace('Ch1=Fp1,,0.5,µV', 'Ch1=odd\\1name,,0.5,µV');
  const h = BrainVisionReader.parseHeader(txt);
  assert.equal(h.channels[0].name, 'odd,name');
});

test('parseHeader: missing channel resolution defaults to 1.0 in unit', () => {
  const txt = BASE_VHDR.replace('Ch1=Fp1,,0.5,µV', 'Ch1=Fp1,,,µV');
  const h = BrainVisionReader.parseHeader(txt);
  assert.equal(h.channels[0].scale, 1);
});

test('parseHeader: IEEE_FLOAT_32 → bps=4, view=Float32Array', () => {
  const txt = BASE_VHDR.replace('BinaryFormat=INT_16', 'BinaryFormat=IEEE_FLOAT_32');
  const h = BrainVisionReader.parseHeader(txt);
  assert.equal(h.bytes_per_sample, 4);
  assert.equal(h.binary_format, 'IEEE_FLOAT_32');
});

test('parseHeader: rejects DataFormat=ASCII', () => {
  const txt = BASE_VHDR.replace('DataFormat=BINARY', 'DataFormat=ASCII');
  assert.throws(() => BrainVisionReader.parseHeader(txt), /DataFormat=BINARY/);
});

test('parseHeader: accepts DataOrientation=VECTORIZED (now supported)', () => {
  // VECTORIZED is now a first-class layout. Header parse must succeed,
  // and the orientation must be surfaced on the returned hdr so the
  // reader can route to the per-channel range-fetch path.
  const txt = BASE_VHDR.replace('DataOrientation=MULTIPLEXED', 'DataOrientation=VECTORIZED');
  const hdr = BrainVisionReader.parseHeader(txt);
  assert.equal(hdr.orientation, 'VECTORIZED');
});

test('parseHeader: rejects unknown DataOrientation', () => {
  const txt = BASE_VHDR.replace('DataOrientation=MULTIPLEXED', 'DataOrientation=SPIRAL');
  assert.throws(() => BrainVisionReader.parseHeader(txt), /unknown DataOrientation/);
});

test('parseHeader: rejects unknown BinaryFormat', () => {
  const txt = BASE_VHDR.replace('BinaryFormat=INT_16', 'BinaryFormat=BIZARRE');
  assert.throws(() => BrainVisionReader.parseHeader(txt), /Unsupported BinaryFormat/);
});

test('parseHeader: rejects negative SamplingInterval', () => {
  const txt = BASE_VHDR.replace('SamplingInterval=2000', 'SamplingInterval=-1');
  assert.throws(() => BrainVisionReader.parseHeader(txt), /Invalid SamplingInterval/);
});

test('parseHeader: rejects missing required section', () => {
  const txt = BASE_VHDR.replace(/\[Channel Infos\][\s\S]*$/, '');
  assert.throws(() => BrainVisionReader.parseHeader(txt), /missing required section/);
});

test('parseHeader: rejects missing per-channel entry', () => {
  const txt = BASE_VHDR.replace('Ch3=Cz,,0.5,µV\n', '');
  assert.throws(() => BrainVisionReader.parseHeader(txt), /missing Ch3/);
});

test('parseHeader: DataPoints=NaN tolerated (logged but parsed as null)', () => {
  // .vhdr DataPoints field is optional and sometimes garbage. Should
  // not throw — `data_points_declared` falls back to null and the
  // open() path derives n_samples from file size instead.
  const txt = BASE_VHDR.replace('SamplingInterval=2000',
                                'SamplingInterval=2000\nDataPoints=garbage');
  const h = BrainVisionReader.parseHeader(txt);
  assert.equal(h.data_points_declared, null);
});
