// Unit tests for formats/_mef-red.js — MEF3 RED block codec.
//
// We don't have a pre-canned binary fixture sourced from upstream
// meflib for the bit-level decoder (there's no published "test vector"
// file in the meflib repo). Instead, we ship both encode and decode
// in the same module and exercise the codec via round trips against
// known sample patterns. The encoder is a literal port of
// RED_encode_exec (meflib.c L6848-7049) for the unencrypted lossless
// / fixed-scale-factor path, so a round-trip success demonstrates the
// two halves agree.
//
// Confidence ladder for the codec correctness claim:
//   - HIGH on the lossless path: lots of byte patterns survive round
//     trips, including all-zero, monotonic-ramp, sinusoid, random.
//   - HIGH on CRC layout + header alignment: the test fixture's MEF
//     reader is independently CRC-validated.
//   - MEDIUM on bit-level interop with the upstream C encoder until
//     we obtain an external binary fixture. Risk: subtle range-coder
//     drift that round-trips against itself but disagrees with C
//     output. Mitigated by (a) the C source being directly transcribed
//     line-for-line with offset comments, and (b) any divergence would
//     immediately fail to decode the synthetic ramp because the carry
//     check (CARRY_CHECK / TOP_VALUE) is exercised by ramps.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../formats/_mef-segment.js');
require('../formats/_mef-red.js');
const MefRed = globalThis.MefRed;

function assertSamplesEqual(a, b, msg) {
  assert.equal(a.length, b.length, `length mismatch: ${a.length} vs ${b.length} (${msg})`);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      assert.fail(`sample[${i}] mismatch: got ${a[i]} expected ${b[i]} (${msg})`);
    }
  }
}

test('mef-red: module attaches globalThis.MefRed with the right surface', () => {
  assert.ok(MefRed);
  assert.equal(MefRed.RED_BLOCK_HEADER_BYTES, 304);
  assert.equal(typeof MefRed.encodeBlock, 'function');
  assert.equal(typeof MefRed.decodeBlock, 'function');
  assert.equal(typeof MefRed.parseBlockHeader, 'function');
});

test('mef-red: encode + decode round-trips a constant signal', () => {
  // All identical samples → every diff is 0 → most-frequent symbol.
  const N = 500;
  const samples = new Int32Array(N);
  samples.fill(12345);
  const block = MefRed.encodeBlock(samples);
  const { samples: out, header } = MefRed.decodeBlock(block);
  assert.equal(header.number_of_samples, N);
  assert.equal(header.discontinuity, false);
  assertSamplesEqual(out, samples, 'constant');
});

test('mef-red: encode + decode round-trips a monotonic +1 ramp', () => {
  // Diff is always +1 → exercises the range coder with a heavily-
  // skewed distribution (single dominant symbol).
  const N = 1000;
  const samples = new Int32Array(N);
  for (let i = 0; i < N; i++) samples[i] = -500 + i;
  const block = MefRed.encodeBlock(samples);
  const { samples: out } = MefRed.decodeBlock(block);
  assertSamplesEqual(out, samples, 'ramp');
});

test('mef-red: encode + decode round-trips a 100 Hz sinusoid', () => {
  // Smooth signal — diffs span a narrow but non-trivial range.
  const N = 500;
  const samples = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    samples[i] = Math.round(1000 * Math.sin(2 * Math.PI * 100 * i / 500));
  }
  const block = MefRed.encodeBlock(samples);
  const { samples: out } = MefRed.decodeBlock(block);
  assertSamplesEqual(out, samples, 'sinusoid');
});

test('mef-red: encode + decode round-trips large jumps via keysample restarts', () => {
  // Force keysample restarts: alternating ±10000 forces every diff
  // to exceed the int8 range, so the encoder emits -128 + 4-byte
  // keysample on every step.
  const N = 200;
  const samples = new Int32Array(N);
  for (let i = 0; i < N; i++) samples[i] = (i % 2) ? 10000 : -10000;
  const block = MefRed.encodeBlock(samples);
  const { samples: out } = MefRed.decodeBlock(block);
  assertSamplesEqual(out, samples, 'alternating-jumps');
});

test('mef-red: encode + decode round-trips pseudo-random EEG-like noise', () => {
  // Mulberry32 PRNG — fully deterministic for the test.
  const N = 1024;
  let s = 0xdeadbeef >>> 0;
  function rand() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const samples = new Int32Array(N);
  let v = 0;
  for (let i = 0; i < N; i++) {
    v += Math.round((rand() - 0.5) * 20);  // Brownian-ish walk
    samples[i] = v;
  }
  const block = MefRed.encodeBlock(samples);
  const { samples: out } = MefRed.decodeBlock(block);
  assertSamplesEqual(out, samples, 'random-walk');
});

test('mef-red: decoded block reports number_of_samples + scale_factor in header', () => {
  const samples = new Int32Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  const block = MefRed.encodeBlock(samples);
  const { header } = MefRed.decodeBlock(block);
  assert.equal(header.number_of_samples, 10);
  assert.equal(header.scale_factor, 1.0);
  assert.equal(header.difference_bytes, 14);  // 4 keysample + 9 diffs + 1 synthetic
  assert.equal(header.discontinuity, false);
});

test('mef-red: discontinuity flag survives encode → decode', () => {
  const samples = new Int32Array(50);
  for (let i = 0; i < 50; i++) samples[i] = i * 7;
  const block = MefRed.encodeBlock(samples, { discontinuity: true });
  const { samples: out, header } = MefRed.decodeBlock(block);
  assert.equal(header.discontinuity, true);
  assertSamplesEqual(out, samples, 'discontinuity-block');
});

test('mef-red: block_bytes is 8-byte aligned', () => {
  // Pin the pad-to-alignment invariant. meflib aligns every block to
  // 8-byte boundaries so .tdat layouts are deterministic.
  for (const N of [1, 7, 31, 64, 128, 257, 500, 999]) {
    const samples = new Int32Array(N);
    for (let i = 0; i < N; i++) samples[i] = i;
    const block = MefRed.encodeBlock(samples);
    assert.equal(block.length % 8, 0, `block length ${block.length} not 8-aligned for N=${N}`);
  }
});

test('mef-red: block CRC is validated by default', () => {
  const samples = new Int32Array(20);
  for (let i = 0; i < 20; i++) samples[i] = i;
  const block = MefRed.encodeBlock(samples);
  // Tamper with a payload byte → CRC mismatch must throw.
  const tampered = new Uint8Array(block);
  tampered[RED_BLOCK_HEADER_BYTES_LOCAL + 0] ^= 0xff;
  assert.throws(
    () => MefRed.decodeBlock(tampered),
    /block CRC mismatch/,
  );
});
// Pull HEADER_BYTES via API so this test stays in sync with the codec.
const RED_BLOCK_HEADER_BYTES_LOCAL = MefRed.RED_BLOCK_HEADER_BYTES;

test('mef-red: CRC validation can be disabled for forensic decode', () => {
  const samples = new Int32Array(20);
  for (let i = 0; i < 20; i++) samples[i] = i * 3;
  const block = MefRed.encodeBlock(samples);
  const tampered = new Uint8Array(block);
  // Tamper with the CRC bytes — payload still decodes correctly so we
  // can prove validateCrc:false is the only way to bypass the check.
  tampered[0] ^= 0xff;
  const { samples: out } = MefRed.decodeBlock(tampered, 0, { validateCrc: false });
  assertSamplesEqual(out, samples, 'tampered-crc-validatecrc-false');
});

test('mef-red: encrypted block is rejected', () => {
  const samples = new Int32Array([1, 2, 3, 4, 5]);
  const block = MefRed.encodeBlock(samples);
  // Set the L1 encryption flag bit.
  const enc = new Uint8Array(block);
  enc[4] |= MefRed.RED_LEVEL_1_ENCRYPTION_MASK;
  // CRC will no longer match — disable validation to surface the
  // encryption error specifically.
  assert.throws(
    () => MefRed.decodeBlock(enc, 0, { validateCrc: false }),
    /encrypted/,
  );
});

test('mef-red: zero-sample block produces empty Int32Array', () => {
  const empty = MefRed.encodeBlock(new Int32Array(0));
  const { samples, header } = MefRed.decodeBlock(empty);
  assert.equal(header.number_of_samples, 0);
  assert.equal(samples.length, 0);
});

test('mef-red: block at non-zero offset within a larger buffer decodes', () => {
  // Simulates the real .tdat layout: 1024-byte UH + concatenated blocks.
  const samples = new Int32Array([100, 101, 102, 103, 104]);
  const block = MefRed.encodeBlock(samples);
  const buf = new Uint8Array(2048);
  buf.set(block, 1024);
  const { samples: out, header } = MefRed.decodeBlock(buf, 1024);
  assert.equal(header.number_of_samples, 5);
  assertSamplesEqual(out, samples, 'offset-1024');
});

test('mef-red: scaleFactor > 1.0 round-trips with controlled loss', () => {
  // Lossy: encoder scales samples DOWN by sf before quantising; decoder
  // scales UP by sf. So integer samples that are exact multiples of sf
  // should round-trip exactly. We test sf=2 with even values.
  const N = 100;
  const samples = new Int32Array(N);
  for (let i = 0; i < N; i++) samples[i] = i * 4;  // multiples of 2 (and 4)
  const block = MefRed.encodeBlock(samples, { scaleFactor: 2.0 });
  const { samples: out, header } = MefRed.decodeBlock(block);
  assert.equal(header.scale_factor, 2.0);
  assertSamplesEqual(out, samples, 'scale-factor-2-even');
});

test('mef-red: parseBlockHeader matches what encodeBlock wrote', () => {
  const samples = new Int32Array(64);
  for (let i = 0; i < 64; i++) samples[i] = i * 11 - 50;
  const block = MefRed.encodeBlock(samples, {
    startTimeLow: 0x12345678,
    startTimeHigh: 0x00000001,
  });
  const h = MefRed.parseBlockHeader(block, 0);
  assert.equal(h.number_of_samples, 64);
  assert.equal(h.block_bytes % 8, 0);
  assert.equal(h.start_time_low, 0x12345678);
  assert.equal(h.start_time_high, 0x00000001);
  assert.equal(h.encrypted, false);
  assert.equal(h.discontinuity, false);
  assert.equal(h.statistics.length, 256);
});

test('mef-red: truncated buffer is rejected with a clear error', () => {
  const samples = new Int32Array(50);
  for (let i = 0; i < 50; i++) samples[i] = i;
  const block = MefRed.encodeBlock(samples);
  // Lop off the last byte → block_bytes claims more than buffer holds.
  const truncated = block.slice(0, block.length - 1);
  assert.throws(
    () => MefRed.decodeBlock(truncated),
    /declares block_bytes/,
  );
});
