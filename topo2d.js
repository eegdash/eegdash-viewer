/* ============================================================
   topo2d.js — MNE/EEGLAB-style 2D top-view EEG head render
   ------------------------------------------------------------
   Implements the same public interface as scene.js so the app
   can swap between 2D and 3D without special-casing either.

   Design references (per deep-research report):
   - MNE topomap outlines: head circle + nose + ears
   - EEGLAB convention: azimuthal equidistant projection with
     the head circle drawn at the Fpz/T7/T8/Oz circumference.
     r = (90 - elevation°) / 90 in normalized units.
   ============================================================ */
(function () {
  'use strict';

  // Public API container
  const api = {};

  // --- State --------------------------------------------------
  let container = null;
  let svg = null;
  let gOutline = null;   // head outline (circle, nose, ears) in sphere mode
  let gElectrodes = null;
  let gLabels = null;
  let gLandmarks = null;
  let electrodes = [];
  let selected = new Set();
  let filtered = null;      // Set<name> or null
  let dimmedRegions = new Set();
  let hovered = null;
  let listeners = { hover: [], click: [] };
  let layoutStyle = 'sphere';   // 'sphere' (EEG/MEG) | 'flat' (iEEG/EMG/fNIRS)
  let currentModality = 'eeg';  // drives flat-mode head-reference (fnirs/ieeg yes, emg no)

  let opts = {
    colorMode: 'region',
    headOpacity: 0.6,
    dotSize: 1,
    showHead: true,
    showLandmarks: true,
    labelDensity: 'smart',
  };

  // --- Projection ---------------------------------------------
  // Input: unit-sphere coords (ux, uy, uz) with +Y = nasion, +Z = vertex.
  // Output: 2D plane coords (px, py) on [-1, 1] where +py = nasion (up),
  // +px = right. Electrodes below the equator (uz < 0) are clipped to the
  // outer ring, which matches how EEGLAB draws 10-10/10-05 ears.
  function project(u) {
    // Sphere-mode (EEG / MEG scalp): azimuthal-equidistant projection.
    // Elevation from vertex (0 = Cz, pi/2 = equator), azimuth via atan2.
    if (layoutStyle !== 'flat') {
      const uz = Math.max(-1, Math.min(1, u.uz));
      const theta = Math.acos(uz);                     // 0..pi
      const az = Math.atan2(u.ux, u.uy);
      const r = Math.min(1, theta / (Math.PI / 2));   // clamp below-equator
      return { x: r * Math.sin(az), y: -r * Math.cos(az) };
    }
    // Flat mode (iEEG/EMG/fNIRS): ux/uy already pre-normalised into the
    // SVG viewbox by the loader's flat pipeline. No projection, no clamp
    // — but flip the Y axis so +Y reads as "up" on screen to match the
    // sphere-mode convention.
    return { x: u.ux, y: -u.uy };
  }

  // --- Colors -------------------------------------------------
  const REGION_COLORS = {
    frontal:   'oklch(0.60 0.14 265)',
    central:   'oklch(0.62 0.14 150)',
    parietal:  '#E69F00',
    temporal:  'oklch(0.58 0.12 35)',
    occipital: 'oklch(0.55 0.14 15)',
    reference: 'oklch(0.55 0.02 260)',
    egi:       'oklch(0.58 0.03 260)',
    other:     'oklch(0.55 0.02 260)',
  };

  // Default "mono" color — a warm silver/graphite, like a real Ag/AgCl cup
  // electrode. Needs to read clearly against the cream paper AND against the
  // head outline (which is the --ink grey), so we go slightly darker than
  // silver and give it a definite rim.
  const MONO_FILL = 'oklch(0.58 0.012 75)';
  const MONO_STROKE = 'oklch(0.28 0.015 70)';
  const SEL_FILL = 'oklch(0.58 0.17 45)';

  // fNIRS type-based palette — sources are near-infrared emitters (warm),
  // detectors are photodetectors (cool). Using the same hue families as
  // frontal/occipital for familiarity.
  const NIRS_SOURCE_FILL   = 'oklch(0.62 0.17 40)';
  const NIRS_DETECTOR_FILL = 'oklch(0.58 0.14 245)';

  function colorFor(el) {
    if (opts.colorMode === 'uniform') return MONO_FILL;
    if (opts.colorMode === 'highlight') {
      return selected.has(el.name) ? SEL_FILL : MONO_FILL;
    }
    // fNIRS: source/detector distinction dominates when type is present.
    if (currentModality === 'nirs' || currentModality === 'fnirs') {
      const t = (el.type || '').toLowerCase();
      if (t.includes('source')) return NIRS_SOURCE_FILL;
      if (t.includes('detector')) return NIRS_DETECTOR_FILL;
    }
    return REGION_COLORS[el.region] || REGION_COLORS.other;
  }

  // --- Geometry constants ------------------------------------
  // Viewbox coordinate system: origin = head center, unit = "1.0" head radius.
  // We render in a [-1.25, 1.25] box so nose/ears can extend past the head.
  const VB = 1.25;

  // --- Outline ------------------------------------------------
  function buildOutline() {
    const NS = 'http://www.w3.org/2000/svg';
    while (gOutline.firstChild) gOutline.removeChild(gOutline.firstChild);

    // Flat layouts (iEEG / EMG / fNIRS) don't have a scalp; render a
    // neutral bounding box + axis ticks instead of the head-circle
    // chrome.
    if (layoutStyle === 'flat') {
      _buildFlatOutline(NS);
      gOutline.style.display = opts.showHead ? '' : 'none';
      return;
    }

    // Head circle (drawn at Fpz/T7/T8/Oz circumference, EEGLAB-style).
    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', 0);
    circle.setAttribute('cy', 0);
    circle.setAttribute('r', 1);
    circle.setAttribute('fill', 'var(--surface, #f7f6f2)');
    circle.setAttribute('stroke', 'var(--ink, #17181a)');
    circle.setAttribute('stroke-width', 0.012);
    circle.setAttribute('opacity', opts.headOpacity);
    gOutline.appendChild(circle);

    // 10-10 reference rings — concentric arcs at r = 0.25, 0.5, 0.75
    // (polar angles 22.5°, 45°, 67.5° from the vertex in the azimuthal-
    // equidistant projection). Give the eye orientation for dense montages.
    //
    // Adaptive density: at 256+ channels the dashed rings fight the dot
    // cloud, so drop the middle ring and use a slightly higher contrast
    // opacity on the two that remain.
    const dense = electrodes.length > 200;
    const ringRadii = dense ? [0.33, 0.66] : [0.25, 0.5, 0.75];
    const ringOpacity = dense ? 0.35 : 0.45;
    ringRadii.forEach(rr => {
      const ring = document.createElementNS(NS, 'circle');
      ring.setAttribute('cx', 0);
      ring.setAttribute('cy', 0);
      ring.setAttribute('r', rr);
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', 'var(--ink-3, #b5b8bd)');
      ring.setAttribute('stroke-width', 0.003);
      ring.setAttribute('stroke-dasharray', '0.012 0.018');
      ring.setAttribute('opacity', ringOpacity);
      gOutline.appendChild(ring);
    });

    // Nose — a soft triangular peak at the top (+y).
    const nose = document.createElementNS(NS, 'path');
    // Start at left edge of nose, peak, right edge; then close along the head.
    nose.setAttribute('d',
      'M -0.15 -0.992 ' +
      'Q -0.06 -1.08, 0 -1.12 ' +
      'Q 0.06 -1.08, 0.15 -0.992'
    );
    nose.setAttribute('fill', 'none');
    nose.setAttribute('stroke', 'var(--ink, #17181a)');
    nose.setAttribute('stroke-width', 0.012);
    nose.setAttribute('stroke-linecap', 'round');
    nose.setAttribute('stroke-linejoin', 'round');
    nose.setAttribute('opacity', opts.headOpacity);
    gOutline.appendChild(nose);

    // Ears — soft bumps at ±1 on the x axis.
    const earL = document.createElementNS(NS, 'path');
    earL.setAttribute('d',
      'M -0.99 -0.13 ' +
      'C -1.05 -0.09, -1.07 0.02, -1.06 0.09 ' +
      'C -1.05 0.15, -1.03 0.18, -0.995 0.18'
    );
    earL.setAttribute('fill', 'none');
    earL.setAttribute('stroke', 'var(--ink, #17181a)');
    earL.setAttribute('stroke-width', 0.012);
    earL.setAttribute('stroke-linecap', 'round');
    earL.setAttribute('opacity', opts.headOpacity);
    gOutline.appendChild(earL);

    const earR = document.createElementNS(NS, 'path');
    earR.setAttribute('d',
      'M 0.99 -0.13 ' +
      'C 1.05 -0.09, 1.07 0.02, 1.06 0.09 ' +
      'C 1.05 0.15, 1.03 0.18, 0.995 0.18'
    );
    earR.setAttribute('fill', 'none');
    earR.setAttribute('stroke', 'var(--ink, #17181a)');
    earR.setAttribute('stroke-width', 0.012);
    earR.setAttribute('stroke-linecap', 'round');
    earR.setAttribute('opacity', opts.headOpacity);
    gOutline.appendChild(earR);

    // Crosshairs — very faint guide at nasion-inion and LPA-RPA axes.
    const crossV = document.createElementNS(NS, 'line');
    crossV.setAttribute('x1', 0); crossV.setAttribute('y1', -1);
    crossV.setAttribute('x2', 0); crossV.setAttribute('y2', 1);
    crossV.setAttribute('stroke', 'var(--ink-3, #aaa)');
    crossV.setAttribute('stroke-width', 0.004);
    crossV.setAttribute('stroke-dasharray', '0.02 0.02');
    crossV.setAttribute('opacity', 0.35);
    gOutline.appendChild(crossV);

    const crossH = document.createElementNS(NS, 'line');
    crossH.setAttribute('x1', -1); crossH.setAttribute('y1', 0);
    crossH.setAttribute('x2', 1); crossH.setAttribute('y2', 0);
    crossH.setAttribute('stroke', 'var(--ink-3, #aaa)');
    crossH.setAttribute('stroke-width', 0.004);
    crossH.setAttribute('stroke-dasharray', '0.02 0.02');
    crossH.setAttribute('opacity', 0.35);
    gOutline.appendChild(crossH);

    gOutline.style.display = opts.showHead ? '' : 'none';
  }

  // iEEG sensors are in-brain and fNIRS optodes are on the scalp — both
  // benefit from a faint head silhouette behind the flat scatter so users can
  // orient "front / back / sides" at a glance. EMG is on limbs/torso and has
  // no meaningful head reference; it gets a plain bounding box only.
  const MODALITIES_WITH_HEAD_REFERENCE = new Set(['ieeg', 'nirs', 'fnirs']);

  // --- Flat outline (iEEG / EMG / fNIRS) ---------------------
  // Neutral bounding box + axis crosshair + optional faint head silhouette.
  function _buildFlatOutline(NS) {
    const withHead = MODALITIES_WITH_HEAD_REFERENCE.has(currentModality);

    // Bounding square at ±1 — the loader's flat pipeline clamps to this.
    const box = document.createElementNS(NS, 'rect');
    box.setAttribute('x', -1); box.setAttribute('y', -1);
    box.setAttribute('width', 2); box.setAttribute('height', 2);
    box.setAttribute('fill', 'var(--surface, #f7f6f2)');
    box.setAttribute('stroke', 'var(--ink, #17181a)');
    box.setAttribute('stroke-width', 0.008);
    box.setAttribute('opacity', opts.headOpacity);
    box.setAttribute('rx', 0.02);
    gOutline.appendChild(box);

    // Crosshair through origin — helps the eye parse orientation.
    for (const [x1, y1, x2, y2] of [[0, -1, 0, 1], [-1, 0, 1, 0]]) {
      const ln = document.createElementNS(NS, 'line');
      ln.setAttribute('x1', x1); ln.setAttribute('y1', y1);
      ln.setAttribute('x2', x2); ln.setAttribute('y2', y2);
      ln.setAttribute('stroke', 'var(--ink-3, #aaa)');
      ln.setAttribute('stroke-width', 0.004);
      ln.setAttribute('stroke-dasharray', '0.02 0.02');
      ln.setAttribute('opacity', 0.35);
      gOutline.appendChild(ln);
    }

    if (!withHead) return;

    // Head silhouette as decorative reference for iEEG / fNIRS. The flat
    // pipeline doesn't project onto the head — this circle is pure visual
    // orientation, at 0.85 radius so electrodes near the edge of the
    // bounding box (e.g. subdural grids that extend to cortical surface)
    // remain clearly distinguishable from the outline.
    const headR = 0.85;
    const head = document.createElementNS(NS, 'circle');
    head.setAttribute('cx', 0); head.setAttribute('cy', 0);
    head.setAttribute('r', headR);
    head.setAttribute('fill', 'none');
    head.setAttribute('stroke', 'var(--ink-2, #3a3d42)');
    head.setAttribute('stroke-width', 0.006);
    head.setAttribute('stroke-dasharray', '0.02 0.02');
    head.setAttribute('opacity', 0.5);
    gOutline.appendChild(head);

    // Nose at the top (+Y). Y axis in flat mode is screen-up thanks to
    // the project()'s y-flip, so a triangular peak at -Y (screen-up)
    // reads as "front of head".
    const nose = document.createElementNS(NS, 'path');
    nose.setAttribute(
      'd',
      `M ${-0.12 * headR} ${-headR * 0.995} ` +
      `Q ${-0.05 * headR} ${-headR * 1.08}, 0 ${-headR * 1.12} ` +
      `Q ${0.05 * headR} ${-headR * 1.08}, ${0.12 * headR} ${-headR * 0.995}`
    );
    nose.setAttribute('fill', 'none');
    nose.setAttribute('stroke', 'var(--ink-2, #3a3d42)');
    nose.setAttribute('stroke-width', 0.006);
    nose.setAttribute('stroke-linecap', 'round');
    nose.setAttribute('opacity', 0.5);
    gOutline.appendChild(nose);

    // Ears at ±X — faint arcs.
    for (const sign of [-1, 1]) {
      const ear = document.createElementNS(NS, 'path');
      const x1 = sign * headR * 0.995;
      ear.setAttribute(
        'd',
        `M ${x1} ${-0.13 * headR} ` +
        `C ${sign * headR * 1.06} ${-0.09 * headR}, ` +
        `${sign * headR * 1.08} ${0.02 * headR}, ` +
        `${sign * headR * 1.07} ${0.09 * headR} ` +
        `C ${sign * headR * 1.06} ${0.15 * headR}, ` +
        `${sign * headR * 1.04} ${0.18 * headR}, ` +
        `${x1} ${0.18 * headR}`
      );
      ear.setAttribute('fill', 'none');
      ear.setAttribute('stroke', 'var(--ink-2, #3a3d42)');
      ear.setAttribute('stroke-width', 0.006);
      ear.setAttribute('stroke-linecap', 'round');
      ear.setAttribute('opacity', 0.5);
      gOutline.appendChild(ear);
    }
  }

  // --- Landmarks ---------------------------------------------
  const LANDMARKS = [
    { name: 'Nasion', x: 0,     y: -1.06, anchor: 'middle', baseline: 'bottom' },
    { name: 'Inion',  x: 0,     y: 1.06,  anchor: 'middle', baseline: 'hanging' },
    { name: 'LPA',    x: -1.06, y: 0,     anchor: 'end',    baseline: 'middle' },
    { name: 'RPA',    x: 1.06,  y: 0,     anchor: 'start',  baseline: 'middle' },
  ];

  function buildLandmarks() {
    const NS = 'http://www.w3.org/2000/svg';
    while (gLandmarks.firstChild) gLandmarks.removeChild(gLandmarks.firstChild);
    // Flat layouts don't have nasion/inion/LPA/RPA — they're scalp-specific.
    if (layoutStyle === 'flat') {
      gLandmarks.style.display = 'none';
      return;
    }
    gLandmarks.style.display = opts.showLandmarks ? '' : 'none';
    LANDMARKS.forEach(lm => {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', lm.x);
      t.setAttribute('y', lm.y);
      t.setAttribute('text-anchor', lm.anchor);
      t.setAttribute('dominant-baseline', lm.baseline);
      t.setAttribute('font-size', 0.045);
      t.setAttribute('font-family', 'IBM Plex Mono, monospace');
      t.setAttribute('font-weight', 500);
      t.setAttribute('letter-spacing', '0.02em');
      t.setAttribute('fill', 'var(--muted, #8a8a85)');
      t.setAttribute('opacity', 0.7);
      t.textContent = lm.name.toUpperCase();
      gLandmarks.appendChild(t);
    });
    gLandmarks.style.display = opts.showLandmarks ? '' : 'none';
  }

  // --- Electrodes --------------------------------------------
  function baseRadius() {
    // Electrodes are drawn as proper markers. dotSize is a 0.3–1.5 multiplier.
    return 0.022 * (opts.dotSize || 1);
  }

  function buildElectrodes() {
    const NS = 'http://www.w3.org/2000/svg';
    while (gElectrodes.firstChild) gElectrodes.removeChild(gElectrodes.firstChild);
    while (gLabels.firstChild) gLabels.removeChild(gLabels.firstChild);

    const r = baseRadius();

    electrodes.forEach(el => {
      const p = project(el);
      el._px = p.x;
      el._py = p.y;

      // Electrode dot — simple filled circle with a thin stroke.
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', p.x);
      dot.setAttribute('cy', p.y);
      dot.setAttribute('r', r);
      dot.setAttribute('stroke', 'rgba(0,0,0,0.35)');
      dot.setAttribute('stroke-width', 0.004);
      dot.setAttribute('data-name', el.name);
      dot.classList.add('topo-dot');
      gElectrodes.appendChild(dot);
      el._dot = dot;

      // Label — only placed for a subset based on density setting.
      const label = document.createElementNS(NS, 'text');
      label.setAttribute('x', p.x);
      label.setAttribute('y', p.y - r - 0.012);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'alphabetic');
      label.setAttribute('font-size', 0.038);
      label.setAttribute('font-family', 'IBM Plex Mono, monospace');
      label.setAttribute('font-weight', 500);
      label.setAttribute('fill', 'var(--ink, #17181a)');
      label.setAttribute('paint-order', 'stroke');
      label.setAttribute('stroke', 'var(--bg, #faf9f5)');
      label.setAttribute('stroke-width', 0.012);
      label.setAttribute('stroke-linejoin', 'round');
      label.setAttribute('pointer-events', 'none');
      label.textContent = el.name;
      gLabels.appendChild(label);
      el._label = label;
    });

    applyStyling();
  }

  // --- Styling (colors, selection, filter, hover) -------------
  function applyStyling() {
    const isFiltered = !!filtered;
    const hoverName = hovered;

    electrodes.forEach(el => {
      if (!el._dot) return;
      const dim = dimmedRegions.has(el.region) || (isFiltered && !filtered.has(el.name));
      const sel = selected.has(el.name);
      const isHover = el.name === hoverName;

      let fill = colorFor(el);
      // Stroke matches the fill family so mono electrodes look cohesive
      // instead of fill+hard-black-ring.
      let stroke = (opts.colorMode === 'uniform' || (opts.colorMode === 'highlight' && !sel))
        ? MONO_STROKE
        : 'rgba(23,24,26,0.45)';
      let sw = 0.005;

      if (sel) {
        fill = SEL_FILL;
        stroke = 'oklch(0.32 0.14 40)';
        sw = 0.012;
      }
      if (isHover) {
        stroke = '#e0521f';
        sw = 0.014;
      }

      el._dot.setAttribute('fill', fill);
      el._dot.setAttribute('stroke', stroke);
      el._dot.setAttribute('stroke-width', sw);
      el._dot.setAttribute('opacity', dim ? 0.18 : 1);

      // Label opacity follows density setting + dim state.
      if (el._label) {
        let show = true;
        if (opts.labelDensity === 'none') show = false;
        else if (opts.labelDensity === 'smart') {
          // Sphere layouts: labels readable up to ≈32 sensors; beyond that
          // switch to on-demand (selected / hovered / search-matched).
          // Flat layouts (fNIRS / EMG / iEEG-brain): physically close
          // source/detector pairs collide even at 20 sensors, so default
          // to on-demand here too — labels still appear on hover.
          if (layoutStyle === 'flat' || electrodes.length > 32) {
            show = sel || isHover || (isFiltered && filtered.has(el.name));
          }
        }
        el._label.style.display = show ? '' : 'none';
        el._label.setAttribute('opacity', dim ? 0.25 : (sel || isHover ? 1 : 0.85));
        if (sel) el._label.setAttribute('font-weight', 600);
        else el._label.setAttribute('font-weight', 500);
        el._label.setAttribute('fill', sel ? 'oklch(0.45 0.18 45)' : 'var(--ink, #17181a)');
      }
    });
  }

  // --- Event wiring -------------------------------------------
  function installEvents() {
    gElectrodes.addEventListener('mousemove', e => {
      const tgt = e.target.closest('.topo-dot');
      if (!tgt) return onHover(null);
      const name = tgt.getAttribute('data-name');
      const el = electrodes.find(x => x.name === name);
      if (!el) return;
      onHover({
        name: el.name,
        region: el.region,
        x: el.x, y: el.y, z: el.z,
        clientX: e.clientX, clientY: e.clientY,
      });
    });
    gElectrodes.addEventListener('mouseleave', () => onHover(null));

    gElectrodes.addEventListener('click', e => {
      const tgt = e.target.closest('.topo-dot');
      if (!tgt) {
        emit('click', null);
        return;
      }
      const name = tgt.getAttribute('data-name');
      emit('click', { name, shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
    });
  }

  function onHover(data) {
    hovered = data ? data.name : null;
    applyStyling();
    emit('hover', data);
  }

  function emit(evt, data) {
    (listeners[evt] || []).forEach(fn => fn(data));
  }

  // --- Public API --------------------------------------------
  api.init = function (containerEl) {
    container = containerEl;

    const NS = 'http://www.w3.org/2000/svg';
    svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'topo-svg');
    svg.setAttribute('viewBox', `${-VB} ${-VB} ${VB * 2} ${VB * 2}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.cssText = 'width:100%;height:100%;display:block;';

    gOutline = document.createElementNS(NS, 'g');
    gLandmarks = document.createElementNS(NS, 'g');
    gElectrodes = document.createElementNS(NS, 'g');
    gLabels = document.createElementNS(NS, 'g');
    gLabels.style.pointerEvents = 'none';

    svg.appendChild(gOutline);
    svg.appendChild(gLandmarks);
    svg.appendChild(gElectrodes);
    svg.appendChild(gLabels);

    container.appendChild(svg);
    installEvents();
  };

  api.on = function (evt, fn) {
    if (!listeners[evt]) listeners[evt] = [];
    listeners[evt].push(fn);
  };

  api.setMontage = function (key, data) {
    electrodes = (data.electrodes || []).map(e => ({ ...e }));
    // Built-in montages (no layoutStyle set) render as sphere; only
    // loaded non-scalp montages flip to flat.
    layoutStyle = data.layoutStyle === 'flat' ? 'flat' : 'sphere';
    currentModality = (data.modality || 'eeg').toLowerCase();
    buildOutline();
    buildLandmarks();
    buildElectrodes();
  };

  api.setSelected = function (names) {
    selected = new Set(names || []);
    applyStyling();
  };

  api.setFiltered = function (names) {
    filtered = names ? new Set(names) : null;
    applyStyling();
  };

  api.setDimmedRegions = function (regions) {
    dimmedRegions = new Set(regions || []);
    applyStyling();
  };

  api.setOpts = function (newOpts) {
    const prev = opts;
    opts = { ...opts, ...newOpts };
    if (prev.headOpacity !== opts.headOpacity || prev.showHead !== opts.showHead) buildOutline();
    if (prev.showLandmarks !== opts.showLandmarks) buildLandmarks();
    if (prev.dotSize !== opts.dotSize) {
      const r = baseRadius();
      electrodes.forEach(el => { if (el._dot) el._dot.setAttribute('r', r); });
    }
    applyStyling();
  };

  api.setView = function () {
    // No-op in 2D top-view; kept for API parity.
  };

  api.show = function (visible) {
    if (svg) svg.style.display = visible ? '' : 'none';
  };

  api.isReady = function () { return svg !== null; };

  window.EEGTopo2D = api;
})();
