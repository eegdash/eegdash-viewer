/**
 * Smoke test that hits the LIVE DEPLOYED viewer at github.io.
 * (Local e2e tests use localhost:8011; this one bypasses the local
 * server entirely and proves the deployed bundle works end-to-end.)
 *
 * TIMEOUT BUDGET
 *   Global test timeout : 90 s
 *   page.goto timeout   : 60 s (deployed page may be cold)
 *   stage-caption       : 30 s (expect global)
 *   Pre-assert wait     : replaced by waitForFunction on concrete element
 *                         to avoid 20 s arbitrary sleep (was flaky on fast CI)
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const LIVE_URL = 'https://eegdash.github.io/eegdash-viewer/?dataset=ds002893&sub=001&task=AuditoryVisualShift&run=01&ext=set';
const EVID = path.resolve('tests/evidence/live-deployed');
fs.mkdirSync(EVID, { recursive: true });

test('LIVE deployed viewer renders ds002893 EEG via cdn.eegdash.org', async ({ page }) => {
  const errors = [];
  const requests = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      errors.push(`console.error: ${m.text()}`);
    }
  });
  page.on('requestfailed', r => {
    const err = r.failure()?.errorText || '';
    // ERR_ABORTED is the AbortController cancelling a superseded read
    // (the prefetch / first-render race) — that's intended behaviour,
    // not a viewer error.
    if (err.includes('ERR_ABORTED')) return;
    errors.push(`requestfailed: ${r.url().slice(-80)} ${err}`);
  });
  page.on('response', r => {
    if (r.url().includes('cdn.eegdash.org') || r.url().includes('s3.amazonaws.com')) {
      requests.push({ url: r.url().slice(-90), status: r.status() });
    }
  });

  await page.goto(LIVE_URL, { timeout: 60_000 });

  // Wait for a concrete signal that the viewer has settled: either the
  // stage-caption appears (success path) or the status div changes from
  // the default text (error path). Using waitForFunction here replaces
  // the prior 20 s arbitrary sleep — we react as soon as the DOM is ready.
  await page.waitForFunction(() => {
    const caption = document.getElementById('stage-caption');
    const status = document.getElementById('status');
    if (caption && !caption.hidden && caption.textContent?.trim()) return true;
    const defaultStatus = 'Drop a BIDS recording or pass';
    if (status && status.textContent && !status.textContent.includes(defaultStatus)) return true;
    return false;
  }, null, { timeout: 45_000 }).catch(() => {
    // If neither condition fires within 45 s, proceed to capture diagnostics
    // anyway so the failure is informative rather than a cold timeout.
  });

  const status_text = (await page.locator('#status').textContent())?.trim();
  fs.writeFileSync(path.join(EVID, 'pre-assert-state.json'), JSON.stringify({
    url: LIVE_URL,
    timestamp: new Date().toISOString(),
    status_text,
    stage_caption_visible: await page.locator('#stage-caption').isVisible().catch(() => null),
    n_console_errors: errors.length,
    errors,
    n_data_requests: requests.length,
    requests,
  }, null, 2));

  await expect(page.locator('#stage-caption'), 'stage-caption never visible').toBeVisible({ timeout: 30_000 });

  const format = (await page.locator('#pill-format').textContent())?.trim();
  const channels = (await page.locator('#pill-channels').textContent())?.trim();
  const fs_pill = (await page.locator('#pill-fs').textContent())?.trim();

  // Canvas pixel check: must see actual ink
  const sawTrace = await page.locator('#traces').evaluate(c => {
    const ctx = c.getContext('2d');
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonBg = 0;
    for (let i = 0; i < img.length; i += 800) {
      if (img[i] < 240 || img[i + 1] < 240 || img[i + 2] < 240) nonBg++;
    }
    return nonBg;
  });

  await page.screenshot({ path: path.join(EVID, 'screenshot.png') });
  fs.writeFileSync(path.join(EVID, 'status.json'), JSON.stringify({
    url: LIVE_URL,
    timestamp: new Date().toISOString(),
    format, channels, fs: fs_pill,
    canvas_nonbg_pixels: sawTrace,
    n_console_errors: errors.length,
    errors,
    n_data_requests: requests.length,
    sample_requests: requests.slice(0, 10),
  }, null, 2));

  expect(format).toBe('SET');
  expect(channels).toMatch(/^\d+ ch$/);
  expect(sawTrace).toBeGreaterThan(50);
  expect(errors).toHaveLength(0);
});
