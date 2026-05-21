#!/usr/bin/env node
/**
 * Synthesise a tiny CC0 KIT/Yokogawa/Ricoh `.con` file for testing
 * the formats/kit.js reader.
 *
 * Output: tests/fixtures/meg/kit-tiny.con
 *   - 8 directory entries (only DIR_INDEX_DIR/SYSTEM/ACQ_COND/RAW_DATA
 *     carry real payloads; the rest exist so dirs[8] and dirs[9] are
 *     reachable by linear index)
 *   - SYSTEM block: version=2, revision=4, nchan=4, adc_range=1.0
 *     (float64 because version=2 revision=4 falls into the > V2R3
 *     branch), adc_allocated=16, adc_stored=12
 *   - ACQ_COND block: acq_type=1 CONTINUOUS, sfreq=1000.0, n_samples=500
 *   - RAW_DATA: 500 samples × 4 channels × 2 bytes (int16 LE) interleaved
 *     deterministic sine waves at increasing frequency per channel.
 *
 * Reference: mne/io/kit/kit.py + mne/io/kit/constants.py (BSD-3-clause,
 * vendored to /tmp/kit_kit.py + /tmp/kit_constants.py for verification).
 * Layouts and constant values were cross-checked against those sources
 * on the date of authorship.
 *
 * All multi-byte values are LITTLE-ENDIAN (KIT files are written by a
 * KIT MEG Laboratory binary on Yokogawa hardware — little-endian on
 * disk per MNE-Python's `np.dtype("<i2")` / `np.dtype("<i4")` usage).
 */
import fs from 'node:fs';
import path from 'node:path';

const N_CHANNELS  = 4;
const N_SAMPLES   = 500;
const SAMPLE_RATE = 1000.0;
const ADC_RANGE   = 1.0;     // ± 0.5 V swing (matches MNE log "+/- 0.5[V]")
const ADC_ALLOC   = 16;      // 16-bit ADC → 2 bytes per sample
const ADC_STORED  = 12;      // 12 effective bits stored
const ACQ_TYPE_CONTINUOUS = 1;  // KIT.CONTINUOUS

const N_DIR_ENTRIES = 10;     // 0..9 inclusive — the highest index we
                              // need is 9 (RAW_DATA). Smaller files would
                              // also work if a hypothetical reader only
                              // peeks at SYSTEM/ACQ_COND/RAW_DATA, but
                              // we keep the full base set so the reader's
                              // bounds check (dirs.length > 9) succeeds.
const DIR_ENTRY_SIZE = 16;

// ---- byte layout ----------------------------------------------------
// SYSTEM block size — see formats/kit.js header for full field map.
// The reader only reads up to adc_stored (offset 728), so we don't
// need to pad beyond that. Use a fixed 740 to leave room for the
// final 3 int32s (adc_polarity, adc_allocated, adc_stored).
const SYSTEM_BLOCK_SIZE   = 740;
// ACQ_COND continuous block: int32 acq_type + float64 sfreq + int32
// samples_count + int32 n_samples = 20 bytes.
const ACQ_COND_BLOCK_SIZE = 20;
const RAW_DATA_BYTES      = N_SAMPLES * N_CHANNELS * (ADC_ALLOC / 8);

const DIR_TABLE_BYTES = N_DIR_ENTRIES * DIR_ENTRY_SIZE;
const OFF_SYSTEM   = DIR_TABLE_BYTES;
const OFF_ACQ_COND = OFF_SYSTEM   + SYSTEM_BLOCK_SIZE;
const OFF_RAW_DATA = OFF_ACQ_COND + ACQ_COND_BLOCK_SIZE;
const FILE_SIZE    = OFF_RAW_DATA + RAW_DATA_BYTES;

const buf = Buffer.alloc(FILE_SIZE, 0);

// ---- directory table (offset 0) -------------------------------------
// Each entry is 16 bytes (uint32 offset, int32 size, int32 max_count,
// int32 count). Entry 0 (DIR_INDEX_DIR) carries the total entry count
// in its `count` field — the reader uses dirs[0].count to discover
// how many more entries to read.
function writeDirEntry(idx, offset, size, max_count, count) {
  const base = idx * DIR_ENTRY_SIZE;
  buf.writeUInt32LE(offset,    base + 0);
  buf.writeInt32LE(size,       base + 4);
  buf.writeInt32LE(max_count,  base + 8);
  buf.writeInt32LE(count,      base + 12);
}

// Entry 0: DIR_INDEX_DIR — `count` holds N_DIR_ENTRIES so the reader
// knows how many entries to consume. offset/size of the dir-of-dirs is
// itself; we point at byte 0 with size=DIR_ENTRY_SIZE so any future
// stricter validation that reads `dirs[0]` as-a-block still succeeds.
writeDirEntry(0, 0, DIR_ENTRY_SIZE, N_DIR_ENTRIES, N_DIR_ENTRIES);
// Entry 1: DIR_INDEX_SYSTEM
writeDirEntry(1, OFF_SYSTEM, SYSTEM_BLOCK_SIZE, 1, 1);
// Entries 2,3,4,5,6,7 — placeholders. We zero-fill so the reader, which
// only deferences SYSTEM/ACQ_COND/RAW_DATA for the initial port, walks
// over them without dereferencing the offset.
writeDirEntry(2, 0, 0, 0, 0);
writeDirEntry(3, 0, 0, 0, 0);
writeDirEntry(4, 0, 0, 0, 0);   // DIR_INDEX_CHANNELS (offset=0, count=0)
writeDirEntry(5, 0, 0, 0, 0);   // DIR_INDEX_CALIBRATION
writeDirEntry(6, 0, 0, 0, 0);
writeDirEntry(7, 0, 0, 0, 0);   // DIR_INDEX_AMP_FILTER
// Entry 8: DIR_INDEX_ACQ_COND
writeDirEntry(8, OFF_ACQ_COND, ACQ_COND_BLOCK_SIZE, 1, 1);
// Entry 9: DIR_INDEX_RAW_DATA — size of one sample (per MNE this is
// adc_allocated/8 bytes); count = total interleaved samples (n_samples
// × nchan). The reader doesn't actually consult these fields for the
// raw data — it computes the byte range from start, nchan, sample_width
// — so any sensible values work.
writeDirEntry(9, OFF_RAW_DATA, ADC_ALLOC / 8, N_SAMPLES * N_CHANNELS, N_SAMPLES * N_CHANNELS);

// ---- SYSTEM block (offset = OFF_SYSTEM) ------------------------------
// Field layout — verified against /tmp/kit_kit.py get_kit_info (lines
// 535-575) on the date of authorship. All values little-endian.
const sys = OFF_SYSTEM;
buf.writeInt32LE(2,            sys + 0);    // version
buf.writeInt32LE(4,            sys + 4);    // revision (≥ 3 required)
buf.writeInt32LE(34,           sys + 8);    // sysid — KIT.SYSTEM_NYU_2010,
                                            // any registered ID works; we
                                            // pick one with a non-LEGACY_AMP
                                            // entry so the reader doesn't
                                            // hit unknown-format paths.
// system_name (128 bytes) — leave as zeros + write a short label.
buf.write('kit-tiny-system', sys + 12, Math.min('kit-tiny-system'.length, 128), 'ascii');
// model_name (128 bytes) at sys+140
buf.write('kit-tiny-model',  sys + 140, Math.min('kit-tiny-model'.length, 128), 'ascii');
// nchan at sys+268
buf.writeInt32LE(N_CHANNELS,   sys + 268);
// comment (256 bytes) at sys+272 — leave zeros.
// create_time, last_modified (int32 × 2) at sys+528
buf.writeInt32LE(0, sys + 528);
buf.writeInt32LE(0, sys + 532);
// reserved (3 × int32) at sys+536
// dewar_style (int32) at sys+548
buf.writeInt32LE(0, sys + 548);
// spare (3 × int32) at sys+552
// fll_type (int32) at sys+564 — set to 0 (the reader's only check is
// FLL membership for filter settings, which we don't surface here)
buf.writeInt32LE(0, sys + 564);
// spare (3 × int32) at sys+568
// trigger_type (int32) at sys+580
buf.writeInt32LE(0, sys + 580);
// spare (3 × int32) at sys+584
// adboard_type (int32) at sys+596
buf.writeInt32LE(0, sys + 596);
// reserved (29 × int32) at sys+600 — leaves us at sys+716.
// adc_range — float64 for version > 2 revision > 3 (our case: V2R4)
buf.writeDoubleLE(ADC_RANGE,   sys + 716);  // float64, 8 bytes
// adc_polarity, adc_allocated, adc_stored — int32 × 3, immediately after
buf.writeInt32LE(0,            sys + 724);  // adc_polarity
buf.writeInt32LE(ADC_ALLOC,    sys + 728);  // adc_allocated
buf.writeInt32LE(ADC_STORED,   sys + 732);  // adc_stored

// ---- ACQ_COND block (offset = OFF_ACQ_COND) --------------------------
const acq = OFF_ACQ_COND;
buf.writeInt32LE(ACQ_TYPE_CONTINUOUS, acq + 0);  // acq_type (CONTINUOUS=1)
buf.writeDoubleLE(SAMPLE_RATE,        acq + 4);  // sfreq (float64)
buf.writeInt32LE(0,                   acq + 12); // samples_count (skipped)
buf.writeInt32LE(N_SAMPLES,           acq + 16); // n_samples

// ---- RAW_DATA (offset = OFF_RAW_DATA) --------------------------------
// Interleaved per time step: sample[t,c] at OFF_RAW_DATA + (t*nchan + c)*2.
// Per-channel sine waves at increasing frequency — gives the test
// suite something to assert distinct-values on (mirrors what the CTF
// fixture does).
const SAMPLE_WIDTH = ADC_ALLOC / 8;
let off = OFF_RAW_DATA;
for (let t = 0; t < N_SAMPLES; t++) {
  for (let c = 0; c < N_CHANNELS; c++) {
    const v = Math.round(1000 * Math.sin(2 * Math.PI * (t / SAMPLE_RATE) * (c + 1)));
    buf.writeInt16LE(v, off);
    off += SAMPLE_WIDTH;
  }
}

const outPath = path.resolve('tests/fixtures/meg/kit-tiny.con');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, buf);

console.log(`wrote ${outPath} (${FILE_SIZE} bytes, ${N_CHANNELS}ch × ${N_SAMPLES}@${SAMPLE_RATE}Hz)`);
