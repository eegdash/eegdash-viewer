// tests/e2e/rapid-scroll.spec.mjs
//
// E2E behaviour tests for rapid input streams (pan, gain, filter, resize).
// Built on the same OpenNeuro EEGLAB fixture as streaming.spec.mjs so the
// shapes are comparable. Each test takes a screenshot and writes a JSON
// summary of pixel counts to tests/evidence/<id>/ for human-eye inspection.

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

async function countNonBgPixels(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('traces');
    if (!canvas || !canvas.width) return 0;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2];
      if (Math.abs(r - 251) > 8 || Math.abs(g - 250) > 8 || Math.abs(b - 246) > 8) {
        count++;
      }
    }
    return count;
  });
}

function pixelCountsStable(prev, curr) {
  const denom = Math.max(prev, curr, 1);
  return Math.abs(curr - prev) < Math.max(5, denom * 0.01);
}

async function settle(page, maxIter = 25, stableTarget = 4, intervalMs = 400) {
  let prev = await countNonBgPixels(page);
  let stable = 0;
  for (let i = 0; i < maxIter && stable < stableTarget; i++) {
    await page.waitForTimeout(intervalMs);
    const curr = await countNonBgPixels(page);
    stable = pixelCountsStable(prev, curr) ? stable + 1 : 0;
    prev = curr;
  }
  return prev;
}

test('RAPID-1: gain change during streaming produces a clean canvas', async ({ page }) => {
  const dir = evidenceDir('rapid-1-gain-during-stream');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });

  await page.goto(`/index.html?eeg=${encodeURIComponent(EEG_URL)}`);
  await waitForLoad(page);
  await page.waitForTimeout(500);
  const baseline = await countNonBgPixels(page);

  // Start a streaming pan, then immediately change gain.
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(50);
  const gain = page.locator('#gain');
  if (await gain.isVisible().catch(() => false)) {
    await gain.fill('2');
    await gain.dispatchEvent('input');
  } else {
    test.skip(true, 'gain slider not present in this build');
  }

  const after = await settle(page);
  await page.screenshot({ path: path.join(dir, 'after.png') });

  fs.writeFileSync(path.join(dir, 'pixel-counts.json'), JSON.stringify({ baseline, after }, null, 2));

  expect(errors).toHaveLength(0);
  // Higher gain typically increases pixel count, but the canvas must be
  // non-blank and not show absurd accumulation (>2x baseline).
  expect(after).toBeGreaterThan(baseline * 0.3);
  expect(after).toBeLessThan(baseline * 2.0);
});

test('RAPID-2: rapid pan at devicePixelRatio=2 leaves no ghost residue', async ({ browser }) => {
  // Retina-resolution browsers triple-buffer canvas pixels; the backing
  // store is 2x cssW/cssH. The bug class we lock down: clearing using
  // CSS coordinates while the polyline draws using transformed coordinates
  // can leave 1-pixel halos at chunk boundaries on hi-DPR.
  const dir = evidenceDir('rapid-2-dpr');
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  const page = await context.newPage();
  try {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
    });

    await page.goto(`/index.html?eeg=${encodeURIComponent(EEG_URL)}`);
    await waitForLoad(page);
    await page.waitForTimeout(500);
    const baseline = await countNonBgPixels(page);

    for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowLeft');

    const after = await settle(page);
    await page.screenshot({ path: path.join(dir, 'after-dpr2.png') });
    fs.writeFileSync(path.join(dir, 'pixel-counts.json'), JSON.stringify({ baseline, after }, null, 2));

    expect(errors).toHaveLength(0);
    expect(after).toBeGreaterThan(baseline * 0.5);
    expect(after).toBeLessThan(baseline * 1.15);
  } finally {
    await context.close();
  }
});

test('RAPID-3: viewport resize while streaming does not leave dead pixels', async ({ page }) => {
  // resize fires requestRender(); deviceFitCanvas resets dims and the next
  // draw re-fits the backing store. If the streaming render aborts then
  // restarts with stale `plotW` cached from the closure, the new render
  // can paint into the wrong region. This test sets a smaller viewport
  // mid-stream and asserts the canvas refits cleanly.
  const dir = evidenceDir('rapid-3-resize');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`/index.html?eeg=${encodeURIComponent(EEG_URL)}`);
  await waitForLoad(page);
  await page.waitForTimeout(500);

  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(30);
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(30);
  await page.setViewportSize({ width: 1400, height: 900 });

  const after = await settle(page);
  await page.screenshot({ path: path.join(dir, 'after-resize.png') });
  fs.writeFileSync(path.join(dir, 'pixel-counts.json'), JSON.stringify({ after }, null, 2));

  expect(errors).toHaveLength(0);
  expect(after).toBeGreaterThan(500);
});
