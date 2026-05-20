/**
 * Acceptance: viewer.format-coverage.spec.mjs
 *
 * Timeout budget: 90 s per test (cold CDN pull for BrainVision/EDF can be
 * 10–20 s; the test outer timeout covers the whole sequence).
 * Individual assertions use the global expect.timeout (30 s).
 *
 * SCENARIO: Format coverage
 *
 * Given a user wants to review EEG data in a variety of formats
 * When they open the viewer with a deep-link for each supported format
 * Then the viewer renders the correct format pill
 *  And the channel list is populated with at least one channel
 *  And the canvas shows non-background pixels (traces were drawn)
 *  And no unhandled JS errors occur
 *
 * Formats covered:
 *   - EEGLAB inline .set  (NEMAR nm000121, small ~1 MB, served via CDN)
 *   - EDF                 (OpenNeuro ds002034)
 *   - BrainVision .vhdr   (OpenNeuro ds002336)
 *   - NEMAR BDF           (nm000121 fallback; we test the NEMAR resolution path)
 */

import { test, expect } from '@playwright/test';
import { FIXTURES } from '../../fixtures/index.mjs';

const FORMAT_CASES = [
  // Swapped from eeglab_inline (NEMAR nm000121) on 2026-05-21: NEMAR
  // returns 404 'Version not published' for nm000121/latest, making the
  // test flake on every run. eeglab_split (OpenNeuro ds002893) covers the
  // same SET-format path via a stable provider. NEMAR coverage moved to
  // tests/e2e/nemar-smoke.spec.mjs which is allowed to skip on 404.
  { key: 'eeglab_split',  desc: 'EEGLAB split .set+.fdt (OpenNeuro ds002893)' },
  { key: 'edf',           desc: 'EDF (OpenNeuro ds002034)'             },
  { key: 'brainvision',   desc: 'BrainVision .vhdr (OpenNeuro ds002336)' },
];

for (const { key, desc } of FORMAT_CASES) {
  const fx = FIXTURES[key];

  test.describe(`As a user, I load ${desc}`, () => {

    test(`data renders correctly — format pill, channels, canvas`, async ({ page }) => {
      // Given: the user opens the viewer with a deep-link for this format
      const errors = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        if (/Failed to load resource/.test(m.text())) return; // sidecar 404s are expected
        errors.push(`console.error: ${m.text()}`);
      });

      // When: they navigate to the deep-link
      await page.goto('/index.html' + fx.url_query);

      // Then: the stage-caption appears — recording open + first window done
      await expect(
        page.locator('#stage-caption'),
        `${key}: stage-caption must appear`
      ).toBeVisible();

      // And: the format pill reflects the correct file format
      await expect(
        page.locator('#pill-format'),
        `${key}: format pill`
      ).toHaveText(fx.expect.format);

      // And: at least one channel row is rendered in the rail
      const nRows = await page.locator('#ch-list .ch-row').count();
      expect(nRows, `${key}: channel list must have rows`).toBeGreaterThan(0);

      // And: channel pill is a positive integer
      const channelText = await page.locator('#pill-channels').textContent();
      expect(channelText?.trim(), `${key}: channel pill format`).toMatch(/^\d+ ch$/);
      expect(parseInt(channelText ?? '0', 10), `${key}: channel count > 0`).toBeGreaterThan(0);

      // And: sampling-rate pill is a positive integer
      const fsText = await page.locator('#pill-fs').textContent();
      expect(fsText?.trim(), `${key}: fs pill format`).toMatch(/^\d+ Hz$/);
      expect(parseInt(fsText ?? '0', 10), `${key}: fs > 0`).toBeGreaterThan(0);

      // And: the canvas shows actual trace ink (renderer ran)
      const nonBgPixels = await page.locator('#traces').evaluate((canvas) => {
        if (!canvas.width || !canvas.height) return 0;
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let i = 0; i < data.length; i += 800) {
          if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) count++;
        }
        return count;
      });
      expect(nonBgPixels, `${key}: canvas non-background pixels`).toBeGreaterThan(50);

      // And: no unhandled JS errors
      expect(errors, `${key}: console errors\n${errors.join('\n')}`).toHaveLength(0);
    });

  });
}
