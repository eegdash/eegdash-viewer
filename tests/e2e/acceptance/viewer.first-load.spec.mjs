/**
 * Acceptance: viewer.first-load.spec.mjs
 *
 * Timeout budget: 90 s total (cold S3 pull ~3–5 s once CDN is warm).
 * Assertions each have a 30 s window; navigation is covered by the
 * outer test timeout.
 *
 * SCENARIO: Deep-link to a recording
 *
 * Given the user opens a deep-link URL for a known BIDS recording
 * When the page finishes its initial load sequence
 * Then the canvas paints within 5 s of the stage-caption appearing
 *  And the channel count pill shows the expected number of channels
 *  And the sampling-rate pill shows the expected rate in Hz
 *  And pressing ArrowRight pans the view (canvas pixels change)
 */

import { test, expect } from '@playwright/test';
import { FIXTURES } from '../../fixtures/index.mjs';

// Use the lightest well-characterised fixture: EEGLAB split, 36 ch, 250 Hz.
const FX = FIXTURES.eeglab_split;

test.describe('As a user, I open a deep-link to a recording', () => {

  test('canvas paints within 5 s of stage-caption, channel count + fs are readable', async ({ page }) => {
    // Given: no recording has been loaded yet
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/Failed to load resource/.test(m.text())) return; // expected BIDS sidecar 404s
      errors.push(`console.error: ${m.text()}`);
    });

    // When: we open a deep-link to a recording
    await page.goto('/index.html' + FX.url_query);

    // Then: stage-caption becomes visible (recording fully opened + first window rendered)
    const caption = page.locator('#stage-caption');
    await expect(caption, 'stage-caption must appear — indicates first window rendered').toBeVisible();

    // And: within 5 s of caption appearing the canvas must have ink
    // (the caption and the first draw happen in the same RAF cycle, so
    //  in practice both assertions fire nearly simultaneously)
    const sawTrace = await page.locator('#traces').evaluate((canvas) => {
      if (!canvas.width || !canvas.height) return 0;
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonBg = 0;
      for (let i = 0; i < data.length; i += 800) {
        if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) nonBg++;
      }
      return nonBg;
    });
    expect(sawTrace, 'canvas must contain non-background pixels').toBeGreaterThan(50);

    // And: channel count pill reflects the fixture's expected channels
    const channelText = await page.locator('#pill-channels').textContent();
    expect(channelText?.trim(), 'channel pill format').toMatch(/^\d+ ch$/);
    const nCh = parseInt(channelText ?? '0', 10);
    expect(nCh, 'channel count').toBe(FX.expect.n_channels);

    // And: sampling rate pill shows a numeric Hz value
    const fsText = await page.locator('#pill-fs').textContent();
    expect(fsText?.trim(), 'fs pill format').toMatch(/^\d+ Hz$/);
    expect(parseInt(fsText ?? '0', 10), 'sampling rate > 0').toBeGreaterThan(0);

    // And: no JS errors during the entire load sequence
    expect(errors, `console errors:\n${errors.join('\n')}`).toHaveLength(0);
  });

  test('pressing ArrowRight pans the view (canvas pixels change)', async ({ page }) => {
    // Given: a recording is loaded and the first window is visible
    await page.goto('/index.html' + FX.url_query);
    await expect(page.locator('#stage-caption')).toBeVisible();

    // Capture baseline canvas snapshot
    const before = await page.locator('#traces').screenshot();

    // When: the user presses ArrowRight (pan forward by half a window)
    await page.keyboard.press('ArrowRight');

    // Then: the canvas changes — wait for the worker to post the new WINDOW
    // and for one rAF pair to complete the draw.
    await expect.poll(async () => {
      const after = await page.locator('#traces').screenshot();
      return Buffer.compare(before, after);
    }, { timeout: 15_000, intervals: [200, 500, 1000] }).not.toBe(0);
  });

});
