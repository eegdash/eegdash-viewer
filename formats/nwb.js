/* ============================================================
   formats/nwb.js — read NWB (Neurodata Without Borders) iEEG /
   ECoG / LFP recordings for the eegdash-viewer.

   NWB is an HDF5-based container format defined by the NWB schema
   (https://nwb-schema.readthedocs.io/). We delegate the HDF5 walk to
   jsfive (vendored as `formats/_jsfive.js` for the browser, npm-
   installed for Node tests) and read the canonical iEEG path:

     /                                attrs: nwb_version (str),
                                              neurodata_type=NWBFile
     /acquisition/                    GROUP — first child whose
                                      neurodata_type attr is
                                      "ElectricalSeries" (else first
                                      child that has a `data` dataset).
     /acquisition/<ts>/data           float dataset, shape
                                      [n_samples, n_channels]
                                      (NWB canonical layout; we also
                                      accept [n_channels, n_samples]
                                      and transpose on read.)
     /acquisition/<ts>/starting_time  scalar float64, attrs.rate = fs
                                      OR
     /acquisition/<ts>/timestamps     float dataset [n_samples] — only
                                      consulted if `starting_time.rate`
                                      is missing; we derive fs from
                                      timestamps[1] - timestamps[0].
     /general/extracellular_ephys/electrodes/  optional DynamicTable
                                      with `label` (or `id`) column
                                      used for channel names.

   Pragmatic scope (v1, parallels formats/snirf.js):
     - jsfive needs the whole HDF5 buffer in memory (no HTTP-range
       random-access reads on HDF5 chunks). We download the whole file
       and cap at 200 MB, matching the legacy EEGLAB inline path.
     - Multi-recording NWB files: we read the first ElectricalSeries
       in /acquisition only. Additional series are surfaced as a
       follow-up.

   What we DON'T handle (deliberately):
     - References / DynamicTableRegion lookups across files: NWB allows
       `/acquisition/X/electrodes` to point at a foreign electrodes
       table via HDF5 references. Channel labels fall back to "Ch1..N"
       when the column lookup fails — never crash on a missing label.
     - Compressed datasets that jsfive doesn't transparently decompress
       (chunked + GZIP is fine; SZIP / N-bit / scale-offset filters are
       not). The error surfaces with the jsfive message intact.
     - Encrypted NWB (NWB extensions for encrypted data are out of scope).
     - Stimuli / behavioural NWB groups — we read /acquisition only.
     - Per-channel unit conversions: NWB allows a `conversion` /
       `offset` scalar attribute on `data`. We apply both if present,
       skip silently if absent.
   ============================================================ */
(function () {
  'use strict';

  const api = {};

  // Match the legacy EEGLAB inline-set cap, and the SNIRF reader's
  // implicit one. NWB files in DANDI are routinely several GB; we
  // intentionally fail clean rather than OOM the browser.
  const LEGACY_FALLBACK_CAP = 200 * 1024 * 1024;  // 200 MB

  // A2-style integer caps: NWB recordings in the wild peak at a few
  // hundred ECoG channels; nothing in current iEEG hits 4096. Catching
  // a 4-byte garbage shape early prevents a multi-GB Float32Array alloc.
  const MAX_CHANNELS = 4096;
  const MAX_SAMPLES_TOTAL = 1 << 30;  // ~1.07e9 sample cells (any dtype)

  // jsfive resolves differently in Node (CJS via npm) and the
  // browser/worker (vendored IIFE attaches globalThis.hdf5). Same
  // pattern as formats/_mat73.js and formats/snirf.js.
  function getJsfive() {
    if (typeof globalThis !== 'undefined' && globalThis.hdf5) return globalThis.hdf5;
    if (typeof require !== 'undefined') {
      try { return require('jsfive'); } catch (_) { /* fall through */ }
    }
    throw new Error(
      'jsfive not available: include formats/_jsfive.js before ' +
      'formats/nwb.js in the browser, or `npm install jsfive` for ' +
      'the Node tests.'
    );
  }

  // NWB files are pure HDF5; magic at byte 0 (same as SNIRF, unlike
  // MAT v7.3 which has the 512-byte MAT stub first).
  function isHdf5AtZero(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (u8.length < 8) return false;
    return u8[0] === 0x89 && u8[1] === 0x48 && u8[2] === 0x44 &&
           u8[3] === 0x46 && u8[4] === 0x0d && u8[5] === 0x0a &&
           u8[6] === 0x1a && u8[7] === 0x0a;
  }

  // jsfive returns fixed-length strings ("S8", "S16") NUL-padded to
  // the declared width. Strip trailing NULs and whitespace so labels
  // round-trip to humans cleanly.
  function trimNulString(s) {
    if (typeof s !== 'string') return s == null ? '' : String(s);
    let end = s.length;
    while (end > 0) {
      const c = s.charCodeAt(end - 1);
      if (c === 0 || c === 0x20) end--;
      else break;
    }
    return s.slice(0, end);
  }

  // Pull a numeric attribute from jsfive's `.attrs` object. jsfive
  // returns scalars as a plain number OR a 1-length array depending on
  // how the file was written (h5py emits both shapes). Normalise.
  function readNumericAttr(attrs, name) {
    if (!attrs) return null;
    const v = attrs[name];
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (typeof v.length === 'number' && v.length > 0) {
      const n = Number(v[0]);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  // Find the first child group inside /acquisition that looks like an
  // ElectricalSeries (or, failing the neurodata_type attribute, any
  // child that has a `data` dataset — some legacy NWB exports omit the
  // attribute on auto-named series). Prefer the canonical match.
  function pickElectricalSeries(acq) {
    if (!acq || !acq.keys || !acq.keys.length) {
      throw new Error('NWB: /acquisition is empty (no ElectricalSeries found)');
    }
    let firstWithData = null;
    for (const k of acq.keys) {
      let child;
      try { child = acq.get(k); } catch (_) { continue; }
      if (!child || !child.keys) continue;
      const nd = child.attrs && child.attrs.neurodata_type;
      if (nd === 'ElectricalSeries') return { name: k, group: child };
      if (!firstWithData && child.keys.includes('data')) {
        firstWithData = { name: k, group: child };
      }
    }
    if (firstWithData) return firstWithData;
    throw new Error(
      'NWB: no ElectricalSeries found under /acquisition ' +
      '(checked: ' + acq.keys.join(', ') + ')'
    );
  }

  // Compute sampling frequency from either starting_time.rate (the
  // canonical NWB regular-sampling field) or timestamps[1]-timestamps[0]
  // (irregular sampling fallback). Returns { fs, isUniform }.
  function deriveSamplingRate(es) {
    if (es.keys.includes('starting_time')) {
      const st = es.get('starting_time');
      const rate = readNumericAttr(st.attrs, 'rate');
      if (rate != null && rate > 0) return { fs: rate, isUniform: true };
    }
    if (es.keys.includes('timestamps')) {
      const tsDs = es.get('timestamps');
      const ts = tsDs.value;
      if (ts && ts.length >= 2) {
        const dt = Number(ts[1]) - Number(ts[0]);
        if (dt > 0) {
          // Sanity-check uniformity. NWB allows irregularly-sampled
          // timestamps; the viewer assumes uniform fs for windowing, so
          // we warn rather than throw — the rendered traces will simply
          // be slightly stretched at non-uniform regions.
          const dtMean = (Number(ts[ts.length - 1]) - Number(ts[0])) / (ts.length - 1);
          const isUniform = Math.abs(dtMean - dt) / dt <= 0.05;
          if (!isUniform) {
            console.warn(
              'NWB: timestamps are non-uniform ' +
              '(dt[0]=' + dt.toExponential(3) + ', dt_mean=' + dtMean.toExponential(3) +
              '); v1 assumes uniform fs.'
            );
          }
          return { fs: 1 / dt, isUniform };
        }
      }
    }
    throw new Error(
      'NWB: cannot derive sampling rate — no starting_time.rate ' +
      'attribute and no usable timestamps dataset'
    );
  }

  // Build channel labels from /general/extracellular_ephys/electrodes
  // when available. NWB stores the table as a DynamicTable group with
  // one dataset per column; we look for `label` first (most common
  // in BIDS-iEEG conversions) and fall back to `id` (numeric channel
  // index) before giving up and using indexed Ch1..ChN.
  //
  // We intentionally do not resolve the per-series `electrodes`
  // DynamicTableRegion reference — that requires HDF5 reference
  // dereferencing which jsfive supports unevenly across NWB writer
  // versions. The /general electrodes table covers the recording-wide
  // channel set, which matches every ElectricalSeries in well-formed
  // single-acquisition NWB files (the only shape we read in v1).
  function buildChannelLabels(root, nChannels) {
    const fallback = (typeof globalThis !== 'undefined' && globalThis.ChannelLabels)
      ? globalThis.ChannelLabels.indexed(nChannels)
      : Array.from({ length: nChannels }, (_, i) => 'Ch' + (i + 1));
    let electrodes = null;
    try { electrodes = root.get('general/extracellular_ephys/electrodes'); }
    catch (_) { return fallback; }
    if (!electrodes || !electrodes.keys) return fallback;

    // Prefer `label` (string) → `id` (int). NWB's DynamicTable spec
    // guarantees `id` is always present; `label` is the recommended
    // human-readable column for iEEG.
    const tryColumn = (colName, mapper) => {
      if (!electrodes.keys.includes(colName)) return null;
      const ds = electrodes.get(colName);
      const v = ds.value;
      if (!v || v.length !== nChannels) return null;
      const out = new Array(nChannels);
      for (let i = 0; i < nChannels; i++) out[i] = mapper(v[i], i);
      return out;
    };

    const labels = tryColumn('label', (s) => trimNulString(String(s)) || ('Ch' + (1)));
    if (labels) {
      // If we got empty strings back (shouldn't happen, but a malformed
      // table could yield all-NULs), drop back to indexed labels.
      const anyNonEmpty = labels.some((s) => s && s.length);
      if (anyNonEmpty) {
        return labels.map((s, i) => (s && s.length) ? s : 'Ch' + (i + 1));
      }
    }

    const ids = tryColumn('id', (n) => 'Ch' + (Number(n) + 1));
    if (ids) return ids;

    return fallback;
  }

  // Validate dataset shape: must be 2-D, both dims positive, neither
  // axis above its A2 cap. Returns the canonical [nSamples, nChannels]
  // pair and a `transposed` flag so readWindow can index correctly.
  // NWB canonical is [n_samples, n_channels] but some converters write
  // [n_channels, n_samples] (matching the MATLAB / EEGLAB convention);
  // we detect that by checking which axis exceeds MAX_CHANNELS.
  function normaliseShape(shape) {
    if (!Array.isArray(shape) || shape.length !== 2) {
      throw new Error(
        'NWB: ElectricalSeries.data must be 2-D, got [' +
        (shape ? shape.join(',') : '?') + ']'
      );
    }
    const a = shape[0] | 0;
    const b = shape[1] | 0;
    if (a <= 0 || b <= 0) {
      throw new Error('NWB: empty data shape [' + shape.join(',') + ']');
    }
    if (a * b > MAX_SAMPLES_TOTAL) {
      throw new Error(
        'NWB: data has ' + (a * b) + ' total cells, exceeds cap ' +
        MAX_SAMPLES_TOTAL + ' (file may be malformed or too large)'
      );
    }
    // Canonical NWB: dim 0 = samples (long), dim 1 = channels (short).
    // We treat the axis with the smaller extent as the channels axis as
    // long as it's <= MAX_CHANNELS. This catches both layouts without
    // a costly heuristic.
    let nSamples, nChannels, transposed;
    if (b <= MAX_CHANNELS && (a >= b || a > MAX_CHANNELS)) {
      // [n_samples, n_channels] — canonical
      nSamples = a;
      nChannels = b;
      transposed = false;
    } else if (a <= MAX_CHANNELS) {
      // [n_channels, n_samples] — needs transpose on read
      nSamples = b;
      nChannels = a;
      transposed = true;
    } else {
      throw new Error(
        'NWB: both axes [' + a + ',' + b + '] exceed channel cap ' +
        MAX_CHANNELS + ' — refusing to load (likely shape garbage)'
      );
    }
    if (nChannels > MAX_CHANNELS) {
      throw new Error(
        'NWB: ' + nChannels + ' channels exceeds cap ' + MAX_CHANNELS
      );
    }
    return { nSamples, nChannels, transposed };
  }

  // Promote jsfive's `.value` to a flat Float32Array indexed in
  // sample-major order: flat[s * nChannels + c]. We always store
  // sample-major regardless of the on-disk layout so readWindow has
  // a single indexing rule (matches SNIRF reader).
  //
  // jsfive returns either:
  //   - a flat Array of numbers (most common, including for our
  //     synthetic h5py-generated fixture),
  //   - a nested Array (some chunked datasets),
  //   - a typed array (rare — only when jsfive happens to read the
  //     underlying buffer in-place).
  // We normalise all three.
  function normaliseToFloat32SampleMajor(value, nSamples, nChannels, transposed, conversion, offset) {
    const expected = nSamples * nChannels;
    const out = new Float32Array(expected);
    const scale = (conversion != null && Number.isFinite(conversion)) ? conversion : 1;
    const shift = (offset != null && Number.isFinite(offset)) ? offset : 0;
    const noScale = scale === 1 && shift === 0;

    // Case A: flat array/typed-array.
    if (value && typeof value.length === 'number' && value.length === expected) {
      if (!transposed) {
        if (noScale && value instanceof Float32Array) return value;
        for (let i = 0; i < expected; i++) {
          out[i] = noScale ? Number(value[i]) : Number(value[i]) * scale + shift;
        }
        return out;
      }
      // Transposed: on-disk is [nChannels, nSamples], flat[c*nSamples+s].
      // Re-index to [nSamples, nChannels].
      for (let c = 0; c < nChannels; c++) {
        const baseIn = c * nSamples;
        for (let s = 0; s < nSamples; s++) {
          const v = Number(value[baseIn + s]);
          out[s * nChannels + c] = noScale ? v : v * scale + shift;
        }
      }
      return out;
    }

    // Case B: nested array. jsfive returns either rows-of-cols or
    // chunks-of-chunks; flat() handles the row-of-cols common case.
    // We re-normalise into the 1-D layout we want.
    if (Array.isArray(value)) {
      const flat = value.flat ? value.flat(Infinity) : [].concat.apply([], value);
      if (flat.length === expected) {
        return normaliseToFloat32SampleMajor(flat, nSamples, nChannels, transposed, conversion, offset);
      }
    }
    throw new Error(
      'NWB: cannot promote data.value (len=' +
      (value && value.length) + ') to expected size ' + expected
    );
  }

  // Approximate raw byte width per sample for the duration / bandwidth
  // estimate the UI surfaces. jsfive's `.dtype` is a numpy-style string
  // like '<f4' / '<i2'. We map the common iEEG widths; anything we
  // don't recognise falls back to 4 (Float32 — what we hand the renderer).
  function bytesPerSampleFromDtype(dtype) {
    if (typeof dtype !== 'string') return 4;
    const m = dtype.match(/[<>=!@\|]?([iuf])(\d+)/);
    if (!m) return 4;
    return Math.max(1, parseInt(m[2], 10) | 0);
  }

  // Parse the ISO 8601 session start time NWB stores at
  // /session_start_time (NWB ≥ 2.0). Optional — many DANDI files have
  // it, some BIDS-iEEG converters don't. Returned verbatim so the UI
  // can render it without further parsing.
  function readSessionStartIso(root) {
    if (!root.keys || !root.keys.includes('session_start_time')) return null;
    try {
      const ds = root.get('session_start_time');
      const v = ds.value;
      if (typeof v === 'string') return v;
      if (Array.isArray(v) && v.length === 1 && typeof v[0] === 'string') return v[0];
      return null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Open an NWB file for windowed reading.
   *
   * @param {{ eeg_url: string, [k: string]: any }} meta
   * @returns {Promise<object>} reader matching the cross-format contract:
   *   { n_channels, sampling_frequency, duration_s, n_samples,
   *     channel_labels, channel_types, bytes_per_sample,
   *     recording_start_iso, annotation_events, readWindow(start, n) }
   */
  api.open = async function (meta) {
    const url = meta && (meta.eeg_url || meta.url);
    if (!url) throw new Error('nwb.open: meta.eeg_url is required');
    const HttpRange = globalThis.HttpRange;
    if (!HttpRange) throw new Error('nwb.open: globalThis.HttpRange missing');

    // Probe length first so we can refuse oversized files with a clean
    // message instead of half-downloading them. probeLength is part of
    // the same HttpRange surface SNIRF / EEGLAB inline use.
    if (typeof HttpRange.probeLength === 'function') {
      const length = await HttpRange.probeLength(url).catch(() => null);
      if (length != null && length > LEGACY_FALLBACK_CAP) {
        throw new Error(
          'NWB: file is ' + (length >>> 20) + ' MB, exceeds ' +
          (LEGACY_FALLBACK_CAP >>> 20) + ' MB cap. jsfive cannot range- ' +
          'read HDF5 chunks; chunked / range-based NWB streaming is a ' +
          'follow-up. Trim the file (e.g. via pynwb / nwbinspector) or ' +
          'subset the ElectricalSeries before viewing.'
        );
      }
    }

    const buf = await HttpRange.fetchBuffer(url);
    if (!isHdf5AtZero(buf)) {
      throw new Error('NWB: file is not a valid HDF5 (magic mismatch at byte 0)');
    }
    if (buf.byteLength > LEGACY_FALLBACK_CAP) {
      // Defensive: probeLength may have been unavailable, fall back to
      // the actual buffer size we just downloaded.
      throw new Error(
        'NWB: file is ' + (buf.byteLength >>> 20) + ' MB, exceeds ' +
        (LEGACY_FALLBACK_CAP >>> 20) + ' MB cap.'
      );
    }

    return api.read(buf);
  };

  /**
   * Parse an NWB buffer that's already in memory. Used by:
   *   - api.open() once the file has been downloaded,
   *   - tests that load fixtures via fs.readFileSync.
   *
   * Matches the SNIrf reader's surface (SnirfReader.read alongside
   * SnirfReader.open) — fully synchronous internally but returns a
   * Promise so the caller signature is symmetric.
   *
   * @param {ArrayBuffer|Uint8Array} buffer
   * @returns {Promise<object>} same reader object as api.open
   */
  api.read = async function (buffer) {
    const u8 = buffer instanceof Uint8Array
      ? buffer
      : new Uint8Array(buffer);
    if (!isHdf5AtZero(u8)) {
      throw new Error('NWB: buffer is not a valid HDF5 (magic mismatch at byte 0)');
    }
    if (u8.byteLength > LEGACY_FALLBACK_CAP) {
      throw new Error(
        'NWB: buffer is ' + (u8.byteLength >>> 20) + ' MB, exceeds ' +
        (LEGACY_FALLBACK_CAP >>> 20) + ' MB cap.'
      );
    }
    const jsfive = getJsfive();
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    const file = new jsfive.File(ab);

    if (!file.keys || !file.keys.includes('acquisition')) {
      throw new Error(
        'NWB: /acquisition group missing — not a recognised NWB file ' +
        '(root keys: ' + (file.keys ? file.keys.join(', ') : 'none') + ')'
      );
    }
    const acq = file.get('acquisition');
    const picked = pickElectricalSeries(acq);
    const es = picked.group;

    if (!es.keys.includes('data')) {
      throw new Error(
        'NWB: /acquisition/' + picked.name + '/data missing'
      );
    }
    const dataDs = es.get('data');
    const shape = dataDs.shape;
    const { nSamples, nChannels, transposed } = normaliseShape(shape);

    const { fs } = deriveSamplingRate(es);

    // Optional unit conversion: NWB allows `conversion` (multiplier)
    // and `offset` (additive) scalar attributes on the data dataset.
    // pynwb sets `conversion=1.0` by default; we treat 1.0 / 0.0 as
    // no-op without allocating a scaling loop.
    const conversion = readNumericAttr(dataDs.attrs, 'conversion');
    const offset = readNumericAttr(dataDs.attrs, 'offset');

    const flat = normaliseToFloat32SampleMajor(
      dataDs.value, nSamples, nChannels, transposed, conversion, offset
    );
    if (flat.length !== nSamples * nChannels) {
      throw new Error(
        'NWB: data length ' + flat.length + ' != ' +
        'nSamples(' + nSamples + ') * nChannels(' + nChannels + ')'
      );
    }

    const channelLabels = buildChannelLabels(file, nChannels);
    // NWB ElectricalSeries are by convention all iEEG / ECoG / LFP —
    // we don't currently introspect the electrode group to distinguish
    // sub-types, so every channel reports as "ieeg" (matches the
    // BrainVision iEEG path's default channel_type).
    const channelTypes = new Array(nChannels).fill('ieeg');

    const bytesPerSample = bytesPerSampleFromDtype(dataDs.dtype);
    const recordingStartIso = readSessionStartIso(file);

    return {
      n_channels: nChannels,
      sampling_frequency: fs,
      duration_s: nSamples / fs,
      n_samples: nSamples,
      channel_labels: channelLabels,
      channel_types: channelTypes,
      bytes_per_sample: bytesPerSample,
      recording_start_iso: recordingStartIso,
      // NWB stores events / epochs in /intervals/ — out of scope for
      // v1. We return an empty array so callers can iterate without
      // a null check (matches the SNIRF / BrainVision shape).
      annotation_events: [],
      readWindow: async (startSample, nWin) => {
        const win = globalThis.ChannelBuffers.clampWindow(startSample, nWin, nSamples);
        if (!win) return globalThis.ChannelBuffers.empty(nChannels);
        const { start, end } = win;
        const out = globalThis.ChannelBuffers.alloc(nChannels, end - start);
        // flat is sample-major row-major: flat[s * nChannels + c] is
        // sample s of channel c regardless of on-disk transpose.
        for (let s = start; s < end; s++) {
          const base = s * nChannels;
          for (let c = 0; c < nChannels; c++) {
            out[c][s - start] = flat[base + c];
          }
        }
        return out;
      },
    };
  };

  // Re-exposed for tests / future debug surfacing.
  api._isHdf5AtZero = isHdf5AtZero;
  api._normaliseShape = normaliseShape;
  api._trimNulString = trimNulString;
  api._pickElectricalSeries = pickElectricalSeries;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.NwbReader = api;
})();
