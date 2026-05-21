import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
require('../formats/_fiff-dir.js');
const FIFFReader = require('../formats/fiff.js');

globalThis.HttpRange = {
  async fetchBuffer(url) {
    const p = url.replace(/^file:\/\//, '');
    const buf = fs.readFileSync(p);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },
  async probeLength(url) {
    const p = url.replace(/^file:\/\//, '');
    return fs.statSync(p).size;
  },
  async rangeFetch(url, start, endIncl) {
    const p = url.replace(/^file:\/\//, '');
    const buf = fs.readFileSync(p);
    return buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + endIncl + 1);
  },
};

const RAW_FIXTURE = path.resolve('tests/fixtures/meg/synth-raw.fif');
const skipIfNoFixture = !fs.existsSync(RAW_FIXTURE);

test('fiff raw: open() returns a reader with non-null raw + readable readWindow', { skip: skipIfNoFixture }, async () => {
  const reader = await FIFFReader.open({ eeg_url: 'file://' + RAW_FIXTURE });
  assert.ok(reader.n_channels > 0);
  assert.ok(reader.sampling_frequency > 0);
  assert.ok(reader.n_samples > 0);
  assert.equal(typeof reader.readWindow, 'function');
});

test('fiff raw: readWindow(0, 100) returns nCh Float32Arrays of length 100', { skip: skipIfNoFixture }, async () => {
  const reader = await FIFFReader.open({ eeg_url: 'file://' + RAW_FIXTURE });
  const win = await reader.readWindow(0, 100);
  assert.equal(win.length, reader.n_channels);
  for (let c = 0; c < win.length; c++) {
    assert.ok(win[c] instanceof Float32Array);
    assert.equal(win[c].length, 100);
  }
});

test('fiff raw: readWindow at the tail clamps to n_samples', { skip: skipIfNoFixture }, async () => {
  const reader = await FIFFReader.open({ eeg_url: 'file://' + RAW_FIXTURE });
  const win = await reader.readWindow(reader.n_samples - 10, 1000);
  assert.ok(win[0].length <= 10);
  assert.ok(win[0].length > 0);
});
