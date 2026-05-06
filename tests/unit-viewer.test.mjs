// Unit tests for viewer.js — the page-level rendering helpers we
// extracted out of index.html. We swap globalThis.document for a
// minimal Element/Document stub so the tests exercise the real
// DOM-construction code without requiring jsdom.
//
// The stub mirrors only what viewer.js actually calls:
//   document.createElement(tag)
//   document.createTextNode(text)
//   document.getElementById(id)        (test setup pre-populates)
//   element.append(...nodes|text)
//   element.replaceChildren(...nodes)
//   element.textContent (get/set)
//   element.className (set)
//   element.dataset (object)
//   element.hidden (bool)
//   element.href (string)
import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

class StubElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this._textContent = '';
    this.className = '';
    this.hidden = false;
    this.href = undefined;
  }
  get textContent() {
    if (this.children.length) {
      return this.children.map(c => typeof c === 'string' ? c : c.textContent).join('');
    }
    return this._textContent;
  }
  set textContent(v) { this._textContent = String(v); this.children = []; }
  append(...nodes) {
    for (const n of nodes) this.children.push(n);
  }
  replaceChildren(...nodes) {
    this.children = nodes.filter(Boolean);
  }
  setAttribute(k, v) { this.attributes[k] = v; }
  // Pretty-print the rendered tree for assertion-on-failure.
  describe() {
    const open = `<${this.tagName.toLowerCase()}${this.className ? ' class="' + this.className + '"' : ''}>`;
    const close = `</${this.tagName.toLowerCase()}>`;
    const body = this.children.length
      ? this.children.map(c =>
          typeof c === 'string' ? c : (c.describe ? c.describe() : c.textContent)
        ).join('')
      : this._textContent;
    return open + body + close;
  }
}
class StubText {
  constructor(text) { this._textContent = String(text); }
  get textContent() { return this._textContent; }
  describe() { return this._textContent; }
}
class StubDocument {
  constructor() { this._byId = new Map(); }
  createElement(tag) { return new StubElement(tag); }
  createTextNode(text) { return new StubText(text); }
  getElementById(id) { return this._byId.get(id) || null; }
  register(id, el) { this._byId.set(id, el); return el; }
}

let originalDocument;
let doc;
let Viewer;

beforeEach(() => {
  originalDocument = globalThis.document;
  doc = new StubDocument();
  globalThis.document = doc;
  // Defer require until document is in place — viewer.js doesn't
  // touch document at module-init time, so this just gives us a
  // fresh module reference each test.
  delete require.cache[require.resolve('../viewer.js')];
  Viewer = require('../viewer.js');
});
afterEach(() => { globalThis.document = originalDocument; });

// ----- el / setChildren ---------------------------------------

test('el(): builds element with class and textContent', () => {
  const e = Viewer.el('span', 'foo', 'hello');
  assert.equal(e.tagName, 'SPAN');
  assert.equal(e.className, 'foo');
  assert.equal(e.textContent, 'hello');
});

test('el(): no class / no text → bare element', () => {
  const e = Viewer.el('div');
  assert.equal(e.className, '');
  assert.equal(e.textContent, '');
});

test('el(): does NOT use innerHTML — XSS payload becomes text', () => {
  // The whole point of the el() helper is that user-controllable
  // strings get assigned via textContent, never innerHTML, so a
  // crafted ?eeg= URL containing tags can't inject markup.
  const e = Viewer.el('span', null, '<script>alert(1)</script>');
  assert.equal(e.textContent, '<script>alert(1)</script>');
  // No child elements got constructed from the markup.
  assert.equal(e.children.length, 0);
});

test('setChildren(): replaces all children, drops falsy', () => {
  const parent = doc.createElement('div');
  parent.append(doc.createElement('p'));
  Viewer.setChildren(parent,
    doc.createElement('span'),
    null,                            // dropped
    doc.createElement('em'),
    undefined,                       // dropped
    0);                              // dropped — falsy
  assert.equal(parent.children.length, 2);
  assert.equal(parent.children[0].tagName, 'SPAN');
  assert.equal(parent.children[1].tagName, 'EM');
});

// ----- renderProvenance --------------------------------------

test('renderProvenance: one row per non-null sidecar source', () => {
  const provenance = doc.createElement('div');
  Viewer.renderProvenance({
    sidecar_sources: {
      eeg_json:    'https://example.invalid/dsX/sub-01_eeg.json',
      channels:    'https://example.invalid/dsX/sub-01_channels.tsv',
      events:      null,
      electrodes:  null,
      coordsystem: null,
    },
  }, provenance);
  assert.equal(provenance.children.length, 2);
  // The path with the host stripped is in the <code> child.
  assert.match(provenance.describe(), /dsX\/sub-01_eeg\.json/);
  assert.match(provenance.describe(), /dsX\/sub-01_channels\.tsv/);
});

test('renderProvenance: empty sources → "no sidecars resolved"', () => {
  const provenance = doc.createElement('div');
  Viewer.renderProvenance({
    sidecar_sources: { eeg_json: null, channels: null, events: null, electrodes: null, coordsystem: null },
  }, provenance);
  assert.equal(provenance.children.length, 1);
  assert.match(provenance.describe(), /no sidecars resolved/);
});

test('renderProvenance: XSS payload in path stays as text', () => {
  const provenance = doc.createElement('div');
  Viewer.renderProvenance({
    sidecar_sources: { eeg_json: 'https://x.example/<script>alert(1)</script>_eeg.json' },
  }, provenance);
  // The <script> tag-looking string is now textContent of a <code>
  // element, so it can't execute. We verify by rendering the tree
  // and confirming the literal text is there.
  assert.match(provenance.describe(), /<script>alert\(1\)<\/script>_eeg\.json/);
});

// ----- renderChannels ----------------------------------------

test('renderChannels: null channels → "no _channels.tsv" muted text', () => {
  const list  = doc.createElement('div');
  const count = doc.createElement('span');
  Viewer.renderChannels(null, list, count);
  assert.equal(count.textContent, '?');
  assert.match(list.describe(), /no _channels\.tsv/);
});

test('renderChannels: count + bad_dot for status="bad"', () => {
  const list  = doc.createElement('div');
  const count = doc.createElement('span');
  Viewer.renderChannels([
    { name: 'Fp1', status: 'good', type: 'EEG', units: 'uV' },
    { name: 'Fp2', status: 'bad',  type: 'EEG', units: 'uV' },
  ], list, count);
  assert.equal(count.textContent, '2');
  assert.equal(list.children.length, 2);
  // Bad row has the bad-dot span as its first child.
  const fp2 = list.children[1];
  assert.equal(fp2.children[0].className, 'bad-dot');
});

test('renderChannels: missing type/units handled (BV-via-vhdr case)', () => {
  const list  = doc.createElement('div');
  const count = doc.createElement('span');
  Viewer.renderChannels([{ name: 'Cz' }], list, count);
  assert.equal(count.textContent, '1');
  // Just the name span; no type/units children.
  const row = list.children[0];
  assert.equal(row.children.length, 1);
  assert.equal(row.children[0].className, 'ch-name');
});

// ----- renderEvents ------------------------------------------

test('renderEvents: empty → "no events"', () => {
  const list  = doc.createElement('div');
  const count = doc.createElement('span');
  Viewer.renderEvents([], list, count);
  assert.equal(count.textContent, '0');
  assert.match(list.describe(), /no events/);
});

test('renderEvents: caps display at 50 even when more events present', () => {
  const list  = doc.createElement('div');
  const count = doc.createElement('span');
  const events = Array.from({ length: 200 }, (_, i) => ({ onset: i, label: 'X' }));
  Viewer.renderEvents(events, list, count);
  assert.equal(count.textContent, '200');
  assert.equal(list.children.length, 50);
});

test('renderEvents: onset formatted with 3-decimal precision', () => {
  const list  = doc.createElement('div');
  const count = doc.createElement('span');
  Viewer.renderEvents([{ onset: 1.234567, label: 'Stim' }], list, count);
  const row = list.children[0];
  assert.equal(row.children[0].textContent, '1.235s');
});

test('renderEvents: null label preserved as empty string', () => {
  const list  = doc.createElement('div');
  const count = doc.createElement('span');
  Viewer.renderEvents([{ onset: 0, label: null }], list, count);
  assert.equal(list.children[0].children[2].textContent, '');
});

// ----- updateElectrodeLink -----------------------------------

test('updateElectrodeLink: hides when no electrodes sidecar', () => {
  const link = doc.createElement('a');
  Viewer.updateElectrodeLink({ sidecar_sources: { electrodes: null } }, link);
  assert.equal(link.hidden, true);
});

test('updateElectrodeLink: builds tsv-only URL when no coords', () => {
  const link = doc.createElement('a');
  const tsv = 'https://example.invalid/electrodes.tsv';
  Viewer.updateElectrodeLink(
    { sidecar_sources: { electrodes: tsv } }, link);
  assert.equal(link.hidden, false);
  // Encoded URL param.
  assert.match(link.href, /tsv=https%3A%2F%2Fexample\.invalid%2Felectrodes\.tsv/);
  assert.ok(!link.href.includes('coords='));
});

test('updateElectrodeLink: tsv + coords → both URL params', () => {
  const link = doc.createElement('a');
  Viewer.updateElectrodeLink({
    sidecar_sources: {
      electrodes:  'https://example.invalid/e.tsv',
      coordsystem: 'https://example.invalid/c.json',
    },
  }, link);
  assert.match(link.href, /coords=https%3A%2F%2Fexample\.invalid%2Fc\.json/);
});

// ----- renderStageCaption ------------------------------------

test('renderStageCaption: ch / Hz / s / EXT separated by ·', () => {
  const cap = doc.createElement('div');
  Viewer.renderStageCaption(
    { ext: 'set' },
    { n_channels: 64, sampling_frequency: 500, duration_s: 600.0 },
    cap);
  assert.equal(cap.hidden, false);
  const text = cap.describe();
  assert.match(text, /64 ch/);
  assert.match(text, /500 Hz/);
  assert.match(text, /600\.0 s/);
  assert.match(text, /SET/);
  // Three separators between four values.
  const seps = (text.match(/·/g) || []).length;
  assert.equal(seps, 3);
});

// ----- pure-math helpers -------------------------------------

test('clampStart: 0 ≤ start ≤ duration - window', () => {
  assert.equal(Viewer.clampStart(50, 100, 10), 50);
  assert.equal(Viewer.clampStart(-50, 100, 10), 0);   // floor
  assert.equal(Viewer.clampStart(150, 100, 10), 90);  // ceil = duration - window
});

test('clampStart: no reader (duration null) → 0', () => {
  assert.equal(Viewer.clampStart(50, null, 10), 0);
});

// ----- deriveChannelLabels -----------------------------------

test('deriveChannelLabels: prefers reader.channel_labels', () => {
  const reader = { channel_labels: ['A', 'B'], n_channels: 2 };
  assert.deepEqual(Viewer.deriveChannelLabels(reader, []), ['A', 'B']);
});

test('deriveChannelLabels: falls back to channels.tsv names', () => {
  const reader = { n_channels: 2 };
  assert.deepEqual(
    Viewer.deriveChannelLabels(reader, [{name: 'Fp1'}, {name: 'Fp2'}]),
    ['Fp1', 'Fp2']);
});

test('deriveChannelLabels: empty channels.tsv → synthesized Ch1..ChN', () => {
  // The bug we just fixed: an empty array shouldn't short-circuit
  // the fallback chain.
  const reader = { n_channels: 3 };
  assert.deepEqual(Viewer.deriveChannelLabels(reader, []), ['Ch1', 'Ch2', 'Ch3']);
});

test('deriveChannelLabels: no reader labels, no channels.tsv → synthesized', () => {
  const reader = { n_channels: 2 };
  assert.deepEqual(Viewer.deriveChannelLabels(reader, null), ['Ch1', 'Ch2']);
});

// ----- deriveBadMask -----------------------------------------

test('deriveBadMask: status="bad" → true, others false', () => {
  const mask = Viewer.deriveBadMask([
    { status: 'good' }, { status: 'bad' }, { status: null }, { status: 'bad' },
  ], 4);
  assert.deepEqual(mask, [false, true, false, true]);
});

test('deriveBadMask: pads with false when channels.tsv shorter than reader', () => {
  // BV via .vhdr: sidecar can be missing or absent. The mask must
  // still match `n_channels` so the renderer's lookup never trips.
  const mask = Viewer.deriveBadMask([{ status: 'bad' }], 4);
  assert.deepEqual(mask, [true, false, false, false]);
});

test('deriveBadMask: null channels → all-false mask of correct length', () => {
  assert.deepEqual(Viewer.deriveBadMask(null, 3), [false, false, false]);
});

// ----- pickDefaultWindowSec ----------------------------------
// The picker maps reader bandwidth × per-pan window to one of the
// <select id="window-sec"> presets, so a 5 kHz BV recording loads
// at a small default while a 250 Hz EEGLAB stays at 30 s.

test('pickDefaultWindowSec: low-Hz EEGLAB-style → max preset (30 s)', () => {
  const reader = { n_channels: 36, sampling_frequency: 250, bytes_per_sample: 4 };
  // 36 × 250 × 4 = 36 KB/s → 30 s = 1.08 MB, fits under 1.5 MB budget
  assert.equal(Viewer.pickDefaultWindowSec(reader), 30);
});

test('pickDefaultWindowSec: mid-density EDF → 20 s preset', () => {
  // 82 × 512 × 2 = 84 KB/s → 20 s = 1.68 MB (over) so falls to 10 s = 0.84 MB
  const reader = { n_channels: 82, sampling_frequency: 512, bytes_per_sample: 2 };
  assert.equal(Viewer.pickDefaultWindowSec(reader), 10);
});

test('pickDefaultWindowSec: dense BV 5 kHz → small preset (2 s)', () => {
  // 64 × 5000 × 2 = 640 KB/s → 5 s = 3.2 MB (over), 2 s = 1.28 MB (fits)
  const reader = { n_channels: 64, sampling_frequency: 5000, bytes_per_sample: 2 };
  assert.equal(Viewer.pickDefaultWindowSec(reader), 2);
});

test('pickDefaultWindowSec: extreme density falls back to smallest preset', () => {
  // 256 × 10000 × 4 = 10 MB/s → even 2 s = 20 MB blows the budget,
  // but caller still gets the smallest preset rather than 0/null.
  const reader = { n_channels: 256, sampling_frequency: 10000, bytes_per_sample: 4 };
  assert.equal(Viewer.pickDefaultWindowSec(reader), 2);
});

test('pickDefaultWindowSec: missing bytes_per_sample defaults to 4', () => {
  // EEGLAB used to omit this field; the picker assumes Float32 so
  // older readers don't get pessimistic 1-byte estimates that would
  // pick too-large windows.
  const reader = { n_channels: 36, sampling_frequency: 250 };
  // 36 × 250 × 4 = 36 KB/s → 30 s fits
  assert.equal(Viewer.pickDefaultWindowSec(reader), 30);
});

test('pickDefaultWindowSec: degenerate reader (zero rate) → safe 10 s default', () => {
  const reader = { n_channels: 0, sampling_frequency: 250, bytes_per_sample: 4 };
  assert.equal(Viewer.pickDefaultWindowSec(reader), 10);
});
