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
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Expose window.gc() to the page so the RAPID-5 memory-leak
        // gate can drive Joyee Cheung's tryGC retry pattern. V8's GC
        // is async + lazy; without explicit triggering, the heap-diff
        // signal is dominated by deferred GC noise, not real leaks.
        launchOptions: { args: ['--js-flags=--expose-gc'] },
      },
    },
  ],
  webServer: {
    // Use a Node static server with Range-request support — the EDF/BDF
    // range-fetch path needs RFC 7233 byte ranges for local fixtures
    // (Python's built-in http.server ≤ 3.12 silently ignores Range and
    // returns 200, which breaks HttpRange.rangeFetchSingle's byte-count
    // validation against the F09 EDF+ test fixture).
    command: 'node scripts/serve.mjs 8011',
    url: 'http://localhost:8011/index.html',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
