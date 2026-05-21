#!/usr/bin/env node
/**
 * scripts/audit-merge-shards.mjs
 *
 * Merges per-worker JSONL shards (results.worker-*.jsonl) produced by the
 * AUDIT_FULL=1 run of audit-loadable.spec.mjs into a single, deterministically
 * sorted results-full.jsonl. Idempotent: re-running overwrites the merged
 * file without touching the shards.
 *
 * Usage:
 *   node scripts/audit-merge-shards.mjs
 *   node scripts/audit-merge-shards.mjs --out tests/evidence/audit-browser-reality/results-full.jsonl
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'tests/evidence/audit-browser-reality');

function parseArgs(argv) {
  const out = { outPath: path.join(EVIDENCE_DIR, 'results-full.jsonl') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) {
      out.outPath = path.resolve(argv[i + 1]);
      i++;
    }
  }
  return out;
}

function loadShards() {
  if (!fs.existsSync(EVIDENCE_DIR)) {
    throw new Error(`evidence directory not found: ${EVIDENCE_DIR}`);
  }
  const files = fs
    .readdirSync(EVIDENCE_DIR)
    .filter((f) => /^results\.worker-\d+\.jsonl$/.test(f))
    .sort();
  if (files.length === 0) {
    throw new Error(
      `no worker shards found in ${EVIDENCE_DIR} — run \`npm run test:audit-reality:full\` first`,
    );
  }
  const rows = [];
  for (const f of files) {
    const full = path.join(EVIDENCE_DIR, f);
    const lines = fs.readFileSync(full, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    for (let i = 0; i < lines.length; i++) {
      try {
        rows.push(JSON.parse(lines[i]));
      } catch (err) {
        throw new Error(`${f} line ${i + 1} is not valid JSON: ${err.message}`);
      }
    }
  }
  return { rows, shardFiles: files };
}

function dedupeAndSort(rows) {
  // Dedupe by cdn_url (a URL should be tested exactly once across all
  // workers; if it appears twice, prefer the row with verdict==='pass'
  // — re-runs after a flake should override the failing row).
  const byUrl = new Map();
  for (const r of rows) {
    const existing = byUrl.get(r.cdn_url);
    if (!existing) {
      byUrl.set(r.cdn_url, r);
      continue;
    }
    const existingPasses = existing.verdict === 'pass';
    const incomingPasses = r.verdict === 'pass';
    if (incomingPasses && !existingPasses) byUrl.set(r.cdn_url, r);
  }
  return Array.from(byUrl.values()).sort((a, b) => {
    const da = a.dataset_id ?? '';
    const db = b.dataset_id ?? '';
    if (da !== db) return da.localeCompare(db);
    return (a.cdn_url ?? '').localeCompare(b.cdn_url ?? '');
  });
}

function main() {
  const { outPath } = parseArgs(process.argv.slice(2));
  const { rows: raw, shardFiles } = loadShards();
  const merged = dedupeAndSort(raw);
  const payload = merged.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, payload);
  console.log(
    `merged ${shardFiles.length} shard(s) → ${merged.length} unique rows (from ${raw.length} raw) → ${outPath}`,
  );
}

main();
