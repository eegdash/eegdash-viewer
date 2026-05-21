#!/usr/bin/env node
/**
 * scripts/audit-failure-classifier.mjs
 *
 * Consumes tests/evidence/audit-browser-reality/results-full.jsonl
 * (produced by `npm run merge:audit-shards`) and emits
 * tests/evidence/audit-browser-reality/results-classified.jsonl with an
 * added per-row `failure_class` field. Pass rows get `failure_class: null`.
 *
 * Bins are matched in priority order (first match wins). Each bin maps to a
 * known viewer code path:
 *   format-CTF-residual          — formats/ctf.js post offset-fix bugs (a52b74c)
 *   format-FIFF-large            — fetchBuffer 200 MB cap in src/http-range.js
 *   format-FIFF-no-raw-block     — FIFF file has no FIFFB_RAW_DATA block
 *                                  (events/projections/annotations sidecar only)
 *   format-EEGLAB-large          — 200 MB inline .set cap (91aeae3)
 *   format-EEGLAB-v73-renamed-fdt — Mat73 reader (d555923) + cross-basename fdt
 *   network-flake                — 5xx/TLS/DNS surfaced as page console errors
 *   timeout-cold-cdn             — stage-caption never visible within 60 s
 *   unknown                      — needs investigation (escalate to sleuth)
 *
 * Usage:
 *   node scripts/audit-failure-classifier.mjs
 *   node scripts/audit-failure-classifier.mjs --in <path> --out <path>
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'tests/evidence/audit-browser-reality');

function parseArgs(argv) {
  const out = {
    inPath: path.join(EVIDENCE_DIR, 'results-full.jsonl'),
    outPath: path.join(EVIDENCE_DIR, 'results-classified.jsonl'),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in' && argv[i + 1]) {
      out.inPath = path.resolve(argv[i + 1]);
      i++;
    } else if (argv[i] === '--out' && argv[i + 1]) {
      out.outPath = path.resolve(argv[i + 1]);
      i++;
    }
  }
  return out;
}

// Each entry: { class, test(row) -> boolean }. First true wins.
// Order matters: more-specific format bins before generic network/timeout bins.
const CLASSIFIERS = [
  {
    class: 'format-CTF-residual',
    test: (r) => r.ext === 'ds' && r.verdict !== 'pass',
  },
  {
    class: 'format-FIFF-large',
    test: (r) => {
      if (r.ext !== 'fif') return false;
      const m = r.error_message ?? '';
      return /(fetchBuffer|exceeds .* cap|over .*MB|200 ?MB)/i.test(m);
    },
  },
  {
    class: 'format-FIFF-no-raw-block',
    test: (r) => {
      if (r.ext !== 'fif') return false;
      const m = r.error_message ?? '';
      return /FIFFB_RAW_DATA|no .*raw.*block|events\/projections\/annotations only/i.test(m);
    },
  },
  {
    class: 'format-EEGLAB-large',
    test: (r) => {
      if (r.ext !== 'set') return false;
      const m = r.error_message ?? '';
      return /200 ?MB|inline .* exceeds|cap on inline/i.test(m);
    },
  },
  {
    class: 'format-EEGLAB-v73-renamed-fdt',
    test: (r) => {
      if (r.ext !== 'set') return false;
      const m = r.error_message ?? '';
      return /v?7\.3|HDF5|jsfive|renamed .*fdt|fdt .*not found/i.test(m);
    },
  },
  {
    class: 'network-flake',
    test: (r) => {
      if (r.verdict !== 'console-error') return false;
      const m = r.error_message ?? '';
      return /5\d\d|net::ERR|TLS|ECONNRESET|EAI_AGAIN/i.test(m);
    },
  },
  {
    class: 'timeout-cold-cdn',
    test: (r) => {
      if (r.verdict === 'timeout') return true;
      if (r.verdict !== 'render-fail') return false;
      const m = r.error_message ?? '';
      return /stage-caption never visible/i.test(m);
    },
  },
];

function classify(row) {
  if (row.verdict === 'pass') return null;
  for (const c of CLASSIFIERS) {
    if (c.test(row)) return c.class;
  }
  return 'unknown';
}

function main() {
  const { inPath, outPath } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(inPath)) {
    throw new Error(`input not found: ${inPath} — run \`npm run merge:audit-shards\` first`);
  }
  const rows = fs
    .readFileSync(inPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));

  const out = rows.map((r) => ({ ...r, failure_class: classify(r) }));
  const tally = {};
  for (const r of out) {
    const k = r.failure_class ?? 'pass';
    tally[k] = (tally[k] ?? 0) + 1;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`classified ${out.length} rows → ${outPath}`);
  console.log('tally:', JSON.stringify(tally, null, 2));
}

main();
