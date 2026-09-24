// Scratch config (untracked): drive the locally-installed Google Chrome when
// Playwright's own Chromium download is unavailable. Rendering differs from
// bundled Chromium, so visual-regression results here are NOT authoritative.
import base from './playwright.config.mjs';
export default {
  ...base,
  projects: [{
    name: 'chromium',
    use: { ...base.projects[0].use, channel: 'chrome' },
  }],
};
