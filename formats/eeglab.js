/* ============================================================
   formats/eeglab.js — read EEGLAB recordings in either layout:

   1. Split `.set` + `.fdt`: the .set is just a MATLAB header
      (channel info, srate, etc.) and the data lives in a sibling
      .fdt file as flat little-endian float32 in MATLAB column-
      major order — `data[chan, sample] @ byte (sample*nCh+chan)*4`.
      Range-friendly: we fetch only the needed window via HTTP
      Range and de-interleave once.

   2. Inline-data `.set` (most modern EEGLAB / MNE-Python exports):
      the .set is a MAT v5 file containing the data as a typed
      array INSIDE itself. We download the whole .set, parse it
      via _matv5.js, extract `EEG.data` (or top-level `data`),
      and serve windows from the in-memory column-major array.

   We skip BIDS sidecar `.set` parsing for the split-layout case
   (channel count + sample rate come from `_channels.tsv` and
   `_eeg.json`); the inline case has no choice but to parse the
   MAT structure since that's where the data is. Standalone inline
   .set files without a BIDS sidecar are supported too — nbchan and
   srate come from the EEG struct and channel labels default to
   Ch1..ChN when _channels.tsv is absent.

   Epoched (3-D) data `[n_channels, n_pnts, n_trials]` is treated
   as continuous: we flatten the trial axis so the viewer's flat
   time-axis pans across concatenated trials.
   ============================================================ */
(function () {
  'use strict';

  const api = {};
  const BYTES_PER_SAMPLE = 4;
  const HOST_LITTLE_ENDIAN =
    new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

  // Security: when a v7.3 .set CHAR pointer names a sibling .fdt file
  // we treat the value as a BASENAME ONLY. Reject anything that could
  // escape the .set's directory (path separator, leading dot, scheme).
  // Threat model: hostile .set embeds e.g. "../../../etc/passwd" or
  // "//evil.com/x" as the /EEG/data CHAR; the reader would otherwise
  // concatenate dir + namedFdt and fetch the resulting URL.
  function _validateCrossFdtName(namedFdt) {
    if (typeof namedFdt !== 'string' || namedFdt.length === 0) {
      throw new Error(`eeglab: refusing cross-basename .fdt with empty or non-string name`);
    }
    if (namedFdt.includes('/') || namedFdt.includes('\\') ||
        namedFdt.startsWith('.') || /^[a-z]+:/i.test(namedFdt)) {
      throw new Error(`eeglab: refusing cross-basename .fdt with path separator or scheme: ${namedFdt}`);
    }
    return namedFdt;
  }
  api._validateCrossFdtName = _validateCrossFdtName;

  api.fdtUrlFor = function (eegUrl) {
    const { dir, prefix, ext } = BIDSRecording.parseEegUrl(eegUrl);
    if (ext !== 'set') {
      throw new Error(`EEGLAB reader expects *_eeg.set, got *_eeg.${ext}`);
    }
    return `${dir}${prefix}_eeg.fdt`;
  };

  // Detect whether a file/sidecar duration mismatch is "this is just
  // an epoched .fdt the sidecar doesn't know about" or a real problem.
  // Returning kind keeps the open() control flow flat.
  function classifyDurationMismatch(fileDur, declaredDur) {
    if (declaredDur == null || declaredDur <= 0) return { kind: 'no-declared' };
    if (Math.abs(fileDur - declaredDur) <= 0.01) return { kind: 'ok' };
    const ratio = fileDur / declaredDur;
    const intRatio = Math.round(ratio);
    if (intRatio > 1 && Math.abs(ratio - intRatio) < 0.01) {
      return { kind: 'epoched', trials: intRatio };
    }
    return { kind: 'mismatch' };
  }

  /**
   * Open an EEGLAB .set file (with optional external .fdt) for windowed reading.
   *
   * The returned descriptor (loosely typed as `object` because the .set
   * format has several optional fields and extra metadata is attached
   * conditionally) exposes at least:
   *   - n_channels, sampling_frequency, n_samples, bytes_per_sample,
   *     duration_s: number
   *   - url, channel_labels, bids_channels: pass-through metadata
   *   - readWindow(start, n, opts?): Promise<Float32Array[]>
   *   - readWindowStreaming(start, n, opts?) when supported by the layout
   *
   * @param {object} meta - The recording descriptor from bids-recording.js.
   * @returns {Promise<object>}
   */
  api.open = async function (meta) {
    if (!HOST_LITTLE_ENDIAN) {
      throw new Error('EEGLAB .fdt reader requires a little-endian host.');
    }
    // BIDS-strict gate has been relaxed: when _channels.tsv is absent
    // we can still serve an inline-data .set (MAT v5 parser fills in
    // nbchan / srate / labels from the EEG struct itself). The split
    // .set+.fdt layout, on the other hand, still needs _channels.tsv
    // because the .fdt is a raw float32 blob with no header — we have
    // no way to know nChannels without it. So: only require channels
    // up front; defer the BIDS-sidecar requirement to the .fdt branch.
    const eegJson = meta.eeg_json || {};
    const sidecarFs = eegJson.sampling_frequency;
    const sidecarFsValid = isFinite(sidecarFs) && sidecarFs > 0;
    const hasChannels = !!(meta.channels && meta.channels.length);
    const nChannelsFromSidecar = hasChannels ? meta.channels.length : null;

    // Resolve the .fdt sibling URL. For BIDS-pathed sources
    // (OpenNeuro) we derive it by string-replace on .set; for SHA-
    // keyed sources (NEMAR) we look it up in the pre-resolved map.
    // A null result is a strong signal that this is an inline-data
    // .set — we'll fall through to the MAT parser below.
    const fdtUrl = resolveFdtUrl(meta);

    // Probe the .fdt; on 404 (or NEMAR with no .fdt entry) switch to
    // the inline-data .set path. Other errors propagate.
    let totalBytes = null;
    if (fdtUrl) {
      try {
        totalBytes = await HttpRange.probeLength(fdtUrl);
      } catch (e) {
        if (!/HTTP 404/.test(e.message)) throw e;
      }
    }
    if (totalBytes == null) {
      // Inline-data path: nbchan / srate / data live inside the .set;
      // we can produce a working reader without the BIDS sidecar.
      // Pass nulls for the sidecar values when missing; openInlineSet
      // will use the .set's own metadata and warn only if they conflict.
      return openInlineSet(meta, nChannelsFromSidecar, sidecarFsValid ? sidecarFs : null);
    }

    // Split .set + .fdt path: the .fdt is a flat float32 blob with no
    // header — we need _channels.tsv (channel count) and _eeg.json
    // (sampling rate) to interpret it. These can't be derived from the
    // file itself.
    if (!hasChannels) {
      throw new Error('EEGLAB .fdt reader needs _channels.tsv (we skip .set parsing).');
    }
    if (!sidecarFsValid) {
      throw new Error('EEGLAB .fdt reader needs SamplingFrequency in _eeg.json.');
    }
    const nChannels = nChannelsFromSidecar;
    const fs = sidecarFs;

    if (totalBytes % (nChannels * BYTES_PER_SAMPLE) !== 0) {
      throw new Error(
        `.fdt size ${totalBytes} is not a multiple of ${nChannels}×4 — ` +
        `channel count from sidecar may be wrong.`
      );
    }
    const nSamples = totalBytes / (nChannels * BYTES_PER_SAMPLE);
    const fileDur = nSamples / fs;
    const mismatch = classifyDurationMismatch(fileDur, meta.eeg_json.recording_duration);
    let trialsHint = null;
    if (mismatch.kind === 'epoched') {
      trialsHint = mismatch.trials;
      console.warn(
        `.fdt appears epoched: ${trialsHint} trials. v1 treats it as continuous; ` +
        `epoch boundaries will not be marked.`
      );
    } else if (mismatch.kind === 'mismatch') {
      console.warn(
        `.fdt duration (${fileDur.toFixed(3)}s) disagrees with sidecar ` +
        `(${meta.eeg_json.recording_duration}s); trusting file.`
      );
    }

    return {
      n_channels: nChannels,
      n_samples: nSamples,
      sampling_frequency: fs,
      duration_s: fileDur,
      // .fdt is always Float32 little-endian per the EEGLAB spec.
      // Exposed so callers (e.g. the adaptive default-window picker
      // in viewer.js) can compute per-pan byte cost uniformly across
      // formats without special-casing EEGLAB.
      bytes_per_sample: 4,
      trials_hint: trialsHint,
      url: fdtUrl,
      channel_labels: meta.channels.map(c => c.name),
      bids_channels: meta.channels,
      // Bounds-clamp here so callers can pan past the end without
      // worrying about negative ranges or off-by-one near EOF.
      readWindow: async (startSample, nSamplesWindow, opts) => {
        const start = Math.max(0, startSample);
        if (start >= nSamples || nSamplesWindow <= 0) {
          return ChannelBuffers.empty(nChannels);
        }
        const end = Math.min(start + nSamplesWindow, nSamples);
        if (end <= start) return ChannelBuffers.empty(nChannels);
        return readInterleavedWindow(fdtUrl, nChannels, start, end - start, opts);
      },
      readWindowStreaming: (startSample, nSamplesWindow, opts) =>
        streamInterleavedWindow(fdtUrl, nChannels, nSamples, startSample, nSamplesWindow, opts),
    };
  };

  // BIDS-pathed sources string-derive .fdt; SHA-keyed sources look
  // it up in the pre-resolved sibling map. Returns null when neither
  // produces a candidate URL (used as the signal to try inline-data
  // parsing instead).
  function resolveFdtUrl(meta) {
    if (meta.sibling_urls) {
      return meta.sibling_urls[`${meta.prefix}_eeg.fdt`] || null;
    }
    return api.fdtUrlFor(meta.eeg_url);
  }

  // Inline-data .set: the EEG signal lives inside the MAT file
  // itself (no sibling .fdt). We download the whole file once,
  // parse it with the minimal MAT v5 reader, and serve windows
  // from the in-memory column-major typed array.
  //
  // Memory cost: scales with file size (typical .set is 1-200 MB).
  // For huge multi-hour recordings the upfront download will be
  // perceptible; range-streaming inside a MAT structure is non-
  // trivial (variable-length elements, optional zlib compression)
  // and out of scope for v1.
  // Range-based inline-set open. Range-fetches the head (first 16 MB)
  // to scan top-level MAT v5 elements, then serves `readWindow` by
  // range-fetching just the column slice of the `data` matrix. This
  // unblocks files > 200 MB that previously hit the legacy cap.
  //
  // Falls back to the whole-file parse path for:
  //   - MAT v7.3 (HDF5 needs the whole file for jsfive)
  //   - Compressed (miCOMPRESSED) elements (zlib needs the whole stream)
  //   - Non-float32 data classes (we don't range-stream int16/double yet)
  //   - Struct-wrapped EEG (scanElements only sees top-level matrices;
  //     EEG struct hides `data` inside, so we fall through to MatV5.parse)
  // Each fallback retains its own 200 MB ceiling so we don't OOM the
  // page on a non-streamable huge file.
  const INLINE_METADATA_BUDGET_BYTES = 16 * 1024 * 1024;  // 16 MB head probe
  const INLINE_LEGACY_FALLBACK_CAP   = 200 * 1024 * 1024;  // 200 MB cap

  async function openInlineSet(meta, nChannelsFromSidecar, fsFromSidecar) {
    const setUrl = meta.eeg_url;
    // Use a 1-byte Range GET to learn total size — HEAD requests
    // against cdn.eegdash.org poison the Range cache (see
    // tests/evidence/streaming-large/README.md for the discovery).
    const totalBytes = await probeLengthRangeOnly(setUrl);

    // Range-fetch the head probe (capped at 16 MB or totalBytes).
    const probeBytes = Math.min(totalBytes, INLINE_METADATA_BUDGET_BYTES);
    const probeBuf   = await HttpRange.rangeFetch(setUrl, 0, probeBytes - 1, probeBytes);

    // Detect MAT version. v7.3 (HDF5) is NOT range-streamable in v1 —
    // jsfive needs the whole file. Fall back to the legacy whole-file
    // path, with the 200 MB cap kept as a safety net.
    const matVersion = MatV5.detectMatVersion(probeBuf);
    if (matVersion === 'v7.3') {
      if (totalBytes > INLINE_LEGACY_FALLBACK_CAP) {
        throw new Error(
          `EEGLAB inline v7.3 .set is ${(totalBytes / 1024 / 1024).toFixed(0)} MB ` +
          `(exceeds ${INLINE_LEGACY_FALLBACK_CAP / 1024 / 1024} MB v7.3 cap). ` +
          `Streaming v7.3 is not supported in v1.`,
        );
      }
      const buf = await HttpRange.rangeFetch(setUrl, 0, totalBytes - 1, totalBytes);
      return await openInlineSetLegacy(setUrl, meta, buf, nChannelsFromSidecar, fsFromSidecar, matVersion);
    }

    // v5 path: scan the probe buffer for top-level elements.
    // If scan fails (e.g. struct-wrapped EEG whose payload exceeds
    // the 16 MB probe), fall back to whole-file parse with the
    // 200 MB cap as a safety net.
    let elements;
    try {
      elements = MatV5.scanElements(probeBuf);
    } catch (e) {
      if (totalBytes > INLINE_LEGACY_FALLBACK_CAP) {
        throw new Error(
          `EEGLAB inline .set scan failed and file is ` +
          `${(totalBytes / 1024 / 1024).toFixed(0)} MB ` +
          `(exceeds ${INLINE_LEGACY_FALLBACK_CAP / 1024 / 1024} MB ` +
          `legacy cap). Original error: ${e.message}`,
        );
      }
      const buf = await HttpRange.rangeFetch(setUrl, 0, totalBytes - 1, totalBytes);
      return await openInlineSetLegacy(setUrl, meta, buf, nChannelsFromSidecar, fsFromSidecar, 'v5');
    }

    // If any compressed element is present, fall back to whole-file parse.
    const hasCompressed = elements.some(el => el.miType === 15);
    if (hasCompressed) {
      if (totalBytes > INLINE_LEGACY_FALLBACK_CAP) {
        throw new Error(
          `EEGLAB inline .set is compressed and ${(totalBytes / 1024 / 1024).toFixed(0)} MB ` +
          `(exceeds ${INLINE_LEGACY_FALLBACK_CAP / 1024 / 1024} MB legacy cap).`,
        );
      }
      const buf = await HttpRange.rangeFetch(setUrl, 0, totalBytes - 1, totalBytes);
      return await openInlineSetLegacy(setUrl, meta, buf, nChannelsFromSidecar, fsFromSidecar, 'v5');
    }

    // Find the top-level `data` matrix. EEGLAB writes either a single
    // struct named "EEG" wrapping data/srate/nbchan/etc., or top-level
    // variables with those names. scanElements only walks top-level —
    // struct-wrapped layouts fall back to the legacy whole-file parse.
    const dataElem = elements.find(el => el.name === 'data' && el.dataSubOffset != null);
    if (!dataElem) {
      // Probably EEG-wrapped struct, or the head probe didn't reach
      // far enough. Either way, fall back to whole-file parse.
      if (totalBytes > INLINE_LEGACY_FALLBACK_CAP) {
        throw new Error(
          `EEGLAB inline .set: top-level 'data' not found in first ${probeBytes}B ` +
          `(file is ${(totalBytes / 1024 / 1024).toFixed(0)} MB, exceeds legacy cap). ` +
          `Re-export as top-level (non-struct-wrapped) inline .set or split .set+.fdt.`,
        );
      }
      const buf = await HttpRange.rangeFetch(setUrl, 0, totalBytes - 1, totalBytes);
      return await openInlineSetLegacy(setUrl, meta, buf, nChannelsFromSidecar, fsFromSidecar, 'v5');
    }

    // Pull the small metadata fields from the scanned elements. EEGLAB
    // writes scalars compactly: when a value (srate=250, nbchan=74)
    // fits in a smaller integer type, the MAT writer encodes the
    // realdata sub-element in that type — independent of the matrix's
    // mxClass. We've seen ds002718 store srate=250 as a single uint8
    // byte, dims-array-style. Handle every integer width that EEGLAB
    // emits in the wild, plus the two float types.
    function readScalar(name) {
      const el = elements.find(x => x.name === name && x.dataSubOffset != null);
      if (!el) return null;
      const localOff = el.dataSubOffset;
      if (localOff < 0 || localOff + el.dataSubBytes > probeBuf.byteLength) return null;
      const dv = new DataView(probeBuf, localOff, el.dataSubBytes);
      switch (el.dataSubMiType) {
        case 1: return dv.getInt8(0);            // miINT8
        case 2: return dv.getUint8(0);           // miUINT8
        case 3: return dv.getInt16(0, true);     // miINT16
        case 4: return dv.getUint16(0, true);    // miUINT16
        case 5: return dv.getInt32(0, true);     // miINT32
        case 6: return dv.getUint32(0, true);    // miUINT32
        case 7: return dv.getFloat32(0, true);   // miSINGLE
        case 9: return dv.getFloat64(0, true);   // miDOUBLE
        default: return null;
      }
    }

    const srate  = readScalar('srate');
    const nbchan = readScalar('nbchan') ?? dataElem.dims[0];
    const pnts   = readScalar('pnts')   ?? dataElem.dims[1];
    const trials = readScalar('trials') ?? (dataElem.dims[2] || 1);
    if (!srate || !isFinite(srate) || srate <= 0) {
      // EEG.srate isn't a top-level matrix — file is struct-wrapped or
      // uses miCOMPRESSED scalars. Fall back to whole-file parse so
      // extractEegInline can descend into the EEG struct.
      if (totalBytes > INLINE_LEGACY_FALLBACK_CAP) {
        throw new Error(
          `EEGLAB inline .set: srate not at top level and file is ${(totalBytes / 1024 / 1024).toFixed(0)} MB ` +
          `(exceeds ${INLINE_LEGACY_FALLBACK_CAP / 1024 / 1024} MB legacy cap).`,
        );
      }
      const buf = await HttpRange.rangeFetch(setUrl, 0, totalBytes - 1, totalBytes);
      return await openInlineSetLegacy(setUrl, meta, buf, nChannelsFromSidecar, fsFromSidecar, 'v5');
    }
    if (nChannelsFromSidecar != null && nbchan !== nChannelsFromSidecar) {
      console.warn(
        `EEGLAB inline .set: nbchan=${nbchan} disagrees with _channels.tsv (${nChannelsFromSidecar}); ` +
        `trusting the .set.`
      );
    }
    if (fsFromSidecar != null && Math.abs(srate - fsFromSidecar) > 0.5) {
      console.warn(
        `EEGLAB inline .set: srate=${srate} Hz disagrees with _eeg.json (${fsFromSidecar} Hz); ` +
        `trusting the .set.`
      );
    }

    const nSamples = pnts * trials;
    const expectedDataBytes = nbchan * nSamples * 4;
    if (dataElem.dataSubMiType !== 7) {
      // Non-float32 data — fall back to whole-file parse.
      if (totalBytes > INLINE_LEGACY_FALLBACK_CAP) {
        throw new Error(
          `EEGLAB inline .set: data is non-float32 (miType=${dataElem.dataSubMiType}) ` +
          `and file is ${(totalBytes / 1024 / 1024).toFixed(0)} MB — exceeds ${INLINE_LEGACY_FALLBACK_CAP / 1024 / 1024} MB legacy cap.`,
        );
      }
      const buf = await HttpRange.rangeFetch(setUrl, 0, totalBytes - 1, totalBytes);
      return await openInlineSetLegacy(setUrl, meta, buf, nChannelsFromSidecar, fsFromSidecar, 'v5');
    }
    if (dataElem.dataSubBytes !== expectedDataBytes) {
      // Keep the canonical "data length != nbchan × pnts × trials" wording
      // so callers (and tests) can match on a stable string.
      throw new Error(
        `EEGLAB inline .set: data length ${dataElem.dataSubBytes / 4} != ` +
        `nbchan(${nbchan}) × pnts(${pnts}) × trials(${trials}) (= ${nbchan * pnts * trials})`,
      );
    }

    const duration_s = nSamples / srate;
    const trialsHint = trials > 1 ? trials : null;
    if (trialsHint) {
      console.warn(`EEGLAB inline .set is epoched (${trialsHint} trials); v1 flattens to continuous.`);
    }
    const fallbackLabels = Array.from({ length: nbchan }, (_, i) => `Ch${i + 1}`);
    const channelLabels  = meta.channels && meta.channels.length === nbchan
      ? meta.channels.map(c => c.name)
      : fallbackLabels;

    const dataAbsOffset = dataElem.dataSubOffset;

    return {
      n_channels:         nbchan,
      n_samples:          nSamples,
      sampling_frequency: srate,
      duration_s,
      bytes_per_sample:   4,
      trials_hint:        trialsHint,
      url:                setUrl,
      channel_labels:     channelLabels,
      bids_channels:      meta.channels || null,
      streaming:          true,
      async readWindow(startSample, nSamplesWindow, opts) {
        const start = Math.max(0, startSample);
        if (start >= nSamples || nSamplesWindow <= 0) {
          return ChannelBuffers.empty(nbchan);
        }
        const end = Math.min(start + nSamplesWindow, nSamples);
        const nWin = end - start;
        const byteStart = dataAbsOffset + start * nbchan * 4;
        const byteEnd   = dataAbsOffset + end   * nbchan * 4 - 1;
        const buf = await HttpRange.rangeFetch(setUrl, byteStart, byteEnd, nWin * nbchan * 4, opts);
        const flat = new Float32Array(buf);
        // Column-major slice: data[chan, sample] @ sample*nchan + chan.
        const out = ChannelBuffers.alloc(nbchan, nWin);
        for (let s = 0; s < nWin; s++) {
          const base = s * nbchan;
          for (let c = 0; c < nbchan; c++) out[c][s] = flat[base + c];
        }
        return out;
      },
    };
  }

  // HEAD-avoidant length probe — see formats/fiff.js for the same
  // workaround. The cdn.eegdash.org worker caches HEAD responses with
  // the same cache key as GET, so subsequent GET-with-Range gets the
  // cached 200 + full body. Use a 1-byte Range GET instead and read
  // total from Content-Range.
  async function probeLengthRangeOnly(url) {
    try {
      const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
      if (res.status === 206) {
        const cr = res.headers.get('content-range');
        const m = cr && /\/(\d+)$/.exec(cr);
        if (m) {
          await res.arrayBuffer();
          return Number(m[1]);
        }
      }
      await res.arrayBuffer().catch(() => null);
    } catch {
      // Fall through.
    }
    return HttpRange.probeLength(url);
  }

  // Legacy whole-file parse path. Used as the fallback for v7.3,
  // compressed, struct-wrapped, or non-float32 inline .set files.
  // Identical to the pre-refactor behaviour but factored out so the
  // streaming path can reuse it.
  async function openInlineSetLegacy(setUrl, meta, buf, nChannelsFromSidecar, fsFromSidecar, matVersion) {
    let vars;
    if (matVersion === 'v7.3' && typeof globalThis.Mat73 !== 'undefined') {
      try {
        vars = await Mat73.parse(buf);
      } catch (e) {
        // Cross-basename .fdt fallback: when /EEG/data is a CHAR
        // pointer to a sibling whose basename differs from the .set,
        // Mat73.parse throws a precise message containing the filename
        // in double-quoted form. Parse the filename out, derive the
        // sibling URL, and serve windows from the named .fdt. See
        // tests/evidence/v73-real-data/README.md for the rationale.
        const fdtMatch = /CHAR sidecar filename \("([^"]+)"\)/.exec(e.message || '');
        if (fdtMatch) {
          const namedFdt = _validateCrossFdtName(fdtMatch[1]);
          const dir = setUrl.slice(0, setUrl.lastIndexOf('/') + 1);
          const fdtUrl = dir + namedFdt;
          console.warn(
            `EEGLAB v7.3: /EEG/data points at sibling "${namedFdt}" ` +
            `(different basename from the .set); following the named .fdt.`
          );
          // Without the .set's inline numeric data we can't recover
          // nbchan/srate from the file itself. The BIDS sidecar
          // (passed in `meta`) is the only source.
          if (!nChannelsFromSidecar || !fsFromSidecar) {
            throw new Error(
              `EEGLAB v7.3 cross-basename: need _channels.tsv and ` +
              `SamplingFrequency in _eeg.json to interpret the named ` +
              `.fdt sibling "${namedFdt}"`
            );
          }
          const totalBytesFdt = await HttpRange.probeLength(fdtUrl);
          if (totalBytesFdt % (nChannelsFromSidecar * BYTES_PER_SAMPLE) !== 0) {
            throw new Error(
              `.fdt size ${totalBytesFdt} is not a multiple of ` +
              `${nChannelsFromSidecar}×${BYTES_PER_SAMPLE} — sidecar ` +
              `channel count may be wrong`
            );
          }
          const nSamplesFdt = totalBytesFdt / (nChannelsFromSidecar * BYTES_PER_SAMPLE);
          const durationFdt = nSamplesFdt / fsFromSidecar;
          const labels =
            meta.channels && meta.channels.length === nChannelsFromSidecar
              ? meta.channels.map((c) => c.name)
              : Array.from({ length: nChannelsFromSidecar }, (_, i) => `Ch${i + 1}`);
          return {
            n_channels: nChannelsFromSidecar,
            n_samples: nSamplesFdt,
            sampling_frequency: fsFromSidecar,
            duration_s: durationFdt,
            bytes_per_sample: BYTES_PER_SAMPLE,
            url: fdtUrl,
            channel_labels: labels,
            bids_channels: meta.channels || null,
            readWindow: async (startSample, nSamplesWindow, opts) => {
              const start = Math.max(0, startSample);
              if (start >= nSamplesFdt || nSamplesWindow <= 0) {
                return ChannelBuffers.empty(nChannelsFromSidecar);
              }
              const end = Math.min(start + nSamplesWindow, nSamplesFdt);
              return readInterleavedWindow(
                fdtUrl,
                nChannelsFromSidecar,
                start,
                end - start,
                opts,
              );
            },
          };
        }
        throw new Error(`EEGLAB inline .set (v7.3) parse failed at ${setUrl}: ${e.message}`);
      }
    } else {
      try {
        vars = await MatV5.parse(buf);
      } catch (e) {
        throw new Error(`EEGLAB inline .set parse failed at ${setUrl}: ${e.message}`);
      }
    }
    const eeg = MatV5.extractEegInline(vars);

    const nbchan = eeg.nbchan;
    // Sidecar values are advisory: warn on mismatch, but trust the
    // .set (it's the actual on-disk header). When the sidecar is
    // absent entirely (standalone .set), there's nothing to warn about.
    if (nChannelsFromSidecar != null && nbchan !== nChannelsFromSidecar) {
      console.warn(
        `EEGLAB inline .set: nbchan=${nbchan} disagrees with _channels.tsv ` +
        `(${nChannelsFromSidecar}); trusting the .set.`
      );
    }
    if (fsFromSidecar != null && Math.abs(eeg.srate - fsFromSidecar) > 0.5) {
      console.warn(
        `EEGLAB inline .set: srate=${eeg.srate} Hz disagrees with _eeg.json ` +
        `(${fsFromSidecar} Hz); trusting the .set.`
      );
    }
    const fs = eeg.srate;

    // Convert non-Float32 inputs (int16 / int32 / double) up-front so
    // the source typed array can be GC'd. sliceColumnMajor would
    // promote to Float32 implicitly at element-assignment anyway, but
    // that path keeps both the source AND the destination buffers in
    // memory simultaneously during the slice; converting now bounds
    // peak memory to the destination size only.
    const data32 = eeg.dataClass === 'single' ? eeg.data : Float32Array.from(eeg.data);
    const nSamples = eeg.pnts * eeg.trials;
    const expectedLen = nbchan * nSamples;
    if (data32.length !== expectedLen) {
      throw new Error(
        `EEGLAB inline .set: data length ${data32.length} != nbchan(${nbchan}) × pnts(${eeg.pnts}) × trials(${eeg.trials})`
      );
    }
    const trialsHint = eeg.trials > 1 ? eeg.trials : null;
    if (trialsHint) {
      console.warn(
        `EEGLAB inline .set is epoched (${trialsHint} trials); v1 flattens to continuous.`
      );
    }
    const duration_s = nSamples / fs;

    // Channel labels: prefer the BIDS sidecar (gives types + units),
    // otherwise fall back to Ch1..ChN. Note: EEGLAB's EEG.chanlocs
    // struct-array carries real labels in MATLAB but the current
    // MatV5 parser only reads the first element of a struct array,
    // so we can't extract per-channel labels from there yet — tracked
    // as a follow-up. Defaulting to indexed labels lets standalone
    // .set files (no BIDS sidecar) at least open and render.
    const fallbackLabels = Array.from({ length: nbchan }, (_, i) => `Ch${i + 1}`);
    const channelLabels = meta.channels && meta.channels.length === nbchan
      ? meta.channels.map(c => c.name)
      : fallbackLabels;

    return {
      n_channels: nbchan,
      n_samples: nSamples,
      sampling_frequency: fs,
      duration_s,
      bytes_per_sample: 4,
      trials_hint: trialsHint,
      url: setUrl,
      channel_labels: channelLabels,
      bids_channels: meta.channels || null,
      readWindow: async (startSample, nSamplesWindow) => {
        const start = Math.max(0, startSample);
        if (start >= nSamples || nSamplesWindow <= 0) {
          return ChannelBuffers.empty(nbchan);
        }
        const end = Math.min(start + nSamplesWindow, nSamples);
        return sliceColumnMajor(data32, nbchan, start, end - start);
      },
    };
  }

  // Slice an in-memory column-major (channels-major) Float32 array.
  // Same memory layout as the de-interleaved .fdt path output: one
  // Float32Array per channel, allocated through ChannelBuffers.
  function sliceColumnMajor(flat, nChannels, startSample, nWin) {
    const out = ChannelBuffers.alloc(nChannels, nWin);
    for (let s = 0; s < nWin; s++) {
      const base = (startSample + s) * nChannels;
      for (let c = 0; c < nChannels; c++) {
        out[c][s] = flat[base + c];
      }
    }
    return out;
  }

  // Returns one Float32Array per channel as views over a single
  // backing buffer — the renderer can subscript them at draw time
  // without copying, and we get one allocation per pan instead of
  // n_channels small ones.
  async function readInterleavedWindow(url, nChannels, startSample, nWin, opts) {
    const byteStart = startSample * nChannels * BYTES_PER_SAMPLE;
    const expectedBytes = nWin * nChannels * BYTES_PER_SAMPLE;
    const buf = await HttpRange.rangeFetch(url, byteStart, byteStart + expectedBytes - 1, expectedBytes, opts);
    const interleaved = new Float32Array(buf);
    const out = ChannelBuffers.alloc(nChannels, nWin);
    let i = 0;
    for (let s = 0; s < nWin; s++) {
      for (let c = 0; c < nChannels; c++) {
        out[c][s] = interleaved[i++];
      }
    }
    return out;
  }

  // Underscore prefix marks "stable for tests, not for production
  // callers". Production code consumes `open()` only.
  api._classifyDurationMismatch = classifyDurationMismatch;
  api._sliceColumnMajor = sliceColumnMajor;

  // Streaming decode for EEGLAB .fdt (channel-interleaved Float32).
  // Yields { firstSampleIdx, lastSampleIdx, channels } as bytes arrive.
  // Each chunk is decoded by de-interleaving complete frames (nCh * 4 bytes).
  // STREAM_BATCH_FRAMES controls how many frames to accumulate before yielding.
  const STREAM_BATCH_FRAMES = 512;

  async function* streamInterleavedWindow(url, nChannels, nSamples, startSample, nWinReq, opts) {
    const start = Math.max(0, startSample);
    if (start >= nSamples || nWinReq <= 0) return;
    const end = Math.min(start + nWinReq, nSamples);
    const nWin = end - start;

    const byteStart = start * nChannels * BYTES_PER_SAMPLE;
    const expectedBytes = nWin * nChannels * BYTES_PER_SAMPLE;
    const frameSize = nChannels * BYTES_PER_SAMPLE;

    let leftover = new Uint8Array(0);
    let outSamples = 0;

    for await (const { bytes } of HttpRange.rangeFetchStreaming(
      url, byteStart, byteStart + expectedBytes - 1, opts
    )) {
      const boundary = StreamingUtils.decodeChunkBoundary(leftover, bytes, frameSize);
      leftover = boundary.leftover;
      const completeBytes = boundary.completeRecordBytes;
      const nFrames = Math.floor(completeBytes.length / frameSize);
      if (nFrames === 0) continue;

      // Decode in batches to limit memory pressure
      let fOff = 0;
      while (fOff < nFrames && outSamples < nWin) {
        const batchFrames = Math.min(STREAM_BATCH_FRAMES, nFrames - fOff, nWin - outSamples);
        const batchU8 = completeBytes.subarray(fOff * frameSize, (fOff + batchFrames) * frameSize);
        const interleaved = new Float32Array(batchU8.buffer, batchU8.byteOffset, batchFrames * nChannels);
        const out = ChannelBuffers.alloc(nChannels, batchFrames);
        let i = 0;
        for (let s = 0; s < batchFrames; s++) {
          for (let c = 0; c < nChannels; c++) {
            out[c][s] = interleaved[i++];
          }
        }
        const firstSampleIdx = start + outSamples;
        const lastSampleIdx = firstSampleIdx + batchFrames - 1;
        outSamples += batchFrames;
        yield { firstSampleIdx, lastSampleIdx, channels: out };
        fOff += batchFrames;
      }
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.EEGLABReader = api;
})();
