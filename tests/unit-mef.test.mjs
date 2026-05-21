// Unit tests for formats/mef.js — MEF3 (Mayo Clinic Multiscale
// Electrophysiology Format v3) iEEG reader.
//
// Tier achieved: 1 (metadata only). readWindow() throws a clean
// "RED decompression not implemented" error. The tests below verify:
//   - universal header parsing (magic, version, CRC, channel name)
//   - .tmet metadata section 2 fields (sample_rate, n_samples)
//   - the reader's contract: n_channels, sampling_frequency, etc.
//   - readWindow throws the documented error
//   - encrypted recordings are rejected up-front
//
// Fixture: tests/fixtures/ieeg/mef-tiny.mefd/ (synthesised, CC0 —
// see scripts/make-mef-fixture.mjs). 4 channels (A1..A4) × 2500
// samples @ 1000 Hz = 2.5 s per channel.

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
const MefReader = require('../formats/mef.js');

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
  assert.equal(entry.start_sample, 0);
  assert.equal(entry.number_of_samples, 500);
  assert.equal(entry.block_bytes, 304);
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
  assert.equal(r._mef.tier, 1, 'Tier 1 (metadata only) reader');
  assert.equal(r._mef.channels.length, 4);
  assert.equal(r._mef.channels[0].mef_version, '3.0');
  assert.equal(r._mef.channels[0].n_blocks, 5);
});

test('mef: open() requires meta.eeg_url', async () => {
  installLocalHttpRange();
  await assert.rejects(() => MefReader.open({}), /eeg_url is required/);
});

test('mef: readWindow throws "RED decompression not implemented" — Tier 1 contract', async () => {
  installLocalHttpRange();
  const r = await MefReader.open({ eeg_url: FIXTURE_URL });
  await assert.rejects(
    () => r.readWindow(0, 100),
    /RED decompression is not implemented/,
    'Tier 1 readWindow must throw a clean error, not return garbage',
  );
});

test('mef: readWindow throws even at the tail boundary (no silent EOF return)', async () => {
  // Pins the contract that we DON'T short-circuit-return an empty array
  // when start ≥ n_samples — the consumer needs the unambiguous "RED
  // not implemented" signal regardless of where they ask to read.
  installLocalHttpRange();
  const r = await MefReader.open({ eeg_url: FIXTURE_URL });
  await assert.rejects(
    () => r.readWindow(r.n_samples + 100, 5),
    /RED decompression is not implemented/,
  );
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
