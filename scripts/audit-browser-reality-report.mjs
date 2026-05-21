#!/usr/bin/env node
/**
 * scripts/audit-browser-reality-report.mjs
 *
 * Consumes tests/evidence/audit-browser-reality/results.jsonl (one JSON
 * line per dataset, produced by tests/e2e/acceptance/audit-loadable.spec.mjs)
 * and writes docs/audit-browser-reality-2026-05-21.md.
 *
 * Pure transform — no network, no Playwright dependency. Idempotent:
 * rerunning overwrites the doc but does not touch the JSONL.
 *
 * Usage:
 *   node scripts/audit-browser-reality-report.mjs
 *   node scripts/audit-browser-reality-report.mjs --out docs/custom-name.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const JSONL = path.join(REPO_ROOT, 'tests/evidence/audit-browser-reality/results.jsonl');

function parseArgs(argv) {
  const out = { outPath: path.join(REPO_ROOT, 'docs/audit-browser-reality-2026-05-21.md') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) {
      out.outPath = path.resolve(argv[i + 1]);
      i++;
    }
  }
  return out;
}

function loadRows() {
  if (!fs.existsSync(JSONL)) {
    throw new Error(
      `results JSONL not found at ${JSONL} — run \`npm run test:audit-reality\` first`,
    );
  }
  return fs
    .readFileSync(JSONL, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (err) {
        throw new Error(`results.jsonl line ${i + 1} is not valid JSON: ${err.message}`);
      }
    });
}

const VERDICT_ICON = {
  pass: 'PASS',
  'render-fail': 'FAIL (render)',
  'blank-canvas': 'FAIL (blank canvas)',
  'console-error': 'FAIL (console error)',
  'pill-mismatch': 'FAIL (pill mismatch)',
  timeout: 'FAIL (timeout)',
  skipped: 'SKIPPED',
  unknown: 'UNKNOWN',
};

function summarise(rows) {
  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  const total = rows.length;
  const passed = counts.pass ?? 0;
  const passRate = total === 0 ? 0 : (passed / total) * 100;
  const renderTimes = rows.filter((r) => typeof r.render_ms === 'number').map((r) => r.render_ms);
  const medianMs =
    renderTimes.length === 0
      ? null
      : renderTimes.slice().sort((a, b) => a - b)[Math.floor(renderTimes.length / 2)];
  return { counts, total, passed, passRate, medianMs };
}

// Strip ANSI escapes + collapse whitespace so failure messages render as a
// single clean line in the report's table column.
function cleanErrorMessage(msg) {
  if (!msg) return '';
  // eslint-disable-next-line no-control-regex
  const ansiRe = /\[[0-9;]*m/g;
  return String(msg)
    .replace(ansiRe, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fmtRow(r) {
  const verdict = VERDICT_ICON[r.verdict] ?? r.verdict;
  const renderMs = r.render_ms == null ? '—' : `${r.render_ms} ms`;
  const errors = r.console_errors + r.page_errors;
  const cleanedMsg = cleanErrorMessage(r.error_message);
  const errCell = errors === 0 ? '0' : `${errors} (${cleanedMsg})`;
  const pill = r.pill_format ?? '—';
  return `| ${r.dataset_id} | ${r.ext} | ${r.datatype ?? '—'} | ${verdict} | ${renderMs} | ${pill} | ${errCell.replace(/\|/g, '\\|').slice(0, 120)} |`;
}

function render(rows) {
  const { counts, total, passed, passRate, medianMs } = summarise(rows);
  const today = new Date().toISOString().slice(0, 10);

  const verdictLines = Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `- **${VERDICT_ICON[k] ?? k}**: ${v}`)
    .join('\n');

  const tableHeader =
    '| dataset_id | ext | datatype | verdict | render_time | pill | console_errors |\n' +
    '|---|---|---|---|---:|---|---|';

  const rowsSorted = rows
    .slice()
    .sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === 'pass' ? 1 : -1));

  return `# Browser reality check — audit-claimed loadable datasets

**Date:** ${today}
**Source JSONL:** \`tests/evidence/audit-browser-reality/results.jsonl\`
**Spec:** \`tests/e2e/acceptance/audit-loadable.spec.mjs\`
**Probe:** real Chromium navigation to \`/?eeg=<cdn_url>\` with stage-caption + canvas + console-error assertions.

## Headline

**${passed} of ${total} datasets (${passRate.toFixed(1)}%) actually render in the browser.**

Median end-to-end render time: ${medianMs == null ? 'n/a' : `${medianMs} ms`}.

## Verdict breakdown

${verdictLines || '_no rows_'}

## Per-dataset results

${tableHeader}
${rowsSorted.map(fmtRow).join('\n')}

## How to reproduce

\`\`\`bash
# Default 10-sample run (strict assertions)
npm run test:audit-reality

# Soft-fail mode (every per-dataset test marked fixme; JSONL still written)
AUDIT_SOFT_FAIL=1 npm run test:audit-reality:soft

# Manual full run (all 80 loadable URLs — ~40 min)
AUDIT_SAMPLE_SIZE=80 npm run test:audit-reality

# Regenerate this report from the existing JSONL
npm run report:audit-reality
\`\`\`

## Notes

- The audit JSON (\`scripts/audit-100-datasets.json\`) marks "loadable" based on a 1-byte HEAD-range probe. This report verifies the viewer's reader actually decodes + renders.
- Failures here that the audit marked loadable are real reader/parser bugs (or sidecar-resolution bugs); failures that the audit also missed are network flakes — re-run with a different \`AUDIT_SEED\` to subsample a different slice.
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
