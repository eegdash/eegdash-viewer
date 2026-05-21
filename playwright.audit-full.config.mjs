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
  workers: 4,
  // 712 × ~15 s budget per test = ~3 h serial → ~50 min wall at 4 workers.
  // No per-test timeout change: the existing 90 s budget already covers the
  // cold-CDN 60 s stage-caption deadline.
  reporter: [
    ['list'],
    ['json', { outputFile: 'tests/evidence/audit-browser-reality/playwright-full.json' }],
  ],
});
