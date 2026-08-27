// Guards the chrome around the canvas:
//   1. units and event labels read from the recording must reach the
//      screen unmodified (a CSS uppercase once rendered `mV` as `MV`),
//   2. every interactive control must paint a visible focus ring,
//   3. the canvas must stay the dominant element at any viewport.
// See docs/superpowers/plans/2026-08-27-frontend-defect-pass.md and
// DESIGN.md §4, §6, §8.
import { test, expect } from '@playwright/test';

const RECORDING = '/index.html?eeg=/test-data/edfplus-with-annotations.edf';

// Computed styles settle as soon as the page loads, so these assertions
// do not need the suite's 30 s network-tolerant retry budget.
const CSS = { timeout: 4000 };

async function loadRecording(page) {
  await page.goto(RECORDING);
  await expect(page.locator('#stage-caption')).toBeVisible();
}

test.describe('chrome integrity', () => {
  test('does not uppercase physical units or event labels', async ({ page }) => {
    await loadRecording(page);

    // Every selector below renders a unit or a value read from the file.
    // `mV` uppercased is megavolt; `10 s` uppercased is siemens; `Hz`
    // uppercased is not a unit at all.
    for (const sel of ['#gain-readout', '#window-sec', '.filter-unit',
                       '.stage-caption .val', '.ch-units', '.ev-label']) {
      // .ch-units only exists once a _channels.tsv resolves; this fixture
      // has none, so absence is not a failure.
      if (await page.locator(sel).count() === 0) continue;
      await expect(page.locator(sel).first(), sel)
        .toHaveCSS('text-transform', 'none', CSS);
    }

    // viewer.js builds this as "1.00× (~47 µV/slot)".
    await expect(page.locator('#gain-readout')).not.toHaveText(/MV|ΜV/, CSS);

    // The fixture's annotations are sentence-cased: "Stimulus",
    // "Page change", "Eye blink". They must render verbatim.
    await expect(page.locator('.ev-label').first()).toHaveText('Stimulus', CSS);
  });

  test('sets the view tip as a sentence, not tracked uppercase', async ({ page }) => {
    await loadRecording(page);
    const tip = page.locator('.view-tip');
    await expect(tip).toHaveCSS('text-transform', 'none', CSS);
    await expect(tip).toHaveText(/^Drag traces to pan/, CSS);
  });

  test('gives every interactive control a visible focus ring', async ({ page }) => {
    await loadRecording(page);

    // Walk the first ten tab stops; each must paint an outline at least
    // 2px wide. Chromium's 1px `auto` default does not qualify.
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        return {
          tag: el.tagName + (el.id ? '#' + el.id : ''),
          width: parseFloat(cs.outlineWidth),
          style: cs.outlineStyle,
        };
      });
      if (!focused) continue;
      expect(focused.style, `${focused.tag} has no focus outline`).not.toBe('none');
      expect(focused.width, `${focused.tag} outline too thin`).toBeGreaterThanOrEqual(2);
    }
  });

  // The design rule (DESIGN.md §6): the canvas is the product, so it never
  // yields width to the rail. Below 760px the grid reflows to a single
  // column and the canvas gets essentially the full width; above it the
  // rail is a fixed sidebar and the canvas takes the remainder.
  for (const [name, width, height] of [['phone', 390, 844],
                                       ['tablet', 834, 1000],
                                       ['desktop', 1440, 900]]) {
    test(`keeps the canvas dominant and the page unscrolled at ${name}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await loadRecording(page);

      const canvas = await page.locator('#traces').boundingBox();
      const rail = await page.locator('.rail.left').boundingBox();

      expect(canvas.width, `canvas ${canvas.width} vs rail ${rail.width}`)
        .toBeGreaterThanOrEqual(rail.width);
      if (width <= 760) {
        expect(canvas.width, 'canvas should span nearly the full width')
          .toBeGreaterThan(width * 0.9);
      }
      expect(canvas.height, 'canvas too short').toBeGreaterThan(200);

      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'page scrolls horizontally').toBeLessThanOrEqual(1);
    });
  }
});
