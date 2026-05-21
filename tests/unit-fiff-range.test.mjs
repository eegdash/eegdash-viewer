// Unit tests for the range-based FIFF api.open path. Mocks
// HttpRange.{probeLength, rangeFetch} so we can construct a synthetic
// FIFF body, register it as a byte source, and assert that open():
//   1. Only fetches the directory tail + meas_info bytes (NOT the
//      whole file — important property: the byte-range index must
//      stay small for huge files).
//   2. Returns the correct n_samples / n_channels / sfreq.
//   3. Falls back to fetchBuffer when DIR_POINTER says -1.
import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { FiffReader, FiffDir, HttpRange } from './_bootstrap.mjs';

// ---- synthetic FIFF builder ---------------------------------------

const FIFF_FILE_ID     = 100;
const FIFF_DIR_POINTER = 101;
const FIFF_DIR         = 102;
const FIFF_BLOCK_START = 104;
const FIFF_BLOCK_END   = 105;
const FIFF_NCHAN       = 200;
const FIFF_SFREQ       = 201;
const FIFF_CH_INFO     = 203;
const FIFF_DATA_BUFFER = 300;
const FIFFB_MEAS_INFO  = 101;
const FIFFB_RAW_DATA   = 102;

function wTag(dv, off, kind, type, size, next) {
  dv.setInt32(off + 0,  kind, false);
  dv.setInt32(off + 4,  type, false);
  dv.setInt32(off + 8,  size, false);
  dv.setInt32(off + 12, next, false);
}

// Build a FIFF with 2 channels, sfreq=100 Hz, and one large data buffer
// of 50 samples preceded by 1 MB of synthetic FIFF_DATA_BUFFER padding
// so the file is big enough that the < 50% budget assertion is
// meaningful. The directory at the very end stays small.
//
// Layout:
//   [FIFF_FILE_ID][FIFF_DIR_POINTER → dirOff]
//   [BLOCK_START MEAS_INFO][NCHAN][SFREQ][CH_INFO×2][BLOCK_END MEAS_INFO]
//   [BLOCK_START RAW_DATA][FIFF_DATA_BUFFER (50 samples)][BLOCK_END RAW_DATA]
//   [PADDING — 1 MB of zero bytes outside any block, ignored by the walker]
//   [FIFF_DIR + entries]
function buildSyntheticFiff() {
  const PADDING_BYTES = 1024 * 1024;  // 1 MB pad → file is ~1 MB total
  const buf = new ArrayBuffer(PADDING_BYTES + 4096);
  const dv = new DataView(buf);
  let off = 0;
  // FIFF_FILE_ID
  wTag(dv, off, FIFF_FILE_ID, 31, 20, 0); off += 36;
  // FIFF_DIR_POINTER → directory placed after padding
  const dirPtrPayloadOff = off + 16;
  wTag(dv, off, FIFF_DIR_POINTER, 3, 4, 0); off += 20;
  // BLOCK_START MEAS_INFO
  const measStart = off;
  wTag(dv, off, FIFF_BLOCK_START, 3, 4, 0); dv.setInt32(off + 16, FIFFB_MEAS_INFO, false); off += 20;
  // FIFF_NCHAN = 2
  const nchanPos = off;
  wTag(dv, off, FIFF_NCHAN, 3, 4, 0); dv.setInt32(off + 16, 2, false); off += 20;
  // FIFF_SFREQ = 100.0
  const sfreqPos = off;
  wTag(dv, off, FIFF_SFREQ, 4, 4, 0); dv.setFloat32(off + 16, 100.0, false); off += 20;
  // 2× FIFF_CH_INFO (96 bytes each)
  const ch1Pos = off;
  wTag(dv, off, FIFF_CH_INFO, 1, 96, 0);
  for (let i = 0; i < 96; i++) dv.setUint8(off + 16 + i, 0);
  dv.setFloat32(off + 16 + 12, 1.0, false);
  dv.setFloat32(off + 16 + 16, 1.0, false);
  off += 112;
  const ch2Pos = off;
  wTag(dv, off, FIFF_CH_INFO, 1, 96, 0);
  for (let i = 0; i < 96; i++) dv.setUint8(off + 16 + i, 0);
  dv.setFloat32(off + 16 + 12, 1.0, false);
  dv.setFloat32(off + 16 + 16, 1.0, false);
  off += 112;
  // BLOCK_END MEAS_INFO
  const measEnd = off;
  wTag(dv, off, FIFF_BLOCK_END, 3, 4, 0); dv.setInt32(off + 16, FIFFB_MEAS_INFO, false); off += 20;
  // BLOCK_START RAW_DATA
  const rawStart = off;
  wTag(dv, off, FIFF_BLOCK_START, 3, 4, 0); dv.setInt32(off + 16, FIFFB_RAW_DATA, false); off += 20;
  // FIFF_DATA_BUFFER (type=4 float32, 50 samples × 2 chans × 4 = 400 bytes)
  const buf1Pos = off;
  wTag(dv, off, FIFF_DATA_BUFFER, 4, 400, 0);
  for (let i = 0; i < 100; i++) dv.setFloat32(off + 16 + i * 4, i * 0.01, false);
  off += 16 + 400;
  // BLOCK_END RAW_DATA
  const rawEnd = off;
  wTag(dv, off, FIFF_BLOCK_END, 3, 4, 0); dv.setInt32(off + 16, FIFFB_RAW_DATA, false); off += 20;
  // Padding region (off..off+PADDING_BYTES) — left zero-filled. The
  // walker never enters it because the directory entries don't index it.
  off += PADDING_BYTES;
  // Align to 16B boundary for the directory.
  off = (off + 15) & ~15;
  const dirOff = off;
  // Now write the directory pointer's payload to dirOff.
  dv.setInt32(dirPtrPayloadOff, dirOff, false);
  // FIFF_DIR
  const entries = [
    [FIFF_FILE_ID,     31, 20, 0],
    [FIFF_DIR_POINTER, 3,  4,  36],
    [FIFF_BLOCK_START, 3,  4,  measStart],
    [FIFF_NCHAN,       3,  4,  nchanPos],
    [FIFF_SFREQ,       4,  4,  sfreqPos],
    [FIFF_CH_INFO,     1,  96, ch1Pos],
    [FIFF_CH_INFO,     1,  96, ch2Pos],
    [FIFF_BLOCK_END,   3,  4,  measEnd],
    [FIFF_BLOCK_START, 3,  4,  rawStart],
    [FIFF_DATA_BUFFER, 4,  400, buf1Pos],
    [FIFF_BLOCK_END,   3,  4,  rawEnd],
  ];
  wTag(dv, dirOff, FIFF_DIR, 3, entries.length * 16, -1);
  for (let i = 0; i < entries.length; i++) {
    const [k, t, s, p] = entries[i];
    const eOff = dirOff + 16 + i * 16;
    dv.setInt32(eOff + 0,  k, false);
    dv.setInt32(eOff + 4,  t, false);
    dv.setInt32(eOff + 8,  s, false);
    dv.setInt32(eOff + 12, p, false);
  }
  const totalBytes = dirOff + 16 + entries.length * 16;
  return buf.slice(0, totalBytes);
}

// ---- shared mock: tracks every range request ----------------------

let mockSource;            // ArrayBuffer
let rangeRequestLog;       // [{ start, end }]

beforeEach(() => {
  mockSource = buildSyntheticFiff();
  rangeRequestLog = [];
  globalThis.HttpRange.probeLength = async () => mockSource.byteLength;
  globalThis.HttpRange.rangeFetch  = async (_url, start, endIncl) => {
    rangeRequestLog.push({ start, end: endIncl });
    return mockSource.slice(start, endIncl + 1);
  };
});

test('fiff range: open() fetches < 50% of total bytes', async () => {
  const reader = await FiffReader.open({ eeg_url: 'mock://synth.fif' });
  const totalFetched = rangeRequestLog.reduce(
    (acc, r) => acc + (r.end - r.start + 1),
    0,
  );
  assert.ok(
    totalFetched < mockSource.byteLength * 0.5,
    `open fetched ${totalFetched}B of ${mockSource.byteLength}B — should be < 50%`,
  );
  assert.equal(reader.n_channels, 2);
  assert.equal(reader.sampling_frequency, 100);
  assert.equal(reader.n_samples, 50);
});

test('fiff range: returns channel labels and duration', async () => {
  const reader = await FiffReader.open({ eeg_url: 'mock://synth.fif' });
  assert.equal(reader.channel_labels.length, 2);
  assert.equal(reader.duration_s, 0.5);  // 50 samples / 100 Hz
});

test('fiff range: falls back to fetchBuffer when DIR_POINTER = -1', async () => {
  // Rewrite the DIR_POINTER payload to -1 → no-directory file.
  const dv = new DataView(mockSource);
  dv.setInt32(0x24 + 16, -1, false);
  // The fallback path uses fetchBuffer. Mock it.
  let fetchBufferCalled = false;
  globalThis.HttpRange.fetchBuffer = async (url) => {
    fetchBufferCalled = true;
    return mockSource;
  };
  const reader = await FiffReader.open({ eeg_url: 'mock://synth-nodir.fif' });
  assert.equal(fetchBufferCalled, true, 'fallback must call fetchBuffer');
  assert.equal(reader.n_channels, 2);
});
