/* ============================================================
   formats/mef.js — MEF3 (Multiscale Electrophysiology Format
   version 3) iEEG reader for eegdash-viewer.

   MEF3 is the Mayo Clinic epilepsy iEEG standard. Unlike CTF/KIT
   which interleave channels into a single binary blob, MEF3 stores
   each channel INDEPENDENTLY as its own directory tree:

     <session>.mefd/                    session directory
       <ch1>.timd/                      one time-series channel
         <ch1>-NNNNNN.tmet              metadata (UH + sec1 + sec2 + sec3)
         <ch1>-NNNNNN.tdat              RED-compressed sample blocks
         <ch1>-NNNNNN.tidx              per-block index (start_sample, offset)
       <ch2>.timd/
         ...

   NNNNNN is a 6-digit segment number (000000, 000001, ...).
   This reader only handles **continuous, single-segment, unencrypted**
   recordings — the most common in-the-wild case.

   TIER ACHIEVED: 1 (metadata only). RED block decompression is NOT
   implemented; readWindow() throws a clean error explaining that the
   viewer can surface the dataset's structure (channel count, sample
   rate, duration) but cannot render samples. The Mayo RED codec is a
   custom range-encoded differential coder (meflib.c L4000+, ~2000
   LOC of bit-level decoding) and is out of scope for this initial
   port. Real-world EEGDash datasets aren't MEF3, so this reader is
   primarily a structure-aware fallback for users who drag .mefd/
   bundles into the viewer.

   References:
   - Spec: msel-source/meflib (Apache 2.0)
     https://github.com/msel-source/meflib
   - pymef Python bindings (BSD-2-clause)
     https://github.com/MaxvandenBoom/pymef

   ============================================================ */
(function () {
  'use strict';

  const api = {};

  // Universal header is 1024 bytes. Reading the full .tmet file is
  // cheap (16384 bytes total — UH + sec1 1536 + sec2 10752 + sec3 3072)
  // and avoids juggling multiple range reads. .tdat / .tidx can be
  // arbitrarily large, so those we leave to range-fetch on demand.
  const UH_BYTES   = 1024;
  const TMET_BYTES = 16384;

  // Plausibility bound: a real .mefd/ in iEEG contexts has anywhere from
  // 4 to ~256 channels. We accept up to 2048 to leave headroom for
  // research recordings; beyond that something is wrong.
  const MAX_CHANNELS = 2048;

  /**
   * Parse a `.tmet` ArrayBuffer into a per-segment metadata object.
   * Synchronous entry point — exposed so tests can exercise the parser
   * without HTTP. Production `api.open` calls this internally.
   *
   * @param {ArrayBuffer | Uint8Array} buf - one .tmet file
   * @returns {object} segment metadata (see _mef-segment.js parseTmet)
   * @throws {Error} on any parse failure — never returns null.
   */
  api.read = function (buf) {
    if (!globalThis.MefSegment) {
      throw new Error('mef.read: globalThis.MefSegment missing — load formats/_mef-segment.js first');
    }
    return globalThis.MefSegment.parseTmet(buf);
  };

  /**
   * Open a MEF3 `.mefd/` recording for windowed reading.
   *
   * `meta.eeg_url` must point at the bundle DIRECTORY (e.g.
   * `…/sub-01_ses-01_task-rest_ieeg.mefd/`). The trailing slash is
   * optional but the URL must resolve as a directory (the viewer's
   * controller routes .mefd/ extensions here).
   *
   * Alternatively, the caller can pass `meta.channel_urls` — a pre-
   * resolved array of `<channel>.timd/` directory URLs — to bypass
   * the listing step. This is how production callers (which can list
   * a remote directory via a manifest) wire it up.
   *
   * @param {object} meta
   * @param {string} meta.eeg_url - .mefd/ directory URL
   * @param {string[]} [meta.channel_urls] - pre-resolved .timd/ URLs
   * @param {string[]} [meta.segment_urls] - pre-resolved {.tmet, .tdat,
   *   .tidx} URL triples, one per channel. When supplied, no directory
   *   listing is needed.
   * @returns {Promise<object>} reader matching the cross-format contract
   */
  api.open = async function (meta) {
    const HttpRange = globalThis.HttpRange;
    if (!HttpRange) throw new Error('mef.open: globalThis.HttpRange missing');

    const MefSegment = globalThis.MefSegment;
    if (!MefSegment) throw new Error('mef.open: globalThis.MefSegment missing — load formats/_mef-segment.js first');

    const sessionUrl = meta && (meta.eeg_url || meta.url);
    if (!sessionUrl && !meta.segment_urls) {
      throw new Error('mef.open: meta.eeg_url is required (point at <session>.mefd/)');
    }

    // Resolve which segment .tmet/.tdat/.tidx URL triples to read. The
    // viewer + controller hand us either:
    //   (a) meta.segment_urls = [{ tmet, tdat, tidx, channel_dir }, ...]
    //       — pre-listed bundle, used by tests + future remote listing
    //   (b) meta.eeg_url = bundle dir + an HttpRange.listDir function
    //       — for file:// roots or CDNs that expose directory indexes
    // We attempt (a) first; if absent, we try (b).
    let segmentTriples = meta.segment_urls;
    if (!segmentTriples) {
      segmentTriples = await listSegmentsFromDirectory(sessionUrl, HttpRange);
    }
    if (!Array.isArray(segmentTriples) || segmentTriples.length === 0) {
      throw new Error('mef.open: could not resolve any .timd channel segments from the bundle');
    }
    if (segmentTriples.length > MAX_CHANNELS) {
      throw new Error(
        `mef.open: ${segmentTriples.length} channels exceeds the safety bound ` +
        `${MAX_CHANNELS} — refusing to load`,
      );
    }

    // Fetch all .tmet files in parallel — each is at most 16 KiB so the
    // total payload is bounded by MAX_CHANNELS * 16 KiB = 32 MiB worst
    // case. Real iEEG recordings have ~64-256 channels → 1-4 MiB.
    const tmetBuffers = await Promise.all(
      segmentTriples.map((t) => HttpRange.fetchBuffer(t.tmet)),
    );

    // Parse each .tmet. Reject if any channel is encrypted, or if
    // channels disagree on sample rate / length (we don't yet handle
    // ragged MEF3 sessions — pymef itself emits a warning in that case).
    const channelMeta = tmetBuffers.map((b, idx) => {
      try {
        return MefSegment.parseTmet(b);
      } catch (e) {
        throw new Error(
          `mef.open: channel ${idx} (${segmentTriples[idx].tmet}) failed to parse: ${e.message}`,
        );
      }
    });

    const sfreq0 = channelMeta[0].sampling_frequency;
    const nsamp0 = channelMeta[0].n_samples;
    for (let i = 1; i < channelMeta.length; i++) {
      if (channelMeta[i].sampling_frequency !== sfreq0) {
        throw new Error(
          `mef.open: channel ${i} sample rate ${channelMeta[i].sampling_frequency} ` +
          `differs from channel 0 ${sfreq0} — ragged MEF3 sessions are not supported`,
        );
      }
      if (channelMeta[i].n_samples !== nsamp0) {
        throw new Error(
          `mef.open: channel ${i} length ${channelMeta[i].n_samples} ` +
          `differs from channel 0 ${nsamp0} — ragged MEF3 sessions are not supported`,
        );
      }
    }

    const channel_labels = channelMeta.map((m, idx) => {
      // Prefer the channel_name carried in the universal header. Falls
      // back to indexed labels if the field is empty (which happens
      // when a write path failed to populate it — rare but seen in the
      // wild).
      const nm = m.universal_header.channel_name;
      return (nm && nm.length > 0) ? nm : ('Ch' + (idx + 1));
    });

    const n_channels = channelMeta.length;

    // Recording start ISO — μUTC stored in universal_header.start_time.
    // μUTC is microseconds since the Unix epoch. We convert to ms (the
    // input the JS Date constructor accepts). If the field is the
    // UUTC_NO_ENTRY sentinel (0x8000000000000000) it'll appear as a
    // very large negative number after Number() conversion — we treat
    // that as "no time" and emit null.
    let recording_start_iso = null;
    const startUUTC = channelMeta[0].universal_header.start_time;
    // UUTC_NO_ENTRY = 0x8000000000000000 = INT64_MIN ≈ -9.22e18 after
    // BigInt → Number conversion. Plausible recording times sit well
    // above zero (post-1970) and below ~2e15 μs (year 2033 or so).
    if (Number.isFinite(startUUTC) && startUUTC > 0 && startUUTC < 1e18) {
      const ms = startUUTC / 1000;
      const d = new Date(ms);
      if (!isNaN(d.getTime())) recording_start_iso = d.toISOString();
    }

    async function readWindow(_startSample, _nWin) {
      // Tier 1: the universal header parser knows what the file CONTAINS
      // but the RED decoder isn't shipped, so we cannot return samples.
      // The viewer surfaces this error as a "format unsupported" overlay,
      // which is more useful than a silent black render.
      throw new Error(
        'mef.readWindow: MEF3 RED decompression is not implemented — ' +
        'this reader can surface the recording structure (channels, ' +
        'sample rate, duration) but cannot decode samples. Real-world ' +
        'EEGDash datasets are not MEF3; this reader is a stub for users ' +
        'who drag .mefd/ bundles into the viewer.',
      );
    }

    return {
      n_channels,
      sampling_frequency:  sfreq0,
      n_samples:           nsamp0,
      duration_s:          nsamp0 / sfreq0,
      channel_labels,
      channel_types:       new Array(n_channels).fill('ieeg'),
      bytes_per_sample:    4,         // RED decodes to si4 internally
      recording_start_iso,
      annotation_events:   [],        // .rdat record files not yet parsed
      bad_channels:        [],
      // Surface a small subset of the parsed header for tests + debug
      // overlays. Not part of the canonical reader API.
      _mef: {
        tier:              1,
        channels:          channelMeta.map((m, idx) => ({
          name:                m.universal_header.channel_name || ('Ch' + (idx + 1)),
          segment_number:      m.universal_header.segment_number,
          n_blocks:            m.n_blocks,
          maximum_block_bytes: m.maximum_block_bytes,
          mef_version:         `${m.universal_header.mef_version_major}.${m.universal_header.mef_version_minor}`,
        })),
      },
      readWindow,
    };
  };

  // ---- helpers -----------------------------------------------------

  /**
   * Discover the .timd/ channel sub-directories of a .mefd/ bundle and
   * resolve the .tmet/.tdat/.tidx URL triples for each one. Uses an
   * HttpRange.listDir hook if available; falls back to throwing because
   * directory listing isn't part of the generic Range interface.
   *
   * Production wires this through a controller-supplied manifest. Tests
   * install their own listDir on the local HttpRange shim.
   *
   * @param {string} sessionUrl
   * @param {object} HttpRange
   * @returns {Promise<Array<{ tmet: string, tdat: string, tidx: string, channel_dir: string }>>}
   */
  async function listSegmentsFromDirectory(sessionUrl, HttpRange) {
    if (typeof HttpRange.listDir !== 'function') {
      throw new Error(
        'mef.open: HttpRange.listDir is not available — pass meta.segment_urls ' +
        'with pre-resolved {.tmet, .tdat, .tidx} triples',
      );
    }

    // Normalise trailing slash so URL string arithmetic works.
    const sessionDir = sessionUrl.endsWith('/') ? sessionUrl : (sessionUrl + '/');
    const sessionEntries = await HttpRange.listDir(sessionDir);
    if (!Array.isArray(sessionEntries)) {
      throw new Error(`mef.open: listDir(${sessionDir}) did not return an array`);
    }
    // Each .timd/ entry contains exactly one segment in the continuous-
    // single-segment case we support. Sort the channels by name so the
    // reader yields a stable channel order (the order on disk is
    // filesystem-dependent and unspecified by the MEF3 spec).
    const channelDirs = sessionEntries
      .filter((name) => /\.timd\/?$/.test(name))
      .map((name) => name.replace(/\/$/, ''))
      .sort();

    const triples = [];
    for (const chName of channelDirs) {
      const chDir = sessionDir + chName + '/';
      const chEntries = await HttpRange.listDir(chDir);
      if (!Array.isArray(chEntries)) {
        throw new Error(`mef.open: listDir(${chDir}) did not return an array`);
      }
      // Find one matching trio. We accept only the first segment found
      // (initial scope: single-segment recordings).
      const tmet = chEntries.find((n) => /\.tmet$/.test(n));
      const tdat = chEntries.find((n) => /\.tdat$/.test(n));
      const tidx = chEntries.find((n) => /\.tidx$/.test(n));
      if (!tmet || !tdat || !tidx) {
        throw new Error(
          `mef.open: channel ${chName} is missing one of {.tmet, .tdat, .tidx} in ${chDir} ` +
          `(found tmet=${tmet || '-'}, tdat=${tdat || '-'}, tidx=${tidx || '-'})`,
        );
      }
      triples.push({
        channel_dir: chDir,
        tmet: chDir + tmet,
        tdat: chDir + tdat,
        tidx: chDir + tidx,
      });
    }
    return triples;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.MefReader = api;
})();
