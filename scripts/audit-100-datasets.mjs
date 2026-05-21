#!/usr/bin/env node
/**
 * Sample 100 datasets from data.eegdash.org and check how many would
 * load in the viewer.
 *
 * Improved methodology:
 *   1. Fetch the catalog of all eegdash datasets.
 *   2. Random-sample 100.
 *   3. For each: fetch participants.tsv to get the real first subject.
 *   4. List S3 `openneuro.org/<dataset>/sub-<first>/<datatype>/` to find
 *      the first recording file (using AWS XML list API — public read).
 *   5. Build the viewer-equivalent URL from the actual file key.
 *   6. Probe via cdn.eegdash.org (the same path the viewer would use).
 *   7. Classify: loadable / catalog-only / cdn-missing.
 *
 * Output: scripts/audit-100-datasets.json + a summary table.
 */

import fs from 'node:fs';
import path from 'node:path';

const CATALOG_API = 'https://data.eegdash.org/api/eegdash/datasets';
const CDN = 'https://cdn.eegdash.org';
const S3 = 'https://s3.amazonaws.com/openneuro.org';
const PER_PAGE = 100;
const SAMPLE_SIZE = 100;
const BATCH = 8;
const PROBE_TIMEOUT_MS = 15_000;

// Supported by the viewer.
const SUPPORTED_DATATYPES = new Set(['eeg', 'ieeg', 'meg', 'emg', 'nirs']);
const SUPPORTED_EXTS = new Set(['edf', 'bdf', 'set', 'vhdr', 'fif', 'snirf']);

// --- catalog --------------------------------------------------------

async function fetchCatalog() {
  const meta = await fetch(`${CATALOG_API}?limit=1`).then(r => r.json());
  const total = meta.total;
  const pages = Math.ceil(total / PER_PAGE);
  process.stderr.write(`Fetching ${total} datasets in ${pages} pages…\n`);
  const out = [];
  for (let p = 0; p < pages; p++) {
    const r = await fetch(`${CATALOG_API}?limit=${PER_PAGE}&offset=${p * PER_PAGE}`)
      .then(r => r.json());
    out.push(...r.data);
    process.stderr.write(`  page ${p + 1}/${pages} → ${out.length} total\n`);
  }
  return out;
}

// --- per-dataset discovery ------------------------------------------

async function fetchFirstSubject(dataset) {
  // Primary: read participants.tsv. Most datasets have it.
  try {
    const r = await fetch(`${CDN}/${dataset}/participants.tsv`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (r.ok) {
      const text = await r.text();
      const lines = text.split('\n').filter(l => l.trim());
      if (lines.length >= 2) {
        const firstParticipant = lines[1].split('\t')[0].trim();
        return firstParticipant.replace(/^sub-/, '');
      }
    }
  } catch {}
  // Fallback: list S3 to find the first sub-XXX/ key. Some datasets
  // (ds003774) lack participants.tsv but DO have data under sub-NNN/.
  try {
    const keys = await listS3(`${dataset}/sub-`);
    for (const key of keys) {
      const m = /^[^/]+\/sub-([^/]+)\//.exec(key);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

async function listS3(prefix) {
  // S3 ListObjectsV2. Returns the first 20 keys under the prefix.
  const url = `${S3}?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=20`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!r.ok) return [];
    const xml = await r.text();
    const keys = [];
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      keys.push(m[1]);
    }
    return keys;
  } catch {
    return [];
  }
}

function pickRecording(keys, datatype) {
  // From a list of S3 keys, pick the first one whose path matches:
  //   sub-X/[ses-Y/]<datatype>/<entities>_<suffix>.<ext>
  // where ext is a viewer-supported extension.
  const re = new RegExp(`/${datatype}/[^/]+_${datatype}\\.([a-z0-9]+)$`, 'i');
  for (const key of keys) {
    const m = re.exec(key);
    if (m && SUPPORTED_EXTS.has(m[1].toLowerCase())) {
      return { key, ext: m[1].toLowerCase() };
    }
  }
  return null;
}

async function classifyDataset(record) {
  const dataset = record.dataset_id;
  const datatypes = (record.datatypes || []).filter(t => SUPPORTED_DATATYPES.has(t));
  if (datatypes.length === 0) {
    return {
      dataset_id: dataset,
      verdict: 'unsupported-datatype',
      datatypes: record.datatypes,
    };
  }

  // First subject from participants.tsv (with fallback to common IDs).
  const sub = await fetchFirstSubject(dataset) || '01';

  // For each datatype, try to find an actual recording file via S3.
  for (const datatype of datatypes) {
    // Try with and without session directory. Some datasets use
    // sub-X/ses-Y/<datatype>/..., others use sub-X/<datatype>/...
    const sesEntries = (record.sessions || []).slice(0, 3);  // try first 3
    const prefixes = [
      `${dataset}/sub-${sub}/${datatype}/`,
      ...sesEntries.map(ses => `${dataset}/sub-${sub}/ses-${ses}/${datatype}/`),
    ];
    for (const prefix of prefixes) {
      const keys = await listS3(prefix);
      if (keys.length === 0) continue;
      const rec = pickRecording(keys, datatype);
      if (rec) {
        // Build the URL the viewer would use (cdn.eegdash.org).
        const cdnUrl = `${CDN}/${rec.key}`;
        // Probe the CDN to confirm the file is mirrored.
        let cdnOk = false;
        try {
          const r = await fetch(cdnUrl, {
            method: 'GET',
            headers: { Range: 'bytes=0-0' },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          cdnOk = r.status === 200 || r.status === 206;
        } catch {}
        return {
          dataset_id: dataset,
          verdict: cdnOk ? 'loadable' : 'cdn-missing-file',
          datatype,
          sub,
          key: rec.key,
          ext: rec.ext,
          cdn_url: cdnUrl,
        };
      }
    }
  }

  return {
    dataset_id: dataset,
    verdict: 'no-recording-found',
    datatypes,
    triedSub: sub,
  };
}

// --- sampling -------------------------------------------------------

function sample(arr, n) {
  // Reservoir sample (Algorithm R) for deterministic-ish randomness.
  const out = arr.slice(0, n);
  for (let i = n; i < arr.length; i++) {
    const j = Math.floor(Math.random() * (i + 1));
    if (j < n) out[j] = arr[i];
  }
  return out;
}

// --- main -----------------------------------------------------------

async function main() {
  const allDatasets = await fetchCatalog();
  process.stderr.write(`\nCatalog: ${allDatasets.length} datasets.\n`);
  process.stderr.write(`Sampling ${SAMPLE_SIZE} at random…\n\n`);

  const sampled = sample(allDatasets, SAMPLE_SIZE);

  const results = [];
  for (let i = 0; i < sampled.length; i += BATCH) {
    const batch = sampled.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(classifyDataset));
    results.push(...batchResults);
    const loadableInBatch = batchResults.filter(r => r.verdict === 'loadable').length;
    process.stderr.write(
      `  ${String(results.length).padStart(3)}/${sampled.length} ` +
      `(${loadableInBatch}/${batch.length} loadable in this batch)\n`,
    );
  }

  // Summary
  const verdictCounts = {};
  for (const r of results) {
    verdictCounts[r.verdict] = (verdictCounts[r.verdict] || 0) + 1;
  }

  console.log('\n=== AUDIT SUMMARY ===\n');
  console.log(`Catalog total:  ${allDatasets.length}`);
  console.log(`Sampled:        ${results.length}\n`);
  console.log(`Verdict counts:`);
  for (const [v, n] of Object.entries(verdictCounts).sort((a, b) => b[1] - a[1])) {
    const pct = ((n / results.length) * 100).toFixed(1);
    console.log(`  ${v.padEnd(24)} ${String(n).padStart(3)}  (${pct}%)`);
  }

  const byDatatype = {};
  for (const r of results) {
    const key = r.datatype || (r.datatypes && r.datatypes[0]) || 'unknown';
    if (!byDatatype[key]) byDatatype[key] = { loadable: 0, total: 0 };
    byDatatype[key].total++;
    if (r.verdict === 'loadable') byDatatype[key].loadable++;
  }
  console.log(`\nLoadable rate by datatype:`);
  for (const [t, { loadable, total }] of Object.entries(byDatatype).sort((a, b) => b[1].total - a[1].total)) {
    const pct = ((loadable / total) * 100).toFixed(1);
    console.log(`  ${t.padEnd(10)} ${loadable}/${total}  (${pct}%)`);
  }

  // Write full results
  const outPath = path.resolve('scripts/audit-100-datasets.json');
  fs.writeFileSync(outPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    catalogTotal: allDatasets.length,
    sampled: results.length,
    verdictCounts,
    byDatatype,
    results,
  }, null, 2));
  console.log(`\nFull report: ${outPath}`);

  // Non-loadable examples for debugging
  const nonLoadable = results.filter(r => r.verdict !== 'loadable').slice(0, 10);
  if (nonLoadable.length > 0) {
    console.log(`\nFirst ${nonLoadable.length} non-loadable examples:`);
    for (const r of nonLoadable) {
      const detail = r.key || `datatypes=${JSON.stringify(r.datatypes || [])}`;
      console.log(`  ${r.dataset_id.padEnd(12)} ${r.verdict.padEnd(22)}  ${detail}`);
    }
  }

  // Loadable examples for confirmation
  const loadable = results.filter(r => r.verdict === 'loadable').slice(0, 5);
  if (loadable.length > 0) {
    console.log(`\nFirst ${loadable.length} loadable examples:`);
    for (const r of loadable) {
      console.log(`  ${r.dataset_id.padEnd(12)} ${r.datatype.padEnd(5)} sub-${r.sub}  ${r.key}`);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
