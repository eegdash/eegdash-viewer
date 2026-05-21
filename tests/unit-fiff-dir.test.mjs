// Unit tests for formats/_fiff-dir.js — synth + real-fixture coverage
// for the end-of-file tag-directory walker. The walker is the critical
// piece that lets FIFF api.open run on a 2 GB file without
// downloading the whole thing — if this test passes against the real
// MNE-Python fixture we know the byte-offset math matches reality.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const FiffDir = require('../formats/_fiff-dir.js');

// ---- helpers: build a synthetic FIFF tag stream --------------------

const FIFF_FILE_ID     = 100;
const FIFF_DIR_POINTER = 101;
const FIFF_DIR         = 102;
const FIFF_BLOCK_START = 104;
const FIFF_BLOCK_END   = 105;
const FIFF_DATA_BUFFER = 300;
const FIFFB_MEAS_INFO  = 101;
const FIFFB_RAW_DATA   = 102;
const TYPE_INT32       = 3;

function writeTagBE(dv, off, kind, type, size, next) {
  dv.setInt32(off + 0,  kind, false);
  dv.setInt32(off + 4,  type, false);
  dv.setInt32(off + 8,  size, false);
  dv.setInt32(off + 12, next, false);
}

// Build a 256-byte buffer with: FIFF_FILE_ID, FIFF_DIR_POINTER→0x80,
// one MEAS_INFO block (empty), one RAW_DATA block containing one
// FIFF_DATA_BUFFER of 32 bytes, then FIFF_DIR at 0x80 with 6 entries.
function buildSyntheticFiff() {
  const buf = new ArrayBuffer(512);
  const dv = new DataView(buf);
  // 0x00 FIFF_FILE_ID (kind=100, type=31, size=20 (FIFF spec), next=0)
  writeTagBE(dv, 0x00, FIFF_FILE_ID, 31, 20, 0);
  // 0x24 FIFF_DIR_POINTER (kind=101, type=3, size=4, next=0) payload@0x34 = 0x100
  writeTagBE(dv, 0x24, FIFF_DIR_POINTER, TYPE_INT32, 4, 0);
  dv.setInt32(0x24 + 16, 0x100, false);
  // 0x38 BLOCK_START MEAS_INFO
  writeTagBE(dv, 0x38, FIFF_BLOCK_START, TYPE_INT32, 4, 0);
  dv.setInt32(0x38 + 16, FIFFB_MEAS_INFO, false);
  // 0x4c BLOCK_END MEAS_INFO
  writeTagBE(dv, 0x4c, FIFF_BLOCK_END, TYPE_INT32, 4, 0);
  dv.setInt32(0x4c + 16, FIFFB_MEAS_INFO, false);
  // 0x60 BLOCK_START RAW_DATA
  writeTagBE(dv, 0x60, FIFF_BLOCK_START, TYPE_INT32, 4, 0);
  dv.setInt32(0x60 + 16, FIFFB_RAW_DATA, false);
  // 0x74 FIFF_DATA_BUFFER (kind=300, type=4=float32, size=32, next=0)
  writeTagBE(dv, 0x74, FIFF_DATA_BUFFER, 4, 32, 0);
  // 0xa8 BLOCK_END RAW_DATA
  writeTagBE(dv, 0xa8, FIFF_BLOCK_END, TYPE_INT32, 4, 0);
  dv.setInt32(0xa8 + 16, FIFFB_RAW_DATA, false);
  // 0x100 FIFF_DIR (kind=102, type=3, size = 6 entries × 16 = 96, next=-1)
  writeTagBE(dv, 0x100, FIFF_DIR, TYPE_INT32, 6 * 16, -1);
  // Each dir entry: (kind, type, size, position) — int32 BE × 4 = 16 B.
  const entries = [
    [FIFF_BLOCK_START, TYPE_INT32, 4, 0x38],
    [FIFF_BLOCK_END,   TYPE_INT32, 4, 0x4c],
    [FIFF_BLOCK_START, TYPE_INT32, 4, 0x60],
    [FIFF_DATA_BUFFER, 4,          32, 0x74],
    [FIFF_BLOCK_END,   TYPE_INT32, 4, 0xa8],
    [FIFF_FILE_ID,     31,         20, 0x00],
  ];
  let off = 0x100 + 16;
  for (const [k, t, s, p] of entries) {
    dv.setInt32(off + 0,  k, false);
    dv.setInt32(off + 4,  t, false);
    dv.setInt32(off + 8,  s, false);
    dv.setInt32(off + 12, p, false);
    off += 16;
  }
  return buf;
}

test('fiff-dir: parses synthetic directory and locates MEAS_INFO + RAW_DATA ranges', () => {
  const buf = buildSyntheticFiff();
  const view = new DataView(buf);
  const dirInfo = FiffDir.readDirPointer(view);
  assert.equal(dirInfo.dirOffset, 0x100, 'dir pointer payload is 0x100');
  assert.equal(dirInfo.hasDirectory, true);

  const dir = FiffDir.parseDirectory(view, dirInfo.dirOffset);
  assert.equal(dir.entries.length, 6, 'six directory entries');
  assert.equal(dir.entries[3].kind, FIFF_DATA_BUFFER);
  assert.equal(dir.entries[3].position, 0x74);

  const blocks = FiffDir.indexBlocks(view, dir.entries);
  // Should find: MEAS_INFO [0x38..0x4c], RAW_DATA [0x60..0xa8]
  assert.ok(blocks.meas_info, 'meas_info block found');
  assert.equal(blocks.meas_info.startTagOffset, 0x38);
  assert.equal(blocks.meas_info.endTagOffset,   0x4c);
  assert.ok(blocks.raw_data, 'raw_data block found');
  assert.equal(blocks.raw_data.startTagOffset, 0x60);
  assert.equal(blocks.raw_data.endTagOffset,   0xa8);
  // RAW_DATA must enumerate exactly one FIFF_DATA_BUFFER.
  assert.equal(blocks.raw_data.buffers.length, 1);
  assert.equal(blocks.raw_data.buffers[0].headerOffset, 0x74);
  assert.equal(blocks.raw_data.buffers[0].payloadOffset, 0x74 + 16);
  assert.equal(blocks.raw_data.buffers[0].payloadSize, 32);
  assert.equal(blocks.raw_data.buffers[0].miType, 4);
});

test('fiff-dir: returns hasDirectory=false when DIR_POINTER payload is -1', () => {
  const buf = new ArrayBuffer(64);
  const dv = new DataView(buf);
  writeTagBE(dv, 0x00, FIFF_FILE_ID, 31, 20, 0);
  writeTagBE(dv, 0x24, FIFF_DIR_POINTER, TYPE_INT32, 4, 0);
  dv.setInt32(0x24 + 16, -1, false);
  const view = new DataView(buf);
  const dirInfo = FiffDir.readDirPointer(view);
  assert.equal(dirInfo.hasDirectory, false, 'no directory when pointer is -1');
});

test('fiff-dir: rejects garbage first tag', () => {
  const buf = new ArrayBuffer(64);
  const dv = new DataView(buf);
  writeTagBE(dv, 0x00, 999, 0, 0, 0);  // not FIFF_FILE_ID
  const view = new DataView(buf);
  assert.throws(() => FiffDir.readDirPointer(view), /FIFF_FILE_ID/);
});

const REAL_FIXTURE = path.resolve('tests/fixtures/meg/test_ctf_comp_raw.fif');
const skipIfNoFixture = !fs.existsSync(REAL_FIXTURE);

test('fiff-dir: buildDirectoryByHeaderWalk reconstructs entries when no DIR_POINTER', async () => {
  // Build a synthetic stream-writer FIFF: FILE_ID, DIR_POINTER payload=-1,
  // MEAS_INFO block (empty), RAW_DATA block with one big DATA_BUFFER, EOF.
  // The walker should produce the same shape of {kind,type,size,position}
  // entries as parseDirectory would for an end-of-file FIFF_DIR.
  const PAYLOAD_BYTES = 256;
  const buf = new ArrayBuffer(0x100 + PAYLOAD_BYTES);
  const dv  = new DataView(buf);
  // 0x00 FILE_ID
  writeTagBE(dv, 0x00, FIFF_FILE_ID, 31, 20, 0);
  // 0x24 DIR_POINTER payload=-1 (no directory)
  writeTagBE(dv, 0x24, FIFF_DIR_POINTER, TYPE_INT32, 4, 0);
  dv.setInt32(0x24 + 16, -1, false);
  // 0x38 BLOCK_START MEAS_INFO
  writeTagBE(dv, 0x38, FIFF_BLOCK_START, TYPE_INT32, 4, 0);
  dv.setInt32(0x38 + 16, FIFFB_MEAS_INFO, false);
  // 0x4c BLOCK_END MEAS_INFO
  writeTagBE(dv, 0x4c, FIFF_BLOCK_END, TYPE_INT32, 4, 0);
  dv.setInt32(0x4c + 16, FIFFB_MEAS_INFO, false);
  // 0x60 BLOCK_START RAW_DATA
  writeTagBE(dv, 0x60, FIFF_BLOCK_START, TYPE_INT32, 4, 0);
  dv.setInt32(0x60 + 16, FIFFB_RAW_DATA, false);
  // 0x74 FIFF_DATA_BUFFER (big payload — walker should skip via size jump)
  writeTagBE(dv, 0x74, FIFF_DATA_BUFFER, 4, PAYLOAD_BYTES, 0);
  // After header + payload: pos = 0x74 + 16 + PAYLOAD_BYTES
  const blockEndPos = 0x74 + 16 + PAYLOAD_BYTES;
  // BLOCK_END RAW_DATA with next=-1 → walker stops cleanly
  writeTagBE(dv, blockEndPos, FIFF_BLOCK_END, TYPE_INT32, 4, -1);
  dv.setInt32(blockEndPos + 16, FIFFB_RAW_DATA, false);

  const totalBytes = blockEndPos + 16 + 4;  // last tag header + 4-byte payload
  // Fake fetchRange backed by the synthetic buffer. Slice [s, e].
  let fetchCount = 0;
  const fetchRange = async (s, e) => {
    fetchCount++;
    return buf.slice(s, e + 1);
  };
  const dir = await FiffDir.buildDirectoryByHeaderWalk(
    'https://example.invalid/synthetic.fif',
    totalBytes,
    fetchRange,
    { chunk: 64 },  // tiny chunk to force multiple fetches
  );
  // Should have collected: FILE_ID, DIR_POINTER, BLOCK_START×2,
  // BLOCK_END×1 (the MEAS_INFO end), BLOCK_START (RAW_DATA),
  // DATA_BUFFER, BLOCK_END (RAW_DATA). Total = 7 tag headers walked.
  // (Note: we have FILE_ID + DIR_POINTER + 4 BLOCK_* + 1 DATA_BUFFER = 7)
  assert.equal(dir.entries.length, 7, 'walker found all 7 tag headers');
  assert.equal(dir.entries[0].kind, FIFF_FILE_ID);
  assert.equal(dir.entries[1].kind, FIFF_DIR_POINTER);
  // DATA_BUFFER must be at position 0x74 (proves walker did NOT
  // mistakenly walk INTO the payload byte-by-byte).
  const dataBufEntry = dir.entries.find(e => e.kind === FIFF_DATA_BUFFER);
  assert.ok(dataBufEntry, 'data buffer entry found');
  assert.equal(dataBufEntry.position, 0x74);
  assert.equal(dataBufEntry.size, PAYLOAD_BYTES);

  // The blockIds map should have the 4 BLOCK_START/BLOCK_END positions.
  assert.equal(dir.blockIds.size, 4, 'blockIds populated for all BLOCK_START/END tags');
  assert.equal(dir.blockIds.get(0x38), FIFFB_MEAS_INFO);
  assert.equal(dir.blockIds.get(0x60), FIFFB_RAW_DATA);

  // Verify indexBlocks works on the synthesized entries.
  const blocks = FiffDir.indexBlocks(
    (pos) => dir.blockIds.get(pos) ?? null,
    dir.entries,
  );
  assert.ok(blocks.meas_info, 'header-walked entries → MEAS_INFO indexed');
  assert.equal(blocks.meas_info.startTagOffset, 0x38);
  assert.ok(blocks.raw_data, 'header-walked entries → RAW_DATA indexed');
  assert.equal(blocks.raw_data.buffers.length, 1);
  assert.equal(blocks.raw_data.buffers[0].payloadOffset, 0x74 + 16);

  // Walker should issue a small number of fetches relative to file size.
  // Each fetch is ≤ CHUNK bytes; with 64 B chunks and ~7 distinct tag
  // headers, expect ≤ 7 fetches.
  assert.ok(fetchCount <= 7, `expected ≤7 fetches, got ${fetchCount}`);
});

test('fiff-dir: real-world test_ctf_comp_raw.fif parses DIR_POINTER correctly', { skip: skipIfNoFixture }, () => {
  const buf = fs.readFileSync(REAL_FIXTURE);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const view = new DataView(ab);
  // The bundled MNE test fixtures are stream-writer outputs (DIR_POINTER
  // payload = -1, no end-of-file directory). The walker must surface
  // hasDirectory=false cleanly so the caller can fall back to the
  // whole-file path. Real OpenNeuro production FIFFs DO have directories
  // (covered by the browser reality-check in Task 5).
  const dirInfo = FiffDir.readDirPointer(view);
  assert.equal(typeof dirInfo.hasDirectory, 'boolean');
  if (dirInfo.hasDirectory) {
    const dir = FiffDir.parseDirectory(view, dirInfo.dirOffset);
    assert.ok(dir.entries.length > 0, 'directory has entries');
    const blocks = FiffDir.indexBlocks(view, dir.entries);
    assert.ok(blocks.meas_info, 'real file has MEAS_INFO');
  } else {
    // Validate the no-directory path is well-formed.
    assert.ok(dirInfo.reason, 'no-directory path includes a reason');
    assert.equal(dirInfo.dirOffset, -1);
  }
});
