#!/usr/bin/env node
/**
 * Synthesise a tiny CC0 BTi / 4D Neuroimaging (Magnes WH3600) MEG
 * directory bundle for testing formats/bti.js.
 *
 * Output: tests/fixtures/meg/bti-tiny/
 *   - config       (minimal binary header — enough to satisfy the
 *                   reader's smoke check; the actual data layout is
 *                   driven by the PDF tail header below)
 *   - c,rfDC       (the "PDF" / raw continuous data file. Naming
 *                   convention: the literal filename in real BTi
 *                   recordings encodes the filter applied during
 *                   acquisition. `c,rfDC` = "raw, filtered DC" =
 *                   no high-pass = the most common naming. Other
 *                   common names are c,rfhp1.0Hz (1.0 Hz HPF) and
 *                   c,rfhp0.1Hz (0.1 Hz HPF). All carry identical
 *                   binary structure.)
 *
 * Binary layout of c,rfDC (verified against MNE-Python's
 * mne/io/bti/bti.py `_read_bti_header_pdf` + mne/io/bti/read.py,
 * vendored to /tmp/mne_bti.py + /tmp/mne_bti_read.py):
 *
 *   offset 0..N         : raw data — interleaved per-sample, per-channel.
 *                         Per data_format below: float32 BE in this fixture.
 *                         Byte layout: data[t,c] at byte
 *                           (t * total_chans + c) * sample_size
 *   offset N..N+H-1     : the PDF header (variable-length section
 *                         described below). Header sits at the END of the
 *                         file, not at the beginning.
 *   offset -8 from end  : int64 BE pointing back to `header_position` =
 *                         N (the start of the header section). This is
 *                         how the reader discovers where the header lives.
 *
 * PDF header field layout (starts at header_position):
 *     +0   int16 BE  version          (= 2 here; arbitrary)
 *     +2   char[5]   file_type        ('BTi\x00\x00' here)
 *     +7   pad 1     (read_int16 above already produced 7-byte cursor;
 *                    MNE seeks +1)
 *     +8   int16 BE  data_format      (3 = float32 BE per DTYPES table)
 *     +10  int16 BE  acq_mode         (0 here; reader doesn't gate on it)
 *     +12  int32 BE  total_epochs     (= 1 here)
 *     +16  int32 BE  input_epochs     (= 1)
 *     +20  int32 BE  total_events     (= 0)
 *     +24  int32 BE  total_fixed_events (= 0)
 *     +28  float32 BE sample_period   (= 1 / sampling_freq, seconds)
 *     +32  char[16]  xaxis_label      ('Time\x00...' here)
 *     +48  int32 BE  total_processes  (= 0)
 *     +52  int16 BE  total_chans      (= 4 here)
 *     +54  pad 2
 *     +56  int32 BE  checksum         (= 0; not validated by reader)
 *     +60  int32 BE  total_ed_classes (= 0)
 *     +64  int16 BE  total_associated_files (= 0)
 *     +66  int16 BE  last_file_index  (= 0)
 *     +68  int32 BE  timestamp        (= 0)
 *     +72  pad 20
 *     +92  align-to-8 → +4 of padding → cursor at +96
 *     +96  epoch[0]                   56 bytes
 *           +0  int32 BE pts_in_epoch (= n_samples here)
 *           +4  float32 BE epoch_duration
 *           +8  float32 BE expected_iti (= 0)
 *           +12 float32 BE actual_iti   (= 0)
 *           +16 int32 BE total_var_events (= 0)
 *           +20 int32 BE checksum     (= 0)
 *           +24 int32 BE epoch_timestamp (= 0)
 *           +28 pad 28
 *     +152 channels (total_chans * 104 bytes each)
 *           per channel:
 *             +0   char[16] chan_label
 *             +16  int16 BE chan_no
 *             +18  int16 BE attributes
 *             +20  float32 BE scale
 *             +24  char[16] yaxis_label
 *             +40  int16 BE valid_min_max
 *             +42  pad 6
 *             +48  float64 BE ymin
 *             +56  float64 BE ymax
 *             +64  int32 BE index
 *             +68  int32 BE checksum
 *             +72  char[4] off_flag
 *             +76  float32 BE offset
 *             +80  pad 24
 *             = 104 bytes per channel
 *     +152 + 4*104 = +568   end of meaningful header
 *
 *   So PDF header_position = data_bytes; header size = 568; final 8-byte
 *   pointer makes total file = data_bytes + 568 + 8.
 *
 * Reference (vendored, BSD-3-clause):
 *   /tmp/mne_bti.py            _read_bti_header_pdf
 *   /tmp/mne_bti_read.py       read primitives (all BIG-ENDIAN)
 *   /tmp/mne_bti_constants.py  BTI.FILE_* and BTI.DATA_* constants
 *
 * Released under CC0.
 */
import fs from 'node:fs';
import path from 'node:path';

const N_CHANNELS  = 4;
const N_SAMPLES   = 500;
const SAMPLE_RATE = 100.0;
const SAMPLE_PERIOD = 1.0 / SAMPLE_RATE;
const DATA_FORMAT = 3;        // MNE DTYPES[3] = ">f4" (float32 BE)
const SAMPLE_SIZE = 4;        // bytes for float32

const outDir = path.resolve('tests/fixtures/meg/bti-tiny');
fs.mkdirSync(outDir, { recursive: true });

// ─── c,rfDC (PDF data file) ────────────────────────────────────────
// Order of operations:
//  1. Reserve a buffer big enough for data + header + 8-byte pointer.
//  2. Fill the data section first (per-channel sine waves, float32 BE).
//  3. Write the PDF header AFTER the data section.
//  4. Write the int64 BE pointer in the final 8 bytes.

const DATA_BYTES  = N_SAMPLES * N_CHANNELS * SAMPLE_SIZE;   // 500 * 4 * 4 = 8000
const HEADER_BYTES = 568;                                    // see file-level doc
const POINTER_BYTES = 8;
const FILE_BYTES = DATA_BYTES + HEADER_BYTES + POINTER_BYTES;

const buf = Buffer.alloc(FILE_BYTES, 0);

// ── data section (offset 0) ────────────────────────────────────────
// Per-channel sine waves at increasing frequency so the unit test can
// assert distinct values across channels and zero at t=0. Mirrors what
// scripts/make-kit-fixture.mjs + scripts/make-ctf-fixture.mjs do.
let off = 0;
for (let t = 0; t < N_SAMPLES; t++) {
  for (let c = 0; c < N_CHANNELS; c++) {
    const v = Math.sin(2 * Math.PI * (t / SAMPLE_RATE) * (c + 1));
    buf.writeFloatBE(v, off);
    off += SAMPLE_SIZE;
  }
}

// ── PDF header (offset = DATA_BYTES) ───────────────────────────────
const H = DATA_BYTES;

// +0  int16 BE  version = 2
buf.writeInt16BE(2, H + 0);
// +2  char[5]  file_type = 'BTi\0\0' — the reader doesn't validate the
//              exact contents; only the existence of a sensible header.
buf.write('BTi\0\0', H + 2, 5, 'ascii');
// +7  pad 1 (already zero) — cursor lands at +8.
// +8  int16 BE  data_format = 3 (float32 BE)
buf.writeInt16BE(DATA_FORMAT, H + 8);
// +10 int16 BE  acq_mode = 0
buf.writeInt16BE(0, H + 10);
// +12 int32 BE  total_epochs = 1
buf.writeInt32BE(1, H + 12);
// +16 int32 BE  input_epochs = 1
buf.writeInt32BE(1, H + 16);
// +20 int32 BE  total_events = 0
buf.writeInt32BE(0, H + 20);
// +24 int32 BE  total_fixed_events = 0
buf.writeInt32BE(0, H + 24);
// +28 float32 BE sample_period
buf.writeFloatBE(SAMPLE_PERIOD, H + 28);
// +32 char[16]  xaxis_label = 'Time'
buf.write('Time', H + 32, 16, 'ascii');
// +48 int32 BE  total_processes = 0
buf.writeInt32BE(0, H + 48);
// +52 int16 BE  total_chans = N_CHANNELS
buf.writeInt16BE(N_CHANNELS, H + 52);
// +54 pad 2 (zero) → cursor lands at +56
// +56 int32 BE  checksum = 0
buf.writeInt32BE(0, H + 56);
// +60 int32 BE  total_ed_classes = 0
buf.writeInt32BE(0, H + 60);
// +64 int16 BE  total_associated_files = 0
buf.writeInt16BE(0, H + 64);
// +66 int16 BE  last_file_index = 0
buf.writeInt16BE(0, H + 66);
// +68 int32 BE  timestamp = 0
buf.writeInt32BE(0, H + 68);
// +72..+91 pad 20 (zero). Cursor at +92.
// +92 _correct_offset(fid) aligns 92→96 (8-byte alignment). 4 pad bytes.
// +96 epochs[0] — 56 bytes
const E = H + 96;
buf.writeInt32BE(N_SAMPLES, E + 0);            // pts_in_epoch
buf.writeFloatBE(N_SAMPLES * SAMPLE_PERIOD, E + 4);  // epoch_duration
buf.writeFloatBE(0, E + 8);                    // expected_iti
buf.writeFloatBE(0, E + 12);                   // actual_iti
buf.writeInt32BE(0, E + 16);                   // total_var_events
buf.writeInt32BE(0, E + 20);                   // checksum
buf.writeInt32BE(0, E + 24);                   // epoch_timestamp
// +28..+55 pad 28 (zero). Cursor at E+56 = H+152.

// +152 channels: N_CHANNELS × 104 bytes. Real BTi files carry meaningful
// values here; for the synth we write the channel name and chan_no so a
// reader extension that DOES parse channel records gets something sane,
// but the reader the test exercises falls back to indexed labels.
const labels = ['A1', 'A2', 'A3', 'A4'];
let C = H + 152;
for (let c = 0; c < N_CHANNELS; c++) {
  // +0   char[16]  chan_label
  buf.write(labels[c], C + 0, Math.min(labels[c].length, 16), 'ascii');
  // +16  int16 BE  chan_no
  buf.writeInt16BE(c + 1, C + 16);
  // +18  int16 BE  attributes = 0
  buf.writeInt16BE(0, C + 18);
  // +20  float32 BE scale = 1.0 (units_per_bit applied at config level
  //                            for integer formats; for float32 data the
  //                            on-disk values already carry the unit so
  //                            scale=1.0 keeps them as-is)
  buf.writeFloatBE(1.0, C + 20);
  // +24  char[16]  yaxis_label = 'Tesla' (truncated — we leave zero pad)
  buf.write('Tesla', C + 24, 16, 'ascii');
  // +40  int16 BE  valid_min_max = 0
  buf.writeInt16BE(0, C + 40);
  // +42..+47 pad 6
  // +48  float64 BE ymin = -1.0
  buf.writeDoubleBE(-1.0, C + 48);
  // +56  float64 BE ymax =  1.0
  buf.writeDoubleBE(1.0, C + 56);
  // +64  int32 BE   index = c
  buf.writeInt32BE(c, C + 64);
  // +68  int32 BE   checksum = 0
  buf.writeInt32BE(0, C + 68);
  // +72  char[4]    off_flag = ''
  // +76  float32 BE offset = 0
  buf.writeFloatBE(0, C + 76);
  // +80..+103 pad 24
  C += 104;
}
// Cursor now at H + 152 + 4*104 = H + 568 = end of meaningful header.

// ── trailing int64 BE pointer ──────────────────────────────────────
// The last 8 bytes of the file hold `header_position` as int64 BE so
// the reader can seek backward from end-of-file to discover the header
// location. Per MNE this is read as `>u8`, so any value up to 2^31-1
// (FILE_MASK) is interpreted literally; larger values are AND-masked.
// Our header sits at H = DATA_BYTES = 8000 which is well under FILE_MASK,
// so we just write H directly.
buf.writeBigUInt64BE(BigInt(H), FILE_BYTES - 8);

fs.writeFileSync(path.join(outDir, 'c,rfDC'), buf);

// ─── config (system metadata) ──────────────────────────────────────
// The real BTi `config` file is a multi-megabyte binary with many
// user blocks (channel maps, calibration tables, weight tables, …).
// Our reader doesn't depend on it for opening the recording (the PDF
// tail header alone gives us nchan / srate / nsamples / dtype), so we
// emit a deliberately minimal config that's just present-but-empty.
// A future enhancement parses channel labels from this file's
// B_ch_labels user block — until then it's a placeholder.
//
// The first 78 bytes of the real config follow the layout in
// `_read_config` (mne/io/bti/bti.py:213-236):
//   int16  version
//   char[32] site_name
//   char[16] dap_hostname
//   int16  sys_type
//   int32  sys_options
//   int16  supply_freq
//   int16  total_chans
//   float32 system_fixed_gain
//   float32 volts_per_bit
//   int16  total_sensors
//   int16  total_user_blocks       ← we set this to 0 so the reader's
//                                    user-block loop terminates instantly
//   int16  next_der_chan_no
// followed by 2 pad bytes + uint32 checksum + char[32] reserved + transforms.
// For a "no user blocks, no sensors" config the structure collapses to
// just the fixed header — total ~80 bytes. We pad to 128 for safety.

const config = Buffer.alloc(128, 0);
let p = 0;
config.writeInt16BE(1, p); p += 2;                    // version = 1
config.write('bti-tiny-site', p, 32, 'ascii'); p += 32;
config.write('bti-tiny-host', p, 16, 'ascii'); p += 16;
config.writeInt16BE(0, p); p += 2;                    // sys_type
config.writeInt32BE(0, p); p += 4;                    // sys_options
config.writeInt16BE(50, p); p += 2;                   // supply_freq (Hz)
config.writeInt16BE(N_CHANNELS, p); p += 2;           // total_chans
config.writeFloatBE(1.0, p); p += 4;                  // system_fixed_gain
config.writeFloatBE(1.0, p); p += 4;                  // volts_per_bit
config.writeInt16BE(0, p); p += 2;                    // total_sensors = 0
config.writeInt16BE(0, p); p += 2;                    // total_user_blocks = 0
config.writeInt16BE(0, p); p += 2;                    // next_der_chan_no
// 2 pad bytes
p += 2;
// uint32 checksum (= 0)
config.writeUInt32BE(0, p); p += 4;
// char[32] reserved — already zero

fs.writeFileSync(path.join(outDir, 'config'), config);

console.log(
  `wrote ${outDir}/\n` +
    `  config  (${config.length} bytes — minimal stub)\n` +
    `  c,rfDC  (${FILE_BYTES} bytes — ${N_CHANNELS}ch × ${N_SAMPLES}@${SAMPLE_RATE}Hz, float32 BE)`,
);
