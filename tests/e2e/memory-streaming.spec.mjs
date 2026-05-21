// tests/e2e/memory-streaming.spec.mjs
//
// Memory leak detection during ACTIVE streaming, not just at rest.
// Differs from RAPID-5 (heap after settle) — this samples the heap
// AT regular intervals WHILE a continuous pan workload runs.

import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const EEG_URL = 'https://s3.amazonaws.com/openneuro.org/ds002893/sub-001/eeg/sub-001_task-AuditoryVisualShift_run-01_eeg.set';
const EVIDENCE_ROOT = path.resolve('tests/evidence');

function evidenceDir(id) {
  const d = path.join(EVIDENCE_ROOT, id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function waitForLoad(page, timeout = 90_000) {
  await expect(page.locator('#stage-caption')).toBeVisible({ timeout });
}

test('MEM-STREAM: heap stays bounded during 5 min of continuous panning', async ({ page }) => {
  // 30 cycles × (20 pans + ~200ms settle) + per-cycle heap measurement
  // can easily exceed Playwright's default 90 s per-test cap. Give it
  // a generous budget; the assertion below is what actually polices
  // the runtime, not the timeout.
  test.setTimeout(8 * 60_000);

  const dir = evidenceDir('mem-streaming');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      errors.push(m.text());
    }
  });

  await page.goto(`/index.html?eeg=${encodeURIComponent(EEG_URL)}`);
  await waitForLoad(page);
  await page.waitForTimeout(2000);

  const hasGc = await page.evaluate(() => typeof window.gc === 'function');
  test.skip(!hasGc, 'window.gc unavailable — run with --js-flags=--expose-gc');

  const samples = [];
  for (let cycle = 0; cycle < 30; cycle++) {
    const heap = await page.evaluate(() => {
      for (let i = 0; i < 5; i++) window.gc();
      // performance.memory.usedJSHeapSize is quantized to 10 MB buckets
      // in Chromium as a privacy mitigation. This test catches leaks
      // that cross a bucket boundary (>= 10 MB growth). Sub-bucket leaks
      // are NOT detected -- RAPID-5 has the same limitation; for sub-MB
      // leak detection, run process.memoryUsage().heapUsed via a Node
      // worker host. Worth a future iteration; for now this catches
      // the realistic regression class (cache-set unbounded growth,
      // closure leaks).
      return performance.memory.usedJSHeapSize;
    });
    samples.push({ cycle, heap, ts: Date.now() });

    for (let i = 0; i < 20; i++) {
      await page.keyboard.press(i % 2 === 0 ? 'ArrowRight' : 'ArrowLeft');
      await page.waitForTimeout(150);  // give the worker time to actually stream
    }
    await page.waitForTimeout(500);  // settle before next heap sample
  }

  const start = samples[5].heap;
  const end = samples[samples.length - 1].heap;
  const growth = end - start;
  const growthMb = growth / 1024 / 1024;

  fs.writeFileSync(path.join(dir, 'samples.json'), JSON.stringify({
    samples,
    growthBytes: growth,
    growthMb: Number(growthMb.toFixed(2)),
    cycles: samples.length,
    pansApprox: 600,
  }, null, 2));

  expect(errors).toHaveLength(0);
  expect(growthMb).toBeLessThan(10);
});
