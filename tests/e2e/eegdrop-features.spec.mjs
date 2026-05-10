/**
 * Playwright tests for the eegdrop-incorporation features defined in
 * docs/eegdrop-features-spec.md. Each test is named with the F-XX:
 * prefix the validator runbook greps for. Tests are written for the
 * post-implementation state — today they are filtered out by the
 * validator's PRE-IMPLEMENTATION CHECK (a grep over the source) and
 * never get invoked. Once a feature lands, the same test starts
 * passing without spec changes.
 *
 * TIMEOUT BUDGET
 *   Global test timeout : 90 s (playwright.config.mjs)
 *   Global expect.timeout: 30 s
 *   Per-assertion overrides:
 *     stage-caption visible: 60 s — cold S3 can take 20–40 s
 *     worker message wait  : 30 s — worker.js must respond within one RAF cycle
 *     filter re-render     : 15 s — filter + re-fetch + draw
 *
 * waitForTimeout usage in this file:
 *   150 ms — rAF flush after a click (canvas.screenshot() requires the
 *             frame to complete; using waitForFunction is heavier here).
 *   200 ms — cursor hover settle (mousemove events are asynchronous).
 *   800 ms — drain in-flight prefetch before baselining (intentional).
 *   These are the minimum necessary to avoid spurious pixel comparisons;
 *   they are NOT arbitrary sleeps masking timing bugs.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const FIXTURES = {
  eeglab: 'https://s3.amazonaws.com/openneuro.org/ds002893/sub-001/eeg/sub-001_task-AuditoryVisualShift_run-01_eeg.set',
  edf:    'https://s3.amazonaws.com/openneuro.org/ds002034/sub-01/ses-01/eeg/sub-01_ses-01_task-offline_run-01_eeg.edf',
  bv:     'https://s3.amazonaws.com/openneuro.org/ds002336/sub-xp101/eeg/sub-xp101_task-motorloc_eeg.vhdr',
};

const EVIDENCE_ROOT = path.resolve('tests/evidence');

function evidenceDir(featureId) {
  const dir = path.join(EVIDENCE_ROOT, featureId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function gotoFixture(page, kind = 'eeglab') {
  await page.goto(`/index.html?eeg=${encodeURIComponent(FIXTURES[kind])}`);
  await expect(page.locator('#stage-caption')).toBeVisible({ timeout: 60_000 });
}

async function canvasBox(page) {
  const box = await page.locator('#traces').boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  return box;
}

test.describe('eegdrop incorporation', () => {
  test('F01: cursor readout shows time, channel, amplitude on hover', async ({ page }) => {
    const dir = evidenceDir('F01-cursor-readout');
    await gotoFixture(page, 'eeglab');

    const box = await canvasBox(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(200);

    const bar = page.locator('#cursor-info-bar');
    await expect(bar).toBeVisible();

    const t = await page.locator('.cursor-time').textContent();
    expect(t).toMatch(/^t = -?\d+\.\d{3}\s*s$/);

    const ch = await page.locator('.cursor-channel').textContent();
    const labels = await page.locator('#ch-list .ch-name').allTextContents();
    expect(labels).toContain(ch);

    const v = await page.locator('.cursor-value').textContent();
    expect(v).toMatch(/^-?\d+(\.\d{1,2})?\s*(µV|mV|V|au)$/);

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 4);
    await page.waitForTimeout(200);
    const ch2 = await page.locator('.cursor-channel').textContent();
    expect(ch2).not.toBe(ch);

    await page.screenshot({ path: path.join(dir, 'screenshot.png'), clip: box });
    fs.writeFileSync(path.join(dir, 'dom-snapshot.json'), JSON.stringify({
      cursor_time: await page.locator('.cursor-time').textContent(),
      cursor_channel: ch2,
      cursor_value: await page.locator('.cursor-value').textContent(),
    }, null, 2));
  });

  test('F02: keyboard shortcuts overlay opens with ? and closes with Escape', async ({ page }) => {
    const dir = evidenceDir('F02-shortcuts-overlay');
    await gotoFixture(page, 'eeglab');

    const overlay = page.locator('#shortcuts-overlay');
    await expect(overlay).toHaveCount(1);
    expect(await overlay.isHidden()).toBe(true);

    await page.keyboard.press('?');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.overlay-panel h2')).toHaveText('Keyboard Shortcuts');

    const keys = await overlay.locator('.shortcut-key').allTextContents();
    const required = ['←', '→', 'b', 'i', '?'];
    for (const k of required) {
      expect(keys.some(x => x.includes(k)), `missing key: ${k}`).toBe(true);
    }

    await page.screenshot({ path: path.join(dir, 'screenshot.png') });
    fs.writeFileSync(path.join(dir, 'shortcuts.json'), JSON.stringify({ keys }, null, 2));

    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden();
  });

  test('F03: file metadata overlay opens with i, lists sidecar provenance', async ({ page }) => {
    const dir = evidenceDir('F03-metadata-overlay');
    await gotoFixture(page, 'eeglab');
    await expect(page.locator('#ch-list .ch-row').first()).toBeVisible();

    const overlay = page.locator('#metadata-overlay');
    await expect(overlay).toHaveCount(1);
    await page.keyboard.press('i');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.overlay-panel h2')).toHaveText('File Information');

    const required = {
      'Sample rate': /^\d+(\.\d+)?\s*Hz$/,
      'Channels':    /^\d+$/,
      'Duration':    /^\d+(\.\d+)?\s*s$/,
      'Format':      /^(EDF|BDF|SET|VHDR)$/,
      'Samples':     /^\d+$/,
    };
    const captured = {};
    for (const [key, re] of Object.entries(required)) {
      const row = overlay.locator(`tr:has(td:has-text("${key}"))`).first();
      await expect(row).toBeVisible();
      const value = (await row.locator('td').nth(1).textContent())?.trim() ?? '';
      expect(value, `${key} value`).toMatch(re);
      captured[key] = value;
    }

    const chCount = await page.locator('#ch-list .ch-row').count();
    const metaChCount = await overlay.locator('.meta-section-channels table tr').count();
    expect(metaChCount).toBeGreaterThanOrEqual(chCount);

    await page.screenshot({ path: path.join(dir, 'screenshot.png') });
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(captured, null, 2));

    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden();
    await page.keyboard.press('i');
    await overlay.locator('.overlay-close').click();
    await expect(overlay).toBeHidden();
  });

  test('F04: click channel row toggles bad state and changes canvas pixels', async ({ page }) => {
    const dir = evidenceDir('F04-toggle-bad');
    await gotoFixture(page, 'eeglab');
    await expect(page.locator('#ch-list .ch-row')).toHaveCount(36);

    const row = page.locator('#ch-list .ch-row').nth(5);
    const name = (await row.locator('.ch-name').textContent())?.trim();
    const before = await row.locator('.bad-dot').count();

    const baseline = await page.locator('#traces').screenshot();

    await row.click();
    await page.waitForTimeout(150);
    const after = await row.locator('.bad-dot').count();
    expect(after).toBe(before === 0 ? 1 : 0);

    const filtered = await page.locator('#traces').screenshot();
    expect(Buffer.compare(baseline, filtered)).not.toBe(0);

    await row.click();
    await page.waitForTimeout(150);
    const reverted = await row.locator('.bad-dot').count();
    expect(reverted).toBe(before);

    await page.screenshot({ path: path.join(dir, 'screenshot.png') });
    fs.writeFileSync(path.join(dir, 'toggle.json'), JSON.stringify({
      channel_name: name, was_bad: before > 0, toggled_to: after > 0,
    }, null, 2));
  });

  test('F05: per-channel-type colors render and accept overrides', async ({ page }) => {
    const dir = evidenceDir('F05-channel-colors');
    await gotoFixture(page, 'edf');

    const rows = page.locator('#channel-colors .color-swatch-row');
    expect(await rows.count()).toBeGreaterThanOrEqual(1);

    const types = await rows.locator('.ch-type-label').allTextContents();
    const defaults = {};
    for (let i = 0; i < types.length; i++) {
      const active = rows.nth(i).locator('button.color-swatch.active');
      defaults[types[i]] = await active.evaluate(el => getComputedStyle(el).backgroundColor);
    }

    const swatches = rows.first().locator('button.color-swatch');
    const swatchCount = await swatches.count();
    expect(swatchCount).toBeGreaterThanOrEqual(5);
    await swatches.nth(swatchCount - 1).click();
    await page.waitForTimeout(150);
    await expect(swatches.nth(swatchCount - 1)).toHaveClass(/active/);

    const after = {};
    for (let i = 0; i < types.length; i++) {
      const active = rows.nth(i).locator('button.color-swatch.active');
      after[types[i]] = await active.evaluate(el => getComputedStyle(el).backgroundColor);
    }
    expect(after[types[0]]).not.toBe(defaults[types[0]]);

    await page.screenshot({ path: path.join(dir, 'screenshot.png') });
    fs.writeFileSync(path.join(dir, 'colors.json'), JSON.stringify({
      types, default_colors: defaults, after_change: after,
    }, null, 2));
  });

  test('F06: time mode toggle flips axis labels between relative and clock', async ({ page }) => {
    const dir = evidenceDir('F06-time-mode');
    await gotoFixture(page, 'edf');

    const toggle = page.locator('#time-mode-toggle');
    await expect(toggle).toBeVisible();
    expect(await toggle.getAttribute('data-mode')).toBe('relative');

    const labelsRel = await page.evaluate(() => globalThis.TraceRenderer?.lastDrawnXLabels ?? []);
    expect(labelsRel.length).toBeGreaterThan(0);
    for (const l of labelsRel) expect(String(l)).toMatch(/^\d+(\.\d+)?$/);

    await toggle.click();
    await page.waitForTimeout(150);
    expect(await toggle.getAttribute('data-mode')).toBe('clock');

    const labelsClock = await page.evaluate(() => globalThis.TraceRenderer?.lastDrawnXLabels ?? []);
    for (const l of labelsClock) expect(String(l)).toMatch(/^\d{2}:\d{2}:\d{2}$/);

    await page.screenshot({ path: path.join(dir, 'screenshot.png') });
    fs.writeFileSync(path.join(dir, 'labels.json'), JSON.stringify({
      rel_labels: labelsRel, clock_labels: labelsClock,
    }, null, 2));
  });

  test('F07: viewer offloads reads to a Web Worker', async ({ page }) => {
    const dir = evidenceDir('F07-worker');
    await gotoFixture(page, 'eeglab');
    await page.waitForFunction(() => globalThis.__viewerWorker instanceof Worker, null, { timeout: 30_000 });

    await page.evaluate(() => { globalThis.__viewerWorkerStats = { messages_sent: 0, messages_received: 0 }; });
    const before = await page.evaluate(() => globalThis.__viewerWorkerStats?.messages_sent ?? 0);

    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(500);

    const stats = await page.evaluate(() => ({ ...(globalThis.__viewerWorkerStats || {}) }));
    // Expect at least one FETCH_WINDOW per pan after RAF coalescing.
    // Was 10+before before the prefetch idle-gate (which amplified each
    // render to 5 messages); now each pan produces 1 foreground +
    // optionally 1 prefetch when the worker is idle. 5 is a robust
    // lower bound that still proves the worker is in active use.
    expect(stats.messages_sent ?? 0).toBeGreaterThanOrEqual(5 + before);
    expect(stats.messages_received ?? 0).toBeGreaterThanOrEqual(5);

    fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify(stats, null, 2));
    await page.screenshot({ path: path.join(dir, 'screenshot.png') });
  });

  test('F08: enabling a filter changes canvas pixels (UI wiring)', async ({ page }) => {
    const dir = evidenceDir('F08-filters');
    await gotoFixture(page, 'edf');

    const sample = () => page.locator('#traces').screenshot();

    // After a filter UI change, wait for at least 2 fresh WINDOWs to
    // arrive so any in-flight prefetch from the prior render is drained
    // and the filter-induced foreground fetch has come back. Then one
    // RAF pair to ensure traces.draw() has painted.
    const getWindows = () =>
      page.evaluate(() => globalThis.__viewerWorkerStats?.windows_received ?? 0);
    const waitFiltered = async (before) => {
      await page.waitForFunction(
        b => (globalThis.__viewerWorkerStats?.windows_received ?? 0) >= b + 2,
        before,
        { timeout: 15_000 },
      );
      await page.evaluate(() => new Promise(r =>
        requestAnimationFrame(() => requestAnimationFrame(r))));
    };

    // Drain any in-flight prefetch from initial load before baselining.
    await page.waitForTimeout(800);
    const baseline = await sample();

    let before = await getWindows();
    await page.locator('#filter-hp-enable').check();
    await page.locator('#filter-hp-cutoff').fill('30');
    await page.locator('#filter-hp-cutoff').blur();
    await waitFiltered(before);
    const hp = await sample();
    expect(Buffer.compare(baseline, hp), 'HP filter must change canvas').not.toBe(0);

    before = await getWindows();
    await page.locator('#filter-hp-enable').uncheck();
    await page.locator('#filter-notch-enable').check();
    await page.locator('#filter-notch-freq').selectOption('60');
    await waitFiltered(before);
    const notch = await sample();
    expect(Buffer.compare(baseline, notch), 'Notch filter must change canvas').not.toBe(0);

    await page.screenshot({ path: path.join(dir, 'screenshot.png') });
    fs.writeFileSync(path.join(dir, 'pixel-deltas.json'), JSON.stringify({
      baseline_bytes: baseline.length,
      hp_bytes: hp.length,
      notch_bytes: notch.length,
      hp_changed: Buffer.compare(baseline, hp) !== 0,
      notch_changed: Buffer.compare(baseline, notch) !== 0,
    }, null, 2));
  });

  test('F09: EDF+ Annotations channel events render in #ev-list', async ({ page }) => {
    const dir = evidenceDir('F09-edf-annotations');
    // Implementer must point this at a fixture with annotations + no _events.tsv.
    // Default uses a checked-in local fixture.
    await page.goto('/index.html?eeg=' + encodeURIComponent('/test-data/edfplus-with-annotations.edf'));
    await expect(page.locator('#stage-caption')).toBeVisible({ timeout: 60_000 });

    const eventCount = parseInt(await page.locator('#event-count').textContent() ?? '0', 10);
    expect(eventCount).toBeGreaterThan(0);

    const chNames = await page.locator('#ch-list .ch-name').allTextContents();
    expect(chNames).not.toContain('EDF Annotations');
    expect(chNames).not.toContain('BDF Annotations');

    const evRows = await page.locator('#ev-list .ev-row').count();
    expect(evRows).toBeGreaterThan(0);

    const events = await page.locator('#ev-list .ev-row').evaluateAll(rows => rows.slice(0, 5).map(r => ({
      onset: r.querySelector('.ev-onset')?.textContent,
      label: r.querySelector('.ev-label')?.textContent,
    })));

    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(events, null, 2));
    await page.screenshot({ path: path.join(dir, 'screenshot.png') });
  });
});
