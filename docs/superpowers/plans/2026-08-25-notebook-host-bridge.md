# Notebook Host Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `BIDSDataset.plot()` in braindecode shows EMG traces + the synchronized hand-pose panel inside a Jupyter cell with **no server**: the recording bytes are inlined in the cell (papaya pattern) and pushed into the deployed eegdash-viewer through `postMessage`.

**Architecture:** The viewer gains a tiny *host-page bridge* — a `message` listener that accepts `{type:'eegdash-viewer:open', files:[File…], pose}` and routes it through the exact code path drag-and-drop already uses (`HttpRange.registerLocal` → `load()`), plus an `?embed=1` layout that keeps the View/Filter controls as a toolbar and docks the pose panel beside the traces. braindecode's side shrinks to one Python module that base64-inlines the recording (+ split-format siblings + small sidecars) and emits an `<iframe src=CDN/index.html?embed=1>` with ~15 lines of glue JS. No JS is re-implemented in Python; every viewer feature (worker, filters, cursor readout, events, pose panel) comes for free.

**Tech Stack:** eegdash-viewer (vanilla JS, node:test + jsdom, Playwright), GitHub Pages CDN (`https://eegdash.github.io/eegdash-viewer`), braindecode (Python ≥3.10, mne-bids, IPython.display.HTML, pytest), Python Playwright for the end-to-end proof.

**Spec:** Section "Spec" below (distilled from the opencode session `ses_fc80d86a0ffeh1nC2ypUHSLQW9`; prior handoff at `/tmp/opencode/emgdemo/HANDOFF.md` and `~/Desktop/HANDOFF-emg2pose.md`).

## Spec (what Bruno asked for, verbatim where it matters)

1. "I want to have something that allow me the show of the data with pose in the jupyter notebook."
2. "can we do this without server … like the papaya here" — bytes inline as `data:…;base64`, viewer JS from a CDN, zero localhost, zero ports, zero CORS prompts (Chrome's Local-Network-Access blocks public-origin → 127.0.0.1 fetches; this was the 404/`ERR_FAILED` wall of the previous session).
3. "I want minimal PR in braindecode, really minimal … or really really small." No emg2pose-specific class: "just load the bids datasets".
4. "please patch what needs to be patched in the eegdash viewer and directly push."
5. "then /design to improve by a lot what we are pushing" — the current `?embed=1` view (see `/tmp/opencode/emgdemo/real-sub01-pose.png`) has no controls (rail hidden) and the hand panel floats over the traces top-right. Design a notebook-grade embed: toolbar + docked pose panel + honest empty/error states.
6. Works in classic Notebook, JupyterLab and VS Code; saved notebooks keep the output (bytes live in the cell).

## Why not finish the previous "glue" approach

The uncommitted `_notebook_viewer.py` re-implements a mini viewer by loading 10 internal CDN files. It cannot work as written: `EDFReader.open()` calls `SidecarChecks.warnFsMismatch(meta.eeg_json.sampling_frequency, …)` — `formats/_sidecar.js` is not loaded (ReferenceError) and `meta.eeg_json` is undefined (TypeError). It also has no pose-panel CSS, no worker, no filters, no cursor readout, and duplicates viewer UI code inside Python. The bridge replaces it.

## Global Constraints

- CDN base: `https://eegdash.github.io/eegdash-viewer` (Pages deploys on push to `main`, `.github/workflows/pages.yml`; the cp allowlist stages only listed files/dirs — **no new top-level files** in this plan, so the allowlist is untouched).
- Bridge message names: `eegdash-viewer:open` (host → viewer), `eegdash-viewer:ready` (viewer → host). Exact strings; braindecode tests assert them.
- braindecode PR #1133 stays "really small": 1 new module (`braindecode/datasets/_notebook_viewer.py`, ≤ 90 lines), `plot()` ≤ 30 lines, 1 new test file, no new dependencies (IPython is imported lazily inside `plot()`).
- Inline size guard default: `MAX_BYTES = 256 * 2**20`.
- Commit messages: `<type>: <description>`; no Co-Authored-By, no "Generated with" lines.
- Repos: viewer = `/Users/bruaristimunha/Projects/eegdash/eegdash-viewer` (branch `main`, remote `origin`); braindecode = `/Users/bruaristimunha/Projects/braindecode/braindecode-emgpose` (branch `bids-plot-viewer`, PR #1133). Note the path is `bruaristimunha` — the previous session's "flapping filesystem" was a typo (`braristimunha`).

---

## File Structure

**eegdash-viewer**
- Modify `pose-panel.js` — `openUrl(url)` / `hideActive()` on the shared controller; `#pose-toggle` header button wiring; resize nudge on show/hide.
- Modify `viewer.js` — extract `openLocalFiles(files, {pose})` from the drop handler; add `attachHostBridge()`.
- Modify `index.html` — one `<button id="pose-toggle" hidden>` in `.header-right`.
- Modify `styles.css` — embed-mode toolbar rail, docked pose panel, `#pose-toggle` styling.
- Create `tests/unit-pose-panel-openurl.test.mjs` — controller reuse.
- Create `tests/unit-viewer-bridge.test.mjs` — message → registerLocal → load.
- Create `tests/e2e/host-bridge.spec.mjs` — real iframe host posts a BDF File + pose data URL; traces + hand render.
- Create `docs/embedding.md` — `?embed=1` + bridge protocol + braindecode snippet. Modify `README.md` (pointer).

**braindecode**
- Rewrite `braindecode/datasets/_notebook_viewer.py` — `collect_files()`, `build_viewer_html()`.
- Modify `braindecode/datasets/bids/datasets.py:203-249` — drop `_viewer_param`, slim `plot()`, fix import placement.
- Create `test/unit_tests/datasets/test_notebook_viewer.py`.
- Modify `test/unit_tests/datasets/test_bids.py:64-100` — plot test against the bridge HTML (BrainVision fixture now supported).
- Modify `docs/whats_new.rst` — one entry (remove the duplicate).
- Rewrite `emg2pose_real_demo.ipynb` (repo root, untracked demo) — two cells, executed.

---

### Task 1: `PosePanel.openUrl()` — one shared controller, re-usable by any host

**Files:**
- Modify: `pose-panel.js:566-760`
- Test: `tests/unit-pose-panel-openurl.test.mjs`

**Interfaces:**
- Produces: `PosePanel.openUrl(url: string) → controller` (mounts once, reloads afterwards), `PosePanel.hideActive() → void`.
- `mount()` additionally wires `#pose-toggle` (if present) and dispatches `window` `resize` on show/hide so the traces canvas refits when the docked panel changes the stage width.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit-pose-panel-openurl.test.mjs
// openUrl() must give hosts (drag-drop, postMessage bridge, ?pose=)
// one shared controller: first call mounts, later calls only reload.
import './_jsdom-bootstrap.mjs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The bridge/viewer look the panel up on globalThis; the test drives
// the same object node:test gets via module.exports.
const PosePanel = require('../pose-panel.js');

const EMPTY_JSON = 'data:application/json;base64,e30=';

test('openUrl: mounts one panel and reuses it on the next call', async () => {
  const fetched = [];
  globalThis.fetch = async (url) => { fetched.push(url); return { ok: false, status: 404 }; };
  const a = PosePanel.openUrl(EMPTY_JSON);
  const b = PosePanel.openUrl(EMPTY_JSON);
  assert.equal(a, b, 'same controller');
  assert.equal(globalThis.document.querySelectorAll('.pose-panel').length, 1);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(fetched.length, 2, 'each call loads the url');
});

test('hideActive: hides the shared panel; openUrl shows it again', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  PosePanel.openUrl(EMPTY_JSON);
  PosePanel.hideActive();
  const root = globalThis.document.querySelector('.pose-panel');
  assert.ok(root.hasAttribute('hidden'));
  PosePanel.openUrl(EMPTY_JSON);
  await new Promise(r => setTimeout(r, 0));
  assert.ok(!root.hasAttribute('hidden'), 'load() shows the panel (even on load failure, for the caption)');
});

test('mount: wires #pose-toggle when the header has one', () => {
  const btn = globalThis.document.createElement('button');
  btn.id = 'pose-toggle'; btn.hidden = true;
  globalThis.document.body.append(btn);
  const ctl = PosePanel.mount({});
  assert.equal(btn.hidden, false, 'button revealed');
  ctl.show();
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  btn.click();
  assert.ok(ctl.root.hasAttribute('hidden'), 'click toggles');
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  btn.remove();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/bruaristimunha/Projects/eegdash/eegdash-viewer && node --test tests/unit-pose-panel-openurl.test.mjs`
Expected: FAIL — `TypeError: PosePanel.openUrl is not a function`.

- [ ] **Step 3: Implement**

In `pose-panel.js`, inside `mount()` right after `closeBtn.addEventListener('click', () => hide());` add:

```js
    // Optional header button (index.html `.header-right`): visible
    // only once a panel exists, mirrors the `p` key.
    const toggleBtn = doc.getElementById('pose-toggle');
    if (toggleBtn) {
      toggleBtn.hidden = false;
      toggleBtn.addEventListener('click', () => toggle());
    }
    function reflect(visible) {
      if (toggleBtn) toggleBtn.setAttribute('aria-pressed', String(visible));
      // Docked (embed) layout: the panel shares the stage row with the
      // traces canvas, so its visibility changes the canvas width.
      // viewer.js refits on window resize; nudge it.
      try { globalThis.dispatchEvent(new globalThis.Event('resize')); } catch { /* no window */ }
    }
```

Replace the existing `show`/`hide` with:

```js
    function show() { root.removeAttribute('hidden'); reflect(true); }
    function hide() { root.setAttribute('hidden', ''); reflect(false); }
```

Replace `bootFromParams` and add the two new module-level functions (keep `_active`):

```js
  /**
   * Open a sidecar URL on the shared controller: mounts (and wires
   * keys) on first use, then just reloads — hosts that push a new
   * recording (postMessage bridge, drag-drop) never stack panels.
   */
  function openUrl(url) {
    if (!_active) {
      _active = mount({});
      attachKeys(_active);
    }
    _active.load(url);
    return _active;
  }

  /** Hide the shared panel (a recording without a sidecar was opened). */
  function hideActive() {
    _active?.hide();
  }

  function bootFromParams(params) {
    const poseUrl = params && params.get ? params.get('pose') : null;
    if (!poseUrl) return null;
    const abs = globalThis.location ? new URL(poseUrl, globalThis.location.href).href : poseUrl;
    return openUrl(abs);
  }
```

Add `openUrl, hideActive,` to the `api` object (same line as `mount, attachKeys, bootFromParams, …`).

- [ ] **Step 4: Run the tests**

Run: `node --test tests/unit-pose-panel-openurl.test.mjs tests/unit-pose-panel.test.mjs tests/unit-pose-mesh.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add pose-panel.js tests/unit-pose-panel-openurl.test.mjs
git commit -m "feat(pose): shared-controller openUrl()/hideActive() + header toggle wiring"
```

---

### Task 2: viewer.js host-page bridge (`postMessage` → drop path)

**Files:**
- Modify: `viewer.js:1185-1240` (drop handler) and `viewer.js:1328-1333` (boot tail)
- Test: `tests/unit-viewer-bridge.test.mjs`

**Interfaces:**
- Consumes: `PosePanel.openUrl(url)`, `PosePanel.hideActive()` (Task 1); `HttpRange.registerLocal/clearLocal`; existing `load(url)`.
- Produces (browser protocol):
  - host → viewer: `{ type: 'eegdash-viewer:open', files: File[], pose?: string|null }`
  - viewer → host (`window.parent`): `{ type: 'eegdash-viewer:ready' }` once `boot()` has run.
- Internal: `openLocalFiles(files, opts = {pose}) → physioUrl|null` shared by drop + bridge.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit-viewer-bridge.test.mjs
// Host-page bridge: a `message` event carrying File objects must take
// the same road as drag-drop — register local blobs, then load().
// Harness mirrors unit-viewer-boot.test.mjs (jsdom + stub Worker +
// 404 fetch stub for the sidecar walk).
import './_jsdom-bootstrap.mjs';
import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.location = globalThis.window.location;
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
globalThis.fetch = async () => new Response('', { status: 404, statusText: 'Not Found' });
globalThis.Worker = class {
  constructor() { this.sent = []; }
  postMessage(msg) {
    this.sent.push(msg);
    if (msg && msg.type === 'INIT') {
      queueMicrotask(() => this.onmessage && this.onmessage({
        data: { type: 'INIT_OK', formats: ['edf', 'bdf', 'set', 'vhdr'] } }));
    }
  }
  terminate() {}
};
process.on('unhandledRejection', () => {});

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
require('../pose-panel.js');
require('../viewer.js');

const Viewer = globalThis.window.Viewer;
const HttpRange = globalThis.HttpRange;
const PosePanel = globalThis.PosePanel;

// Bridge messages arrive as MessageEvents on `window`; viewer.js listens
// on globalThis, which the jsdom bootstrap aliases to `dom.window`
// (globalThis.window). Dispatch on the same object.
function post(data) {
  const ev = new globalThis.window.MessageEvent('message', { data });
  globalThis.window.dispatchEvent(ev);
}

before(() => {
  globalThis.window.history.replaceState({}, '', '/?embed=1');
  Viewer.boot({});
});

test('bridge: open message registers the file locally and starts load()', async () => {
  const file = new globalThis.window.File([new Uint8Array(512)], 'sub-01_task-x_emg.bdf');
  post({ type: 'eegdash-viewer:open', files: [file] });
  await new Promise(r => setTimeout(r, 20));
  const url = 'https://localdrop.invalid/sub-01_task-x_emg.bdf';
  assert.equal(await HttpRange.probeLength(url), 512, 'blob registered');
  const status = globalThis.document.getElementById('status').textContent;
  assert.match(status, /localdrop\.invalid\/sub-01_task-x_emg\.bdf|sub-01_task-x_emg/, `status: ${status}`);
});

test('bridge: pose url opens the shared pose panel; a later open without pose hides it', async () => {
  const opened = [];
  const origOpen = PosePanel.openUrl, origHide = PosePanel.hideActive;
  let hidden = 0;
  PosePanel.openUrl = (u) => { opened.push(u); return {}; };
  PosePanel.hideActive = () => { hidden++; };
  try {
    const file = new globalThis.window.File([new Uint8Array(64)], 'sub-02_emg.bdf');
    post({ type: 'eegdash-viewer:open', files: [file], pose: 'data:application/json;base64,e30=' });
    post({ type: 'eegdash-viewer:open', files: [file] });
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(opened, ['data:application/json;base64,e30=']);
    assert.equal(hidden, 1);
  } finally {
    PosePanel.openUrl = origOpen; PosePanel.hideActive = origHide;
  }
});

test('bridge: ignores foreign / malformed messages', async () => {
  const before = globalThis.document.getElementById('status').textContent;
  post({ type: 'something-else', files: [] });
  post({ type: 'eegdash-viewer:open', files: 'not-an-array' });
  post(null);
  await new Promise(r => setTimeout(r, 5));
  const after = globalThis.document.getElementById('status').textContent;
  // Only the well-formed-but-empty case may touch status, and then only with an error.
  assert.ok(after === before || /no files/.test(after), after);
});

test('bridge: ready handshake is posted to the parent when framed', () => {
  const got = [];
  const parent = { postMessage: (m, origin) => got.push([m, origin]) };
  Object.defineProperty(globalThis, 'parent', { value: parent, configurable: true });
  try {
    Viewer.boot({});
    assert.deepEqual(got.at(-1), [{ type: 'eegdash-viewer:ready' }, '*']);
  } finally {
    Object.defineProperty(globalThis, 'parent', { value: globalThis, configurable: true });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/unit-viewer-bridge.test.mjs`
Expected: FAIL — `blob registered` assertion (probeLength rejects: "Local drop missing"), and the ready-handshake test gets no message.

- [ ] **Step 3: Implement**

In `viewer.js` replace the body of the `drop` listener with a call to a shared function. Final shape of the block (replace from `function registerDrop(files) {` through the end of `attachDragDrop()`):

```js
    function registerDrop(files) {
      let physioUrl = null;
      for (const file of files) {
        const url = HttpRange.registerLocal(file.name, file);
        if (!physioUrl && PHYSIO_FILENAME.test(file.name)) physioUrl = url;
      }
      return physioUrl;
    }

    // Shared by drag-drop and the host-page bridge: swap the local
    // registry for `files`, open the physio file, and (un)dock the
    // hand-pose panel. Returns the synthetic URL that was loaded, or
    // null when no file matched a supported *_{suffix}.<ext> name.
    function openLocalFiles(files, opts = {}) {
      // Tear down before swap: an in-flight readWindow on a local
      // blob slices synchronously, so a clearLocal() race would
      // throw "Local drop missing" against a since-cleared registry.
      if (inFlight) inFlight.abort();
      readerInfo = null;
      fallbackReader = null;
      clearReadCache();
      HttpRange.clearLocal();
      const physioUrl = registerDrop(files);
      if (!physioUrl) {
        const supported = Object.keys(READERS).join(',');
        status.replaceChildren(el('span', 'err',
          `Drop a *_{eeg,ieeg,emg,meg,nirs}.{${supported}} file (got: ${[...files].map(f => f.name).join(', ')})`));
        return null;
      }
      const PosePanel = globalThis.PosePanel;
      if (PosePanel) {
        if (opts.pose) PosePanel.openUrl(opts.pose);
        else PosePanel.hideActive?.();
      }
      load(physioUrl);
      return physioUrl;
    }

    function attachDragDrop() {
      let depth = 0;
      let hasFiles = false;
      const show = () => globalThis.document.body.classList.add('drag-active');
      const hide = () => globalThis.document.body.classList.remove('drag-active');
      window.addEventListener('dragenter', (e) => {
        if (depth === 0) {
          hasFiles = !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
        }
        if (!hasFiles) return;
        depth++;
        show();
        e.preventDefault();
      });
      window.addEventListener('dragleave', () => {
        if (!hasFiles) return;
        depth = Math.max(0, depth - 1);
        if (depth === 0) { hide(); hasFiles = false; }
      });
      window.addEventListener('dragover', (e) => { if (hasFiles) e.preventDefault(); });
      window.addEventListener('drop', (e) => {
        e.preventDefault();
        depth = 0; hasFiles = false; hide();
        const files = e.dataTransfer && e.dataTransfer.files;
        if (!files || !files.length) return;
        openLocalFiles(files);
      });
    }

    // ---- host-page bridge (postMessage) ----------------------
    // Notebooks and docs embed the viewer in an <iframe> and hand it
    // in-memory files — no server, no CORS, no Range requests:
    //   frame.contentWindow.postMessage(
    //     { type: 'eegdash-viewer:open', files: [File, …], pose: url|null },
    //     'https://eegdash.github.io');
    // Files are structured-cloned (Blobs are zero-copy); `pose` is any
    // URL fetch() accepts, data: URLs included. The viewer announces
    // itself with { type: 'eegdash-viewer:ready' } once boot() ran so
    // hosts don't race the iframe load. Any origin may post: the
    // payload only selects what to render (same trust as a drag-drop)
    // and the viewer holds no credentials.
    const BRIDGE_OPEN = 'eegdash-viewer:open';
    const BRIDGE_READY = 'eegdash-viewer:ready';

    function attachHostBridge() {
      globalThis.addEventListener('message', (e) => {
        const msg = e && e.data;
        if (!msg || msg.type !== BRIDGE_OPEN) return;
        const files = Array.isArray(msg.files)
          ? msg.files.filter(f => f && typeof f.name === 'string' && typeof f.slice === 'function')
          : [];
        if (!files.length) {
          status.replaceChildren(el('span', 'err', `${BRIDGE_OPEN}: no files in message`));
          return;
        }
        openLocalFiles(files, { pose: typeof msg.pose === 'string' ? msg.pose : null });
      });
      const parent = globalThis.parent;
      if (parent && parent !== globalThis) {
        try { parent.postMessage({ type: BRIDGE_READY }, '*'); } catch { /* sandboxed host */ }
      }
    }
```

In the boot tail, after `attachDragDrop();` add `attachHostBridge();`.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/unit-viewer-bridge.test.mjs tests/unit-viewer-boot.test.mjs tests/unit-viewer.test.mjs tests/unit-api-surface.test.mjs`
Expected: all PASS. Then `npm run test:unit` — PASS (no regressions in the drop path).

- [ ] **Step 5: Commit**

```bash
git add viewer.js tests/unit-viewer-bridge.test.mjs
git commit -m "feat(embed): host-page postMessage bridge reusing the drag-drop path"
```

---

### Task 3: Notebook-grade `?embed=1` layout (design → CSS)

**Files:**
- Design canvas (artboards: *Embed / loaded with pose*, *Embed / loaded without pose*, *Embed / waiting for host*, *Embed / unsupported file*, *Notebook cell context*) — produced with the `design` skill before touching CSS; the artboards are the reference for the values below.
- Modify: `index.html:96-104` (`.header-right`)
- Modify: `styles.css:172` (`#time-mode-toggle` → shared with `#pose-toggle`), `styles.css:776-813` (embed block), `styles.css:1098-1156` (pose panel)
- Test: `tests/e2e/host-bridge.spec.mjs` (Task 4 asserts the docked layout geometry)

**Interfaces:**
- Consumes: `#pose-toggle` wiring from Task 1 (`mount()` reveals the button and keeps `aria-pressed` in sync).
- Produces: in `body.embed` the left rail renders as a one-row toolbar (Recording name · Window · Gain · HP/LP/Notch), header pills are visible, and `.pose-panel` is a docked right column of the stage (`position: static`) with a 240×240 canvas.

- [ ] **Step 1: Header button**

In `index.html` `.header-right`, after the `#time-mode-toggle` button add:

```html
      <button id="pose-toggle" hidden aria-pressed="true" title="Toggle hand-pose panel (p)">hand</button>
```

- [ ] **Step 2: Share the toggle styling**

In `styles.css` change the selector `#time-mode-toggle {` (line 172) to `#time-mode-toggle,\n#pose-toggle {` and every other `#time-mode-toggle…` selector in that block (`:hover`, `[data-mode="absolute"]`, `:disabled`) gets a `#pose-toggle` twin where it makes sense: append after the block

```css
#pose-toggle[aria-pressed="true"] {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--bg);
}
#pose-toggle[hidden] { display: none; }
```

- [ ] **Step 3: Replace the embed block** (`/* ----- embed mode ---- */` through `body.embed .stage-caption {…}`)

```css
/* ----- embed mode ---------------------------------------- */
/* (?embed=1) Notebook cells and docs pages host the viewer in an
   iframe. The header collapses to the brand mark + pills; the left
   rail folds into a one-row toolbar (recording · window · gain ·
   filters) so the essentials stay reachable without a 320px column;
   channel/event lists stay keyboard-reachable (`i` overlay) but off
   screen; the hand-pose panel docks to the right of the traces
   instead of floating over them. */

body.embed { background: transparent; }
body.embed .app {
  grid-template-columns: 1fr;
  grid-template-rows: 38px auto 1fr;
}
body.embed .header {
  background: transparent;
  padding: 0 14px;
  min-height: 38px;
}
body.embed .brand-title,
body.embed .brand-sub { display: none; }
body.embed .header-right .pill { display: inline-block; }
body.embed .brand-mark { width: 18px; height: 18px; }
body.embed .brand-eegdash {
  margin-left: 0;
  padding-left: 0;
  border-left: 0;
  opacity: 1;                  /* the wordmark IS the brand here */
  height: 24px;
}

/* Rail → toolbar. Sections become inline groups; the heavy lists hide. */
body.embed .rail.left {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 22px;
  padding: 5px 14px 7px;
  border-right: 0;
  border-bottom: 1px solid var(--line-2);
  background: transparent;
  overflow: visible;
}
body.embed .rail-section { margin: 0; display: flex; align-items: center; gap: 10px; }
body.embed .rail-title { margin: 0; }
body.embed .rail-section:has(#channel-colors),
body.embed .rail-section:has(#ch-list),
body.embed .rail-section:has(#ev-list),
body.embed .view-tip,
body.embed .provenance,
body.embed #electrode-link { display: none; }
body.embed .status {
  max-width: 34ch;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  word-break: normal;
}
body.embed .view-controls { flex-direction: row; gap: 16px; }
body.embed .view-controls label { grid-template-columns: auto auto auto; gap: 6px; }
body.embed .view-controls input[type="range"] { width: 110px; }
body.embed #filter-controls { flex-direction: row; gap: 12px; }
body.embed .filter-row { padding: 0; gap: 6px; }

/* Stage: canvas + docked pose column. */
body.embed .stage {
  display: flex;
  align-items: stretch;
  background: transparent;     /* let the host page bleed through */
}
body.embed .traces { flex: 1 1 auto; min-width: 0; }
body.embed .stage-hint { padding: 16px; font-size: 11px; }
body.embed .stage-caption {
  bottom: 8px;
  left: 12px;
  font-size: 9.5px;
}
body.embed .pose-panel {
  position: static;
  flex: 0 0 auto;
  align-self: stretch;
  margin: 8px 8px 8px 0;
  background: transparent;
  border-color: var(--line-2);
  box-shadow: none;
}
body.embed .pose-canvas { width: 240px; height: 240px; }
```

Delete the old `body.embed .pose-panel {…}` rule at the end of the pose block (it is folded into the block above).

- [ ] **Step 4: Eyeball it locally**

Run: `node scripts/serve.mjs 8011 &` then open `http://localhost:8011/index.html?embed=1&eeg=/tests/fixtures/eeg/sub-001_ses-01_task-meditation_eeg.bdf&pose=/test-data/pose-demo.json` in Chrome (Playwright screenshot in Task 4 is the recorded proof). Expected: toolbar row under the header, traces fill the remaining width, hand panel docked right, `hand` pill in the header toggles it.

- [ ] **Step 5: Commit**

```bash
git add index.html styles.css
git commit -m "feat(embed): toolbar rail + docked hand-pose panel for notebook hosts"
```

---

### Task 4: Browser e2e for the bridge + embed layout

**Files:**
- Create: `tests/e2e/host-bridge.spec.mjs`
- Uses fixtures: `tests/fixtures/eeg/sub-001_ses-01_task-meditation_eeg.bdf`, `test-data/pose-demo.json`

- [ ] **Step 1: Write the test**

```js
/**
 * tests/e2e/host-bridge.spec.mjs
 *
 * A host page (what a Jupyter cell renders) frames the viewer in
 * ?embed=1 mode and hands it a BDF as a File plus a pose sidecar as a
 * data: URL over postMessage. Proves the serverless notebook path:
 * no Range requests for the recording, traces + hand render, and
 * the embed layout docks the panel beside the canvas.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BDF = path.resolve('tests/fixtures/eeg/sub-001_ses-01_task-meditation_eeg.bdf');
const POSE = path.resolve('test-data/pose-demo.json');
const VIEWER = 'http://localhost:8011/index.html?embed=1';

const HOST_HTML = `<!doctype html><body style="margin:0;background:#fff">
<iframe id="v" src="${VIEWER}" style="width:1100px;height:560px;border:0"></iframe>
<script>
  window.__ready = new Promise(res => addEventListener('message', e => {
    if (e.data && e.data.type === 'eegdash-viewer:ready') res(true);
  }));
</script></body>`;

test('host bridge: File + pose data URL over postMessage renders traces and hand', async ({ page }) => {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const recordingRanges = [];
  page.on('request', r => { if (r.headers().range && /sub-001/.test(r.url())) recordingRanges.push(r.url()); });

  await page.setContent(HOST_HTML);
  await page.evaluate(() => window.__ready);

  const b64 = fs.readFileSync(BDF).toString('base64');
  const poseB64 = fs.readFileSync(POSE).toString('base64');
  await page.evaluate(async ([b64, poseB64]) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bytes], 'sub-001_ses-01_task-meditation_eeg.bdf');
    document.getElementById('v').contentWindow.postMessage({
      type: 'eegdash-viewer:open',
      files: [file],
      pose: 'data:application/json;base64,' + poseB64,
    }, '*');
  }, [b64, poseB64]);

  const frame = page.frameLocator('#v');
  await expect(frame.locator('#stage-caption')).toBeVisible({ timeout: 30_000 });
  await expect(frame.locator('#traces')).toBeVisible();
  await expect(frame.locator('#pill-format')).toHaveText('BDF');

  // Pose docked beside the canvas: same top edge, panel right of canvas.
  const panel = frame.locator('.pose-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.pose-caption')).toHaveText(/t = \d+\.\d{3} s/);
  const c = await frame.locator('#traces').boundingBox();
  const p = await panel.boundingBox();
  expect(p.x).toBeGreaterThanOrEqual(c.x + c.width - 1);

  // Toolbar: view + filter controls are on screen in embed mode.
  await expect(frame.locator('#window-sec')).toBeVisible();
  await expect(frame.locator('#gain')).toBeVisible();
  await expect(frame.locator('#filter-hp-enable')).toBeVisible();
  await expect(frame.locator('#ch-list')).toBeHidden();

  // Header toggle mirrors `p`.
  const toggle = frame.locator('#pose-toggle');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(panel).toBeVisible();

  expect(recordingRanges, 'recording must never be fetched over HTTP').toEqual([]);
  expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);

  await page.screenshot({ path: 'tests/evidence/host-bridge/embed-bridge.png' });
});
```

- [ ] **Step 2: Run it**

Run: `mkdir -p tests/evidence/host-bridge && npx playwright test tests/e2e/host-bridge.spec.mjs --project=chromium`
Expected: PASS (Playwright starts `scripts/serve.mjs` on 8011 itself). If the pose caption never appears, check that `test-data/pose-demo.json` still validates against `PosePanel.parseSidecar` (`node -e "require('./pose-panel.js').parseSidecar(require('./test-data/pose-demo.json'))"`).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/host-bridge.spec.mjs tests/evidence/host-bridge/embed-bridge.png
git commit -m "test(e2e): host-page bridge renders traces + docked hand panel in embed mode"
```

---

### Task 5: Docs, push, verify the CDN

**Files:**
- Create: `docs/embedding.md`
- Modify: `docs/pose-sidecar.md` (one pointer line under "Point the panel at it with `?pose=<url>`")

- [ ] **Step 1: Write `docs/embedding.md`**

````markdown
# Embedding the viewer (`?embed=1`) and the host-page bridge

The deployed viewer (`https://eegdash.github.io/eegdash-viewer/`) can be
framed by any page. `?embed=1` switches to the compact layout: header
pills, a one-row toolbar (recording · window · gain · HP/LP/notch), the
traces canvas, and — when a pose sidecar is loaded — the hand panel
docked to the right of the canvas.

## Two ways to hand the viewer a recording

1. **URL** — `?emg=<https url>` (or `?eeg=`, `?ieeg=`, `?meg=`, `?nirs=`) plus
   optional `&pose=<url>`. The viewer fetches windows with HTTP Range
   requests, so the host must allow CORS + Range (OpenNeuro/S3 do).
2. **postMessage bridge** — the host page pushes in-memory files. No
   server, no CORS, no Range: this is how `braindecode.datasets.BIDSDataset.plot()`
   shows a recording inside a Jupyter cell.

## Bridge protocol

| direction | message | notes |
|---|---|---|
| viewer → `window.parent` | `{ type: 'eegdash-viewer:ready' }` | posted once `Viewer.boot()` ran, origin `*` |
| host → viewer | `{ type: 'eegdash-viewer:open', files: File[], pose?: string \| null }` | `files` are structured-cloned; the first `*_{eeg,ieeg,emg,meg,nirs}.<ext>` is the recording, siblings (`.eeg/.vmrk`, `.fdt`, `_channels.tsv`, `_events.tsv`) are registered next to it. `pose` is any URL `fetch()` accepts, `data:` URLs included. |

The bridge takes exactly the drag-and-drop path (`HttpRange.registerLocal`
→ `load()`), so every format the viewer reads from a drop works here.
Any origin may post: the payload only selects what to render, and the
viewer holds no credentials.

```html
<iframe id="v" src="https://eegdash.github.io/eegdash-viewer/index.html?embed=1"
        style="width:100%;height:520px;border:0"></iframe>
<script>
  const frame = document.getElementById('v');
  let sent = false;
  async function send() {
    if (sent) return; sent = true;
    const buf = await (await fetch('data:application/octet-stream;base64,…')).arrayBuffer();
    frame.contentWindow.postMessage({
      type: 'eegdash-viewer:open',
      files: [new File([buf], 'sub-01_task-x_emg.bdf')],
      pose: 'data:application/json;base64,…',   // or null
    }, 'https://eegdash.github.io');
  }
  addEventListener('message', e => {
    if (e.source === frame.contentWindow && e.data?.type === 'eegdash-viewer:ready') send();
  });
  frame.addEventListener('load', send);   // belt and braces
</script>
```

Size note: bytes inlined in a notebook output are saved with the
notebook. braindecode refuses recordings above `max_bytes` (256 MiB by
default); crop or downsample first for anything larger.
````

- [ ] **Step 2: Pointer in `docs/pose-sidecar.md`**

After the sentence ending `(resolved against the page URL).` in the intro paragraph add: `In an iframe host, pass it as the \`pose\` field of the postMessage bridge instead (see [embedding.md](embedding.md)).`

- [ ] **Step 3: Full local gate, then push**

Run: `npm run test:unit && npx playwright test tests/e2e/host-bridge.spec.mjs --project=chromium`
Expected: PASS.

```bash
git add docs/embedding.md docs/pose-sidecar.md docs/superpowers/plans/2026-08-25-notebook-host-bridge.md
git commit -m "docs(embed): host-page bridge protocol + notebook embedding guide"
git push origin main
```

- [ ] **Step 4: Wait for Pages and verify the deployed bundle**

Run: `gh run watch --repo eegdash/eegdash-viewer $(gh run list --repo eegdash/eegdash-viewer --workflow pages.yml --limit 1 --json databaseId --jq '.[0].databaseId')`
Then: `curl -s https://eegdash.github.io/eegdash-viewer/viewer.js | grep -c "eegdash-viewer:open"` → `1` (GitHub Pages may cache for ~1 min; add `?nocache=$(date +%s)`), and `curl -s https://eegdash.github.io/eegdash-viewer/styles.css | grep -c "body.embed .pose-panel"` → `1`.

---

### Task 6: braindecode `_notebook_viewer.py` — inline bytes + bridge HTML

**Files:**
- Rewrite: `braindecode/datasets/_notebook_viewer.py`
- Test: `test/unit_tests/datasets/test_notebook_viewer.py`

**Interfaces:**
- Produces:
  - `CDN = "https://eegdash.github.io/eegdash-viewer"`, `MAX_BYTES = 256 * 2**20`
  - `collect_files(recording: Path) -> list[Path]` — recording first, then split-format siblings (`.vhdr`→`.eeg`,`.vmrk`; `.set`→`.fdt`), then same-prefix `_channels.tsv`, `_events.tsv` that exist.
  - `build_viewer_html(recording, pose_sidecar=None, *, height=520, cdn=CDN, max_bytes=MAX_BYTES) -> str` — raises `ValueError` mentioning `max_bytes` when the inlined bytes exceed the limit.

- [ ] **Step 1: Write the failing tests**

```python
# test/unit_tests/datasets/test_notebook_viewer.py
import json
import re

import pytest

from braindecode.datasets import _notebook_viewer as nv


def _write(path, n_bytes=16):
    path.write_bytes(bytes(range(n_bytes)))
    return path


def _payload(html):
    return json.loads(re.search(r"var payload = (\{.*?\});\n", html).group(1))


def test_collect_files_brainvision_trio_and_same_prefix_sidecars(tmp_path):
    rec = _write(tmp_path / "sub-1_task-a_emg.vhdr")
    eeg = _write(tmp_path / "sub-1_task-a_emg.eeg")
    channels = _write(tmp_path / "sub-1_task-a_channels.tsv")
    _write(tmp_path / "sub-1_task-b_channels.tsv")  # other run: excluded
    _write(tmp_path / "sub-1_task-a_emg.json")  # not read by the viewer
    assert nv.collect_files(rec) == [rec, eeg, channels]


def test_collect_files_single_file_recording(tmp_path):
    rec = _write(tmp_path / "sub-1_emg.bdf")
    assert nv.collect_files(rec) == [rec]


def test_build_viewer_html_iframe_and_payload(tmp_path):
    rec = _write(tmp_path / "sub-1_task-a_emg.bdf")
    pose = tmp_path / "sub-1_task-a_desc-pose.json"
    pose.write_text("{}")
    html = nv.build_viewer_html(rec, pose, height=300, cdn="https://viewer.test/v/")

    assert 'src="https://viewer.test/v/index.html?embed=1"' in html
    assert "height:300px" in html
    assert '"https://viewer.test"' in html  # postMessage target origin
    assert "eegdash-viewer:open" in html and "eegdash-viewer:ready" in html
    assert "localhost" not in html and "127.0.0.1" not in html

    payload = _payload(html)
    assert [f["name"] for f in payload["files"]] == ["sub-1_task-a_emg.bdf"]
    assert payload["files"][0]["data"] == (
        "data:application/octet-stream;base64,AAECAwQFBgcICQoLDA0ODw=="
    )
    assert payload["pose"] == "data:application/json;base64,e30="


def test_build_viewer_html_without_pose(tmp_path):
    rec = _write(tmp_path / "sub-1_emg.edf")
    assert _payload(nv.build_viewer_html(rec))["pose"] is None


def test_build_viewer_html_size_guard(tmp_path):
    rec = _write(tmp_path / "sub-1_emg.edf", 64)
    with pytest.raises(ValueError, match="max_bytes"):
        nv.build_viewer_html(rec, max_bytes=32)
    assert nv.build_viewer_html(rec, max_bytes=64)  # boundary is inclusive
```

- [ ] **Step 2: Run to verify failure**

Run: `python -m pytest test/unit_tests/datasets/test_notebook_viewer.py -q`
Expected: FAIL — `AttributeError: module … has no attribute 'collect_files'`.

- [ ] **Step 3: Rewrite the module**

```python
# Authors: Bruno Aristimunha <b.aristimunha@gmail.com>
#
# License: BSD (3-clause)
"""Serverless in-notebook viewer for BIDS recordings.

The recording bytes are inlined in the cell output as base64 (the
"papaya pattern") and pushed into the deployed eegdash-viewer through
its ``postMessage`` host bridge (``docs/embedding.md`` in
https://github.com/eegdash/eegdash-viewer). No local server, no ports,
no CORS: works in classic Notebook, JupyterLab and VS Code, and the
saved notebook keeps the interactive output.
"""

from __future__ import annotations

import base64
import json
import uuid
from pathlib import Path
from urllib.parse import urlsplit

CDN = "https://eegdash.github.io/eegdash-viewer"
MAX_BYTES = 256 * 2**20
# Split-file formats travel with their siblings; small BIDS sidecars
# give the viewer channel types and event markers.
_SIBLINGS = {".vhdr": (".eeg", ".vmrk"), ".set": (".fdt",)}
_SIDECARS = ("_channels.tsv", "_events.tsv")

_TEMPLATE = """<iframe id="{uid}" src="{cdn}/index.html?embed=1" title="eegdash trace viewer"
  style="width:100%;height:{height}px;border:1px solid var(--jp-border-color1,#d9dce1);border-radius:6px;background:transparent"></iframe>
<script>
(function () {{
  var frame = document.getElementById("{uid}");
  var payload = {payload};
  var sent = false;
  async function send() {{
    if (sent || !frame.contentWindow) return;
    sent = true;
    var files = await Promise.all(payload.files.map(async function (f) {{
      var buf = await (await fetch(f.data)).arrayBuffer();
      return new File([buf], f.name);
    }}));
    frame.contentWindow.postMessage(
      {{ type: "eegdash-viewer:open", files: files, pose: payload.pose }}, "{origin}");
  }}
  window.addEventListener("message", function (e) {{
    if (e.source === frame.contentWindow && e.data && e.data.type === "eegdash-viewer:ready") send();
  }});
  frame.addEventListener("load", send);
}})();
</script>"""


def collect_files(recording: Path) -> list[Path]:
    """Recording first, then the siblings the viewer needs (if present)."""
    rec = Path(recording)
    prefix = rec.stem.rsplit("_", 1)[0]  # sub-01_..._run-17 (drop the suffix token)
    candidates = [rec.with_suffix(ext) for ext in _SIBLINGS.get(rec.suffix.lower(), ())]
    candidates += [rec.with_name(prefix + name) for name in _SIDECARS]
    return [rec] + [p for p in candidates if p.is_file()]


def build_viewer_html(
    recording: Path,
    pose_sidecar: Path | None = None,
    *,
    height: int = 520,
    cdn: str = CDN,
    max_bytes: int = MAX_BYTES,
) -> str:
    """HTML for one recording: viewer iframe + inlined bytes + bridge glue."""
    files = collect_files(recording)
    total = sum(p.stat().st_size for p in files)
    if total > max_bytes:
        raise ValueError(
            f"{Path(recording).name}: {total / 2**20:.0f} MiB would be inlined into "
            f"the notebook output (max_bytes={max_bytes / 2**20:.0f} MiB). Crop or "
            "downsample and export a smaller file, or pass a larger max_bytes."
        )
    payload = {
        "files": [{"name": p.name, "data": _data_url(p.read_bytes())} for p in files],
        "pose": (
            _data_url(Path(pose_sidecar).read_bytes(), "application/json")
            if pose_sidecar is not None
            else None
        ),
    }
    cdn = cdn.rstrip("/")
    parts = urlsplit(cdn)
    return _TEMPLATE.format(
        uid=f"eegdash-viewer-{uuid.uuid4().hex[:8]}",
        cdn=cdn,
        origin=f"{parts.scheme}://{parts.netloc}",
        height=int(height),
        payload=json.dumps(payload).replace("</", "<\\/"),
    )


def _data_url(raw: bytes, mime: str = "application/octet-stream") -> str:
    return f"data:{mime};base64," + base64.b64encode(raw).decode()
```

- [ ] **Step 4: Run the tests**

Run: `python -m pytest test/unit_tests/datasets/test_notebook_viewer.py -q && python -m ruff check braindecode/datasets/_notebook_viewer.py test/unit_tests/datasets/test_notebook_viewer.py && python -m ruff format --check braindecode/datasets/_notebook_viewer.py test/unit_tests/datasets/test_notebook_viewer.py`
Expected: 5 passed, ruff clean.

- [ ] **Step 5: Commit (braindecode, staged only — the branch commit happens in Task 8)**

```bash
git add braindecode/datasets/_notebook_viewer.py test/unit_tests/datasets/test_notebook_viewer.py
```

---

### Task 7: `BIDSDataset.plot()` slimmed to the bridge

**Files:**
- Modify: `braindecode/datasets/bids/datasets.py:16-21` (import), `:203-249` (`_viewer_param` + `plot`)
- Modify: `test/unit_tests/datasets/test_bids.py:83-100`
- Modify: `docs/whats_new.rst:31-38`

- [ ] **Step 1: Update the plot test**

Replace `test_bids_dataset_plot_iframe` with:

```python
@pytest.mark.parametrize("with_pose", [False, True])
def test_bids_dataset_plot(tmp_path, with_pose):
    root = _make_emg_bids_tree(tmp_path)
    ds = BIDSDataset(root, suffixes="emg", datatypes="emg")
    assert len(ds.datasets) == 1
    assert ds.bids_paths[0].suffix == "emg"

    if with_pose:  # optional hand-pose skeleton sidecar
        (
            root
            / "sub-893"
            / "ses-s1"
            / "emg"
            / "sub-893_ses-s1_task-fist_acq-right_desc-pose.json"
        ).write_text("{}")

    html = ds.plot(0).data
    assert 'src="https://eegdash.github.io/eegdash-viewer/index.html?embed=1"' in html
    # BrainVision trio is inlined (recording first), nothing is served.
    assert "sub-893_ses-s1_task-fist_acq-right_emg.vhdr" in html
    assert "sub-893_ses-s1_task-fist_acq-right_emg.eeg" in html
    assert "localhost" not in html and "127.0.0.1" not in html
    assert ("data:application/json;base64" in html) is with_pose
```

Run: `python -m pytest test/unit_tests/datasets/test_bids.py -q -k plot` → Expected: FAIL (old `plot()` rejects `.vhdr`).

- [ ] **Step 2: Rewrite `plot()`**

In `datasets.py`: move `from .. import _notebook_viewer` out of the third-party block to the local-import block (it must sit with the other `from ..` / `from .` imports so ruff's isort passes), delete `_viewer_param` entirely, and replace `plot` with:

```python
def plot(
    self,
    index: int = 0,
    *,
    height: int = 520,
    cdn_url: str = _notebook_viewer.CDN,
    max_bytes: int = _notebook_viewer.MAX_BYTES,
):
    """Show one recording in the eegdash-viewer inside a Jupyter cell.

    Serverless: the recording bytes are inlined in the output and pushed
    into the viewer (loaded from ``cdn_url``) over ``postMessage``.
    Drag to pan, hover for the cursor readout; when a ``*_desc-pose.json``
    sidecar sits next to the recording the hand skeleton tracks the
    cursor (``p`` toggles the panel). See
    https://github.com/eegdash/eegdash-viewer/blob/main/docs/embedding.md.

    Parameters
    ----------
    index : int
        Recording to display (position in ``self.bids_paths``).
    height : int
        Viewer height in pixels.
    cdn_url : str
        Base URL of a deployed eegdash-viewer.
    max_bytes : int
        Refuse to inline more than this many bytes (they are saved with
        the notebook).

    Returns
    -------
    IPython.display.HTML
    """
    from IPython.display import HTML

    fpath = Path(self.bids_paths[index].fpath).resolve()
    pose = fpath.with_name(fpath.stem.rsplit("_", 1)[0] + "_desc-pose.json")
    return HTML(
        _notebook_viewer.build_viewer_html(
            fpath,
            pose if pose.is_file() else None,
            height=height,
            cdn=cdn_url,
            max_bytes=max_bytes,
        )
    )


BIDSDataset.plot = plot
del plot
```

- [ ] **Step 3: whats_new — one entry**

Replace both `Add ``BIDSDataset.plot()``…` bullets in `docs/whats_new.rst` with:

```rst
- Add :meth:`braindecode.datasets.BIDSDataset.plot`: show a recording in the
  `eegdash-viewer <https://github.com/eegdash/eegdash-viewer>`_ inside a
  Jupyter cell — serverless (bytes inlined, viewer from CDN), with the
  synchronized hand-pose panel when a ``*_desc-pose.json`` sidecar is present
  (:gh:`1133` by `Bruno Aristimunha`_)
```

(Keep whatever author-link/`:gh:` role convention the surrounding entries use — copy the exact form of the entry directly above.)

- [ ] **Step 4: Run everything**

Run: `python -m pytest test/unit_tests/datasets/test_bids.py test/unit_tests/datasets/test_notebook_viewer.py -q && python -m ruff check braindecode/datasets test/unit_tests/datasets && python -m ruff format --check braindecode/datasets/bids/datasets.py test/unit_tests/datasets/test_bids.py`
Expected: 9 passed (4 in test_bids incl. 2 plot cases, 5 in test_notebook_viewer), ruff clean.

- [ ] **Step 5: Stage**

```bash
git add braindecode/datasets/bids/datasets.py test/unit_tests/datasets/test_bids.py docs/whats_new.rst
```

---

### Task 8: Clean the index, end-to-end proof, commit + push the PR branch

**Files:**
- Index only: `braindecode/datasets/viewer_static/**` (47 files) and `scripts/sync_viewer_assets.py` are *staged as added but deleted in the worktree* (leftovers of the server approach) — unstage them.
- Scratch: `$SCRATCH/e2e_notebook_proof.py`

- [ ] **Step 1: Unstage the dead server assets**

```bash
git rm -r -q --cached braindecode/datasets/viewer_static scripts/sync_viewer_assets.py
git status --short   # expect only: M datasets.py, M whats_new.rst, M test_bids.py, A _notebook_viewer.py, A test_notebook_viewer.py (+ untracked demo dirs)
```

- [ ] **Step 2: End-to-end proof against the real sub-01 BDF (Python Playwright)**

```python
# $SCRATCH/e2e_notebook_proof.py — run: python e2e_notebook_proof.py [cdn]
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from braindecode.datasets import BIDSDataset

CDN = sys.argv[1] if len(sys.argv) > 1 else "https://eegdash.github.io/eegdash-viewer"
ROOT = Path("/Users/bruaristimunha/Projects/braindecode/braindecode-emgpose/emg2pose_test_bids")
OUT = Path(__file__).with_name("notebook-proof.png")

ds = BIDSDataset(ROOT, suffixes="emg", datatypes="emg")
html = ds.plot(0, cdn_url=CDN).data
assert "sub-01_ses-02_task-emg2pose_run-17_recording-left_emg.bdf" in html
assert "data:application/json;base64" in html, "pose sidecar must be inlined"

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1200, "height": 640})
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.set_content(f"<body style='margin:16px;background:#fff'>{html}</body>")
    frame = page.frame_locator("iframe")
    expect(frame.locator("#stage-caption")).to_be_visible(timeout=60_000)
    expect(frame.locator("#pill-format")).to_have_text("BDF")
    expect(frame.locator(".pose-panel")).to_be_visible()
    expect(frame.locator(".pose-caption")).to_have_text(re.compile(r"t = \d+\.\d{3} s"))
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT))
    browser.close()
assert not errors, errors
print("OK ->", OUT)
```

(Add `import re` at the top.) Run first against the local viewer server — `node scripts/serve.mjs 8011` in the viewer repo — with `python e2e_notebook_proof.py http://localhost:8011`, then, once Task 5 Step 4 confirmed the deploy, with no argument (CDN). Expected: `OK -> …/notebook-proof.png` both times; open the PNG and confirm traces + hand + toolbar.

- [ ] **Step 3: Commit + push**

```bash
git commit -m "Rewrite BIDSDataset.plot() as a serverless inline viewer (eegdash-viewer host bridge)"
git push origin bids-plot-viewer
```

- [ ] **Step 4: PR body**

`gh pr edit 1133 --repo braindecode/braindecode --body-file $SCRATCH/pr-body.md` with:

```markdown
## What

`BIDSDataset.plot(index)` shows a recording in the [eegdash-viewer](https://github.com/eegdash/eegdash-viewer) inside a Jupyter cell — **serverless**. The recording bytes are inlined in the output (base64, like the papaya pattern in huggingface/datasets#7874) and pushed into the deployed viewer over `postMessage`; the viewer's own reader/worker/filters/cursor readout and the synchronized hand-pose panel come along for free.

```python
from braindecode.datasets import BIDSDataset

ds = BIDSDataset("emg2pose-bids", suffixes="emg", datatypes="emg")
ds.plot(index=0)
```

![real sub-01 EMG + hand pose in a notebook cell](<url of notebook-proof.png uploaded to the PR>)

## Diff

- `braindecode/datasets/_notebook_viewer.py` (new, ~80 lines): `collect_files()` (recording + split-format siblings + `_channels.tsv`/`_events.tsv`), `build_viewer_html()` (iframe to the CDN + inlined payload + 15 lines of glue JS, `max_bytes` guard, default 256 MiB).
- `datasets.py`: store `self.bids_paths` (+1 line), `plot()` (~25 lines incl. docstring).
- Tests: `test_notebook_viewer.py` (5), `test_bids.py` (2 parametrized plot cases against a BrainVision emg tree).
- `whats_new.rst`: one entry.

No new dependencies (IPython is imported lazily). Viewer-side bridge + embed layout: eegdash/eegdash-viewer `main` (docs/embedding.md).

## Verification

- `pytest test/unit_tests/datasets/test_bids.py test/unit_tests/datasets/test_notebook_viewer.py` → 9 passed
- Python Playwright renders the generated cell HTML against the deployed CDN with the real rsynced `sub-01` BDF (9.5 MB @ 2 kHz, 16 EMG + 20 joint channels) + FK pose sidecar: traces + docked hand panel, zero console errors, zero HTTP Range requests for the recording (screenshot above).
```

Upload the PNG by attaching it to a PR comment or via `gh pr comment 1133 --body-file` after dropping the image into the issue (GitHub renders pasted images); reference the resulting URL in the body.

---

### Task 9: Demo notebook + open Jupyter

**Files:**
- Rewrite: `emg2pose_real_demo.ipynb` (repo root; untracked, not part of the PR)

- [ ] **Step 1: Regenerate the notebook**

```python
# $SCRATCH/make_demo_nb.py
import nbformat as nbf
from nbclient import NotebookClient

ROOT = "/Users/bruaristimunha/Projects/braindecode/braindecode-emgpose"
nb = nbf.v4.new_notebook()
nb.cells = [
    nbf.v4.new_markdown_cell(
        "# emg2pose (BIDS) in braindecode — EMG traces with synchronized hand pose\n\n"
        "Real converted emg2pose data (`sub-01`, BDF @ 2 kHz, 16 EMG + 20 joint-angle channels). "
        "`BIDSDataset.plot()` embeds the [eegdash-viewer](https://github.com/eegdash/eegdash-viewer) "
        "**without any server**: the recording is inlined in this cell's output and handed to the viewer "
        "over `postMessage`. The hand skeleton comes from the `*_desc-pose.json` sidecar "
        "(UmeTrack forward kinematics, `scripts/export-pose-sidecar.py` in eegdash-viewer).\n\n"
        "Drag the traces to pan, hover for the cursor readout — the hand tracks it. "
        "Toolbar: window, gain, HP/LP/notch. `p` (or the *hand* pill) toggles the panel, drag the hand to orbit."
    ),
    nbf.v4.new_code_cell(
        "from braindecode.datasets import BIDSDataset\n\n"
        f'dataset = BIDSDataset("{ROOT}/emg2pose_test_bids", suffixes="emg", datatypes="emg")\n'
        "print(len(dataset.datasets), \"recording(s)\")\n"
        "dataset.bids_paths[0]"
    ),
    nbf.v4.new_code_cell("dataset.plot(index=0)"),
]
NotebookClient(nb, timeout=300, kernel_name="python3", resources={"metadata": {"path": ROOT}}).execute()
nbf.write(nb, f"{ROOT}/emg2pose_real_demo.ipynb")
out = nb.cells[2].outputs[0]["data"]["text/html"]
assert "eegdash-viewer:open" in out and "_desc-pose.json" not in out and "data:application/json;base64" in out
print("notebook executed; output html bytes:", len(out))
```

Run: `python $SCRATCH/make_demo_nb.py` → prints the size (~13 MB: the BDF base64 + pose).

- [ ] **Step 2: Open it for Bruno**

```bash
pkill -f jupyter-notebook || true
cd /Users/bruaristimunha/Projects/braindecode/braindecode-emgpose
nohup jupyter notebook emg2pose_real_demo.ipynb --no-browser --NotebookApp.token='' --port 8888 > $SCRATCH/jupyter.log 2>&1 &
sleep 4 && open http://localhost:8888/notebooks/emg2pose_real_demo.ipynb
```

Expected: the browser opens the notebook; running the two cells shows the viewer with traces + docked hand panel (the saved output already shows it before re-running).

---

### Task 10: Handoff at the repo root (what the previous session failed to write)

- [ ] Write `HANDOFF.md` in `/Users/bruaristimunha/Projects/braindecode/braindecode-emgpose/` (untracked) with: state of both repos after this plan (commit SHAs), how the bridge works, the verification commands (Task 4, Task 8 Step 2), known limits (inline size, CDN required, no `_repr_html_` by design — displaying a dataset object must not inline megabytes), and the path typo that caused the "flapping FS".

---

## Self-review

- **Spec coverage:** (1) pose in notebook → Tasks 1–4, 6–9; (2) serverless/papaya → Task 6 payload + Task 2 bridge, e2e asserts zero Range requests; (3) minimal braindecode PR → Task 6/7 (1 module + 1 method + tests); (4) patch viewer and push → Task 5; (5) design improvement → Task 3 (design canvas first, toolbar + docked panel), Task 4 asserts geometry; (6) Notebook/Lab/VS Code + saved output → bytes in the cell, glue uses only `fetch(data:)`, `File`, `postMessage`.
- **Placeholder scan:** none; the PR-body image URL is the one runtime value that only exists after upload (Task 8 Step 4 says how to obtain it).
- **Type consistency:** `openUrl`/`hideActive` (Task 1) ⇄ Task 2 usage; `eegdash-viewer:open`/`:ready` strings identical across Tasks 2, 4, 6 and the braindecode tests; `collect_files`/`build_viewer_html(…, height, cdn, max_bytes)` (Task 6) ⇄ `plot()` (Task 7) ⇄ tests.
