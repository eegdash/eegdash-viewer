import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';

const edf = fs.readFileSync('tests/fixtures/emg/sub-01_ses-02_task-emg2pose_run-17_recording-left_emg.edf');
const file = (name, text) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });

test('second view renders the MNE template, supports interaction, and returns to traces', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open a recording', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '3D geometry', exact: true }).click();
  await page.getByRole('button', { name: 'Explore the standard EEG montage' }).click();
  await expect(page.locator('#geometry-summary')).toHaveText('94 positions · MNE head · m');
  await expect(page.locator('#geometry-note')).toContainText('not participant digitization');
  const canvas = page.locator('#geometry-canvas');
  const pixels = () => canvas.evaluate(c => c.toDataURL());
  await expect.poll(async () => canvas.evaluate(c => c.width)).toBeGreaterThan(100);
  await expect(page.getByLabel('Reference head', { exact: true })).toBeChecked();
  const withHead = await pixels();
  await page.getByLabel('Reference head', { exact: true }).uncheck();
  await expect.poll(pixels).not.toBe(withHead);
  await page.getByLabel('Reference head', { exact: true }).check();
  const before = await pixels();
  await canvas.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(pixels).not.toBe(before);
  await page.locator('#geometry-sensor').selectOption({ label: 'Cz · EEG' });
  await expect(page.locator('#geometry-readout')).toContainText('Cz · EEG');
  await page.getByRole('button', { name: 'Top', exact: true }).click();
  const violations = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations;
  expect(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target).join(', ')}`)).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('geometry.png') });
  await page.getByRole('button', { name: 'Traces', exact: true }).click();
  await expect(page.locator('#geometry-panel')).toBeHidden();
  await expect(page.locator('#stage-hint')).toBeVisible();
  expect(errors).toEqual([]);
});

test('local file picker loads BIDS EMG geometry and clears it on the next recording', async ({ page }) => {
  await page.goto('/');
  await page.locator('#recording-files').setInputFiles([
    { name: 'sub-01_task-rest_emg.edf', mimeType: 'application/octet-stream', buffer: edf },
    file('sub-01_electrodes.tsv', 'name\tx\ty\tz\nEMG1\t0\t10\t0\nEMG2\t0\t20\t0'),
    file('sub-01_coordsystem.json', '{"EMGCoordinateSystem":"Other","EMGCoordinateUnits":"mm"}'),
  ]);
  await expect(page.locator('#stage-caption')).toBeVisible();
  await page.locator('#view-geometry').click();
  await expect(page.locator('#geometry-summary')).toHaveText('2 positions · Other · mm');
  await expect(page.locator('#geometry-note')).not.toContainText('Template');
  await page.locator('#view-traces').click();
  await expect(page.locator('#traces')).toBeVisible();
  await page.locator('#recording-files').setInputFiles([
    { name: 'sub-02_task-rest_emg.edf', mimeType: 'application/octet-stream', buffer: edf },
  ]);
  await expect(page.locator('#status')).toContainText('sub-02_task-rest_emg.edf');
  await expect(page.locator('#stage-caption')).toBeVisible();
  await page.locator('#view-geometry').click();
  await expect(page.locator('#geometry-empty-title')).toHaveText('This recording has no 3D positions');
  await expect(page.locator('#geometry-canvas')).toBeHidden();
});

for (const [modality, source, name] of [
  ['meg', 'tests/fixtures/meg/test_ctf_comp_raw.fif', 'sub-01_task-rest_meg.fif'],
  ['nirs', 'tests/fixtures/nirs/snirf-tiny.snirf', 'sub-01_task-rest_nirs.snirf'],
]) {
  test(`${modality} geometry crosses the real reader / worker boundary`, async ({ page }) => {
    await page.goto('/');
    await page.locator('#recording-files').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: fs.readFileSync(source) });
    await expect(page.locator('#stage-caption')).toBeVisible();
    await page.locator('#view-geometry').click();
    if (modality === 'nirs') {
      // This real SNIRF fixture has only 2D probe positions. Do not
      // manufacture z=0; allow real 3D BIDS optodes to be supplied.
      await expect(page.locator('#geometry-empty-title')).toHaveText('This recording has no 3D positions');
      await page.locator('#geometry-files').setInputFiles([
        file('sub-01_optodes.tsv', 'name\tx\ty\tz\ttype\nS1\t2\t2\t3\tsource\nD1\t0\t0\t3\tdetector'),
        file('sub-01_coordsystem.json', '{"NIRSCoordinateSystem":"Other","NIRSCoordinateUnits":"cm"}'),
      ]);
    }
    await expect(page.locator('#geometry-canvas')).toBeVisible();
    await expect(page.locator('#geometry-source')).toContainText(modality === 'meg' ? 'FIFF' : 'optodes.tsv');
    await expect(page.locator('#geometry-sensor option').first()).not.toHaveText('');
    if (modality === 'meg') {
      await expect(page.locator('#geometry-summary')).toHaveText('274 positions · MNE head · m');
      await expect(page.locator('#geometry-sensor')).not.toContainText('BG1-2908');
      await page.locator('#geometry-references').check();
      await expect(page.locator('#geometry-summary')).toHaveText('303 positions · MNE head · m');
      await expect(page.locator('#geometry-sensor')).toContainText('BG1-2908 · MEGREF');
      await page.locator('#geometry-references').uncheck();
      await page.screenshot({ path: test.info().outputPath('meg-head.png') });
    }
  });
}

test('phone geometry remains reachable without horizontal page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.locator('#view-geometry').click();
  await page.locator('#geometry-preview').click();
  await page.locator('#geometry-sensor').scrollIntoViewIfNeeded();
  await expect(page.locator('#geometry-sensor')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath('geometry-phone.png') });
});

test('header-only recording keeps channel controls and view settings across the 3D view', async ({ page }) => {
  await page.goto('/index.html?meg=/tests/fixtures/meg/test_ctf_comp_raw.fif');
  await expect(page.locator('#stage-caption')).toBeVisible();
  await expect(page.locator('#channel-count')).toHaveText('340');
  await expect(page.locator('#ch-list .ch-row')).toHaveCount(340);
  const channel = page.locator('#ch-list .ch-row').first();
  await expect(channel).toContainText('UPPT002');
  await channel.click();
  await expect(channel).toHaveClass(/is-bad/);
  const swatch = page.locator('#channel-colors .color-swatch:not(.active)').first();
  const color = await swatch.getAttribute('data-color');
  await swatch.click();
  await page.locator('#filter-hp-enable').check();
  await page.locator('#window-sec').selectOption('5');
  await page.locator('#gain').focus();
  await page.keyboard.press('ArrowRight');
  const gain = await page.locator('#gain').inputValue();
  expect(Number(gain)).toBeGreaterThan(1);
  await page.locator('#view-geometry').click();
  await expect(page.locator('#geometry-canvas')).toBeVisible();
  await page.locator('#view-traces').click();
  await expect(page.locator('#traces')).toBeVisible();
  await expect(channel).toHaveClass(/is-bad/);
  await expect(page.locator('#channel-colors .color-swatch.active').first()).toHaveAttribute('data-color', color);
  await expect(page.locator('#filter-hp-enable')).toBeChecked();
  await expect(page.locator('#window-sec')).toHaveValue('5');
  await expect(page.locator('#gain')).toHaveValue(gain);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#show-metadata').click();
  await expect(page.locator('#metadata-overlay')).toBeVisible();
  await expect(page.locator('#meta-channels-rows tr').first()).toContainText('UPPT002');
});

test('native channel types reach the color controls without a channels sidecar', async ({ page }) => {
  await page.goto('/index.html?meg=/tests/fixtures/meg/kit-tiny.con');
  await expect(page.locator('#stage-caption')).toBeVisible();
  await expect(page.locator('#channel-colors .ch-type-label')).toHaveText('MAG');
});

for (const [suffix, prefix, space, head] of [
  ['eeg', 'EEG', 'CapTrak', true], ['ieeg', 'iEEG', 'ACPC', false],
  ['meg', 'MEG', 'CTF', true], ['nirs', 'NIRS', 'CapTrak', true], ['emg', 'EMG', 'Other', false],
]) {
  test(`${suffix} coordinates-only input works through the main file picker`, async ({ page }) => {
    await page.goto('/');
    const kind = suffix === 'nirs' ? 'optodes' : 'electrodes';
    await page.locator('#recording-files').setInputFiles([
      file(`sub-01_space-${space}_${kind}.tsv`, 'name\tx\ty\tz\nA\t-30\t20\t80\nB\t30\t20\t80'),
      file(`sub-01_space-${space}_coordsystem.json`, JSON.stringify({ [`${prefix}CoordinateSystem`]: space, [`${prefix}CoordinateUnits`]: 'mm' })),
    ]);
    await expect(page.locator('#geometry-canvas')).toBeVisible();
    await expect(page.locator('#geometry-summary')).toContainText('2 positions');
    await expect(page.locator('#geometry-head')).toBeChecked({ checked: head });
    await expect(page.locator('#status')).not.toContainText('Drop a');
  });
}

test('recording plus space-qualified coordinates uses the correct frame JSON', async ({ page }) => {
  await page.goto('/');
  await page.locator('#recording-files').setInputFiles([
    { name: 'sub-01_task-rest_emg.edf', mimeType: 'application/octet-stream', buffer: edf },
    file('sub-01_space-Forearm_electrodes.tsv', 'name\tx\ty\tz\nE1\t1\t2\t3'),
    file('sub-01_space-Forearm_coordsystem.json', '{"EMGCoordinateSystem":"Other","EMGCoordinateUnits":"cm"}'),
  ]);
  await expect(page.locator('#stage-caption')).toBeVisible();
  await page.locator('#view-geometry').click();
  await expect(page.locator('#geometry-summary')).toContainText('cm');
  await expect(page.locator('#geometry-source')).toContainText('space-Forearm_electrodes.tsv');
});

test('TSV without JSON permits explicit head frame and units; invalid replacement preserves valid geometry', async ({ page }) => {
  await page.goto('/');
  await page.locator('#recording-files').setInputFiles(file('electrodes.tsv', 'name\tx\ty\tz\nCz\t0\t0\t90'));
  await expect(page.locator('#geometry-canvas')).toBeVisible();
  await expect(page.locator('#geometry-head')).toBeDisabled();
  await page.locator('#geometry-coordinate-frame').selectOption('CapTrak');
  await page.locator('#geometry-coordinate-units').selectOption('mm');
  await expect(page.locator('#geometry-head')).toBeChecked();
  await expect(page.locator('#geometry-readout')).toContainText('90.000 mm');
  await page.locator('#geometry-files').setInputFiles(file('electrodes.tsv', 'name\tx\ty\tz\nX\tn/a\tn/a\tn/a'));
  await expect(page.locator('#geometry-error')).toContainText('No sensors with finite');
  await expect(page.locator('#geometry-sensor')).toContainText('Cz');
});

test('electrodes-only URL opens the geometry without a recording', async ({ page }) => {
  await page.route(url => url.pathname === '/url-demo_electrodes.tsv', r => r.fulfill({ body: 'name\tx\ty\tz\nCz\t0\t0\t90' }));
  await page.route(url => url.pathname === '/url-demo_coordsystem.json', r => r.fulfill({ body: '{"EEGCoordinateSystem":"CapTrak","EEGCoordinateUnits":"mm"}' }));
  await page.goto('/?tsv=/url-demo_electrodes.tsv&coords=/url-demo_coordsystem.json');
  await expect(page.locator('#geometry-canvas')).toBeVisible();
  await expect(page.locator('#geometry-head')).toBeChecked();
});

test('official BIDS electrodes-only example renders a reference head', async ({ page }) => {
  const root = '/tests/fixtures/geometry/sub-EP10_ses-01_space-CapTrak_';
  await page.goto(`/?tsv=${root}electrodes.tsv&coords=${root}coordsystem.json`);
  await expect(page.locator('#geometry-canvas')).toBeVisible();
  await expect(page.locator('#geometry-head')).toBeChecked();
  await expect(page.locator('#geometry-source')).toContainText('sub-EP10');
  await page.getByRole('button', { name: 'Front', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('eeg-head-front.png') });
});
