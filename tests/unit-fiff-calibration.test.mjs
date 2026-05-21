// Unit test for the FIFF "calibration/empty-block file" early-exit.
// ds003392 (and similar) ship FIFF files with FIFFB_MEAS_INFO and
// FIFFB_PROJ but NO FIFFB_RAW_DATA. The viewer must surface a clean
// error at open() time — not a TypeError on the first readWindow call.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

globalThis.HttpRange = {
  fetchBuffer: async (url) => {
    const filePath = url.replace(/^file:\/\//, '');
    const b = fs.readFileSync(filePath);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  },
  probeLength: async (url) => {
    const filePath = url.replace(/^file:\/\//, '');
    return fs.statSync(filePath).size;
  },
  rangeFetch: async (url, start, endIncl) => {
    const filePath = url.replace(/^file:\/\//, '');
    const b = fs.readFileSync(filePath);
    return b.buffer.slice(b.byteOffset + start, b.byteOffset + endIncl + 1);
  },
};

require('../formats/_buffers.js');
require('../formats/_fiff-dir.js');
const FiffReader = require('../formats/fiff.js');

// tests/fixtures/meg/test-proj.fif is a projection-only fixture with
// MEAS_INFO but no FIFFB_RAW_DATA — confirmed by FiffReader.read()
// returning {nchan: 0, raw: null}. This is the same shape ds003392
// hits in production.
const FIXTURE = 'file://' + path.resolve('tests/fixtures/meg/test-proj.fif');

test('fiff: open() throws a clean error when there is no raw data block', async () => {
  await assert.rejects(
    FiffReader.open({ eeg_url: FIXTURE }),
    (err) => {
      // Must be a clean message — NOT a TypeError or "cannot read
      // properties of null". The viewer surfaces this string verbatim.
      assert.match(err.message, /FIFF.*(calibration|no raw|empty-block|no signal)/i);
      assert.doesNotMatch(err.message, /TypeError|cannot read/i);
      return true;
    },
  );
});
