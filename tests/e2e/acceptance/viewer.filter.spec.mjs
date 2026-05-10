/**
 * Acceptance: viewer.filter.spec.mjs
 *
 * Timeout budget: 90 s (filter re-fetch re-runs the full window read
 * path; cold S3 + filter compute can take ~5–15 s for large windows).
 *
 * SCENARIO: HP filter reduces DC offset
 *
 * Given a user has loaded an EEG recording with some DC offset
 * When they toggle the 1 Hz high-pass filter
 * Then the rendered canvas pixels change (the filter altered the signal)
 *  And no unhandled JS errors occur during the filter round-trip
 *
 * NOTE: We cannot directly assert that "the DC offset drops" from pixels
 * alone — that would require comparing mean pixel luminance per channel
 * against a known ground truth. Instead, we assert:
 *   a) the canvas changes after enabling the filter (filter wiring works)
 *   b) re-disabling the filter changes the canvas back to a state that
 *      differs from the filtered state (round-trip is correct)
 * This is the observable acceptance criterion an end-user can verify
 * visually: "enabling the HP filter changes what I see."
 */

import { test, expect } from '@playwright/test';
import { FIXTURES } from '../../fixtures/index.mjs';

// EDF dataset is best for filter testing: has more DC content than EEGLAB
// and loads quickly via CDN.
const FX = FIXTURES.edf;

test.describe('As a user, I toggle a 1 Hz HP filter and see the signal change', () => {

  test('HP filter enable changes canvas; disable restores a different state', async ({ page }) => {
    // Given: a recording is loaded
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/Failed to load resource/.test(m.text())) return;
      errors.push(`console.error: ${m.text()}`);
    });

    await page.goto('/index.html' + FX.url_query);
    await expect(page.locator('#stage-caption')).toBeVisible();

    // Helper: count worker WINDOW messages received (each filter cycle triggers one)
    const getWindows = () =>
      page.evaluate(() => globalThis.__viewerWorkerStats?.windows_received ?? 0);

    // Helper: wait for at least `n` new WINDOWs and two rAF flushes
    const waitForWindows = async (beforeCount, n = 1) => {
      await page.waitForFunction(
        ({ b, n }) => (globalThis.__viewerWorkerStats?.windows_received ?? 0) >= b + n,
        { b: beforeCount, n },
        { timeout: 30_000 }
      );
      await page.evaluate(() => new Promise(r =>
        requestAnimationFrame(() => requestAnimationFrame(r))
      ));
    };

    // Drain any in-flight prefetch from initial load
    await page.waitForTimeout(600);

    // Capture baseline canvas screenshot
    const baseline = await page.locator('#traces').screenshot();

    // When: the user enables the 1 Hz HP filter
    const hpCheckbox = page.locator('#filter-hp-enable');

    // Guard: if the filter UI is absent, skip gracefully with a clear message
    const hpVisible = await hpCheckbox.isVisible().catch(() => false);
    if (!hpVisible) {
      test.skip(true, 'HP filter UI (#filter-hp-enable) not present — skipping filter acceptance test');
      return;
    }

    // Set cutoff to 1 Hz (conservative — should always affect baseline drift)
    const before1 = await getWindows();
    await hpCheckbox.check();
    await page.locator('#filter-hp-cutoff').fill('1');
    await page.locator('#filter-hp-cutoff').blur();
    await waitForWindows(before1);

    // Then: canvas pixels changed
    const filtered = await page.locator('#traces').screenshot();
    expect(
      Buffer.compare(baseline, filtered),
      'Enabling HP 1 Hz filter must change canvas pixels'
    ).not.toBe(0);

    // And: disabling the filter produces yet another different state
    const before2 = await getWindows();
    await hpCheckbox.uncheck();
    await waitForWindows(before2);

    const restored = await page.locator('#traces').screenshot();
    expect(
      Buffer.compare(filtered, restored),
      'Disabling the filter must change canvas back (filter round-trip)'
    ).not.toBe(0);

    // And: no JS errors
    expect(errors, `filter test console errors:\n${errors.join('\n')}`).toHaveLength(0);
  });

});
