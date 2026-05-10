/**
 * NEMAR-only smoke test: loads one NEMAR-hosted recording end-to-end
 * and asserts canvas paints. Kept separate from the OpenNeuro
 * multi-record smoke spec because the resolution path is entirely
 * different:
 *
 * TIMEOUT BUDGET
 *   Global test timeout : 90 s (playwright.config.mjs)
 *   Global expect.timeout: 30 s
 *   Per-assertion overrides:
 *     stage-caption visible: 60 s — NEMAR API + cdn worker + S3 fetch
 *
 * Resolution path:
 *   1. Viewer detects nm-prefixed dataset_id
 *   2. Calls data.eegdash.org/api/eegdash/records?filter={"bidspath":...}
 *   3. Reads sidecars from storage.sidecar_inline (no extra fetches)
 *   4. Builds binary URL from storage.annex_keys via the cdn.eegdash.org
 *      Cloudflare Worker (NEMAR's S3 has no CORS, the worker adds it)
 *
 * Coverage today is BDF only — see docs/build_traces_recordings.py
 * for the upstream gaps blocking other formats.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const EVIDENCE_DIR = path.resolve('tests/evidence/nemar-smoke');
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const RECORDS = [
  {
    name: 'nemar-set-nm000121',
    label: 'NEMAR inline-data .set · nm000121 sub-6 SSVEP (~1 MB)',
    qs: '?dataset=nm000121&sub=6&ses=0&task=ssvep&run=6&ext=set',
    expected_format: 'SET',
  },
];

for (const rec of RECORDS) {
  test(`NEMAR-SMOKE: ${rec.label}`, async ({ page }) => {
    const dir = path.join(EVIDENCE_DIR, rec.name);
    fs.mkdirSync(dir, { recursive: true });

    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      // 404s on optional BIDS sidecars are expected (inheritance walk).
      // BDF auxiliary-channel drop is a console.warn, not an error,
      // so it doesn't get surfaced here.
      if (/Failed to load resource/.test(t)) return;
      errors.push(`console.error: ${t}`);
    });

    await page.goto('/index.html' + rec.qs);

    await expect(page.locator('#stage-caption'), `${rec.name}: stage-caption never visible`)
      .toBeVisible({ timeout: 60_000 });

    const format = (await page.locator('#pill-format').textContent())?.trim();
    expect(format, `${rec.name}: format pill`).toBe(rec.expected_format);

    const channels = (await page.locator('#pill-channels').textContent())?.trim();
    expect(channels, `${rec.name}: channels pill`).toMatch(/^\d+ ch$/);
    const nCh = parseInt(channels, 10);
    expect(nCh, `${rec.name}: channels > 0`).toBeGreaterThan(0);

    const fs_pill = (await page.locator('#pill-fs').textContent())?.trim();
    expect(fs_pill, `${rec.name}: fs pill`).toMatch(/^\d+ Hz$/);

    const nRows = await page.locator('#ch-list .ch-row').count();
    expect(nRows, `${rec.name}: ch-list rows`).toBeGreaterThan(0);
    expect(Math.abs(nRows - nCh), `${rec.name}: ch-list count vs pill (${nRows} vs ${nCh})`)
      .toBeLessThanOrEqual(2);

    const sawTrace = await page.locator('#traces').evaluate((c) => {
      const ctx = c.getContext('2d');
      const img = ctx.getImageData(0, 0, c.width, c.height).data;
      let nonBg = 0;
      for (let i = 0; i < img.length; i += 800) {
        if (img[i] < 240 || img[i + 1] < 240 || img[i + 2] < 240) nonBg++;
      }
      return nonBg;
    });
    expect(sawTrace, `${rec.name}: canvas painted non-bg pixels`).toBeGreaterThan(50);

    await page.screenshot({ path: path.join(dir, 'screenshot.png'), fullPage: false });
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
      record: rec.name,
      label: rec.label,
      url: page.url(),
      format,
      n_channels: nCh,
      sampling_frequency_pill: fs_pill,
      duration_pill: (await page.locator('#pill-duration').textContent())?.trim(),
      n_ch_rows: nRows,
      n_canvas_nonbg_pixels: sawTrace,
      n_console_errors: errors.length,
      console_errors: errors,
      timestamp: new Date().toISOString(),
    }, null, 2));

    expect(errors, `${rec.name}: console errors\n${errors.join('\n')}`).toHaveLength(0);
  });
}
