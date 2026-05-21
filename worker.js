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
  // MAT v7.3 (HDF5) support for modern EEGLAB .set files. _jsfive
  // is the vendored 207 KB IIFE bundle of jsfive that attaches
  // `globalThis.hdf5`; _mat73 patches its DataObjects prototype for
  // compact storage and exposes `Mat73.parse` mirroring _matv5's
  // surface. Both load before bids-recording.js so the eeglab
  // reader's v5/v7.3 dispatch sees them.
  'formats/_jsfive.js',
  'formats/_mat73.js',
  'bids-recording.js',
  'formats/eeglab.js',
  'formats/edf.js',
  'formats/brainvision.js',
  // Tag-directory walker — must load BEFORE fiff.js because the range-
  // based api.open reaches through globalThis.FiffDir.
  'formats/_fiff-dir.js',
  'formats/fiff.js',
  'formats/_ctf-res4.js',
  'formats/_ctf-marker.js',
  'formats/ctf.js',
  // SNIRF (HDF5) fNIRS reader. Depends on _jsfive loaded above (same
  // engine used for the MAT v7.3 EEGLAB path).
  'formats/snirf.js',
  'filters.js',
);

const READERS = {
  set:   globalThis.EEGLABReader,
  edf:   globalThis.EDFReader,
  bdf:   globalThis.EDFReader,
  vhdr:  globalThis.BrainVisionReader,
  fif:   globalThis.FiffReader,
  fiff:  globalThis.FiffReader,
  ds:    globalThis.CTFReader,
  snirf: globalThis.SnirfReader,
};

let reader = null;
// Monotonic counter bumped on every LOAD_FILE. Long-running fetches
// (especially streaming) capture the epoch at entry and bail at every
// await/iterator boundary if the epoch changed — protects against
// the recording-switch race where reader A's window samples would
// otherwise get rawCachePut into reader B's cache, corrupting
// subsequent reads. (Worker sleuth finding 2.)
let currentReaderEpoch = 0;

// F08: Active filter chain — array of biquad coefficient objects.
// Each entry: { kind, cutoff_hz, coefs: {b, a} }
// Updated on APPLY_FILTER messages; applied to each channel in FETCH_WINDOW.
let activeFilterCoefs = [];

// Cancellation registry for in-flight FETCH_WINDOW(_STREAM) requests.
// The viewer can send `{ type: 'CANCEL_REQUEST', request_id }` to mark a
// request as abandoned. Long-running streams check between iterator steps
// and bail without further postMessage. Saves bandwidth + main-thread
// message overhead during rapid panning. Bounded with FIFO eviction to
// prevent unbounded growth — matches the viewer-side `trackCancelled`
// pattern. (Worker sleuth finding 5.)
const cancelledRequestIds = new Set();
const MAX_CANCELLED_REQUEST_IDS = 256;
function markRequestCancelled(id) {
  cancelledRequestIds.add(id);
  while (cancelledRequestIds.size > MAX_CANCELLED_REQUEST_IDS) {
    const oldest = cancelledRequestIds.values().next().value;
    cancelledRequestIds.delete(oldest);
  }
}
function isRequestCancelled(id) {
  return cancelledRequestIds.has(id);
}

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
// MRU-on-hit is enforced via rawCacheGet (Map.get alone preserves
// insertion order — without the explicit promote, eviction is FIFO).
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
  // delete-then-set so an existing key is bumped to the MRU end.
  rawCache.delete(key);
  rawCache.set(key, owned);
  while (rawCache.size > RAW_CACHE_MAX) {
    rawCache.delete(rawCache.keys().next().value);
  }
}
function rawCacheGet(key) {
  const v = rawCache.get(key);
  if (v === undefined) return undefined;
  // Promote to MRU: re-insert so insertion-order-based eviction picks
  // the genuinely-oldest key, not the oldest-loaded-but-recently-used.
  rawCache.delete(key);
  rawCache.set(key, v);
  return v;
}

// In-flight dedup. Two concurrent FETCH_WINDOW(_STREAM) for the same
// cacheKey would otherwise each pay the full S3 round-trip and race
// to write the cache. Cache the promise; the second caller awaits it
// and gets the same buffers. Cleared on file load.
const inflightRawFetches = new Map();   // cacheKey → Promise<channels[]>
function awaitInflight(cacheKey, fetchFn) {
  let p = inflightRawFetches.get(cacheKey);
  if (p) return p;
  p = (async () => {
    try {
      const fresh = await fetchFn();
      rawCachePut(cacheKey, fresh);
      return rawCacheGet(cacheKey);
    } finally {
      inflightRawFetches.delete(cacheKey);
    }
  })();
  inflightRawFetches.set(cacheKey, p);
  return p;
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
        inflightRawFetches.clear();
        // Bump the epoch so any in-flight FETCH_WINDOW(_STREAM) from
        // the previous recording bails before writing into the new
        // recording's cache. (Worker sleuth finding 2.)
        currentReaderEpoch++;
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
        // Same epoch + filter snapshot pattern as FETCH_WINDOW_STREAM
        // (Worker sleuth findings 1 + 2). Even though FETCH_WINDOW has
        // only one await, that's enough for APPLY_FILTER or LOAD_FILE
        // to land between request and response.
        const epoch = currentReaderEpoch;
        const localReader = reader;
        const filterSnapshot = activeFilterCoefs.slice();

        const cacheKey = `${start_sample}-${n_samples}`;
        // awaitInflight handles cache hit, dedupes concurrent misses,
        // and on miss pays the S3 round-trip + populates the cache.
        const rawChannels = rawCacheGet(cacheKey)
          ?? await awaitInflight(cacheKey,
                                  () => localReader.readWindow(start_sample, n_samples));
        if (epoch !== currentReaderEpoch) return;  // recording switched; drop
        if (isRequestCancelled(request_id)) return;  // viewer cancelled — bail
        // Apply the snapshot filter chain to a fresh OUTPUT buffer per
        // channel — never mutate the cached raw. Each output buffer
        // is owned + transferable.
        const owned = rawChannels.map(rawCh => {
          if (filterSnapshot.length > 0) {
            return globalThis.Filters.applyChain(rawCh, filterSnapshot);
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

      // Viewer-initiated cancellation. Marks the request as cancelled so
      // any in-flight FETCH_WINDOW(_STREAM) loop body checking
      // isRequestCancelled() bails before paying further bandwidth +
      // postMessage cost. The viewer's main-thread cancelledRequests
      // already drops responses for cancelled IDs, but without this the
      // worker happily streams the full window for an abandoned request.
      // (Worker sleuth finding 5.)
      case 'CANCEL_REQUEST': {
        if (typeof msg.request_id !== 'undefined') {
          markRequestCancelled(msg.request_id);
          // Echo back so the viewer can immediately drop the pendingRequest
          // entry and free any associated state (callback closures, etc.).
          self.postMessage({ type: 'CANCELLED', request_id: msg.request_id });
        }
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
        // Capture epoch + filter chain at entry. Any APPLY_FILTER /
        // LOAD_FILE that arrives between awaits below MUST NOT change
        // what this stream sends — the viewer's request_id contract is
        // "the answer to the question the user asked at the moment they
        // asked it". (Worker sleuth findings 1 + 2.)
        const epoch = currentReaderEpoch;
        const localReader = reader;
        const filterSnapshot = activeFilterCoefs.slice();
        const isStillCurrent = () => epoch === currentReaderEpoch;

        // If no streaming method available, fall back to non-streaming
        if (!localReader.readWindowStreaming) {
          const cacheKey = `${start_sample}-${n_samples}`;
          const rawChannels = rawCacheGet(cacheKey)
            ?? await awaitInflight(cacheKey,
                                    () => localReader.readWindow(start_sample, n_samples));
          if (!isStillCurrent()) return;  // recording switched mid-fetch — drop result
          if (isRequestCancelled(request_id)) return;  // viewer cancelled — bail before paint
          const owned = rawChannels.map(rawCh => {
            if (filterSnapshot.length > 0) {
              return globalThis.Filters.applyChain(rawCh, filterSnapshot);
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

        // Helper: send a single non-streaming reply from cached raw,
        // applying any active filters first. Used by both the cache-
        // hit branch and the dedup branch (when another concurrent
        // request is already streaming this window).
        const sendFinalFromRaw = (raw) => {
          // Guard against the resolveInflight([]) / null edge case where
          // the upstream stream yielded nothing. Either send an ERROR or
          // a zero-length WINDOW_CHUNK; sending an error is the more
          // useful signal because the main thread already handles ERROR
          // messages cleanly. (Worker sleuth finding 4.)
          if (!raw || raw.length === 0 || !raw[0] || raw[0].length === 0) {
            self.postMessage({ type: 'ERROR', request_id,
              message: 'fetch returned no data (end-of-recording or aborted)' });
            return;
          }
          const owned = raw.map(rawCh => {
            if (filterSnapshot.length > 0) {
              return globalThis.Filters.applyChain(rawCh, filterSnapshot);
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
        };

        // Cache hit — no streaming needed.
        const cachedRaw = rawCacheGet(cacheKey);
        if (cachedRaw) { sendFinalFromRaw(cachedRaw); return; }

        // Dedup: if another concurrent request is already streaming
        // this same window, await its assembled buffers and send a
        // single non-streaming reply. We forfeit incremental partials
        // for the duplicate caller, but skip the duplicate S3 cost.
        const inflight = inflightRawFetches.get(cacheKey);
        if (inflight) {
          const rawChannels = await inflight;
          sendFinalFromRaw(rawChannels);
          return;
        }

        const hasFilter = filterSnapshot.length > 0;

        // Register the in-flight assembly promise so concurrent
        // FETCH_WINDOW(_STREAM) for the same key dedup against us.
        // The promise resolves with the cached raw channels once
        // assembly completes; cleanup happens in finally.
        let resolveInflight, rejectInflight;
        const inflightP = new Promise((res, rej) => {
          resolveInflight = res;
          rejectInflight = rej;
        });
        inflightRawFetches.set(cacheKey, inflightP);

        try {
          if (hasFilter) {
            // Filter is active: collect all chunks, then apply filter and send single final chunk.
            // rawCache assembly: accumulate into a single buffer per channel.
            let assembledChannels = null;
            let totalSamples = 0;
            for await (const chunk of localReader.readWindowStreaming(start_sample, n_samples)) {
              if (!isStillCurrent()) { resolveInflight([]); return; }
              if (isRequestCancelled(request_id)) { resolveInflight([]); return; }
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
            if (!assembledChannels) { resolveInflight([]); return; }
            if (!isStillCurrent()) { resolveInflight([]); return; }
            // Trim to actual samples received
            const trimmed = assembledChannels.map(ch => ch.subarray(0, totalSamples));
            rawCachePut(cacheKey, trimmed);
            resolveInflight(rawCacheGet(cacheKey));
            const filtered = trimmed.map(rawCh => globalThis.Filters.applyChain(rawCh, filterSnapshot));
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
            for await (const chunk of localReader.readWindowStreaming(start_sample, n_samples)) {
              if (!isStillCurrent()) { resolveInflight([]); return; }
              if (isRequestCancelled(request_id)) { resolveInflight([]); return; }
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

            if (!assembledChannels) { resolveInflight([]); return; }
            if (!isStillCurrent()) { resolveInflight([]); return; }
            // Populate rawCache with complete assembled buffer
            const trimmed = assembledChannels.map(ch => ch.subarray(0, totalSamples));
            rawCachePut(cacheKey, trimmed);
            resolveInflight(rawCacheGet(cacheKey));

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
        } catch (e) {
          rejectInflight(e);
          throw e;
        } finally {
          inflightRawFetches.delete(cacheKey);
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
