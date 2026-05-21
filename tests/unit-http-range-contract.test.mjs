// Contract test: any function tests MOCK on HttpRange MUST also exist
// on the production export. Catches the "mock invents a function that
// doesn't exist in production" pattern that hid the fetchBuffer bug
// (commit f524bad surfaced it via browser reality-check audit).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
require('../formats/_http_range.js');
const realKeys = new Set(Object.keys(globalThis.HttpRange));

test('HttpRange production exports fetchBuffer (mocked in tests, must exist real)', () => {
  assert.ok(realKeys.has('fetchBuffer'),
    `HttpRange.fetchBuffer is referenced by formats/fiff.js + formats/ctf.js ` +
    `at runtime; must exist in production exports. Current keys: ` +
    `${[...realKeys].sort().join(', ')}`);
});

test('HttpRange production has every method tests mock', () => {
  // Static scan: every globalThis.HttpRange.<methodName> = ... in tests/
  // must also exist in the production API. Catches future divergence.
  const testFiles = [
    'tests/unit-fiff.test.mjs',
    'tests/unit-fiff-raw.test.mjs',
    'tests/unit-ctf.test.mjs',
    'tests/unit-brainvision-readwindow.test.mjs',
    'tests/unit-edf-readwindow.test.mjs',
    'tests/unit-eeglab-readwindow.test.mjs',
  ];
  const mockedMethods = new Set();
  const methodRe = /globalThis\.HttpRange\s*=\s*\{[\s\S]*?\}/g;
  const nameRe = /(\w+)\s*:\s*(async\s+)?(\(|function)/g;
  for (const path of testFiles) {
    if (!fs.existsSync(path)) continue;
    const src = fs.readFileSync(path, 'utf8');
    for (const m of src.matchAll(methodRe)) {
      for (const n of m[0].matchAll(nameRe)) mockedMethods.add(n[1]);
    }
  }
  const missing = [...mockedMethods].filter(m => !realKeys.has(m));
  assert.deepEqual(missing, [],
    `Tests mock these HttpRange methods that don't exist in production: ${missing.join(', ')}`);
});
