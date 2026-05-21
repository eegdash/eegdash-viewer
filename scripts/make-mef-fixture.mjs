#!/usr/bin/env node
/**
 * Synthesise a tiny CC0 MEF3 `.mefd/` bundle for testing
 * formats/mef.js. The output is structurally valid (universal
 * headers carry the correct magic + CRC, metadata Section 2 carries
 * the documented sampling_frequency / n_samples fields) but the .tdat
 * file is filled with a placeholder pattern — the test reader is
 * Tier 1 (metadata only, throws on readWindow), so no actual RED
 * blocks need to be encoded.
 *
 * Output: tests/fixtures/ieeg/mef-tiny.mefd/
 *   - A1.timd/A1-000000.{tmet, tdat, tidx}
 *   - A2.timd/A2-000000.{tmet, tdat, tidx}
 *   - A3.timd/A3-000000.{tmet, tdat, tidx}
 *   - A4.timd/A4-000000.{tmet, tdat, tidx}
 *
 *   Each channel: 2500 samples @ 1000 Hz = 2.5 s recording.
 *
 * Reference: msel-source/meflib (Apache 2.0) — meflib.h byte
 * offsets used here are documented inline against the upstream
 * #define names so future maintainers can audit.
 *
 * All multi-byte values are LITTLE-ENDIAN (UH byte_order_code=1).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const require    = createRequire(import.meta.url);

// Load the parser so the fixture's CRC matches what the reader expects.
// _mef-segment.js attaches to globalThis on load.
require(path.resolve(__dirname, '..', 'formats', '_mef-segment.js'));
const MefSegment = globalThis.MefSegment;

// ---- recording parameters ----------------------------------------
const SESSION_NAME = 'mef-tiny';
const CHANNELS     = ['A1', 'A2', 'A3', 'A4'];
const N_SAMPLES    = 2500;
const SAMPLE_RATE  = 1000.0;
const N_BLOCKS     = 5;            // 500 samples per block (placeholder)

// ---- universal header constants (meflib.h L309-347) --------------
const UH_BYTES                       = 1024;
const UH_HEADER_CRC_OFFSET           = 0;
const UH_BODY_CRC_OFFSET             = 4;
const UH_FILE_TYPE_OFFSET            = 8;
const UH_MEF_VERSION_MAJOR_OFFSET    = 13;
const UH_MEF_VERSION_MINOR_OFFSET    = 14;
const UH_BYTE_ORDER_CODE_OFFSET      = 15;
const UH_START_TIME_OFFSET           = 16;
const UH_END_TIME_OFFSET             = 24;
const UH_NUMBER_OF_ENTRIES_OFFSET    = 32;
const UH_MAXIMUM_ENTRY_SIZE_OFFSET   = 40;
const UH_SEGMENT_NUMBER_OFFSET       = 48;
const UH_CHANNEL_NAME_OFFSET         = 52;
const UH_SESSION_NAME_OFFSET         = 308;

// ---- metadata section offsets (meflib.h L353-422) ----------------
const METADATA_SECTION_1_OFFSET             = UH_BYTES;     // 1024
const SECTION_1_BYTES                       = 1536;
const METADATA_SECTION_2_OFFSET             = 2560;
const SECTION_2_BYTES                       = 10752;
const METADATA_SECTION_3_OFFSET             = 13312;
const SECTION_3_BYTES                       = 3072;
const TMET_FILE_BYTES                       = METADATA_SECTION_3_OFFSET + SECTION_3_BYTES;  // 16384

const METADATA_SECTION_2_ENCRYPTION_OFFSET  = 1024;         // within sec1
const METADATA_SECTION_3_ENCRYPTION_OFFSET  = 1025;         // within sec1

// Time-series Section 2 offsets (relative to start of section 2):
const TSM2_SAMPLING_FREQUENCY_OFFSET        = 8720 - METADATA_SECTION_2_OFFSET;  // 6160
const TSM2_NUMBER_OF_SAMPLES_OFFSET         = 8920 - METADATA_SECTION_2_OFFSET;  // 6360
const TSM2_NUMBER_OF_BLOCKS_OFFSET          = 8928 - METADATA_SECTION_2_OFFSET;  // 6368
const TSM2_MAXIMUM_BLOCK_BYTES_OFFSET       = 8936 - METADATA_SECTION_2_OFFSET;  // 6376
const TSM2_MAXIMUM_BLOCK_SAMPLES_OFFSET     = 8944 - METADATA_SECTION_2_OFFSET;  // 6384

// ---- index entry constants (meflib.h L499-521) -------------------
const TSI_ENTRY_BYTES                       = 56;
const TSI_FILE_OFFSET_OFFSET                = 0;
const TSI_START_TIME_OFFSET                 = 8;
const TSI_START_SAMPLE_OFFSET               = 16;
const TSI_NUMBER_OF_SAMPLES_OFFSET          = 24;
const TSI_BLOCK_BYTES_OFFSET                = 28;

// ---- helpers -----------------------------------------------------

/**
 * Write the 1024-byte universal header into `buf` at offset 0.
 * Header CRC is computed AFTER all other fields are written. Body
 * CRC is supplied by the caller (it covers everything from offset
 * 1024 onwards — caller has to assemble that first, compute its CRC,
 * then pass it here).
 *
 * @param {Buffer} buf - output buffer (≥ 1024 bytes)
 * @param {string} fileTypeMagic - 4-char ASCII ('tmet', 'tdat', 'tidx')
 * @param {string} channelName
 * @param {number} segmentNumber
 * @param {number} numberOfEntries - meaningful for .tidx; 0 for others
 * @param {number} maximumEntrySize - meaningful for .tidx; 0 for others
 * @param {bigint} bodyCrc - CRC of bytes [1024..EOF), or 0n if no body
 */
function writeUniversalHeader(buf, fileTypeMagic, channelName, segmentNumber, numberOfEntries, maximumEntrySize, bodyCrc) {
  // Zero the whole UH region first.
  buf.fill(0, 0, UH_BYTES);
  // Magic at offset 8 (4 ASCII bytes; byte 12 left as 0 for null terminator).
  buf.write(fileTypeMagic, UH_FILE_TYPE_OFFSET, 4, 'ascii');
  // Version: MEF 3.0
  buf.writeUInt8(3, UH_MEF_VERSION_MAJOR_OFFSET);
  buf.writeUInt8(0, UH_MEF_VERSION_MINOR_OFFSET);
  // Byte order code: 1 = little endian
  buf.writeUInt8(1, UH_BYTE_ORDER_CODE_OFFSET);
  // Start/end times: μUTC. We use a fixed reasonable value so the test
  // can verify the start-time conversion. 2026-01-01 00:00:00 UTC =
  // 1767225600 seconds since the epoch.
  buf.writeBigInt64LE(1767225600000000n, UH_START_TIME_OFFSET);  // μUTC
  buf.writeBigInt64LE(1767225602500000n, UH_END_TIME_OFFSET);    // +2.5 s
  // Number of entries / maximum entry size — only meaningful for .tidx
  // (where it counts TSI entries) and record-data files. For .tmet/.tdat
  // we leave these as 0; the reader doesn't consult them.
  buf.writeBigInt64LE(BigInt(numberOfEntries), UH_NUMBER_OF_ENTRIES_OFFSET);
  buf.writeBigInt64LE(BigInt(maximumEntrySize), UH_MAXIMUM_ENTRY_SIZE_OFFSET);
  buf.writeInt32LE(segmentNumber, UH_SEGMENT_NUMBER_OFFSET);
  // Channel/session names — UTF-8, null-terminated. 256 bytes each.
  buf.write(channelName, UH_CHANNEL_NAME_OFFSET, Math.min(channelName.length, 255), 'utf-8');
  buf.write(SESSION_NAME, UH_SESSION_NAME_OFFSET, Math.min(SESSION_NAME.length, 255), 'utf-8');
  // Body CRC — written before computing header CRC.
  buf.writeUInt32LE(Number(bodyCrc) >>> 0, UH_BODY_CRC_OFFSET);
  // Header CRC: computed over bytes [4..1024). Written last (overwriting
  // the zeros we wrote in step 1 at offset 0).
  const headerCrc = MefSegment.crcCalculate(
    new Uint8Array(buf.buffer, buf.byteOffset, UH_BYTES), 4, UH_BYTES,
  );
  buf.writeUInt32LE(headerCrc >>> 0, UH_HEADER_CRC_OFFSET);
}

/**
 * Build one .tmet file (16384 bytes). The body — sections 1, 2, 3 —
 * is assembled first, its CRC computed, then the universal header
 * is written with that CRC in place.
 *
 * @param {string} channelName
 * @param {number} segmentNumber
 * @returns {Buffer}
 */
function buildTmet(channelName, segmentNumber) {
  const buf = Buffer.alloc(TMET_FILE_BYTES, 0);

  // ---- Section 1: encryption levels ------------------------------
  // signed byte 0 = NO_ENCRYPTION. Section 1 starts at offset 1024.
  buf.writeInt8(0, METADATA_SECTION_1_OFFSET + METADATA_SECTION_2_ENCRYPTION_OFFSET);
  buf.writeInt8(0, METADATA_SECTION_1_OFFSET + METADATA_SECTION_3_ENCRYPTION_OFFSET);

  // ---- Section 2: time-series metadata ---------------------------
  // sampling_frequency (sf8) and n_samples (si8) are the two fields
  // the reader consults. The rest of section 2 stays zero.
  const sec2 = METADATA_SECTION_2_OFFSET;
  buf.writeDoubleLE(SAMPLE_RATE, sec2 + TSM2_SAMPLING_FREQUENCY_OFFSET);
  buf.writeBigInt64LE(BigInt(N_SAMPLES), sec2 + TSM2_NUMBER_OF_SAMPLES_OFFSET);
  buf.writeBigInt64LE(BigInt(N_BLOCKS),  sec2 + TSM2_NUMBER_OF_BLOCKS_OFFSET);
  // maximum_block_bytes — placeholder (real RED blocks would carry
  // actual size). Use 304 (RED_BLOCK_HEADER_BYTES) so the reader's
  // sanity checks pass.
  buf.writeBigInt64LE(304n, sec2 + TSM2_MAXIMUM_BLOCK_BYTES_OFFSET);
  buf.writeUInt32LE(Math.ceil(N_SAMPLES / N_BLOCKS), sec2 + TSM2_MAXIMUM_BLOCK_SAMPLES_OFFSET);

  // ---- Section 3: discretionary — left zero ----------------------

  // Compute body CRC over bytes [1024..16384)
  const bodyCrc = MefSegment.crcCalculate(
    new Uint8Array(buf.buffer, buf.byteOffset, TMET_FILE_BYTES),
    UH_BYTES, TMET_FILE_BYTES,
  );

  writeUniversalHeader(buf, 'tmet', channelName, segmentNumber, 0, 0, BigInt(bodyCrc));
  return buf;
}

/**
 * Build one .tidx file. Layout: 1024-byte UH + N_BLOCKS * 56-byte
 * index entries. The reader's Tier 1 path doesn't actually consult
 * .tidx (it would for seek), but we ship a real file so the parseTidxEntry
 * helper has something to chew on.
 *
 * @param {string} channelName
 * @param {number} segmentNumber
 * @returns {Buffer}
 */
function buildTidx(channelName, segmentNumber) {
  const indexBytes = N_BLOCKS * TSI_ENTRY_BYTES;
  const fileBytes  = UH_BYTES + indexBytes;
  const buf = Buffer.alloc(fileBytes, 0);

  // Per-block index. Each block "owns" N_SAMPLES / N_BLOCKS samples.
  const samplesPerBlock = Math.floor(N_SAMPLES / N_BLOCKS);
  // Placeholder RED block size — 304 = RED_BLOCK_HEADER_BYTES (no body).
  const blockBytes = 304;
  for (let b = 0; b < N_BLOCKS; b++) {
    const base = UH_BYTES + b * TSI_ENTRY_BYTES;
    buf.writeBigInt64LE(BigInt(b * blockBytes), base + TSI_FILE_OFFSET_OFFSET);
    // start_time: μUTC of the block's first sample
    const startUUTC = 1767225600000000n + BigInt(Math.floor(b * samplesPerBlock * 1e6 / SAMPLE_RATE));
    buf.writeBigInt64LE(startUUTC, base + TSI_START_TIME_OFFSET);
    buf.writeBigInt64LE(BigInt(b * samplesPerBlock), base + TSI_START_SAMPLE_OFFSET);
    buf.writeUInt32LE(samplesPerBlock, base + TSI_NUMBER_OF_SAMPLES_OFFSET);
    buf.writeUInt32LE(blockBytes,      base + TSI_BLOCK_BYTES_OFFSET);
  }

  const bodyCrc = MefSegment.crcCalculate(
    new Uint8Array(buf.buffer, buf.byteOffset, fileBytes),
    UH_BYTES, fileBytes,
  );
  writeUniversalHeader(buf, 'tidx', channelName, segmentNumber, N_BLOCKS, TSI_ENTRY_BYTES, BigInt(bodyCrc));
  return buf;
}

/**
 * Build one .tdat file. Layout: 1024-byte UH + N_BLOCKS * 304-byte
 * placeholder bodies (no actual RED data — Tier 1 readWindow throws
 * before touching this file). The fixture exists for completeness
 * (the reader's listing step requires all three files to be present)
 * and to anchor a future RED-decoder test.
 *
 * @param {string} channelName
 * @param {number} segmentNumber
 * @returns {Buffer}
 */
function buildTdat(channelName, segmentNumber) {
  const blockBytes = 304;       // RED_BLOCK_HEADER_BYTES — body left as zeros
  const bodyBytes  = N_BLOCKS * blockBytes;
  const fileBytes  = UH_BYTES + bodyBytes;
  const buf = Buffer.alloc(fileBytes, 0);

  // Write the RED_BLOCK_BLOCK_BYTES_OFFSET field of each placeholder
  // block (offset 36 within the block) so a future RED decoder can at
  // least walk the block table. The other RED header fields stay zero.
  for (let b = 0; b < N_BLOCKS; b++) {
    const base = UH_BYTES + b * blockBytes;
    buf.writeUInt32LE(blockBytes, base + 36);  // RED_BLOCK_BLOCK_BYTES_OFFSET
  }

  const bodyCrc = MefSegment.crcCalculate(
    new Uint8Array(buf.buffer, buf.byteOffset, fileBytes),
    UH_BYTES, fileBytes,
  );
  writeUniversalHeader(buf, 'tdat', channelName, segmentNumber, 0, 0, BigInt(bodyCrc));
  return buf;
}

// ---- write the fixture -------------------------------------------

const outBase = path.resolve('tests/fixtures/ieeg/mef-tiny.mefd');
fs.mkdirSync(outBase, { recursive: true });

const segmentNumber = 0;
const segSuffix = '-' + String(segmentNumber).padStart(6, '0');

let totalBytes = 0;
for (const ch of CHANNELS) {
  const chDir = path.join(outBase, ch + '.timd');
  fs.mkdirSync(chDir, { recursive: true });

  const tmet = buildTmet(ch, segmentNumber);
  const tidx = buildTidx(ch, segmentNumber);
  const tdat = buildTdat(ch, segmentNumber);

  fs.writeFileSync(path.join(chDir, ch + segSuffix + '.tmet'), tmet);
  fs.writeFileSync(path.join(chDir, ch + segSuffix + '.tdat'), tdat);
  fs.writeFileSync(path.join(chDir, ch + segSuffix + '.tidx'), tidx);
  totalBytes += tmet.length + tdat.length + tidx.length;
}

console.log(`wrote ${outBase}/`);
console.log(`  ${CHANNELS.length} channels × {.tmet, .tdat, .tidx} = ${CHANNELS.length * 3} files`);
console.log(`  ${N_SAMPLES} samples @ ${SAMPLE_RATE} Hz = ${(N_SAMPLES / SAMPLE_RATE).toFixed(2)} s per channel`);
console.log(`  total bundle size: ${totalBytes} bytes`);
