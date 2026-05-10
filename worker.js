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
  'formats/_streaming.js',
  'formats/_sidecar.js',
  'formats/_matv5.js',
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

// Perf: raw (unfiltered) window cache, keyed by `${start}-${n}`. The
// viewer's main-thread cache holds FILTERED Float32Arrays (their bytes
// are transferred to the main thread, zero-copy, so the worker doesn't
// keep them anyway). When a filter toggles, the viewer dumps its
// filtered cache and re-asks for the same windows; without this raw
// cache, that means a 700 ms S3 round-trip per re-ask. With it, the
// worker re-applies the new filter chain to in-memory bytes (~30 ms).
//
// Bounded LRU; size matches the viewer's cache (READ_CACHE_MAX = 6) so
// no extra retention beyond what the viewer is already asking for.
const RAW_CACHE_MAX = 6;
const rawCache = new Map();   // "start-n" → Float32Array[] (one per channel)
function rawCachePut(key, channels) {
  // Deep-copy into owned buffers — the reader returns subarrays of a
  // shared backing buffer that may be reused on the next readWindow.
  const owned = channels.map(ch => {
    const a = new Float32Array(ch.length);
    a.set(ch);
    return a;
  });
  rawCache.set(key, owned);
  while (rawCache.size > RAW_CACHE_MAX) {
    rawCache.delete(rawCache.keys().next().value);
  }
}

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
        // Reset filter chain + raw cache on new file load (fs may differ).
        activeFilterCoefs = [];
        rawCache.clear();
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
        const cacheKey = `${start_sample}-${n_samples}`;
        let rawChannels = rawCache.get(cacheKey);
        if (!rawChannels) {
          // Cache miss — pay the S3 round-trip, then store the raw
          // (unfiltered) buffers so subsequent filter changes can
          // re-filter without re-fetching.
          const fresh = await reader.readWindow(start_sample, n_samples);
          rawCachePut(cacheKey, fresh);
          rawChannels = rawCache.get(cacheKey);
        }
        // Apply current filter chain to a fresh OUTPUT buffer per
        // channel — never mutate the cached raw. Each output buffer
        // is owned + transferable.
        const owned = rawChannels.map(rawCh => {
          if (activeFilterCoefs.length > 0) {
            return globalThis.Filters.applyChain(rawCh, activeFilterCoefs);
          }
          const a = new Float32Array(rawCh.length);
          a.set(rawCh);
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

      // 1C: Streaming window fetch.
      // When filter chain is active, streaming is unsafe (filtfilt needs full signal):
      // collect all chunks, apply filter, then send ONE final WINDOW_CHUNK with partial:false.
      // When no filter: stream chunks as they arrive (partial:true), then final (partial:false).
      // Also populates rawCache so subsequent non-streaming FETCH_WINDOW hits are cache hits.
      case 'FETCH_WINDOW_STREAM': {
        const { start_sample, n_samples, request_id } = msg;
        if (!reader) {
          self.postMessage({ type: 'ERROR', request_id, message: 'No reader loaded' });
          return;
        }

        // If no streaming method available, fall back to non-streaming
        if (!reader.readWindowStreaming) {
          const cacheKey = `${start_sample}-${n_samples}`;
          let rawChannels = rawCache.get(cacheKey);
          if (!rawChannels) {
            const fresh = await reader.readWindow(start_sample, n_samples);
            rawCachePut(cacheKey, fresh);
            rawChannels = rawCache.get(cacheKey);
          }
          const owned = rawChannels.map(rawCh => {
            if (activeFilterCoefs.length > 0) {
              return globalThis.Filters.applyChain(rawCh, activeFilterCoefs);
            }
            const a = new Float32Array(rawCh.length);
            a.set(rawCh);
            return a;
          });
          self.postMessage(
            { type: 'WINDOW_CHUNK', request_id, partial: false,
              sample_start: start_sample, sample_end: start_sample + owned[0].length - 1,
              channels: owned },
            owned.map(a => a.buffer),
          );
          return;
        }

        const cacheKey = `${start_sample}-${n_samples}`;

        // Check rawCache — if already populated, no streaming needed
        const cachedRaw = rawCache.get(cacheKey);
        if (cachedRaw) {
          const owned = cachedRaw.map(rawCh => {
            if (activeFilterCoefs.length > 0) {
              return globalThis.Filters.applyChain(rawCh, activeFilterCoefs);
            }
            const a = new Float32Array(rawCh.length);
            a.set(rawCh);
            return a;
          });
          self.postMessage(
            { type: 'WINDOW_CHUNK', request_id, partial: false,
              sample_start: start_sample, sample_end: start_sample + owned[0].length - 1,
              channels: owned },
            owned.map(a => a.buffer),
          );
          return;
        }

        const hasFilter = activeFilterCoefs.length > 0;

        if (hasFilter) {
          // Filter is active: collect all chunks, then apply filter and send single final chunk.
          // rawCache assembly: accumulate into a single buffer per channel.
          let assembledChannels = null;
          let totalSamples = 0;
          for await (const chunk of reader.readWindowStreaming(start_sample, n_samples)) {
            if (!assembledChannels) {
              assembledChannels = chunk.channels.map(ch => {
                const a = new Float32Array(n_samples);
                a.set(ch, 0);
                return a;
              });
              totalSamples = chunk.channels[0].length;
            } else {
              for (let c = 0; c < assembledChannels.length; c++) {
                assembledChannels[c].set(chunk.channels[c], totalSamples);
              }
              totalSamples += chunk.channels[0].length;
            }
          }
          if (!assembledChannels) return;
          // Trim to actual samples received
          const trimmed = assembledChannels.map(ch => ch.subarray(0, totalSamples));
          rawCachePut(cacheKey, trimmed);
          const filtered = trimmed.map(rawCh => globalThis.Filters.applyChain(rawCh, activeFilterCoefs));
          const ownedFiltered = filtered.map(ch => {
            const a = new Float32Array(ch.length);
            a.set(ch);
            return a;
          });
          self.postMessage(
            { type: 'WINDOW_CHUNK', request_id, partial: false,
              sample_start: start_sample, sample_end: start_sample + ownedFiltered[0].length - 1,
              channels: ownedFiltered },
            ownedFiltered.map(a => a.buffer),
          );
        } else {
          // No filter: stream chunks as they arrive, each as partial:true WINDOW_CHUNK.
          // Assemble into rawCache simultaneously (deep copy each chunk).
          let assembledChannels = null;
          let totalSamples = 0;
          for await (const chunk of reader.readWindowStreaming(start_sample, n_samples)) {
            const chunkLen = chunk.channels[0].length;
            if (!assembledChannels) {
              assembledChannels = chunk.channels.map(() => new Float32Array(n_samples));
            }
            for (let c = 0; c < assembledChannels.length; c++) {
              assembledChannels[c].set(chunk.channels[c], totalSamples);
            }
            totalSamples += chunkLen;

            // Send partial chunk (transferable — transfer ownership; assembledChannels
            // keeps its own copy so we can't transfer from that; must copy for transfer)
            const transferable = chunk.channels.map(ch => {
              const a = new Float32Array(ch.length);
              a.set(ch);
              return a;
            });
            self.postMessage(
              { type: 'WINDOW_CHUNK', request_id, partial: true,
                sample_start: chunk.firstSampleIdx, sample_end: chunk.lastSampleIdx,
                channels: transferable },
              transferable.map(a => a.buffer),
            );
          }

          if (!assembledChannels) return;
          // Populate rawCache with complete assembled buffer
          const trimmed = assembledChannels.map(ch => ch.subarray(0, totalSamples));
          rawCachePut(cacheKey, trimmed);

          // Send final chunk (assembled full window, no filter)
          const ownedFinal = trimmed.map(ch => {
            const a = new Float32Array(ch.length);
            a.set(ch);
            return a;
          });
          self.postMessage(
            { type: 'WINDOW_CHUNK', request_id, partial: false,
              sample_start: start_sample, sample_end: start_sample + ownedFinal[0].length - 1,
              channels: ownedFinal },
            ownedFinal.map(a => a.buffer),
          );
        }
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
