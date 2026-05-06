/* ============================================================
   bids-loader.js — parse BIDS electrodes.tsv + coordsystem.json
   and produce a montage object in the same shape montages.js
   exposes, so the rest of the app consumes it unchanged.

   Pipeline: parse → unit-scale → sphere-fit → unit-normalize to
   (ux, uy, uz). The renderers already speak (ux, uy, uz).

   Sphere fit mirrors MNE's two paths:
     1. EEGLAB 4-point: radius = mean(|T7.x|, |T8.x|, |Fpz.y|, |Oz.y|)
        centered on the mean of those four electrodes.
     2. Linear least-squares fallback: solve [2x 2y 2z 1]·u = x²+y²+z².
   ============================================================ */
(function () {
  'use strict';

  const api = {};

  // ---- TSV parsing --------------------------------------------
  api.parseElectrodesTSV = function (text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) throw new Error('electrodes.tsv has no rows');

    const headers = lines[0].split('\t').map(h => h.trim().toLowerCase());
    const col = (name) => headers.indexOf(name);
    const iName = col('name'), iX = col('x'), iY = col('y'), iZ = col('z');
    if (iName < 0 || iX < 0 || iY < 0 || iZ < 0) {
      throw new Error('electrodes.tsv is missing one of: name, x, y, z');
    }
    const iType = col('type'), iMat = col('material');

    // Optional BIDS columns we preserve if present: `coordinate_system` and
    // `group` drive multi-frame EMG panelling; `hemisphere` helps iEEG.
    const iCoordSys = headers.indexOf('coordinate_system');
    const iGroup = headers.indexOf('group');
    const iHemi = headers.indexOf('hemisphere');

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split('\t');
      const name = (c[iName] || '').trim();
      const x = parseFloat(c[iX]);
      const y = parseFloat(c[iY]);
      const z = parseFloat(c[iZ]);
      // BIDS uses "n/a" for missing; parseFloat → NaN → skip.
      if (!name || !isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
      const row = {
        name, x, y, z,
        type: iType >= 0 ? (c[iType] || '').trim() : '',
        material: iMat >= 0 ? (c[iMat] || '').trim() : '',
      };
      if (iCoordSys >= 0 && c[iCoordSys] && c[iCoordSys].trim() && c[iCoordSys].trim().toLowerCase() !== 'n/a') {
        row.coordinate_system = c[iCoordSys].trim();
      }
      if (iGroup >= 0 && c[iGroup] && c[iGroup].trim() && c[iGroup].trim().toLowerCase() !== 'n/a') {
        row.group = c[iGroup].trim();
      }
      if (iHemi >= 0 && c[iHemi] && c[iHemi].trim() && c[iHemi].trim().toLowerCase() !== 'n/a') {
        row.hemisphere = c[iHemi].trim();
      }
      rows.push(row);
    }
    if (rows.length < 4) throw new Error('Need at least 4 electrodes with finite x,y,z');
    return rows;
  };

  // ---- coordsystem.json ---------------------------------------
  api.parseCoordsystem = function (jsonOrText) {
    const obj = typeof jsonOrText === 'string' ? JSON.parse(jsonOrText) : jsonOrText;
    // BIDS prefixes coordinate keys by datatype: EEGCoordinateSystem,
    // iEEGCoordinateSystem, MEGCoordinateSystem, EMGCoordinateSystem (BEP-030),
    // NIRSCoordinateSystem. Pick whichever prefix has a match.
    const prefixes = ['EEG', 'iEEG', 'MEG', 'EMG', 'NIRS'];
    const prefix = prefixes.find(
      p => obj[p + 'CoordinateSystem'] || obj[p + 'CoordinateUnits']
    ) || 'EEG';
    return {
      space: obj[prefix + 'CoordinateSystem'] || 'Other',
      units: (obj[prefix + 'CoordinateUnits'] || 'm').toLowerCase(),
      landmarks: obj.AnatomicalLandmarkCoordinates || null,
    };
  };

  function declaredUnitScale(u) {
    if (u === 'mm') return 0.001;
    if (u === 'cm') return 0.01;
    return 1;                       // 'm' or unknown → assume meters
  }

  // BIDS coordinate-system conventions differ on where +X and +Y point.
  // Our 2D/3D viewer assumes RAS+ (+X=right, +Y=anterior, +Z=up). EEGLAB,
  // CTF, 4D and KIT use ALS (+X=anterior, +Y=left, +Z=up). Datasets declared
  // in ALS-style frames need to be rotated before the sphere fit, otherwise
  // the whole cap appears rotated 90° in the viewer. CapTrak, MNI*, ACPC,
  // Talairach, ScanRAS and fsaverage are already RAS+; everything else
  // defaults to identity.
  //
  // See BIDS appendix on coordinate systems:
  //   https://bids-specification.readthedocs.io/en/stable/appendices/coordinate-systems.html
  //
  // Note: ds002578 declares "CTF" but the maintainer has publicly acknowledged
  // the label is wrong and the data is really in EEGLAB convention
  // (same ALS axes, so the rotation applies either way).
  const ALS_TO_RAS = {
    name: 'ALS→RAS+',
    apply: (e) => ({ ...e, x: -e.y, y: e.x, z: e.z }),
  };

  function axisTransformForSpace(space) {
    if (!space) return null;
    const s = space.toUpperCase();
    if (s === 'EEGLAB' || s === 'CTF' || s === '4D' || s === 'KIT') {
      return ALS_TO_RAS;
    }
    return null;                    // identity for RAS+ frames and unknown
  }

  /* Detect ALS-stored data when the coordsystem declares "Other" or is
     missing entirely. Some public datasets (e.g. ds001971) store x=anterior
     / y=left but declare the frame as "Other", so the above lookup returns
     null and electrodes render rotated 90° (frontal labels land on the
     right side of the head in the topomap).

     Two heuristics, both using the sensor cloud itself:

     1. If a standard 10-20 frontal label is present (Fp1/Fp2/Fpz/Nz),
        it should sit at high +Y in RAS+. If instead its |x| > |y| AND
        x > 0 for Fp* / Nz, the cloud is ALS.
     2. Fallback when no named landmarks are present: if Fpz/Cz aren't
        found, return null (we can't guess). RAS+ is the safer default.

     Returns the ALS→RAS+ transform when detection is confident, else null. */
  function inferAxisTransformFromSensors(sensors) {
    if (!Array.isArray(sensors) || sensors.length < 4) return null;
    const byName = {};
    for (const s of sensors) {
      const k = (s.name || '').toUpperCase();
      if (k) byName[k] = s;
    }
    // Probe candidates, front-most 10-20 labels first.
    const frontCandidates = ['FPZ', 'NZ', 'FP1', 'FP2', 'AFZ', 'AFP1', 'AFP2'];
    const backCandidates  = ['OZ', 'IZ', 'O1', 'O2', 'POO1', 'POO2'];
    const pickFirst = (keys) => {
      for (const k of keys) if (byName[k]) return byName[k];
      return null;
    };
    const front = pickFirst(frontCandidates);
    const back  = pickFirst(backCandidates);
    if (!front) return null;
    // Anterior marker should dominate on the anterior axis. In RAS+ that's
    // +Y; in ALS it's +X. Pick whichever axis has the larger magnitude,
    // signed toward anterior (toward the nose).
    const ax = Math.abs(front.x);
    const ay = Math.abs(front.y);
    // If we also have an occipital anchor, check it points opposite along
    // the same axis — removes false positives from single-sensor flukes.
    if (ay > 1.3 * ax && front.y > 0) return null;         // already RAS+
    if (ax > 1.3 * ay && front.x > 0) {
      if (back && back.x > 0) return null;                 // front + back both at +X: not ALS
      return ALS_TO_RAS;
    }
    return null;
  }

  // Infer the scale that turns a raw sphere radius into meters, based on what
  // is physically plausible for a human head (~40-150 mm). We trust the data
  // over coordsystem.json, which lies often enough in the wild (see ds002578
  // which declares mm but stores meters).
  function inferMetersScaleFromRadius(rawR) {
    const candidates = [
      { unit: 'm',  scale: 1,     min: 0.04, max: 0.20 },
      { unit: 'mm', scale: 0.001, min: 40,   max: 200 },
      { unit: 'cm', scale: 0.01,  min: 4,    max: 20 },
    ];
    for (const c of candidates) {
      if (rawR >= c.min && rawR <= c.max) return c;
    }
    return null;
  }

  // ---- Sphere fits --------------------------------------------
  function fitSphereEeglab(els) {
    const by = {};
    for (const e of els) by[e.name.toUpperCase()] = e;
    const fpz = by.FPZ, oz = by.OZ;
    const t7  = by.T7 || by.T3;     // T3/T4 are the pre-2005 names
    const t8  = by.T8 || by.T4;
    if (!fpz || !oz || !t7 || !t8) return null;
    const cx = (fpz.x + oz.x + t7.x + t8.x) / 4;
    const cy = (fpz.y + oz.y + t7.y + t8.y) / 4;
    const cz = (fpz.z + oz.z + t7.z + t8.z) / 4;
    const r  = (Math.abs(t7.x - cx) + Math.abs(t8.x - cx) +
                Math.abs(fpz.y - cy) + Math.abs(oz.y - cy)) / 4;
    if (!isFinite(r) || r <= 0) return null;
    return [cx, cy, cz, r];
  }

  function fitSphereLstsq(els) {
    // Solve normal equations AtA·u = Atb for 4-unknown linear system.
    const AtA = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
    const Atb = [0, 0, 0, 0];
    for (const e of els) {
      const a = [2 * e.x, 2 * e.y, 2 * e.z, 1];
      const b = e.x * e.x + e.y * e.y + e.z * e.z;
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) AtA[i][j] += a[i] * a[j];
        Atb[i] += a[i] * b;
      }
    }
    const u = gaussSolve4(AtA, Atb);
    if (!u) return null;
    const [cx, cy, cz, d] = u;
    const r = Math.sqrt(cx * cx + cy * cy + cz * cz + d);
    if (!isFinite(r) || r <= 0) return null;
    return [cx, cy, cz, r];
  }

  function gaussSolve4(A, b) {
    const M = [
      [A[0][0], A[0][1], A[0][2], A[0][3], b[0]],
      [A[1][0], A[1][1], A[1][2], A[1][3], b[1]],
      [A[2][0], A[2][1], A[2][2], A[2][3], b[2]],
      [A[3][0], A[3][1], A[3][2], A[3][3], b[3]],
    ];
    for (let i = 0; i < 4; i++) {
      let p = i;
      for (let k = i + 1; k < 4; k++) {
        if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
      }
      if (Math.abs(M[p][i]) < 1e-12) return null;
      if (p !== i) { const t = M[i]; M[i] = M[p]; M[p] = t; }
      for (let k = i + 1; k < 4; k++) {
        const f = M[k][i] / M[i][i];
        for (let j = i; j < 5; j++) M[k][j] -= f * M[i][j];
      }
    }
    const x = [0, 0, 0, 0];
    for (let i = 3; i >= 0; i--) {
      let s = M[i][4];
      for (let j = i + 1; j < 4; j++) s -= M[i][j] * x[j];
      x[i] = s / M[i][i];
    }
    return x;
  }

  api.fitSphere = function (els) {
    return fitSphereEeglab(els) || fitSphereLstsq(els);
  };

  // ---- Region inference ---------------------------------------
  // Two strategies. Labels like "Fp1", "Cz", "PO3" tell us the region directly
  // via prefix. Dataset-specific labels like BioSemi's "A1..H32" or "CH17"
  // don't carry that information, so we fall back to a position-based
  // quadrant map. The loader picks one per montage based on how many labels
  // actually look 10-20-shaped.

  // Standard 10-20 / 10-10 / 10-05 letter prefixes, plus the reference/EGI
  // special cases the built-in montages use.
  const TEN_TWENTY_PREFIXES = new Set([
    'FP', 'AF', 'F', 'FC', 'FT', 'C', 'T', 'CP', 'TP', 'P', 'PO', 'O',
    'N', 'I', 'A',                  // landmarks + ear references
    'FFC', 'AFF', 'AFP', 'FCC', 'CCP', 'CPP', 'PPO', 'POO',  // 10-05 half-rings
    'E',                            // EGI HydroCel
  ]);

  function prefixOf(name) {
    const m = name.match(/^([A-Za-z]+)/);
    let p = m ? m[1].toUpperCase() : '';
    if (p.length > 1 && p.endsWith('Z')) p = p.slice(0, -1);
    return p;
  }

  function regionByLabel(name) {
    const p = prefixOf(name);
    if (p === 'NZ' || p === 'N' || p === 'FP' || p === 'AF') return 'frontal';
    if (p === 'F' || p === 'FC' || p === 'FT' || p === 'FFC' || p === 'AFF' || p === 'AFP') return 'frontal';
    if (p === 'T' || p === 'C' || p === 'FCC' || p === 'CCP') return 'central';
    if (p === 'CP' || p === 'TP' || p === 'CPP') return 'parietal';
    if (p === 'P' || p === 'PPO') return 'parietal';
    if (p === 'PO' || p === 'POO' || p === 'O' || p === 'IZ' || p === 'I') return 'occipital';
    if (p === 'A') return 'reference';
    if (p === 'E') return 'egi';
    return 'other';
  }

  // Region from position in viewer RAS+ (+X=right, +Y=anterior, +Z=vertex).
  // Ordered so anterior-posterior wins over elevation, which matches how
  // scalp anatomy is usually described.
  function regionByPosition(ux, uy, uz) {
    if (uy < -0.7) return 'occipital';
    if (uy > 0.4) return 'frontal';
    if (uy < -0.15 && uz > 0.3) return 'parietal';
    if (uz > 0.5) return 'central';
    return 'central';                         // lateral / lower — temporal-like
  }

  // Decide which strategy to use. If most labels match known 10-20/10-05/EGI
  // prefixes, label-based is more informative. Otherwise fall back to
  // position-based so datasets with opaque labels (BioSemi ABCD, generic
  // CH17) still get meaningful color coding.
  function pickRegionStrategy(electrodes) {
    if (electrodes.length === 0) return 'position';
    let matches = 0;
    for (const e of electrodes) {
      if (TEN_TWENTY_PREFIXES.has(prefixOf(e.name))) matches++;
    }
    return matches / electrodes.length >= 0.7 ? 'label' : 'position';
  }

  // Modalities the EEG-style sphere pipeline applies to. Other modalities
  // (iEEG in brain space, EMG on body landmarks, fNIRS when the coordsystem
  // isn't obviously a scalp frame) bypass sphere-fit + unit-inference and
  // go through a "flat" pipeline that just normalises the bounding box.
  const SPHERE_MODALITIES = new Set(['eeg', 'meg']);

  // ---- Flat pipeline (iEEG / EMG / fNIRS / anything non-spherical) ----
  // Normalises raw (x, y, z) to a [-1, 1] cube around the centroid. Skips
  // axis rotation, unit inference, and sphere-fit. The viewer renders these
  // as a plain scatter — no head outline, no 10-10 rings, just coordinate
  // axes and a bounding box.
  //
  // For EMG datasets with multiple anatomical frames in one file (HySER's
  // ed/ep/fd/fp), we spread the groups across a 2×2 grid so they don't
  // stack at the same normalised coords. Detection: the raw parser
  // preserves the `coordinate_system` column when present.
  function buildFlatMontage({ raw, meta, label, modality, axisXform }) {
    const electrodes = raw.slice();

    // Group-based offsets for EMG multi-frame files. Each group gets its
    // own sub-panel in a grid. Groups are laid out 2-across.
    const groupKey = (e) => e.coordinate_system || e.group || '';
    const groups = [...new Set(electrodes.map(groupKey).filter(k => k !== ''))];
    const hasGroups = groups.length > 1;
    const perGroupPanel = {};  // groupName -> {ox, oy} offset in normalised space
    if (hasGroups) {
      const cols = Math.ceil(Math.sqrt(groups.length));
      groups.forEach((g, i) => {
        const row = Math.floor(i / cols);
        const col = i % cols;
        // Each sub-panel fits in roughly [-0.45, 0.45]; offset centres
        // them on a (cols × rows) grid centered on (0, 0).
        const span = 1 / cols;
        const ox = (col - (cols - 1) / 2) * span * 2;
        const oy = ((cols - 1) / 2 - row) * span * 2;   // row 0 on top
        perGroupPanel[g] = { ox, oy, span };
      });
    }

    // Normalise each group (or the whole cloud) to [-0.45, 0.45].
    const normalise = (pts) => {
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y), zs = pts.map(p => p.z);
      const xmin = Math.min(...xs), xmax = Math.max(...xs);
      const ymin = Math.min(...ys), ymax = Math.max(...ys);
      const zmin = Math.min(...zs), zmax = Math.max(...zs);
      const cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2, cz = (zmin + zmax) / 2;
      const span = Math.max(xmax - xmin, ymax - ymin, 1e-9);
      return { cx, cy, cz, span };
    };

    const out = [];
    if (hasGroups) {
      for (const g of groups) {
        const members = electrodes.filter(e => groupKey(e) === g);
        const { cx, cy, cz, span } = normalise(members);
        const { ox, oy, span: panelSpan } = perGroupPanel[g];
        const scale = panelSpan * 0.9;   // leave 10% margin per panel
        for (const e of members) {
          const nx = (e.x - cx) / span * scale + ox;
          const ny = (e.y - cy) / span * scale + oy;
          // In flat mode ux/uy are the final 2D coords; uz stays raw for
          // completeness but the renderer uses only ux/uy.
          out.push({
            name: e.name,
            x: +(e.x).toFixed(5), y: +(e.y).toFixed(5), z: +(e.z).toFixed(5),
            ux: nx, uy: ny, uz: 0,
            region: 'other',
            type: e.type || modality.toUpperCase(),
            material: e.material || '',
            group: e.group, coordinate_system: e.coordinate_system,
          });
        }
      }
    } else {
      const { cx, cy, cz, span } = normalise(electrodes);
      for (const e of electrodes) {
        out.push({
          name: e.name,
          x: +(e.x).toFixed(5), y: +(e.y).toFixed(5), z: +(e.z).toFixed(5),
          ux: (e.x - cx) / span * 0.9,
          uy: (e.y - cy) / span * 0.9,
          uz: (e.z - cz) / span * 0.9,
          region: 'other',
          type: e.type || modality.toUpperCase(),
          material: e.material || '',
        });
      }
    }

    return {
      label: label || `Loaded · ${out.length}ch`,
      count: out.length,
      electrodes: out,
      space: meta.space,
      units: meta.units,
      // Flat layouts have no sphere geometry. Consumers that read `.sphere`
      // must handle null explicitly (rail stats, caption, etc.).
      sphere: null,
      inferredUnits: meta.units,
      declaredUnits: meta.units,
      unitsMismatch: false,
      axisTransform: axisXform ? axisXform.name : null,
      regionStrategy: 'none',
      layoutStyle: 'flat',
      modality,
      groups: hasGroups ? groups : null,
    };
  }

  // Best-effort modality inference when the caller doesn't supply it.
  // Inspects the coordsystem.json keys — BIDS prefixes the system/units
  // keys with the datatype (EEGCoordinateSystem, iEEGCoordinateSystem, etc.).
  function inferModalityFromMeta(meta, coordsystemJson) {
    if (coordsystemJson) {
      const obj = typeof coordsystemJson === 'string'
        ? (() => { try { return JSON.parse(coordsystemJson); } catch { return {}; } })()
        : coordsystemJson;
      for (const prefix of ['iEEG', 'EEG', 'MEG', 'EMG', 'NIRS']) {
        if (obj[prefix + 'CoordinateSystem'] || obj[prefix + 'CoordinateUnits']) {
          return prefix.toLowerCase();
        }
      }
    }
    return null;
  }

  // ---- Core sensor → montage pipeline -------------------------
  // Used by both the TSV path (parse first) and the registry path (sensors
  // already parsed server-side). Input is an array of ``{name, x, y, z,
  // type?, material?}`` rows plus a ``meta = {space, units}`` object and
  // the caller's chosen modality (explicit or resolved).
  api.buildMontageFromSensors = function ({ sensors, meta, label, modality }) {
    const resolved = (
      (modality || '').toLowerCase() ||
      inferModalityFromMeta(meta, null) ||
      'eeg'
    );

    // Rotate into RAS+ if the declared space uses ALS (EEGLAB/CTF/4D/KIT).
    // Applied to both sphere- and flat-mode inputs; pure permutation +
    // sign flip, safe before any downstream fitting / normalisation.
    //
    // Fallback: when the declared space is unknown ("Other" / null) we
    // sniff the sensor cloud itself via known 10-20 anchors (Fpz/Nz/Fp1
    // at high +X instead of high +Y → ALS-stored). Covers datasets like
    // ds001971 where the authors uploaded ALS coords with a generic
    // space label. Guarded to only kick in when axisTransformForSpace
    // returned null — explicit declarations always win.
    let axisXform = axisTransformForSpace(meta.space);
    if (!axisXform) {
      axisXform = inferAxisTransformFromSensors(sensors);
    }
    const raw = axisXform ? sensors.map(axisXform.apply) : sensors;

    // Flat pipeline for non-spherical modalities. No sphere-fit, no unit
    // inference — but still rotation-aware via the `axisXform` we just
    // applied.
    if (!SPHERE_MODALITIES.has(resolved)) {
      return buildFlatMontage({ raw, meta, label, modality: resolved, axisXform });
    }

    const rawSphere = api.fitSphere(raw);
    if (!rawSphere) {
      throw new Error(
        'Could not fit a sphere to the electrodes. Need either ' +
        'Fpz/Oz/T7/T8 (EEGLAB method) or at least 4 non-coplanar points.'
      );
    }

    // Infer scale from the fitted radius, not the metadata. coordsystem.json
    // frequently lies about units (see ds002578 mm-vs-m).
    const inferred = inferMetersScaleFromRadius(rawSphere[3]);
    if (!inferred) {
      throw new Error(
        `Could not infer coordinate units: fitted radius is ${rawSphere[3].toFixed(3)} ` +
        `(expected 0.04–0.20 m, 40–200 mm, or 4–20 cm). ` +
        `Check the TSV for missing origin translation or axis swaps.`
      );
    }

    const s = inferred.scale;
    const scaled = raw.map(e => ({ ...e, x: e.x * s, y: e.y * s, z: e.z * s }));
    const [cx, cy, cz, R] = rawSphere.map(v => v * s);

    const declaredUnits = meta.units || null;
    const unitsMismatch = declaredUnits && declaredUnits !== inferred.unit;

    const regionStrategy = pickRegionStrategy(scaled);

    const electrodes = scaled.map(e => {
      const dx = e.x - cx, dy = e.y - cy, dz = e.z - cz;
      const r  = Math.hypot(dx, dy, dz) || R;
      const ux = dx / r, uy = dy / r, uz = dz / r;
      const region = regionStrategy === 'label'
        ? regionByLabel(e.name)
        : regionByPosition(ux, uy, uz);
      return {
        name: e.name,
        x: +dx.toFixed(5),
        y: +dy.toFixed(5),
        z: +dz.toFixed(5),
        ux, uy, uz,
        region,
        type: e.type || 'EEG',
        material: e.material || 'Ag/AgCl',
      };
    });

    return {
      label: label || `Loaded · ${electrodes.length}ch`,
      count: electrodes.length,
      electrodes,
      space: meta.space,
      units: 'm',                   // everything normalized to meters
      sphere: { cx: 0, cy: 0, cz: 0, R },   // centered after translation
      inferredUnits: inferred.unit,
      declaredUnits,
      unitsMismatch,
      axisTransform: axisXform ? axisXform.name : null,
      regionStrategy,
      layoutStyle: 'sphere',
      modality: resolved,
    };
  };

  // ---- Main entry (TSV + coordsystem pipeline) ----------------
  // Returns { label, count, electrodes, space, units, sphere, layoutStyle,
  // modality } matching the shape of MONTAGES[key]. The `modality` field
  // drives the viewer's rendering path ('sphere' vs 'flat').
  api.buildMontageFromBIDS = function ({ tsvText, coordsystemJson, label, modality }) {
    const parsed = api.parseElectrodesTSV(tsvText);
    const meta = coordsystemJson
      ? api.parseCoordsystem(coordsystemJson)
      : { space: 'Other', units: null, landmarks: null };

    // Let inferModalityFromMeta see the raw coordsystem.json keys — they
    // carry the only modality hint outside of the URL.
    const resolved = (
      (modality || '').toLowerCase() ||
      inferModalityFromMeta(meta, coordsystemJson) ||
      'eeg'
    );

    return api.buildMontageFromSensors({
      sensors: parsed,
      meta,
      label,
      modality: resolved,
    });
  };

  // ---- Registry pipeline (GET /api/{db}/montages/{hash}) -------
  // The API returns ``{database, data: <montage doc>}``; pass either the
  // wrapper or the inner doc here. Registry docs ship sensors already
  // parsed plus declared space/units, so we bypass TSV parsing entirely.
  api.buildMontageFromRegistryDoc = function (docOrResponse, { label } = {}) {
    const doc = (docOrResponse && docOrResponse.data) ? docOrResponse.data : docOrResponse;
    if (!doc || !Array.isArray(doc.sensors) || doc.sensors.length < 4) {
      throw new Error('registry doc missing sensors array (need at least 4)');
    }
    // Normalize sensor rows. The digest pipeline writes `{name, x, y, z}`
    // plus optional `type`/`material`; coerce to numbers defensively.
    const sensors = doc.sensors
      .map(s => ({
        name: String(s.name || '').trim(),
        x: +s.x, y: +s.y, z: +s.z,
        type: s.type || '',
        material: s.material || '',
      }))
      .filter(s => s.name && isFinite(s.x) && isFinite(s.y) && isFinite(s.z));
    if (sensors.length < 4) {
      throw new Error('registry doc has fewer than 4 electrodes with finite coordinates');
    }
    const meta = {
      space: doc.space_declared || 'Other',
      units: (doc.units_declared || '').toLowerCase() || null,
      landmarks: null,
    };
    const hashTag = doc.hash ? ` · ${String(doc.hash).slice(0, 8)}` : '';
    const fallbackLabel = `Registry${hashTag} · ${sensors.length}ch`;
    return api.buildMontageFromSensors({
      sensors,
      meta,
      label: label || fallbackLabel,
      modality: doc.modality,
    });
  };

  if (typeof window !== 'undefined') window.BIDSLoader = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.BIDSLoader = api;
})();
