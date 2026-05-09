/* ============================================================
   formats/eeglab.js — read EEGLAB `.fdt` flat float32 matrices
   over HTTP Range requests. We deliberately do NOT parse the
   sibling `.set` MAT-file: BIDS sidecars (`_channels.tsv`,
   `_eeg.json`) carry every field we need (channel count, sample
   rate, channel names, units), and skipping the MAT parser
   keeps this module under 200 LOC of vanilla JS.

   Binary layout (continuous recordings):
     little-endian float32, MATLAB column-major
       data[chan, sample] @ byte (sample * n_channels + chan) * 4
     i.e. samples are interleaved by channel — exactly the layout
     that lets us range-fetch a time window of all channels in a
     single contiguous HTTP request and then de-interleave once.

   Epoched (3-D) `.fdt` files [n_channels, n_pnts, n_trials] are
   out of scope for v1; if the file size implies trials > 1 we
   flag it in `open()` and the viewer treats samples as flat.
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

  api.open = async function (meta) {
    if (!HOST_LITTLE_ENDIAN) {
      throw new Error('EEGLAB .fdt reader requires a little-endian host.');
    }
    if (!meta.channels || !meta.channels.length) {
      throw new Error('EEGLAB .fdt reader needs _channels.tsv (we skip .set parsing).');
    }
    const fs = meta.eeg_json.sampling_frequency;
    if (!isFinite(fs) || fs <= 0) {
      throw new Error('EEGLAB .fdt reader needs SamplingFrequency in _eeg.json.');
    }
    const nChannels = meta.channels.length;
    const fdtUrl = api.fdtUrlFor(meta.eeg_url);
    let totalBytes;
    try {
      totalBytes = await HttpRange.probeLength(fdtUrl);
    } catch (e) {
      // The most common 404 here is that the recording embeds its data
      // inside the .set MAT-file instead of in a sibling .fdt — EEGLAB
      // supports both layouts but our v1 only reads the .fdt variant.
      // Surface that explicitly so the user knows what's missing.
      if (/HTTP 404/.test(e.message)) {
        throw new Error(
          `EEGLAB .fdt not found at ${fdtUrl}. This recording likely embeds ` +
          `its data inside the .set MAT-file (no sibling .fdt). v1 only supports ` +
          `the .set+.fdt split layout; inline-data .set parsing isn't implemented.`
        );
      }
      throw e;
    }

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
