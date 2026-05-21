#!/usr/bin/env node
/**
 * scripts/audit-browser-reality-full-report.mjs
 *
 * Consumes tests/evidence/audit-browser-reality/results-classified.jsonl
 * (produced by `npm run classify:audit-failures`) and emits
 * docs/audit-browser-reality-full-2026-05-21.md.
 *
 * Pure transform — no network, no Playwright dependency. Idempotent:
 * rerunning overwrites the doc but does not touch the JSONL.
 *
 * Usage:
 *   node scripts/audit-browser-reality-full-report.mjs
 *   node scripts/audit-browser-reality-full-report.mjs --out docs/custom.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'tests/evidence/audit-browser-reality');
const CLASSIFIED_JSONL = path.join(EVIDENCE_DIR, 'results-classified.jsonl');
const RUN_LOG = path.join(EVIDENCE_DIR, 'full-run.log');
const BASELINE_MD = path.join(REPO_ROOT, 'docs/audit-browser-reality-2026-05-21.md');

const BIN_ORDER = [
  'format-CTF-residual',
  'format-FIFF-large',
  'format-FIFF-no-raw-block',
  'format-EEGLAB-large',
  'format-EEGLAB-v73-renamed-fdt',
  'network-flake',
  'timeout-cold-cdn',
  'unknown',
];

const BIN_BLURB = {
  'format-CTF-residual': 'CTF .ds bundles that still fail after the .res4 offset fix (a52b74c). Each row needs a one-off look — likely a new .res4 header variant.',
  'format-FIFF-large': 'FIFF files that exceed the current 200 MB fetchBuffer cap in src/http-range.js. Lifting the cap requires streaming-decode work in formats/fiff.js.',
  'format-FIFF-no-raw-block': 'FIFF files that contain only events/projections/annotations (no FIFFB_RAW_DATA block). These are sidecar/companion files — the viewer has no recording to render. Surface a clearer error message and/or skip these in catalog discovery.',
  'format-EEGLAB-large': 'Inline .set files larger than 200 MB (cap added in 91aeae3). Same streaming-decode story as FIFF.',
  'format-EEGLAB-v73-renamed-fdt': 'MAT v7.3 (HDF5) .set files where the companion .fdt has a different basename than the .set. Mat73 reader (d555923) needs cross-basename .fdt sidecar resolution.',
  'network-flake': 'Console errors that surfaced 5xx/TLS/DNS — likely flakes, not viewer bugs. Re-run the listed URLs in isolation to confirm.',
  'timeout-cold-cdn': 'stage-caption never appeared within 60 s. Cold CDN + first range-fetch latency. Confirm by re-running the listed URLs after a warm-up GET.',
  unknown: 'Failures that did not match any classifier regex. Escalate to sleuth for one-by-one investigation.',
};

function parseArgs(argv) {
  const out = {
    outPath: path.join(REPO_ROOT, 'docs/audit-browser-reality-full-2026-05-21.md'),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) {
      out.outPath = path.resolve(argv[i + 1]);
      i++;
    }
  }
  return out;
}

function loadRows() {
  if (!fs.existsSync(CLASSIFIED_JSONL)) {
    throw new Error(
      `${CLASSIFIED_JSONL} not found — run \`npm run classify:audit-failures\` first`,
    );
  }
  return fs
    .readFileSync(CLASSIFIED_JSONL, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function parseRunLog() {
  if (!fs.existsSync(RUN_LOG)) return null;
  const text = fs.readFileSync(RUN_LOG, 'utf8');
  const startMatch = text.match(/^START (\S+)$/m);
  const endMatch = text.match(/^END (\S+)$/m);
  if (!startMatch || !endMatch) return null;
  const startMs = Date.parse(startMatch[1]);
  const endMs = Date.parse(endMatch[1]);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const totalMs = endMs - startMs;
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  return { totalMs, formatted: `${minutes}m ${seconds}s` };
}

function parseBaselinePass() {
  if (!fs.existsSync(BASELINE_MD)) return null;
  const text = fs.readFileSync(BASELINE_MD, 'utf8');
  // Headline format in the 20-sample report (audit-browser-reality-report.mjs:128):
  //   **N of M datasets (X.X%) actually render in the browser.**
  const m = text.match(/\*\*(\d+) of (\d+) datasets \(([\d.]+)%\)/);
  if (!m) return null;
  return { passed: +m[1], total: +m[2], pct: +m[3] };
}

function cleanMsg(msg) {
  if (!msg) return '';
  return String(msg)
    .replace(/\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarise(rows) {
  const verdictCounts = {};
  const classCounts = {};
  const renderTimes = [];
  for (const r of rows) {
    verdictCounts[r.verdict] = (verdictCounts[r.verdict] ?? 0) + 1;
    const k = r.failure_class ?? 'pass';
    classCounts[k] = (classCounts[k] ?? 0) + 1;
    if (typeof r.render_ms === 'number') renderTimes.push(r.render_ms);
  }
  renderTimes.sort((a, b) => a - b);
  const median = renderTimes.length === 0 ? null : renderTimes[Math.floor(renderTimes.length / 2)];
  return {
    verdictCounts,
    classCounts,
    total: rows.length,
    passed: verdictCounts.pass ?? 0,
    medianRenderMs: median,
  };
}

function renderBinTable(rows) {
  if (rows.length === 0) return '_no rows_\n';
  const header = '| dataset_id | ext | datatype | verdict | render_ms | error_message |\n|---|---|---|---|---:|---|';
  const body = rows
    .slice()
    .sort((a, b) => (a.dataset_id ?? '').localeCompare(b.dataset_id ?? ''))
    .map((r) => {
      const ms = r.render_ms == null ? '—' : `${r.render_ms}`;
      const msg = cleanMsg(r.error_message).slice(0, 140).replace(/\|/g, '\\|');
      return `| ${r.dataset_id} | ${r.ext ?? '—'} | ${r.datatype ?? '—'} | ${r.verdict} | ${ms} | ${msg} |`;
    })
    .join('\n');
  return `${header}\n${body}\n`;
}

function renderExampleUrls(rows) {
  // First 5 unique cdn_urls for the bin (cited inline so the reader can reproduce
  // without scrolling to the appendix).
  const seen = new Set();
  const urls = [];
  for (const r of rows) {
    if (!r.cdn_url || seen.has(r.cdn_url)) continue;
    seen.add(r.cdn_url);
    urls.push(r.cdn_url);
    if (urls.length === 5) break;
  }
  if (urls.length === 0) return '';
  return '\nFirst example URLs:\n' + urls.map((u) => `- ${u}`).join('\n') + '\n';
}

function renderSurprising(rows) {
  // "Surprising" = failures with the rarest extension among failures (signals
  // a code path we haven't seen break before). Tie-break by render_ms === null
  // (the test got nowhere at all, which is more surprising than a late blank-canvas).
  const failures = rows.filter((r) => r.verdict !== 'pass');
  const extFreq = {};
  for (const r of failures) extFreq[r.ext ?? 'unknown'] = (extFreq[r.ext ?? 'unknown'] ?? 0) + 1;
  const surprising = failures
    .slice()
    .sort((a, b) => {
      const fa = extFreq[a.ext ?? 'unknown'];
      const fb = extFreq[b.ext ?? 'unknown'];
      if (fa !== fb) return fa - fb;
      const nullA = a.render_ms == null ? 0 : 1;
      const nullB = b.render_ms == null ? 0 : 1;
      return nullA - nullB;
    })
    .slice(0, 10);
  return renderBinTable(surprising);
}

function renderAppendix(rows) {
  const header = '| dataset_id | ext | datatype | verdict | failure_class | render_ms | error_message |\n|---|---|---|---|---|---:|---|';
  const body = rows
    .slice()
    .sort((a, b) => {
      const da = a.dataset_id ?? '';
      const db = b.dataset_id ?? '';
      if (da !== db) return da.localeCompare(db);
      return (a.cdn_url ?? '').localeCompare(b.cdn_url ?? '');
    })
    .map((r) => {
      const ms = r.render_ms == null ? '—' : `${r.render_ms}`;
      const cls = r.failure_class ?? '—';
      const msg = cleanMsg(r.error_message).slice(0, 100).replace(/\|/g, '\\|');
      return `| ${r.dataset_id} | ${r.ext ?? '—'} | ${r.datatype ?? '—'} | ${r.verdict} | ${cls} | ${ms} | ${msg} |`;
    })
    .join('\n');
  return `${header}\n${body}\n`;
}

function render(rows) {
  const today = new Date().toISOString().slice(0, 10);
  const { verdictCounts, classCounts, total, passed, medianRenderMs } = summarise(rows);
  const passPct = total === 0 ? 0 : (passed / total) * 100;
  const wall = parseRunLog();
  const baseline = parseBaselinePass();

  const verdictLines = Object.entries(verdictCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `- **${k}**: ${v}`)
    .join('\n');

  const byClass = {};
  for (const r of rows) {
    const k = r.failure_class ?? 'pass';
    (byClass[k] ??= []).push(r);
  }

  const binSections = BIN_ORDER.map((bin) => {
    const binRows = byClass[bin] ?? [];
    return `### ${bin} — ${binRows.length} row(s)

${BIN_BLURB[bin]}
${renderExampleUrls(binRows)}
${renderBinTable(binRows)}`;
  }).join('\n');

  const comparison = baseline
    ? `**Baseline (20-sample, ${baseline.total} datasets):** ${baseline.passed}/${baseline.total} = ${baseline.pct.toFixed(1)}%
**Full run (this report, ${total} datasets):** ${passed}/${total} = ${passPct.toFixed(1)}%
**Delta:** ${(passPct - baseline.pct).toFixed(1)} pp`
    : '_baseline file not found at docs/audit-browser-reality-2026-05-21.md — skipping comparison_';

  return `# Browser reality check — FULL audit (all loadable URLs)

**Date:** ${today}
**Source JSONL:** \`tests/evidence/audit-browser-reality/results-classified.jsonl\`
**Spec:** \`tests/e2e/acceptance/audit-loadable.spec.mjs\` (AUDIT_FULL=1, 4 workers)
**Config:** \`playwright.audit-full.config.mjs\`
**Wall-clock:** ${wall ? wall.formatted : 'unknown'}

## Headline

**${passed} of ${total} datasets (${passPct.toFixed(1)}%) actually render in the browser.**

Median end-to-end render time: ${medianRenderMs == null ? 'n/a' : `${medianRenderMs} ms`}.

## Self-comparison vs 20-sample baseline

${comparison}

## Verdict breakdown

${verdictLines || '_no rows_'}

## Failure-mode classification

${binSections}

## Top 10 surprising failures

(Sorted by rarest failing extension first, then by tests that never got a render_ms.)

${renderSurprising(rows)}

## Per-dataset appendix

${renderAppendix(rows)}

## How to reproduce

\`\`\`bash
# Regenerate the audit JSON (file-existence probes, ~10 min):
node scripts/audit-100-datasets.mjs --full --out=scripts/audit-100-datasets.json

# Full 712-URL browser run (~50 min wall at 4 workers):
rm -f tests/evidence/audit-browser-reality/results.worker-*.jsonl
npm run test:audit-reality:full

# Merge per-worker shards + classify + render:
npm run merge:audit-shards
npm run classify:audit-failures
npm run report:audit-reality:full
\`\`\`

## Notes

- The audit JSON marks "loadable" based on a 1-byte HEAD-range probe. This report verifies the viewer's reader actually decodes + renders the file in a real Chromium.
- Network flakes are classified separately from real reader bugs (see the \`network-flake\` bin). Re-run the listed URLs in isolation before opening an issue.
- The \`unknown\` bin is the action queue: failures with no matching regex bin. Escalate row-by-row to the \`sleuth\` agent.
`;
}

function main() {
  const { outPath } = parseArgs(process.argv.slice(2));
  const rows = loadRows();
  const md = render(rows);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md);
  console.log(`wrote ${rows.length} rows to ${outPath}`);
}

main();
