// Playwright config for the viewer's browser e2e suite. Uses
// Playwright's built-in webServer to spin up the static file server
// on the same port the developer-facing tab uses (8011), so manual
// browsing and CI runs share one URL convention.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.mjs$/,
  // Be tolerant of cold OpenNeuro S3 connections — first run pulls
  // ~125 MB; subsequent runs hit the browser cache.
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8011',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // Stand up a Python static file server so the viewer loads via
    // http:// (CORS for OpenNeuro fetches works; file:// would 0-origin).
    command: 'python3 -m http.server 8011',
    url: 'http://localhost:8011/index.html',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
