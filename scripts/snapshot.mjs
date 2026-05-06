import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

// Standalone with data
await page.goto('http://localhost:8011/index.html?eeg=https%3A%2F%2Fs3.amazonaws.com%2Fopenneuro.org%2Fds002893%2Fsub-001%2Feeg%2Fsub-001_task-AuditoryVisualShift_run-01_eeg.set');
await page.waitForSelector('#stage-caption:not([hidden])', { timeout: 60000 });
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/viewer-shots/standalone.png', fullPage: false });

// Empty standalone (no data)
await page.goto('http://localhost:8011/index.html');
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/viewer-shots/empty.png', fullPage: false });

// Embed with data
await page.goto('http://localhost:8011/index.html?eeg=https%3A%2F%2Fs3.amazonaws.com%2Fopenneuro.org%2Fds002893%2Fsub-001%2Feeg%2Fsub-001_task-AuditoryVisualShift_run-01_eeg.set&embed=1');
await page.waitForSelector('#stage-caption:not([hidden])', { timeout: 60000 });
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/viewer-shots/embed.png', fullPage: false });

// Header crop standalone
await page.goto('http://localhost:8011/index.html?eeg=https%3A%2F%2Fs3.amazonaws.com%2Fopenneuro.org%2Fds002893%2Fsub-001%2Feeg%2Fsub-001_task-AuditoryVisualShift_run-01_eeg.set');
await page.waitForSelector('#stage-caption:not([hidden])', { timeout: 60000 });
const header = await page.locator('.header');
await header.screenshot({ path: '/tmp/viewer-shots/header-standalone.png' });

await browser.close();
console.log('done');
