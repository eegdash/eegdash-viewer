/**
 * tests/e2e/csp.spec.mjs
 *
 * index.html ships a meta Content-Security-Policy. Boot the viewer, load a
 * local recording, open the 3D geometry view, and fail on any CSP violation
 * (a new inline script, an unlisted font host, a worker from blob:, ...).
 */
import { test, expect } from '@playwright/test';

test('CSP: booting and loading a recording triggers no violation', async ({ page }) => {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', e => {
      window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  await page.goto('/index.html?eeg=' + encodeURIComponent('/test-data/edfplus-with-annotations.edf'));
  await expect(page.locator('#ch-list .ch-row').first()).toBeVisible({ timeout: 15_000 });
  await page.locator('#view-geometry').click();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
});
