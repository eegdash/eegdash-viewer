/* ============================================================
   formats/_buffers.js — per-pan channel buffer allocation shared
   by every format reader. The two helpers exist so the renderer
   can subscript per-channel typed arrays without copying, and
   we get one Float32Array allocation per pan instead of one per
   channel.
   ============================================================ */
(function () {
  'use strict';

  function empty(nChannels) {
    return Array.from({ length: nChannels }, () => new Float32Array(0));
  }

  // Returns N typed-array views over a single backing buffer.
  // Mutating any view writes through to `backing`, so the renderer
  // must treat each view as owned for the duration of the pan.
  function alloc(nChannels, nWin) {
    const backing = new Float32Array(nChannels * nWin);
    const out = new Array(nChannels);
    for (let c = 0; c < nChannels; c++) {
      out[c] = backing.subarray(c * nWin, (c + 1) * nWin);
    }
    return out;
  }

  const api = { empty, alloc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.ChannelBuffers = api;
})();
