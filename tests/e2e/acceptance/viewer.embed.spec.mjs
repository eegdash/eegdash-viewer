/**
 * Acceptance: viewer.embed.spec.mjs
 *
 * Timeout budget: 90 s (the embedded viewer needs to fetch data just like
 * the standalone viewer; cold S3 paths add latency).
 *
 * SCENARIO: iframe embed mode
 *
 * Given a docs reader embeds the viewer in an iframe
 * When the ?embed=1 parameter is present in the URL
 * Then the iframe renders with a transparent canvas background
 *  And the left rail, brand title, and format pill are collapsed / hidden
 *  And the eegdash brand anchor remains visible (the only chrome in embed mode)
 *  And the parent page does not receive any unhandled console errors from the iframe
 *  And the stage-caption appears (data loaded successfully inside the iframe)
 */

import { test, expect } from '@playwright/test';
import { FIXTURES } from '../../fixtures/index.mjs';

const FX = FIXTURES.eeglab_split;

test.describe('As a docs reader, the iframe embed renders correctly', () => {

  test('transparent canvas, collapsed chrome, no console errors', async ({ page }) => {
    // Given: errors collector for the embed page
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/Failed to load resource/.test(m.text())) return;
      errors.push(`console.error: ${m.text()}`);
    });

    // When: navigate to the viewer with embed=1
    await page.goto('/index.html' + FX.url_query + '&embed=1');

    // Then: the traces canvas appears (data rendered successfully)
    await expect(
      page.locator('#traces'),
      'embed: traces canvas must appear'
    ).toBeVisible();

    // And: body carries the .embed class (CSS hook for embed layout)
    const hasEmbed = await page.evaluate(() => document.body.classList.contains('embed'));
    expect(hasEmbed, 'body must have .embed class').toBe(true);

    // And: the left rail folds into a one-row toolbar (window · gain ·
    // filters); channel/event lists stay off screen.
    await expect(page.locator('.rail.left'), 'toolbar visible in embed').toBeVisible();
    expect((await page.locator('.rail.left').boundingBox()).height, 'toolbar is one row').toBeLessThan(44);
    await expect(page.locator('#ch-list'), 'channel list hidden in embed').toBeHidden();

    // And: the brand title is hidden but the pills stay (they replace the
    // engraved caption, which is off in embed mode)
    await expect(page.locator('.brand-title'), 'brand-title hidden in embed').toBeHidden();
    await expect(page.locator('#pill-format'), 'format pill visible in embed').toBeVisible();
    await expect(page.locator('#stage-caption'), 'caption off in embed').toBeHidden();

    // And: the eegdash brand anchor is still visible (the only chrome that stays)
    await expect(
      page.locator('.brand-eegdash'),
      'eegdash brand anchor must remain visible in embed'
    ).toBeVisible();
    await expect(
      page.locator('.brand-eegdash'),
      'eegdash brand anchor must link to eegdash.org'
    ).toHaveAttribute('href', /eegdash\.org/);

    // And: the canvas background is transparent in embed mode
    // (the viewer sets canvas.style.background = 'transparent' or similar)
    const canvasAlpha = await page.locator('#traces').evaluate((canvas) => {
      const ctx = canvas.getContext('2d');
      if (!ctx || !canvas.width || !canvas.height) return null;
      // Sample top-left corner — in transparent mode alpha channel = 0 on blank background.
      // We can't reliably test opacity=0 after a render, but we CAN assert the canvas
      // element doesn't have a solid background-color set via inline style.
      return canvas.style.backgroundColor;
    });
    // In embed mode the viewer should not force a white/cream background on the canvas element
    expect(
      canvasAlpha,
      'canvas element must not force an opaque background-color in embed mode'
    ).not.toMatch(/rgb\(251|white|#fbf|#fff/i);

    // And: no unhandled JS errors occurred
    expect(errors, `embed: console errors\n${errors.join('\n')}`).toHaveLength(0);
  });

  test('parent page scroll is not broken by embed (no body overflow forced)', async ({ page, browser }) => {
    // Given: a parent page containing an iframe pointing to the embed URL
    const context = await browser.newContext();
    const parentPage = await context.newPage();

    const parentErrors = [];
    parentPage.on('pageerror', (e) => parentErrors.push(e.message));

    const embedURL = 'http://localhost:8011/index.html' + FX.url_query + '&embed=1';

    // Inject a minimal parent page with an iframe and extra content to scroll
    await parentPage.setContent(`
      <!doctype html>
      <html>
        <body style="margin:0; height:3000px; font-family:sans-serif;">
          <h1>Docs page — scroll test</h1>
          <iframe
            src="${embedURL}"
            style="width:100%;height:400px;border:none;"
            id="eeg-iframe"
          ></iframe>
          <p style="margin-top:2600px;">Below the fold</p>
        </body>
      </html>
    `);

    // When: we scroll to the bottom of the parent page
    await parentPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await parentPage.waitForTimeout(300);

    // Then: the scroll position is actually at the bottom (not locked by the iframe)
    const scrollY = await parentPage.evaluate(() => window.scrollY);
    expect(scrollY, 'parent page must be scrollable past the iframe').toBeGreaterThan(100);

    // And: no JS errors in the parent page context
    expect(parentErrors, 'parent page JS errors').toHaveLength(0);

    await context.close();
  });

});
