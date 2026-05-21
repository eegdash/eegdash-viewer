/* ============================================================
   formats/ctf.js — minimal CTF MEG reader for eegdash-viewer.

   CTF recordings are *directory bundles*: the user-facing URL is
   `<entities>_meg.ds/`, a directory containing:
     <entities>_meg.res4    big-endian binary header (channels, srate,
                            gains) — parsed by formats/_ctf-res4.js
     <entities>_meg.meg4    big-endian int16 interleaved samples;
                            8-byte "MEG4xCP\0" magic + body
     <entities>_meg.acq     text acquisition metadata (ignored)
     <entities>_meg.hc      text head coordinates (ignored)
     <entities>_meg.hist    text history log (ignored)
     MarkerFile.mrk         text events → annotation_events
     BadChannels            text — one bad channel per line
     ClassFile.cls          text trial classifications (ignored)

   This reader fetches the .res4 + .meg4 over HTTP Range and serves
   windows directly from a cached `.meg4` body (small datasets) or
   range-fetches every readWindow call (large datasets). The cutoff
   is FULL_LOAD_MAX_BYTES below.

   References:
   - MNE-Python  mne/io/ctf/info.py         (CTF info-block assembly)
   - MNE-Python  mne/io/ctf/res4.py         (binary layout source of truth)
   - MNE-Python  mne/io/ctf/eeg.py          (.meg4 read path)
   - MNE-Python  mne/io/ctf/markers.py      (MarkerFile.mrk parsing)
   ============================================================ */
(function () {
  'use strict';

  const api = {};

  // CTF samples are int16 BE; 2 bytes per sample.
  const BYTES_PER_SAMPLE = 2;
  // 8-byte ASCII magic at the head of .meg4 — "MEG41CP\0" or "MEG42CP\0".
  const MEG4_HEADER_BYTES = 8;
  // Above this size we don't pre-fetch the full .meg4 — each readWindow
  // issues its own HTTP range. 64 MiB ≈ 100 channels × 30 minutes @ 1 kHz,
  // which still fits in browser memory but bumping the cutoff would have
  // us greedily holding multi-GB MEG sessions.
  const FULL_LOAD_MAX_BYTES = 64 * 1024 * 1024;

  /**
   * Parse a CTF `.res4` ArrayBuffer into a header object.
   * Synchronous entry point exposed for unit + property tests so the
   * parser can be exercised without network. Production `api.open`
   * calls this internally after HttpRange.fetchBuffer'ing the .res4.
   *
   * @param {ArrayBuffer} buf - the .res4 file as one buffer.
   * @returns {{
   *   no_samples: number, no_channels: number, sample_rate: number,
   *   epoch_time: number, no_trials: number,
   *   channels: Array<{ name: string, sensor_type: number, cal: number,
   *     io_offset: number, proper_gain: number, q_gain: number, io_gain: number }>
   * }}
   * @throws {Error} on any parse failure — never returns null.
   */
  api.read = function (buf) {
    // Delegates to the per-format helper. _ctf-res4.js is loaded into
    // globalThis.CTFRes4 by its own IIFE (in worker.js + index.html).
    if (!globalThis.CTFRes4) {
      throw new Error('ctf.read: globalThis.CTFRes4 missing — load formats/_ctf-res4.js first');
    }
    return globalThis.CTFRes4.parse(buf);
  };

  // api.open lives in Task 6.

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.CTFReader = api;
})();
