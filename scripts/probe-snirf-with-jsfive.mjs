#!/usr/bin/env node
/**
 * scripts/probe-snirf-with-jsfive.mjs
 *
 * Confirms jsfive (the same HDF5 reader vendored for MAT v7.3 EEGLAB)
 * can parse a SNIRF file. Walks the canonical SNIRF top-level groups
 * and prints their shapes — if this prints the expected paths we're
 * confident formats/snirf.js can be built on the same library.
 *
 * Run:  node scripts/probe-snirf-with-jsfive.mjs tests/fixtures/nirs/snirf-tiny.snirf
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jsfive = require('jsfive');

const file = process.argv[2];
if (!file) {
  console.error('usage: probe-snirf-with-jsfive.mjs <file>');
  process.exit(2);
}

const buf = fs.readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const f = new jsfive.File(ab);

console.log('top-level keys:', f.keys);

function walk(group, prefix, depth) {
  if (depth > 4) return;
  for (const k of group.keys || []) {
    let child;
    try { child = group.get(k); } catch (e) { console.log(`  ERR getting ${prefix}/${k}: ${e.message}`); continue; }
    const path = prefix + '/' + k;
    if (child && child.shape) {
      console.log(`  DATASET ${path}  shape=[${child.shape.join(',')}]  dtype=${child.dtype}`);
    } else if (child && child.keys) {
      console.log(`  GROUP   ${path}  (${child.keys.length} children)`);
      walk(child, path, depth + 1);
    } else {
      console.log(`  ??      ${path}  (kind=${typeof child})`);
    }
  }
}
walk(f, '', 0);
