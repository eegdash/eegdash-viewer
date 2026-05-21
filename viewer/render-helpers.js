/* ============================================================
   viewer/render-helpers.js — pure helpers that shape the data
   the TraceRenderer expects, extracted from viewer.js so the
   render-pipeline body stays under the readability threshold.
   (Lane F2.)

   Every helper here is pure: it reads from a deps object the
   caller constructs and returns a fresh value. No closures over
   viewer.js state. Tests can call these directly with a
   synthetic deps payload.
   ============================================================ */
'use strict';
(function () {
  // Build the drawOpts payload for TraceRenderer.draw().
  //
  // Inputs:
  //   channels      — Float32Array[] (already trimmed to visible window)
  //   startSample   — sample offset (start of the visible window)
  //   fs            — sampling frequency in Hz
  //   deps          — read-only references the caller closes over:
  //     metaChannels, typeColors, channelLabels, channelBadMask,
  //     metaEvents, view (start_sec/window_sec/gain/time_mode/
  //     channel_offset), readerInfo, isEmbedMode
  //
  // Output: plain object ready to pass into TraceRenderer.draw().
  function buildDrawOpts(channels, startSample, fs, deps) {
    const {
      metaChannels, typeColors, channelLabels, channelBadMask, metaEvents,
      view, readerInfo, isEmbedMode,
    } = deps;
    const channelColors = metaChannels && metaChannels.length
      ? metaChannels.map(ch => typeColors[(ch.type || 'MISC').toUpperCase()] || null)
      : null;
    return {
      channels,
      n_samples_visible: channels[0]?.length || 0,
      channel_labels: channelLabels,
      channel_types: metaChannels ? metaChannels.map(ch => (ch.type || '').toUpperCase()) : null,
      bad_mask: channelBadMask,
      channel_colors: channelColors,
      channel_offset: view.channel_offset,
      events: metaEvents,
      fs,
      start_sec: startSample / fs,
      gain: view.gain,
      time_mode: view.time_mode,
      recording_start_iso: readerInfo ? (readerInfo.recording_start_iso ?? null) : null,
      transparent: isEmbedMode,
    };
  }

  const api = { buildDrawOpts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.ViewerRenderHelpers = api;
})();
