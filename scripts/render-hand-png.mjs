#!/usr/bin/env node
/**
 * Render one eegdash-pose sidecar to a standalone PNG through the viewer API.
 *
 * Usage:
 *   node scripts/render-hand-png.mjs --sidecar pose.json --output pose.png \
 *     [--time 12.5] [--width 720] [--height 720] [--scale 2] \
 *     [--mode auto|skeleton|mesh|both]
 *
 * The script deliberately does not know where the sidecar originated. This
 * keeps experiment orchestration responsible for data provenance while
 * EEGDash owns parsing, kinematics, and rasterization.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const USAGE = `Usage: node scripts/render-hand-png.mjs --sidecar <pose.json> --output <pose.png>
  [--time <seconds>] [--width <pixels>] [--height <pixels>] [--scale <factor>]
  [--mode auto|skeleton|mesh|both] [--camera-yaw <radians>]
  [--camera-pitch <radians>] [--camera-zoom <factor>]
  [--executable-path <browser>]
`;
const VIEWER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  throw new Error(`${message}\n\n${USAGE}`);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (!flag.startsWith('--')) fail(`unknown argument ${JSON.stringify(flag)}`);
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) fail(`missing value for ${flag}`);
    const name = flag.slice(2).replaceAll('-', '_');
    if (Object.hasOwn(values, name)) fail(`duplicate argument ${flag}`);
    values[name] = value;
    index += 1;
  }
  if (!values.sidecar || !values.output) fail('--sidecar and --output are required');
  if (values.mode && !['auto', 'skeleton', 'mesh', 'both'].includes(values.mode)) {
    fail(`unsupported --mode ${JSON.stringify(values.mode)}`);
  }
  return values;
}

function optionalNumber(values, name) {
  if (values[name] == null) return undefined;
  const number = Number(values[name]);
  if (!Number.isFinite(number)) fail(`--${name.replaceAll('_', '-')} must be finite`);
  return number;
}

const args = parseArgs(process.argv.slice(2));
const sidecarPath = resolve(args.sidecar);
const outputPath = resolve(args.output);
let sidecar;
try {
  sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'));
} catch (error) {
  fail(`cannot read a JSON sidecar at ${sidecarPath}: ${error.message}`);
}

const camera = {
  yaw: optionalNumber(args, 'camera_yaw'),
  pitch: optionalNumber(args, 'camera_pitch'),
  zoom: optionalNumber(args, 'camera_zoom'),
};
for (const key of Object.keys(camera)) if (camera[key] == null) delete camera[key];
const options = {
  time: optionalNumber(args, 'time'),
  width: optionalNumber(args, 'width'),
  height: optionalNumber(args, 'height'),
  scale: optionalNumber(args, 'scale'),
  mode: args.mode,
  ...(Object.keys(camera).length ? { camera } : {}),
};
for (const key of Object.keys(options)) if (options[key] == null) delete options[key];

const browser = await chromium.launch({
  headless: true,
  ...(args.executable_path ? { executablePath: resolve(args.executable_path) } : {}),
});
try {
  const page = await browser.newPage();
  await page.addScriptTag({ path: resolve(VIEWER_ROOT, 'pose-kinematics.js') });
  await page.addScriptTag({ path: resolve(VIEWER_ROOT, 'pose-panel.js') });
  const dataUrl = await page.evaluate(({ sidecar: document, options: renderOptions }) => (
    globalThis.PosePanel.renderPNG(document, renderOptions)
  ), { sidecar, options });
  const encoded = dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!encoded) throw new Error('viewer did not return a PNG data URL');
  await writeFile(outputPath, Buffer.from(encoded[1], 'base64'), { flag: 'wx' });
  process.stdout.write(`${outputPath}\n`);
} finally {
  await browser.close();
}
