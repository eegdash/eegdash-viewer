#!/usr/bin/env node
// Enumerate every OpenNeuro dataset (ds-prefixed root folder) directly
// from the public S3 bucket. The EEGDash catalog API blocks unauthenticated
// requests so we go upstream. For each dataset, check which electrophysiology
// datatype folders exist (eeg/ieeg/meg/emg/nirs) and pick up to N recordings.
//
// Output: scripts/audit-openneuro-full.json with the same schema as
// audit-100-datasets.json so the audit spec can consume it via AUDIT_MANIFEST.
import fs from 'node:fs';

const SUPPORTED_EXTS = new Set(['edf','bdf','set','vhdr','fif','snirf','ds','con','sqd','nwb','mefd','raw','kdf']);
const ELECTRO_DATATYPES = new Set(['eeg','ieeg','meg','emg','nirs']);
const S3 = 'https://s3.amazonaws.com/openneuro.org';
const CDN = 'https://cdn.eegdash.org';
const PER_DATASET_CAP = 8;
const CONCURRENCY = 16;

function parseS3Xml(xml) {
  const keys = [], prefixes = [];
  const reK = /<Key>([^<]+)<\/Key>/g;
  const reP = /<Prefix>([^<]+)<\/Prefix>/g;
  let m;
  while ((m = reK.exec(xml))) keys.push(m[1]);
  while ((m = reP.exec(xml))) prefixes.push(m[1]);
  const tok = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
  return { keys, prefixes, nextToken: tok?.[1] ?? null };
}

async function listS3(prefix, delimiter = '/', maxKeys = 1000) {
  const all = { keys: [], prefixes: [] };
  let token = null;
  for (let i = 0; i < 50; i++) {
    const url = new URL(S3 + '/');
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', prefix);
    if (delimiter) url.searchParams.set('delimiter', delimiter);
    url.searchParams.set('max-keys', String(maxKeys));
    if (token) url.searchParams.set('continuation-token', token);
    const r = await fetch(url);
    if (!r.ok) break;
    const xml = await r.text();
    const { keys, prefixes, nextToken } = parseS3Xml(xml);
    all.keys.push(...keys);
    all.prefixes.push(...prefixes);
    if (!nextToken) break;
    token = nextToken;
  }
  return all;
}

async function listAllRecursive(prefix, cap = 5000) {
  const keys = [];
  let token = null;
  for (let i = 0; i < 10 && keys.length < cap; i++) {
    const url = new URL(S3 + '/');
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', prefix);
    url.searchParams.set('max-keys', '1000');
    if (token) url.searchParams.set('continuation-token', token);
    const r = await fetch(url);
    if (!r.ok) break;
    const xml = await r.text();
    const { keys: ks, nextToken } = parseS3Xml(xml);
    keys.push(...ks);
    if (!nextToken) break;
    token = nextToken;
  }
  return keys;
}

console.error('Step 1: Enumerate all ds* dataset root folders in OpenNeuro S3...');
const root = await listS3('ds', '/', 1000);
const datasets = root.prefixes
  .map(p => p.replace(/\/$/, ''))
  .filter(p => /^ds\d{6}$/.test(p));
console.error(`  Found ${datasets.length} ds######-prefixed datasets`);

console.error('Step 2: For each dataset, check whether sub-XX/<datatype>/ exists, pick recordings...');
const out = [];
let processed = 0;

async function processDataset(dsId) {
  // First: list the top-level of the dataset to find an example subject.
  const subRoot = await listS3(`${dsId}/sub-`, '/', 50);
  if (!subRoot.prefixes.length) return;
  // For up to PER_DATASET_CAP subjects, check each for datatype subfolders.
  const subjects = subRoot.prefixes.slice(0, PER_DATASET_CAP);
  const allKeys = await listAllRecursive(`${dsId}/`, 8000);
  // Group keys by datatype within sub-<X>/[ses-<Y>/]<datatype>/
  const recordings = [];
  const seenStems = new Set();
  for (const k of allKeys) {
    const m = /^([^/]+)\/sub-([^/]+)\/(?:ses-([^/]+)\/)?(eeg|ieeg|meg|emg|nirs)\/(.+)$/.exec(k);
    if (!m) continue;
    const [, , sub, ses, datatype, file] = m;
    if (!ELECTRO_DATATYPES.has(datatype)) continue;
    // Determine ext + filter to primary header files.
    let ext = file.split('.').pop().toLowerCase();
    let cdnFile = file;
    let isPrimary = false;
    if (SUPPORTED_EXTS.has(ext) && !file.endsWith('.fdt') && !file.endsWith('.vmrk') && !file.endsWith('.eeg')) {
      isPrimary = true;
    } else if (/\.meg4$/i.test(file)) {
      isPrimary = true; ext = 'ds';
    }
    if (!isPrimary) continue;
    // Dedup by sub+ses+filestem
    const stem = `${sub}/${ses ?? ''}/${file.split('.')[0]}`;
    if (seenStems.has(stem)) continue;
    seenStems.add(stem);
    recordings.push({
      dataset_id: dsId,
      cdn_url: `${CDN}/${k}`,
      ext,
      datatype,
      verdict: 'loadable',
    });
    if (recordings.length >= PER_DATASET_CAP) break;
  }
  for (const r of recordings) out.push(r);
}

// Run with bounded concurrency.
const queue = datasets.slice();
async function worker() {
  while (queue.length) {
    const dsId = queue.shift();
    if (!dsId) return;
    try {
      await processDataset(dsId);
    } catch (e) {
      console.error(`  ${dsId} ERR: ${e.message}`);
    }
    processed++;
    if (processed % 50 === 0) {
      console.error(`  ${processed}/${datasets.length} datasets processed, ${out.length} recordings`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.error(`\nTotal datasets enumerated: ${datasets.length}`);
console.error(`Total recording URLs: ${out.length}`);
const datasetCounts = {};
for (const r of out) datasetCounts[r.dataset_id] = (datasetCounts[r.dataset_id] ?? 0) + 1;
const withRecordings = Object.keys(datasetCounts).length;
console.error(`Datasets with at least one recording: ${withRecordings} (${(withRecordings/datasets.length*100).toFixed(1)}%)`);

fs.writeFileSync('scripts/audit-openneuro-full.json', JSON.stringify({
  meta: {
    source: 'OpenNeuro S3 bucket enumeration',
    per_dataset_cap: PER_DATASET_CAP,
    total_datasets_in_bucket: datasets.length,
    datasets_with_electro_recordings: withRecordings,
    total_recording_urls: out.length,
  },
  results: out,
}, null, 2));
console.error('Wrote scripts/audit-openneuro-full.json');
