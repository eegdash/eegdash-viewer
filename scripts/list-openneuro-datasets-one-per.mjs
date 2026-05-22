#!/usr/bin/env node
// Enumerate every OpenNeuro dataset (ds###### root folder) and pick ONE
// recording URL per dataset. Optimised for speed: 3 S3 calls per dataset
// instead of the recursive enumeration.
//
// Step 1: list all ds###### prefixes in the openneuro.org bucket.
// Step 2: for each, list the first sub-XX/ prefix.
// Step 3: list the first <datatype>/ subfolder under that subject.
// Step 4: scan that subfolder for the first primary recording file
//         matching one of our supported extensions.
//
// Output: scripts/audit-openneuro-one-per-dataset.json — same schema as
// audit-100-datasets.json so the audit spec can consume it via
// AUDIT_MANIFEST.
import fs from 'node:fs';

const SUPPORTED_EXTS = ['edf','bdf','set','vhdr','fif','snirf','ds','con','sqd','nwb','mefd','raw','kdf'];
const ELECTRO_DATATYPES = ['eeg','ieeg','meg','emg','nirs'];
const S3 = 'https://s3.amazonaws.com/openneuro.org';
const CDN = 'https://cdn.eegdash.org';
const CONCURRENCY = 32;
// Skip enumeration entirely for datasets known to be non-electrophysiology
// (no sub-XXX/ with eeg/ieeg/meg/emg/nirs folder). We don't have that
// metadata up front; instead we probe optimistically and accept the
// "no datatype folder" misses as fast S3 404s.

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

async function listS3(prefix, delimiter = '/', maxKeys = 100) {
  const url = new URL(S3 + '/');
  url.searchParams.set('list-type', '2');
  url.searchParams.set('prefix', prefix);
  if (delimiter) url.searchParams.set('delimiter', delimiter);
  url.searchParams.set('max-keys', String(maxKeys));
  const r = await fetch(url);
  if (!r.ok) return { keys: [], prefixes: [], nextToken: null };
  return parseS3Xml(await r.text());
}

async function listAllPaginated(prefix, delimiter = '/', maxKeys = 1000, hardCap = 5000) {
  const all = { keys: [], prefixes: [] };
  let token = null;
  for (let i = 0; i < 20 && all.prefixes.length + all.keys.length < hardCap; i++) {
    const url = new URL(S3 + '/');
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', prefix);
    if (delimiter) url.searchParams.set('delimiter', delimiter);
    url.searchParams.set('max-keys', String(maxKeys));
    if (token) url.searchParams.set('continuation-token', token);
    const r = await fetch(url);
    if (!r.ok) break;
    const { keys, prefixes, nextToken } = parseS3Xml(await r.text());
    all.keys.push(...keys); all.prefixes.push(...prefixes);
    if (!nextToken) break;
    token = nextToken;
  }
  return all;
}

console.error('Step 1: enumerate all ds###### dataset root folders...');
const root = await listAllPaginated('ds', '/', 1000);
const datasets = root.prefixes
  .map(p => p.replace(/\/$/, ''))
  .filter(p => /^ds\d{6}$/.test(p))
  .sort();
console.error(`  Found ${datasets.length} datasets`);

const out = [];
let processed = 0;
const tStart = Date.now();

async function pickOneRecording(dsId) {
  // List first sub-XX/ prefix (capped at 5 so we can fall through if first
  // has no electrophysiology folder).
  const subs = await listS3(`${dsId}/sub-`, '/', 5);
  for (const subPrefix of subs.prefixes.slice(0, 5)) {
    // Some datasets nest under ses-XX/ first. Try direct datatype folders, then ses-XX.
    for (const datatype of ELECTRO_DATATYPES) {
      // First try sub-X/<datatype>/
      const direct = await listS3(`${subPrefix}${datatype}/`, '/', 50);
      const found = scanForPrimary(direct.keys, datatype, dsId);
      if (found) return found;
    }
    // Try first ses-Y/ child
    const sessions = await listS3(`${subPrefix}ses-`, '/', 3);
    for (const sesPrefix of sessions.prefixes.slice(0, 3)) {
      for (const datatype of ELECTRO_DATATYPES) {
        const direct = await listS3(`${sesPrefix}${datatype}/`, '/', 50);
        const found = scanForPrimary(direct.keys, datatype, dsId);
        if (found) return found;
      }
    }
  }
  return null;
}

function scanForPrimary(keys, datatype, dsId) {
  // Find the first primary recording file in this datatype folder.
  for (const k of keys) {
    const filename = k.split('/').pop();
    const ext = filename.split('.').pop().toLowerCase();
    // Skip sidecars + companion bins (we only pick the primary header).
    if (filename.endsWith('.fdt') || filename.endsWith('.vmrk') || filename.endsWith('.eeg')) continue;
    if (filename.endsWith('.json') || filename.endsWith('.tsv')) continue;
    // CTF .ds bundle — pick the .meg4 leaf inside the .ds folder
    if (/\.meg4$/i.test(filename)) {
      return { dataset_id: dsId, cdn_url: `${CDN}/${k}`, ext: 'ds', datatype, verdict: 'loadable' };
    }
    if (SUPPORTED_EXTS.includes(ext)) {
      return { dataset_id: dsId, cdn_url: `${CDN}/${k}`, ext, datatype, verdict: 'loadable' };
    }
  }
  return null;
}

const queue = datasets.slice();
async function worker(i) {
  while (queue.length) {
    const dsId = queue.shift();
    if (!dsId) return;
    try {
      const rec = await pickOneRecording(dsId);
      if (rec) out.push(rec);
    } catch (e) {
      // ignore — datasets without electrophysiology folders simply have no match
    }
    processed++;
    if (processed % 50 === 0 || processed === datasets.length) {
      const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
      console.error(`  ${processed}/${datasets.length} (${elapsed}s) — ${out.length} datasets with electro recordings`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));

console.error(`\nTotal datasets scanned: ${datasets.length}`);
console.error(`Datasets with at least one electrophysiology recording: ${out.length}`);
console.error(`Hit rate: ${(out.length / datasets.length * 100).toFixed(1)}%`);

// Sanity stats per datatype + ext
const byDatatype = {}, byExt = {};
for (const r of out) {
  byDatatype[r.datatype] = (byDatatype[r.datatype] ?? 0) + 1;
  byExt[r.ext] = (byExt[r.ext] ?? 0) + 1;
}
console.error('\nBy datatype:', byDatatype);
console.error('By extension:', byExt);

fs.writeFileSync('scripts/audit-openneuro-one-per-dataset.json', JSON.stringify({
  meta: {
    source: 'OpenNeuro S3 bucket enumeration',
    one_recording_per_dataset: true,
    total_datasets_scanned: datasets.length,
    datasets_with_electro_recordings: out.length,
    by_datatype: byDatatype,
    by_ext: byExt,
  },
  results: out,
}, null, 2));
console.error('\nWrote scripts/audit-openneuro-one-per-dataset.json');
