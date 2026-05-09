/* ============================================================
   worker.js — Web Worker that owns the active format reader and
   answers FETCH_WINDOW requests from the main thread off-thread
   so pan/zoom no longer jank during large range fetches.

   Message protocol (see docs/eegdrop-features-spec.md § F07/F08):
     main → worker:  { type: 'INIT' }
     worker → main:  { type: 'INIT_OK', formats: ['edf','bdf','set','vhdr'] }
     main → worker:  { type: 'LOAD_FILE', ext, eeg_url, sidecars }
     worker → main:  { type: 'HEADER', n_channels, sampling_frequency,
                        duration_s, channel_labels, bytes_per_sample, n_samples }
     main → worker:  { type: 'FETCH_WINDOW', start_sample, n_samples, request_id }
     worker → main:  { type: 'WINDOW', request_id, channels: Float32Array[] }
     main → worker:  { type: 'APPLY_FILTER', filters: [{kind, cutoff_hz, order?},...] }
     worker → main:  { type: 'FILTERED', filter_id }
     worker → main:  { type: 'ERROR', request_id?, message }

   importScripts loads the same IIFE modules used by the main page.
   Each IIFE attaches its API to globalThis (which is the worker's
   global), so ChannelBuffers, HttpRange, etc. are available without
   any module-system changes.
   ============================================================ */
'use strict';

importScripts(
  'formats/_buffers.js',
  'formats/_http_range.js',
  'formats/_sidecar.js',
  'bids-recording.js',
  'formats/eeglab.js',
  'formats/edf.js',
  'formats/brainvision.js',
  'filters.js',
);

const READERS = {
  set:  globalThis.EEGLABReader,
  edf:  globalThis.EDFReader,
  bdf:  globalThis.EDFReader,
  vhdr: globalThis.BrainVisionReader,
};

let reader = null;

// F08: Active filter chain — array of biquad coefficient objects.
// Each entry: { kind, cutoff_hz, coefs: {b, a} }
// Updated on APPLY_FILTER messages; applied to each channel in FETCH_WINDOW.
let activeFilterCoefs = [];

// Build a biquad coef object from a filter spec descriptor.
// Called when APPLY_FILTER arrives; fs comes from the current reader.
function buildCoefs(spec, fs) {
  switch (spec.kind) {
    case 'highpass':
      return globalThis.Filters.designHighpass(fs, spec.cutoff_hz, spec.order);
    case 'lowpass':
      return globalThis.Filters.designLowpass(fs, spec.cutoff_hz, spec.order);
    case 'notch':
      return globalThis.Filters.designNotch(fs, spec.cutoff_hz, spec.q);
    default:
      return null;
  }
}

// bids-recording.js loads correctly in the worker (it only accesses
// globalThis.HttpRange which is now available after the importScripts
// above), but we pass the full metadata bundle via LOAD_FILE instead
// of re-running the BIDS sidecar walk in the worker, so we don't
// need to call BIDSRecording.loadRecordingMetadata here.

self.onmessage = async function (evt) {
  const msg = evt.data;
  if (!msg || !msg.type) return;

  try {
    switch (msg.type) {

      case 'INIT': {
        self.postMessage({
          type: 'INIT_OK',
          formats: Object.keys(READERS),
        });
        break;
      }

      case 'LOAD_FILE': {
        const { ext, eeg_url, sidecars } = msg;
        const readerModule = READERS[ext];
        if (!readerModule) {
          self.postMessage({
            type: 'ERROR',
            message: `No reader for *.${ext} (supported: ${Object.keys(READERS).join(', ')})`,
          });
          return;
        }
        // sidecars is the serialised meta object from BIDSRecording.loadRecordingMetadata
        // (already fetched on the main thread); pass it straight into open().
        reader = await readerModule.open(sidecars);
        // Reset filter chain on new file load (fs may differ).
        activeFilterCoefs = [];
        self.postMessage({
          type: 'HEADER',
          n_channels:          reader.n_channels,
          sampling_frequency:  reader.sampling_frequency,
          duration_s:          reader.duration_s,
          channel_labels:      reader.channel_labels || null,
          bytes_per_sample:    reader.bytes_per_sample,
          n_samples:           reader.n_samples,
          recording_start_iso: reader.recording_start_iso ?? null,
          annotation_events:   reader.annotation_events || null,
        });
        break;
      }

      case 'FETCH_WINDOW': {
        const { start_sample, n_samples, request_id } = msg;
        if (!reader) {
          self.postMessage({ type: 'ERROR', request_id, message: 'No reader loaded' });
          return;
        }
        const channels = await reader.readWindow(start_sample, n_samples);
        // Transfer the underlying ArrayBuffers for zero-copy IPC.
        // Each channel is a Float32Array subarray of a shared backing
        // buffer in ChannelBuffers.alloc — we need to copy to owned
        // buffers so they can be transferred.
        const owned = channels.map(ch => {
          // Apply active filter chain (filtfilt per stage) if any.
          if (activeFilterCoefs.length > 0) {
            return globalThis.Filters.applyChain(ch, activeFilterCoefs);
          }
          const a = new Float32Array(ch.length);
          a.set(ch);
          return a;
        });
        self.postMessage(
          { type: 'WINDOW', request_id, channels: owned },
          owned.map(a => a.buffer),
        );
        break;
      }

      // F08: install a new filter chain. Subsequent FETCH_WINDOW responses
      // will apply the chain via Filters.applyChain (filtfilt per stage).
      case 'APPLY_FILTER': {
        const specs = msg.filters || [];
        const fs = reader ? reader.sampling_frequency : 250;
        activeFilterCoefs = specs
          .map(s => buildCoefs(s, fs))
          .filter(Boolean);
        // Acknowledge so the main thread knows the chain is installed.
        // Subsequent WINDOWs will carry filtered data.
        self.postMessage({ type: 'FILTERED', filter_id: specs.map(s => s.kind).join('+') });
        break;
      }

      default:
        // Unknown message type — ignore silently.
        break;
    }
  } catch (err) {
    self.postMessage({
      type: 'ERROR',
      request_id: msg.request_id ?? null,
      message: err && err.message ? err.message : String(err),
    });
  }
};
