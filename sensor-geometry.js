/* BIDS sensor geometry. Coordinate conventions: docs/sensor-geometry.md. */
(function () {
  'use strict';
  const finitePoint = p => p && [p.x, p.y, p.z].every(Number.isFinite);
  const key = name => String(name || '').trim().toLowerCase();
  const als = /^(ctf|4dbti|kityokogawa|eeglab|eeglab-hj)$/i;
  const ras = /^(captrak|neuromagelektamegin|elektaneuromag|chietiitab|acpc|scanras|mne head|ras)$/i;

  function displayPoint(p, space, units) {
    const scale = ({ m: 1000, cm: 10, mm: 1 })[units] || 1;
    const xyz = als.test(space) ? [-p.y, p.x, p.z] : [p.x, p.y, p.z];
    return xyz.map(v => v * scale);
  }

  function buildGroups(meta = {}, reader = {}, montage = globalThis.SensorMontage || {}) {
    const modality = (meta.suffix || 'eeg').toLowerCase();
    const groups = [];
    const channels = new Map((meta.channels || []).map(c => [key(c.name), c]));
    const add = (points, cs, source, template = false) => {
      const frames = new Map();
      for (const p of points || []) {
        if (!finitePoint(p)) continue;
        const space = p.coordinate_system || cs?.id || cs?.space || 'Other';
        // EMG can name several independent local coordinate systems.
        // Never merge their origins or apply the parent's units to one.
        const child = p.coordinate_system && p.coordinate_system !== (cs?.id || cs?.space);
        const units = child ? 'n/a' : (cs?.units || 'n/a');
        const convention = child ? 'Other' : (cs?.space || 'Other');
        const id = `${space}/${units}`;
        if (!frames.has(id)) frames.set(id, { space, units, source, template,
          displaySpace: cs?.to_head ? 'MNE head' : convention, points: [] });
        const channel = channels.get(key(p.name));
        const transformed = cs?.to_head ? [0, 1, 2].map(i => {
          const t = cs.to_head;
          return t[i * 4] * p.x + t[i * 4 + 1] * p.y + t[i * 4 + 2] * p.z + t[i * 4 + 3];
        }) : null;
        frames.get(id).points.push({ ...p, type: p.type || channel?.type || cs?.modality?.toUpperCase() || modality.toUpperCase(),
          bad: channel?.status === 'bad', display: transformed ? transformed.map(v => v * 1000) : displayPoint(p, convention, units) });
      }
      groups.push(...frames.values());
    };
    const sidecar = modality === 'nirs' ? meta.optodes : meta.electrodes;
    if (meta.coordinate_sets?.length) {
      for (const set of meta.coordinate_sets) add(set.points, set.coordsystem, set.source);
    } else if (sidecar?.length) {
      add(sidecar, meta.coordsystem, modality === 'nirs' ? 'BIDS optodes.tsv' : 'BIDS electrodes.tsv');
    }
    // FIFF MEG coils and EEG electrodes use different frames. Even when
    // EEG sidecars exist, keep the MEG device geometry available.
    for (const native of reader.sensor_geometry || []) {
      if (!(sidecar?.length || meta.coordinate_supplied) || native.points?.some(p => /^MEG/.test(p.type))) {
        add(native.points, native, native.source);
      }
    }
    // Exact EEG label matching only. Never invent intracranial, muscle,
    // optode, or MEG locations, or fill holes in participant geometry.
    const supplied = sidecar?.length || meta.coordinate_supplied || meta.sidecar_sources?.[modality === 'nirs' ? 'optodes' : 'electrodes'];
    if (!groups.length && !supplied && modality === 'eeg') {
      const standard = new Map(Object.entries(montage).map(([name, xyz]) => [key(name), xyz]));
      const labels = reader.channel_labels || (meta.channels || []).map(c => c.name);
      const points = [];
      for (const name of labels) {
        const type = channels.get(key(name))?.type;
        const xyz = standard.get(key(name));
        if (xyz && (!type || /^EEG$/i.test(type))) points.push({ name, type: 'EEG', x: xyz[0], y: xyz[1], z: xyz[2] });
      }
      add(points, { space: 'MNE head', units: 'm' }, 'MNE standard_1020 template', true);
    }
    return groups;
  }

  let ui;
  function boot({ onTraces } = {}) {
    const $ = id => document.getElementById(id);
    if (!$('geometry-panel') || ui) return;
    const panel = $('geometry-panel'), canvas = $('geometry-canvas'), stage = $('stage');
    let groups = [], group = null, selected = 0, projected = null, meta = null, reader = null;
    let yaw = -0.35, pitch = 0.28, zoom = 1, drag = null, frame = 0, epoch = 0;
    const schedule = () => {
      if (!frame && !panel.hidden) frame = requestAnimationFrame(() => { frame = 0; draw(); });
    };
    function setView(geometry) {
      stage.dataset.view = geometry ? 'geometry' : 'traces';
      panel.hidden = !geometry;
      $('view-traces').setAttribute('aria-pressed', String(!geometry));
      $('view-geometry').setAttribute('aria-pressed', String(geometry));
      if (geometry) schedule(); else onTraces?.();
    }
    function selectPoint(i) {
      selected = i;
      $('geometry-sensor').value = String(i);
      const p = group?.points[i];
      $('geometry-readout').textContent = p
        ? `${p.name} · ${p.type}${p.bad ? ' · marked bad' : ''} · ${group.space} · x ${p.x.toPrecision(5)}  y ${p.y.toPrecision(5)}  z ${p.z.toPrecision(5)} ${group.units === 'n/a' ? '(units unspecified)' : group.units}` : '';
      schedule();
    }
    function chooseGroup(reset = true) {
      const rawGroup = groups[Number($('geometry-frame').value)] || null;
      const references = rawGroup?.points.filter(p => p.type === 'MEGREF').length || 0;
      $('geometry-references-label').hidden = !references;
      $('geometry-reference-count').textContent = references ? `(${references})` : '';
      if (reset !== false) { yaw = -0.35; pitch = 0.28; zoom = 1; $('geometry-references').checked = false; }
      if (reset !== false) {
        $('geometry-coordinate-frame').value = ''; $('geometry-coordinate-units').value = '';
        if (rawGroup?.points.length === references) $('geometry-references').checked = true;
      }
      const overrideFrame = $('geometry-coordinate-frame').value, overrideUnits = $('geometry-coordinate-units').value;
      group = rawGroup && { ...rawGroup, space: overrideFrame || rawGroup.space,
        displaySpace: overrideFrame || rawGroup.displaySpace, units: overrideUnits || rawGroup.units,
        points: rawGroup.points.filter(p => p.type !== 'MEGREF' || $('geometry-references').checked).map(p => ({
          ...p, display: overrideFrame || overrideUnits ? displayPoint(p, overrideFrame || rawGroup.displaySpace, overrideUnits || rawGroup.units) : p.display,
        })) };
      $('geometry-coordinate-controls').hidden = !group || rawGroup.space === 'FIFF device';
      // A frame's axes alone do not locate anatomy. ACPC, ScanRAS and
      // arbitrary device/body frames require their own registration.
      const space = group?.displaySpace || group?.space;
      const headFrame = /^(captrak|mne head|neuromagelektamegin|elektaneuromag|chietiitab|ctf|4dbti|kityokogawa|eeglab|eeglab-hj)$/i.test(space);
      const headAvailable = !!group && meta?.suffix !== 'emg' && headFrame && /^(m|cm|mm)$/.test(group.units);
      const wasDisabled = $('geometry-head').disabled;
      $('geometry-head').disabled = !headAvailable;
      $('geometry-head-opacity').disabled = !headAvailable;
      if (reset !== false || wasDisabled || !headAvailable) $('geometry-head').checked = headAvailable;
      if (reset !== false) $('geometry-coordinate-controls').open = !headAvailable;
      $('geometry-head-note').hidden = !group;
      $('geometry-head-note').textContent = headAvailable
        ? 'Reference head: MNE fsaverage scalp. Approximate atlas anatomy, not the participant’s head.'
        : 'Head unavailable in this coordinate frame. An anatomical registration and physical units are needed.';
      $('geometry-empty').hidden = !!group;
      $('geometry-tools').hidden = !group;
      canvas.hidden = !group;
      $('geometry-details').hidden = !group;
      $('geometry-source').textContent = group?.source?.split('/').at(-1) || 'Sensor positions';
      $('geometry-source').title = group?.source || '';
      if (group) {
        $('geometry-labels').checked = group.points.length <= 64;
        const known = als.test(group.displaySpace) || ras.test(group.displaySpace);
        const names = new Set(group.points.map(p => key(p.name)));
        const total = reader?.channel_labels?.length || meta?.channels?.length || 0;
        const matched = (reader?.channel_labels || (meta?.channels || []).map(c => c.name)).filter(n => names.has(key(n))).length;
        $('geometry-summary').textContent = `${group.points.length} positions · ${group.displaySpace === 'MNE head' ? group.displaySpace : group.space} · ${group.units === 'n/a' ? 'units unspecified' : group.units}`;
        $('geometry-note').textContent = [
          group.template ? 'Template positions; not participant digitization.' : 'Positions from the recording.',
          group.space === 'FIFF device' && group.displaySpace === 'MNE head' ? 'Device-to-head transform applied for display. Readout retains the original device coordinates.' : '',
          references ? `${references} reference coils are ${$('geometry-references').checked ? 'shown' : 'hidden'}; these are physically outside the measurement helmet.` : '',
          !known ? 'Original axes retained; anatomical orientation is unspecified.' : 'Axes shown as right, anterior, superior (RAS).',
          meta && total && meta.suffix !== 'nirs' ? `${matched} of ${total} recording channels located in this frame.` : '',
        ].filter(Boolean).join(' ');
        $('geometry-sensor').replaceChildren(...group.points.map((p, i) => new Option(`${p.name} · ${p.type}`, String(i))));
        selectPoint(0);
      } else {
        $('geometry-summary').textContent = meta ? `${(meta.suffix || 'eeg').toUpperCase()} · no 3D coordinates found` : 'EEG · iEEG · MEG · fNIRS · EMG';
        $('geometry-empty-title').textContent = meta ? 'This recording has no 3D positions' : 'See where your signals come from';
        $('geometry-empty-copy').textContent = meta
          ? 'Open the recording together with its electrodes.tsv (optodes.tsv for fNIRS) and coordsystem.json. Missing or 2D coordinates cannot define a 3D layout.'
          : 'Open a BIDS recording with its coordinate sidecars, or explore the standard EEG montage below.';
        $('geometry-preview').hidden = !!meta;
      }
      schedule();
    }
    function setGroups(next) {
      groups = next;
      $('geometry-frame').replaceChildren(...groups.map((g, i) => new Option(`${g.space} · ${g.source}`, String(i))));
      $('geometry-frame-label').hidden = groups.length < 2;
      chooseGroup();
    }

    function draw() {
      if (!group || panel.hidden) return;
      const rect = canvas.getBoundingClientRect(), w = rect.width, h = rect.height;
      if (w < 1 || h < 1) return;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      const css = getComputedStyle(stage);
      const ink = css.getPropertyValue('--ink').trim(), muted = css.getPropertyValue('--muted').trim();
      const accent = css.getPropertyValue('--accent').trim(), line = css.getPropertyValue('--line').trim();
      const points = group.points.map(p => p.display);
      const head = globalThis.SensorHead;
      const headPoints = !$('geometry-head').disabled ? head.vertices : [];
      // Keep the same fit when toggling the head, and the same scale while rotating.
      const all = [...points, ...headPoints];
      const min = [0, 1, 2].map(k => all.reduce((v, p) => Math.min(v, p[k]), Infinity));
      const max = [0, 1, 2].map(k => all.reduce((v, p) => Math.max(v, p[k]), -Infinity));
      const centre = min.map((v, k) => (v + max[k]) / 2);
      const radius = Math.max(1, ...all.map(p => Math.hypot(...p.map((v, k) => v - centre[k]))));
      const axisStart = all.length;
      all.push(centre, ...[0, 1, 2].map(k => centre.map((v, j) => v + (j === k ? radius * 0.5 : 0))));
      const viewPoints = all.flatMap(p => [-(p[0] - centre[0]), p[2] - centre[2], p[1] - centre[1]]);
      const { sx, sy, depth } = globalThis.PosePanel.rotateProject(Float32Array.from(viewPoints), all.length,
        yaw, pitch, w, h, Math.min(35, w * 0.08, h * 0.08), zoom, radius);
      projected = group.points.map((_, i) => ({ x: sx[i], y: sy[i], depth: depth[i] }));
      ctx.setLineDash([3, 5]); ctx.strokeStyle = muted; ctx.globalAlpha = 0.55;
      const known = als.test(group.displaySpace) || ras.test(group.displaySpace);
      ctx.font = '11px "IBM Plex Mono", monospace';
      for (let k = 0; k < 3; k++) {
        const i = axisStart + k + 1;
        ctx.beginPath(); ctx.moveTo(sx[axisStart], sy[axisStart]); ctx.lineTo(sx[i], sy[i]); ctx.stroke();
        ctx.fillStyle = ink; ctx.fillText((known ? ['R', 'A', 'S'] : ['X', 'Y', 'Z'])[k], sx[i] + 7, sy[i]);
      }
      ctx.globalAlpha = 1; ctx.setLineDash([]);
      const order = group.points.map((p, i) => ({ i, depth: depth[i] }));
      const back = Math.min(...points.map((_, i) => depth[i]));
      const span = Math.max(1e-6, ...points.map((_, i) => depth[i] - back));
      if (headPoints.length && $('geometry-head').checked) {
        for (const face of head.triangles) {
          const ids = face.map(i => points.length + i);
          const [a, b, c] = ids.map(i => viewPoints.slice(i * 3, i * 3 + 3));
          const u = b.map((v, i) => v - a[i]), v = c.map((v, i) => v - a[i]);
          const n = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
          const facing = (n[1] * Math.sin(pitch) + (-n[0] * Math.sin(yaw) + n[2] * Math.cos(yaw)) * Math.cos(pitch)) / (Math.hypot(...n) || 1);
          if (facing <= 0) continue;
          order.push({ ids, depth: ids.reduce((sum, i) => sum + depth[i], 0) / 3, shade: Math.round(177 + 57 * facing) });
        }
      }
      order.sort((a, b) => a.depth - b.depth);
      for (const item of order) {
        if (item.ids) {
          ctx.globalAlpha = Number($('geometry-head-opacity').value);
          ctx.fillStyle = `rgb(${item.shade}, ${item.shade - 3}, ${item.shade - 8})`;
          ctx.beginPath();
          item.ids.forEach((id, j) => j ? ctx.lineTo(sx[id], sy[id]) : ctx.moveTo(sx[id], sy[id]));
          ctx.closePath(); ctx.fill();
          continue;
        }
        const i = item.i;
        const p = group.points[i], active = i === selected;
        ctx.globalAlpha = active ? 1 : 0.4 + 0.6 * (depth[i] - back) / span;
        const detector = /^detector$/i.test(p.type);
        ctx.fillStyle = p.bad ? css.getPropertyValue('--bad').trim() : active ? ink : accent;
        ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = active ? 2 : 1.5;
        ctx.beginPath();
        if (detector) ctx.rect(sx[i] - 4, sy[i] - 4, 8, 8);
        else ctx.arc(sx[i], sy[i], active ? 6 : 4, 0, Math.PI * 2);
        if (detector) ctx.stroke(); else ctx.fill();
        if (active) { ctx.beginPath(); ctx.arc(sx[i], sy[i], 10, 0, Math.PI * 2); ctx.stroke(); }
        if (active || $('geometry-labels').checked) {
          ctx.font = `${active ? '600 ' : ''}11px "IBM Plex Mono", monospace`;
          ctx.lineWidth = 3; ctx.strokeStyle = css.getPropertyValue('--bg').trim();
          ctx.strokeText(p.name, sx[i] + 10, sy[i] - 7);
          ctx.fillStyle = active ? ink : muted;
          ctx.fillText(p.name, sx[i] + 10, sy[i] - 7);
        }
      }
      // Keep the selected marker readable even when it is behind the
      // translucent atlas surface; coordinates and depth remain unchanged.
      if (group.points[selected]) {
        ctx.globalAlpha = 1; ctx.strokeStyle = ink; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sx[selected], sy[selected], 10, 0, Math.PI * 2); ctx.stroke();
        ctx.font = '600 11px "IBM Plex Mono", monospace';
        ctx.lineWidth = 3; ctx.strokeStyle = css.getPropertyValue('--bg').trim();
        ctx.strokeText(group.points[selected].name, sx[selected] + 10, sy[selected] - 7);
        ctx.fillStyle = ink; ctx.fillText(group.points[selected].name, sx[selected] + 10, sy[selected] - 7);
      }
    }
    $('view-traces').addEventListener('click', () => setView(false));
    $('view-geometry').addEventListener('click', () => setView(true));
    $('geometry-frame').addEventListener('change', chooseGroup);
    $('geometry-sensor').addEventListener('change', e => selectPoint(Number(e.target.value)));
    $('geometry-labels').addEventListener('change', schedule);
    $('geometry-head').addEventListener('change', schedule);
    $('geometry-head-opacity').addEventListener('input', schedule);
    $('geometry-coordinate-frame').addEventListener('change', () => chooseGroup(false));
    $('geometry-coordinate-units').addEventListener('change', () => chooseGroup(false));
    $('geometry-references').addEventListener('change', () => chooseGroup(false));
    $('geometry-preview').addEventListener('click', () => {
      reader = { channel_labels: Object.keys(globalThis.SensorMontage) };
      setGroups(buildGroups({ suffix: 'eeg' }, reader));
    });
    $('geometry-import').addEventListener('click', () => $('geometry-files').click());
    async function openFiles(input) {
      const current = ++epoch;
      let files = [...input];
      setView(true);
      try {
        // Accept a single plain TSV export as well as BIDS filenames.
        if (!files.some(f => /(?:^|_)(electrodes|optodes)\.tsv$/i.test(f.name)) && files.filter(f => /\.tsv$/i.test(f.name)).length === 1) {
          files = files.map(f => ({ name: /\.tsv$/i.test(f.name) ? 'electrodes.tsv' : /\.json$/i.test(f.name) ? 'coordsystem.json' : f.name,
            source: f.name, size: f.size, text: () => f.text() }));
        }
        const bundle = await globalThis.BIDSRecording.loadCoordinateSets(files);
        if (current !== epoch) return;
        if (!bundle.coordinate_sets.length) throw new Error(bundle.coordinate_errors.join(' · ') || 'Select electrodes.tsv or optodes.tsv, optionally with matching coordsystem.json files.');
        const suffix = bundle.coordinate_sets.find(s => s.coordsystem?.modality)?.coordsystem.modality
          || (bundle.coordinate_sets[0].kind === 'optodes' ? 'nirs' : 'sensors');
        meta = { suffix, ...bundle }; reader = null;
        setGroups(buildGroups(meta));
        $('geometry-error').textContent = bundle.coordinate_errors.join(' · ');
        $('geometry-error').hidden = !bundle.coordinate_errors.length;
      } catch (error) {
        if (current !== epoch) return;
        $('geometry-error').textContent = error.message;
        $('geometry-error').hidden = false;
      }
    }
    async function openUrls(tableUrl, coordsUrl) {
      try {
        const files = [tableUrl, coordsUrl].filter(Boolean).map(value => {
          const url = new URL(value, location.href);
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Coordinate URLs must use HTTP or HTTPS.');
          return { name: url.href, text: () => globalThis.HttpRange.fetchTextOrNull(url.href) };
        });
        await openFiles(files);
      } catch (error) { setView(true); $('geometry-error').textContent = error.message; $('geometry-error').hidden = false; }
    }
    $('geometry-files').addEventListener('change', e => {
      const files = [...e.target.files]; e.target.value = '';
      if (files.length) openFiles(files);
    });
    panel.querySelectorAll('[data-camera]').forEach(button => button.addEventListener('click', () => {
      [yaw, pitch] = ({ front: [0, 0], side: [Math.PI / 2, 0], top: [Math.PI, Math.PI / 2], reset: [-0.35, 0.28] })[button.dataset.camera];
      zoom = 1; schedule();
    }));
    const zoomBy = value => { zoom = Math.max(0.4, Math.min(4, zoom * value)); schedule(); };
    $('geometry-zoom-in').addEventListener('click', () => zoomBy(1.2));
    $('geometry-zoom-out').addEventListener('click', () => zoomBy(1 / 1.2));
    canvas.addEventListener('wheel', e => { e.preventDefault(); zoomBy(Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) * 0.005)); }, { passive: false });
    canvas.addEventListener('pointerdown', e => {
      drag = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY };
      canvas.setPointerCapture(e.pointerId); canvas.focus();
    });
    canvas.addEventListener('pointermove', e => {
      if (!drag) return;
      yaw += (e.clientX - drag.x) * 0.008; pitch += (e.clientY - drag.y) * 0.008;
      drag.x = e.clientX; drag.y = e.clientY; schedule();
    });
    canvas.addEventListener('pointerup', e => {
      if (drag && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5 && projected) {
        const rect = canvas.getBoundingClientRect();
        const hits = projected.map((p, i) => ({ ...p, i, distance: Math.hypot(p.x - (e.clientX - rect.left), p.y - (e.clientY - rect.top)) }))
          .filter(p => p.distance < 14).sort((a, b) => b.depth - a.depth);
        if (hits.length) selectPoint(hits[0].i);
      }
      drag = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    });
    for (const event of ['pointercancel', 'lostpointercapture']) canvas.addEventListener(event, () => { drag = null; });
    canvas.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'Home'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'ArrowLeft') yaw -= 0.15;
      if (e.key === 'ArrowRight') yaw += 0.15;
      if (e.key === 'ArrowUp') pitch -= 0.15;
      if (e.key === 'ArrowDown') pitch += 0.15;
      if (e.key === '+' || e.key === '=') zoomBy(1.2);
      if (e.key === '-') zoomBy(1 / 1.2);
      if (e.key === 'Home') { yaw = -0.35; pitch = 0.28; zoom = 1; }
      schedule();
    });
    new ResizeObserver(schedule).observe(canvas);
    ui = {
      openFiles, openUrls,
      setRecording(m, r) { epoch++; meta = m; reader = r; setGroups(buildGroups(m, r));
        $('geometry-error').textContent = (m.coordinate_errors || []).join(' · ');
        $('geometry-error').hidden = !m.coordinate_errors?.length; },
      clear() { epoch++; meta = reader = null; setGroups([]); $('geometry-error').hidden = true; setView(false); },
    };
    chooseGroup();
  }
  const api = { displayPoint, buildGroups, boot, openFiles: files => ui?.openFiles(files), openUrls: (t, c) => ui?.openUrls(t, c), setRecording: (m, r) => ui?.setRecording(m, r), clear: () => ui?.clear() };
  globalThis.SensorGeometry = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
