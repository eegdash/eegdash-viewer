/**
 * Acceptance: format-demos.spec.mjs
 *
 * One curated demo per BIDS-accepted electrophysiology format. Mirrors
 * `audit-loadable.spec.mjs` for cdn.eegdash.org rows and
 * `format-polish-render.spec.mjs` for local-fixture rows.
 *
 * GATED BY `RUN_DEMO_TESTS=1` — some demos pull 10–40 MB across cold CDN
 * byte-ranges. The spec is skipped in normal `npx playwright test` runs.
 *
 * SCENARIOS
 *   - Full-tier readers   → stage-caption visible, canvas non-blank, pill matches.
 *   - Metadata-only (MEF3) → stage-caption may not appear; the recording-status
 *                            panel must surface a clean documented error
 *                            (no console TypeError / null-deref crashes).
 *   - Stub-tier (KRISS)    → open() throws a documented "not yet supported"
 *                            message rendered into the status panel.
 *
 * INPUTS
 *   env RUN_DEMO_TESTS=1  — required to execute (otherwise every test is skipped)
 *
 * OUTPUTS
 *   tests/evidence/format-demos/<id>/screenshot.png
 *
 * TIMEOUT BUDGET inherits 90 s per test from playwright.config.mjs.
 *
 * Demo URL matrix: see docs/bids-format-demos.md.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const EVIDENCE_ROOT = path.join(REPO_ROOT, 'tests/evidence/format-demos');
fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });

const RUN_DEMO_TESTS = process.env.RUN_DEMO_TESTS === '1';

/**
 * Per-format demo row.
 *
 * tier:
 *   'full'      — stage-caption visible + canvas non-blank + pill matches expected
 *   'metadata'  — reader open() works but readWindow() throws cleanly;
 *                 we assert the error surface, not the canvas.
 *   'stub'      — reader open() throws a documented error string.
 *
 * source:
 *   'cdn'       — url is a real cdn.eegdash.org path. Skipped on offline runs.
 *   'fixture'   — url is `/tests/fixtures/...` (served by scripts/serve.mjs).
 *
 * expected_pill is asserted only for tier='full'. For metadata/stub tiers the
 * pill may stay as '—' because LOAD_FILE itself throws before setPill fires.
 */
const DEMOS = [
  // Full-tier, cdn-backed (verified via audit-loadable.spec.mjs).
  {
    id: 'edf-ds002034',
    source: 'cdn',
    tier: 'full',
    url: 'https://cdn.eegdash.org/ds002034/sub-01/ses-01/eeg/sub-01_ses-01_task-offline_run-01_eeg.edf',
    expected_pill: 'EDF',
    notes: 'EDF (ds002034 sub-01) — offline EEG',
  },
  {
    id: 'bdf-ds001787',
    source: 'cdn',
    tier: 'full',
    url: 'https://cdn.eegdash.org/ds001787/sub-001/ses-01/eeg/sub-001_ses-01_task-meditation_eeg.bdf',
    expected_pill: 'BDF',
    notes: 'BDF (ds001787 sub-001) — BioSemi 24-bit',
  },
  {
    id: 'vhdr-ds001810',
    source: 'cdn',
    tier: 'full',
    url: 'https://cdn.eegdash.org/ds001810/sub-01/ses-anodalpost/eeg/sub-01_ses-anodalpost_task-attentionalblink_eeg.vhdr',
    expected_pill: 'VHDR',
    notes: 'BrainVision (ds001810 sub-01) — attentional blink',
  },
  {
    id: 'set-ds001785',
    source: 'cdn',
    tier: 'full',
    url: 'https://cdn.eegdash.org/ds001785/sub-01/ses-01/eeg/sub-01_ses-01_task-adapt_run-01_eeg.set',
    expected_pill: 'SET',
    notes: 'EEGLAB v5 .set (ds001785 sub-01)',
  },
  {
    id: 'fiff-ds000248',
    source: 'cdn',
    tier: 'full',
    url: 'https://cdn.eegdash.org/ds000248/sub-01/meg/sub-01_acq-crosstalk_meg.fif',
    // Note: this particular FIFF is a calibration-only file; the viewer
    // shows a clean error rather than rendering traces. Treat as metadata
    // tier for canvas assertion purposes, even though the FIFF reader
    // itself is full-tier — the file content, not the reader, drives this.
    tier: 'metadata',
    expected_error_pattern: /calibration|empty-block|no raw signal/i,
    notes: 'FIFF (ds000248 sub-01_acq-crosstalk) — calibration file, clean error path',
  },
  {
    id: 'ctf-ds000246',
    source: 'cdn',
    tier: 'full',
    url: 'https://cdn.eegdash.org/ds000246/sub-emptyroom/meg/sub-emptyroom_task-noise_run-01_meg.ds/sub-emptyroom_task-noise_run-01_meg.meg4',
    expected_pill: 'DS',
    notes: 'CTF (ds000246 sub-emptyroom) — emptyroom noise, 301 channels',
  },

  // Full-tier, local-fixture (no cdn.eegdash.org dataset exists yet).
  {
    id: 'snirf-fixture',
    source: 'fixture',
    tier: 'full',
    url: 'http://localhost:8011/tests/fixtures/nirs/snirf-tiny.snirf',
    expected_pill: 'SNIRF',
    notes: 'SNIRF (HDF5) fNIRS — local fixture',
  },
  {
    id: 'kit-fixture',
    source: 'fixture',
    tier: 'full',
    url: 'http://localhost:8011/tests/fixtures/meg/kit-tiny.con',
    expected_pill: 'CON',
    notes: 'KIT/Yokogawa .con — local fixture',
  },

  // Lane H: BIDS-allowed formats, local fixtures only (no real demos yet).
  {
    id: 'nwb-fixture',
    source: 'fixture',
    tier: 'full',
    url: 'http://localhost:8011/tests/fixtures/ieeg/nwb-tiny.nwb',
    expected_pill: 'NWB',
    notes: 'NWB (HDF5) iEEG — local fixture',
  },
  {
    id: 'bti-fixture',
    source: 'fixture',
    tier: 'full',
    // BTi URLs point at the inner `config` or `c,rfDC` file; the reader
    // siblings out from there. No file extension on the bundle itself.
    url: 'http://localhost:8011/tests/fixtures/meg/bti-tiny/config',
    expected_pill: 'BTI',
    notes: 'BTi/4D MEG bundle — local fixture (path-based dispatch)',
  },
  {
    id: 'itab-fixture',
    source: 'fixture',
    tier: 'full',
    url: 'http://localhost:8011/tests/fixtures/meg/itab-tiny.raw',
    expected_pill: 'RAW',
    notes: 'ITAB MEG (.raw + .mhd companion) — local fixture',
  },

  // MEF3 was metadata-only in Lane J; Tier 3 (full RED decode) shipped
  // in commit-K, so this is now a full-tier fixture demo.
  {
    id: 'mef-fixture',
    source: 'fixture',
    tier: 'full',
    // MEF3 is a directory bundle. The viewer enters via the bundle root.
    url: 'http://localhost:8011/tests/fixtures/ieeg/mef-tiny.mefd/',
    // The .mefd dispatch maps to the 'MEFD' pill (see worker.js
    // FORMAT_DISPATCH key).
    expected_pill: 'MEFD',
    notes: 'MEF3 (Mayo) — Tier 3 full decode via RED codec; local fixture (4ch × 2.5 s sine bundle)',
  },

  // Stub-tier (open() deliberately throws a documented error).
  {
    id: 'kriss-fixture',
    source: 'fixture',
    tier: 'stub',
    url: 'http://localhost:8011/tests/fixtures/meg/kriss-tiny.kdf',
    // open() throws "KRISS .kdf format is not yet supported …" — exact
    // wording lives in formats/kriss.js; we only pin the substring.
    expected_error_pattern: /KRISS|\.kdf|not (yet )?supported/i,
    notes: 'KRISS .kdf — stub-reader pending public spec',
  },
];

// Crash-class console errors that MUST NOT appear on any demo, regardless
// of tier. A clean error is a string rendered into the DOM; a crash is a
// TypeError / null-deref bubbling out of the worker.
const CRASH_PATTERN = /TypeError|Cannot read properties|ReferenceError|undefined is not/;

// Sidecar 404s are expected on the BIDS inheritance walk and are filtered
// from console errors before assertion. Same allow-list as audit-loadable.spec.mjs.
function isExpectedConsoleNoise(text) {
  if (/Failed to load resource/.test(text)) return true;
  if (/data\.eegdash\.org.*CORS policy/.test(text)) return true;
  if (/Access to fetch at 'https:\/\/data\.eegdash\.org/.test(text)) return true;
  return false;
}

for (const demo of DEMOS) {
  test(`demo: ${demo.id} (${demo.source}/${demo.tier}) — ${demo.notes}`, async ({ page }) => {
    test.skip(!RUN_DEMO_TESTS, 'RUN_DEMO_TESTS=1 not set — gated demo spec');

    const consoleErrors = [];
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (isExpectedConsoleNoise(t)) return;
      consoleErrors.push(`console.error: ${t}`);
    });

    await page.goto('/index.html?eeg=' + encodeURIComponent(demo.url));

    if (demo.tier === 'full') {
      // Stage-caption visible → recording open + first window rendered.
      await expect(
        page.locator('#stage-caption'),
        `${demo.id}: stage-caption never visible`,
      ).toBeVisible({ timeout: 60_000 });

      if (demo.expected_pill) {
        const pillText = (await page.locator('#pill-format').textContent())?.trim() ?? '';
        expect(pillText, `${demo.id}: pill mismatch`).toBe(demo.expected_pill);
      }

      // Canvas non-blank check — same routine as audit-loadable.spec.mjs.
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
      expect(nonBgPixels, `${demo.id}: canvas non-background pixels`).toBeGreaterThan(50);
    } else {
      // metadata / stub tier — we assert the error is surfaced cleanly.
      // The viewer renders documented errors into the status / recording
      // panel; the exact selector depends on which side of the boot the
      // reader threw. Wait for the error pattern to appear anywhere in
      // the body, then verify NO crash-class console error fired.
      await expect(
        page.locator(`text=${demo.expected_error_pattern}`).first(),
        `${demo.id}: expected error pattern not surfaced (was the message regressed?)`,
      ).toBeVisible({ timeout: 60_000 });
    }

    // Crash-free invariant — applies to every tier, including stubs.
    const crashErrors = [...pageErrors, ...consoleErrors].filter((t) => CRASH_PATTERN.test(t));
    expect(
      crashErrors,
      `${demo.id}: must surface errors cleanly, not crash\n${crashErrors.join('\n')}`,
    ).toHaveLength(0);

    // Save a screenshot for the evidence trail.
    const outDir = path.join(EVIDENCE_ROOT, demo.id);
    fs.mkdirSync(outDir, { recursive: true });
    await page.screenshot({
      path: path.join(outDir, 'screenshot.png'),
      fullPage: true,
    });
  });
}
