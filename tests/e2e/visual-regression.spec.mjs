/**
 * visual-regression.spec.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Canvas visual regression for the EEG trace renderer. Each test loads the
 * viewer with a synthetic or local-fixture dataset, waits for the canvas to
 * be rendered, then compares a cropped canvas screenshot against a committed
 * PNG baseline stored in __snapshots__/.
 *
 * WHY WE CROP TO CANVAS ONLY
 * The viewer header contains pills that include channel count and sample rate;
 * those strings are stable across runs. However the time-axis ticks and any
 * bottom chrome are also stable because we fix start_sec=0. We crop the
 * canvas region only to avoid timing-pill animation artifacts and reduce the
 * pixel surface that needs to match across OS font-rendering variants.
 *
 * FLAKINESS CONSIDERATIONS
 * ┌───────────────────────────────────────────────────────────────┐
 * │ Canvas anti-aliasing and sub-pixel rendering differ slightly  │
 * │ between macOS (Quartz) and Linux (FreeType/Skia). The        │
 * │ thresholds below (maxDiffPixels: 200, threshold: 0.15) were  │
 * │ tuned on macOS + Chromium 1.59. If CI runs on Linux,         │
 * │ regenerate baselines on that platform and commit the Linux    │
 * │ PNGs (see HOW TO REGENERATE BASELINES below).                │
 * │                                                               │
 * │ Font rendering: IBM Plex Mono is loaded via Google Fonts in   │
 * │ production. The local dev server does not load remote fonts,  │
 * │ so the axis labels fall back to system monospace. Baselines   │
 * │ committed here reflect that fallback. If the font stack       │
 * │ changes, regenerate baselines.                                │
 * └───────────────────────────────────────────────────────────────┘
 *
 * HOW TO REGENERATE BASELINES (after intentional render changes)
 * ──────────────────────────────────────────────────────────────
 *   # From the repo root:
 *   npx playwright test tests/e2e/visual-regression.spec.mjs --update-snapshots
 *
 *   # Review the changed PNGs in tests/e2e/__snapshots__/ with:
 *   git diff --name-only tests/e2e/__snapshots__/
 *
 *   # On Linux CI (recommended for team-wide consistency):
 *   docker run --rm -v $(pwd):/work -w /work \
 *     mcr.microsoft.com/playwright:v1.59.1-noble \
 *     npx playwright test tests/e2e/visual-regression.spec.mjs --update-snapshots
 *
 *   Commit the updated PNGs together with any render code change.
 *
 * FORMATS COVERED
 *   • local-edf  — local EDF+ fixture (test-data/edfplus-with-annotations.edf)
 *   • synth-eeg  — synthetic 4-channel EEG injected via page.evaluate()
 *   • synth-transparent — same data with ?embed=1 (transparent canvas mode)
 *   • synth-bad-channels — same data with 1 bad channel flagged
 *   • synth-events — same data with 3 event-onset markers
 *
 * NOTE: EEGLAB, BrainVision, NEMAR-BDF, NEMAR-inline-set formats are covered
 * by multi-record-smoke.spec.mjs and nemar-smoke.spec.mjs. Those tests hit the
 * live CDN and are therefore excluded from visual-regression to avoid flakiness
 * from S3 latency variability. Instead we use the local EDF fixture and
 * synthetic data to cover all render paths (bad channels, events, transparent).
 */

import { test, expect } from '@playwright/test';

// ── Shared screenshot options ────────────────────────────────────────────────
// threshold: per-pixel color tolerance (0–1). 0.15 absorbs sub-pixel
//   anti-aliasing that varies between macOS Quartz and Linux Skia.
// maxDiffPixels: absolute fallback ceiling. 200 px is ~0.03% of an
//   800×600 canvas (generous for curve AA, tight for structural changes).
const SNAP_OPTS = {
  threshold: 0.15,
  maxDiffPixels: 200,
  animations: 'disabled',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * waitForCanvas(page) — poll until the canvas has non-blank (non-cream) pixels.
 * BG_COLOR is #fbfaf6 (R=251,G=250,B=246); any pixel with a component < 240
 * means the renderer has drawn at least one trace.
 */
async function waitForCanvas(page, timeout = 20_000) {
  await page.waitForFunction(() => {
    const canvas = document.getElementById('traces');
    if (!canvas || canvas.hasAttribute('hidden')) return false;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < data.length; i += 400) {
      if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) return true;
    }
    return false;
  }, {}, { timeout });
}

/**
 * canvasLocator(page) — returns the canvas element locator.
 * We always screenshot the element (not full page) to isolate the render
 * output from header chrome, status pills, and scrollbar artefacts.
 */
function canvasLocator(page) {
  return page.locator('#traces');
}

/**
 * injectSynthDraw(page, opts) — call TraceRenderer.draw() directly with
 * synthetic data, bypassing the EEG file loading machinery. This lets us
 * produce deterministic, reproducible renders for visual regression without
 * relying on network access or file I/O latency.
 *
 * @param {object} opts - passed straight to TraceRenderer.draw()
 */
async function injectSynthDraw(page, opts) {
  await page.evaluate((opts) => {
    const canvas = document.getElementById('traces');
    if (!canvas) throw new Error('#traces canvas not found');
    canvas.removeAttribute('hidden');
    canvas.style.width  = '800px';
    canvas.style.height = '500px';

    // Build Float32Arrays from plain arrays (structured-clone boundary).
    const channels = opts.channelData.map(arr => new Float32Array(arr));
    window.TraceRenderer.draw(canvas, {
      channels,
      channel_labels:  opts.channel_labels,
      channel_types:   opts.channel_types,
      channel_colors:  opts.channel_colors  || null,
      bad_mask:        opts.bad_mask        || null,
      events:          opts.events          || [],
      n_samples_visible: opts.n_samples_visible,
      fs:              opts.fs,
      start_sec:       opts.start_sec,
      gain:            opts.gain ?? 1,
      transparent:     opts.transparent ?? false,
    });
  }, opts);
}

/**
 * synthChannelData(nCh, nSamples) — generates a ramp+sine that gives each
 * channel a distinct, visually separated trace. Deterministic (no Math.random).
 */
function synthChannelData(nCh, nSamples) {
  const channels = [];
  for (let c = 0; c < nCh; c++) {
    const d = [];
    for (let i = 0; i < nSamples; i++) {
      // Ramp + sine at channel-specific frequency and amplitude.
      d.push(Math.sin((2 * Math.PI * (c + 1) * i) / nSamples) * (c + 1) * 20);
    }
    channels.push(d);
  }
  return channels;
}

// ── Shared fixture nav ───────────────────────────────────────────────────────

async function gotoBlank(page) {
  // Navigate to the viewer without any dataset so it renders an empty
  // canvas state. We then inject via TraceRenderer.draw() directly.
  await page.goto('/index.html');
  // Give the page a moment to initialise TraceRenderer.
  await page.waitForFunction(() => typeof window.TraceRenderer !== 'undefined',
    {}, { timeout: 10_000 });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('visual regression — canvas renderer', () => {

  /**
   * local-edf: Load the committed EDF+ fixture which contains real EEG data
   * plus annotations. Uses the range-fetch path, fully local.
   *
   * The canvas is measured at 1280×720 viewport to match the default project
   * device config (Desktop Chrome). We wait for the stage-caption to confirm
   * the reader is done before snapshotting.
   */
  test('local-edf fixture renders without visual change', async ({ page }) => {
    await page.goto('/index.html?eeg=/test-data/edfplus-with-annotations.edf');

    // Stage caption signals the reader + first draw are complete.
    await expect(page.locator('#stage-caption')).toBeVisible({ timeout: 30_000 });
    await waitForCanvas(page);

    await expect(canvasLocator(page)).toHaveScreenshot(
      'local-edf-canvas.png',
      SNAP_OPTS
    );
  });

  /**
   * synth-eeg: 4-channel synthetic EEG drawn directly via TraceRenderer.draw().
   * Completely deterministic — no file I/O, no network.
   */
  test('synth 4-ch EEG renders correctly', async ({ page }) => {
    await gotoBlank(page);

    const nSamples = 500;
    await injectSynthDraw(page, {
      channelData:       synthChannelData(4, nSamples),
      channel_labels:    ['Fp1', 'Fp2', 'Fz', 'Cz'],
      channel_types:     ['EEG', 'EEG', 'EEG', 'EEG'],
      n_samples_visible: nSamples,
      fs:                250,
      start_sec:         0,
    });
    await waitForCanvas(page);

    await expect(canvasLocator(page)).toHaveScreenshot(
      'synth-4ch-eeg-canvas.png',
      SNAP_OPTS
    );
  });

  /**
   * synth-transparent: Same 4-channel render but with transparent=true
   * (?embed=1 mode). The canvas background should be fully clear; traces
   * must still appear. A regression here would show the cream BG flooding
   * back (clearRect→fillRect mutation).
   */
  test('synth transparent (embed) mode: traces visible, BG clear', async ({ page }) => {
    await page.goto('/index.html?embed=1');
    await page.waitForFunction(() => typeof window.TraceRenderer !== 'undefined',
      {}, { timeout: 10_000 });

    const nSamples = 500;
    await injectSynthDraw(page, {
      channelData:       synthChannelData(4, nSamples),
      channel_labels:    ['Ch1', 'Ch2', 'Ch3', 'Ch4'],
      channel_types:     ['EEG', 'EEG', 'EEG', 'EEG'],
      n_samples_visible: nSamples,
      fs:                250,
      start_sec:         0,
      transparent:       true,
    });
    await waitForCanvas(page);

    await expect(canvasLocator(page)).toHaveScreenshot(
      'synth-transparent-canvas.png',
      SNAP_OPTS
    );
  });

  /**
   * synth-bad-channels: Channel index 1 marked as bad. Expect the bad-channel
   * slot to show the muted grey background and the vermillion trace colour.
   * Catches the mutation that drops the bad_mask check.
   */
  test('synth bad-channel row has distinct visual treatment', async ({ page }) => {
    await gotoBlank(page);

    const nSamples = 500;
    await injectSynthDraw(page, {
      channelData:       synthChannelData(4, nSamples),
      channel_labels:    ['Fp1', 'Fp2', 'Fz', 'Cz'],
      channel_types:     ['EEG', 'EEG', 'EEG', 'EEG'],
      bad_mask:          [false, true, false, false],
      n_samples_visible: nSamples,
      fs:                250,
      start_sec:         0,
    });
    await waitForCanvas(page);

    await expect(canvasLocator(page)).toHaveScreenshot(
      'synth-bad-channel-canvas.png',
      SNAP_OPTS
    );
  });

  /**
   * synth-events: Three event-onset markers at distinct time points. Tests
   * that drawEventMarkers produces the muted-green hairlines + labels without
   * polluting adjacent renders.
   */
  test('synth event-onset markers appear at correct positions', async ({ page }) => {
    await gotoBlank(page);

    const nSamples = 500;
    await injectSynthDraw(page, {
      channelData:       synthChannelData(3, nSamples),
      channel_labels:    ['Fp1', 'Fp2', 'Fz'],
      channel_types:     ['EEG', 'EEG', 'EEG'],
      events:            [
        { onset: 0.25, label: 'S1' },
        { onset: 0.75, label: 'S2' },
        { onset: 1.50, label: 'S3' },
      ],
      n_samples_visible: nSamples,
      fs:                250,
      start_sec:         0,
    });
    await waitForCanvas(page);

    await expect(canvasLocator(page)).toHaveScreenshot(
      'synth-events-canvas.png',
      SNAP_OPTS
    );
  });

  /**
   * synth-mixed-types: EEG, EOG, and ECG channels in one recording. Checks
   * that the type-specific dash patterns (solid / dashed / dotted) and the
   * type-suffix label chip render correctly side-by-side.
   */
  test('synth mixed-type channels (EEG+EOG+ECG) use correct dash patterns', async ({ page }) => {
    await gotoBlank(page);

    const nSamples = 500;
    await injectSynthDraw(page, {
      channelData:       synthChannelData(3, nSamples),
      channel_labels:    ['Fp1', 'EOG-L', 'ECG'],
      channel_types:     ['EEG', 'EOG',   'ECG'],
      n_samples_visible: nSamples,
      fs:                250,
      start_sec:         0,
    });
    await waitForCanvas(page);

    await expect(canvasLocator(page)).toHaveScreenshot(
      'synth-mixed-types-canvas.png',
      SNAP_OPTS
    );
  });

});
