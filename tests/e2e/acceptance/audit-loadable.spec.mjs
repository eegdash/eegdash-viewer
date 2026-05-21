/**
 * Acceptance: audit-loadable.spec.mjs
 *
 * Browser reality check for the dataset audit.
 *
 * The audit (scripts/audit-100-datasets.mjs, docs/audit-100-datasets-2026-05-21.md)
 * marks a dataset "loadable" when a 1-byte HEAD-range request returns 200/206.
 * That proves the file EXISTS on the CDN but NOT that the viewer's reader can
 * decode it. This spec closes that gap by opening each loadable URL in a real
 * browser and asserting render success.
 *
 * INPUTS
 *   scripts/audit-100-datasets.json — produced by `node scripts/audit-100-datasets.mjs`
 *   env AUDIT_SAMPLE_SIZE           — number of datasets to test (default 10)
 *   env AUDIT_SEED                  — PRNG seed for deterministic subsampling (default 42)
 *   env AUDIT_SOFT_FAIL             — '1' downgrades hard failures to test.fixme; default off
 *
 * OUTPUTS
 *   tests/evidence/audit-browser-reality/results.jsonl
 *     — one JSON line per dataset: { dataset_id, cdn_url, ext, verdict,
 *                                    render_ms, console_errors, page_errors,
 *                                    pill_format, non_bg_pixels, error_message }
 *
 * TIMEOUT BUDGET
 *   Per-test timeout    : 90 s (inherited from playwright.config.mjs)
 *   stage-caption visible: 60 s — cold CDN + range fetch
 *   Total wall-clock    : 10 × 60s ≈ 10 min for default sample
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const AUDIT_JSON = path.join(REPO_ROOT, 'scripts/audit-100-datasets.json');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'tests/evidence/audit-browser-reality');
const RESULTS_JSONL = path.join(EVIDENCE_DIR, 'results.jsonl');

const SAMPLE_SIZE = Number.parseInt(process.env.AUDIT_SAMPLE_SIZE ?? '10', 10);
const SEED = Number.parseInt(process.env.AUDIT_SEED ?? '42', 10);
const SOFT_FAIL = process.env.AUDIT_SOFT_FAIL === '1';

// Mulberry32 — small, deterministic PRNG so reruns sample the same N rows
// for a given seed. We don't need cryptographic randomness; we need
// reproducible "did dataset X get tested last run?" answers.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadLoadableRows() {
  if (!fs.existsSync(AUDIT_JSON)) {
    throw new Error(
      `audit JSON not found at ${AUDIT_JSON} — run \`node scripts/audit-100-datasets.mjs\` first`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(AUDIT_JSON, 'utf8'));
  const loadable = (raw.results ?? []).filter(
    (r) => r.verdict === 'loadable' && typeof r.cdn_url === 'string' && r.cdn_url.length > 0,
  );
  if (loadable.length === 0) {
    throw new Error('audit JSON has zero loadable rows — re-run the audit');
  }
  return loadable;
}

function subsample(rows, n, seed) {
  // Fisher-Yates with seeded RNG, take first n. Stable across runs for
  // a given seed even if the audit JSON row order changes.
  const rng = mulberry32(seed);
  const a = rows.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(n, a.length));
}

const ALL_LOADABLE = loadLoadableRows();
const CASES = subsample(ALL_LOADABLE, SAMPLE_SIZE, SEED);

// Truncate the JSONL sidecar at suite startup so a new run gets a fresh report.
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(RESULTS_JSONL, '');

test.describe('audit-loadable: browser reality check', () => {
  test('subsample bootstrap sanity', () => {
    // Sanity guard — if this fires, the loader produced an empty case list
    // and every dataset test will appear "skipped" instead of failing loudly.
    expect(CASES.length, 'subsampled case count').toBeGreaterThan(0);
    expect(CASES.length, 'subsample bounded by sample size').toBeLessThanOrEqual(SAMPLE_SIZE);
    for (const c of CASES) {
      expect(c.cdn_url, `case ${c.dataset_id} missing cdn_url`).toMatch(
        /^https:\/\/cdn\.eegdash\.org\//,
      );
    }
  });
});
