#!/usr/bin/env node
/**
 * Synthesise a tiny CC0 CTF `.ds/` directory bundle for testing.
 *
 * Output: tests/fixtures/meg/ctf-tiny.ds/
 *   - ctf-tiny_meg.res4   (1844 + N*32 + N*1328 bytes, big-endian header)
 *   - ctf-tiny_meg.meg4   (8-byte magic + N*S*2 bytes interleaved int16 BE)
 *   - ctf-tiny_meg.acq    (text, dummy)
 *   - ctf-tiny_meg.hc     (text, dummy)
 *   - ctf-tiny_meg.hist   (text, dummy)
 *   - MarkerFile.mrk      (text, 2 markers)
 *   - BadChannels         (text, 1 entry)
 *
 * Reference: mne/io/ctf/res4.py for the binary layout (BSD-3, MIT-compatible).
 */
import fs from 'node:fs';
import path from 'node:path';

const N_CHANNELS = 4;
const N_SAMPLES_PER_TRIAL = 250;
const N_TRIALS = 1;
const SAMPLE_RATE = 100.0;
const CHANNEL_NAMES = ['MLT11-1609', 'MLT12-1609', 'MLT13-1609', 'EEG001'];
const SENSOR_TYPES = [9, 9, 9, 14]; // MEG, MEG, MEG, EEG

const outDir = path.resolve('tests/fixtures/meg/ctf-tiny.ds');
fs.mkdirSync(outDir, { recursive: true });
const prefix = 'ctf-tiny_meg';

// ---- .res4 ----------------------------------------------------------
const HEADER_FIXED = 1844;
const NAME_BYTES = 32;
const SENSOR_BYTES = 1328;
const res4Size = HEADER_FIXED + N_CHANNELS * (NAME_BYTES + SENSOR_BYTES);
const res4 = Buffer.alloc(res4Size, 0);

// Magic
res4.write('MEG41RS\x00', 0, 8, 'binary');

// Fixed-header field layout per MNE-Python's mne/io/ctf/res4.py.
// Verified empirically against real ds002001 + ds002908 .res4 files
// 2026-05-21. The previous offsets (1682/1684/1686/1690/1694 with
// int16/float32) landed in a zero-padded region and both code AND
// this fixture were wrong in lockstep — fixed together.
// no_samples (offset 1288, int32 BE)
res4.writeInt32BE(N_SAMPLES_PER_TRIAL, 1288);
// no_channels (offset 1292, int16 BE)
res4.writeInt16BE(N_CHANNELS, 1292);
// sample_rate (offset 1296, float64 BE)
res4.writeDoubleBE(SAMPLE_RATE, 1296);
// epoch_time (offset 1304, float64 BE)
res4.writeDoubleBE(N_SAMPLES_PER_TRIAL / SAMPLE_RATE, 1304);
// no_trials (offset 1312, int16 BE)
res4.writeInt16BE(N_TRIALS, 1312);

// Channel names: 32 bytes each, null-padded ASCII, starting at offset 1844
const namesOff = HEADER_FIXED;
for (let c = 0; c < N_CHANNELS; c++) {
  res4.write(CHANNEL_NAMES[c], namesOff + c * NAME_BYTES, NAME_BYTES, 'ascii');
}

// Sensor_res structs: 1328 bytes each, starting after names
const sensorOff = namesOff + N_CHANNELS * NAME_BYTES;
for (let c = 0; c < N_CHANNELS; c++) {
  const base = sensorOff + c * SENSOR_BYTES;
  res4.writeInt16BE(SENSOR_TYPES[c], base + 0);   // sensorTypeIndex
  res4.writeInt16BE(1, base + 2);                  // originalRunNum
  res4.writeInt32BE(0, base + 4);                  // coilShape
  res4.writeDoubleBE(1.0e-12, base + 8);           // properGain
  res4.writeDoubleBE(1.0, base + 16);              // qGain
  res4.writeDoubleBE(1.0, base + 24);              // ioGain
  res4.writeDoubleBE(0.0, base + 32);              // ioOffset
}

fs.writeFileSync(path.join(outDir, `${prefix}.res4`), res4);

// ---- .meg4 ----------------------------------------------------------
const meg4Size = 8 + N_TRIALS * N_SAMPLES_PER_TRIAL * N_CHANNELS * 2;
const meg4 = Buffer.alloc(meg4Size, 0);
meg4.write('MEG41CP\x00', 0, 8, 'binary');
let off = 8;
for (let t = 0; t < N_TRIALS; t++) {
  for (let s = 0; s < N_SAMPLES_PER_TRIAL; s++) {
    for (let c = 0; c < N_CHANNELS; c++) {
      const v = Math.round(1000 * Math.sin(2 * Math.PI * (s / SAMPLE_RATE) * (c + 1)));
      meg4.writeInt16BE(v, off);
      off += 2;
    }
  }
}
fs.writeFileSync(path.join(outDir, `${prefix}.meg4`), meg4);

// ---- text siblings --------------------------------------------------
fs.writeFileSync(path.join(outDir, `${prefix}.acq`),
  'acquisition: ctf-tiny synthetic\n');
fs.writeFileSync(path.join(outDir, `${prefix}.hc`),
  'standard nasion-coordinates\nx = 0\ny = 0\nz = 0\n');
fs.writeFileSync(path.join(outDir, `${prefix}.hist`),
  '2026-05-21: synthesised by scripts/make-ctf-fixture.mjs\n');
fs.writeFileSync(path.join(outDir, 'MarkerFile.mrk'),
  [
    'PATH OF DATASET:',
    '/synthetic/ctf-tiny.ds',
    '',
    'NUMBER OF MARKERS:',
    '1',
    '',
    'CLASSGROUPID:',
    '0',
    'NAME:',
    'Trigger1',
    'COMMENT:',
    '',
    'COLOR:',
    'red',
    'EDITABLE:',
    'Yes',
    'CLASSID:',
    '1',
    'NUMBER OF SAMPLES:',
    '2',
    'LIST OF SAMPLES:',
    'TRIAL NUMBER\t\tTIME FROM SYNC POINT (in seconds)',
    '                +0\t\t   +0.500000',
    '                +0\t\t   +1.250000',
    '',
  ].join('\n'));
fs.writeFileSync(path.join(outDir, 'BadChannels'),
  'EEG001\n');

console.log(`wrote ${outDir} (${fs.readdirSync(outDir).length} files)`);
