/**
 * Multi-record smoke test: loads three OpenNeuro recordings (EEGLAB,
 * EDF, BrainVision) end-to-end through the live cdn.eegdash.org
 * Cloudflare proxy and asserts each renders. One screenshot + one
 * status JSON per record under tests/evidence/multi-record/<format>/.
 *
 * TIMEOUT BUDGET
 *   Global test timeout : 90 s (playwright.config.mjs)
 *   Global expect.timeout: 30 s
 *   Per-assertion overrides:
 *     stage-caption visible: 60 s — CDN cold-start + S3 fetch for first window
 *
 * NEMAR has its own spec (nemar-smoke.spec.mjs) because the resolution
 * path and upstream constraints are different — kept separate by request.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const EVIDENCE_DIR = path.resolve('tests/evidence/multi-record');
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const RECORDS = [
  {
    name: 'eeglab',
    label: 'EEGLAB (.set+.fdt)',
    qs: '?dataset=ds002893&sub=001&task=AuditoryVisualShift&run=01&ext=set',
    expected_format: 'SET',
  },
  {
    name: 'edf',
    label: 'EDF',
    qs: '?dataset=ds002034&sub=01&ses=01&task=offline&run=01&ext=edf',
    expected_format: 'EDF',
  },
  {
    name: 'brainvision',
    label: 'BrainVision (.vhdr+.eeg+.vmrk)',
    qs: '?dataset=ds002336&sub=xp101&task=motorloc&ext=vhdr',
    expected_format: 'VHDR',
  },
];

for (const rec of RECORDS) {
  test(`MULTI-RECORD: ${rec.label}`, async ({ page }) => {
    const dir = path.join(EVIDENCE_DIR, rec.name);
    fs.mkdirSync(dir, { recursive: true });

    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      // 404s on optional BIDS sidecars are expected (inheritance walk)
      if (/Failed to load resource/.test(t)) return;
      errors.push(`console.error: ${t}`);
    });

    await page.goto('/index.html' + rec.qs);

    // Stage caption only appears after reader opens + first WINDOW lands
    await expect(page.locator('#stage-caption'), `${rec.name}: stage-caption never visible`)
      .toBeVisible({ timeout: 60_000 });

    // Format pill should reflect the actual file format
    const format = (await page.locator('#pill-format').textContent())?.trim();
    expect(format, `${rec.name}: format pill`).toBe(rec.expected_format);

    // Channel count pill should be a positive integer with " ch" suffix
    const channels = (await page.locator('#pill-channels').textContent())?.trim();
    expect(channels, `${rec.name}: channels pill`).toMatch(/^\d+ ch$/);
    const nCh = parseInt(channels, 10);
    expect(nCh, `${rec.name}: channels > 0`).toBeGreaterThan(0);

    // Sampling-frequency pill must be an integer with " Hz"
    const fs_pill = (await page.locator('#pill-fs').textContent())?.trim();
    expect(fs_pill, `${rec.name}: fs pill`).toMatch(/^\d+ Hz$/);

    // Channel rows must populate the rail. Allow ±1 vs the pill count
    // since EDF+ Annotations pseudo-channel is in the BIDS sidecar but
    // excluded from the signal-channel render (F09 behavior).
    const nRows = await page.locator('#ch-list .ch-row').count();
    expect(nRows, `${rec.name}: ch-list rows`).toBeGreaterThan(0);
    expect(Math.abs(nRows - nCh), `${rec.name}: ch-list count vs pill (${nRows} vs ${nCh})`)
      .toBeLessThanOrEqual(2);

    // Canvas must paint actual non-background pixels (the renderer ran)
    const sawTrace = await page.locator('#traces').evaluate((c) => {
      const ctx = c.getContext('2d');
      const img = ctx.getImageData(0, 0, c.width, c.height).data;
      // BG is cream (#fbfaf6 ≈ R251,G250,B246). Anything noticeably
      // darker is trace ink, slot dividers, or labels.
      let nonBg = 0;
      for (let i = 0; i < img.length; i += 800) {  // sample every 200th pixel
        if (img[i] < 240 || img[i + 1] < 240 || img[i + 2] < 240) nonBg++;
      }
      return nonBg;
    });
    expect(sawTrace, `${rec.name}: canvas painted non-bg pixels`).toBeGreaterThan(50);

    // Capture evidence
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
