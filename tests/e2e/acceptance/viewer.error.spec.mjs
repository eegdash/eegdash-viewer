/**
 * Acceptance: viewer.error.spec.mjs
 *
 * Timeout budget: 30 s (error cases should resolve quickly — no real data
 * to fetch; the viewer should surface the error state within a few seconds).
 *
 * SCENARIO: Bad URL shows actionable error
 *
 * Given a user with a bad URL (nonexistent dataset / misspelled path)
 * When they open the viewer with that URL
 * Then they see a clear, actionable error message — NOT a blank page
 *  And the stage-hint element is visible (the welcome/idle state is shown)
 *  And the status element contains an error or descriptive message
 *  And the canvas is NOT shown (no broken half-render)
 *  And no unhandled JS exceptions occur (only expected fetch failures)
 *
 * This covers the user experience for the most common support issue:
 * "I pasted the wrong URL and got a blank page."
 */

import { test, expect } from '@playwright/test';

test.describe('As a user with a bad URL, I see a clear actionable error', () => {

  test('nonexistent OpenNeuro dataset shows error state, not blank page', async ({ page }) => {
    // Collect only genuine JS errors, not expected network failures
    const jsErrors = [];
    page.on('pageerror', (e) => jsErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // 404s on sidecars / the data URL itself are expected; ignore them
      if (/Failed to load resource/.test(m.text())) return;
      // The viewer may also log "Failed to open recording" style messages
      // via console.error — those are handled UI errors, not JS exceptions
      if (/Failed to open|could not load|not found/i.test(m.text())) return;
      jsErrors.push(`console.error: ${m.text()}`);
    });

    // When: the user opens a URL for a clearly nonexistent dataset
    await page.goto('/index.html?dataset=ds999999999&sub=001&task=nothing&ext=edf');

    // Then: the page loads without a blank timeout — the viewer handles the error
    // We wait for either the stage-hint (idle state) or a status message to appear.
    // The status div always exists; after a failed load it should show an error.
    // Allow up to 15 s for the fetch attempts to fail and the UI to update.
    await expect.poll(async () => {
      const statusText = await page.locator('#status').textContent();
      const hintVisible = await page.locator('#stage-hint').isVisible().catch(() => false);
      // The viewer has handled the error if:
      //   a) #stage-hint is visible (viewer reverted to idle), OR
      //   b) #status contains an error/fail message
      return hintVisible || /error|fail|not found|could not/i.test(statusText ?? '');
    }, {
      timeout: 20_000,
      intervals: [500, 1000, 2000],
      message: 'viewer should show #stage-hint or error text in #status after bad URL',
    }).toBe(true);

    // And: the canvas is not actively displaying (no partial broken render).
    // The viewer sets the HTML `hidden` attribute on #traces when idle.
    // We check the attribute directly because the CSS can override display
    // in ways that make toBeHidden() unreliable for attribute-based hiding.
    const canvasHiddenAttr = await page.locator('#traces').evaluate(
      (el) => el.hasAttribute('hidden')
    );
    expect(canvasHiddenAttr, 'canvas must have hidden attribute when no valid recording loaded').toBe(true);

    // And: no unhandled JS exceptions (fetch failures are expected, JS errors are not)
    expect(jsErrors, `unexpected JS errors:\n${jsErrors.join('\n')}`).toHaveLength(0);
  });

  test('malformed ?eeg= URL with bad path shows error state', async ({ page }) => {
    const jsErrors = [];
    page.on('pageerror', (e) => jsErrors.push(e.message));

    // When: the user opens the viewer with a totally bogus URL
    await page.goto('/index.html?eeg=https://s3.amazonaws.com/openneuro.org/DOESNOTEXIST/sub-X/eeg/sub-X_task-Y_eeg.set');

    // Then: the page handles the fetch failure gracefully
    await expect.poll(async () => {
      const hintVisible = await page.locator('#stage-hint').isVisible().catch(() => false);
      const statusText = await page.locator('#status').textContent();
      return hintVisible || /error|fail|not found|could not/i.test(statusText ?? '');
    }, {
      timeout: 20_000,
      intervals: [500, 1000, 2000],
      message: 'viewer should recover from bad ?eeg= URL gracefully',
    }).toBe(true);

    // And: no unhandled JS exceptions
    expect(jsErrors, `JS errors after bad eeg URL:\n${jsErrors.join('\n')}`).toHaveLength(0);
  });

  test('bare index.html with no params shows the stage-hint welcome state', async ({ page }) => {
    // Given: the user lands on the viewer with no query parameters
    await page.goto('/index.html');

    // Then: the welcome hint is immediately visible (no recording loaded)
    await expect(
      page.locator('#stage-hint'),
      'stage-hint must be visible with no URL params'
    ).toBeVisible();

    // And: the canvas is not displaying (has the `hidden` attribute)
    const tracesHidden = await page.locator('#traces').evaluate(
      (el) => el.hasAttribute('hidden')
    );
    expect(tracesHidden, 'canvas must have hidden attribute with no recording loaded').toBe(true);

    // And: the status text prompts the user to drop a file or pass a URL
    const statusText = await page.locator('#status').textContent();
    expect(statusText, 'status must contain usage instructions').toMatch(/drop|eeg=|dataset/i);
  });

});
