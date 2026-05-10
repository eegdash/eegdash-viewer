/**
 * Real-browser e2e for the page bootstrap.
 *
 * TIMEOUT BUDGET
 *   Global test timeout : 90 s (playwright.config.mjs)
 *   Global expect.timeout: 30 s
 *   Per-assertion overrides:
 *     stage-caption visible: 60 s — cold S3 + CDN can take 20–40 s on first load
 *     canvas resize reflow : 5 s  — purely local DOM event, should be instant
 *
 * Node test suite covers everything below the page (readers, sidecar walks,
 * render math, viewer-helper DOM construction); this is what catches the
 * "the page actually paints something" case + the ResizeObserver branch +
 * the canvas-state effects of TraceRenderer.draw.
 */
import { test, expect } from '@playwright/test';

// Use the shortest dataset we have on hand: ds002893 .set+.fdt is
// ~125 MB but `readWindow(0, 100)` only pulls ~14 KB thanks to the
// existing range-fetch path. Cold runs take ~3-5s; warm runs ~1s.
const EEG_URL = 'https://s3.amazonaws.com/openneuro.org/ds002893/sub-001/eeg/sub-001_task-AuditoryVisualShift_run-01_eeg.set';

test.describe('viewer end-to-end', () => {
  test('cold load renders 36-channel EEG without console errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // The BIDS inheritance walk fans ~100 sidecar probes per load,
      // most of which 404 (the file genuinely isn't at that variant
      // path). Browsers log every 404 to the console; that's expected
      // network-layer noise, not a viewer error. Real JS errors come
      // through `pageerror` or `console.error` with a JS message —
      // we only care about those.
      const text = m.text();
      if (/Failed to load resource/.test(text)) return;
      errors.push(`console.error: ${text}`);
    });

    await page.goto(`/index.html?eeg=${encodeURIComponent(EEG_URL)}`);

    // Stage caption only populates after the reader opens + the
    // first readWindow resolves, so its presence is a clean
    // "everything wired correctly" signal.
    const caption = page.locator('#stage-caption');
    await expect(caption).toBeVisible({ timeout: 60_000 });
    await expect(caption).toContainText('36 ch');
    await expect(caption).toContainText('250 Hz');
    await expect(caption).toContainText('SET');

    // Pills update twice — once from sidecar values, then with
    // the binary header's authoritative numbers. Both should land.
    await expect(page.locator('#pill-channels')).toHaveText('36 ch');
    await expect(page.locator('#pill-fs')).toHaveText('250 Hz');

    // Trace canvas is unhidden + has non-zero device pixels.
    const canvas = page.locator('#traces');
    await expect(canvas).not.toHaveAttribute('hidden', '');
    const dims = await canvas.evaluate((c) => ({ w: c.width, h: c.height }));
    expect(dims.w).toBeGreaterThan(0);
    expect(dims.h).toBeGreaterThan(0);

    // Channel list renders 36 rows.
    const chRows = page.locator('#ch-list .ch-row');
    await expect(chRows).toHaveCount(36);

    // Electrode-explorer link appears (this dataset has _electrodes.tsv).
    const link = page.locator('#electrode-link');
    await expect(link).toBeVisible();
    expect(await link.getAttribute('href')).toContain('electrodes.eegdash.org');

    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  test('canvas paints non-blank pixels (the renderer ran)', async ({ page }) => {
    await page.goto(`/index.html?eeg=${encodeURIComponent(EEG_URL)}`);
    // Wait for the concrete signal that the first window has been decoded and drawn.
    // Using waitForFunction (vs waitForTimeout) means we react as soon as the
    // condition is met, rather than waiting an arbitrary fixed interval.
    await expect(page.locator('#stage-caption')).toBeVisible({ timeout: 60_000 });

    // Poll until the canvas actually has non-background pixels.
    // The renderer draws asynchronously after the stage-caption is shown, so
    // using expect.poll here is more reliable than a fixed waitForTimeout.
    await expect.poll(async () => {
      return page.locator('#traces').evaluate((c) => {
        if (!c.width || !c.height) return 0;
        const ctx = c.getContext('2d');
        const img = ctx.getImageData(0, 0, c.width, c.height);
        const data = img.data;
        // Sample every 200th pixel for speed (640×480 → ~1500 samples).
        let nonBg = 0;
        for (let i = 0; i < data.length; i += 800) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          if (r < 240 || g < 240 || b < 240) nonBg++;
        }
        return nonBg;
      });
    }, { timeout: 10_000, intervals: [200, 500, 1000] }).toBeGreaterThan(0);
  });

  test('embed mode collapses to a thin header with eegdash brand', async ({ page }) => {
    await page.goto(`/index.html?eeg=${encodeURIComponent(EEG_URL)}&embed=1`);
    await expect(page.locator('#stage-caption')).toBeVisible({ timeout: 60_000 });
    // Rail is hidden; header is still there but compressed.
    await expect(page.locator('.rail.left')).toBeHidden();
    await expect(page.locator('.brand-title')).toBeHidden();
    await expect(page.locator('#pill-format')).toBeHidden();
    // The eegdash brand anchor is the only chrome that should remain
    // visible — it's the ONE link telling the user this is an eegdash
    // viewer when the iframe lives inside a docs page.
    await expect(page.locator('.brand-eegdash')).toBeVisible();
    await expect(page.locator('.brand-eegdash')).toHaveAttribute('href', /eegdash\.org/);
    expect(await page.evaluate(() => document.body.classList.contains('embed'))).toBe(true);
  });

  test('drag-drop overlay shows when a file is dragged into the page', async ({ page }) => {
    await page.goto('/index.html');
    // Dispatch a synthetic dragenter with a Files dataTransfer entry.
    await page.evaluate(() => {
      const dt = new DataTransfer();
      // Synthetic File so DataTransfer reports types: ['Files'].
      const f = new File(['x'], 'sub-01_eeg.set', { type: 'application/octet-stream' });
      dt.items.add(f);
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    expect(await page.evaluate(() => document.body.classList.contains('drag-active'))).toBe(true);
    await page.evaluate(() => {
      window.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }));
    });
    expect(await page.evaluate(() => document.body.classList.contains('drag-active'))).toBe(false);
  });

  test('ResizeObserver reflows the canvas on window resize', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(`/index.html?eeg=${encodeURIComponent(EEG_URL)}`);
    await expect(page.locator('#stage-caption')).toBeVisible({ timeout: 60_000 });
    const before = await page.locator('#traces').evaluate((c) => c.width);
    // Big viewport delta + rAF flush so the ResizeObserver invalidation
    // and the subsequent requestRender both land before we sample.
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.waitForFunction(
      ({ before }) => document.getElementById('traces').width !== before,
      { before }, { timeout: 5000 });
    const after = await page.locator('#traces').evaluate((c) => c.width);
    expect(after).not.toEqual(before);
  });
});
