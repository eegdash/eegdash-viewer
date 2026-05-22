// Unit tests for formats/mef.js — MEF3 (Mayo Clinic Multiscale
// Electrophysiology Format v3) iEEG reader.
//
// Tier achieved: 3 (full sample decode via RED). readWindow now
// returns decoded sample windows. The tests below verify:
//   - universal header parsing (magic, version, CRC, channel name)
//   - .tmet metadata section 2 fields (sample_rate, n_samples)
//   - the reader's contract: n_channels, sampling_frequency, etc.
//   - readWindow decodes RED blocks against a known sine fixture
//   - block-boundary windows are stitched correctly
//   - encrypted recordings are rejected up-front
//
// Fixture: tests/fixtures/ieeg/mef-tiny.mefd/ (synthesised, CC0 —
// see scripts/make-mef-fixture.mjs). 4 channels (A1..A4) × 2500
// samples @ 1000 Hz = 2.5 s per channel.
//
// Each fixture channel carries a deterministic sine wave:
//   A1: 10 Hz, A2: 20 Hz, A3: 40 Hz, A4: 80 Hz; amplitude 1000.
// The encoder is a literal port of meflib's RED_encode_exec; the
// decoder is a literal port of RED_decode. Round-trip success on
// the fixture is therefore the strongest verification we have
// without external binary test vectors (none are published by
// upstream meflib).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
// Helpers attach to globalThis on require — load before mef.js.
require('../formats/_buffers.js');
require('../formats/_labels.js');
require('../formats/_decode.js');
require('../formats/_mef-segment.js');
require('../formats/_mef-red.js');
const MefReader = require('../formats/mef.js');

// Deterministic sine generator — must match scripts/make-mef-fixture.mjs.
const CHANNEL_FREQ = { A1: 10, A2: 20, A3: 40, A4: 80 };
const SAMPLE_RATE  = 1000;
function expectedSample(chName, i) {
  // Normalise -0 → +0 so equality against a Float32Array read (which
  // canonicalises to +0) matches.
  const v = Math.round(1000 * Math.sin(2 * Math.PI * CHANNEL_FREQ[chName] * i / SAMPLE_RATE));
  return v === 0 ? 0 : v;
}

const FIXTURE_DIR = path.resolve('tests/fixtures/ieeg/mef-tiny.mefd');
const FIXTURE_URL = 'file://' + FIXTURE_DIR + '/';
const SEG = '-000000';
const CHANNELS = ['A1', 'A2', 'A3', 'A4'];

function readBuf(rel) {
  const b = fs.readFileSync(rel);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

// ─── _mef-segment.js parser tests ─────────────────────────────────

test('mef-segment: parseUniversalHeader rejects truncated buffer', () => {
  assert.throws(
    () => globalThis.MefSegment.parseUniversalHeader(new ArrayBuffer(512)),
    /universal header needs 1024 bytes/,
  );
});

test('mef-segment: parseUniversalHeader reads magic + channel name + version', () => {
  const tmetPath = path.join(FIXTURE_DIR, 'A1.timd', 'A1' + SEG + '.tmet');
  const ab = readBuf(tmetPath);
  const uh = globalThis.MefSegment.parseUniversalHeader(ab);
  assert.equal(uh.file_type, 'tmet', 'magic must be tmet');
  assert.equal(uh.mef_version_major, 3);
  assert.equal(uh.mef_version_minor, 0);
  assert.equal(uh.byte_order_code, 1, 'little-endian');
  assert.equal(uh.channel_name, 'A1');
  assert.equal(uh.session_name, 'mef-tiny');
  assert.equal(uh.segment_number, 0);
  assert.equal(uh.level_1_encrypted, false);
  assert.equal(uh.level_2_encrypted, false);
});

test('mef-segment: universal header CRC validates against the fixture', () => {
  const tmetPath = path.join(FIXTURE_DIR, 'A1.timd', 'A1' + SEG + '.tmet');
  const ab = readBuf(tmetPath);
  const bytes = new Uint8Array(ab, 0, 1024);
  const { stored, computed, valid } = globalThis.MefSegment.validateUniversalHeaderCrc(bytes);
  assert.equal(stored, computed,
    `header CRC mismatch: stored=0x${stored.toString(16)} computed=0x${computed.toString(16)}`);
  assert.equal(valid, true);
});

test('mef-segment: CRC over an empty range returns the init value 0xFFFFFFFF', () => {
  // meflib's CRC_calculate starts at 0xFFFFFFFF and applies no final XOR,
  // so an empty input yields 0xFFFFFFFF. Pinning this means a future
  // refactor that "fixes" the final XOR loudly breaks.
  const empty = new Uint8Array(0);
  const crc = globalThis.MefSegment.crcCalculate(empty);
  assert.equal(crc >>> 0, 0xFFFFFFFF);
});

test('mef-segment: parseTmet returns sample rate + n_samples', () => {
  const tmetPath = path.join(FIXTURE_DIR, 'A1.timd', 'A1' + SEG + '.tmet');
  const ab = readBuf(tmetPath);
  const meta = globalThis.MefSegment.parseTmet(ab);
  assert.equal(meta.sampling_frequency, 1000);
  assert.equal(meta.n_samples, 2500);
  assert.equal(meta.n_blocks, 5);
  assert.equal(meta.section_2_encrypted, false);
  assert.equal(meta.section_3_encrypted, false);
  assert.equal(meta.universal_header.channel_name, 'A1');
});

test('mef-segment: parseTmet rejects encrypted Section 2', () => {
  // Mutate a fixture copy to set the Section 2 encryption byte to 1
  // (LEVEL_1_ENCRYPTION). This is the only path that should reject;
  // encryption is feature-gated, NOT supported.
  const tmetPath = path.join(FIXTURE_DIR, 'A1.timd', 'A1' + SEG + '.tmet');
  const buf = Buffer.from(fs.readFileSync(tmetPath));
  // Section 1 starts at offset 1024; sec2 encryption byte at sec1+1024 = 2048.
  buf.writeInt8(1, 1024 + 1024);
  assert.throws(
    () => globalThis.MefSegment.parseTmet(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
    /section 2 is encrypted/,
  );
});

test('mef-segment: parseTidxEntry walks one index record', () => {
  const tidxPath = path.join(FIXTURE_DIR, 'A1.timd', 'A1' + SEG + '.tidx');
  const ab = readBuf(tidxPath);
  // First TSI entry starts at offset 1024 (after the universal header).
  const dv = new DataView(ab);
  const entry = globalThis.MefSegment.parseTidxEntry(dv, 1024);
  // Block 0 owns samples [0, 500), file_offset 0 within the .tdat body.
  // The block_bytes value is now the actual encoded RED block size
  // (varies per signal complexity) rather than the old 304-byte
  // placeholder. We assert structural invariants instead of an
  // exact size: must be 8-aligned and at least one full header big.
  assert.equal(entry.start_sample, 0);
  assert.equal(entry.number_of_samples, 500);
  assert.ok(entry.block_bytes >= 304, `block_bytes ${entry.block_bytes} < RED_BLOCK_HEADER_BYTES`);
  assert.equal(entry.block_bytes % 8, 0, `block_bytes ${entry.block_bytes} must be 8-aligned`);
});

// ─── mef.read(.tmet buf) ──────────────────────────────────────────

test('mef: read() parses one .tmet into a header', () => {
  const tmetPath = path.join(FIXTURE_DIR, 'A1.timd', 'A1' + SEG + '.tmet');
  const ab = readBuf(tmetPath);
  const h = MefReader.read(ab);
  assert.ok(h && typeof h === 'object');
  assert.equal(h.sampling_frequency, 1000);
  assert.equal(h.n_samples, 2500);
});

test('mef: read() rejects garbage / truncated buffers with a regular Error', () => {
  assert.throws(() => MefReader.read(new ArrayBuffer(8)), Error);
  // Empty buffer
  assert.throws(() => MefReader.read(new ArrayBuffer(0)), Error);
});

// ─── api.open + readWindow ────────────────────────────────────────
// Install a local file:// HttpRange shim that also exposes a listDir
// hook for the .mefd/ directory listing path. Production uses an
// HTTP-backed implementation; tests use this synchronous file:// one
// so api.open exercises the production code path without a server.

function installLocalHttpRange() {
  globalThis.HttpRange = {
    async probeLength(url) {
      return fs.statSync(url.replace(/^file:\/\//, '')).size;
    },
    async probeLengthNoHead(url) {
      return fs.statSync(url.replace(/^file:\/\//, '')).size;
    },
    async fetchBuffer(url) {
      const b = fs.readFileSync(url.replace(/^file:\/\//, ''));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    async rangeFetch(url, start, endIncl) {
      const b = fs.readFileSync(url.replace(/^file:\/\//, ''));
      const slice = b.slice(start, endIncl + 1);
      return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    },
    // Directory listing — used by mef.open to walk the .mefd/ bundle.
    // The MEF reader is the only format that needs this hook; other
    // bundle formats (.ds, .vhdr) discover siblings by name not listing.
    async listDir(url) {
      const dir = url.replace(/^file:\/\//, '').replace(/\/$/, '');
      return fs.readdirSync(dir);
    },
  };
}

test('mef: open() returns a reader-shaped object', async () => {
  installLocalHttpRange();
  const r = await MefReader.open({ eeg_url: FIXTURE_URL });
  assert.ok(r, 'open() returned null');
  assert.equal(r.n_channels, 4);
  assert.equal(r.sampling_frequency, 1000);
  assert.equal(r.n_samples, 2500);
  // 2500 / 1000 = 2.5 s
  assert.ok(Math.abs(r.duration_s - 2.5) < 1e-9);
  assert.equal(r.channel_labels.length, 4);
  // The fixture stamps real channel names — verify they appear (sorted
  // alphabetically by the listDir path).
  assert.deepEqual([...r.channel_labels].sort(), CHANNELS);
  assert.equal(typeof r.readWindow, 'function');
  assert.equal(r.bytes_per_sample, 4);
  // Channel types default to 'ieeg' — every channel in a .mefd/ bundle
  // is intracranial unless the calling controller overrides.
  assert.equal(r.channel_types[0], 'ieeg');
});

test('mef: open() surfaces recording start time from universal header (μUTC → ISO)', async () => {
  installLocalHttpRange();
  const r = await MefReader.open({ eeg_url: FIXTURE_URL });
  // The fixture writes start_time = 1767225600000000 μUTC = 2026-01-01T00:00:00Z
  assert.equal(r.recording_start_iso, '2026-01-01T00:00:00.000Z');
});

test('mef: open() exposes per-channel _mef debug info', async () => {
  installLocalHttpRange();
  const r = await MefReader.open({ eeg_url: FIXTURE_URL });
  assert.ok(r._mef, '_mef debug object missing');
  assert.equal(r._mef.tier, 3, 'Tier 3 (full RED decode) reader');
  assert.equal(r._mef.channels.length, 4);
  assert.equal(r._mef.channels[0].mef_version, '3.0');
  assert.equal(r._mef.channels[0].n_blocks, 5);
});

test('mef: open() requires meta.eeg_url', async () => {
  installLocalHttpRange();
  await assert.rejects(() => MefReader.open({}), /eeg_url is required/);
});

test('mef: readWindow decodes a small head window against the known sine fixture', async () => {
  installLocalHttpRange();
  const r = await MefReader.open({ eeg_url: FIXTURE_URL });
  const N = 100;
  const win = await r.readWindow(0, N);
  assert.equal(win.length, 4, 'one Float32Array per channel');
  assert.equal(win[0].length, N);
  // For each channel, sample i must equal the deterministic sine.
  // r.channel_labels carries the same order as `win`.
  for (let c = 0; c < 4; c++) {
    const ch = r.channel_labels[c];
    for (let i = 0; i < N; i++) {
      const expected = expectedSample(ch, i);
      assert.equal(
        win[c][i], expected,
        `channel ${ch} sample ${i}: got ${win[c][i]} expected ${expected}`,
      );
    }
  }
});

test('mef: readWindow stitches across a RED block boundary', async () => {
  // Fixture has 5 blocks × 500 samples. Read a window centred on the
  // boundary between block 1 and block 2 (samples [450..550)) — this
  // forces the reader to range-fetch two blocks, decode both, and
  // splice them into one Float32Array.
  installLocalHttpRange();
  const r = await MefReader.open({ eeg_url: FIXTURE_URL });
  const start = 450, N = 100;   // straddles block-boundary at sample 500
  const win = await r.readWindow(start, N);
  for (let c = 0; c < 4; c++) {
    const ch = r.channel_labels[c];
    for (let i = 0; i < N; i++) {
      const expected = expectedSample(ch, start + i);
      assert.equal(
        win[c][i], expected,
        `channel ${ch} sample ${start + i}: got ${win[c][i]} expected ${expected}`,
      );
    }
  }
});

test('mef: readWindow spanning multiple blocks returns continuous samples', async () => {
  // Read the entire 2.5 s recording in one call. This exercises every
  // block of every channel and is the highest-coverage round-trip check.
  installLocalHttpRange();
  const r = await MefReader.open({ eeg_url: FIXTURE_URL });
  const win = await r.readWindow(0, r.n_samples);
  for (let c = 0; c < 4; c++) {
    const ch = r.channel_labels[c];
    // Spot-check the first sample of every block (boundary points the
    // RED differential chain restarts at).
    for (let block = 0; block < 5; block++) {
      const idx = block * 500;
      assert.equal(
        win[c][idx], expectedSample(ch, idx),
        `channel ${ch} block-${block} first sample (idx ${idx})`,
      );
    }
    // And spot-check the very last sample.
    const last = r.n_samples - 1;
    assert.equal(win[c][last], expectedSample(ch, last),
      `channel ${ch} last sample (idx ${last})`);
  }
});

test('mef: readWindow returns empty arrays past EOF (no throw)', async () => {
  // Pins the contract: requesting samples beyond n_samples returns the
  // canonical empty per-channel array (zero-length Float32Arrays). This
  // mirrors every other reader's behaviour and lets the renderer skip
  // tile-fetch teardown gracefully.
  installLocalHttpRange();
  const r = await MefReader.open({ eeg_url: FIXTURE_URL });
  const win = await r.readWindow(r.n_samples + 100, 5);
  assert.equal(win.length, 4);
  for (let c = 0; c < 4; c++) assert.equal(win[c].length, 0);
});

test('mef: readWindow clamps tail-overlapping requests to recording end', async () => {
  // Ask for 200 samples starting 100 before EOF → reader returns just
  // the trailing 100 samples (clampWindow semantics, shared with every
  // other reader). Verifies the boundary math doesn't underflow.
  installLocalHttpRange();
  const r = await MefReader.open({ eeg_url: FIXTURE_URL });
  const start = r.n_samples - 100;   // 2400
  const win = await r.readWindow(start, 200);
  // clampWindow truncates the request — actual returned length is
  // n_samples - start = 100.
  assert.equal(win[0].length, 100);
  const ch = r.channel_labels[0];
  for (let i = 0; i < 100; i++) {
    assert.equal(win[0][i], expectedSample(ch, start + i),
      `tail sample ${start + i} mismatch`);
  }
});

test('mef: open() accepts pre-resolved segment_urls without listDir', async () => {
  // This is the path production callers will use — a controller-built
  // manifest passes the URL triples directly. Exercises the no-listDir
  // branch + verifies it produces the same reader.
  installLocalHttpRange();
  // Strip listDir from the shim to prove segment_urls bypasses it.
  delete globalThis.HttpRange.listDir;
  const segment_urls = CHANNELS.map((ch) => {
    const dir = FIXTURE_URL + ch + '.timd/';
    return {
      channel_dir: dir,
      tmet: dir + ch + SEG + '.tmet',
      tdat: dir + ch + SEG + '.tdat',
      tidx: dir + ch + SEG + '.tidx',
    };
  });
  const r = await MefReader.open({ eeg_url: FIXTURE_URL, segment_urls });
  assert.equal(r.n_channels, 4);
  assert.equal(r.sampling_frequency, 1000);
  assert.equal(r.n_samples, 2500);
});

test('mef: open() rejects ragged session (channel 1 sample rate differs)', async () => {
  // Mutate a fresh in-memory copy of A2's .tmet to carry a different
  // sample rate. The reader must reject the whole session — we don't
  // (yet) support ragged MEF3.
  const tmetA1 = readBuf(path.join(FIXTURE_DIR, 'A1.timd', 'A1' + SEG + '.tmet'));
  const tmetA2 = Buffer.from(fs.readFileSync(path.join(FIXTURE_DIR, 'A2.timd', 'A2' + SEG + '.tmet')));
  // Section 2 starts at offset 2560; sampling_frequency at sec2+6160 = 8720.
  tmetA2.writeDoubleLE(500.0, 8720);
  // Recompute body CRC + header CRC after the mutation so the parser's
  // own validation doesn't fire instead of the ragged check.
  // (Actually parseTmet doesn't validate CRC at present, so we don't
  // need to rewrite — but we do need to write a fresh shim.)
  const tdatA1 = readBuf(path.join(FIXTURE_DIR, 'A1.timd', 'A1' + SEG + '.tdat'));
  const tidxA1 = readBuf(path.join(FIXTURE_DIR, 'A1.timd', 'A1' + SEG + '.tidx'));
  const tdatA2 = readBuf(path.join(FIXTURE_DIR, 'A2.timd', 'A2' + SEG + '.tdat'));
  const tidxA2 = readBuf(path.join(FIXTURE_DIR, 'A2.timd', 'A2' + SEG + '.tidx'));

  globalThis.HttpRange = {
    async probeLength()      { return 0; },
    async probeLengthNoHead(){ return 0; },
    async fetchBuffer(url) {
      if (url.endsWith('A1' + SEG + '.tmet')) return tmetA1;
      if (url.endsWith('A2' + SEG + '.tmet')) {
        // Return the mutated copy.
        return tmetA2.buffer.slice(tmetA2.byteOffset, tmetA2.byteOffset + tmetA2.byteLength);
      }
      if (url.endsWith('A1' + SEG + '.tdat')) return tdatA1;
      if (url.endsWith('A2' + SEG + '.tdat')) return tdatA2;
      if (url.endsWith('A1' + SEG + '.tidx')) return tidxA1;
      if (url.endsWith('A2' + SEG + '.tidx')) return tidxA2;
      throw new Error('test shim got unexpected URL ' + url);
    },
    async rangeFetch()       { throw new Error('unexpected rangeFetch in ragged test'); },
  };
  const segment_urls = ['A1', 'A2'].map((ch) => {
    const dir = FIXTURE_URL + ch + '.timd/';
    return {
      channel_dir: dir,
      tmet: dir + ch + SEG + '.tmet',
      tdat: dir + ch + SEG + '.tdat',
      tidx: dir + ch + SEG + '.tidx',
    };
  });
  await assert.rejects(
    () => MefReader.open({ eeg_url: FIXTURE_URL, segment_urls }),
    /ragged MEF3 sessions are not supported/,
  );
});

// ─── api.open via globalThis (registration sanity) ───────────────
// The IIFE attaches to globalThis.MefReader; the viewer/worker
// dispatch tables reach through this name. Pin it so an accidental
// rename in formats/mef.js breaks loudly.

test('mef: module attaches globalThis.MefReader', () => {
  assert.ok(globalThis.MefReader, 'globalThis.MefReader missing');
  assert.equal(typeof globalThis.MefReader.read, 'function');
  assert.equal(typeof globalThis.MefReader.open, 'function');
});

test('mef-segment: module attaches globalThis.MefSegment', () => {
  assert.ok(globalThis.MefSegment, 'globalThis.MefSegment missing');
  assert.equal(typeof globalThis.MefSegment.parseUniversalHeader, 'function');
  assert.equal(typeof globalThis.MefSegment.parseTmet, 'function');
  assert.equal(typeof globalThis.MefSegment.crcCalculate, 'function');
});
