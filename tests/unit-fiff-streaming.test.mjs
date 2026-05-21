// Streaming variant of the FIFF range reader. Asserts that
// readWindowStreaming yields chunks in monotonically increasing
// sample order, that each chunk's channels are correctly sized,
// and that the union of all chunks equals readWindow(start, n).
import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { FiffReader } from './_bootstrap.mjs';

// Reuse the synthetic builder; copy-paste from unit-fiff-range.test.mjs
// would create a maintenance hazard, so re-import it via a tiny shim.
// In production this lives in tests/_arbitraries.mjs but for v1 we
// duplicate the minimum.
function wTag(dv, off, kind, type, size, next) {
  dv.setInt32(off + 0,  kind, false);
  dv.setInt32(off + 4,  type, false);
  dv.setInt32(off + 8,  size, false);
  dv.setInt32(off + 12, next, false);
}

// Two buffers of 25 samples each (50 total), 2 channels — so streaming
// must yield 2 chunks for a 50-sample window. Uses a 1 MB padding
// region so the file is large enough for the tail-probe heuristic.
function buildTwoBufferFiff() {
  const PADDING_BYTES = 1024 * 1024;
  const buf = new ArrayBuffer(PADDING_BYTES + 4096);
  const dv  = new DataView(buf);
  let off = 0;
  wTag(dv, off, 100, 31, 20, 0); off += 36;
  // FIFF_DIR_POINTER — payload offset patched after we know dirOff.
  const dirPtrPayloadOff = off + 16;
  wTag(dv, off, 101, 3, 4, 0); off += 20;
  const measStart = off; wTag(dv, off, 104, 3, 4, 0); dv.setInt32(off + 16, 101, false); off += 20;
  const nchanPos = off; wTag(dv, off, 200, 3, 4, 0); dv.setInt32(off + 16, 2, false); off += 20;
  const sfreqPos = off; wTag(dv, off, 201, 4, 4, 0); dv.setFloat32(off + 16, 100.0, false); off += 20;
  const ch1Pos = off; wTag(dv, off, 203, 1, 96, 0);
  dv.setFloat32(off + 16 + 12, 1.0, false); dv.setFloat32(off + 16 + 16, 1.0, false); off += 112;
  const ch2Pos = off; wTag(dv, off, 203, 1, 96, 0);
  dv.setFloat32(off + 16 + 12, 1.0, false); dv.setFloat32(off + 16 + 16, 1.0, false); off += 112;
  const measEnd = off; wTag(dv, off, 105, 3, 4, 0); dv.setInt32(off + 16, 101, false); off += 20;
  const rawStart = off; wTag(dv, off, 104, 3, 4, 0); dv.setInt32(off + 16, 102, false); off += 20;
  const buf1Pos = off; wTag(dv, off, 300, 4, 200, 0);  // 25 samples × 2 × 4 = 200
  for (let i = 0; i < 50; i++) dv.setFloat32(off + 16 + i * 4, i * 0.01, false);
  off += 16 + 200;
  const buf2Pos = off; wTag(dv, off, 300, 4, 200, 0);
  for (let i = 0; i < 50; i++) dv.setFloat32(off + 16 + i * 4, (50 + i) * 0.01, false);
  off += 16 + 200;
  const rawEnd = off; wTag(dv, off, 105, 3, 4, 0); dv.setInt32(off + 16, 102, false); off += 20;
  off += PADDING_BYTES;
  off = (off + 15) & ~15;
  const dirOff = off;
  dv.setInt32(dirPtrPayloadOff, dirOff, false);
  const entries = [
    [100, 31, 20, 0],
    [101, 3, 4, 36],
    [104, 3, 4, measStart],
    [200, 3, 4, nchanPos], [201, 4, 4, sfreqPos],
    [203, 1, 96, ch1Pos], [203, 1, 96, ch2Pos],
    [105, 3, 4, measEnd],
    [104, 3, 4, rawStart],
    [300, 4, 200, buf1Pos], [300, 4, 200, buf2Pos],
    [105, 3, 4, rawEnd],
  ];
  wTag(dv, dirOff, 102, 3, entries.length * 16, -1);
  for (let i = 0; i < entries.length; i++) {
    const [k, t, s, p] = entries[i];
    const e = dirOff + 16 + i * 16;
    dv.setInt32(e + 0, k, false); dv.setInt32(e + 4, t, false);
    dv.setInt32(e + 8, s, false); dv.setInt32(e + 12, p, false);
  }
  return buf.slice(0, dirOff + 16 + entries.length * 16);
}

let mockSource;
beforeEach(() => {
  mockSource = buildTwoBufferFiff();
  globalThis.HttpRange.probeLength = async () => mockSource.byteLength;
  globalThis.HttpRange.rangeFetch  = async (_url, s, e) => mockSource.slice(s, e + 1);
});

test('fiff streaming: yields chunks in monotonic sample order', async () => {
  const reader = await FiffReader.open({ eeg_url: 'mock://2buf.fif' });
  assert.equal(typeof reader.readWindowStreaming, 'function');
  let lastEnd = -1;
  let nChunks = 0;
  for await (const chunk of reader.readWindowStreaming(0, reader.n_samples)) {
    assert.ok(chunk.firstSampleIdx >= lastEnd + 1 || lastEnd === -1);
    assert.ok(chunk.lastSampleIdx >= chunk.firstSampleIdx);
    assert.equal(chunk.channels.length, reader.n_channels);
    lastEnd = chunk.lastSampleIdx;
    nChunks++;
  }
  // 50 samples across 2 buffers → at least 2 chunks
  assert.ok(nChunks >= 2, `expected >= 2 chunks, got ${nChunks}`);
});

test('fiff streaming: union of chunks equals readWindow', async () => {
  const reader = await FiffReader.open({ eeg_url: 'mock://2buf.fif' });
  const baseline = await reader.readWindow(0, reader.n_samples);
  const collected = Array.from({ length: reader.n_channels }, () => new Float32Array(reader.n_samples));
  for await (const chunk of reader.readWindowStreaming(0, reader.n_samples)) {
    const w = chunk.lastSampleIdx - chunk.firstSampleIdx + 1;
    for (let c = 0; c < reader.n_channels; c++) {
      for (let t = 0; t < w; t++) collected[c][chunk.firstSampleIdx + t] = chunk.channels[c][t];
    }
  }
  for (let c = 0; c < reader.n_channels; c++) {
    for (let t = 0; t < reader.n_samples; t++) {
      assert.ok(Math.abs(collected[c][t] - baseline[c][t]) < 1e-6);
    }
  }
});
