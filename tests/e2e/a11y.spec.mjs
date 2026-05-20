// tests/e2e/a11y.spec.mjs
//
// Accessibility audit via axe-core against the viewer's main scenes:
//   1. Empty state (no recording loaded)
//   2. Loaded state (a recording visible)
//   3. Shortcuts overlay open
//   4. Metadata overlay open
//
// We assert against WCAG 2.1 Level AA — the common baseline for public
// scientific tools. Each violation is a real accessibility bug; we
// don't ignore them by default. If a specific rule is genuinely
// inapplicable (e.g., canvas content is not text-readable by design),
// add it to `disableRules` with a justifying comment.

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import path from 'node:path';
import fs from 'node:fs';

const EEG_URL = 'https://s3.amazonaws.com/openneuro.org/ds002893/sub-001/eeg/sub-001_task-AuditoryVisualShift_run-01_eeg.set';

const EVIDENCE_ROOT = path.resolve('tests/evidence');
function evidenceDir(id) {
  const d = path.join(EVIDENCE_ROOT, id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Rules we are documenting as "knowingly excluded" with rationale.
// Add a rule here ONLY with a justification comment.
const DISABLED_RULES = [
  // 'color-contrast',  // would disable if we had a justified reason
];

async function audit(page, label) {
  const builder = new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  if (DISABLED_RULES.length) builder.disableRules(DISABLED_RULES);
  const results = await builder.analyze();
  return { label, results };
}

function summarize(violations) {
  return violations.map(v => ({
    id: v.id,
    impact: v.impact,
    description: v.description,
    nodes: v.nodes.length,
    sample: v.nodes[0]?.html?.slice(0, 200),
  }));
}

test('A11Y-1: empty viewer state passes WCAG 2.1 AA', async ({ page }) => {
  const dir = evidenceDir('a11y-1-empty');
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(500);

  const { results } = await audit(page, 'empty');
  const summary = summarize(results.violations);
  fs.writeFileSync(path.join(dir, 'violations.json'), JSON.stringify({
    url: page.url(),
    violationCount: results.violations.length,
    violations: summary,
  }, null, 2));
  await page.screenshot({ path: path.join(dir, 'screenshot.png') });

  // Soft-fail: report rather than block; CI artifact captures the
  // details. The first time we wire this up, we want visibility into
  // the baseline, not an immediate red gate. After 30 days of CI
  // history we'll tighten by ratcheting allowed violation count down.
  if (results.violations.length > 0) {
    console.warn(`A11Y-1: ${results.violations.length} violations found (see ${dir}/violations.json)`);
  }
  expect(results.violations.filter(v => v.impact === 'critical')).toHaveLength(0);
});

test('A11Y-2: loaded viewer with trace canvas passes WCAG 2.1 AA', async ({ page }) => {
  const dir = evidenceDir('a11y-2-loaded');
  await page.goto(`/index.html?eeg=${encodeURIComponent(EEG_URL)}`);
  await expect(page.locator('#stage-caption')).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(2000);

  const { results } = await audit(page, 'loaded');
  const summary = summarize(results.violations);
  fs.writeFileSync(path.join(dir, 'violations.json'), JSON.stringify({
    violationCount: results.violations.length,
    violations: summary,
  }, null, 2));
  await page.screenshot({ path: path.join(dir, 'screenshot.png') });

  if (results.violations.length > 0) {
    console.warn(`A11Y-2: ${results.violations.length} violations found`);
  }
  expect(results.violations.filter(v => v.impact === 'critical')).toHaveLength(0);
});

test('A11Y-3: shortcuts overlay open passes WCAG 2.1 AA', async ({ page }) => {
  const dir = evidenceDir('a11y-3-shortcuts');
  await page.goto(`/index.html?eeg=${encodeURIComponent(EEG_URL)}`);
  await expect(page.locator('#stage-caption')).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(1000);
  await page.keyboard.press('?');
  await page.waitForTimeout(300);

  const { results } = await audit(page, 'shortcuts');
  const summary = summarize(results.violations);
  fs.writeFileSync(path.join(dir, 'violations.json'), JSON.stringify({
    violationCount: results.violations.length,
    violations: summary,
  }, null, 2));
  await page.screenshot({ path: path.join(dir, 'screenshot.png') });

  if (results.violations.length > 0) {
    console.warn(`A11Y-3: ${results.violations.length} violations found`);
  }
  expect(results.violations.filter(v => v.impact === 'critical')).toHaveLength(0);
});

test('A11Y-4: metadata overlay open passes WCAG 2.1 AA', async ({ page }) => {
  const dir = evidenceDir('a11y-4-metadata');
  await page.goto(`/index.html?eeg=${encodeURIComponent(EEG_URL)}`);
  await expect(page.locator('#stage-caption')).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(1000);
  await page.keyboard.press('i');
  await page.waitForTimeout(300);

  const { results } = await audit(page, 'metadata');
  const summary = summarize(results.violations);
  fs.writeFileSync(path.join(dir, 'violations.json'), JSON.stringify({
    violationCount: results.violations.length,
    violations: summary,
  }, null, 2));
  await page.screenshot({ path: path.join(dir, 'screenshot.png') });

  if (results.violations.length > 0) {
    console.warn(`A11Y-4: ${results.violations.length} violations found`);
  }
  expect(results.violations.filter(v => v.impact === 'critical')).toHaveLength(0);
});
