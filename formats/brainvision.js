/* ============================================================
   formats/brainvision.js — read BrainVision Core Data Format
   (.vhdr / .eeg / .vmrk) over HTTP Range.

   The header is INI-style text in the `.vhdr` file. The data is
   a flat binary matrix in the `.eeg` file in one of two layouts:

     MULTIPLEXED  (default, sample-major)
       byte offset of sample s, channel c = (s·N + c) · bps
       — same layout as EEGLAB .fdt; readers can deinterleave
       a single contiguous range fetch.

     VECTORIZED  (channel-major, rare)
       byte offset of sample s, channel c = (c·NSAMPLES + s) · bps

   v1 supports only MULTIPLEXED; VECTORIZED would cost N range
   fetches per pan and we haven't seen it in practice.

   Per-channel scaling is a simple scalar `resolution_per_unit`
   (typically µV per integer), applied uniformly per channel.
   No digital min/max gymnastics like EDF.

   We read sidecars first if available (BIDS sources of truth),
   but fall back to the .vhdr's own SamplingInterval and
   [Channel Infos] when sidecars are missing — many real datasets
   (ds002336) inherit `_channels.tsv` only at the dataset root,
   or omit it entirely.
   ============================================================ */
(function () {
  'use strict';

  const api = {};

  // Maps the BrainVision spec's BinaryFormat tag to (a) bytes per
  // sample and (b) the typed-array view we use to read the buffer.
  // All supported formats are little-endian on the host architectures
  // we run; the float case is covered by the host-endianness check
  // in eeglab.js.
  const BIN_FORMATS = {
    INT_16:        { bps: 2, view: Int16Array  },
    UINT_16:       { bps: 2, view: Uint16Array },
    INT_32:        { bps: 4, view: Int32Array  },
    IEEE_FLOAT_32: { bps: 4, view: Float32Array },
  };

  // Permissive INI parser. BrainVision allows `;` line comments,
  // square-bracket section headers, and `key=value` pairs. Section
  // names are lower-cased so callers can index without remembering
  // the original capitalisation.
  api.parseIni = function (text) {
    const sections = {};
    let cur = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith(';')) continue;
      const sec = /^\[(.+)\]$/.exec(line);
      if (sec) {
        cur = sec[1].trim().toLowerCase();
        sections[cur] = sections[cur] || {};
        continue;
      }
      if (cur == null) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      sections[cur][line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
    }
    return sections;
  };

  // BrainVision encodes commas inside channel names as `\1`. This is
  // the only escape the spec defines. Restore them after splitting.
  function splitCh(value) {
    return value.split(',').map(p => p.replace(/\\1/g, ',').trim());
  }

  function parseFiniteIntOrNull(v) {
    if (v == null) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }

  api.parseHeader = function (text) {
    const sec = api.parseIni(text);
    const common = sec['common infos'];
    const binary = sec['binary infos'];
    const channels = sec['channel infos'];
    if (!common || !binary || !channels) {
      throw new Error('.vhdr missing required section: [Common Infos] / [Binary Infos] / [Channel Infos]');
    }

    if (common.DataFormat !== 'BINARY') {
      throw new Error(`v1 only supports DataFormat=BINARY (got "${common.DataFormat}")`);
    }
    if ((common.DataType || 'TIMEDOMAIN') !== 'TIMEDOMAIN') {
      throw new Error(`v1 only supports DataType=TIMEDOMAIN (got "${common.DataType}")`);
    }
    const orientation = (common.DataOrientation || 'MULTIPLEXED').toUpperCase();
    if (orientation !== 'MULTIPLEXED') {
      throw new Error(`v1 only supports DataOrientation=MULTIPLEXED (got "${orientation}")`);
    }

    const nChannels = parseInt(common.NumberOfChannels, 10);
    if (!Number.isFinite(nChannels) || nChannels <= 0) {
      throw new Error(`Invalid NumberOfChannels: ${common.NumberOfChannels}`);
    }
    const samplingIntervalUs = parseFloat(common.SamplingInterval);
    if (!Number.isFinite(samplingIntervalUs) || samplingIntervalUs <= 0) {
      throw new Error(`Invalid SamplingInterval: ${common.SamplingInterval}`);
    }
    const fs = 1e6 / samplingIntervalUs;

    const binaryFormat = binary.BinaryFormat;
    if (!BIN_FORMATS[binaryFormat]) {
      throw new Error(`Unsupported BinaryFormat "${binaryFormat}" (supported: ${Object.keys(BIN_FORMATS).join(', ')})`);
    }
    const bytesPerSample = BIN_FORMATS[binaryFormat].bps;

    const channelInfos = new Array(nChannels);
    for (let i = 0; i < nChannels; i++) {
      const v = channels[`Ch${i + 1}`];
      if (!v) throw new Error(`[Channel Infos] missing Ch${i + 1}`);
      const parts = splitCh(v);
      const scale = parseFloat(parts[2]);
      channelInfos[i] = {
        name:      parts[0] || `Ch${i + 1}`,
        reference: parts[1] || null,
        // BrainVision spec: empty resolution means "1 in unit".
        // mne also defaults to 1 when missing.
        scale:     Number.isFinite(scale) ? scale : 1,
        unit:      parts[3] || 'µV',
      };
    }

    return {
      data_file: common.DataFile,
      marker_file: common.MarkerFile || null,
      n_channels: nChannels,
      sampling_frequency: fs,
      sampling_interval_us: samplingIntervalUs,
      data_points_declared: parseFiniteIntOrNull(common.DataPoints),
      binary_format: binaryFormat,
      bytes_per_sample: bytesPerSample,
      orientation,
      channels: channelInfos,
    };
  };

  function warnIf(cond, msg) { if (cond) console.warn(msg); }

  api.open = async function (meta) {
    const vhdrUrl = meta.eeg_url;
    const hdr = api.parseHeader(await HttpRange.fetchText(vhdrUrl));

    // `new URL(relative, base)` already covers absolute URLs, relative
    // sub-paths, and bare filenames against a base, including the
    // trailing-slash edge cases we'd otherwise have to remember. For
    // localdrop URLs we still get a localdrop URL back because both
    // base and relative live on the same synthetic host.
    const eegUrl = new URL(hdr.data_file, vhdrUrl).href;
    const totalBytes = await HttpRange.probeLength(eegUrl);
    const recordBytes = hdr.n_channels * hdr.bytes_per_sample;
    if (recordBytes === 0) throw new Error('BrainVision: zero-byte sample (n_channels or bps is 0)');
    if (totalBytes % recordBytes !== 0) {
      throw new Error(
        `.eeg size ${totalBytes}B not a multiple of n_channels·bps=${recordBytes}B; ` +
        `header may misreport channel count or format.`
      );
    }
    const nSamples = totalBytes / recordBytes;

    warnIf(hdr.data_points_declared != null && hdr.data_points_declared !== nSamples,
      `.vhdr DataPoints=${hdr.data_points_declared} ≠ derived ${nSamples}; trusting file.`);
    SidecarChecks.crossCheckChannelOrder(
      hdr.channels.map(c => c.name), meta.channels, 'BrainVision');
    SidecarChecks.warnFsMismatch(meta.eeg_json.sampling_frequency, hdr.sampling_frequency, 'BrainVision');

    const scales = new Float64Array(hdr.n_channels);
    const channelLabels = new Array(hdr.n_channels);
    for (let c = 0; c < hdr.n_channels; c++) {
      scales[c] = hdr.channels[c].scale;
      channelLabels[c] = hdr.channels[c].name;
    }

    const layout = {
      url: eegUrl,
      n_channels: hdr.n_channels,
      n_samples: nSamples,
      bytes_per_sample: hdr.bytes_per_sample,
      view_ctor: BIN_FORMATS[hdr.binary_format].view,
      scales,
    };

    return {
      n_channels: hdr.n_channels,
      n_samples: nSamples,
      sampling_frequency: hdr.sampling_frequency,
      duration_s: nSamples / hdr.sampling_frequency,
      bytes_per_sample: hdr.bytes_per_sample,
      binary_format: hdr.binary_format,
      url: eegUrl,
      vhdr_url: vhdrUrl,
      channel_labels: channelLabels,
      bids_channels: meta.channels || null,
      readWindow: (start, n, opts) => readMultiplexedWindow(layout, start, n, opts),
    };
  };

  // Hot path. Single contiguous range fetch, single typed-array view
  // over the buffer chosen at open() time, then a linear walk that
  // deinterleaves + applies per-channel scale in one pass.
  async function readMultiplexedWindow(layout, startSample, nWinReq, opts) {
    const start = Math.max(0, startSample);
    if (start >= layout.n_samples || nWinReq <= 0) return ChannelBuffers.empty(layout.n_channels);
    const end = Math.min(start + nWinReq, layout.n_samples);
    const nWin = end - start;
    const nCh = layout.n_channels;
    const byteStart = start * nCh * layout.bytes_per_sample;
    const expectedBytes = nWin * nCh * layout.bytes_per_sample;
    const buf = await HttpRange.rangeFetch(layout.url, byteStart, byteStart + expectedBytes - 1, expectedBytes, opts);
    const interleaved = new layout.view_ctor(buf);

    const out = ChannelBuffers.alloc(nCh, nWin);
    const scales = layout.scales;
    let i = 0;
    for (let s = 0; s < nWin; s++) {
      for (let c = 0; c < nCh; c++) {
        out[c][s] = interleaved[i++] * scales[c];
      }
    }
    return out;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.BrainVisionReader = api;
})();
