#!/usr/bin/env node
/**
 * Synthesise a tiny CC0 ITAB (Chieti ARGOS) MEG fixture pair for testing
 * the formats/itab.js reader.
 *
 * Outputs:
 *   tests/fixtures/meg/itab-tiny.raw      — binary header followed by data
 *   tests/fixtures/meg/itab-tiny.mhd      — sidecar copy of the header
 *
 * Binary layout follows FieldTrip's `fileio/private/read_itab_mhd.m`
 * (BSD-3-clause, vendored to /tmp/read_itab_mhd.m at the time of
 * authorship). Field offsets and sizes were enumerated from that source
 * top-to-bottom; the canonical map is documented in formats/itab.js's
 * header block. ALL multi-byte values are LITTLE-ENDIAN on disk
 * (data_type=5 = LE_FLOAT, matching FieldTrip's `ieee-le` branch in
 * ft_read_data.m).
 *
 * The fixture deliberately compresses the on-disk header to the smallest
 * span that still includes the per-channel records the reader needs:
 *   - All scalar fields up to `isns` (last interesting scalar) are
 *     populated.
 *   - The per-channel array carries only N_CHANNELS records (vs. the
 *     640-channel maximum in the real binary). The reader stops at
 *     nchan, so the missing 636 records cannot trip it up.
 *   - `start_data` is set to the byte just past the last channel record,
 *     i.e. data begins at offset 87,040 (= 85,444 + 4 × 328 = 86,756,
 *     rounded up to 64-byte alignment — alignment matches FieldTrip's
 *     production files, where data starts at a multiple of 256 or 512).
 *   - Everything between the last channel record and `start_data` is
 *     zero-padded — a real ITAB file would carry sensor-position /
 *     marker / filter data here, but the reader doesn't dereference any
 *     of those.
 *
 * The `.mhd` sidecar is the same byte-for-byte content as the `.raw`
 * file's binary header. In real ITAB recordings the two files agree on
 * the scalar fields but the sidecar may carry post-acquisition edits
 * (sensor positions refit, additional markers); for our happy-path
 * fixture we synthesise them identical.
 */
import fs from 'node:fs';
import path from 'node:path';

const N_CHANNELS  = 4;
const N_SAMPLES   = 500;
const SAMPLE_RATE = 1000.0;
const DATA_TYPE   = 5;          // 5 = LE_FLOAT (Intel little-endian float)

// Offsets enumerated from read_itab_mhd.m (see formats/itab.js header).
// We mirror the constants in the reader so a single source of truth
// drives both sides; if you change one, change the other.
const OFF_STNAME            = 0;     // 10 bytes
const OFF_STVER             = 10;    // 8 bytes
const OFF_STENDIAN          = 18;    // 4 bytes
const OFF_NCHAN             = 684;
const OFF_DATA_TYPE         = 720;
const OFF_SMPFQ             = 724;
const OFF_NTPDATA           = 748;
const OFF_START_DATA        = 85428;
const OFF_ISNS              = 85440;
const OFF_CH_ARRAY          = 85444;
const CH_RECORD_SIZE        = 328;

// Where binary data starts inside .raw. Must clear the per-channel
// records the reader reads (offsets 85,444 .. 85,444 + nchan × 328).
// 87,040 = next 64-byte-aligned offset past 85,444 + 4 × 328 = 86,756.
const START_DATA            = 87040;
const SAMPLE_BYTES          = 4;     // float32 LE per data_type=5
const DATA_BYTES            = N_SAMPLES * N_CHANNELS * SAMPLE_BYTES;
const FILE_SIZE             = START_DATA + DATA_BYTES;

const buf = Buffer.alloc(FILE_SIZE, 0);

// ---- header identification block ------------------------------------
// "FORMAT: ATB-BIOMAGDATA" is what FieldTrip's filetype detector looks
// for in the leading bytes — it splits cleanly across stname/stver/
// stendian: "FORMAT: AT" (10) + "B-BIOMAG" (8) + "DATA" (4) = 22.
// (Verified: this is the binary "header identifier" FieldTrip's
// ft_filetype.m matches on. Reading the 22 bytes as ASCII reconstructs
// the BIDS-MEG appendix's "ASCII header" prose without making the rest
// of the file ASCII.)
buf.write('FORMAT: AT',    OFF_STNAME,    10, 'ascii');  // stname[10]
buf.write('B-BIOMAG',      OFF_STVER,      8, 'ascii');  // stver[8]
buf.write('DATA',          OFF_STENDIAN,   4, 'ascii');  // stendian[4]

// ---- scalar metadata --------------------------------------------------
buf.writeInt32LE(N_CHANNELS,   OFF_NCHAN);
buf.writeInt32LE(DATA_TYPE,    OFF_DATA_TYPE);
buf.writeFloatLE(SAMPLE_RATE,  OFF_SMPFQ);
buf.writeInt32LE(N_SAMPLES,    OFF_NTPDATA);
buf.writeInt32LE(START_DATA,   OFF_START_DATA);
// isns = 153 (Original Chieti 153 ch. helmet) — the canonical sensor
// code for ARGOS-153 systems per read_itab_mhd.m's comments. Carried
// for parity with real files; the reader doesn't gate on it.
buf.writeInt32LE(153,          OFF_ISNS);

// ---- per-channel records ----------------------------------------------
// Layout per channel (328 bytes), from read_itab_mhd.m. We only
// populate the fields the reader consumes — type, label, calib, unit —
// plus 1 byte of `flag` so a future check for "noisy/broken" channels
// has something non-zero to read against.
//
// Channel types per ITAB convention:
//   1 = ele (EEG), 2 = mag (MEG)
// Our fixture mimics a real ARGOS recording: 3 MEG + 1 reference auxiliary.
const CH_TYPE = [2, 2, 2, 16];        // mag, mag, mag, aux
const CH_LABELS = ['MAG001', 'MAG002', 'MAG003', 'AUX001'];
const CH_CALIBS = [1.0, 1.0, 1.0, 1.0];  // unity calibration → samples
                                          // come out as the raw float32
                                          // values we wrote, divided by
                                          // 1 (i.e. unchanged).
const CH_UNITS  = ['fT',   'fT',   'fT',   'V'];

for (let c = 0; c < N_CHANNELS; c++) {
  const base = OFF_CH_ARRAY + c * CH_RECORD_SIZE;
  // Layout inside one channel record:
  //   +0   uint8     type
  //   +1   uint8[3]  pad
  //   +4   int32     number
  //   +8   char[16]  label
  //   +24  uint8     flag
  //   +25  uint8[3]  pad
  //   +28  float     amvbit
  //   +32  float     calib
  //   +36  char[6]   unit
  //   +42  uint8[2]  pad
  //   +44  int32     ncoils
  //   +48  float[10] wgt
  //   +88  10x(position) — each: float[3] r_s + float[3] u_s = 24 B
  //   +328 end
  buf.writeUInt8(CH_TYPE[c],            base + 0);
  buf.writeInt32LE(c + 1,               base + 4);   // number
  buf.write(CH_LABELS[c], base + 8, Math.min(CH_LABELS[c].length, 16), 'ascii');
  buf.writeUInt8(0,                     base + 24);  // flag = working
  buf.writeFloatLE(1.0,                 base + 28);  // amvbit
  buf.writeFloatLE(CH_CALIBS[c],        base + 32);  // calib
  buf.write(CH_UNITS[c], base + 36, Math.min(CH_UNITS[c].length, 6), 'ascii');
  buf.writeInt32LE(1,                   base + 44);  // ncoils
  // wgt[10] and position[10] left zero — the viewer's value contract
  // doesn't depend on coil geometry.
}

// ---- raw data (float32 LE, interleaved per time step) -----------------
// Sample[t,c] at byte START_DATA + (t * nchan + c) * 4. Per-channel
// sine waves at increasing frequency — mirrors what kit-tiny + ctf-tiny
// do, giving the test suite a "channels must differ" assertion that
// kills any de-interleave mutant that reads the same byte across
// channels.
let off = START_DATA;
for (let t = 0; t < N_SAMPLES; t++) {
  for (let c = 0; c < N_CHANNELS; c++) {
    const v = Math.sin(2 * Math.PI * (t / SAMPLE_RATE) * (c + 1));
    buf.writeFloatLE(v, off);
    off += SAMPLE_BYTES;
  }
}

// ---- write .raw + .mhd ------------------------------------------------
const outRaw = path.resolve('tests/fixtures/meg/itab-tiny.raw');
const outMhd = path.resolve('tests/fixtures/meg/itab-tiny.mhd');
fs.mkdirSync(path.dirname(outRaw), { recursive: true });

fs.writeFileSync(outRaw, buf);
// The .mhd sidecar is just the header portion (START_DATA bytes) of the
// .raw file. In real ITAB recordings the sidecar tends to be slightly
// modified (e.g. post-acquisition sensor refits), but for the happy
// path we keep them identical so the reader's "trust sidecar over raw"
// logic — if/when added — has a stable starting point.
fs.writeFileSync(outMhd, buf.subarray(0, START_DATA));

console.log(
  `wrote ${outRaw} (${FILE_SIZE} bytes, ${N_CHANNELS}ch × ${N_SAMPLES}@${SAMPLE_RATE}Hz)`,
);
console.log(`wrote ${outMhd} (${START_DATA} bytes, header only)`);
