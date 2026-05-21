/**
 * Acceptance: streaming-large.spec.mjs
 *
 * Evidence gate for the range-based FIFF + EEGLAB-inline readers.
 * Loads each of three real recordings > 200 MB and asserts:
 *   - api.open completes in < 5 s   (stage-caption visible)
 *   - first readWindow < 2 s         (worker performance marks)
 *   - peak JS heap < 100 MB delta    (performance.memory polling)
 *
 * Outputs: tests/evidence/streaming-large/results.jsonl — one JSON
 * line per dataset with shape:
 *   { dataset_id, format, n_bytes, open_ms, read_ms, peak_heap_mb_delta, verdict }
 *
 * Run:  npm run test:streaming-large
 * Per-test budget: 120 s (each dataset — pulls 200 MB - 2 GB over CDN).
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'tests/evidence/streaming-large');
const RESULTS = path.join(EVIDENCE_DIR, 'results.jsonl');

// Datasets sourced from scripts/audit-100-datasets.json — these four
// previously failed the browser reality-check at > 200 MB.
const TARGETS = [
  {
    id: 'ds003682',
    format: 'fif',
    cdn_url: 'https://cdn.eegdash.org/ds003682/sub-001/ses-01/meg/sub-001_ses-01_task-AversiveLearningReplay_run-01_meg.fif',
    n_bytes: 644 * 1024 * 1024,
  },
  {
    id: 'ds003694',
    format: 'fif',
    cdn_url: 'https://cdn.eegdash.org/ds003694/sub-01/meg/sub-01_task-MEM_run-01_meg.fif',
    n_bytes: 2000 * 1024 * 1024,
  },
];

test.beforeAll(() => {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  // Truncate the JSONL so each run starts clean.
  fs.writeFileSync(RESULTS, '');
});

for (const target of TARGETS) {
  test(`${target.id} (${target.format}, ${(target.n_bytes / 1024 / 1024).toFixed(0)} MB): open < 5s, readWindow < 2s, heap < 100MB`, async ({ page }, testInfo) => {
    testInfo.setTimeout(120 * 1000);  // 2 min per dataset

    const url = `/?eeg=${encodeURIComponent(target.cdn_url)}`;
    const navStart = Date.now();
    await page.goto(url);

    // Baseline heap once the page is loaded but before stage-caption
    // becomes visible (i.e. before the format reader runs).
    const baselineHeap = await page.evaluate(() =>
      // @ts-expect-error Chrome-only
      typeof performance !== 'undefined' && performance.memory
        // @ts-expect-error Chrome-only
        ? performance.memory.usedJSHeapSize
        : 0,
    );

    // Open gate: stage-caption visible.
    await expect(page.locator('#stage-caption')).toBeVisible({ timeout: 60 * 1000 });
    const openMs = Date.now() - navStart;

    // First readWindow: drive a pan and time the next traces update.
    const readStart = Date.now();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(
      () => {
        const traces = document.querySelector('#traces');
        return traces && /** @type {HTMLCanvasElement} */ (traces).width > 0;
      },
      { timeout: 10 * 1000 },
    );
    const readMs = Date.now() - readStart;

    // Memory peak — poll every 100 ms for 2 s after the read.
    const peakHeapDelta = await page.evaluate(async (baseline) => {
      // @ts-expect-error Chrome-only
      if (!performance.memory) return 0;
      let peak = 0;
      for (let i = 0; i < 20; i++) {
        // @ts-expect-error Chrome-only
        const used = performance.memory.usedJSHeapSize;
        if (used > peak) peak = used;
        await new Promise(r => setTimeout(r, 100));
      }
      return peak - baseline;
    }, baselineHeap);
    const peakHeapMb = peakHeapDelta / 1024 / 1024;

    const verdict =
      openMs    < 5000  &&
      readMs    < 2000  &&
      peakHeapMb < 100  ? 'PASS' : 'FAIL';

    fs.appendFileSync(RESULTS, JSON.stringify({
      dataset_id: target.id,
      format:     target.format,
      n_bytes:    target.n_bytes,
      open_ms:    openMs,
      read_ms:    readMs,
      peak_heap_mb_delta: +peakHeapMb.toFixed(1),
      verdict,
    }) + '\n');

    expect(openMs,    `${target.id}: open_ms = ${openMs}, must be < 5000`).toBeLessThan(5000);
    expect(readMs,    `${target.id}: read_ms = ${readMs}, must be < 2000`).toBeLessThan(2000);
    expect(peakHeapMb, `${target.id}: peak heap delta = ${peakHeapMb.toFixed(1)} MB, must be < 100`).toBeLessThan(100);
  });
}
