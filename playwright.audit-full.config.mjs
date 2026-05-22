// playwright.audit-full.config.mjs
//
// Override config used ONLY by `npm run test:audit-reality:full`. The base
// config (playwright.config.mjs) keeps fullyParallel:false because most specs
// share the truncate-on-load sentinel in audit-loadable.spec.mjs. For the
// 712-dataset full run we re-enable parallelism (4 workers, ~3 hours →
// ~50 min wall) and switch the spec to per-worker JSONL shards so writes
// never race.
import { defineConfig } from '@playwright/test';
import base from './playwright.config.mjs';

export default defineConfig({
  ...base,
  fullyParallel: true,
  // Lowered 2026-05-22 from 4 → 2 workers because Cloudflare rate-limits
  // the audit at 4 workers when running back-to-back full audits
  // (observed: 402/647 datasets failed with 'Failed to fetch' after CDN
  // started returning HTTP 429 to nearly every URL). 2 workers gives
  // ~3-5 req/s instead of ~10-15 req/s, well within typical CDN burst
  // quotas. Wall time roughly doubles (50 min → 90 min for 647), but
  // we get clean results instead of mass 429.
  workers: 2,
  // Per-test timeout. Raised 2026-05-22 from inherited 90 s → 180 s
  // because the inline-cap raise (200 MB → 1 GB) means EEGLAB v7.3
  // .sets in the 500–900 MB range now fully load (instead of instantly
  // rejecting at the cap), which takes 60–90 s of fetch + parse on a
  // typical home connection. The stage-caption gate inside the spec
  // is 120 s; this outer test timeout has to be larger so a slow-but-
  // valid file doesn't fail with playwright's own timeout *before* the
  // spec's race resolves.
  timeout: 180_000,
  reporter: [
    ['list'],
    ['json', { outputFile: 'tests/evidence/audit-browser-reality/playwright-full.json' }],
  ],
});
