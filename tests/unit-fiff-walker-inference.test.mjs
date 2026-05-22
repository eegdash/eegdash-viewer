// Unit test for the K2 bisect-inference path in
// formats/_fiff-dir.js::buildDirectoryByHeaderWalk.
//
// Background — production observation on ds003703 (MNE-Python BSD-3
// MEG fixture, 1.3 GB FIFF): the walker made ~518 sequential 2-MB
// chunk fetches over ~3200 uniformly-sized DATA_BUFFER tags, costing
// 149s on Node from the public CDN. The fix: once we see K>=5
// consecutive uniform DATA_BUFFER headers inside FIFFB_RAW_DATA,
// galloping + bisect the end of the uniform run and synthesise the
// remaining entries arithmetically. This test pins that behaviour
// using a fetchRange mock that counts every call.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const FiffDir = require('../formats/_fiff-dir.js');

// FIFF tag constants (mirrored from formats/_fiff-dir.js).
const FIFF_FILE_ID     = 100;
const FIFF_DIR_POINTER = 101;
const FIFF_BLOCK_START = 104;
const FIFF_BLOCK_END   = 105;
const FIFF_DATA_BUFFER = 300;
const FIFFB_RAW_DATA   = 102;
const TYPE_INT32       = 3;
const TYPE_FLOAT32     = 4;

// 64 uniform 1-KB DATA_BUFFER tags. With INFER_THRESHOLD=5 the naive
// walker would issue ~N_BUFFERS chunk fetches (each buffer header
// lives in its own chunk because BUF_STRIDE > chunk size); the
// gallop+bisect path must stay logarithmic: O(log N) probes after
// the initial threshold walk. We assert the win by bounding total
// fetches WELL below N_BUFFERS — ds003703 had 3200 buffers and ~518
// fetches, so the ratio is what matters, not exact counts.
const N_BUFFERS = 64;
const BUF_PAYLOAD = 1024;        // 1 KB per buffer
const BUF_STRIDE  = 16 + BUF_PAYLOAD;

function writeTagBE(dv, off, kind, type, size, next) {
  dv.setInt32(off + 0,  kind, false);
  dv.setInt32(off + 4,  type, false);
  dv.setInt32(off + 8,  size, false);
  dv.setInt32(off + 12, next, false);
}

// Build a stream-writer FIFF with no end-of-file directory and a long
// uniform DATA_BUFFER run inside FIFFB_RAW_DATA.
//
// Layout:
//   0x00  FIFF_FILE_ID (size=20)
//   0x24  FIFF_DIR_POINTER payload=-1
//   0x38  FIFF_BLOCK_START FIFFB_RAW_DATA
//   0x4c  FIFF_DATA_BUFFER × 10 (each: 16 B header + 1024 B payload)
//   ...
//   END   FIFF_BLOCK_END FIFFB_RAW_DATA (next=-1)
function buildSyntheticUniformFiff() {
  const firstBufPos = 0x4c;
  const blockEndPos = firstBufPos + N_BUFFERS * BUF_STRIDE;
  const totalBytes  = blockEndPos + 16 + 4;
  const buf = new ArrayBuffer(totalBytes);
  const dv  = new DataView(buf);
  // FILE_ID
  writeTagBE(dv, 0x00, FIFF_FILE_ID, 31, 20, 0);
  // DIR_POINTER payload = -1 → no directory, walker is used.
  writeTagBE(dv, 0x24, FIFF_DIR_POINTER, TYPE_INT32, 4, 0);
  dv.setInt32(0x24 + 16, -1, false);
  // BLOCK_START FIFFB_RAW_DATA
  writeTagBE(dv, 0x38, FIFF_BLOCK_START, TYPE_INT32, 4, 0);
  dv.setInt32(0x38 + 16, FIFFB_RAW_DATA, false);
  // N_BUFFERS uniform DATA_BUFFER tags, float32, 1 KB payload each.
  for (let i = 0; i < N_BUFFERS; i++) {
    writeTagBE(dv, firstBufPos + i * BUF_STRIDE, FIFF_DATA_BUFFER, TYPE_FLOAT32, BUF_PAYLOAD, 0);
  }
  // BLOCK_END FIFFB_RAW_DATA with next=-1 → walker stops cleanly.
  writeTagBE(dv, blockEndPos, FIFF_BLOCK_END, TYPE_INT32, 4, -1);
  dv.setInt32(blockEndPos + 16, FIFFB_RAW_DATA, false);
  return { buf, totalBytes, firstBufPos, blockEndPos };
}

test('fiff-dir: inference path synthesises uniform DATA_BUFFER entries with few fetches', async () => {
  const { buf, totalBytes, firstBufPos, blockEndPos } = buildSyntheticUniformFiff();
  let fetchCount = 0;
  let bytesFetched = 0;
  const fetchRange = async (s, e) => {
    fetchCount++;
    bytesFetched += (e - s + 1);
    return buf.slice(s, e + 1);
  };
  // Use a tiny chunk so the OLD walker would issue ~N_BUFFERS fetches
  // (one per buffer). With inference active, total fetches must stay
  // well below N_BUFFERS — the gallop+bisect pattern is O(log N).
  const dir = await FiffDir.buildDirectoryByHeaderWalk(
    'https://example.invalid/synthetic-uniform.fif',
    totalBytes,
    fetchRange,
    { chunk: 64 },
  );

  // All N_BUFFERS DATA_BUFFER entries must be present (either walked
  // or synthesised), at the right positions, with the right size/type.
  const bufEntries = dir.entries.filter(e => e.kind === FIFF_DATA_BUFFER);
  assert.equal(bufEntries.length, N_BUFFERS,
    `expected ${N_BUFFERS} DATA_BUFFER entries, got ${bufEntries.length}`);
  for (let i = 0; i < N_BUFFERS; i++) {
    const e = bufEntries[i];
    const expectedPos = firstBufPos + i * BUF_STRIDE;
    assert.equal(e.position, expectedPos,
      `DATA_BUFFER[${i}] position ${e.position} != ${expectedPos}`);
    assert.equal(e.size, BUF_PAYLOAD, `DATA_BUFFER[${i}] size mismatch`);
    assert.equal(e.type, TYPE_FLOAT32, `DATA_BUFFER[${i}] type mismatch`);
  }

  // BLOCK_END after the uniform run must also be present — proves we
  // resumed normal walking after inference.
  const blockEnd = dir.entries.find(e => e.position === blockEndPos && e.kind === FIFF_BLOCK_END);
  assert.ok(blockEnd, 'BLOCK_END after uniform run must be walked');

  // Fetch budget. With INFER_THRESHOLD=5 and chunk=64, the walker
  // does the initial walk (FILE_ID + DIR_POINTER + BLOCK_START + 5
  // DATA_BUFFER headers ≈ 7-8 chunk fetches because each buffer
  // header lives in a fresh 64-byte chunk), then gallop+bisect probes
  // (each one 20-byte range fetch). For N_BUFFERS=64 with threshold=5,
  // gallop is at most log2(N/threshold)=4 probes, bisect at most
  // log2(N)=6 probes → ~10 probes max + ~10 walk fetches + a
  // couple to finish past inference. The naive walker would issue
  // ~N_BUFFERS=64 fetches; we expect well under half that.
  const NAIVE_BUDGET = N_BUFFERS;
  assert.ok(fetchCount < NAIVE_BUDGET / 2,
    `inference should produce far fewer fetches than the naive walker (got ${fetchCount}, expected < ${NAIVE_BUDGET / 2})`);

  // indexBlocks must consume synthesised entries identically to walked
  // ones — the shape contract that ds003703 depends on downstream.
  const blocks = FiffDir.indexBlocks(
    (pos) => dir.blockIds.get(pos) ?? null,
    dir.entries,
  );
  assert.ok(blocks.raw_data, 'RAW_DATA block must be indexed');
  assert.equal(blocks.raw_data.buffers.length, N_BUFFERS,
    'indexBlocks must enumerate all DATA_BUFFER tags including synthesised ones');
  for (let i = 0; i < N_BUFFERS; i++) {
    const b = blocks.raw_data.buffers[i];
    const expectedHeader = firstBufPos + i * BUF_STRIDE;
    assert.equal(b.headerOffset,  expectedHeader);
    assert.equal(b.payloadOffset, expectedHeader + 16);
    assert.equal(b.payloadSize,   BUF_PAYLOAD);
    assert.equal(b.miType,        TYPE_FLOAT32);
  }
});

test('fiff-dir: inference does NOT fire on heterogeneous DATA_BUFFER sizes', async () => {
  // Build a synthetic FIFF where the 3rd DATA_BUFFER has a different
  // size — the inference uniformity check must reject this and fall
  // back to normal walking. (Real-world case: MNE-Python truncates the
  // last buffer of a recording when the sample count isn't a clean
  // multiple of the buffer length.)
  const BUF1_PAYLOAD = 1024;
  const BUF2_PAYLOAD = 512;   // odd one out
  const STRIDE1 = 16 + BUF1_PAYLOAD;
  const STRIDE2 = 16 + BUF2_PAYLOAD;
  const firstBufPos = 0x4c;
  // Layout: 4 × 1024-byte buffers, then 1 × 512-byte buffer, then 4
  // more 1024-byte buffers (sizes mixed → never uniform).
  const layout = [];
  let off = firstBufPos;
  for (let i = 0; i < 4; i++) { layout.push({ off, size: BUF1_PAYLOAD }); off += STRIDE1; }
  layout.push({ off, size: BUF2_PAYLOAD });           off += STRIDE2;
  for (let i = 0; i < 4; i++) { layout.push({ off, size: BUF1_PAYLOAD }); off += STRIDE1; }
  const blockEndPos = off;
  const totalBytes  = blockEndPos + 16 + 4;
  const buf = new ArrayBuffer(totalBytes);
  const dv  = new DataView(buf);
  writeTagBE(dv, 0x00, FIFF_FILE_ID, 31, 20, 0);
  writeTagBE(dv, 0x24, FIFF_DIR_POINTER, TYPE_INT32, 4, 0);
  dv.setInt32(0x24 + 16, -1, false);
  writeTagBE(dv, 0x38, FIFF_BLOCK_START, TYPE_INT32, 4, 0);
  dv.setInt32(0x38 + 16, FIFFB_RAW_DATA, false);
  for (const { off: bufOff, size } of layout) {
    writeTagBE(dv, bufOff, FIFF_DATA_BUFFER, TYPE_FLOAT32, size, 0);
  }
  writeTagBE(dv, blockEndPos, FIFF_BLOCK_END, TYPE_INT32, 4, -1);
  dv.setInt32(blockEndPos + 16, FIFFB_RAW_DATA, false);

  const fetchRange = async (s, e) => buf.slice(s, e + 1);
  const dir = await FiffDir.buildDirectoryByHeaderWalk(
    'https://example.invalid/synthetic-mixed.fif',
    totalBytes,
    fetchRange,
    { chunk: 256 },
  );
  const bufEntries = dir.entries.filter(e => e.kind === FIFF_DATA_BUFFER);
  assert.equal(bufEntries.length, layout.length,
    'all DATA_BUFFER entries must be walked even though inference rejects mixed sizes');
  // Verify positions and sizes match the layout exactly.
  for (let i = 0; i < layout.length; i++) {
    assert.equal(bufEntries[i].position, layout[i].off);
    assert.equal(bufEntries[i].size,     layout[i].size);
  }
});

test('fiff-dir: inference path is skipped when fewer than threshold uniform buffers exist', async () => {
  // 3 DATA_BUFFER tags — below the threshold of 5. Walker must
  // enumerate all three via the normal path, no inference call.
  const firstBufPos = 0x4c;
  const N = 3;
  const PAYLOAD = 256;
  const STRIDE = 16 + PAYLOAD;
  const blockEndPos = firstBufPos + N * STRIDE;
  const totalBytes  = blockEndPos + 16 + 4;
  const buf = new ArrayBuffer(totalBytes);
  const dv  = new DataView(buf);
  writeTagBE(dv, 0x00, FIFF_FILE_ID, 31, 20, 0);
  writeTagBE(dv, 0x24, FIFF_DIR_POINTER, TYPE_INT32, 4, 0);
  dv.setInt32(0x24 + 16, -1, false);
  writeTagBE(dv, 0x38, FIFF_BLOCK_START, TYPE_INT32, 4, 0);
  dv.setInt32(0x38 + 16, FIFFB_RAW_DATA, false);
  for (let i = 0; i < N; i++) {
    writeTagBE(dv, firstBufPos + i * STRIDE, FIFF_DATA_BUFFER, TYPE_FLOAT32, PAYLOAD, 0);
  }
  writeTagBE(dv, blockEndPos, FIFF_BLOCK_END, TYPE_INT32, 4, -1);
  dv.setInt32(blockEndPos + 16, FIFFB_RAW_DATA, false);

  const fetchRange = async (s, e) => buf.slice(s, e + 1);
  const dir = await FiffDir.buildDirectoryByHeaderWalk(
    'https://example.invalid/synthetic-small.fif',
    totalBytes,
    fetchRange,
    { chunk: 128 },
  );
  const bufEntries = dir.entries.filter(e => e.kind === FIFF_DATA_BUFFER);
  assert.equal(bufEntries.length, N, 'all 3 walked entries present, no inference needed');
  for (let i = 0; i < N; i++) {
    assert.equal(bufEntries[i].position, firstBufPos + i * STRIDE);
  }
});
