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
    // keep firstChild / removeChild chain working
    this._rebuildFirstChild();
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) this.children.splice(idx, 1);
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
