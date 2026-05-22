#!/usr/bin/env node
// Expand the audit catalog: for each of the 89 unique datasets in
// audit-100-datasets.json, enumerate up to PER_DATASET_CAP recording
// URLs (different subjects/sessions/runs) by listing the OpenNeuro S3
// bucket. Produces audit-100-datasets-expanded.json with the same
// schema as the source, so the audit-loadable spec can consume it.
//
// Why: the seed manifest only picks ONE canonical recording per dataset
// (first subject + first session + first file), giving 89 unique URLs.
// To stress-test the readers across real-world variation (different
// recording lengths, channel counts, subject-specific quirks) we want
// hundreds of URLs.
import fs from 'node:fs';

const SUPPORTED_EXTS = new Set(['edf','bdf','set','vhdr','fif','snirf','ds','con','sqd','nwb','mefd','raw','kdf']);
const S3 = 'https://s3.amazonaws.com/openneuro.org';
const CDN = 'https://cdn.eegdash.org';
const PER_DATASET_CAP = 12;

const audit = JSON.parse(fs.readFileSync('scripts/audit-100-datasets.json', 'utf8'));
const datasets = [...new Set(audit.results.filter(r => r.verdict === 'loadable').map(r => r.dataset_id))];
console.error(`Expanding ${datasets.length} datasets to up to ${PER_DATASET_CAP} recordings each...`);

function parseS3Keys(xml) {
  const keys = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m;
  while ((m = re.exec(xml))) keys.push(m[1]);
  return keys;
}

async function listAllKeys(prefix) {
  const keys = [];
  let token = null;
  for (let i = 0; i < 5 && keys.length < 5000; i++) {
    const url = new URL(S3 + '/');
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', prefix);
    url.searchParams.set('max-keys', '1000');
    if (token) url.searchParams.set('continuation-token', token);
    const r = await fetch(url);
    if (!r.ok) break;
    const xml = await r.text();
    keys.push(...parseS3Keys(xml));
    const cm = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
    if (!cm) break;
    token = cm[1];
  }
  return keys;
}

function pickRecordings(keys, originalUrl) {
  const origMatch = /\/(?<datatype>eeg|ieeg|meg|emg|nirs)\/[^/]+\.(?<ext>[a-z0-9]+)/i.exec(originalUrl);
  const origDatatype = origMatch?.groups?.datatype ?? null;
  const origExt = origMatch?.groups?.ext?.toLowerCase() ?? null;
  const isDs = origExt === 'ds' || /\.meg4$/i.test(originalUrl);
  const picked = [];
  const seenStems = new Set();
  for (const k of keys) {
    const m = /\/sub-(?<sub>[^/]+)\/(?:ses-(?<ses>[^/]+)\/)?(?<datatype>eeg|ieeg|meg|emg|nirs)\/(?<file>.+)$/i.exec(k);
    if (!m) continue;
    if (origDatatype && m.groups.datatype !== origDatatype) continue;
    const file = m.groups.file;
    let ext = file.split('.').pop().toLowerCase();
    if (isDs) {
      if (!/\.meg4$/i.test(file)) continue;
      ext = 'ds';
    } else {
      if (!SUPPORTED_EXTS.has(ext)) continue;
      if (origExt && origExt !== ext) continue;
    }
    const stem = `${m.groups.sub}/${m.groups.ses ?? ''}/${file.split('.')[0]}`;
    if (seenStems.has(stem)) continue;
    seenStems.add(stem);
    picked.push({ key: k, sub: m.groups.sub, ses: m.groups.ses, ext });
    if (picked.length >= PER_DATASET_CAP) break;
  }
  return picked;
}

const expanded = [];
let done = 0;
for (const dsId of datasets) {
  const seed = audit.results.find(r => r.dataset_id === dsId && r.verdict === 'loadable');
  if (!seed) continue;
  try {
    const keys = await listAllKeys(`${dsId}/`);
    const picks = pickRecordings(keys, seed.cdn_url);
    for (const p of picks) {
      expanded.push({
        dataset_id: dsId,
        cdn_url: `${CDN}/${p.key}`,
        ext: p.ext,
        datatype: seed.datatype,
        verdict: 'loadable',
      });
    }
    done++;
    console.error(`  [${done}/${datasets.length}] ${dsId}: ${picks.length} recordings (keys=${keys.length})`);
  } catch (e) {
    console.error(`  [${dsId}] ERR: ${e.message}`);
  }
}

console.error(`\nTotal expanded URLs: ${expanded.length}`);
fs.writeFileSync('scripts/audit-100-datasets-expanded.json', JSON.stringify({
  meta: { source: 'expanded from audit-100-datasets.json', per_dataset_cap: PER_DATASET_CAP },
  results: expanded,
}, null, 2));
console.error('Wrote scripts/audit-100-datasets-expanded.json');
