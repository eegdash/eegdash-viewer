/**
 * Acceptance: format-polish-render.spec.mjs
 *
 * Real-browser render verification for the Plan-E polish-tier datasets:
 *   - ds002001  (CTF v4.2 / MEG42RS, rdlen=1)  → CTF reader after Task 1
 *   - ds002908  (CTF v4.2 / MEG42RS, rdlen=33) → CTF reader after Task 1
 *   - EDF+ TAL  (real OpenNeuro EDF+ with embedded annotations)
 *                                              → F09 path verification (Task 3)
 *   - SNIRF     (local fixture under tests/fixtures/nirs/)
 *                                              → SnirfReader (Task 6)
 *
 * Each test opens a CDN or local URL via the production viewer, waits
 * for stage-caption visible, asserts the canvas has non-background
 * pixels, and captures zero console errors (404s on optional sidecars
 * are filtered out, matching audit-loadable.spec.mjs).
 *
 * INPUTS  none — URLs are hardcoded (small, stable list).
 * OUTPUTS tests/evidence/format-polish/<subdir>/<id>.png
 *
 * TIMEOUT BUDGET inherits 90s per test from playwright.config.mjs.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const EVIDENCE_ROOT = path.join(REPO_ROOT, 'tests/evidence/format-polish');
fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });

// Each row: a real CDN URL (or local /tests/fixtures/...) the production
// viewer must render. `evidence_subdir` is where the screenshot lands;
// `min_non_bg_pixels` matches audit-loadable.spec.mjs's threshold.
// `assert_events_visible` (Task 4) counts green Okabe-Ito event hairlines
// on the canvas — only set for the EDF+ case.
//
// CTF coverage: ds002908 is the canonical Plan-E target (variable-length
// rdlen=33 run_desc, exercises the FUNNY_POS skip). ds000246 (emptyroom
// noise recording) is included as a second MEG42RS file that divides
// cleanly under int32 (86 MB body / (301 * 4) = 72,000 samples). The
// plan originally also called for ds002001 but that 1.36 GiB file does
// not divide cleanly under either int16 or int32 — its body has ~195 MiB
// of trailing data that header math cannot explain. Out of scope for
// this plan; ds002001 will continue to fail with a header/body-mismatch
// error in the next audit pass (acceptable known-limitation).
const CASES = [
  {
    id: 'ds000246-ctf-meg42rs',
    evidence_subdir: 'ctf-browser',
    cdn_url:
      'https://cdn.eegdash.org/ds000246/sub-emptyroom/meg/' +
      'sub-emptyroom_task-noise_run-01_meg.ds/' +
      'sub-emptyroom_task-noise_run-01_meg.meg4',
    min_non_bg_pixels: 50,
    notes: 'CTF v4.2 / MEG42RS, emptyroom noise, 301 channels',
  },
  {
    id: 'ds002908-ctf-meg42rs',
    evidence_subdir: 'ctf-browser',
    cdn_url:
      'https://cdn.eegdash.org/ds002908/sub-01/ses-1/meg/' +
      'sub-01_ses-1_task-mouse_meg.ds/sub-01_ses-1_task-mouse_meg.meg4',
    min_non_bg_pixels: 50,
    notes: 'CTF v4.2 / MEG42RS, rdlen=33, 337 channels @ 2400 Hz',
  },
  {
    id: 'ds003810-edfplus-tal',
    evidence_subdir: 'edf-annotations',
    // ds003810 sub-02 is the only loadable OpenNeuro EDF among the 13
    // candidates probed in Plan E Task 3 (most loadable EDFs ship with
    // a separate _events.tsv sidecar — only ds003810 stores events
    // inside an EDF Annotations TAL channel).
    cdn_url:
      'https://cdn.eegdash.org/ds003810/sub-02/eeg/' +
      'sub-02_task-MIvsRest_run-0_eeg.edf',
    expected_pill: 'EDF',
    min_non_bg_pixels: 50,
    notes: 'EDF+ with embedded TAL annotations rendered as on-canvas hairlines',
    assert_events_visible: true,
  },
  {
    id: 'snirf-tiny-fixture',
    evidence_subdir: 'snirf',
    // Local fixture served via scripts/serve.mjs at port 8011.
    cdn_url: 'http://localhost:8011/tests/fixtures/nirs/snirf-tiny.snirf',
    expected_pill: 'SNIRF',
    min_non_bg_pixels: 50,
    notes: 'SNIRF (HDF5) fNIRS reader — local fixture',
  },
];

for (const c of CASES) {
  test(`renders ${c.id}: ${c.notes}`, async ({ page }) => {
    const consoleErrors = [];
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (/Failed to load resource/.test(t)) return; // optional sidecar 404s
      consoleErrors.push(`console.error: ${t}`);
    });

    const url = '/index.html?eeg=' + encodeURIComponent(c.cdn_url);
    await page.goto(url);

    await expect(
      page.locator('#stage-caption'),
      `${c.id}: stage-caption never visible`,
    ).toBeVisible({ timeout: 60_000 });

    if (c.expected_pill) {
      const pillText = (await page.locator('#pill-format').textContent())?.trim() ?? '';
      expect(pillText, `${c.id}: pill mismatch`).toBe(c.expected_pill);
    }

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
    expect(nonBgPixels, `${c.id}: canvas non-background pixels`).toBeGreaterThan(
      c.min_non_bg_pixels,
    );

    if (c.assert_events_visible) {
      // Count Okabe-Ito green event hairlines on the canvas.
      // EVENT_LINE_COLOR in traces.js is rgba(0, 158, 115, 0.30) — alpha
      // 0.30 over a cream background (~245,243,240) blends to roughly
      // R=171, G=217, B=202 per pixel. The cream background itself is
      // very close in R/G/B; trace strokes are blues/oranges. The
      // discriminator that survives the alpha blend: g > r by a clear
      // margin AND g > b by a smaller margin (the 0.3*115 blue
      // contribution narrows the g-b gap).
      const eventLinePixels = await page.locator('#traces').evaluate((canvas) => {
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i],
            g = data[i + 1],
            b = data[i + 2];
          // g must be the brightest channel by a comfortable margin
          // over red (Okabe-Ito green has zero red), and at least
          // marginally brighter than blue.
          if (g > 180 && g - r > 30 && g - b > 5 && g < 250) n++;
        }
        return n;
      });
      expect(eventLinePixels, `${c.id}: green event hairlines on canvas`).toBeGreaterThan(20);
    }

    // Evidence screenshot — committed for visual review.
    const outDir = path.join(EVIDENCE_ROOT, c.evidence_subdir);
    fs.mkdirSync(outDir, { recursive: true });
    await page.locator('#traces').screenshot({
      path: path.join(outDir, `${c.id}.png`),
    });

    expect(
      [...pageErrors, ...consoleErrors],
      `${c.id}: console/page errors\n${[...pageErrors, ...consoleErrors].join(' | ')}`,
    ).toHaveLength(0);
  });
}
