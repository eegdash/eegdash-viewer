// tests/unit-viewer-boot.test.mjs
//
// Exercises viewer.boot() through one round-trip: URL params → fetch
// metadata → INIT worker → LOAD_FILE → HEADER. Uses a stub Worker
// that responds to INIT + LOAD_FILE with canned HEADER messages, and
// stubs globalThis.fetch so the sidecar walker (`loadRecordingMetadata`)
// returns 404 for every sidecar instead of crashing on relative URLs
// that Node's fetch can't parse.
//
// Goal: reach the ~1300-LOC boot() function so Stryker mutations
// inside it become observable. Even a minimal exercise lifts mutation
// coverage from 0.63% baseline.
//
// Contract adjustments versus the task template:
// 1. viewer.js reads URL params from `globalThis.location.search`
//    (line 1637), not `window.location.search`. The JSDOM bootstrap
//    only sets `globalThis.window.location`, so we must assign
//    `globalThis.location = globalThis.window.location` (a live
//    reference) before calling boot().
// 2. The JSDOM bootstrap's `#shortcuts-overlay` and `#metadata-overlay`
//    divs lack the `.overlay-backdrop` / `.overlay-close` children
//    that `attachOverlayClose` (viewer.js:1076) calls
//    `addEventListener` on. We patch those children in before boot()
//    runs.
// 3. boot() ALWAYS constructs a Worker (viewer.js:401-511 guards on
//    `typeof Worker !== 'undefined'`, not on URL params). The
//    template's "worker may or may not be constructed" comment was
//    overcautious — with a Worker global present, boot constructs
//    one unconditionally and sends INIT as its first message.
// 4. The HttpRange stub from the template is unused because
//    `loadRecordingMetadata` calls `HttpRange.fetchTextOrNull`
//    which routes through `globalThis.fetch`. Stubbing fetch is
//    simpler and covers more paths.

import './_jsdom-bootstrap.mjs';
import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ── Setup: must run before viewer.js is loaded ──────────────────

// boot() reads URL params via `globalThis.location.search`. JSDOM
// puts location on `window` only; mirror it onto globalThis as a
// live reference so window.history.replaceState updates propagate.
globalThis.location = globalThis.window.location;

// Patch the overlay backdrop/close children so attachOverlayClose
// doesn't crash on missing querySelector targets.
for (const id of ['shortcuts-overlay', 'metadata-overlay']) {
  const el = globalThis.document.getElementById(id);
  if (el && !el.querySelector('.overlay-backdrop')) {
    const backdrop = globalThis.document.createElement('div');
    backdrop.className = 'overlay-backdrop';
    const close = globalThis.document.createElement('button');
    close.className = 'overlay-close';
    el.appendChild(backdrop);
    el.appendChild(close);
  }
}

// Stub fetch so the sidecar walker returns 404 for every sidecar
// URL instead of crashing on Node's "Invalid URL" for relative paths.
// loadRecordingMetadata treats 404 as "no sidecar" and continues.
globalThis.fetch = async () => new Response('', { status: 404, statusText: 'Not Found' });

// Stub Worker to capture posted messages and auto-respond to
// INIT + LOAD_FILE.
let workerInstance = null;

class StubWorker {
  constructor(src) {
    workerInstance = this;
    this.src = src;
    this.onmessage = null;
    this.onerror = null;
    this.sent = [];
  }
  postMessage(msg) {
    this.sent.push(msg);
    if (msg && msg.type === 'INIT') {
      queueMicrotask(() => this.onmessage && this.onmessage({
        data: { type: 'INIT_OK', formats: ['edf', 'bdf', 'set', 'vhdr', 'fif', 'fiff'] },
      }));
    }
    if (msg && msg.type === 'LOAD_FILE') {
      queueMicrotask(() => this.onmessage && this.onmessage({
        data: {
          type: 'HEADER',
          n_channels: 2,
          sampling_frequency: 250,
          duration_s: 10,
          channel_labels: ['Ch1', 'Ch2'],
          bytes_per_sample: 2,
          n_samples: 2500,
          recording_start_iso: null,
          annotation_events: null,
        },
      }));
    }
  }
  terminate() {}
}

globalThis.Worker = StubWorker;

// Some async paths inside load() may reject (e.g., when no sidecars
// are found and the format reader path is unreachable in tests).
// Boot itself is synchronous — those rejections happen after boot
// returns, so we swallow them here to keep node:test happy.
process.on('unhandledRejection', () => {});

// ── Load viewer.js + deps ──────────────────────────────────────

require('../formats/_buffers.js');
require('../formats/_http_range.js');
require('../formats/_streaming.js');
require('../formats/_sidecar.js');
require('../formats/_matv5.js');
require('../bids-recording.js');
require('../formats/eeglab.js');
require('../formats/edf.js');
require('../formats/brainvision.js');
require('../formats/fiff.js');
require('../traces.js');
require('../filters.js');
require('../viewer.js');

const Viewer = globalThis.window.Viewer;

// ── Tests ──────────────────────────────────────────────────────

test('viewer.boot: runs to completion with no URL params', () => {
  workerInstance = null;
  globalThis.window.history.replaceState({}, '', '/');
  assert.doesNotThrow(() => Viewer.boot({}));
  // boot() unconditionally constructs a Worker (line 401-511 guards
  // on `typeof Worker !== 'undefined'`, not on URL params), and INIT
  // is the first message regardless of whether a recording was loaded.
  assert.ok(workerInstance, 'boot must construct a Worker');
  assert.equal(workerInstance.sent[0].type, 'INIT',
    'first worker message must be INIT');
});

test('viewer.boot: with ?eeg= URL sends LOAD_FILE after INIT', async () => {
  workerInstance = null;
  // Same-origin relative URLs (start with /) are allowed per the SAST
  // P2 fix at bids-recording.js:786. resolveTargets accepts this
  // shape; load() then drives sidecar walking + LOAD_FILE.
  globalThis.window.history.replaceState({}, '', '/?eeg=/test-data/edfplus-with-annotations.edf');
  Viewer.boot({});
  // Yield to allow sidecar fetches (all 404 per the fetch stub) and
  // workerReadyPromise to settle before LOAD_FILE is sent.
  await new Promise(r => setTimeout(r, 100));
  assert.ok(workerInstance, 'boot must construct a Worker');
  assert.equal(workerInstance.sent[0].type, 'INIT',
    'first worker message must be INIT');
  // After INIT_OK + sidecar walk, boot sends LOAD_FILE. If the
  // sidecar walk failed before LOAD_FILE could be queued, the test
  // would observe sent.length === 1.
  const types = workerInstance.sent.map(m => m.type);
  assert.ok(types.includes('LOAD_FILE'),
    `expected LOAD_FILE in ${JSON.stringify(types)}`);
});

test('viewer.boot: does not throw on unknown URL param', () => {
  workerInstance = null;
  globalThis.window.history.replaceState({}, '', '/?someUnknownParam=42');
  assert.doesNotThrow(() => Viewer.boot({}));
  // Unknown params → resolveTargets returns null → boot finishes
  // without sending LOAD_FILE, but the Worker + INIT are still wired.
  assert.ok(workerInstance, 'Worker is constructed regardless of params');
  assert.equal(workerInstance.sent[0].type, 'INIT');
});
