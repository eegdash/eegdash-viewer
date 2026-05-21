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
  async function openInlineSet(meta, nChannelsFromSidecar, fsFromSidecar) {
    const setUrl = meta.eeg_url;
    const totalBytes = await HttpRange.probeLength(setUrl);

    // Bandwidth/memory ceiling for inline .set (no sibling .fdt).
    // Surfaced by Plan D browser reality-check (commit f524bad):
    // ds002578 (695 MiB) and ds002718 (224 MiB) both exceeded the
    // viewer's 60s open() budget. 200 MB cap surfaces a user-readable
    // error instead of timing out silently. Proper fix is a streaming
    // MAT v5 parser that only fetches the bytes for the requested
    // window — tracked as a follow-up.
    const INLINE_MAX_BYTES = 200 * 1024 * 1024;
    if (totalBytes > INLINE_MAX_BYTES) {
      throw new Error(
        `EEGLAB inline .set is ${(totalBytes / 1024 / 1024).toFixed(0)} MB ` +
        `(exceeds ${INLINE_MAX_BYTES / 1024 / 1024} MB inline cap). ` +
        `Upload as split .set+.fdt for streaming, or wait for streaming-inline support.`,
      );
    }

    const buf = await HttpRange.rangeFetch(setUrl, 0, totalBytes - 1, totalBytes);

    // MAT v5 (0x0100) vs v7.3 (0x0200, HDF5) dispatch. The HDF5 path
    // is opt-in: Mat73 is only loaded when index.html / worker.js
    // brings in formats/_jsfive.js + formats/_mat73.js, so we fail
    // soft to the v5 reader (which has its own friendly v7.3
    // diagnostic) when those modules aren't loaded.
    const matVersion = MatV5.detectMatVersion(buf);
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
          const namedFdt = fdtMatch[1];
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
