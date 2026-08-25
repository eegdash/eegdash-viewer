/**
 * tests/e2e/host-bridge.spec.mjs
 *
 * A host page (what a Jupyter cell renders) frames the viewer in
 * ?embed=1 mode and hands it an EMG recording (2 s of emg2pose sub-01,
 * 36 ch @ 2 kHz) as a File plus its pose sidecar as a
 * data: URL over postMessage. Proves the serverless notebook path:
 * no Range requests for the recording, traces + skinned hand render,
 * and the embed layout docks the panel beside the canvas.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const EMG = path.resolve('tests/fixtures/emg/sub-01_ses-02_task-emg2pose_run-17_recording-left_emg.edf');
const POSE = path.resolve('tests/fixtures/pose/sub-01_run-17_2s_desc-pose.json');
const VIEWER = 'http://localhost:8011/index.html?embed=1';

const HOST_HTML = `<!doctype html><body style="margin:0;background:#fff">
<iframe id="v" src="${VIEWER}" style="width:1100px;height:520px;border:0"></iframe>
<script>
  window.__ready = new Promise(res => addEventListener('message', e => {
    if (e.data && e.data.type === 'eegdash-viewer:ready') res(true);
  }));
</script></body>`;

test('host bridge: File + pose data URL over postMessage renders traces and the hand', async ({ page }) => {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  const recordingRanges = [];
  page.on('request', r => { if (r.headers().range && /sub-01_ses-02/.test(r.url())) recordingRanges.push(r.url()); });

  await page.setContent(HOST_HTML);
  await page.evaluate(() => window.__ready);

  const frame = page.frameLocator('#v');
  await expect(frame.locator('#stage-hint p').first()).toHaveText(/Waiting for the host page/);

  const b64 = fs.readFileSync(EMG).toString('base64');
  const poseB64 = fs.readFileSync(POSE).toString('base64');
  await page.evaluate(async ([b64, poseB64]) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bytes], 'sub-01_ses-02_task-emg2pose_run-17_recording-left_emg.edf');
    document.getElementById('v').contentWindow.postMessage({
      type: 'eegdash-viewer:open',
      files: [file],
      pose: 'data:application/json;base64,' + poseB64,
    }, '*');
  }, [b64, poseB64]);

  await expect(frame.locator('#traces')).toBeVisible({ timeout: 30_000 });
  await expect(frame.locator('#pill-format')).toHaveText('EDF');
  await expect(frame.locator('#pill-channels')).toHaveText('36 ch');
  await expect(frame.locator('#pill-page')).toHaveText(/ch 1–\d+ of 36/);   // 36 ch @ 16px slots paginate in 520px
  await expect(frame.locator('#status')).toContainText('sub-01_ses-02_task-emg2pose_run-17_recording-left_emg.edf');

  // Pose docked beside the canvas: panel starts where the canvas ends.
  const panel = frame.locator('.pose-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.pose-caption')).toHaveText(/t = \d+\.\d{3} s · mesh/);
  const c = await frame.locator('#traces').boundingBox();
  const p = await panel.boundingBox();
  expect(p.x).toBeGreaterThanOrEqual(c.x + c.width - 1);
  expect(p.width).toBeGreaterThanOrEqual(240);

  // Toolbar: view + filter controls on screen in embed mode, lists off.
  await expect(frame.locator('#window-sec')).toBeVisible();
  await expect(frame.locator('#gain')).toBeVisible();
  await expect(frame.locator('#filter-hp-enable')).toBeVisible();
  await expect(frame.locator('#ch-list')).toBeHidden();
  const rail = await frame.locator('.rail.left').boundingBox();
  expect(rail.height, 'toolbar fits one row').toBeLessThan(44);

  await page.screenshot({ path: 'tests/evidence/host-bridge/embed-bridge.png' });

  // Header toggle mirrors `p`; the canvas reclaims the width.
  const toggle = frame.locator('#pose-toggle');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(panel).toBeHidden();
  await expect.poll(async () => (await frame.locator('#traces').boundingBox()).width).toBeGreaterThan(c.width + 200);
  await toggle.click();
  await expect(panel).toBeVisible();

  expect(recordingRanges, 'recording must never be fetched over HTTP').toEqual([]);
  expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
});

test('host bridge: a second open without a sidecar hides the hand and swaps the recording', async ({ page }) => {
  await page.setContent(HOST_HTML);
  await page.evaluate(() => window.__ready);
  const b64 = fs.readFileSync(EMG).toString('base64');
  const poseB64 = fs.readFileSync(POSE).toString('base64');
  const send = (withPose) => page.evaluate(async ([b64, poseB64, withPose]) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bytes], 'sub-01_ses-02_task-emg2pose_run-17_recording-left_emg.edf');
    document.getElementById('v').contentWindow.postMessage({
      type: 'eegdash-viewer:open', files: [file], pose: withPose ? 'data:application/json;base64,' + poseB64 : null,
    }, '*');
  }, [b64, poseB64, withPose]);
  const frame = page.frameLocator('#v');
  await send(true);
  await expect(frame.locator('.pose-panel')).toBeVisible({ timeout: 30_000 });
  await send(false);
  await expect(frame.locator('.pose-panel')).toBeHidden();
  await expect(frame.locator('#traces')).toBeVisible({ timeout: 30_000 });
});
