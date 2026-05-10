/**
 * tests/e2e/smoke.spec.mjs
 *
 * Lightweight deployed-health check for post-deploy monitoring.
 * Target: < 30 s total. Suitable for running after every deployment.
 *
 * Run with:
 *   npm run test:smoke
 *
 * What this checks:
 *   1. Critical static assets return HTTP 200 (viewer.js, worker.js, etc.)
 *   2. The deployed home page loads, has the correct <title>,
 *      shows no JS console errors, and the #stage-hint is visible
 *      (proving the viewer bundle loaded and initialised correctly).
 *   3. The CDN endpoint (cdn.eegdash.org) responds to a HEAD probe.
 *
 * What this does NOT check:
 *   - Data loading from S3 or CDN (that's the acceptance suite's job)
 *   - Rendering a recording (live-deployed-smoke.spec.mjs covers that)
 *   This spec must finish < 30 s and never hit real EEG data.
 *
 * Timeout budget per test: 15 s. Total budget: 30 s.
 */

import { test, expect } from '@playwright/test';

const DEPLOYED_BASE = 'https://eegdash.github.io/eegdash-viewer';

/**
 * Critical assets that must return HTTP 200 from the deployed GitHub Pages site.
 * Each entry is: [display-name, path-relative-to-DEPLOYED_BASE]
 */
const CRITICAL_ASSETS = [
  ['viewer.js',           '/viewer.js'],
  ['worker.js',           '/worker.js'],
  ['filters.js',          '/filters.js'],
  ['perf.js',             '/perf.js'],
  ['formats/_matv5.js',   '/formats/_matv5.js'],
  ['formats/edf.js',      '/formats/edf.js'],
  ['formats/eeglab.js',   '/formats/eeglab.js'],
  ['formats/brainvision.js', '/formats/brainvision.js'],
  ['styles.css',          '/styles.css'],
];

test.describe('Deployed asset health @smoke', () => {

  for (const [name, path] of CRITICAL_ASSETS) {
    test(`${name} returns HTTP 200`, async ({ request }) => {
      const url = DEPLOYED_BASE + path;
      const response = await request.head(url, { timeout: 10_000 });
      expect(
        response.status(),
        `${name} at ${url} must return 200`
      ).toBe(200);
    });
  }

});

test.describe('Deployed home page health @smoke', () => {

  test('home page loads, has correct title, stage-hint visible, no JS errors', async ({ page }) => {
    test.setTimeout(20_000);

    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // Font preconnect failures, sidecar 404s, etc. are expected noise
      if (/Failed to load resource/.test(m.text())) return;
      errors.push(`console.error: ${m.text()}`);
    });

    // Navigate to the deployed home page (no recording URL — should show hint)
    await page.goto(DEPLOYED_BASE + '/index.html', { timeout: 15_000 });

    // The page title must match the viewer identity
    await expect(page).toHaveTitle(/EEG.*Viewer|Trace Viewer/i);

    // The stage-hint must be visible — confirms the JS bundle initialised
    // and the DOM is in the expected idle state.
    await expect(
      page.locator('#stage-hint'),
      '#stage-hint must be visible — JS bundle loaded and ran init'
    ).toBeVisible({ timeout: 10_000 });

    // The canvas must not be actively displaying (no recording loaded).
    // The viewer uses the HTML `hidden` attribute (not display:none via class)
    // on #traces; Playwright's toBeHidden() checks CSS visibility which can
    // differ from the attribute in some stylesheet configurations.
    // Use hasAttribute check to remain resilient to CSS implementation details.
    const canvasIsHiddenAttr = await page.locator('#traces').evaluate(
      (el) => el.hasAttribute('hidden')
    );
    expect(
      canvasIsHiddenAttr,
      '#traces must have the hidden attribute when no recording is loaded'
    ).toBe(true);

    // No unhandled JS errors
    expect(errors, `Home page JS errors:\n${errors.join('\n')}`).toHaveLength(0);
  });

});

test.describe('CDN endpoint health @smoke', () => {

  test('cdn.eegdash.org responds to HTTP probe', async ({ request }) => {
    // The CDN endpoint is a Cloudflare Worker that proxies S3 data.
    // A HEAD to the root returns whatever the worker returns (usually
    // a 400/404 because no path is given) — we just confirm it is
    // REACHABLE and does not timeout or return a 5xx.
    let status;
    try {
      const response = await request.head('https://cdn.eegdash.org', { timeout: 8_000 });
      status = response.status();
    } catch (err) {
      // If the request itself fails (network error / timeout) that is
      // a genuine failure — let the test error out naturally.
      throw err;
    }

    // Accept any non-5xx response — the CDN is up if it responds at all
    expect(status, 'CDN must respond with a non-5xx status').toBeLessThan(500);
  });

});
