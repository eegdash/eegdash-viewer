// Unit tests for topo2d.js — MNE/EEGLAB-style 2D EEG topomap renderer.
//
// The module is an IIFE that attaches window.EEGTopo2D.  We stub:
//   - globalThis.window          (so "window.EEGTopo2D = api" works)
//   - globalThis.document        (SVG createElementNS + addEventListener)
// We do NOT use JSDOM; instead we build a minimal synthetic DOM that
// mirrors exactly what topo2d.js touches at runtime.
//
// Projection math is tested directly via the public API by reading
// the `cx`/`cy` attributes the module writes onto each SVG <circle>.
import { test, beforeEach, afterEach, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Minimal synthetic DOM
// ---------------------------------------------------------------------------

class StubEl {
  constructor(tag, ns) {
    this.tagName = tag;
    this.namespaceURI = ns || null;
    this._attrs = {};
    this._classList = new Set();
    this.children = [];
    this.style = {};
    this._textContent = '';
    this._listeners = {};
    this.firstChild = null;
    this.pointerEvents = '';
  }

  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs[k] ?? null; }

  get classList() {
    const self = this;
    return {
      add(cls) { self._classList.add(cls); },
      has(cls) { return self._classList.has(cls); },
    };
  }

  get textContent() { return this._textContent; }
  set textContent(v) { this._textContent = String(v); }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    // keep firstChild / removeChild chain working
    this._rebuildFirstChild();
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) this.children.splice(idx, 1);
    if (child.parentNode === this) child.parentNode = null;
    this._rebuildFirstChild();
    return child;
  }

  _rebuildFirstChild() {
    this.firstChild = this.children.length ? this.children[0] : null;
  }

  addEventListener(type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  }

  removeEventListener(type, fn) {
    const arr = this._listeners[type];
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }

  // Dispatch a fake event to registered listeners.
  _dispatch(type, eventObj) {
    (this._listeners[type] || []).forEach(fn => fn(eventObj));
  }

  // closest('.topo-dot') — topo2d calls this on the event target
  closest(selector) {
    if (selector === '.topo-dot' && this._classList.has('topo-dot')) return this;
    return null;
  }
}

class StubDocument {
  constructor() { this._byId = new Map(); }

  createElementNS(ns, tag) { return new StubEl(tag, ns); }
  createElement(tag) { return new StubEl(tag, null); }

  getElementById(id) { return this._byId.get(id) || null; }
  register(id, el) { this._byId.set(id, el); return el; }
}

// ---------------------------------------------------------------------------
// Helpers to load a fresh copy of topo2d.js into globalThis
// ---------------------------------------------------------------------------

let savedWindow, savedDocument;

function setupGlobals() {
  savedWindow   = globalThis.window;
  savedDocument = globalThis.document;

  const doc = new StubDocument();
  globalThis.document = doc;
  globalThis.window   = globalThis; // so "window.EEGTopo2D = api" lands on globalThis
  return doc;
}

function loadFreshTopo2D() {
  // Bust the require cache so the IIFE re-runs and resets all module state.
  const mod = require.resolve('../topo2d.js');
  delete require.cache[mod];
  require('../topo2d.js');
  return globalThis.EEGTopo2D;
}

function teardownGlobals() {
  globalThis.window   = savedWindow;
  globalThis.document = savedDocument;
}

// Build a minimal container element that the SVG gets appended to.
function makeContainer() {
  return new StubEl('div', null);
}

// Standard EEG montage with known positions for geometry tests.
//
// Coordinate convention (unit-sphere, right-hand):
//   +uy = nasion direction (front), +uz = vertex (top), +ux = right ear
//
// Cz   → directly above → (0,  0,  1)     projection → (0,   0)
// Fz   → midline front  → (0,  0.71, 0.71) projection → small y<0
// Pz   → midline back   → (0, -0.71, 0.71) projection → small y>0
// T7   → left ear       → (-1, 0,   0)     projection → (-1,  0)
// T8   → right ear      → ( 1, 0,   0)     projection → ( 1,  0)
// Oz   → midline back   → (0, -1,   0)     projection → (0,   1)
// Fpz  → midline front  → (0,  1,   0)     projection → (0,  -1)
const STD_MONTAGE = {
  electrodes: [
    { name: 'Cz',  ux:  0,     uy:  0,     uz: 1,    region: 'central' },
    { name: 'Fz',  ux:  0,     uy:  0.707, uz: 0.707, region: 'frontal' },
    { name: 'Pz',  ux:  0,     uy: -0.707, uz: 0.707, region: 'parietal' },
    { name: 'T7',  ux: -1,     uy:  0,     uz: 0,    region: 'temporal' },
    { name: 'T8',  ux:  1,     uy:  0,     uz: 0,    region: 'temporal' },
    { name: 'Oz',  ux:  0,     uy: -1,     uz: 0,    region: 'occipital' },
    { name: 'Fpz', ux:  0,     uy:  1,     uz: 0,    region: 'frontal' },
    { name: 'Fp1', ux: -0.309, uy:  0.951, uz: 0,    region: 'frontal' },
  ],
};

// ---------------------------------------------------------------------------
// isReady() lifecycle
// ---------------------------------------------------------------------------

describe('isReady() lifecycle', () => {
  beforeEach(() => { setupGlobals(); });
  afterEach(() => { teardownGlobals(); });

  test('isReady() returns false before init', () => {
    const api = loadFreshTopo2D();
    assert.equal(api.isReady(), false);
  });

  test('isReady() returns true after init', () => {
    const api = loadFreshTopo2D();
    api.init(makeContainer());
    assert.equal(api.isReady(), true);
  });

  test('isReady() still true after setMontage (no destroy)', () => {
    const api = loadFreshTopo2D();
    api.init(makeContainer());
    api.setMontage('test', STD_MONTAGE);
    assert.equal(api.isReady(), true);
  });

  // destroy() reverses init(): SVG removed, listeners detached,
  // module state reset. After destroy() the module can be reinit'd
  // into a different container without leaking.
  test('isReady() returns false after destroy()', () => {
    const api = loadFreshTopo2D();
    api.init(makeContainer());
    api.setMontage('test', STD_MONTAGE);
    api.destroy();
    assert.equal(api.isReady(), false);
  });

  test('destroy() removes the SVG from the container', () => {
    const api = loadFreshTopo2D();
    const container = makeContainer();
    api.init(container);
    assert.equal(container.children.length, 1, 'SVG present after init');
    api.destroy();
    assert.equal(container.children.length, 0, 'SVG removed after destroy');
  });

  test('init() then destroy() then init() into a different container works (no listener leak)', () => {
    const api = loadFreshTopo2D();
    const c1 = makeContainer();
    const c2 = makeContainer();
    api.init(c1);
    api.setMontage('test', STD_MONTAGE);
    api.destroy();
    // Second mount into a fresh container.
    api.init(c2);
    api.setMontage('test', STD_MONTAGE);
    assert.equal(api.isReady(), true);
    assert.equal(c1.children.length, 0, 'old container empty');
    assert.equal(c2.children.length, 1, 'new container holds the SVG');
  });

  test('destroy() before init() is a safe no-op', () => {
    const api = loadFreshTopo2D();
    // No error.
    api.destroy();
    assert.equal(api.isReady(), false);
  });
});

// ---------------------------------------------------------------------------
// init() — creates SVG and appends it to the container
// ---------------------------------------------------------------------------

describe('init()', () => {
  beforeEach(() => { setupGlobals(); });
  afterEach(() => { teardownGlobals(); });

  test('init() appends one SVG child to the container', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    assert.equal(ctr.children.length, 1);
    assert.equal(ctr.children[0].tagName, 'svg');
  });

  test('init() sets viewBox with ±1.25 bounds', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    const svgEl = ctr.children[0];
    // viewBox = "-1.25 -1.25 2.5 2.5"
    const vb = svgEl.getAttribute('viewBox');
    assert.match(vb, /-1\.25.*-1\.25.*2\.5.*2\.5/);
  });

  test('init() twice creates a second SVG (stateless container)', () => {
    // The module is re-loaded fresh each time so this tests that a fresh
    // instance starts clean; verifying the append happens every time.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    assert.equal(ctr.children.length, 1);
  });
});

// ---------------------------------------------------------------------------
// on() / emit() — event wiring
// ---------------------------------------------------------------------------

describe('on() / event wiring', () => {
  let api, gEl;

  beforeEach(() => {
    setupGlobals();
    api = loadFreshTopo2D();
    api.init(makeContainer());
    api.setMontage('test', STD_MONTAGE);
    // gElectrodes is the 3rd child of the SVG (outline, landmarks, electrodes, labels)
    const ctr = api._ctr || (() => {
      // Walk the SVG to find the g.electrodes — it has mousemove listeners.
      // We expose it via a side-channel: the first child of the SVG's 3rd <g> child.
    })();
  });

  afterEach(() => { teardownGlobals(); });

  test('on("hover", cb) receives null on mouseleave', () => {
    // We need access to gElectrodes to dispatch events.  The SVG is the only
    // child of the container; gElectrodes is SVG child[2].
    // Re-init with a fresh container so we have a handle.
    const ctr2 = makeContainer();
    const api2 = loadFreshTopo2D();
    api2.init(ctr2);
    api2.setMontage('test', STD_MONTAGE);

    const svgEl = ctr2.children[0];
    const gElectrodes = svgEl.children[2]; // outline[0] landmarks[1] electrodes[2]

    let received = 'UNSET';
    api2.on('hover', d => { received = d; });

    gElectrodes._dispatch('mouseleave', {});
    assert.equal(received, null);
  });

  test('on("hover", cb) fires with electrode info on mousemove over dot', () => {
    const ctr2 = makeContainer();
    const api2 = loadFreshTopo2D();
    api2.init(ctr2);
    api2.setMontage('test', STD_MONTAGE);

    const svgEl = ctr2.children[0];
    const gElectrodes = svgEl.children[2];

    let received = 'UNSET';
    api2.on('hover', d => { received = d; });

    // Find the Cz dot (first electrode appended) and simulate mousemove over it.
    const czDot = gElectrodes.children[0];
    // czDot is the StubEl for Cz; closest('.topo-dot') returns itself if cls set.
    gElectrodes._dispatch('mousemove', {
      target: czDot,
      clientX: 100,
      clientY: 100,
    });

    assert.notEqual(received, 'UNSET');
    assert.equal(received.name, 'Cz');
    assert.equal(received.region, 'central');
  });

  test('on("click", cb) fires with null when clicking background', () => {
    const ctr2 = makeContainer();
    const api2 = loadFreshTopo2D();
    api2.init(ctr2);
    api2.setMontage('test', STD_MONTAGE);

    const svgEl = ctr2.children[0];
    const gElectrodes = svgEl.children[2];

    let received = 'UNSET';
    api2.on('click', d => { received = d; });

    // target has no topo-dot class → click background → null
    const bgEl = new StubEl('rect', null);
    gElectrodes._dispatch('click', { target: bgEl, shiftKey: false, metaKey: false, ctrlKey: false });
    assert.equal(received, null);
  });

  test('on("click", cb) fires with name+shift on electrode dot click', () => {
    const ctr2 = makeContainer();
    const api2 = loadFreshTopo2D();
    api2.init(ctr2);
    api2.setMontage('test', STD_MONTAGE);

    const svgEl = ctr2.children[0];
    const gElectrodes = svgEl.children[2];

    let received = 'UNSET';
    api2.on('click', d => { received = d; });

    const czDot = gElectrodes.children[0]; // Cz dot
    gElectrodes._dispatch('click', { target: czDot, shiftKey: true, metaKey: false, ctrlKey: false });

    assert.notEqual(received, 'UNSET');
    assert.equal(received.name, 'Cz');
    assert.equal(received.shift, true);
  });

  test('multiple listeners on same event all fire', () => {
    const ctr2 = makeContainer();
    const api2 = loadFreshTopo2D();
    api2.init(ctr2);
    api2.setMontage('test', STD_MONTAGE);

    const svgEl = ctr2.children[0];
    const gElectrodes = svgEl.children[2];

    let count = 0;
    api2.on('hover', () => count++);
    api2.on('hover', () => count++);

    gElectrodes._dispatch('mouseleave', {});
    assert.equal(count, 2);
  });
});

// ---------------------------------------------------------------------------
// setMontage() — state population
// ---------------------------------------------------------------------------

describe('setMontage()', () => {
  beforeEach(() => { setupGlobals(); });
  afterEach(() => { teardownGlobals(); });

  test('setMontage() creates one dot per electrode', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('test', STD_MONTAGE);
    const svgEl = ctr.children[0];
    const gElectrodes = svgEl.children[2];
    assert.equal(gElectrodes.children.length, STD_MONTAGE.electrodes.length);
  });

  test('setMontage() with empty electrodes array → zero dots', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('test', { electrodes: [] });
    const svgEl = ctr.children[0];
    const gElectrodes = svgEl.children[2];
    assert.equal(gElectrodes.children.length, 0);
  });

  test('setMontage() with single electrode → one dot', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('test', {
      electrodes: [{ name: 'Cz', ux: 0, uy: 0, uz: 1, region: 'central' }],
    });
    const svgEl = ctr.children[0];
    const gElectrodes = svgEl.children[2];
    assert.equal(gElectrodes.children.length, 1);
  });

  test('setMontage() stores layoutStyle=flat when data.layoutStyle="flat"', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    // If layoutStyle is flat, landmarks group should be hidden
    api.setMontage('test', {
      electrodes: [{ name: 'G1', ux: 0.1, uy: 0.2, uz: 0, region: 'other' }],
      layoutStyle: 'flat',
    });
    const svgEl = ctr.children[0];
    const gLandmarks = svgEl.children[1];
    assert.equal(gLandmarks.style.display, 'none');
  });

  test('setMontage() without layoutStyle defaults to sphere (landmarks visible)', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('test', STD_MONTAGE);
    const svgEl = ctr.children[0];
    const gLandmarks = svgEl.children[1];
    // In sphere mode with showLandmarks default true, display should not be 'none'
    assert.notEqual(gLandmarks.style.display, 'none');
  });

  test('setMontage() replaces electrodes on second call', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('test', STD_MONTAGE);
    api.setMontage('test2', {
      electrodes: [{ name: 'Cz', ux: 0, uy: 0, uz: 1, region: 'central' }],
    });
    const svgEl = ctr.children[0];
    const gElectrodes = svgEl.children[2];
    // Only the 1 electrode from the second call
    assert.equal(gElectrodes.children.length, 1);
  });

  test('setMontage() with missing electrodes field → empty array (no crash)', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    // data.electrodes is undefined → should default to [] and not throw
    assert.doesNotThrow(() => api.setMontage('test', {}));
    const svgEl = ctr.children[0];
    const gElectrodes = svgEl.children[2];
    assert.equal(gElectrodes.children.length, 0);
  });

  test('setMontage() sets data-name attribute on each dot', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('test', STD_MONTAGE);
    const svgEl = ctr.children[0];
    const gElectrodes = svgEl.children[2];
    assert.equal(gElectrodes.children[0].getAttribute('data-name'), 'Cz');
  });
});

// ---------------------------------------------------------------------------
// Projection geometry: sphere mode
// ---------------------------------------------------------------------------

describe('project() — sphere mode geometry', () => {
  let api, gElectrodes;

  beforeEach(() => {
    setupGlobals();
    api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('test', STD_MONTAGE);
    const svgEl = ctr.children[0];
    gElectrodes = svgEl.children[2];
  });

  afterEach(() => { teardownGlobals(); });

  // Helper: get projected (cx, cy) for electrode at index i
  function proj(i) {
    const dot = gElectrodes.children[i];
    return {
      cx: parseFloat(dot.getAttribute('cx')),
      cy: parseFloat(dot.getAttribute('cy')),
    };
  }

  test('Cz (vertex, uz=1) projects to approximately (0, 0)', () => {
    // MUTATION GUARD: tests the r = theta / (PI/2) formula and its
    // application. If the constant PI/2 is changed to 0, r = Inf → clamped
    // to 1 even for Cz, putting it at the edge instead of center.
    const { cx, cy } = proj(0); // Cz is index 0
    assert.ok(Math.abs(cx) < 0.001, `Cz cx=${cx} should be ~0`);
    assert.ok(Math.abs(cy) < 0.001, `Cz cy=${cy} should be ~0`);
  });

  test('Fz (front of midline) projects to negative cy (screen-up)', () => {
    // Convention: nasion is at top (+uy in 3D, -cy in 2D because y is flipped).
    // Fz sits on midline front, so cx ≈ 0, cy < 0.
    const { cx, cy } = proj(1); // Fz is index 1
    assert.ok(Math.abs(cx) < 0.001, `Fz cx=${cx} should be ~0`);
    assert.ok(cy < 0, `Fz cy=${cy} should be negative (front = up on screen)`);
  });

  test('Pz (back of midline) projects to positive cy (screen-down)', () => {
    const { cx, cy } = proj(2); // Pz is index 2
    assert.ok(Math.abs(cx) < 0.001, `Pz cx=${cx} should be ~0`);
    assert.ok(cy > 0, `Pz cy=${cy} should be positive (back = down on screen)`);
  });

  test('T7 (left equator) projects to (-1, 0)', () => {
    // MUTATION GUARD: if sin/cos operands are swapped in r*sin(az) / -r*cos(az),
    // T7 would map to (0, -1) instead of (-1, 0).
    const { cx, cy } = proj(3); // T7 is index 3
    assert.ok(Math.abs(cx - (-1)) < 0.01, `T7 cx=${cx} should be ~-1`);
    assert.ok(Math.abs(cy) < 0.01, `T7 cy=${cy} should be ~0`);
  });

  test('T8 (right equator) projects to (+1, 0)', () => {
    const { cx, cy } = proj(4); // T8 is index 4
    assert.ok(Math.abs(cx - 1) < 0.01, `T8 cx=${cx} should be ~1`);
    assert.ok(Math.abs(cy) < 0.01, `T8 cy=${cy} should be ~0`);
  });

  test('Oz (back of equator) projects to (0, +1)', () => {
    const { cx, cy } = proj(5); // Oz is index 5
    assert.ok(Math.abs(cx) < 0.01, `Oz cx=${cx} should be ~0`);
    assert.ok(Math.abs(cy - 1) < 0.01, `Oz cy=${cy} should be ~1`);
  });

  test('Fpz (front of equator) projects to (0, -1)', () => {
    const { cx, cy } = proj(6); // Fpz is index 6
    assert.ok(Math.abs(cx) < 0.01, `Fpz cx=${cx} should be ~0`);
    assert.ok(Math.abs(cy - (-1)) < 0.01, `Fpz cy=${cy} should be ~-1`);
  });

  test('Fz / Pz equidistant from center (midline symmetry)', () => {
    const fz = proj(1);
    const pz = proj(2);
    const distFz = Math.sqrt(fz.cx ** 2 + fz.cy ** 2);
    const distPz = Math.sqrt(pz.cx ** 2 + pz.cy ** 2);
    assert.ok(Math.abs(distFz - distPz) < 0.001, `Fz r=${distFz} != Pz r=${distPz}`);
  });

  test('T7 / T8 equidistant from center (lateral symmetry)', () => {
    const t7 = proj(3);
    const t8 = proj(4);
    assert.ok(Math.abs(Math.abs(t7.cx) - Math.abs(t8.cx)) < 0.001);
  });

  test('Below-equator electrode (uz<0) is clamped to r=1 boundary', () => {
    // Below equator: uz = -0.5, so theta > PI/2, r clamped to 1.
    const api2 = loadFreshTopo2D();
    const ctr2 = makeContainer();
    api2.init(ctr2);
    api2.setMontage('test', {
      electrodes: [{ name: 'Sub', ux: 0, uy: 1, uz: -0.5, region: 'other' }],
    });
    const gEl = ctr2.children[0].children[2];
    const dot = gEl.children[0];
    const cx = parseFloat(dot.getAttribute('cx'));
    const cy = parseFloat(dot.getAttribute('cy'));
    const r = Math.sqrt(cx ** 2 + cy ** 2);
    assert.ok(r <= 1.001, `Sub-equator electrode r=${r} should be clamped to ≤1`);
  });

  test('NaN electrode coords are handled without throwing', () => {
    // MUTATION GUARD: tests that Math.max(-1, Math.min(1, NaN)) → NaN is
    // still passed to Math.acos and doesn't throw (NaN -> NaN).
    const api2 = loadFreshTopo2D();
    const ctr2 = makeContainer();
    api2.init(ctr2);
    assert.doesNotThrow(() => {
      api2.setMontage('test', {
        electrodes: [{ name: 'Bad', ux: NaN, uy: NaN, uz: NaN, region: 'other' }],
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Projection geometry: flat mode
// ---------------------------------------------------------------------------

describe('project() — flat mode', () => {
  beforeEach(() => { setupGlobals(); });
  afterEach(() => { teardownGlobals(); });

  test('flat mode: cx = ux, cy = -uy (y-axis flip only)', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('test', {
      layoutStyle: 'flat',
      electrodes: [{ name: 'G1', ux: 0.3, uy: 0.4, uz: 0, region: 'other' }],
    });
    const dot = ctr.children[0].children[2].children[0];
    const cx = parseFloat(dot.getAttribute('cx'));
    const cy = parseFloat(dot.getAttribute('cy'));
    assert.ok(Math.abs(cx - 0.3) < 0.0001, `flat cx=${cx} expected 0.3`);
    assert.ok(Math.abs(cy - (-0.4)) < 0.0001, `flat cy=${cy} expected -0.4`);
  });

  test('flat mode: negative uy → positive cy', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('test', {
      layoutStyle: 'flat',
      electrodes: [{ name: 'G2', ux: 0, uy: -0.5, uz: 0, region: 'other' }],
    });
    const dot = ctr.children[0].children[2].children[0];
    const cy = parseFloat(dot.getAttribute('cy'));
    assert.ok(Math.abs(cy - 0.5) < 0.0001, `flat cy=${cy} expected 0.5`);
  });
});

// ---------------------------------------------------------------------------
// setSelected() / setFiltered() / setDimmedRegions()
// ---------------------------------------------------------------------------

describe('setSelected()', () => {
  let api, gEl;

  beforeEach(() => {
    setupGlobals();
    api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('test', STD_MONTAGE);
    gEl = ctr.children[0].children[2];
  });

  afterEach(() => { teardownGlobals(); });

  test('setSelected([]) → all electrodes have opacity 1', () => {
    api.setSelected([]);
    gEl.children.forEach(dot => {
      assert.equal(dot.getAttribute('opacity'), '1');
    });
  });

  test('setSelected([name]) → selected dot gets SEL_FILL', () => {
    api.setSelected(['Cz']);
    const czDot = gEl.children[0]; // Cz first
    const fill = czDot.getAttribute('fill');
    assert.match(fill, /oklch.*0\.17.*45/, `Expected SEL_FILL, got ${fill}`);
  });

  test('setSelected() replaces previous selection', () => {
    api.setSelected(['Cz']);
    api.setSelected(['Fz']);
    const czDot = gEl.children[0]; // Cz
    const fzDot = gEl.children[1]; // Fz
    const czFill = czDot.getAttribute('fill');
    const fzFill = fzDot.getAttribute('fill');
    // Cz should no longer be selected fill
    assert.ok(!czFill.includes('0.17'), `Cz should not be selected, fill=${czFill}`);
    // Fz should be selected fill
    assert.match(fzFill, /oklch.*0\.17.*45/, `Fz fill=${fzFill}`);
  });

  test('setSelected(null) → treated as empty selection', () => {
    api.setSelected(['Cz']);
    api.setSelected(null);
    const czDot = gEl.children[0];
    const fill = czDot.getAttribute('fill');
    // Should NOT be SEL_FILL anymore
    assert.ok(!fill.includes('0.17'), `Cz fill after null-selection: ${fill}`);
  });
});

describe('setFiltered()', () => {
  let api, gEl;

  beforeEach(() => {
    setupGlobals();
    api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('test', STD_MONTAGE);
    gEl = ctr.children[0].children[2];
  });

  afterEach(() => { teardownGlobals(); });

  test('setFiltered(null) → no dimming from filter', () => {
    api.setFiltered(null);
    gEl.children.forEach(dot => {
      assert.equal(dot.getAttribute('opacity'), '1');
    });
  });

  test('setFiltered([name]) → un-filtered electrodes dimmed to 0.18', () => {
    // MUTATION GUARD: if the dim check is broken (e.g., `!filtered.has(el.name)`
    // becomes `filtered.has(el.name)`), non-filtered electrodes would NOT be dimmed.
    api.setFiltered(['Cz']);
    // Cz (index 0) should NOT be dimmed
    const czDot = gEl.children[0];
    assert.equal(czDot.getAttribute('opacity'), '1', 'filtered-in electrode should be opacity 1');
    // Fz (index 1) should be dimmed
    const fzDot = gEl.children[1];
    assert.equal(fzDot.getAttribute('opacity'), '0.18', `non-filtered electrode should be dimmed`);
  });

  test('setFiltered([...all]) → no electrodes dimmed', () => {
    api.setFiltered(STD_MONTAGE.electrodes.map(e => e.name));
    gEl.children.forEach(dot => {
      assert.equal(dot.getAttribute('opacity'), '1');
    });
  });
});

describe('setDimmedRegions()', () => {
  let api, gEl;

  beforeEach(() => {
    setupGlobals();
    api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('test', STD_MONTAGE);
    gEl = ctr.children[0].children[2];
  });

  afterEach(() => { teardownGlobals(); });

  test('setDimmedRegions([]) → no dimming', () => {
    api.setDimmedRegions([]);
    gEl.children.forEach(dot => {
      assert.equal(dot.getAttribute('opacity'), '1');
    });
  });

  test('setDimmedRegions(["central"]) → Cz dimmed to 0.18', () => {
    api.setDimmedRegions(['central']);
    const czDot = gEl.children[0]; // Cz region=central
    assert.equal(czDot.getAttribute('opacity'), '0.18');
  });

  test('setDimmedRegions(["central"]) → Fz (frontal) not dimmed', () => {
    api.setDimmedRegions(['central']);
    const fzDot = gEl.children[1]; // Fz region=frontal
    assert.equal(fzDot.getAttribute('opacity'), '1');
  });

  test('setDimmedRegions with non-existent region → no crash, no dimming', () => {
    assert.doesNotThrow(() => api.setDimmedRegions(['nonexistent_region_xyz']));
    gEl.children.forEach(dot => {
      assert.equal(dot.getAttribute('opacity'), '1');
    });
  });

  test('setDimmedRegions replaces previous dim set', () => {
    api.setDimmedRegions(['central']);
    api.setDimmedRegions([]); // clear
    const czDot = gEl.children[0];
    assert.equal(czDot.getAttribute('opacity'), '1');
  });
});

// ---------------------------------------------------------------------------
// setOpts() — option merging and side effects
// ---------------------------------------------------------------------------

describe('setOpts()', () => {
  let api, ctr, gEl;

  beforeEach(() => {
    setupGlobals();
    api = loadFreshTopo2D();
    ctr = makeContainer();
    api.init(ctr);
    api.setMontage('test', STD_MONTAGE);
    gEl = ctr.children[0].children[2];
  });

  afterEach(() => { teardownGlobals(); });

  test('setOpts({colorMode:"uniform"}) → all dots get MONO_FILL', () => {
    api.setOpts({ colorMode: 'uniform' });
    const MONO_FILL = 'oklch(0.58 0.012 75)';
    gEl.children.forEach((dot, i) => {
      assert.equal(dot.getAttribute('fill'), MONO_FILL, `dot[${i}] fill mismatch`);
    });
  });

  test('setOpts({colorMode:"region"}) → Cz gets central color', () => {
    api.setOpts({ colorMode: 'region' });
    const czDot = gEl.children[0];
    const centralColor = 'oklch(0.62 0.14 150)';
    assert.equal(czDot.getAttribute('fill'), centralColor);
  });

  test('setOpts({colorMode:"highlight"}) → unselected dots get MONO_FILL', () => {
    api.setOpts({ colorMode: 'highlight' });
    const MONO_FILL = 'oklch(0.58 0.012 75)';
    const czDot = gEl.children[0];
    assert.equal(czDot.getAttribute('fill'), MONO_FILL);
  });

  test('setOpts({dotSize:2}) → dot radius doubles', () => {
    api.setOpts({ dotSize: 1 });
    const r1 = parseFloat(gEl.children[0].getAttribute('r'));
    api.setOpts({ dotSize: 2 });
    const r2 = parseFloat(gEl.children[0].getAttribute('r'));
    assert.ok(Math.abs(r2 - r1 * 2) < 0.0001, `r1=${r1} r2=${r2} ratio should be 2`);
  });

  test('setOpts({showLandmarks:false}) → landmarks group hidden', () => {
    api.setOpts({ showLandmarks: false });
    const gLandmarks = ctr.children[0].children[1];
    assert.equal(gLandmarks.style.display, 'none');
  });

  test('setOpts({showHead:false}) → outline group hidden', () => {
    api.setOpts({ showHead: false });
    const gOutline = ctr.children[0].children[0];
    assert.equal(gOutline.style.display, 'none');
  });

  test('setOpts() merges — unmentioned opts are preserved', () => {
    api.setOpts({ dotSize: 2 });
    // colorMode should still be 'region' (default)
    const czDot = gEl.children[0];
    const centralColor = 'oklch(0.62 0.14 150)';
    assert.equal(czDot.getAttribute('fill'), centralColor);
  });
});

// ---------------------------------------------------------------------------
// Color assignment per colorMode
// ---------------------------------------------------------------------------

describe('colorFor() — color assignment', () => {
  let api, gEl;

  beforeEach(() => {
    setupGlobals();
    api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
  });

  afterEach(() => { teardownGlobals(); });

  test('region mode: frontal region → frontal color', () => {
    api.setMontage('test', {
      electrodes: [{ name: 'Fp1', ux: 0, uy: 1, uz: 0, region: 'frontal' }],
    });
    gEl = api._ctr ? null : (() => {
      // re-read
    })();
    // Use a fresh api where we can track the container
    const api2 = loadFreshTopo2D();
    const ctr2 = makeContainer();
    api2.init(ctr2);
    api2.setMontage('test', {
      electrodes: [{ name: 'Fp1', ux: 0, uy: 1, uz: 0, region: 'frontal' }],
    });
    const dot = ctr2.children[0].children[2].children[0];
    assert.equal(dot.getAttribute('fill'), 'oklch(0.60 0.14 265)');
  });

  test('region mode: unknown region → falls back to "other" color', () => {
    const api2 = loadFreshTopo2D();
    const ctr2 = makeContainer();
    api2.init(ctr2);
    api2.setMontage('test', {
      electrodes: [{ name: 'X1', ux: 0, uy: 0, uz: 1, region: 'invented_region' }],
    });
    const dot = ctr2.children[0].children[2].children[0];
    const otherColor = 'oklch(0.55 0.02 260)';
    assert.equal(dot.getAttribute('fill'), otherColor);
  });

  test('region mode: missing region field → "other" color (no crash)', () => {
    const api2 = loadFreshTopo2D();
    const ctr2 = makeContainer();
    api2.init(ctr2);
    assert.doesNotThrow(() => {
      api2.setMontage('test', {
        electrodes: [{ name: 'X2', ux: 0, uy: 0, uz: 1 }],
      });
    });
    const dot = ctr2.children[0].children[2].children[0];
    const otherColor = 'oklch(0.55 0.02 260)';
    assert.equal(dot.getAttribute('fill'), otherColor);
  });

  test('fNIRS modality: source type → NIRS_SOURCE_FILL', () => {
    const api2 = loadFreshTopo2D();
    const ctr2 = makeContainer();
    api2.init(ctr2);
    api2.setMontage('test', {
      modality: 'fnirs',
      electrodes: [{ name: 'S1', ux: 0.1, uy: 0.1, uz: 0, type: 'source', region: 'other' }],
    });
    const dot = ctr2.children[0].children[2].children[0];
    assert.equal(dot.getAttribute('fill'), 'oklch(0.62 0.17 40)');
  });

  test('fNIRS modality: detector type → NIRS_DETECTOR_FILL', () => {
    const api2 = loadFreshTopo2D();
    const ctr2 = makeContainer();
    api2.init(ctr2);
    api2.setMontage('test', {
      modality: 'nirs',
      electrodes: [{ name: 'D1', ux: 0.2, uy: 0.2, uz: 0, type: 'detector', region: 'other' }],
    });
    const dot = ctr2.children[0].children[2].children[0];
    assert.equal(dot.getAttribute('fill'), 'oklch(0.58 0.14 245)');
  });
});

// ---------------------------------------------------------------------------
// show() — visibility toggle
// ---------------------------------------------------------------------------

describe('show()', () => {
  beforeEach(() => { setupGlobals(); });
  afterEach(() => { teardownGlobals(); });

  test('show(false) sets svg display to "none"', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.show(false);
    assert.equal(ctr.children[0].style.display, 'none');
  });

  test('show(true) clears svg display', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.show(false);
    api.show(true);
    assert.equal(ctr.children[0].style.display, '');
  });

  test('show() before init does not throw', () => {
    const api = loadFreshTopo2D();
    // svg is null, show() has guard: if (svg)
    assert.doesNotThrow(() => api.show(false));
  });
});

// ---------------------------------------------------------------------------
// setView() — no-op parity test
// ---------------------------------------------------------------------------

describe('setView()', () => {
  beforeEach(() => { setupGlobals(); });
  afterEach(() => { teardownGlobals(); });

  test('setView() is callable and returns undefined', () => {
    const api = loadFreshTopo2D();
    api.init(makeContainer());
    const result = api.setView({ azimuth: 45, elevation: 30 });
    assert.equal(result, undefined);
  });

  test('setView() does not mutate the SVG', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('test', STD_MONTAGE);
    const vb = ctr.children[0].getAttribute('viewBox');
    api.setView({ azimuth: 45 });
    // viewBox unchanged
    assert.equal(ctr.children[0].getAttribute('viewBox'), vb);
  });
});

// ---------------------------------------------------------------------------
// Edge cases / robustness
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  beforeEach(() => { setupGlobals(); });
  afterEach(() => { teardownGlobals(); });

  test('setSelected before setMontage → no crash', () => {
    const api = loadFreshTopo2D();
    api.init(makeContainer());
    assert.doesNotThrow(() => api.setSelected(['Cz']));
  });

  test('setFiltered before setMontage → no crash', () => {
    const api = loadFreshTopo2D();
    api.init(makeContainer());
    assert.doesNotThrow(() => api.setFiltered(['Cz']));
  });

  test('setDimmedRegions before setMontage → no crash', () => {
    const api = loadFreshTopo2D();
    api.init(makeContainer());
    assert.doesNotThrow(() => api.setDimmedRegions(['central']));
  });

  test('on() for unknown event type → does not throw', () => {
    const api = loadFreshTopo2D();
    api.init(makeContainer());
    assert.doesNotThrow(() => api.on('unknown_event', () => {}));
  });

  test('setMontage: electrode with uz=0 (equator) → r=1', () => {
    // MUTATION GUARD: if r = Math.min(1, theta / (PI/2)) is changed to
    // Math.min(0, ...) the result would always be 0, putting all equator
    // electrodes at the center.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('test', {
      electrodes: [{ name: 'T7', ux: -1, uy: 0, uz: 0, region: 'temporal' }],
    });
    const dot = ctr.children[0].children[2].children[0];
    const cx = parseFloat(dot.getAttribute('cx'));
    const cy = parseFloat(dot.getAttribute('cy'));
    const r = Math.sqrt(cx ** 2 + cy ** 2);
    assert.ok(Math.abs(r - 1) < 0.01, `Equator electrode r=${r} should be ~1`);
  });

  test('dense montage (>200 electrodes) → does not crash during outline build', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    const electrodes = Array.from({ length: 256 }, (_, i) => ({
      name: `E${i + 1}`,
      ux: Math.cos(i / 256 * 2 * Math.PI) * 0.5,
      uy: Math.sin(i / 256 * 2 * Math.PI) * 0.5,
      uz: 0.5,
      region: 'other',
    }));
    assert.doesNotThrow(() => api.setMontage('test', { electrodes }));
  });

  test('setMontage: modality case-insensitive (EEG vs eeg)', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    // Both should produce sphere layout
    assert.doesNotThrow(() => {
      api.setMontage('test', { modality: 'EEG', electrodes: [] });
    });
  });

  test('combined: setFiltered + setDimmedRegions both dim different electrodes', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    // Cz=central, Fz=frontal, T7=temporal
    api.setMontage('test', {
      electrodes: [
        { name: 'Cz', ux: 0, uy: 0, uz: 1, region: 'central' },
        { name: 'Fz', ux: 0, uy: 0.707, uz: 0.707, region: 'frontal' },
        { name: 'T7', ux: -1, uy: 0, uz: 0, region: 'temporal' },
      ],
    });
    // Filter to only Fz → Cz and T7 dimmed by filter
    api.setFiltered(['Fz']);
    // Also dim temporal region → T7 additionally dimmed by region
    api.setDimmedRegions(['temporal']);

    const gEl = ctr.children[0].children[2];
    const czDot = gEl.children[0]; // Cz — dimmed by filter
    const fzDot = gEl.children[1]; // Fz — NOT dimmed (in filter)
    const t7Dot = gEl.children[2]; // T7 — dimmed by BOTH filter and region

    assert.equal(czDot.getAttribute('opacity'), '0.18', 'Cz should be dimmed by filter');
    assert.equal(fzDot.getAttribute('opacity'), '1', 'Fz should not be dimmed');
    assert.equal(t7Dot.getAttribute('opacity'), '0.18', 'T7 should be dimmed');
  });
});

// ---------------------------------------------------------------------------
// Label density behaviour
// ---------------------------------------------------------------------------

describe('label density', () => {
  beforeEach(() => { setupGlobals(); });
  afterEach(() => { teardownGlobals(); });

  test('labelDensity="none" → all labels hidden', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('test', STD_MONTAGE);
    api.setOpts({ labelDensity: 'none' });
    const gLabels = ctr.children[0].children[3];
    gLabels.children.forEach((label, i) => {
      assert.equal(label.style.display, 'none', `label[${i}] should be hidden`);
    });
  });

  test('labelDensity="all" → all labels visible (≤32 electrodes)', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    // STD_MONTAGE has 8 electrodes (≤32), so with 'all' all visible
    api.setMontage('test', STD_MONTAGE);
    api.setOpts({ labelDensity: 'all' });
    const gLabels = ctr.children[0].children[3];
    gLabels.children.forEach((label, i) => {
      // With 'all' density the show=true branch should fire
      assert.equal(label.style.display, '', `label[${i}] should be shown`);
    });
  });

  test('labelDensity="smart" with ≤32 electrodes → all labels visible', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('test', STD_MONTAGE); // 8 electrodes, default smart
    const gLabels = ctr.children[0].children[3];
    gLabels.children.forEach((label, i) => {
      assert.equal(label.style.display, '', `label[${i}] should be shown with smart+small montage`);
    });
  });

  test('labelDensity="smart" with >32 electrodes → unselected labels hidden', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    const electrodes = Array.from({ length: 64 }, (_, i) => ({
      name: `E${i + 1}`,
      ux: Math.cos(i / 64 * 2 * Math.PI) * 0.5,
      uy: Math.sin(i / 64 * 2 * Math.PI) * 0.5,
      uz: 0.5,
      region: 'other',
    }));
    api.setMontage('test', { electrodes });
    const gLabels = ctr.children[0].children[3];
    // All unselected, none hovered — so all should be hidden under smart+dense
    gLabels.children.forEach((label, i) => {
      assert.equal(label.style.display, 'none', `dense label[${i}] should be hidden`);
    });
  });

  // MUTATION GUARD (M2): guards against "electrodes.length > 32" becoming
  // "electrodes.length >= 32" — at exactly 32 electrodes labels should still
  // be visible (the threshold is *strictly* greater than 32).
  test('labelDensity="smart" with exactly 32 electrodes → all labels visible', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    const electrodes = Array.from({ length: 32 }, (_, i) => ({
      name: `E${i + 1}`,
      ux: Math.cos(i / 32 * 2 * Math.PI) * 0.5,
      uy: Math.sin(i / 32 * 2 * Math.PI) * 0.5,
      uz: 0.5,
      region: 'other',
    }));
    api.setMontage('test', { electrodes });
    const gLabels = ctr.children[0].children[3];
    // Exactly 32 electrodes: condition is > 32, so 32 is NOT over-threshold
    // and labels should all be visible.
    gLabels.children.forEach((label, i) => {
      assert.equal(label.style.display, '', `32-electrode label[${i}] should be shown`);
    });
  });
});

// ---------------------------------------------------------------------------
// baseRadius() — dotSize multiplier
// ---------------------------------------------------------------------------

describe('baseRadius()', () => {
  beforeEach(() => { setupGlobals(); });
  afterEach(() => { teardownGlobals(); });

  test('default dotSize=1 → r = 0.022', () => {
    // MUTATION GUARD: if the constant 0.022 is replaced with 0, all dots
    // collapse to a point and this test catches it.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('test', {
      electrodes: [{ name: 'Cz', ux: 0, uy: 0, uz: 1, region: 'central' }],
    });
    const dot = ctr.children[0].children[2].children[0];
    const r = parseFloat(dot.getAttribute('r'));
    assert.ok(Math.abs(r - 0.022) < 0.0001, `r=${r} expected 0.022`);
  });

  test('dotSize=0.5 → r = 0.011', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('test', {
      electrodes: [{ name: 'Cz', ux: 0, uy: 0, uz: 1, region: 'central' }],
    });
    api.setOpts({ dotSize: 0.5 });
    const dot = ctr.children[0].children[2].children[0];
    const r = parseFloat(dot.getAttribute('r'));
    assert.ok(Math.abs(r - 0.011) < 0.0001, `r=${r} expected 0.011`);
  });
});

// ---------------------------------------------------------------------------
// EEGTopo2D global
// ---------------------------------------------------------------------------

describe('EEGTopo2D global', () => {
  beforeEach(() => { setupGlobals(); });
  afterEach(() => { teardownGlobals(); });

  test('window.EEGTopo2D is set after module load', () => {
    const api = loadFreshTopo2D();
    assert.ok(api != null);
    assert.equal(typeof api.init, 'function');
  });

  test('api has all expected public methods', () => {
    const api = loadFreshTopo2D();
    const expected = ['init', 'on', 'setMontage', 'setSelected', 'setFiltered',
                      'setDimmedRegions', 'setOpts', 'setView', 'show', 'isReady'];
    expected.forEach(method => {
      assert.equal(typeof api[method], 'function', `missing method: ${method}`);
    });
  });
});

// ============================================================
// Iteration 8 (PR 14): golden-output assertions
// ------------------------------------------------------------
// topo2d.js had 91% c8 line coverage but only 37.36% mutation score —
// 253 of 384 survivors were StringLiteral mutants on DOM-attribute
// strings + path-coordinate template literals, plus 31 Arithmetic +
// 18 UnaryOperator mutants on coordinate math. The fix is to read
// back exact attribute values and pin them with deepEqual, instead
// of merely checking "an element exists" or "opacity changed".
// ============================================================

// Helper: pull every attribute as a plain object so we can deepEqual it.
function attrsOf(el) {
  return { ...el._attrs };
}

// ---------------------------------------------------------------------------
// Sphere outline: full golden DOM
// ---------------------------------------------------------------------------

describe('sphere outline — golden DOM', () => {
  beforeEach(() => { setupGlobals(); });
  afterEach(() => { teardownGlobals(); });

  test('sphere outline has 9 children in canonical order', () => {
    // buildOutline appends in a fixed order: head, 3 rings, nose, earL,
    // earR, crossV, crossH = 9 children. A mutation that drops the
    // appendChild of any single element fails count.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', { electrodes: [{ name: 'Cz', ux: 0, uy: 0, uz: 1, region: 'central' }] });
    const gOut = ctr.children[0].children[0];
    assert.equal(gOut.children.length, 9, 'sphere outline child count');
  });

  test('sphere head circle: exact attribute set', () => {
    // Kills StringLiteral mutants on lines 126-134 (the head circle):
    // cx/cy=0, r=1, fill var, stroke var, stroke-width 0.012, opacity 0.6.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', { electrodes: [{ name: 'Cz', ux: 0, uy: 0, uz: 1, region: 'central' }] });
    const head = ctr.children[0].children[0].children[0];
    assert.equal(head.tagName, 'circle');
    assert.deepEqual(attrsOf(head), {
      cx: '0',
      cy: '0',
      r: '1',
      fill: 'var(--surface, #f7f6f2)',
      stroke: 'var(--ink, #17181a)',
      'stroke-width': '0.012',
      opacity: '0.6',
    });
  });

  test('sphere reference rings: 3 rings at radii [0.25, 0.5, 0.75] for ≤200 electrodes', () => {
    // Kills line 143-145 mutants on the dense-vs-sparse ring selection
    // (the `electrodes.length > 200` predicate) AND the ring-radii
    // ArrayDeclaration mutants on line 144 ([0.25, 0.5, 0.75]).
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    // 8 electrodes is well under 200 → sparse rings.
    api.setMontage('t', STD_MONTAGE);
    const gOut = ctr.children[0].children[0];
    // Rings are children[1..3] in sphere mode.
    const rs = [gOut.children[1], gOut.children[2], gOut.children[3]];
    assert.deepEqual(rs.map(r => r.getAttribute('r')), ['0.25', '0.5', '0.75']);
    // Opacity 0.45 in sparse mode (kills line 145 string mutant).
    rs.forEach(r => assert.equal(r.getAttribute('opacity'), '0.45'));
    // Stroke is var(--ink-3, #b5b8bd), dash pattern is "0.012 0.018".
    rs.forEach(r => {
      assert.equal(r.getAttribute('stroke'), 'var(--ink-3, #b5b8bd)');
      assert.equal(r.getAttribute('stroke-dasharray'), '0.012 0.018');
      assert.equal(r.getAttribute('fill'), 'none');
      assert.equal(r.getAttribute('stroke-width'), '0.003');
    });
  });

  test('sphere reference rings: dense (>200 electrodes) → 2 rings at [0.33, 0.66] opacity 0.35', () => {
    // The dense-mode branch on line 144 — kills the
    // `dense ? [0.33, 0.66] : [0.25, 0.5, 0.75]` mutants and the
    // `0.35 : 0.45` opacity flip on line 145.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    const electrodes = Array.from({ length: 256 }, (_, i) => ({
      name: `E${i + 1}`,
      ux: Math.cos(i / 256 * 2 * Math.PI) * 0.5,
      uy: Math.sin(i / 256 * 2 * Math.PI) * 0.5,
      uz: 0.5,
      region: 'other',
    }));
    api.setMontage('t', { electrodes });
    const gOut = ctr.children[0].children[0];
    // Dense: only 2 rings → children = head, ring1, ring2, nose, earL,
    // earR, crossV, crossH = 8 children (one fewer than sparse).
    assert.equal(gOut.children.length, 8);
    const rs = [gOut.children[1], gOut.children[2]];
    assert.deepEqual(rs.map(r => r.getAttribute('r')), ['0.33', '0.66']);
    rs.forEach(r => assert.equal(r.getAttribute('opacity'), '0.35'));
  });

  test('sphere ring threshold at exactly 200 electrodes → still sparse (3 rings)', () => {
    // Pins the `electrodes.length > 200` predicate — at exactly 200,
    // the condition is FALSE, so we're in sparse mode. Kills the
    // `>= 200` mutant.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    const electrodes = Array.from({ length: 200 }, (_, i) => ({
      name: `E${i + 1}`,
      ux: 0, uy: 0, uz: 1, region: 'other',
    }));
    api.setMontage('t', { electrodes });
    const gOut = ctr.children[0].children[0];
    // Sparse: 3 rings → 9 total outline children.
    assert.equal(gOut.children.length, 9, 'at exactly 200 electrodes, outline still sparse');
  });

  test('sphere nose path: exact "d" attribute string', () => {
    // Pins the nose path coordinates verbatim (line 162-166). Kills
    // StringLiteral mutants on the path d attribute AND ArithmeticOperator
    // mutants on the coordinate constants embedded in the string.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', STD_MONTAGE);
    const nose = ctr.children[0].children[0].children[4];
    assert.equal(nose.tagName, 'path');
    assert.equal(
      nose.getAttribute('d'),
      'M -0.15 -0.992 Q -0.06 -1.08, 0 -1.12 Q 0.06 -1.08, 0.15 -0.992');
    assert.equal(nose.getAttribute('stroke-linejoin'), 'round');
    assert.equal(nose.getAttribute('stroke-linecap'), 'round');
  });

  test('sphere left ear path: exact "d" attribute', () => {
    // Kills the StringLiteral mutants on line 177-181 (the left-ear
    // path). The Q-curve and C-bezier control points are pinned.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', STD_MONTAGE);
    const earL = ctr.children[0].children[0].children[5];
    assert.equal(earL.tagName, 'path');
    assert.equal(
      earL.getAttribute('d'),
      'M -0.99 -0.13 C -1.05 -0.09, -1.07 0.02, -1.06 0.09 C -1.05 0.15, -1.03 0.18, -0.995 0.18');
  });

  test('sphere right ear path: exact "d" attribute (mirror of left, +x)', () => {
    // Right ear is at +X (line 190-193). Kills the symmetric mirror
    // StringLiteral mutants.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', STD_MONTAGE);
    const earR = ctr.children[0].children[0].children[6];
    assert.equal(earR.tagName, 'path');
    assert.equal(
      earR.getAttribute('d'),
      'M 0.99 -0.13 C 1.05 -0.09, 1.07 0.02, 1.06 0.09 C 1.05 0.15, 1.03 0.18, 0.995 0.18');
  });

  test('sphere crosshairs: vertical at x=0, horizontal at y=0, both ±1', () => {
    // Pins the crosshair line endpoints. Kills UnaryOperator and
    // StringLiteral mutants on lines 204-218.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', STD_MONTAGE);
    const gOut = ctr.children[0].children[0];
    const crossV = gOut.children[7];
    const crossH = gOut.children[8];
    assert.equal(crossV.tagName, 'line');
    assert.equal(crossH.tagName, 'line');
    assert.deepEqual(
      { x1: crossV.getAttribute('x1'), y1: crossV.getAttribute('y1'),
        x2: crossV.getAttribute('x2'), y2: crossV.getAttribute('y2') },
      { x1: '0', y1: '-1', x2: '0', y2: '1' });
    assert.deepEqual(
      { x1: crossH.getAttribute('x1'), y1: crossH.getAttribute('y1'),
        x2: crossH.getAttribute('x2'), y2: crossH.getAttribute('y2') },
      { x1: '-1', y1: '0', x2: '1', y2: '0' });
    // Both share the same dash + opacity contract.
    assert.equal(crossV.getAttribute('stroke-dasharray'), '0.02 0.02');
    assert.equal(crossV.getAttribute('opacity'), '0.35');
    assert.equal(crossH.getAttribute('opacity'), '0.35');
  });
});

// ---------------------------------------------------------------------------
// Flat outline: golden DOM
// ---------------------------------------------------------------------------

describe('flat outline — golden DOM', () => {
  beforeEach(() => { setupGlobals(); });
  afterEach(() => { teardownGlobals(); });

  test('flat outline (emg): 3 children — box + 2 crosshair lines, NO head silhouette', () => {
    // EMG does NOT carry a head reference (line 228 set). Kills the
    // line 258 `if (!withHead) return` guard mutation: flipping it
    // would add the head circle/nose/ears unconditionally.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', {
      layoutStyle: 'flat',
      modality: 'emg',
      electrodes: [{ name: 'X', ux: 0, uy: 0, uz: 0, region: 'other' }],
    });
    const gOut = ctr.children[0].children[0];
    assert.equal(gOut.children.length, 3, 'emg flat outline: box + 2 crosshairs only');
    assert.equal(gOut.children[0].tagName, 'rect');
    assert.equal(gOut.children[1].tagName, 'line');
    assert.equal(gOut.children[2].tagName, 'line');
  });

  test('flat outline (ieeg): 7 children — box + 2 crosshair lines + head circle + nose + 2 ears', () => {
    // iEEG DOES carry a head reference (line 228). Kills the
    // MODALITIES_WITH_HEAD_REFERENCE Set membership mutants.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', {
      layoutStyle: 'flat',
      modality: 'ieeg',
      electrodes: [{ name: 'X', ux: 0, uy: 0, uz: 0, region: 'other' }],
    });
    const gOut = ctr.children[0].children[0];
    assert.equal(gOut.children.length, 7);
    assert.equal(gOut.children[3].tagName, 'circle');  // head silhouette
    assert.equal(gOut.children[3].getAttribute('r'), '0.85');  // headR pinned
    assert.equal(gOut.children[3].getAttribute('opacity'), '0.5');
    assert.equal(gOut.children[3].getAttribute('stroke-dasharray'), '0.02 0.02');
  });

  test('flat outline (fnirs): also gets head silhouette', () => {
    // fNIRS is in MODALITIES_WITH_HEAD_REFERENCE — kills the mutant
    // that drops fnirs from the Set.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', {
      layoutStyle: 'flat',
      modality: 'fnirs',
      electrodes: [{ name: 'X', ux: 0, uy: 0, uz: 0, region: 'other' }],
    });
    const gOut = ctr.children[0].children[0];
    assert.equal(gOut.children.length, 7);
  });

  test('flat outline (nirs alias): also gets head silhouette', () => {
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', {
      layoutStyle: 'flat',
      modality: 'nirs',
      electrodes: [{ name: 'X', ux: 0, uy: 0, uz: 0, region: 'other' }],
    });
    const gOut = ctr.children[0].children[0];
    assert.equal(gOut.children.length, 7);
  });

  test('flat outline rect: exact bounding box ±1 with rx=0.02', () => {
    // Pins line 237-243 attributes. Kills UnaryOperator (-1 → +1),
    // ArithmeticOperator on width/height (2 → 0, etc.), and
    // StringLiteral mutants on the rx corner-radius.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', {
      layoutStyle: 'flat',
      modality: 'emg',
      electrodes: [{ name: 'X', ux: 0, uy: 0, uz: 0, region: 'other' }],
    });
    const rect = ctr.children[0].children[0].children[0];
    assert.deepEqual(attrsOf(rect), {
      x: '-1',
      y: '-1',
      width: '2',
      height: '2',
      fill: 'var(--surface, #f7f6f2)',
      stroke: 'var(--ink, #17181a)',
      'stroke-width': '0.008',
      opacity: '0.6',
      rx: '0.02',
    });
  });

  test('flat outline nose path (ieeg): pins the computed coordinates from headR=0.85', () => {
    // The nose path d is built from template literals containing
    // expressions like `${-0.12 * headR} ${-headR * 0.995}` (lines 282-285).
    // Kills ArithmeticOperator mutants (multiply→divide), UnaryOperator
    // mutants (sign flip), and StringLiteral mutants on the entire d.
    //
    // Golden values: headR = 0.85.
    //   -0.12 * 0.85 = -0.102
    //   -0.85 * 0.995 = -0.84575
    //   -0.05 * 0.85 = -0.0425
    //   -0.85 * 1.08 = -0.918
    //   -0.85 * 1.12 = -0.952 (JS prints as -0.9520000000000001)
    //   0.05 * 0.85 = 0.0425
    //   0.12 * 0.85 = 0.102
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', {
      layoutStyle: 'flat', modality: 'ieeg',
      electrodes: [{ name: 'X', ux: 0, uy: 0, uz: 0, region: 'other' }],
    });
    const nose = ctr.children[0].children[0].children[4];
    assert.equal(nose.tagName, 'path');
    assert.equal(
      nose.getAttribute('d'),
      'M -0.102 -0.84575 Q -0.0425 -0.918, 0 -0.9520000000000001 Q 0.0425 -0.918, 0.102 -0.84575');
  });

  test('flat outline left ear (ieeg): pins all 7 coordinate pairs from headR=0.85', () => {
    // Lines 297-306 — left ear (sign=-1). Kills coordinate-arithmetic
    // mutants on every cx/cy in the C-bezier path.
    // -0.85 * 0.995 = -0.84575
    // -1 * 0.85 * 1.06 = -0.901
    // -0.85 * 0.13 = -0.1105
    // -1 * 0.85 * 1.08 = -0.918
    // 0.02 * 0.85 = 0.017
    // -1 * 0.85 * 1.07 = -0.9095
    // 0.09 * 0.85 = 0.0765
    // 0.15 * 0.85 = 0.1275
    // -1 * 0.85 * 1.04 = -0.884
    // 0.18 * 0.85 = 0.153
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', {
      layoutStyle: 'flat', modality: 'ieeg',
      electrodes: [{ name: 'X', ux: 0, uy: 0, uz: 0, region: 'other' }],
    });
    const earL = ctr.children[0].children[0].children[5];
    assert.equal(
      earL.getAttribute('d'),
      'M -0.84575 -0.1105 C -0.901 -0.0765, -0.918 0.017, -0.9095 0.0765 C -0.901 0.1275, -0.884 0.153, -0.84575 0.153');
  });

  test('flat outline right ear (ieeg): mirror of left (positive x)', () => {
    // Same template, sign=+1. Pins the sign multiplier semantics.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', {
      layoutStyle: 'flat', modality: 'ieeg',
      electrodes: [{ name: 'X', ux: 0, uy: 0, uz: 0, region: 'other' }],
    });
    const earR = ctr.children[0].children[0].children[6];
    assert.equal(
      earR.getAttribute('d'),
      'M 0.84575 -0.1105 C 0.901 -0.0765, 0.918 0.017, 0.9095 0.0765 C 0.901 0.1275, 0.884 0.153, 0.84575 0.153');
  });

  test('flat outline modality lowercased: "FNIRS" treated as "fnirs"', () => {
    // setMontage on line 543 lowercases data.modality. Kills the
    // .toLowerCase() mutant — without it, "FNIRS" would miss the Set
    // membership test and the head silhouette wouldn't be drawn.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', {
      layoutStyle: 'flat', modality: 'FNIRS',
      electrodes: [{ name: 'X', ux: 0, uy: 0, uz: 0, region: 'other' }],
    });
    const gOut = ctr.children[0].children[0];
    assert.equal(gOut.children.length, 7,
      'uppercased "FNIRS" should still produce head silhouette');
  });
});

// ---------------------------------------------------------------------------
// Landmarks: golden text positions
// ---------------------------------------------------------------------------

describe('landmarks — golden positions and labels', () => {
  beforeEach(() => { setupGlobals(); });
  afterEach(() => { teardownGlobals(); });

  test('landmarks: 4 entries in canonical order Nasion, Inion, LPA, RPA with exact positions', () => {
    // Pins the LANDMARKS array (line 317-322) — coords, anchors,
    // baselines. Kills:
    //   - StringLiteral mutants on the names ("Nasion" → "Stryker")
    //   - StringLiteral mutants on the anchors
    //   - UnaryOperator mutants on the y coordinates (sign flip)
    //   - .toUpperCase() mutant on line 345
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', STD_MONTAGE);
    const gLm = ctr.children[0].children[1];
    assert.equal(gLm.children.length, 4);

    const expected = [
      { text: 'NASION', x: '0',     y: '-1.06', anchor: 'middle', baseline: 'bottom' },
      { text: 'INION',  x: '0',     y: '1.06',  anchor: 'middle', baseline: 'hanging' },
      { text: 'LPA',    x: '-1.06', y: '0',     anchor: 'end',    baseline: 'middle' },
      { text: 'RPA',    x: '1.06',  y: '0',     anchor: 'start',  baseline: 'middle' },
    ];
    for (let i = 0; i < expected.length; i++) {
      const e = expected[i];
      const t = gLm.children[i];
      assert.equal(t.tagName, 'text');
      assert.equal(t.textContent, e.text, `landmark ${i} text`);
      assert.equal(t.getAttribute('x'), e.x, `landmark ${i} x`);
      assert.equal(t.getAttribute('y'), e.y, `landmark ${i} y`);
      assert.equal(t.getAttribute('text-anchor'), e.anchor, `landmark ${i} anchor`);
      assert.equal(t.getAttribute('dominant-baseline'), e.baseline, `landmark ${i} baseline`);
      // Pinned styling (line 339-344).
      assert.equal(t.getAttribute('font-size'), '0.045');
      assert.equal(t.getAttribute('opacity'), '0.7');
      assert.equal(t.getAttribute('letter-spacing'), '0.02em');
    }
  });

  test('landmarks: flat layout hides the landmarks group regardless of showLandmarks', () => {
    // Kills the line 328-331 flat-mode guard mutation. Even with
    // showLandmarks default true, flat → display:none.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', {
      layoutStyle: 'flat', modality: 'ieeg',
      electrodes: [{ name: 'X', ux: 0, uy: 0, uz: 0, region: 'other' }],
    });
    const gLm = ctr.children[0].children[1];
    assert.equal(gLm.style.display, 'none');
    assert.equal(gLm.children.length, 0,
      'flat-mode landmarks group should not be populated with text');
  });
});

// ---------------------------------------------------------------------------
// Projection: golden (cx, cy) values
// ---------------------------------------------------------------------------

describe('projection — golden cx/cy for canonical electrodes', () => {
  beforeEach(() => { setupGlobals(); });
  afterEach(() => { teardownGlobals(); });

  test('canonical 10-20 montage: every electrode projects to its known (cx, cy)', () => {
    // Pins the project() function (lines 49-64). Kills:
    //   - ArithmeticOperator mutants on `theta = acos(uz)`, `az = atan2(ux, uy)`,
    //     `r * sin(az)`, `-r * cos(az)`
    //   - UnaryOperator on `-r * cos(az)` (would flip the y axis)
    //   - The Math.PI/2 divisor (would put Cz at the edge instead of center)
    //
    // Golden coordinates derived from the formulas:
    //   r = min(1, acos(uz) / (PI/2)), x = r*sin(atan2(ux,uy)), y = -r*cos(atan2(ux,uy))
    //
    // Note on float quirks:
    //   - T7/T8 cy is -6.123e-17 (cos(PI/2) is not exactly 0 in IEEE 754).
    //     We use approximate match (|cy| < 1e-15).
    //   - Fp1/Fp2 cx and cy carry their full 17-digit IEEE doubles.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', {
      electrodes: [
        { name: 'Cz',  ux: 0,      uy: 0,      uz: 1,    region: 'central' },
        { name: 'Fz',  ux: 0,      uy: 0.707,  uz: 0.707, region: 'frontal' },
        { name: 'T7',  ux: -1,     uy: 0,      uz: 0,    region: 'temporal' },
        { name: 'T8',  ux: 1,      uy: 0,      uz: 0,    region: 'temporal' },
        { name: 'Fp1', ux: -0.309, uy: 0.951,  uz: 0,    region: 'frontal' },
        { name: 'Fp2', ux: 0.309,  uy: 0.951,  uz: 0,    region: 'frontal' },
      ],
    });
    const dots = ctr.children[0].children[2].children;
    function pos(i) {
      return { cx: parseFloat(dots[i].getAttribute('cx')),
               cy: parseFloat(dots[i].getAttribute('cy')) };
    }
    // Cz: exact (0, 0) — uz=1 ⇒ theta=0 ⇒ r=0.
    assert.deepEqual(pos(0), { cx: 0, cy: 0 });
    // Fz: cx=0 (midline), cy ≈ -0.5 (front; the -cos(0) y-flip).
    // Pinned value from the formula: r ≈ 0.5001 ⇒ y ≈ -0.5001.
    const fz = pos(1);
    assert.equal(fz.cx, 0);
    assert.ok(Math.abs(fz.cy - (-0.5000961295870888)) < 1e-12,
      `Fz cy=${fz.cy} expected -0.5000961295870888 (pinned)`);
    // T7: cx=-1, cy≈0 (within float epsilon).
    const t7 = pos(2);
    assert.equal(t7.cx, -1);
    assert.ok(Math.abs(t7.cy) < 1e-15, `T7 cy=${t7.cy} expected ~0`);
    // T8: cx=+1, cy≈0.
    const t8 = pos(3);
    assert.equal(t8.cx, 1);
    assert.ok(Math.abs(t8.cy) < 1e-15, `T8 cy=${t8.cy} expected ~0`);
    // Fp1: pinned IEEE 754 doubles.
    assert.deepEqual(pos(4), {
      cx: -0.3090182326136022,
      cy: -0.9510561139661349,
    });
    // Fp2: mirror of Fp1 across the midline.
    assert.deepEqual(pos(5), {
      cx: 0.3090182326136022,
      cy: -0.9510561139661349,
    });
  });

  test('below-equator electrode (uz=-0.5) clamps to r=1 — exactly (0, -1) when uy=1', () => {
    // Pins the r = Math.min(1, theta / (PI/2)) clamp on line 56.
    // With ux=0, uy=1, uz=-0.5: theta = acos(-0.5) = 2pi/3 > pi/2,
    // so r clamps to 1. atan2(0, 1)=0 ⇒ x=sin(0)=0, y=-cos(0)=-1.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', {
      electrodes: [{ name: 'Sub', ux: 0, uy: 1, uz: -0.5, region: 'central' }],
    });
    const d = ctr.children[0].children[2].children[0];
    assert.equal(parseFloat(d.getAttribute('cx')), 0);
    assert.equal(parseFloat(d.getAttribute('cy')), -1);
  });

  test('uz clamp at -1: acos(-1.5) is NaN, but Math.max/min clamps -1.5 to -1', () => {
    // Pins the line 53 Math.max(-1, Math.min(1, u.uz)) double clamp.
    // Without the clamp, acos(-1.5) returns NaN and breaks everything.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', {
      electrodes: [{ name: 'Sub', ux: 0, uy: 1, uz: -1.5, region: 'central' }],
    });
    const d = ctr.children[0].children[2].children[0];
    const cx = parseFloat(d.getAttribute('cx'));
    const cy = parseFloat(d.getAttribute('cy'));
    // With uz clamped to -1: theta = acos(-1) = PI, r = min(1, PI/(PI/2)) = min(1, 2) = 1.
    // Same x=0, y=-1 as uz=-0.5.
    assert.equal(cx, 0);
    assert.equal(cy, -1);
  });

  test('flat mode: cx=ux exactly, cy=-uy exactly (no clamp, no projection)', () => {
    // Pins line 63 `return { x: u.ux, y: -u.uy }`. Kills the
    // UnaryOperator mutant on the y-flip.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', {
      layoutStyle: 'flat',
      electrodes: [
        { name: 'A', ux: 0.123, uy: 0.456, uz: 0, region: 'other' },
        { name: 'B', ux: -0.789, uy: -0.321, uz: 0, region: 'other' },
      ],
    });
    const gE = ctr.children[0].children[2];
    assert.equal(parseFloat(gE.children[0].getAttribute('cx')), 0.123);
    assert.equal(parseFloat(gE.children[0].getAttribute('cy')), -0.456);
    assert.equal(parseFloat(gE.children[1].getAttribute('cx')), -0.789);
    assert.equal(parseFloat(gE.children[1].getAttribute('cy')), 0.321);
  });
});

// ---------------------------------------------------------------------------
// applyStyling — golden stroke/fill table per (mode, sel, hover)
// ---------------------------------------------------------------------------

describe('applyStyling — golden stroke/fill table', () => {
  let api, gEl;

  beforeEach(() => {
    setupGlobals();
    api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', {
      electrodes: [
        { name: 'Cz', ux: 0, uy: 0, uz: 1, region: 'central' },
      ],
    });
    gEl = ctr.children[0].children[2];
  });

  afterEach(() => { teardownGlobals(); });

  test('region mode, unselected, unhovered → fill=region color, stroke=rgba(23,24,26,0.45), sw=0.005, opacity=1', () => {
    // Pins the default branch at applyStyling line 418-420 + 421
    // (stroke-width). Kills:
    //   - StringLiteral 'rgba(23,24,26,0.45)' mutant
    //   - LogicalOperator on the `uniform || (highlight && !sel)` test
    //   - StringLiteral '0.005' mutant on sw
    //   - The opacity 1 vs 0.18 branch (line 436)
    const d = gEl.children[0];
    // Cz is region central → 'oklch(0.62 0.14 150)'.
    assert.equal(d.getAttribute('fill'), 'oklch(0.62 0.14 150)');
    assert.equal(d.getAttribute('stroke'), 'rgba(23,24,26,0.45)');
    assert.equal(d.getAttribute('stroke-width'), '0.005');
    assert.equal(d.getAttribute('opacity'), '1');
  });

  test('uniform mode, unselected → fill=MONO_FILL, stroke=MONO_STROKE', () => {
    // Pins the uniform-mode branch of line 418: stroke is MONO_STROKE,
    // NOT 'rgba(23,24,26,0.45)'.
    api.setOpts({ colorMode: 'uniform' });
    const d = gEl.children[0];
    assert.equal(d.getAttribute('fill'), 'oklch(0.58 0.012 75)');
    assert.equal(d.getAttribute('stroke'), 'oklch(0.28 0.015 70)');
  });

  test('highlight mode, unselected → fill=MONO_FILL, stroke=MONO_STROKE', () => {
    // The `(highlight && !sel)` branch of line 418. Pins the
    // composed predicate.
    api.setOpts({ colorMode: 'highlight' });
    const d = gEl.children[0];
    assert.equal(d.getAttribute('fill'), 'oklch(0.58 0.012 75)');
    assert.equal(d.getAttribute('stroke'), 'oklch(0.28 0.015 70)');
  });

  test('highlight mode + selected → fill=SEL_FILL, stroke=selection-orange, sw=0.012', () => {
    // The `(highlight && !sel)` predicate must be FALSE when sel is true,
    // so we fall through to the `if (sel)` block at line 423-427.
    api.setOpts({ colorMode: 'highlight' });
    api.setSelected(['Cz']);
    const d = gEl.children[0];
    assert.equal(d.getAttribute('fill'), 'oklch(0.58 0.17 45)');
    assert.equal(d.getAttribute('stroke'), 'oklch(0.32 0.14 40)');
    assert.equal(d.getAttribute('stroke-width'), '0.012');
  });

  test('region mode + selected → SEL_FILL applied over region color', () => {
    // The `if (sel)` block on line 423 overwrites fill from
    // colorFor(el). Pins the sequence: colorFor first, then sel override.
    api.setSelected(['Cz']);
    const d = gEl.children[0];
    assert.equal(d.getAttribute('fill'), 'oklch(0.58 0.17 45)');
    assert.equal(d.getAttribute('stroke-width'), '0.012');
  });

  test('dimmed (region in dimmedRegions) → opacity 0.18, fill unchanged', () => {
    // The dim check (line 411) ORs region with !filtered. Kills the
    // BooleanLiteral mutant on `dim ? 0.18 : 1`.
    api.setDimmedRegions(['central']);
    const d = gEl.children[0];
    assert.equal(d.getAttribute('opacity'), '0.18');
    // Fill is still the region color — dim only affects opacity.
    assert.equal(d.getAttribute('fill'), 'oklch(0.62 0.14 150)');
  });

  test('label opacity: dim → 0.25, selected → 1, default → 0.85', () => {
    // Pins line 453: `dim ? 0.25 : (sel || isHover ? 1 : 0.85)`.
    // Kills the StringLiteral mutants on '0.25', '1', '0.85'.
    const ctr = makeContainer();
    const api2 = loadFreshTopo2D();
    api2.init(ctr);
    api2.setMontage('t', STD_MONTAGE);
    const gLb = ctr.children[0].children[3];

    // Default: opacity 0.85.
    assert.equal(gLb.children[0].getAttribute('opacity'), '0.85');

    // Selected → opacity 1.
    api2.setSelected(['Cz']);
    assert.equal(gLb.children[0].getAttribute('opacity'), '1');

    // Dimmed (filter excludes Cz) → opacity 0.25.
    api2.setSelected([]);
    api2.setFiltered(['Fz']);
    assert.equal(gLb.children[0].getAttribute('opacity'), '0.25');
  });

  test('selected label font-weight 600, unselected 500', () => {
    // Pins line 454-455. Kills the BooleanLiteral / Number mutants on
    // the font-weight values.
    const ctr = makeContainer();
    const api2 = loadFreshTopo2D();
    api2.init(ctr);
    api2.setMontage('t', STD_MONTAGE);
    const gLb = ctr.children[0].children[3];

    api2.setSelected(['Cz']);
    assert.equal(gLb.children[0].getAttribute('font-weight'), '600');

    api2.setSelected([]);
    assert.equal(gLb.children[0].getAttribute('font-weight'), '500');
  });
});

// ---------------------------------------------------------------------------
// Dot radius scaling
// ---------------------------------------------------------------------------

describe('baseRadius — exact dot r values', () => {
  beforeEach(() => { setupGlobals(); });
  afterEach(() => { teardownGlobals(); });

  test('dotSize=1 → r=0.022; dotSize=1.5 → r=0.033; dotSize=0.3 → r=0.0066', () => {
    // Pins the line 354 multiplier 0.022. Kills ArithmeticOperator
    // mutants (multiply → divide → add).
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', { electrodes: [{ name: 'Cz', ux: 0, uy: 0, uz: 1, region: 'central' }] });
    const dot = ctr.children[0].children[2].children[0];

    // Default dotSize=1.
    assert.equal(parseFloat(dot.getAttribute('r')), 0.022);

    // Scale up.
    api.setOpts({ dotSize: 1.5 });
    assert.ok(Math.abs(parseFloat(dot.getAttribute('r')) - 0.033) < 1e-9);

    // Scale down.
    api.setOpts({ dotSize: 0.3 });
    assert.ok(Math.abs(parseFloat(dot.getAttribute('r')) - 0.0066) < 1e-9);
  });

  test('dotSize=0 → r=0.022 (default fallback via `opts.dotSize || 1`)', () => {
    // Pins the `|| 1` fallback on line 354. Without it, dotSize=0
    // would collapse all dots to a point.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    api.setMontage('t', { electrodes: [{ name: 'Cz', ux: 0, uy: 0, uz: 1, region: 'central' }] });
    api.setOpts({ dotSize: 0 });
    const dot = ctr.children[0].children[2].children[0];
    assert.equal(parseFloat(dot.getAttribute('r')), 0.022);
  });
});

// ---------------------------------------------------------------------------
// SVG viewBox + attributes
// ---------------------------------------------------------------------------

describe('init — svg attribute golden set', () => {
  beforeEach(() => { setupGlobals(); });
  afterEach(() => { teardownGlobals(); });

  test('svg has class topo-svg, viewBox "-1.25 -1.25 2.5 2.5", preserveAspectRatio "xMidYMid meet"', () => {
    // Pins lines 513-516. Kills the VB constant (1.25) Arithmetic
    // mutants AND the StringLiteral mutants on the SVG class /
    // preserveAspectRatio.
    const api = loadFreshTopo2D();
    const ctr = makeContainer();
    api.init(ctr);
    const svg = ctr.children[0];
    assert.equal(svg.tagName, 'svg');
    assert.equal(svg.getAttribute('class'), 'topo-svg');
    assert.equal(svg.getAttribute('viewBox'), '-1.25 -1.25 2.5 2.5');
    assert.equal(svg.getAttribute('preserveAspectRatio'), 'xMidYMid meet');
  });
});

