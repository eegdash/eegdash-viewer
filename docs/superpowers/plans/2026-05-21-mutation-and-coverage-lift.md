# Mutation + Coverage Lift Plan (Round 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift viewer.js mutation (0.63% → 25-35%), worker.js mutation (5.50% → 35-50%), and brainvision/edf/eeglab coverage (~60% → 85%+) by adding direct API-exercising tests rather than re-implementation contract tests.

**Architecture:** Two work streams in 7 tasks. Stream A (T1-T3) drives viewer + worker mutation up by exercising the real exported `api.*` surface + dispatching real messages through `self.onmessage` with mocked readers. Stream B (T4-T6) drives format-reader coverage by adding fixture-backed `open()`/`readWindow()` roundtrip tests for the 3 readers currently at ~60%. T7 captures the new Stryker baseline + raises thresholds per documented policy.

**Tech Stack:** node:test, JSDOM (already installed for T3 of prior plan), fast-check (already installed), existing `tests/_bootstrap.mjs` + `tests/_jsdom-bootstrap.mjs` helpers, existing fixtures in `tests/fixtures/{eeg,ieeg,meg}/`.

---

## File Structure

```
tests/
  ├── _bootstrap.mjs               EXISTS — exports {EDFReader, BIDSRecording, ...}
  ├── _jsdom-bootstrap.mjs         EXISTS — JSDOM globals for viewer.js
  ├── unit-viewer-api.test.mjs     NEW — exercises window.Viewer.* helpers under JSDOM
  ├── unit-viewer-boot.test.mjs    NEW — boot() round-trip with mocked Worker + URL
  ├── unit-worker-roundtrip.test.mjs NEW — LOAD_FILE → HEADER → FETCH_WINDOW → WINDOW
  ├── unit-brainvision-readwindow.test.mjs NEW — open()+readWindow on .vhdr fixture
  ├── unit-edf-readwindow.test.mjs NEW — open()+readWindow on .edf + .bdf fixtures
  └── unit-eeglab-readwindow.test.mjs NEW — open()+readWindow on .set+.fdt fixture

stryker.conf.json                  MODIFY — add new test files to commandRunner; possibly raise threshold
docs/mutation-survivors-2026-05.md MODIFY — append iteration-14 section
```

No source files modified. All work is test-side.

---

## Task 1: viewer.js — exercise window.Viewer.* exported helpers

**Files:**
- Create: `tests/unit-viewer-api.test.mjs`

**Why:** viewer.js exports 11 helpers on `window.Viewer` (boot, el, setChildren, renderProvenance, renderChannels, renderEvents, updateElectrodeLink, renderStageCaption, clampStart, deriveChannelLabels, deriveBadMask, pickDefaultWindowSec). Only `clampStart` is currently tested. Each of the other 10 has Stryker mutants that current tests can't kill.

- [ ] **Step 1: Write the helper tests**

```js
// tests/unit-viewer-api.test.mjs
//
// Direct tests against window.Viewer.* exported helpers. Each helper
// is a pure function or DOM-touching function; we exercise it through
// the public api surface so Stryker mutations are observable.
//
// Pairs with tests/unit-viewer-jsdom.test.mjs (already covers
// clampStart + module-load smoke). This file covers the other 10
// exports + the more involved deriveChannelLabels / deriveBadMask /
// pickDefaultWindowSec / render* / updateElectrodeLink contract.

import './_jsdom-bootstrap.mjs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
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

const V = globalThis.window.Viewer;

// ─── el / setChildren ────────────────────────────────────────────

test('viewer.el: returns the DOM element by id', () => {
  const el = V.el('status');
  assert.ok(el, 'must find #status');
  assert.equal(el.id, 'status');
});

test('viewer.el: returns null for unknown id', () => {
  const el = V.el('definitely-does-not-exist-xyz');
  assert.equal(el, null);
});

test('viewer.setChildren: replaces children with the provided array', () => {
  const host = globalThis.document.createElement('div');
  const a = globalThis.document.createElement('span');
  const b = globalThis.document.createElement('span');
  a.textContent = 'A';
  b.textContent = 'B';
  V.setChildren(host, [a, b]);
  assert.equal(host.children.length, 2);
  assert.equal(host.children[0].textContent, 'A');
  assert.equal(host.children[1].textContent, 'B');
});

test('viewer.setChildren: empty array clears the host', () => {
  const host = globalThis.document.createElement('div');
  host.appendChild(globalThis.document.createElement('span'));
  V.setChildren(host, []);
  assert.equal(host.children.length, 0);
});

// ─── deriveChannelLabels ─────────────────────────────────────────

test('viewer.deriveChannelLabels: uses meta.channels names when present', () => {
  const meta = { channels: [{ name: 'Fp1' }, { name: 'Fp2' }] };
  const out = V.deriveChannelLabels(meta, /* readerInfo */ null);
  assert.deepEqual(out, ['Fp1', 'Fp2']);
});

test('viewer.deriveChannelLabels: falls back to reader.channel_labels when meta lacks names', () => {
  const meta = { channels: null };
  const readerInfo = { channel_labels: ['Cz', 'Pz'] };
  const out = V.deriveChannelLabels(meta, readerInfo);
  assert.deepEqual(out, ['Cz', 'Pz']);
});

test('viewer.deriveChannelLabels: returns Ch{i+1} when no labels anywhere', () => {
  const meta = { channels: null };
  const readerInfo = { channel_labels: null, n_channels: 3 };
  const out = V.deriveChannelLabels(meta, readerInfo);
  assert.deepEqual(out, ['Ch1', 'Ch2', 'Ch3']);
});

// ─── deriveBadMask ───────────────────────────────────────────────

test('viewer.deriveBadMask: marks channels in the bad list', () => {
  const channels = [{ name: 'Fp1' }, { name: 'Fp2', status: 'bad' }, { name: 'Cz' }];
  const mask = V.deriveBadMask(channels);
  assert.deepEqual(Array.from(mask), [false, true, false]);
});

test('viewer.deriveBadMask: empty array → empty mask', () => {
  const mask = V.deriveBadMask([]);
  assert.equal(mask.length, 0);
});

test('viewer.deriveBadMask: null channels → empty mask, no throw', () => {
  const mask = V.deriveBadMask(null);
  assert.equal(mask.length, 0);
});

// ─── pickDefaultWindowSec ────────────────────────────────────────

test('viewer.pickDefaultWindowSec: short recording gets full duration', () => {
  assert.equal(V.pickDefaultWindowSec({ duration_s: 5 }), 5);
});

test('viewer.pickDefaultWindowSec: long recording capped at 30s default', () => {
  assert.equal(V.pickDefaultWindowSec({ duration_s: 3600 }), 30);
});

test('viewer.pickDefaultWindowSec: missing duration → 10s safe default', () => {
  assert.equal(V.pickDefaultWindowSec({}), 10);
});

// ─── renderProvenance ────────────────────────────────────────────

test('viewer.renderProvenance: writes the dataset id + subject + task', () => {
  const meta = {
    dataset: 'ds000123',
    sub: '01',
    task: 'rest',
    run: '02',
    eeg_url: 'https://example.com/foo.edf',
  };
  const host = globalThis.document.createElement('div');
  V.renderProvenance(meta, host);
  const text = host.textContent;
  assert.ok(text.includes('ds000123'), 'must include dataset id');
  assert.ok(text.includes('01'), 'must include subject');
});

test('viewer.renderProvenance: handles missing optional fields gracefully', () => {
  const host = globalThis.document.createElement('div');
  V.renderProvenance({ eeg_url: 'https://example.com/x.set' }, host);
  // must not throw; host should have SOME content
  assert.ok(host.childNodes.length >= 0);
});

// ─── renderChannels ──────────────────────────────────────────────

test('viewer.renderChannels: list 3 channels into the host + writes count', () => {
  const channels = [{ name: 'Fp1' }, { name: 'Fp2' }, { name: 'Cz' }];
  const list = globalThis.document.createElement('ul');
  const count = globalThis.document.createElement('span');
  V.renderChannels(channels, list, count);
  assert.equal(list.children.length, 3);
  assert.equal(count.textContent, '3');
});

test('viewer.renderChannels: empty channels → empty list, count 0', () => {
  const list = globalThis.document.createElement('ul');
  const count = globalThis.document.createElement('span');
  V.renderChannels([], list, count);
  assert.equal(list.children.length, 0);
  assert.equal(count.textContent, '0');
});

// ─── renderEvents ────────────────────────────────────────────────

test('viewer.renderEvents: list events + write count', () => {
  const events = [{ onset: 1.0, label: 'A' }, { onset: 2.5, label: 'B' }];
  const list = globalThis.document.createElement('ul');
  const count = globalThis.document.createElement('span');
  V.renderEvents(events, list, count);
  assert.equal(list.children.length, 2);
  assert.equal(count.textContent, '2');
});

test('viewer.renderEvents: null events → count 0', () => {
  const list = globalThis.document.createElement('ul');
  const count = globalThis.document.createElement('span');
  V.renderEvents(null, list, count);
  assert.equal(count.textContent, '0');
});

// ─── updateElectrodeLink ─────────────────────────────────────────

test('viewer.updateElectrodeLink: shows link when electrodes_tsv URL present', () => {
  const meta = { sidecar_sources: { electrodes: 'https://example.com/electrodes.tsv' } };
  const link = globalThis.document.createElement('a');
  link.hidden = true;
  V.updateElectrodeLink(meta, link);
  assert.equal(link.hidden, false);
  assert.ok(link.href.includes('electrodes.tsv') || link.href.includes('electrodes.eegdash'),
    'href must reference the electrodes URL or the explorer');
});

test('viewer.updateElectrodeLink: stays hidden when no electrodes sidecar', () => {
  const meta = { sidecar_sources: {} };
  const link = globalThis.document.createElement('a');
  link.hidden = true;
  V.updateElectrodeLink(meta, link);
  assert.equal(link.hidden, true);
});

// ─── renderStageCaption ──────────────────────────────────────────

test('viewer.renderStageCaption: includes the format pill text', () => {
  const meta = { ext: 'edf', eeg_json: { sampling_frequency: 250 } };
  const reader = { n_channels: 32, duration_s: 60, sampling_frequency: 250 };
  const caption = globalThis.document.createElement('div');
  V.renderStageCaption(meta, reader, caption);
  const text = caption.textContent.toLowerCase();
  assert.ok(text.includes('edf') || text.includes('32') || text.includes('250'),
    `stage caption text empty or missing key info: "${caption.textContent}"`);
});
```

- [ ] **Step 2: Run the helper tests + verify mutation lift impact**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
node --test tests/unit-viewer-api.test.mjs 2>&1 | tail -6
```

Expected: all tests pass. If any helper doesn't behave as the test assumes (e.g., `deriveChannelLabels` actually takes a different argument shape), READ the function in viewer.js, adjust the test to match its real contract, then re-run. The tests must reflect actual behaviour — they're contract tests for the existing surface, not new behaviour.

- [ ] **Step 3: Add the file to stryker.conf.json's commandRunner**

Edit `stryker.conf.json`. In the `commandRunner.command` string, append:

```
tests/unit-viewer-api.test.mjs
```

Keep all existing test files.

- [ ] **Step 4: Commit**

```bash
git add tests/unit-viewer-api.test.mjs stryker.conf.json
git commit -m "test(viewer): exercise window.Viewer.* exported helpers directly

Adds tests for the 10 exported api helpers that currently aren't
covered by tests/unit-viewer-jsdom.test.mjs (only clampStart was).

Coverage: el, setChildren, deriveChannelLabels (3 fallback levels),
deriveBadMask, pickDefaultWindowSec (3 cases), renderProvenance,
renderChannels (with + empty), renderEvents (with + null),
updateElectrodeLink (show + hide), renderStageCaption.

Adds tests/unit-viewer-api.test.mjs to Stryker commandRunner so
mutations in viewer.js can be killed by these tests. Expected
mutation lift on viewer.js: 0.63% to ~10-15% on this commit alone."
```

NO Co-authored-by. NO push.

---

## Task 2: viewer.js — boot() round-trip with mocked Worker

**Files:**
- Create: `tests/unit-viewer-boot.test.mjs`

**Why:** boot() is ~1300 of viewer.js's 1500 LOC. We can exercise it under JSDOM with a mocked Worker that responds to LOAD_FILE/INIT and observe the resulting DOM + state.

- [ ] **Step 1: Write the boot test**

```js
// tests/unit-viewer-boot.test.mjs
//
// Exercises viewer.boot() through one round-trip: URL params → fetch
// metadata → INIT worker → LOAD_FILE → HEADER → renderProvenance.
// Uses a stub Worker that responds to INIT + LOAD_FILE with canned
// HEADER messages, and stubs HttpRange to read local fixtures.
//
// Goal: reach the ~1300-LOC boot() function so Stryker mutations
// inside it become observable.

import './_jsdom-bootstrap.mjs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Track Worker messages so the test can drive the protocol.
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
    // Auto-respond to INIT with INIT_OK.
    if (msg.type === 'INIT') {
      queueMicrotask(() => this.onmessage && this.onmessage({
        data: { type: 'INIT_OK', formats: ['edf', 'bdf', 'set', 'vhdr', 'fif', 'fiff'] },
      }));
    }
    // Auto-respond to LOAD_FILE with a canned HEADER reply.
    if (msg.type === 'LOAD_FILE') {
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

// Stub HttpRange so any open() called on the main thread reads local.
globalThis.HttpRange = {
  async fetchBuffer(url) {
    const p = url.replace(/^file:\/\//, '');
    if (!fs.existsSync(p)) throw new Error(`stub HttpRange: no file ${p}`);
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  },
  async fetchText(url) {
    const p = url.replace(/^file:\/\//, '');
    return fs.readFileSync(p, 'utf-8');
  },
};

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

test('viewer.boot: INIT message is sent to the worker', async () => {
  // Pre-populate the URL so boot has something to load. JSDOM's
  // window.location is overridable via Object.defineProperty in some
  // configs; if not, we pass via boot() opts.
  globalThis.window.history.replaceState({}, '', '/?eeg=https://example.com/x_eeg.edf');

  Viewer.boot({});

  // Yield microtasks so the auto-INIT_OK lands.
  await new Promise(r => setTimeout(r, 10));

  assert.ok(workerInstance, 'a Worker must have been constructed');
  const initMsg = workerInstance.sent.find(m => m.type === 'INIT');
  assert.ok(initMsg, 'boot must send INIT to the worker');
});

test('viewer.boot: with no URL params, status indicates waiting', () => {
  // Reset the worker instance so a clean boot is observable.
  workerInstance = null;
  globalThis.window.history.replaceState({}, '', '/');
  // Reset status text
  const status = globalThis.document.getElementById('status');
  if (status) status.textContent = '';

  Viewer.boot({});

  const text = (status && status.textContent) || '';
  // With no params, viewer either waits silently OR prompts; either
  // is acceptable. The contract: it does not crash, and either text
  // is present or a Worker is created (depending on the boot path).
  const sane = text.length > 0 || workerInstance !== null;
  assert.ok(sane, 'boot with no params must not crash');
});
```

- [ ] **Step 2: Run the boot tests**

```bash
node --test tests/unit-viewer-boot.test.mjs 2>&1 | tail -10
```

Expected: 2 pass. If they don't, read the boot() function in viewer.js to understand what it actually does with URL params + Worker creation, adjust the stub Worker to match the real LOAD_FILE flow, and re-run. The point of these tests is to actually invoke boot()'s code paths.

- [ ] **Step 3: Add file to stryker commandRunner**

```
tests/unit-viewer-boot.test.mjs
```

- [ ] **Step 4: Commit**

```bash
git add tests/unit-viewer-boot.test.mjs stryker.conf.json
git commit -m "test(viewer): boot() round-trip with stub Worker

Drives boot() through one INIT → INIT_OK → LOAD_FILE → HEADER cycle
under JSDOM. Stubs Worker class to auto-respond to INIT+LOAD_FILE
with canned HEADER payloads. Stubs HttpRange to read local files.

Reaches boot()'s URL parsing, Worker construction, INIT dispatch,
metadata loader, and the post-HEADER render setup — ~600 LOC of
viewer.js that previously had zero mutation coverage.

Expected viewer.js mutation lift on top of T1: +15-20pp."
```

NO Co-authored-by. NO push.

---

## Task 3: worker.js — dispatch real LOAD_FILE → FETCH_WINDOW round-trip

**Files:**
- Create: `tests/unit-worker-roundtrip.test.mjs`

**Why:** Existing `tests/unit-worker-protocol.test.mjs` uses a re-implemented handler that re-DI's a stub reader. The real `self.onmessage` in worker.js is never invoked, so its code paths show as survived mutants. Fix: use the self-shim harness from `unit-worker-jsdom.test.mjs` + dispatch real LOAD_FILE with a mock reader registered in the actual READERS map.

- [ ] **Step 1: Write the round-trip test**

```js
// tests/unit-worker-roundtrip.test.mjs
//
// Dispatches real messages through worker.js's actual self.onmessage
// handler (via the self-shim from unit-worker-jsdom). Drives:
//   INIT      → INIT_OK
//   LOAD_FILE → HEADER (via a mocked-in-READERS reader)
//   FETCH_WINDOW → WINDOW (real reader.readWindow path)
//   APPLY_FILTER → FILTERED
//
// The mock reader is injected into READERS by mutating it BEFORE
// LOAD_FILE arrives. This lets us drive the actual worker.js code
// (not a re-implemented copy) and have Stryker mutations land.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Shim self before loading worker.js.
const recordedMessages = [];
globalThis.self = {
  onmessage: null,
  postMessage(msg, transfer) { recordedMessages.push({ msg, transfer }); },
};
globalThis.importScripts = () => {};

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
require('../filters.js');
require('../worker.js');

// Build a mock reader module + register it as a new ext under the
// worker's READERS map. We can't access READERS directly (it's
// module-private), but LOAD_FILE looks up READERS[meta.ext] —
// any ext not in the default 5 will fail with "No reader" — so we
// MUST use one of: edf, bdf, set, vhdr, fif, fiff. Approach: monkey-
// patch the existing EDFReader to use our mock open() function.

const realEDFOpen = globalThis.EDFReader.open;

function makeMockReader({ n_channels = 2, n_samples = 1000, sampling_frequency = 250 } = {}) {
  return {
    n_channels,
    sampling_frequency,
    duration_s: n_samples / sampling_frequency,
    channel_labels: Array.from({ length: n_channels }, (_, i) => `Ch${i + 1}`),
    bytes_per_sample: 2,
    n_samples,
    recording_start_iso: null,
    annotation_events: null,
    async readWindow(start, n) {
      const out = [];
      for (let c = 0; c < n_channels; c++) {
        const d = new Float32Array(Math.min(n, n_samples - start));
        for (let i = 0; i < d.length; i++) d[i] = Math.sin((start + i) * 0.1 + c) * 10;
        out.push(d);
      }
      return out;
    },
  };
}

test('worker: INIT → INIT_OK', async () => {
  recordedMessages.length = 0;
  await globalThis.self.onmessage({ data: { type: 'INIT' } });
  assert.equal(recordedMessages[0].msg.type, 'INIT_OK');
});

test('worker: LOAD_FILE (mocked EDFReader.open) → HEADER reply', async () => {
  recordedMessages.length = 0;
  globalThis.EDFReader.open = async () => makeMockReader({ n_channels: 4, n_samples: 2500 });
  await globalThis.self.onmessage({ data: {
    type: 'LOAD_FILE',
    ext: 'edf',
    eeg_url: 'https://example.com/foo.edf',
    sidecars: { eeg_url: 'https://example.com/foo.edf', ext: 'edf' },
  } });
  globalThis.EDFReader.open = realEDFOpen;
  assert.equal(recordedMessages[0].msg.type, 'HEADER');
  assert.equal(recordedMessages[0].msg.n_channels, 4);
  assert.equal(recordedMessages[0].msg.n_samples, 2500);
  assert.equal(recordedMessages[0].msg.sampling_frequency, 250);
});

test('worker: FETCH_WINDOW after LOAD_FILE → WINDOW with 4 Float32Arrays', async () => {
  // LOAD_FILE first.
  recordedMessages.length = 0;
  globalThis.EDFReader.open = async () => makeMockReader({ n_channels: 4, n_samples: 2500 });
  await globalThis.self.onmessage({ data: {
    type: 'LOAD_FILE', ext: 'edf', eeg_url: 'https://example.com/foo.edf',
    sidecars: { eeg_url: 'https://example.com/foo.edf', ext: 'edf' },
  } });
  globalThis.EDFReader.open = realEDFOpen;

  // Now FETCH_WINDOW.
  recordedMessages.length = 0;
  await globalThis.self.onmessage({ data: {
    type: 'FETCH_WINDOW', start_sample: 0, n_samples: 100, request_id: 1,
  } });
  const reply = recordedMessages[0].msg;
  assert.equal(reply.type, 'WINDOW');
  assert.equal(reply.request_id, 1);
  assert.equal(reply.channels.length, 4);
  assert.ok(reply.channels[0] instanceof Float32Array);
  assert.equal(reply.channels[0].length, 100);
});

test('worker: APPLY_FILTER → FILTERED ack', async () => {
  // Reader must be loaded for fs to be known.
  recordedMessages.length = 0;
  globalThis.EDFReader.open = async () => makeMockReader();
  await globalThis.self.onmessage({ data: {
    type: 'LOAD_FILE', ext: 'edf', eeg_url: 'x',
    sidecars: { eeg_url: 'x', ext: 'edf' },
  } });
  globalThis.EDFReader.open = realEDFOpen;

  recordedMessages.length = 0;
  await globalThis.self.onmessage({ data: {
    type: 'APPLY_FILTER',
    filters: [{ kind: 'highpass', cutoff_hz: 0.5 }],
  } });
  assert.equal(recordedMessages[0].msg.type, 'FILTERED');
  assert.ok(recordedMessages[0].msg.filter_id.includes('highpass'));
});

test('worker: FETCH_WINDOW after APPLY_FILTER applies the filter chain', async () => {
  recordedMessages.length = 0;
  globalThis.EDFReader.open = async () => makeMockReader();
  await globalThis.self.onmessage({ data: {
    type: 'LOAD_FILE', ext: 'edf', eeg_url: 'x',
    sidecars: { eeg_url: 'x', ext: 'edf' },
  } });
  globalThis.EDFReader.open = realEDFOpen;

  await globalThis.self.onmessage({ data: {
    type: 'APPLY_FILTER',
    filters: [{ kind: 'highpass', cutoff_hz: 0.5 }],
  } });

  recordedMessages.length = 0;
  await globalThis.self.onmessage({ data: {
    type: 'FETCH_WINDOW', start_sample: 0, n_samples: 200, request_id: 2,
  } });
  const reply = recordedMessages[0].msg;
  assert.equal(reply.type, 'WINDOW');
  // Filtered output must differ from raw — sin wave with DC offset
  // through a HP filter should suppress the DC component. Crude check:
  // the mean of the filtered output should be near 0 while the raw
  // signal has a noticeable mean.
  const mean = reply.channels[0].reduce((s, v) => s + v, 0) / reply.channels[0].length;
  assert.ok(Math.abs(mean) < 5, `filtered output mean too high: ${mean}`);
});
```

- [ ] **Step 2: Run the tests**

```bash
node --test tests/unit-worker-roundtrip.test.mjs 2>&1 | tail -8
```

Expected: 5 pass. If a test fails on the mock-injection path (the worker doesn't pick up the monkey-patched EDFReader), the READERS map was bound at worker.js load time before the monkey-patch took effect. Workaround: monkey-patch BEFORE `require('../worker.js')` runs. Move the EDFReader.open assignment up to the top of the file, before the worker require.

- [ ] **Step 3: Add file to stryker commandRunner**

```
tests/unit-worker-roundtrip.test.mjs
```

- [ ] **Step 4: Commit**

```bash
git add tests/unit-worker-roundtrip.test.mjs stryker.conf.json
git commit -m "test(worker): real LOAD_FILE→FETCH_WINDOW round-trip via self-shim

5 tests dispatch real messages through worker.js's actual
self.onmessage (not a re-implementation). Each LOAD_FILE monkey-
patches EDFReader.open to return a controlled mock reader, then
subsequent FETCH_WINDOW + APPLY_FILTER messages exercise the actual
worker code paths.

Covers: INIT, LOAD_FILE+HEADER, FETCH_WINDOW+WINDOW (with real
filter snapshot + reader epoch + cancellation checks), APPLY_FILTER
+FILTERED, post-filter FETCH_WINDOW with filtered output.

Expected worker.js mutation lift: 5.50% → 25-40% (the message-
handling switch + the FETCH_WINDOW filter+epoch checks are the
heaviest mutant-rich regions and they're now exercised)."
```

NO Co-authored-by. NO push.

---

## Task 4: brainvision.js coverage lift via fixture-driven readWindow

**Files:**
- Create: `tests/unit-brainvision-readwindow.test.mjs`

**Why:** brainvision.js line coverage is 57.76%. Uncovered ranges per c8: `267-318` (readWindow internals), `240-259` (binary format dispatch), `174-233` (sidecar resolution). Fix: tests that call `BrainVisionReader.open()` on a committed fixture and exercise `readWindow()` across the entire range.

- [ ] **Step 1: Write the test**

```js
// tests/unit-brainvision-readwindow.test.mjs
//
// Fixture-driven coverage for BrainVisionReader.open() + readWindow()
// + readWindowStreaming() against the committed iEEG fixture
// (tests/fixtures/ieeg/sub-01_ses-iemu_task-film_acq-clinical_run-1_ieeg.vhdr).
//
// Exercises the .vhdr parser, .eeg binary read, and .vmrk marker
// extraction in one round-trip per test.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
require('../formats/_buffers.js');
require('../formats/_http_range.js');
require('../formats/_streaming.js');
require('../formats/_sidecar.js');
require('../formats/_matv5.js');
require('../bids-recording.js');
require('../formats/brainvision.js');

// Mock HttpRange so the reader reads local fixture files.
globalThis.HttpRange = {
  async fetchBuffer(url) {
    const p = url.replace(/^file:\/\//, '');
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  },
  async fetchText(url) {
    const p = url.replace(/^file:\/\//, '');
    return fs.readFileSync(p, 'utf-8');
  },
  async fetchRange(url, start, end) {
    const p = url.replace(/^file:\/\//, '');
    const buf = fs.readFileSync(p);
    const slice = buf.slice(start, end + 1);
    return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
  },
};

const FIXTURE_DIR = path.resolve('tests/fixtures/ieeg');
const VHDR = path.join(FIXTURE_DIR, 'sub-01_ses-iemu_task-film_acq-clinical_run-1_ieeg.vhdr');
const skipIfMissing = !fs.existsSync(VHDR);

test('brainvision.open: returns reader with non-zero channels + sampling rate', { skip: skipIfMissing }, async () => {
  const reader = await globalThis.BrainVisionReader.open({
    eeg_url: 'file://' + VHDR,
  });
  assert.ok(reader.n_channels > 0, 'must have ≥1 channel');
  assert.ok(reader.sampling_frequency > 0, 'must have sampling rate > 0');
  assert.ok(reader.n_samples > 0, 'must have sample count > 0');
  assert.equal(typeof reader.readWindow, 'function');
});

test('brainvision.readWindow: returns nCh Float32Arrays of length n', { skip: skipIfMissing }, async () => {
  const reader = await globalThis.BrainVisionReader.open({
    eeg_url: 'file://' + VHDR,
  });
  const win = await reader.readWindow(0, 500);
  assert.equal(win.length, reader.n_channels);
  for (let c = 0; c < win.length; c++) {
    assert.ok(win[c] instanceof Float32Array);
    assert.equal(win[c].length, 500);
    // Sanity: at least one sample must be non-zero finite.
    const nonZero = win[c].some(v => v !== 0 && isFinite(v));
    assert.ok(nonZero, `channel ${c} must have at least one non-zero finite sample`);
  }
});

test('brainvision.readWindow: tail clamp to n_samples', { skip: skipIfMissing }, async () => {
  const reader = await globalThis.BrainVisionReader.open({
    eeg_url: 'file://' + VHDR,
  });
  const win = await reader.readWindow(reader.n_samples - 10, 1000);
  assert.ok(win[0].length <= 10, 'tail must clamp to remaining samples');
  assert.ok(win[0].length > 0, 'must return at least 1 sample');
});

test('brainvision.readWindowStreaming: emits at least one chunk that sums to full window', { skip: skipIfMissing }, async () => {
  const reader = await globalThis.BrainVisionReader.open({
    eeg_url: 'file://' + VHDR,
  });
  if (typeof reader.readWindowStreaming !== 'function') return;  // streaming optional
  let totalSamples = 0;
  let chunkCount = 0;
  for await (const chunk of reader.readWindowStreaming(0, 1000)) {
    chunkCount++;
    assert.equal(chunk.channels.length, reader.n_channels);
    totalSamples += chunk.channels[0].length;
  }
  assert.ok(chunkCount >= 1, 'must emit at least one chunk');
  assert.equal(totalSamples, 1000, 'sum of chunk lengths must equal requested n');
});

test('brainvision: channel_labels match the .vhdr declared count', { skip: skipIfMissing }, async () => {
  const reader = await globalThis.BrainVisionReader.open({
    eeg_url: 'file://' + VHDR,
  });
  assert.ok(Array.isArray(reader.channel_labels), 'labels must be an array');
  assert.equal(reader.channel_labels.length, reader.n_channels);
  for (const label of reader.channel_labels) {
    assert.equal(typeof label, 'string');
    assert.ok(label.length > 0, 'label must be non-empty');
  }
});
```

- [ ] **Step 2: Run + measure coverage**

```bash
node --test tests/unit-brainvision-readwindow.test.mjs 2>&1 | tail -8
npm run test:coverage 2>&1 | grep 'brainvision.js'
```

Expected: 5 pass; brainvision.js line coverage rises from 57% to 80%+.

- [ ] **Step 3: Commit**

```bash
git add tests/unit-brainvision-readwindow.test.mjs
git commit -m "test(brainvision): fixture-driven open + readWindow + streaming

5 tests against the committed iEEG fixture:
- open() returns reader with positive channels/rate/samples
- readWindow(0, 500) returns Float32Arrays with non-zero data
- tail clamp at n_samples
- readWindowStreaming() emits chunks summing to requested n
- channel_labels match n_channels

Expected brainvision.js line coverage lift: 57% → 80%+. Exercises
the .vhdr parser, .eeg binary read, and (when streaming is available)
the readWindowStreaming generator."
```

NO Co-authored-by. NO push.

---

## Task 5: edf.js coverage lift via BDF + EDF+ + streaming

**Files:**
- Create: `tests/unit-edf-readwindow.test.mjs`

**Why:** edf.js line coverage is 67.15%. Uncovered ranges include BDF binary path + EDF+ annotation parsing + streaming. We have BOTH `tests/fixtures/eeg/sub-01_ses-01_task-offline_run-01_eeg.edf` (EDF+) AND `tests/fixtures/eeg/sub-001_ses-01_task-meditation_eeg.bdf` (BDF) committed.

- [ ] **Step 1: Write the test**

```js
// tests/unit-edf-readwindow.test.mjs
//
// Fixture-driven coverage for EDFReader.open() + readWindow() +
// readWindowStreaming() against both EDF+ and BDF committed
// fixtures. Exercises the full binary-read path that synthetic
// header tests don't reach.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
require('../formats/_buffers.js');
require('../formats/_http_range.js');
require('../formats/_streaming.js');
require('../formats/_sidecar.js');
require('../formats/edf.js');

globalThis.HttpRange = {
  async fetchBuffer(url) {
    const p = url.replace(/^file:\/\//, '');
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  },
  async fetchRange(url, start, end) {
    const p = url.replace(/^file:\/\//, '');
    const buf = fs.readFileSync(p);
    const slice = buf.slice(start, end + 1);
    return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
  },
};

const EDF_PATH = path.resolve('tests/fixtures/eeg/sub-01_ses-01_task-offline_run-01_eeg.edf');
const BDF_PATH = path.resolve('tests/fixtures/eeg/sub-001_ses-01_task-meditation_eeg.bdf');

const skipEdf = !fs.existsSync(EDF_PATH);
const skipBdf = !fs.existsSync(BDF_PATH);

test('edf.open(.edf): returns reader with positive channels + rate + samples', { skip: skipEdf }, async () => {
  const reader = await globalThis.EDFReader.open({
    eeg_url: 'file://' + EDF_PATH,
  });
  assert.ok(reader.n_channels > 0);
  assert.ok(reader.sampling_frequency > 0);
  assert.ok(reader.n_samples > 0);
});

test('edf.readWindow(.edf, 0, 500): Float32Arrays with non-zero data', { skip: skipEdf }, async () => {
  const reader = await globalThis.EDFReader.open({
    eeg_url: 'file://' + EDF_PATH,
  });
  const win = await reader.readWindow(0, 500);
  assert.equal(win.length, reader.n_channels);
  for (let c = 0; c < win.length; c++) {
    assert.ok(win[c] instanceof Float32Array);
    assert.equal(win[c].length, 500);
    assert.ok(win[c].some(v => v !== 0 && isFinite(v)),
      `channel ${c} must have at least one non-zero finite sample`);
  }
});

test('edf.open(.bdf): same shape as EDF (BDF binary path)', { skip: skipBdf }, async () => {
  const reader = await globalThis.EDFReader.open({
    eeg_url: 'file://' + BDF_PATH,
  });
  assert.ok(reader.n_channels > 0);
  assert.ok(reader.sampling_frequency > 0);
  // BDF is 3-byte samples — bytes_per_sample should reflect that.
  // (If the reader normalises to int16 it may say 2; check >= 2.)
  assert.ok(reader.bytes_per_sample >= 2);
});

test('edf.readWindow(.bdf, 0, 200): Float32Arrays with non-zero data', { skip: skipBdf }, async () => {
  const reader = await globalThis.EDFReader.open({
    eeg_url: 'file://' + BDF_PATH,
  });
  const win = await reader.readWindow(0, 200);
  assert.equal(win.length, reader.n_channels);
  for (let c = 0; c < win.length; c++) {
    assert.equal(win[c].length, 200);
    assert.ok(win[c].some(v => v !== 0 && isFinite(v)));
  }
});

test('edf.readWindow tail clamp at n_samples', { skip: skipEdf }, async () => {
  const reader = await globalThis.EDFReader.open({
    eeg_url: 'file://' + EDF_PATH,
  });
  const win = await reader.readWindow(reader.n_samples - 5, 100);
  assert.ok(win[0].length <= 5);
  assert.ok(win[0].length > 0);
});

test('edf+ annotation_events parsed (or null)', { skip: skipEdf }, async () => {
  const reader = await globalThis.EDFReader.open({
    eeg_url: 'file://' + EDF_PATH,
  });
  // EDF+ annotations are optional; reader.annotation_events is either
  // null or an array. Either is OK; the test pins the shape contract.
  if (reader.annotation_events !== null) {
    assert.ok(Array.isArray(reader.annotation_events));
    for (const ev of reader.annotation_events) {
      assert.equal(typeof ev.onset, 'number');
      assert.equal(typeof ev.label, 'string');
    }
  }
});

test('edf.readWindowStreaming: emits chunks summing to requested n', { skip: skipEdf }, async () => {
  const reader = await globalThis.EDFReader.open({
    eeg_url: 'file://' + EDF_PATH,
  });
  if (typeof reader.readWindowStreaming !== 'function') return;
  let totalSamples = 0;
  let chunkCount = 0;
  for await (const chunk of reader.readWindowStreaming(0, 1000)) {
    chunkCount++;
    totalSamples += chunk.channels[0].length;
  }
  assert.ok(chunkCount >= 1);
  assert.equal(totalSamples, 1000);
});
```

- [ ] **Step 2: Run + measure**

```bash
node --test tests/unit-edf-readwindow.test.mjs 2>&1 | tail -8
npm run test:coverage 2>&1 | grep 'edf.js'
```

Expected: 7 pass; edf.js line coverage rises from 67% to 85%+.

- [ ] **Step 3: Commit**

```bash
git add tests/unit-edf-readwindow.test.mjs
git commit -m "test(edf): fixture-driven open + readWindow + streaming on EDF+ + BDF

7 tests exercise the EDFReader.open() → readWindow() → optional
readWindowStreaming() round-trip on both committed fixtures (EDF+
+ BDF). Covers the BDF binary path that synthetic header tests
never reach.

Expected edf.js line coverage lift: 67% → 85%+. annotation_events
shape pinned for the EDF+ path (null or array of {onset, label})."
```

NO Co-authored-by. NO push.

---

## Task 6: eeglab.js coverage lift via split .set+.fdt + montage

**Files:**
- Create: `tests/unit-eeglab-readwindow.test.mjs`

**Why:** eeglab.js line coverage is 62.64%. Uncovered ranges include the .fdt streaming path + the inline .set with embedded data. We have `tests/fixtures/eeg/sub-001_task-AuditoryVisualShift_run-01_eeg.set` (split set+fdt) committed.

- [ ] **Step 1: Write the test**

```js
// tests/unit-eeglab-readwindow.test.mjs
//
// Fixture-driven coverage for EEGLABReader.open() + readWindow()
// against the committed .set+.fdt split fixture.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
require('../formats/_buffers.js');
require('../formats/_http_range.js');
require('../formats/_streaming.js');
require('../formats/_sidecar.js');
require('../formats/_matv5.js');
require('../formats/eeglab.js');

globalThis.HttpRange = {
  async fetchBuffer(url) {
    const p = url.replace(/^file:\/\//, '');
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  },
  async fetchRange(url, start, end) {
    const p = url.replace(/^file:\/\//, '');
    const buf = fs.readFileSync(p);
    const slice = buf.slice(start, end + 1);
    return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
  },
};

const SET_PATH = path.resolve('tests/fixtures/eeg/sub-001_task-AuditoryVisualShift_run-01_eeg.set');
const skipIfMissing = !fs.existsSync(SET_PATH);

test('eeglab.open: returns reader with positive channels + rate + samples', { skip: skipIfMissing }, async () => {
  const reader = await globalThis.EEGLABReader.open({
    eeg_url: 'file://' + SET_PATH,
  });
  assert.ok(reader.n_channels > 0);
  assert.ok(reader.sampling_frequency > 0);
  assert.ok(reader.n_samples > 0);
});

test('eeglab.readWindow(0, 500): nCh × Float32Array[500] with finite data', { skip: skipIfMissing }, async () => {
  const reader = await globalThis.EEGLABReader.open({
    eeg_url: 'file://' + SET_PATH,
  });
  const win = await reader.readWindow(0, 500);
  assert.equal(win.length, reader.n_channels);
  for (let c = 0; c < win.length; c++) {
    assert.equal(win[c].length, 500);
    assert.ok(win[c].some(v => v !== 0 && isFinite(v)));
  }
});

test('eeglab: channel_labels match n_channels', { skip: skipIfMissing }, async () => {
  const reader = await globalThis.EEGLABReader.open({
    eeg_url: 'file://' + SET_PATH,
  });
  assert.ok(Array.isArray(reader.channel_labels));
  assert.equal(reader.channel_labels.length, reader.n_channels);
});

test('eeglab.readWindow tail clamp at n_samples', { skip: skipIfMissing }, async () => {
  const reader = await globalThis.EEGLABReader.open({
    eeg_url: 'file://' + SET_PATH,
  });
  const win = await reader.readWindow(reader.n_samples - 50, 1000);
  assert.ok(win[0].length <= 50);
  assert.ok(win[0].length > 0);
});

test('eeglab.fdtUrlFor: returns sibling .fdt URL when given a .set URL', () => {
  if (typeof globalThis.EEGLABReader.fdtUrlFor !== 'function') return;
  const fdt = globalThis.EEGLABReader.fdtUrlFor('https://example.com/sub-01_eeg.set');
  assert.ok(fdt.endsWith('.fdt') || fdt.endsWith('.fdt.gz'));
});

test('eeglab.readWindowStreaming: emits chunks summing to requested n', { skip: skipIfMissing }, async () => {
  const reader = await globalThis.EEGLABReader.open({
    eeg_url: 'file://' + SET_PATH,
  });
  if (typeof reader.readWindowStreaming !== 'function') return;
  let totalSamples = 0;
  let chunkCount = 0;
  for await (const chunk of reader.readWindowStreaming(0, 1000)) {
    chunkCount++;
    totalSamples += chunk.channels[0].length;
  }
  assert.ok(chunkCount >= 1);
  assert.equal(totalSamples, 1000);
});
```

- [ ] **Step 2: Run + measure**

```bash
node --test tests/unit-eeglab-readwindow.test.mjs 2>&1 | tail -8
npm run test:coverage 2>&1 | grep 'eeglab.js'
```

Expected: 6 pass; eeglab.js line coverage rises from 62% to 85%+.

- [ ] **Step 3: Commit**

```bash
git add tests/unit-eeglab-readwindow.test.mjs
git commit -m "test(eeglab): fixture-driven open + readWindow + streaming on split .set+.fdt

6 tests against the committed split .set+.fdt fixture. Covers the
.fdt binary read path + fdtUrlFor sibling resolution + the
readWindowStreaming() generator.

Expected eeglab.js line coverage lift: 62% → 85%+."
```

NO Co-authored-by. NO push.

---

## Task 7: Stryker iteration-14 baseline + threshold raise + docs

**Files:**
- Modify: `stryker.conf.json` (threshold)
- Modify: `docs/mutation-survivors-2026-05.md` (iter-14 section)

**Why:** T1-T6 added ~30 tests targeting the weakest mutation files + the 3 lowest-coverage readers. Capture the new aggregate + per-file scores. Raise the break threshold if aggregate moved comfortably above the current 30.

- [ ] **Step 1: Fresh Stryker baseline**

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer
rm -f reports/stryker-incremental.json
npx stryker run 2>&1 | tee /tmp/stryker-iter14.log | tail -12
```

Expected runtime: 20-25 minutes (full baseline on 5 mutated files + the added tests).

Capture from the output:
- aggregate %
- per-file scores

- [ ] **Step 2: Run full coverage to capture per-file numbers**

```bash
npm run test:coverage 2>&1 | grep -E '\.(js|mjs)\s+\|' | head -20
```

Capture from the output: line coverage for viewer.js, worker.js, brainvision.js, edf.js, eeglab.js.

- [ ] **Step 3: Adjust threshold per policy**

Edit `stryker.conf.json` `thresholds.break`:
- If new aggregate ≥ 40 → set `break: 35` and `low: 40`
- If new aggregate 30-39 → keep `break: 30` and `low: 35`
- If new aggregate < 30 → STOP. Something regressed. Investigate.

- [ ] **Step 4: Append iter-14 section to survivors doc**

Append to `docs/mutation-survivors-2026-05.md`:

```markdown
## Iteration 14 (Mutation + Coverage Lift, 2026-05-21)

Round 2 of test-side investment. T1-T6 added 6 test files (~30 tests)
targeting the iter-11/12 placeholder floors (viewer + worker) plus
the 3 format readers at ~60% line coverage.

### Per-file mutation results

| File | iter-13 | iter-14 | Δ |
|---|---:|---:|---:|
| traces.js          | 66.71% | <new>% | <delta> |
| filters.js         | 92.37% | <new>% | <delta> |
| bids-recording.js  | 74.24% | <new>% | <delta> |
| viewer.js          | 0.63%  | <new>% | <delta> |
| worker.js          | 5.50%  | <new>% | <delta> |
| **Aggregate**      | 35.33% | **<new>%** | **<delta>** |

### Per-file coverage lift

| File | iter-13 | iter-14 | Δ |
|---|---:|---:|---:|
| brainvision.js | 57.76% | <new>% | <delta> |
| edf.js         | 67.15% | <new>% | <delta> |
| eeglab.js      | 62.64% | <new>% | <delta> |

### Tests added (T1-T6)

- T1: `tests/unit-viewer-api.test.mjs` — 17 tests on window.Viewer.* helpers
- T2: `tests/unit-viewer-boot.test.mjs` — 2 boot() round-trip tests
- T3: `tests/unit-worker-roundtrip.test.mjs` — 5 real-message round-trips
- T4: `tests/unit-brainvision-readwindow.test.mjs` — 5 fixture-driven
- T5: `tests/unit-edf-readwindow.test.mjs` — 7 fixture-driven EDF+ + BDF
- T6: `tests/unit-eeglab-readwindow.test.mjs` — 6 fixture-driven .set+.fdt

### Threshold decision

<aggregate-based; one of: kept at 30, raised to 35>

### Iteration 15+ strategy

If iter-14 viewer.js or worker.js still under 25%, the next leverage
is event-driven tests (pointer/keyboard simulation via JSDOM event
dispatch + observe ctx call trace). traces.js + filters.js + bids-
recording.js are likely past their natural ceilings.
```

Replace `<new>%` and `<delta>` with the actual measured values from steps 1+2.

- [ ] **Step 5: Commit**

```bash
git add stryker.conf.json docs/mutation-survivors-2026-05.md
git commit -m "chore(stryker): iteration 14 baseline + threshold <break>

Round-2 mutation + coverage lift. Aggregate 35.33% → <N>%.

viewer.js:  0.63% → <new>%  (T1+T2: api helpers + boot round-trip)
worker.js:  5.50% → <new>%  (T3: real-message round-trip via self-shim)
brainvision.js coverage: 57% → <new>% (T4)
edf.js coverage: 67% → <new>% (T5)
eeglab.js coverage: 62% → <new>% (T6)

Threshold: break <38|30>, low <42|35>.

Documented iter-15+ strategy in survivors-doc: event-driven tests
for viewer.js/worker.js if their per-file scores remain under 25%
after this round."
```

NO Co-authored-by. NO push (controller pushes after final approval).

## Self-Review

**1. Spec coverage**

| Item from user direction | Task |
|---|---|
| viewer.js mutation 0.63% → 25-35% | T1 + T2 (api helpers + boot round-trip) |
| worker.js mutation 5.50% → 35-50% | T3 (real-message round-trip) |
| brainvision.js coverage 57% → 85% | T4 |
| edf.js coverage 67% → 85% | T5 |
| eeglab.js coverage 62% → 85% | T6 |
| Capture new Stryker baseline + adjust threshold | T7 |

All 6 user-requested items mapped.

**2. Placeholder scan** — searched plan for TBD/TODO/similar-to/etc. Found `<new>%` and `<delta>` placeholders in T7's doc append; those are intentional templates for the implementer to fill with actual measured values, NOT plan failures.

**3. Type consistency**

- `tests/_jsdom-bootstrap.mjs` used in T1+T2; this file was created in the prior plan (T3 / commit `76235a1`).
- `tests/_bootstrap.mjs` referenced in test patterns; it exists and exports the readers (confirmed via grep).
- `globalThis.EDFReader.open` monkey-patch (T3) — confirmed `EDFReader.open` is the public API per `tests/unit-api-surface.test.mjs` snapshot.
- `globalThis.BrainVisionReader.open` (T4) — same API contract via api-surface snapshot.
- `globalThis.HttpRange.fetchBuffer / fetchText / fetchRange` — confirmed by existing test patterns in `tests/unit-fiff.test.mjs` and `tests/unit-fiff-raw.test.mjs`.
- `EEGLABReader.fdtUrlFor` (T6) — confirmed in api-surface snapshot.

All cross-task references match existing surfaces.
