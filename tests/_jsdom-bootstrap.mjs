// tests/_jsdom-bootstrap.mjs
//
// JSDOM globals shim for testing viewer.js under node:test. Sets up
// just enough DOM surface that viewer.js's IIFE can load without
// throwing, while keeping the harness lightweight (no full page
// init, no actual rendering).
//
// To use: import './_jsdom-bootstrap.mjs' before require()-ing
// viewer.js.

import { JSDOM } from 'jsdom';

const dom = new JSDOM(`
<!DOCTYPE html>
<html>
<body>
  <main>
    <input id="window-sec" value="10" />
    <input id="gain" value="1" />
    <span id="status"></span>
    <div id="provenance"></div>
    <canvas id="traces" width="800" height="600"></canvas>
    <div id="stage-hint"></div>
    <div id="stage-caption"></div>
    <span id="pill-format"></span>
    <span id="pill-fs"></span>
    <span id="pill-channels"></span>
    <span id="pill-duration"></span>
    <div id="ch-list"></div>
    <span id="channel-count">0</span>
    <a id="electrode-link" hidden></a>
    <div id="cursor-info-bar" hidden>
      <span class="cursor-time"></span>
      <span class="cursor-channel"></span>
      <span class="cursor-value"></span>
    </div>
    <div id="cursor-dot" hidden></div>
    <div id="shortcuts-overlay" hidden></div>
    <div id="metadata-overlay" hidden></div>
    <button id="time-mode-toggle" data-mode="relative">rel</button>
    <input id="filter-hp-enable" type="checkbox" />
    <input id="filter-hp-cutoff" value="0.5" />
    <input id="filter-lp-enable" type="checkbox" />
    <input id="filter-lp-cutoff" value="45" />
    <input id="filter-notch-enable" type="checkbox" />
    <select id="filter-notch-freq"><option value="50">50</option><option value="60" selected>60</option></select>
    <span id="ch-types-colors"></span>
  </main>
</body>
</html>
`, { url: 'http://localhost/' });

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;
globalThis.Element = dom.window.Element;
globalThis.Event = dom.window.Event;
globalThis.URLSearchParams = dom.window.URLSearchParams;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

// Canvas getContext stub — viewer.js calls .getContext('2d') once at
// boot; we hand it a no-op proxy so the renderer can be invoked
// without actually painting pixels.
const stubCtx = new Proxy({}, {
  get: () => () => {},
  set: () => true,
});
const origGetContext = dom.window.HTMLCanvasElement.prototype.getContext;
dom.window.HTMLCanvasElement.prototype.getContext = function () { return stubCtx; };

// Worker stub — viewer.js creates `new Worker('worker.js')` at boot.
// We provide a no-op constructor; tests that need real worker
// behaviour should use the in-process stub from integration tests.
globalThis.Worker = class {
  constructor() {}
  postMessage() {}
  terminate() {}
  set onmessage(fn) {}
  set onerror(fn) {}
};

// devicePixelRatio is used by traces.js's deviceFitCanvas.
globalThis.window.devicePixelRatio = 1;
