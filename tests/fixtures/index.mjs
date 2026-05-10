/**
 * tests/fixtures/index.mjs
 *
 * Centralised fixture registry for e2e and integration tests.
 *
 * FIXTURE SCHEMA
 * Each entry describes one real recording that can be loaded in the viewer.
 *
 *   url_query   — query-string to append to index.html (starts with ?)
 *   label       — human-readable description used in test titles
 *   sub         — BIDS subject id (string, without "sub-" prefix)
 *   ses         — BIDS session id (optional, without "ses-" prefix)
 *   task        — BIDS task label
 *   run         — BIDS run index (optional)
 *   ext         — BIDS file extension (set | edf | bdf | vhdr)
 *   expect      — expected observable values after a successful load
 *     format    — the pill text that #pill-format should display (e.g. 'SET')
 *     n_channels — exact channel count the reader reports
 *     duration_s_min — minimum recording length in seconds (for duration pill)
 *
 * HOW TO ADD A FIXTURE
 *   1. Pick a unique camelCase key that describes dataset + format.
 *   2. Fill url_query using the ?dataset= query API the viewer already supports.
 *   3. Run the viewer manually once to confirm the pills + canvas all populate.
 *   4. Record the observed values in `expect`.
 *   5. Add the key to the FIXTURES export below.
 *
 * HOW TO USE IN A TEST
 *   import { FIXTURES } from '../fixtures/index.mjs';
 *   const f = FIXTURES.eeglab_split;
 *   await page.goto('/index.html' + f.url_query);
 *   await expect(page.locator('#pill-format')).toHaveText(f.expect.format);
 */

export const FIXTURES = {

  /**
   * EEGLAB split (.set + external .fdt)
   * Dataset ds002893 — Auditory-Visual Shift EEG
   * Source: OpenNeuro via cdn.eegdash.org
   */
  eeglab_split: {
    url_query: '?dataset=ds002893&sub=001&task=AuditoryVisualShift&run=01&ext=set',
    label: 'EEGLAB split .set+.fdt (ds002893 sub-001)',
    sub: '001',
    task: 'AuditoryVisualShift',
    run: '01',
    ext: 'set',
    expect: {
      format: 'SET',
      n_channels: 36,
      duration_s_min: 10,
    },
  },

  /**
   * EEGLAB inline (.set with embedded data, no separate .fdt)
   * Dataset nm000121 — NEMAR SSVEP, small (~1 MB), served via cdn.eegdash.org
   */
  eeglab_inline: {
    url_query: '?dataset=nm000121&sub=6&ses=0&task=ssvep&run=6&ext=set',
    label: 'EEGLAB inline .set (nm000121 sub-6 NEMAR)',
    sub: '6',
    ses: '0',
    task: 'ssvep',
    run: '6',
    ext: 'set',
    expect: {
      format: 'SET',
      n_channels: 32,
      duration_s_min: 5,
    },
  },

  /**
   * EDF — European Data Format
   * Dataset ds002034 — offline EEG session
   */
  edf: {
    url_query: '?dataset=ds002034&sub=01&ses=01&task=offline&run=01&ext=edf',
    label: 'EDF (ds002034 sub-01)',
    sub: '01',
    ses: '01',
    task: 'offline',
    run: '01',
    ext: 'edf',
    expect: {
      format: 'EDF',
      // channel count varies; we assert > 0 in tests
      n_channels: null,
      duration_s_min: 10,
    },
  },

  /**
   * BDF — BioSemi Data Format (24-bit EDF variant)
   * NEMAR dataset — served via cdn.eegdash.org CORS proxy
   */
  bdf: {
    url_query: '?dataset=nm004571&sub=005&ses=01&task=resting&ext=bdf',
    label: 'BDF NEMAR (nm004571 sub-005)',
    sub: '005',
    ses: '01',
    task: 'resting',
    ext: 'bdf',
    expect: {
      format: 'BDF',
      n_channels: null,
      duration_s_min: 10,
    },
  },

  /**
   * BrainVision (.vhdr + .eeg + .vmrk)
   * Dataset ds002336 — motor localiser
   */
  brainvision: {
    url_query: '?dataset=ds002336&sub=xp101&task=motorloc&ext=vhdr',
    label: 'BrainVision .vhdr+.eeg+.vmrk (ds002336 sub-xp101)',
    sub: 'xp101',
    task: 'motorloc',
    ext: 'vhdr',
    expect: {
      format: 'VHDR',
      n_channels: null,
      duration_s_min: 10,
    },
  },

  /**
   * NEMAR BDF — inline-resolved via data.eegdash.org API
   * The resolution path is entirely different from OpenNeuro:
   *   viewer detects nm-prefix → calls /api/eegdash/records → CDN Worker URL
   */
  nemar_bdf: {
    url_query: '?dataset=nm004571&sub=005&ses=01&task=resting&ext=bdf',
    label: 'NEMAR BDF via cdn worker (nm004571)',
    sub: '005',
    ses: '01',
    task: 'resting',
    ext: 'bdf',
    expect: {
      format: 'BDF',
      n_channels: null,
      duration_s_min: 10,
    },
  },

  /**
   * NEMAR SET — inline-data .set served via NEMAR API
   * Used in nemar-smoke.spec.mjs (kept as alias for registry completeness)
   */
  nemar_set: {
    url_query: '?dataset=nm000121&sub=6&ses=0&task=ssvep&run=6&ext=set',
    label: 'NEMAR inline .set (nm000121 sub-6)',
    sub: '6',
    ses: '0',
    task: 'ssvep',
    run: '6',
    ext: 'set',
    expect: {
      format: 'SET',
      n_channels: 32,
      duration_s_min: 5,
    },
  },
};

/**
 * Helper: build the full URL for a fixture when running against a local server.
 * @param {string} key — key from FIXTURES
 * @param {string} [base='http://localhost:8011'] — base URL
 * @returns {string}
 */
export function fixtureURL(key, base = 'http://localhost:8011') {
  const f = FIXTURES[key];
  if (!f) throw new Error(`Unknown fixture key: "${key}". Valid keys: ${Object.keys(FIXTURES).join(', ')}`);
  return base + '/index.html' + f.url_query;
}

/**
 * Helper: assert that the basic viewer pills match a fixture's expected values.
 * Caller must already have navigated to the fixture URL and waited for load.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} fx — a FIXTURES entry
 * @param {import('@playwright/test').Expect} expect — the Playwright expect function
 */
export async function assertFixturePills(page, fx, expect) {
  await expect(page.locator('#pill-format')).toHaveText(fx.expect.format);

  const channelText = await page.locator('#pill-channels').textContent();
  expect(channelText?.trim()).toMatch(/^\d+ ch$/);

  if (fx.expect.n_channels !== null) {
    expect(parseInt(channelText, 10)).toBe(fx.expect.n_channels);
  } else {
    expect(parseInt(channelText, 10)).toBeGreaterThan(0);
  }
}
