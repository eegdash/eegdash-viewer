/* ============================================================
   formats/edf.js — read EDF / EDF+ / BDF over HTTP Range.

   Header (256 bytes fixed) + n_signals × 256 bytes of signal
   metadata, followed by n_records data records. Each record holds
   every signal's samples back-to-back in declaration order. Sample
   bytes per signal in record i:  signal[i].samples_per_record × bps,
   bps = 2 (EDF / EDF+) or 3 (BDF, 24-bit signed little-endian).

   Within a single record, signal layout is signal-major (NOT
   sample-interleaved — that's the EEGLAB layout). Reading a window
   = pulling the records that overlap the window with one Range fetch
   and slicing each signal's stripe out of every record.

   What we trust:
     - EDF header for binary layout (n_signals, samples_per_record,
       record_duration, digital/physical scaling).
     - BIDS `_channels.tsv` for display order, names, types — when
       it disagrees with the EDF labels we surface a warning, never
       silently reorder, because reorders would mis-align the binary.

   What we skip in v1:
     - Discontinuous EDF+ (reserved field "EDF+D"). Most BIDS data is
       continuous; we warn and treat as continuous.
     - Per-signal sample rates differing from the EEG channels'.
     - The "EDF Annotations" channel — surfaced as events when we
       extend Phase 1's events.tsv pipeline; for now it's just hidden
       from the display channel set.
   ============================================================ */
(function () {
  'use strict';

  const api = {};
  const HEADER_FIXED = 256;
  // EDF lays out signal-header fields field-major: all labels first,
  // then all transducers, etc. Iterating the outer loop over fields
  // (rather than signals) matches the file order so we walk bytes
  // linearly.
  const SIGNAL_HEADER_FIELDS = [
    ['label',              16],
    ['transducer',         80],
    ['physical_dimension',  8],
    ['physical_min',        8],
    ['physical_max',        8],
    ['digital_min',         8],
    ['digital_max',         8],
    ['prefiltering',       80],
    ['samples_per_record',  8],
    ['reserved',           32],
  ];
  const ANNOTATION_LABEL = /^EDF Annotations\b/i;

  function ascii(view, offset, length) {
    let s = '';
    for (let i = 0; i < length; i++) {
      const c = view[offset + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }

  function parseAsciiInt(s, label) {
    const n = parseInt(s, 10);
    if (!Number.isFinite(n)) throw new Error(`EDF header: ${label} not an integer (${JSON.stringify(s)})`);
    return n;
  }

  function parseAsciiFloat(s, label) {
    const n = parseFloat(s);
    if (!Number.isFinite(n)) throw new Error(`EDF header: ${label} not a float (${JSON.stringify(s)})`);
    return n;
  }

  api.parseHeader = function (arrayBuf) {
    const v = new Uint8Array(arrayBuf);
    if (v.length < HEADER_FIXED) {
      throw new Error(`EDF header underflow: ${v.length} < ${HEADER_FIXED} bytes`);
    }

    // First byte 0xFF identifies BDF (BioSemi 24-bit). Otherwise it's
    // EDF or EDF+, distinguished by the "reserved" field at byte 192.
    const isBDF = v[0] === 0xFF;
    const reserved = ascii(v, 192, 44);
    const isEdfPlus = reserved.startsWith('EDF+');
    const isContinuous = reserved !== 'EDF+D';

    const headerBytes = parseAsciiInt(ascii(v, 184, 8), 'header_bytes');
    const nRecords    = parseAsciiInt(ascii(v, 236, 8), 'n_records');
    const recordDur   = parseAsciiFloat(ascii(v, 244, 8), 'record_duration');
    const nSignals    = parseAsciiInt(ascii(v, 252, 4), 'n_signals');

    const expectedHeaderBytes = HEADER_FIXED * (nSignals + 1);
    if (headerBytes !== expectedHeaderBytes) {
      throw new Error(`EDF header_bytes (${headerBytes}) ≠ 256·(n_signals+1)=${expectedHeaderBytes}`);
    }
    if (v.length < headerBytes) {
      throw new Error(`EDF header buffer ${v.length}B < declared ${headerBytes}B`);
    }

    const signals = Array.from({ length: nSignals }, () => ({}));
    let off = HEADER_FIXED;
    for (const [field, size] of SIGNAL_HEADER_FIELDS) {
      for (let i = 0; i < nSignals; i++) {
        signals[i][field] = ascii(v, off, size);
        off += size;
      }
    }

    for (let i = 0; i < nSignals; i++) {
      const s = signals[i];
      s.physical_min = parseAsciiFloat(s.physical_min, `signal[${i}].physical_min`);
      s.physical_max = parseAsciiFloat(s.physical_max, `signal[${i}].physical_max`);
      s.digital_min  = parseAsciiInt  (s.digital_min,  `signal[${i}].digital_min`);
      s.digital_max  = parseAsciiInt  (s.digital_max,  `signal[${i}].digital_max`);
      s.samples_per_record = parseAsciiInt(s.samples_per_record, `signal[${i}].samples_per_record`);
      // EDF spec requires digital_max > digital_min. A reversed range
      // would silently invert polarity, so reject up front.
      const dRange = s.digital_max - s.digital_min;
      if (dRange <= 0) throw new Error(`signal[${i}] has non-positive digital range (${s.digital_min}..${s.digital_max})`);
      s.scale  = (s.physical_max - s.physical_min) / dRange;
      s.offset = s.physical_min - s.digital_min * s.scale;
      s.is_annotation = ANNOTATION_LABEL.test(s.label);
    }

    return {
      version: ascii(v, 0, 8),
      isBDF, isEdfPlus, isContinuous, reserved,
      header_bytes: headerBytes,
      n_records: nRecords,
      record_duration: recordDur,
      n_signals: nSignals,
      signals,
    };
  };

  api.open = async function (meta) {
    const url = meta.eeg_url;

    // Run the length probe in parallel with the first 256-byte fetch.
    // The first fetch tells us how many more bytes to ask for; the
    // probe is independent so there's no point blocking on it.
    const [firstBuf, totalBytes] = await Promise.all([
      HttpRange.rangeFetch(url, 0, HEADER_FIXED - 1, HEADER_FIXED),
      HttpRange.probeLength(url),
    ]);
    const declaredHeaderBytes = parseAsciiInt(
      ascii(new Uint8Array(firstBuf), 184, 8), 'header_bytes (first probe)');

    let headerBuf;
    if (declaredHeaderBytes === HEADER_FIXED) {
      headerBuf = firstBuf;
    } else {
      // Re-use what we already fetched: pull only the remaining
      // signal-header bytes and concatenate, instead of re-downloading
      // the fixed 256 we just got.
      const restBuf = await HttpRange.rangeFetch(
        url, HEADER_FIXED, declaredHeaderBytes - 1, declaredHeaderBytes - HEADER_FIXED);
      const merged = new Uint8Array(declaredHeaderBytes);
      merged.set(new Uint8Array(firstBuf), 0);
      merged.set(new Uint8Array(restBuf), HEADER_FIXED);
      headerBuf = merged.buffer;
    }
    const hdr = api.parseHeader(headerBuf);

    if (!hdr.isContinuous) {
      console.warn('EDF+D (discontinuous) treated as continuous in v1; sample timing may be off across record boundaries.');
    }

    const dataBytes = totalBytes - hdr.header_bytes;
    const bytesPerSample = hdr.isBDF ? 3 : 2;
    const samplesPerRecord = hdr.signals.reduce((sum, s) => sum + s.samples_per_record, 0);
    const recordSize = samplesPerRecord * bytesPerSample;

    if (recordSize === 0) throw new Error('EDF: zero-byte data record (signals report samples_per_record=0)');
    if (dataBytes < 0 || dataBytes % recordSize !== 0) {
      throw new Error(`EDF data section ${dataBytes}B is not a multiple of record size ${recordSize}B`);
    }
    const actualRecords = dataBytes / recordSize;
    if (hdr.n_records !== -1 && hdr.n_records !== actualRecords) {
      console.warn(`EDF declared ${hdr.n_records} records but file has ${actualRecords}; trusting file.`);
    }

    // v1: require uniform sample rate across display signals so the
    // returned window is a clean (n_channels × n_samples) shape.
    // Annotation channels are excluded from this check — they often
    // carry a different sample count.
    const displayIdx = [];
    for (let i = 0; i < hdr.signals.length; i++) {
      if (!hdr.signals[i].is_annotation) displayIdx.push(i);
    }
    if (!displayIdx.length) throw new Error('EDF has no non-annotation signals');

    const sprPerDisplay = displayIdx.map(i => hdr.signals[i].samples_per_record);
    const sprFirst = sprPerDisplay[0];
    if (sprPerDisplay.some(s => s !== sprFirst)) {
      throw new Error(`v1 requires uniform samples_per_record across display signals; got ${[...new Set(sprPerDisplay)].join(', ')}`);
    }
    const fs = sprFirst / hdr.record_duration;
    const nSamples = actualRecords * sprFirst;

    SidecarChecks.warnFsMismatch(meta.eeg_json.sampling_frequency, fs, 'EDF');

    // Pre-compute everything readWindow needs keyed by display-channel
    // index `c`, so the hot path doesn't pay an indirection per channel
    // per record. Using typed arrays keeps lookup tight.
    const nDisplay = displayIdx.length;
    const cumByOrigIdx = new Int32Array(hdr.n_signals);
    let cum = 0;
    for (let i = 0; i < hdr.n_signals; i++) {
      cumByOrigIdx[i] = cum * bytesPerSample;
      cum += hdr.signals[i].samples_per_record;
    }
    const sigOffsetInRec = new Int32Array(nDisplay);
    const scales = new Float64Array(nDisplay);
    const offsets = new Float64Array(nDisplay);
    const channelLabels = new Array(nDisplay);
    for (let c = 0; c < nDisplay; c++) {
      const oi = displayIdx[c];
      sigOffsetInRec[c] = cumByOrigIdx[oi];
      scales[c]  = hdr.signals[oi].scale;
      offsets[c] = hdr.signals[oi].offset;
      channelLabels[c] = hdr.signals[oi].label;
    }

    SidecarChecks.crossCheckChannelOrder(channelLabels, meta.channels, 'EDF');

    // Layout state for readWindow lives in this closure rather than on
    // the public handle so callers can't accidentally rely on internals.
    const layout = {
      url,
      isBDF: hdr.isBDF,
      header_bytes: hdr.header_bytes,
      record_size_bytes: recordSize,
      samples_per_record: sprFirst,
      n_records: actualRecords,
      n_samples: nSamples,
      n_channels: nDisplay,
      sigOffsetInRec, scales, offsets,
    };
    const reader = hdr.isBDF ? readWindowBDF : readWindowEDF;

    return {
      n_channels: nDisplay,
      n_samples: nSamples,
      sampling_frequency: fs,
      duration_s: nSamples / fs,
      bytes_per_sample: bytesPerSample,
      url,
      channel_labels: channelLabels,
      bids_channels: meta.channels || null,
      readWindow: (start, n, opts) => reader(layout, start, n, opts),
    };
  };

  // Hot path. Pull every record overlapping the requested window in
  // one Range, then slice each display channel out of each record.
  // Common scaffolding lives here; EDF (Int16) and BDF (Int24)
  // diverge only in the inner per-sample decode, hoisted into
  // dedicated `readWindowEDF` / `readWindowBDF` so the inner loop
  // is branch-free.
  async function fetchWindowBuffer(layout, startSample, nWinReq, opts) {
    const start = Math.max(0, startSample);
    if (start >= layout.n_samples || nWinReq <= 0) return null;
    const end = Math.min(start + nWinReq, layout.n_samples);
    const nWin = end - start;
    const spr = layout.samples_per_record;
    const firstRec = Math.floor(start / spr);
    const lastRec = Math.ceil(end / spr);
    const nRecs = lastRec - firstRec;
    const byteStart = layout.header_bytes + firstRec * layout.record_size_bytes;
    const byteEnd = byteStart + nRecs * layout.record_size_bytes - 1;
    const buf = await HttpRange.rangeFetch(layout.url, byteStart, byteEnd, nRecs * layout.record_size_bytes, opts);
    return { buf, nWin, nRecs, startOffsetInFirstRec: start - firstRec * spr };
  }

  async function readWindowEDF(layout, startSample, nWinReq, opts) {
    const win = await fetchWindowBuffer(layout, startSample, nWinReq, opts);
    if (win == null) return ChannelBuffers.empty(layout.n_channels);
    const { buf, nWin, nRecs, startOffsetInFirstRec } = win;
    // EDF samples are int16 little-endian. Records start at byte
    // offsets that are always even (header_bytes is 256·(n_sig+1) and
    // record_size is samples_per_record_total × 2), so we can view the
    // whole buffer as Int16Array indexed in 16-bit units.
    const i16 = new Int16Array(buf);
    const halfRec = layout.record_size_bytes >> 1;        // record size in int16 units
    const out = ChannelBuffers.alloc(layout.n_channels, nWin);
    const spr = layout.samples_per_record;

    for (let c = 0; c < layout.n_channels; c++) {
      const sigOffI16 = layout.sigOffsetInRec[c] >> 1;    // bytes → int16 index
      const scale = layout.scales[c];
      const offset = layout.offsets[c];
      const ch = out[c];
      let outIdx = 0;
      for (let r = 0; r < nRecs && outIdx < nWin; r++) {
        const sigBase = r * halfRec + sigOffI16;
        const recStart = (r === 0) ? startOffsetInFirstRec : 0;
        const recEnd = Math.min(spr, recStart + (nWin - outIdx));
        for (let s = recStart; s < recEnd; s++) {
          ch[outIdx++] = i16[sigBase + s] * scale + offset;
        }
      }
    }
    return out;
  }

  async function readWindowBDF(layout, startSample, nWinReq, opts) {
    const win = await fetchWindowBuffer(layout, startSample, nWinReq, opts);
    if (win == null) return ChannelBuffers.empty(layout.n_channels);
    const { buf, nWin, nRecs, startOffsetInFirstRec } = win;
    // BDF samples are 24-bit signed little-endian. Pack the 3 bytes
    // into the high 24 bits of a 32-bit int and arithmetic-shift
    // right 8 to sign-extend in one shot.
    const u8 = new Uint8Array(buf);
    const recSize = layout.record_size_bytes;
    const out = ChannelBuffers.alloc(layout.n_channels, nWin);
    const spr = layout.samples_per_record;

    for (let c = 0; c < layout.n_channels; c++) {
      const sigOff = layout.sigOffsetInRec[c];
      const scale = layout.scales[c];
      const offset = layout.offsets[c];
      const ch = out[c];
      let outIdx = 0;
      for (let r = 0; r < nRecs && outIdx < nWin; r++) {
        const sigBase = r * recSize + sigOff;
        const recStart = (r === 0) ? startOffsetInFirstRec : 0;
        const recEnd = Math.min(spr, recStart + (nWin - outIdx));
        for (let s = recStart; s < recEnd; s++) {
          const o = sigBase + s * 3;
          const raw = ((u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16)) << 8) >> 8;
          ch[outIdx++] = raw * scale + offset;
        }
      }
    }
    return out;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.EDFReader = api;
})();
