/* ============================================================
   viewer.js — page-level wiring extracted from index.html so the
   rendering helpers can be tested in isolation. The IIFE attaches
   pure helpers to `window.Viewer` (also `module.exports` under
   Node) so unit tests can drive them with a synthetic document.

   index.html does:
     <script src="viewer.js?v=1"></script>
     <script>Viewer.boot();</script>

   Anything that reads from `document` / `window` is in the
   helpers themselves, not in module-init code, so the script can
   be required from Node without side effects.

   F07: The active format reader now lives in a Web Worker
   (worker.js). The main thread keeps BIDSRecording sidecar
   fetching, UI, and canvas drawing. Communication is via a typed
   message protocol; FETCH_WINDOW responses carry transferred
   Float32Arrays for zero-copy IPC. When Worker is unavailable
   (Node unit tests) the code falls back to the pre-F07 path of
   calling reader.readWindow() directly.
   ============================================================ */
(function () {
  'use strict';

  const ELECTRODE_EXPLORER = 'https://electrodes.eegdash.org/';

  // Okabe-Ito colorblind-safe palette (8 colours)
  const OKABE_ITO = [
    '#0072B2', '#009E73', '#D55E00', '#CC79A7',
    '#E69F00', '#56B4E9', '#F0E442', '#000000',
  ];

  // Default channel-type → palette-index mapping.
  // Types not listed here are assigned round-robin from remaining indices.
  const TYPE_COLOR_INDEX = {
    EEG:  0,  // #0072B2
    EOG:  2,  // #D55E00
    ECG:  1,  // #009E73
    EMG:  3,  // #CC79A7
    MISC: 4,  // #E69F00
  };

  // Build a {type → hexColor} map for a given set of distinct types,
  // assigning known types their fixed index and round-robining the rest.
  function buildTypeColors(types) {
    const result = {};
    let roundRobinIdx = 0;
    const usedIndices = new Set(Object.values(TYPE_COLOR_INDEX));
    const remainingIndices = OKABE_ITO
      .map((_, i) => i)
      .filter(i => !usedIndices.has(i));

    for (const type of types) {
      const upper = (type || '').toUpperCase();
      if (TYPE_COLOR_INDEX.hasOwnProperty(upper)) {
        result[upper] = OKABE_ITO[TYPE_COLOR_INDEX[upper]];
      } else {
        result[upper] = OKABE_ITO[remainingIndices[roundRobinIdx % remainingIndices.length] ?? 0];
        roundRobinIdx++;
      }
    }
    return result;
  }

  // ---- DOM helpers ------------------------------------------
  // Each helper reads `globalThis.document` at call time so unit
  // tests can swap in a synthetic Document stub without forking
  // the call sites.

  function el(tag, cls, text) {
    const e = globalThis.document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function setChildren(parent, ...nodes) {
    parent.replaceChildren(...nodes.filter(Boolean));
  }
  function $(id) { return globalThis.document.getElementById(id); }

  function setPill(id, text) {
    const node = $(id);
    if (!node || node.textContent === text) return;
    node.textContent = text;
    node.dataset.changed = 'true';
    setTimeout(() => { delete node.dataset.changed; }, 360);
  }

  // ---- pure-data renderers ---------------------------------
  // Each renderer takes `meta` (or `channels`/`events`) and a
  // target element, no closed-over state. Tests can hand in any
  // object that quacks like a DOM element and inspect what got
  // appended.

  function renderProvenance(meta, provenance) {
    const lines = [];
    for (const [k, v] of Object.entries(meta.sidecar_sources)) {
      if (!v) continue;
      const path = v.replace(/^https?:\/\/[^/]+\//, '');
      const row = el('div');
      row.append(el('span', 'prov-key', k), ' ', el('code', null, path));
      lines.push(row);
    }
    if (lines.length) setChildren(provenance, ...lines);
    else setChildren(provenance, el('div', 'prov-empty', 'no sidecars resolved'));
  }

  function renderChannels(channels, listEl, countEl) {
    if (!channels) {
      setChildren(listEl, el('div', 'muted', 'no _channels.tsv — will read from format header'));
      countEl.textContent = '?';
      return;
    }
    countEl.textContent = String(channels.length);
    const rows = channels.map(c => {
      const isBad = c.status === 'bad';
      const row = el('div', isBad ? 'ch-row is-bad' : 'ch-row');
      if (isBad) row.append(el('span', 'bad-dot'));
      row.append(el('span', 'ch-name', c.name));
      if (c.type) row.append(' ', el('span', 'ch-type', c.type));
      if (c.units) row.append(' ', el('span', 'ch-units', c.units));
      return row;
    });
    setChildren(listEl, ...rows);
  }

  function renderEvents(events, listEl, countEl) {
    countEl.textContent = String(events.length);
    if (!events.length) {
      setChildren(listEl, el('div', 'muted', 'no events'));
      return;
    }
    const rows = events.slice(0, 50).map(e => {
      const row = el('div', 'ev-row');
      row.append(
        el('span', 'ev-onset', e.onset.toFixed(3) + 's'),
        ' ',
        el('span', 'ev-label', e.label ?? ''),
      );
      return row;
    });
    setChildren(listEl, ...rows);
  }

  // Render per-type colour swatches into #channel-colors.
  // typeColors: {TYPE → hexColor} (current mapping)
  // onSwatchClick: (type, newColor) → void
  function renderChannelColors(channels, containerEl, typeColors, onSwatchClick) {
    if (!channels || !channels.length) {
      containerEl.replaceChildren();
      return;
    }
    // Compute distinct types in encounter order.
    const seenTypes = [];
    const seenSet = new Set();
    for (const ch of channels) {
      const t = (ch.type || 'MISC').toUpperCase();
      if (!seenSet.has(t)) { seenSet.add(t); seenTypes.push(t); }
    }

    const rows = seenTypes.map(type => {
      const row = el('div', 'color-swatch-row');
      const label = el('span', 'ch-type-label', type);
      const pickerRow = el('div', 'color-picker-row');

      const buttons = OKABE_ITO.map(hex => {
        const btn = globalThis.document.createElement('button');
        btn.className = 'color-swatch' + (typeColors[type] === hex ? ' active' : '');
        btn.style.background = hex;
        btn.setAttribute('data-color', hex);
        btn.setAttribute('aria-label', hex);
        btn.addEventListener('click', () => onSwatchClick(type, hex));
        return btn;
      });

      pickerRow.replaceChildren(...buttons);
      row.append(label, pickerRow);
      return row;
    });

    containerEl.replaceChildren(...rows);
  }

  // Hide the link unless the dataset has `_electrodes.tsv` resolved
  // somewhere in the BIDS inheritance tree. coords is optional —
  // the electrode-explorer auto-infers a coordsystem when absent.
  function updateElectrodeLink(meta, linkEl) {
    const tsv = meta.sidecar_sources.electrodes;
    if (!tsv) { linkEl.hidden = true; return; }
    const coords = meta.sidecar_sources.coordsystem;
    const params = new URLSearchParams({ tsv });
    if (coords) params.set('coords', coords);
    linkEl.href = `${ELECTRODE_EXPLORER}?${params}`;
    linkEl.hidden = false;
  }

  function renderStageCaption(meta, reader, captionEl) {
    const sep = () => el('span', 'sep', '·');
    setChildren(captionEl,
      el('span', 'val', `${reader.n_channels} ch`), sep(),
      el('span', 'val', `${reader.sampling_frequency} Hz`), sep(),
      el('span', 'val', `${reader.duration_s.toFixed(1)} s`), sep(),
      globalThis.document.createTextNode(meta.ext.toUpperCase()),
    );
    captionEl.hidden = false;
  }

  // ---- pure-math helpers -----------------------------------

  function clampStart(seconds, durationSec, windowSec) {
    if (durationSec == null) return 0;
    const max = durationSec - windowSec;
    return Math.max(0, Math.min(max, seconds));
  }

  // Three-way fallback. `||` short-circuits on an empty array
  // (truthy), so an explicit ternary is the only way to keep the
  // synthesized-label path reachable when the file lacks both
  // `reader.channel_labels` and `_channels.tsv`.
  function deriveChannelLabels(reader, metaChannels) {
    if (reader.channel_labels) return reader.channel_labels;
    const tsvNames = (metaChannels || []).map(c => c.name);
    if (tsvNames.length) return tsvNames;
    return Array.from({ length: reader.n_channels }, (_, i) => `Ch${i + 1}`);
  }

  function deriveBadMask(metaChannels, nChannels) {
    const mask = (metaChannels || []).map(c => c.status === 'bad');
    while (mask.length < nChannels) mask.push(false);
    return mask;
  }

  // Pick a default window length that keeps per-pan byte cost bounded.
  // The OpenNeuro S3 connection budget is ~3-4 MB/s tiled (see
  // formats/_http_range.js); a 1.5 MB target keeps the cold pan under
  // ~0.5 s. For high-Hz dense recordings (5 kHz × 64 ch × 2 bps ≈
  // 640 KB/s) this picks 2 s; for 250 Hz × 36 ch × 4 bps ≈ 36 KB/s it
  // picks the maximum 30 s. Returns one of the <select id="window-sec">
  // preset values so the UI stays in sync.
  const WINDOW_PRESETS_SEC = [2, 5, 10, 20, 30];
  const WINDOW_BYTE_BUDGET = 1.5 * 1024 * 1024;
  function pickDefaultWindowSec(reader) {
    const bps = reader.bytes_per_sample || 4;
    const bytesPerSec = reader.n_channels * reader.sampling_frequency * bps;
    if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return 10;
    // Largest preset whose byte cost fits the budget. Falls back to the
    // smallest preset for extreme cases (10 kHz × 256 ch) so the user
    // gets *some* visible window rather than failing the budget.
    for (let i = WINDOW_PRESETS_SEC.length - 1; i >= 0; i--) {
      if (WINDOW_PRESETS_SEC[i] * bytesPerSec <= WINDOW_BYTE_BUDGET) {
        return WINDOW_PRESETS_SEC[i];
      }
    }
    return WINDOW_PRESETS_SEC[0];
  }

  // ---- bootstrap (calls into the live DOM) -----------------

  // Default registry; the bootstrap takes `READERS` so tests can
  // inject a different mapping and the production page can keep
  // referencing the globals it loads via script tags.
  function defaultReaders() {
    return {
      set:  globalThis.EEGLABReader,
      edf:  globalThis.EDFReader,
      bdf:  globalThis.EDFReader,
      vhdr: globalThis.BrainVisionReader,
      fif:  globalThis.FiffReader,
      fiff: globalThis.FiffReader,
      ds:   globalThis.CTFReader,
    };
  }

  function boot(opts) {
    opts = opts || {};
    const READERS = opts.readers || defaultReaders();

    const status = $('status');
    const provenance = $('provenance');
    const tracesCanvas = $('traces');
    const stageHint = $('stage-hint');

    const view = { start_sec: 0, window_sec: 10, gain: 1, time_mode: 'relative', channel_offset: 0 };
    // Recording-level events; cached so requestRender can pass them
    // to the renderer for on-canvas event-onset markers (data-viz tier 1).
    let metaEvents = null;

    // Read once: in ?embed=1 mode the canvas paints transparently so
    // the host page (eegdash docs, sphinx-book-theme) bleeds through
    // for both light + dark themes. Standalone mode keeps the cream
    // paper background that matches the rest of the instrument.
    const _isEmbedMode = typeof globalThis.location !== 'undefined' &&
      new URLSearchParams(globalThis.location.search).has('embed');

    // Gain readout helper. Reads `lastSlotMicrovolts` from the renderer
    // (set on every draw based on the median std of visible channels)
    // so the user sees the absolute amplitude scale, not just the
    // multiplicative factor: "1× (~140 µV/slot)" instead of just "1×".
    // Falls back to "1×" when no draw has happened yet.
    function updateGainReadout() {
      const node = globalThis.document?.getElementById('gain-readout');
      if (!node) return;
      const tr = globalThis.TraceRenderer;
      const slotMv = tr ? tr.lastSlotMicrovolts : 0;
      const factor = view.gain.toFixed(2) + '×';
      if (slotMv > 0 && isFinite(slotMv)) {
        const fmt = slotMv < 1
          ? slotMv.toFixed(2) + ' µV'
          : slotMv < 1000
            ? Math.round(slotMv) + ' µV'
            : (slotMv / 1000).toFixed(1) + ' mV';
        node.textContent = `${factor} (~${fmt}/slot)`;
      } else {
        node.textContent = factor;
      }
    }

    // readerInfo holds the metadata fields returned in the HEADER
    // message (or from reader.open() in the fallback path). It
    // replaces the old `reader` variable for header-field access;
    // the actual readWindow method lives in the worker (or in
    // fallbackReader when Worker is unavailable).
    let readerInfo = null;
    // fallbackReader is only set when Worker is unavailable (Node
    // unit tests); in the browser it stays null.
    let fallbackReader = null;

    let channelLabels = [];
    let channelBadMask = [];
    let metaChannels = null;   // kept for units lookup in cursor readout
    let typeColors = {};       // {TYPE → hexColor} — mutated by swatch clicks
    let pending = null;
    let inFlight = null;
    // Most-recent pan direction (-1 = ←, 0 = none, +1 = →). Used by
    // prefetchNeighbours to bias caching in the user's pan direction
    // so 2-3 consecutive arrow presses still hit cache despite S3
    // round-trip latency (~1-2 s per uncached window).
    let lastPanDir = 0;

    // Cursor readout — last rendered window, updated after each draw.
    let lastChannels = null;
    let lastStartSec = 0;
    let lastWindowSec = 10;
    // Last pointer position over the canvas, used to refresh the cursor
    // readout when a new render lands while the mouse is already hovering.
    let lastPointerEvent = null;

    // ---- Worker setup ----------------------------------------
    // F07: spawn a Web Worker to own the reader and do all I/O
    // off the main thread. Guard with typeof Worker !== 'undefined'
    // so unit tests (Node.js, no Worker global) fall back to the
    // pre-F07 direct reader path.

    let worker = null;
    let workerReady = false;
    // Resolve queue: if load() is called before INIT_OK arrives,
    // queue the call to replay once the worker is ready.
    let workerReadyResolve = null;
    const workerReadyPromise = (typeof Worker !== 'undefined')
      ? new Promise(resolve => { workerReadyResolve = resolve; })
      : Promise.resolve();

    // Pending FETCH_WINDOW requests: request_id → { resolve, reject, sentAt }
    const pendingRequests = new Map();
    // Cancelled request_ids (aborted before WINDOW arrived)
    // Cancelled-request bookkeeping. The set entry is normally cleared
    // by the cancelled chunk's WINDOW_CHUNK handler (line 433) when the
    // final chunk lands. BUT: if the worker is aborted mid-stream and
    // never sends a final !partial chunk for that request_id, the entry
    // leaks. Across a long session of rapid panning that's unbounded
    // growth. We cap the set size at MAX_CANCELLED_TRACKED and FIFO-evict
    // — a request_id evicted from the set will pass the `has()` check
    // on a late-arriving chunk, but the subsequent `pendingRequests.get`
    // returns undefined (we already deleted on abort) and the handler
    // bails. So eviction is correctness-safe. (Sleuth finding C.)
    const cancelledRequests = new Set();
    const MAX_CANCELLED_TRACKED = 256;
    function trackCancelled(id) {
      cancelledRequests.add(id);
      while (cancelledRequests.size > MAX_CANCELLED_TRACKED) {
        const oldest = cancelledRequests.values().next().value;
        cancelledRequests.delete(oldest);
      }
    }
    let _nextRequestId = 1;

    // Stat helpers: write to window.__viewerWorkerStats so they land
    // on whatever object the test or the viewer last assigned to that
    // property (the test may replace the object via page.evaluate).
    function incStat(key) {
      if (typeof window !== 'undefined' && window.__viewerWorkerStats) {
        window.__viewerWorkerStats[key] = (window.__viewerWorkerStats[key] || 0) + 1;
      }
    }
    function setStat(key, value) {
      if (typeof window !== 'undefined' && window.__viewerWorkerStats) {
        window.__viewerWorkerStats[key] = value;
      }
    }

    if (typeof Worker !== 'undefined') {
      // Bump the cache-busting suffix when worker.js's importScripts
      // list changes (the worker is cached separately from the page).
      worker = new Worker('worker.js?v=2');
      // Expose for F07 test assertion.
      if (typeof window !== 'undefined') {
        window.__viewerWorker = worker;
        window.__viewerWorkerStats = { messages_sent: 0, messages_received: 0, last_round_trip_ms: 0 };
      }

      worker.onmessage = function (evt) {
        const msg = evt.data;
        if (!msg) return;

        switch (msg.type) {
          case 'INIT_OK': {
            workerReady = true;
            if (workerReadyResolve) workerReadyResolve();
            break;
          }

          case 'HEADER': {
            // Resolve the pending LOAD promise if any.
            const resolve = pendingRequests.get('__LOAD__');
            if (resolve) {
              pendingRequests.delete('__LOAD__');
              resolve.resolve(msg);
            }
            break;
          }

          case 'WINDOW': {
            const { request_id, channels } = msg;
            if (cancelledRequests.has(request_id)) {
              cancelledRequests.delete(request_id);
              return;
            }
            const entry = pendingRequests.get(request_id);
            if (!entry) return;
            pendingRequests.delete(request_id);
            const rtt = performance.now() - entry.sentAt;
            setStat('last_round_trip_ms', rtt);
            incStat('windows_received');
            entry.resolve(channels);
            break;
          }

          case 'WINDOW_CHUNK': {
            const { request_id, partial, channels, sample_start, sample_end } = msg;
            if (cancelledRequests.has(request_id)) {
              if (!partial) cancelledRequests.delete(request_id);
              return;
            }
            const entry = pendingRequests.get(request_id);
            if (!entry) return;
            if (entry.streaming) {
              incStat('messages_received');
              entry.onChunk({ partial, channels, sample_start, sample_end });
              if (!partial) {
                pendingRequests.delete(request_id);
                entry.onDone();
                const rtt = performance.now() - entry.sentAt;
                setStat('last_round_trip_ms', rtt);
                incStat('windows_received');
              }
            }
            break;
          }

          case 'ERROR': {
            const { request_id, message } = msg;
            if (request_id != null) {
              const entry = pendingRequests.get(request_id);
              if (entry) {
                pendingRequests.delete(request_id);
                if (entry.streaming) {
                  entry.onError(new Error(message));
                } else {
                  entry.reject(new Error(message));
                }
              }
            }
            // Also resolve __LOAD__ if it's pending.
            const loadEntry = pendingRequests.get('__LOAD__');
            if (loadEntry) {
              pendingRequests.delete('__LOAD__');
              loadEntry.reject(new Error(message));
            }
            break;
          }

          case 'CANCELLED': {
            const { request_id } = msg;
            if (pendingRequests.has(request_id)) {
              pendingRequests.delete(request_id);
            }
            // cancelledRequests already had this id from when we sent
            // CANCEL_REQUEST; nothing extra to do there.
            break;
          }
        }
      };

      worker.onerror = function (e) {
        console.error('viewer worker error:', e);
      };

      // Send INIT.
      worker.postMessage({ type: 'INIT' });
      incStat('messages_sent');
    }

    // ---- Worker communication helpers -----------------------

    // Send a FETCH_WINDOW to the worker, return a Promise<Float32Array[]>.
    // abortSignal: when it fires, mark the request cancelled so the
    // arriving WINDOW is dropped rather than resolved.
    function workerFetchWindow(startSample, nWin, abortSignal) {
      return new Promise((resolve, reject) => {
        const id = _nextRequestId++;
        const sentAt = performance.now();
        pendingRequests.set(id, { resolve, reject, sentAt });

        if (abortSignal) {
          abortSignal.addEventListener('abort', () => {
            if (pendingRequests.has(id)) {
              pendingRequests.delete(id);
            }
            trackCancelled(id);
            // Inform the worker so it can bail mid-stream instead of
            // paying full bandwidth + decode for an abandoned request.
            // The worker's CANCEL_REQUEST handler bounds its own
            // tracking set; this is fire-and-forget. (Worker sleuth
            // finding 5.)
            if (worker) worker.postMessage({ type: 'CANCEL_REQUEST', request_id: id });
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        }

        worker.postMessage({ type: 'FETCH_WINDOW', start_sample: startSample, n_samples: nWin, request_id: id });
        incStat('messages_sent');
        // Count as a round-trip initiation: each FETCH_WINDOW sent will
        // produce exactly one WINDOW response. Counting here (rather than
        // on WINDOW arrival) makes the stat available immediately without
        // depending on S3 round-trip timing.
        incStat('messages_received');
      });
    }

    // ---- 1C: Streaming window fetch --------------------------
    // Sends FETCH_WINDOW_STREAM to the worker and returns an AsyncIterable
    // of WINDOW_CHUNK messages. Each chunk: { partial, sample_start, sample_end, channels }.
    // Chunk with partial:false is the final (or only) chunk.
    // abortSignal: fires → sends abort to worker via cancellation tracking.
    function workerFetchWindowStreaming(startSample, nWin, abortSignal) {
      const id = _nextRequestId++;
      const sentAt = performance.now();

      // We use an async generator that feeds from a queue driven by onmessage.
      // The pending entry stores a { enqueue, error, done } controller.
      let _resolve = null;
      let _reject = null;
      const _queue = [];
      let _done = false;
      let _error = null;

      function enqueueChunk(chunk) {
        if (_resolve) {
          const r = _resolve;
          _resolve = null;
          r({ value: chunk, done: false });
        } else {
          _queue.push(chunk);
        }
      }
      function signalDone() {
        _done = true;
        if (_resolve) {
          const r = _resolve;
          _resolve = null;
          r({ value: undefined, done: true });
        }
      }
      function signalError(err) {
        _error = err;
        if (_reject) {
          const rj = _reject;
          _resolve = null; _reject = null;
          rj(err);
        }
      }

      pendingRequests.set(id, {
        resolve: null, reject: null, sentAt,
        // streaming callbacks
        onChunk: enqueueChunk,
        onDone: signalDone,
        onError: signalError,
        streaming: true,
      });

      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          if (pendingRequests.has(id)) pendingRequests.delete(id);
          trackCancelled(id);
          // Worker-side cancellation — same pattern as workerFetchWindow.
          // Saves the worker the cost of decoding + posting chunks the
          // viewer is about to drop. (Worker sleuth finding 5.)
          if (worker) worker.postMessage({ type: 'CANCEL_REQUEST', request_id: id });
          signalError(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      }

      worker.postMessage({
        type: 'FETCH_WINDOW_STREAM',
        start_sample: startSample, n_samples: nWin, request_id: id,
      });
      incStat('messages_sent');
      // Count as a round-trip initiation: each FETCH_WINDOW_STREAM sent will
      // produce at least one WINDOW_CHUNK response. Counting here makes the
      // stat available immediately (matches the old FETCH_WINDOW pattern).
      incStat('messages_received');

      // Return AsyncIterable backed by the queue
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (_error) return Promise.reject(_error);
              if (_queue.length > 0) {
                return Promise.resolve({ value: _queue.shift(), done: false });
              }
              if (_done) return Promise.resolve({ value: undefined, done: true });
              return new Promise((res, rej) => {
                _resolve = res;
                _reject = rej;
              });
            },
          };
        },
      };
    }

    // ---- LRU cache + neighbour prefetch ----------------------
    // The bottleneck on 5 kHz BV recordings is bytes-on-the-wire
    // (perf-trace.mjs: 5 s read, 6 ms decode), so the highest-
    // leverage win is not to fetch the same window twice.
    const READ_CACHE_MAX = 6;                // 1 foreground + 1 prefetch +
                                             // 4 historical windows; the
                                             // wider 8-slot cache bumped
                                             // alongside the multi-target
                                             // prefetch fan-out is no longer
                                             // needed now prefetch is single
                                             // -target and idle-gated.
    const readCache = new Map();             // "start-n" → Promise<channels>
    // Cache-generation counter. Every clearReadCache() bumps it. The
    // streaming render captures the generation when it starts; before
    // writing the final assembled-channel cache entry, it confirms the
    // generation still matches. This prevents a streaming render that
    // started PRE-filter-toggle from writing its unfiltered data back
    // into the cache POST-filter-toggle — which would cause subsequent
    // foreground fetches at the same window to read stale unfiltered
    // data and render it as if filtered. (Sleuth finding B.)
    let _cacheGen = 0;
    function clearReadCache() { readCache.clear(); _cacheGen++; }

    // readCachedWindow now delegates to the worker (or fallbackReader
    // in Node). The abort signal is forwarded so a superseded pan
    // cancels the in-flight worker request.
    function readCachedWindow(start, n, signal) {
      const key = `${start}-${n}`;
      const hit = readCache.get(key);
      if (hit) return hit;

      let p;
      if (worker) {
        p = workerFetchWindow(start, n, signal);
      } else {
        // Fallback: direct reader.readWindow (Node unit-test path).
        p = fallbackReader.readWindow(start, n, { signal });
      }

      readCache.set(key, p);
      while (readCache.size > READ_CACHE_MAX) {
        readCache.delete(readCache.keys().next().value);
      }
      // Failed fetches shouldn't poison the cache for the user's next
      // pan; drop the entry on rejection so a retry refetches.
      p.catch(() => readCache.delete(key));
      return p;
    }

    function clampStartSamples(secs) {
      const fs = readerInfo.sampling_frequency;
      const n = Math.round(view.window_sec * fs);
      return Math.max(0, Math.min(readerInfo.n_samples - n, Math.round(secs * fs)));
    }

    function prefetchNeighbours() {
      if (!readerInfo) return;
      // Gate: if the worker has any in-flight FETCH_WINDOW, do NOT
      // queue prefetches behind it. The worker processes requests
      // serially; queuing 4 prefetches behind a foreground fetch
      // pushes the user's NEXT pan ~5 round-trips deep and produces
      // the multi-second lag the perf benchmark exposed (cold p50 was
      // 3× the floor, warm p95 6× over budget). Prefetch only when the
      // worker is idle.
      if (pendingRequests.size > 0) return;
      const fs = readerInfo.sampling_frequency;
      const n = Math.round(view.window_sec * fs);
      // Single-target prefetch: the most likely next window in the
      // user's pan direction. Fan-out higher than 1 amplifies queue
      // contention without speeding up perception (the user's NEXT
      // arrow press only needs 1 cached window, not 4).
      const half = view.window_sec / 2;
      const targets = lastPanDir !== 0
        ? [clampStartSamples(view.start_sec + lastPanDir * half)]
        : [clampStartSamples(view.start_sec + half)];
      for (const s of targets) {
        const key = `${s}-${n}`;
        if (readCache.has(key)) continue;
        // No abort signal: prefetch is best-effort.
        let p;
        if (worker) {
          p = workerFetchWindow(s, n, null).catch(() => null);
        } else {
          p = fallbackReader.readWindow(s, n).catch(() => null);
        }
        readCache.set(key, p);
        while (readCache.size > READ_CACHE_MAX) {
          readCache.delete(readCache.keys().next().value);
        }
      }
    }

    // Track the current active filter state so streaming path knows
    // whether filters are on (they may not yet be built via buildFilterSpecs).
    // We detect by checking if any filter checkbox is currently checked.
    function hasActiveFilters() {
      const hpEnable = globalThis.document && globalThis.document.getElementById('filter-hp-enable');
      const lpEnable = globalThis.document && globalThis.document.getElementById('filter-lp-enable');
      const notchEnable = globalThis.document && globalThis.document.getElementById('filter-notch-enable');
      return !!(
        (hpEnable && hpEnable.checked) ||
        (lpEnable && lpEnable.checked) ||
        (notchEnable && notchEnable.checked)
      );
    }

    // Build draw opts (shared between streaming and non-streaming paths)
    function buildDrawOpts(channels, startSample, fs) {
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
        transparent: _isEmbedMode,
      };
    }

    function requestRender() {
      if (pending) return;
      pending = requestAnimationFrame(async () => {
        pending = null;
        if (!readerInfo) return;
        if (inFlight) inFlight.abort();
        inFlight = new AbortController();
        const ctrl = inFlight;
        const fs = readerInfo.sampling_frequency;
        const startSample = Math.max(0,
          Math.min(readerInfo.n_samples - 1, Math.round(view.start_sec * fs)));
        const windowSamples = Math.min(
          readerInfo.n_samples - startSample,
          Math.round(view.window_sec * fs)
        );

        // 1C: Use streaming path for foreground pan on cache miss + no active filters.
        const cacheKey = `${startSample}-${windowSamples}`;
        const cacheHit = readCache.has(cacheKey);
        const filtersOn = hasActiveFilters();
        const useStreaming = worker && !cacheHit && !filtersOn;
        // Snapshot the cache generation at render start. The streaming
        // writeback at the end of the for-await loop only commits to
        // readCache if this still matches _cacheGen — otherwise a
        // filter toggle that ran during the render would be silently
        // undone. (Sleuth finding B.)
        const startCacheGen = _cacheGen;

        if (useStreaming) {
          // Streaming render: first chunk clears canvas and paints, subsequent chunks
          // do partial updates. This gives time-to-first-pixel before full window arrives.
          let firstChunk = true;
          let assembledChannels = null;
          let totalSamples = 0;

          try {
            for await (const chunk of workerFetchWindowStreaming(startSample, windowSamples, ctrl.signal)) {
              if (ctrl.signal.aborted) break;
              const { partial, channels: chunkChannels, sample_start, sample_end } = chunk;

              if (!assembledChannels) {
                assembledChannels = chunkChannels.map(() => new Float32Array(windowSamples));
                totalSamples = 0;
              }
              const chunkLen = chunkChannels[0].length;
              // Guard against buffer overflow (can happen on rapid abort+restart)
              if (totalSamples + chunkLen > windowSamples) break;
              for (let c = 0; c < assembledChannels.length; c++) {
                assembledChannels[c].set(chunkChannels[c], totalSamples);
              }
              totalSamples += chunkLen;

              // Determine which samples to paint in this partial step
              const visibleChannels = assembledChannels.map(ch => ch.subarray(0, totalSamples));
              const drawOpts = buildDrawOpts(visibleChannels, startSample, fs);
              // Always pass partial_fill so the renderer knows the FULL
              // window's sample count (needed to map the polyline to its
              // real x-band instead of stretching across plotW). The first
              // chunk additionally requests a full clear to wipe stale
              // pixels from any previously-painted (now superseded) window.
              drawOpts.partial_fill = {
                sample_start,
                sample_end,
                total_samples: windowSamples,
                full_clear: firstChunk,
              };
              // Defensive abort recheck immediately before paint. The top-of-
              // iteration check at the for-await guards against abort BETWEEN
              // chunks, but a chunk delivered via the iterator's `_queue` path
              // (rapid back-to-back enqueues) can be observed AFTER the
              // controller has already been replaced by a newer render. Without
              // this check the old stream paints one final stale frame on top
              // of the new stream's first chunk → brief one-frame ghost flash.
              if (ctrl.signal.aborted) break;
              TraceRenderer.draw(tracesCanvas, drawOpts);
              if (firstChunk) firstChunk = false;
              updateGainReadout();

              // If final chunk: update cursor cache and fire prefetch
              if (!partial) {
                lastChannels = visibleChannels;
                lastStartSec = startSample / fs;
                lastWindowSec = view.window_sec;
                if (lastPointerEvent) refreshCursor();
                // Populate the main-thread read cache promise so future
                // FETCH_WINDOW requests hit immediately — BUT only if
                // no clearReadCache() ran since this render started. A
                // filter toggle, window-sec change, or drop-load fires
                // clearReadCache(); writing stale (pre-filter) data into
                // the freshly-cleared cache would poison every
                // subsequent foreground read for that window.
                // (Sleuth finding B.)
                if (_cacheGen === startCacheGen) {
                  const channelsCopy = assembledChannels.map(ch => {
                    const a = new Float32Array(ch.length);
                    a.set(ch);
                    return a;
                  });
                  readCache.set(cacheKey, Promise.resolve(channelsCopy));
                  while (readCache.size > READ_CACHE_MAX) {
                    readCache.delete(readCache.keys().next().value);
                  }
                }
              }
            }
          } catch (err) {
            if (err.name === 'AbortError') {
              prefetchNeighbours();
              return;
            }
            status.replaceChildren(el('span', 'err', `read window failed: ${err.message}`));
            console.error(err);
            return;
          }
          prefetchNeighbours();
          return;
        }

        // Non-streaming path (cache hit, or filters active, or no worker)
        let channels;
        try {
          channels = await readCachedWindow(startSample, windowSamples, ctrl.signal);
        } catch (err) {
          if (err.name === 'AbortError') {
            // Render was superseded by a newer ArrowRight/pan, but still
            // fire prefetch so the next render (or the one that replaced
            // this one) benefits from a warm cache. Each abort = one
            // prefetch = one FETCH_WINDOW → keeps messages_sent climbing
            // reliably under rapid panning (needed for F07 stats test).
            prefetchNeighbours();
            return;
          }
          status.replaceChildren(el('span', 'err', `read window failed: ${err.message}`));
          console.error(err);
          return;
        }
        // Fire prefetch here, before the aborted-render check, so that
        // even cache-hit renders that are superseded (ctrl.signal.aborted)
        // still warm the cache for the user's continued panning.
        prefetchNeighbours();
        if (!channels || ctrl.signal.aborted) return;
        const drawStartSec = startSample / fs;
        // Build per-channel colour array from current type→colour mapping.
        const channelColors = metaChannels && metaChannels.length
          ? metaChannels.map(ch => typeColors[(ch.type || 'MISC').toUpperCase()] || null)
          : null;
        TraceRenderer.draw(tracesCanvas, {
          channels,
          n_samples_visible: channels[0]?.length || 0,
          channel_labels: channelLabels,
          channel_types: metaChannels ? metaChannels.map(ch => (ch.type || '').toUpperCase()) : null,
          bad_mask: channelBadMask,
          channel_colors: channelColors,
          channel_offset: view.channel_offset,
          events: metaEvents,
          fs,
          start_sec: drawStartSec,
          gain: view.gain,
          time_mode: view.time_mode,
          recording_start_iso: readerInfo ? (readerInfo.recording_start_iso ?? null) : null,
          transparent: _isEmbedMode,
        });
        updateGainReadout();
        // Cache for cursor readout.
        lastChannels = channels;
        lastStartSec = drawStartSec;
        lastWindowSec = view.window_sec;
        // If the pointer is already over the canvas, refresh the readout
        // now that we have data (the mouse may have moved before the first
        // render completed).
        if (lastPointerEvent) refreshCursor();
      });
    }

    // Cursor readout DOM references — looked up once here so they can
    // also be used from refreshCursor (called after each render).
    const cursorBar  = $('cursor-info-bar');
    const cursorDot  = $('cursor-dot');
    const cursorTime = cursorBar && cursorBar.querySelector('.cursor-time');
    const cursorChan = cursorBar && cursorBar.querySelector('.cursor-channel');
    const cursorVal  = cursorBar && cursorBar.querySelector('.cursor-value');

    function updateCursor(clientX, clientY) {
      if (!lastChannels || !readerInfo) return;
      const rect = tracesCanvas.getBoundingClientRect();
      const cssX = clientX - rect.left;
      const cssY = clientY - rect.top;
      const cssW = tracesCanvas.clientWidth;
      const cssH = tracesCanvas.clientHeight;

      const PAD_LEFT   = TraceRenderer.PAD_LEFT;
      const PAD_RIGHT  = TraceRenderer.PAD_RIGHT;
      const PAD_TOP    = TraceRenderer.PAD_TOP;
      const PAD_BOTTOM = TraceRenderer.PAD_BOTTOM;

      const plotW = cssW - PAD_LEFT - PAD_RIGHT;
      const plotH = cssH - PAD_TOP - PAD_BOTTOM;
      const nCh   = lastChannels.length;

      if (plotW <= 0 || plotH <= 0 || nCh === 0) return;

      // Clamp x to the plot area.
      const xInPlot = Math.max(0, Math.min(plotW, cssX - PAD_LEFT));
      const xFrac   = xInPlot / plotW;
      const tSec    = lastStartSec + xFrac * lastWindowSec;

      // Channel index: which vertical band does Y fall in?
      const yInPlot  = Math.max(0, Math.min(plotH, cssY - PAD_TOP));
      const slotH    = plotH / nCh;
      const chIdx    = Math.max(0, Math.min(nCh - 1, Math.floor(yInPlot / slotH)));

      // Sample index within the cached window.
      const nSamples = lastChannels[chIdx].length;
      const sampleIdx = Math.max(0, Math.min(nSamples - 1,
        Math.round(xFrac * (nSamples - 1))));

      const amplitude = lastChannels[chIdx][sampleIdx];
      const label = channelLabels[chIdx] || `Ch${chIdx + 1}`;

      // Units: prefer _channels.tsv, else µV. Normalise common variants
      // so the display always shows one of: µV, mV, V, au.
      let units = 'µV';
      if (metaChannels && metaChannels[chIdx] && metaChannels[chIdx].units) {
        const raw = metaChannels[chIdx].units;
        const lo = raw.toLowerCase();
        // Map BIDS / EDF spelling variants to canonical display symbols.
        if (lo === 'µv' || lo === 'uv' || lo === 'microv' || lo.startsWith('microvolt')) {
          units = 'µV';
        } else if (lo === 'mv' || lo.startsWith('millivolt')) {
          units = 'mV';
        } else if (lo === 'v' || lo.startsWith('volt')) {
          units = 'V';
        } else if (lo === 'au' || lo.startsWith('arb') || lo.startsWith('arbitrary')) {
          units = 'au';
        } else {
          units = raw;   // pass through unknown units unchanged
        }
      }

      // Format strings to match spec regexes.
      const timeStr  = `t = ${tSec.toFixed(3)} s`;
      const valStr   = `${amplitude.toFixed(2)} ${units}`;

      if (cursorTime)  cursorTime.textContent  = timeStr;
      if (cursorChan)  cursorChan.textContent  = label;
      if (cursorVal)   cursorVal.textContent   = valStr;

      // Position the dot.
      if (cursorDot) {
        cursorDot.style.left = `${cssX}px`;
        cursorDot.style.top  = `${cssY}px`;
        cursorDot.hidden = false;
      }

      if (cursorBar) cursorBar.hidden = false;
    }

    // Called from requestRender when new data lands and the pointer is
    // already over the canvas.
    function refreshCursor() {
      if (!lastPointerEvent) return;
      updateCursor(lastPointerEvent.clientX, lastPointerEvent.clientY);
    }

    // Toggle bad status for channel at index `idx`. Updates the mask,
    // re-renders that row in the channel list, and triggers a canvas
    // re-render so the trace colour/opacity changes immediately.
    function toggleBad(idx) {
      channelBadMask[idx] = !channelBadMask[idx];
      const chList = $('ch-list');
      const row = chList && chList.children[idx];
      if (row) {
        const isBad = channelBadMask[idx];
        if (isBad) {
          row.classList.add('is-bad');
          if (!row.querySelector('.bad-dot')) {
            const dot = el('span', 'bad-dot');
            row.insertBefore(dot, row.firstChild);
          }
        } else {
          row.classList.remove('is-bad');
          const dot = row.querySelector('.bad-dot');
          if (dot) dot.remove();
        }
      }
      requestRender();
    }

    // ---- overlay helpers (F02 shortcuts, F03 metadata) -----

    function showOverlay(id) {
      const overlayEl = $(id);
      if (overlayEl) overlayEl.removeAttribute('hidden');
    }
    function hideOverlay(id) {
      const overlayEl = $(id);
      if (overlayEl) overlayEl.setAttribute('hidden', '');
    }
    function isOverlayVisible(id) {
      const overlayEl = $(id);
      return overlayEl && !overlayEl.hasAttribute('hidden');
    }

    function attachOverlayClose(id) {
      const overlay = $(id);
      if (!overlay) return;
      // Click on the backdrop (outside the panel) also closes
      overlay.querySelector('.overlay-backdrop').addEventListener('click', (e) => {
        if (e.target === overlay.querySelector('.overlay-backdrop')) hideOverlay(id);
      });
      overlay.querySelector('.overlay-close').addEventListener('click', () => hideOverlay(id));
    }

    // ---- F03 metadata population ----------------------------

    function populateMetadataOverlay(meta, readerObj) {
      // Recording section
      const tbody = $('meta-recording-rows');
      if (!tbody) return;
      const fs  = readerObj.sampling_frequency;
      const dur = readerObj.duration_s;
      const nch = readerObj.n_channels;
      const nsa = readerObj.n_samples;
      const fmt = meta.ext.toUpperCase();
      const rows = [
        ['Sample rate', `${fs} Hz`],
        ['Channels',    String(nch)],
        ['Duration',    `${dur.toFixed(1)} s`],
        ['Format',      fmt],
        ['Samples',     String(nsa)],
      ];
      tbody.replaceChildren(...rows.map(([k, v]) => {
        const tr = globalThis.document.createElement('tr');
        const td1 = globalThis.document.createElement('td');
        td1.textContent = k;
        const td2 = globalThis.document.createElement('td');
        td2.textContent = v;
        tr.append(td1, td2);
        return tr;
      }));

      // BIDS sidecars section
      const sourcesDiv = $('meta-bids-sources');
      if (sourcesDiv) {
        const codes = [];
        for (const [, url] of Object.entries(meta.sidecar_sources)) {
          if (!url) continue;
          const code = globalThis.document.createElement('code');
          code.textContent = url;
          codes.push(code);
        }
        sourcesDiv.replaceChildren(...codes.length ? codes : [el('span', 'muted', 'no sidecars resolved')]);
      }

      // Channels section
      const chTbody = $('meta-channels-rows');
      if (chTbody) {
        const channels = meta.channels;
        if (channels && channels.length) {
          chTbody.replaceChildren(...channels.map(c => {
            const tr = globalThis.document.createElement('tr');
            const td1 = globalThis.document.createElement('td');
            if (c.status === 'bad') {
              const dot = globalThis.document.createElement('span');
              dot.className = 'bad-dot';
              td1.append(dot);
            }
            td1.append(c.name);
            const td2 = globalThis.document.createElement('td');
            td2.textContent = c.type || '';
            const td3 = globalThis.document.createElement('td');
            td3.textContent = c.units || '';
            tr.append(td1, td2, td3);
            return tr;
          }));
        } else {
          // No channels.tsv — still add a row per reader channel
          const synthRows = Array.from({ length: readerObj.n_channels }, (_, i) => {
            const tr = globalThis.document.createElement('tr');
            const td1 = globalThis.document.createElement('td');
            td1.textContent = `Ch${i + 1}`;
            tr.append(td1);
            return tr;
          });
          chTbody.replaceChildren(...synthRows);
        }
      }
    }

    function attachInput() {
      let dragging = false, dragX0 = 0, t0 = 0;
      tracesCanvas.addEventListener('pointerdown', (e) => {
        dragging = true; dragX0 = e.clientX; t0 = view.start_sec;
        tracesCanvas.setPointerCapture(e.pointerId);
      });
      tracesCanvas.addEventListener('pointerup', (e) => {
        dragging = false;
        try { tracesCanvas.releasePointerCapture(e.pointerId); } catch {}
      });
      // `pointercancel` + `lostpointercapture` cover the cases where the
      // OS or browser interrupts the drag without firing pointerup —
      // examples: Cmd-Tab during drag, gesture cancel, alert popup,
      // browser scroll chaining. Without these resets, `dragging` stays
      // true and the next stray pointermove (even a hover) yanks
      // `view.start_sec` by the cumulative delta from the stale anchor.
      // (Sleuth finding D.)
      const endDrag = (e) => {
        dragging = false;
        try { tracesCanvas.releasePointerCapture(e.pointerId); } catch {}
      };
      tracesCanvas.addEventListener('pointercancel', endDrag);
      tracesCanvas.addEventListener('lostpointercapture', endDrag);
      tracesCanvas.addEventListener('pointermove', (e) => {
        lastPointerEvent = e;
        updateCursor(e.clientX, e.clientY);
        if (!dragging) return;
        const w = tracesCanvas.clientWidth - TraceRenderer.PAD_LEFT - TraceRenderer.PAD_RIGHT;
        if (w <= 0) return;
        const dt = -(e.clientX - dragX0) * (view.window_sec / w);
        view.start_sec = clampStart(t0 + dt, readerInfo && readerInfo.duration_s, view.window_sec);
        requestRender();
      });
      tracesCanvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        view.start_sec = clampStart(view.start_sec + e.deltaX * (view.window_sec / 800),
                                    readerInfo && readerInfo.duration_s, view.window_sec);
        requestRender();
      }, { passive: false });
      window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        // Close whichever overlay is open first
        if (e.key === 'Escape') {
          if (isOverlayVisible('shortcuts-overlay')) { hideOverlay('shortcuts-overlay'); return; }
          if (isOverlayVisible('metadata-overlay'))  { hideOverlay('metadata-overlay');  return; }
        }
        // F02: toggle shortcuts overlay on '?'
        if (e.key === '?') {
          if (isOverlayVisible('shortcuts-overlay')) {
            hideOverlay('shortcuts-overlay');
          } else {
            hideOverlay('metadata-overlay');
            showOverlay('shortcuts-overlay');
          }
          return;
        }
        // F03: toggle metadata overlay on 'i'
        if (e.key === 'i') {
          if (isOverlayVisible('metadata-overlay')) {
            hideOverlay('metadata-overlay');
          } else {
            hideOverlay('shortcuts-overlay');
            showOverlay('metadata-overlay');
          }
          return;
        }
        if (e.key === 'ArrowLeft')  { lastPanDir = -1; view.start_sec = clampStart(view.start_sec - view.window_sec / 2, readerInfo && readerInfo.duration_s, view.window_sec); requestRender(); }
        if (e.key === 'ArrowRight') { lastPanDir = +1; view.start_sec = clampStart(view.start_sec + view.window_sec / 2, readerInfo && readerInfo.duration_s, view.window_sec); requestRender(); }
        // PgUp / PgDn: page through channels when the recording has more
        // than fits at MIN_SLOT_PX (data-viz tier 3 — virtual scroll).
        if (e.key === 'PageUp' || e.key === 'PageDown') {
          const tr = globalThis.TraceRenderer;
          const total = tr ? (tr.lastTotalChannels || 0) : 0;
          const page  = tr ? (tr.lastMaxVisibleChannels || 1) : 1;
          if (total > page) {
            const dir = e.key === 'PageUp' ? -1 : +1;
            view.channel_offset = Math.max(0, Math.min(total - page, view.channel_offset + dir * page));
            requestRender();
            e.preventDefault();
          }
        }
      });
      window.addEventListener('resize', requestRender);
      $('window-sec').addEventListener('change', (e) => {
        view.window_sec = parseFloat(e.target.value);
        // Cache is keyed by sample count; changing the window
        // invalidates every entry. Drop them so we don't waste
        // memory on data we'll never re-display.
        clearReadCache();
        view.start_sec = clampStart(view.start_sec, readerInfo && readerInfo.duration_s, view.window_sec);
        requestRender();
      });
      $('gain').addEventListener('input', (e) => {
        view.gain = parseFloat(e.target.value);
        updateGainReadout();
        requestRender();
      });
      const timeModeBtn = $('time-mode-toggle');
      if (timeModeBtn) {
        timeModeBtn.addEventListener('click', () => {
          if (timeModeBtn.disabled) return;
          const isRel = view.time_mode === 'relative';
          view.time_mode = isRel ? 'clock' : 'relative';
          timeModeBtn.dataset.mode = view.time_mode;
          timeModeBtn.textContent = isRel ? 'clock' : 'rel';
          requestRender();
        });
      }

      // Wire overlay close buttons
      attachOverlayClose('shortcuts-overlay');
      attachOverlayClose('metadata-overlay');
    }

    async function load(eegUrl) {
      return loadFromMeta(
        () => BIDSRecording.loadRecordingMetadata(eegUrl),
        `Loading sidecars from ${eegUrl} …`,
      );
    }

    // NEMAR path: one data.nemar.org manifest.json fetch (via cdn-worker
    // for CORS) yields every file URL in the dataset; the loader picks
    // out the raw binary, walks the manifest for sidecars by BIDS
    // inheritance, and builds a same-dir sibling_urls map for split-file
    // formats (.vhdr+.eeg, .set+.fdt). Covers nm/on/xx datasets — the
    // OpenNeuro-mirror (on*) and sandbox (xx*) prefixes resolve through
    // the same backend. Downstream pipeline (worker, format reader,
    // render) is identical: meta carries the same shape as
    // loadRecordingMetadata returns.
    async function loadNemar(params) {
      const label = `${params.dataset}/sub-${params.sub}` +
        (params.task ? ` task-${params.task}` : '') +
        (params.run  ? ` run-${params.run}`   : '');
      return loadFromMeta(
        () => BIDSRecording.loadNemarRecording(params),
        `Loading NEMAR record (${label}) …`,
      );
    }

    async function loadFromMeta(metaFn, statusText) {
      // New recording → previous reader's sample-keyed cache is moot.
      clearReadCache();
      status.replaceChildren(globalThis.document.createTextNode(statusText));
      try {
        // BIDSRecording sidecar fetching stays on the main thread.
        const meta = await metaFn();
        status.replaceChildren(el('strong', null, `${meta.prefix}_eeg.${meta.ext}`));
        setPill('pill-format', meta.ext.toUpperCase());
        setPill('pill-fs', (meta.eeg_json.sampling_frequency ?? '?') + ' Hz');
        setPill('pill-channels', (meta.channels?.length ?? '?') + ' ch');
        setPill('pill-duration', (meta.eeg_json.recording_duration ?? '?') + ' s');
        renderProvenance(meta, provenance);
        renderChannels(meta.channels, $('ch-list'), $('channel-count'));
        // F09: defer renderEvents until after the reader opens so we can
        // merge in EDF+ annotation-channel events when no _events.tsv
        // sidecar was found.
        updateElectrodeLink(meta, $('electrode-link'));

        // Initialise per-type colour mapping for the new recording.
        const _metaChannels = meta.channels || [];
        const distinctTypes = [...new Set(_metaChannels.map(ch => (ch.type || 'MISC').toUpperCase()))];
        typeColors = buildTypeColors(distinctTypes);
        const colorContainer = $('channel-colors');
        if (colorContainer) {
          renderChannelColors(_metaChannels, colorContainer, typeColors, (type, hex) => {
            typeColors[type] = hex;
            // Swap .active on all swatches for this type row.
            const rows = colorContainer.querySelectorAll('.color-swatch-row');
            rows.forEach(row => {
              const lbl = row.querySelector('.ch-type-label');
              if (!lbl || lbl.textContent !== type) return;
              row.querySelectorAll('button.color-swatch').forEach(btn => {
                btn.classList.toggle('active', btn.getAttribute('data-color') === hex);
              });
            });
            requestRender();
          });
        }

        if (worker) {
          // Wait for INIT_OK before sending LOAD_FILE.
          await workerReadyPromise;

          const headerMsg = await new Promise((resolve, reject) => {
            pendingRequests.set('__LOAD__', { resolve, reject });
            worker.postMessage({ type: 'LOAD_FILE', ext: meta.ext, eeg_url: meta.eeg_url, sidecars: meta });
            incStat('messages_sent');
          });
          // headerMsg is the HEADER message from the worker.
          readerInfo = headerMsg;
        } else {
          // Fallback: open reader directly (Node unit tests, no Worker).
          const readerModule = READERS[meta.ext];
          if (!readerModule) {
            throw new Error(`No reader for *_eeg.${meta.ext} (supported: ${Object.keys(READERS).join(', ')})`);
          }
          fallbackReader = await readerModule.open(meta);
          readerInfo = {
            n_channels:         fallbackReader.n_channels,
            sampling_frequency: fallbackReader.sampling_frequency,
            duration_s:         fallbackReader.duration_s,
            channel_labels:     fallbackReader.channel_labels || null,
            bytes_per_sample:   fallbackReader.bytes_per_sample,
            n_samples:          fallbackReader.n_samples,
            recording_start_iso: fallbackReader.recording_start_iso ?? null,
            annotation_events:  fallbackReader.annotation_events || null,
          };
        }

        // F09: merge EDF+ annotation-channel events when no _events.tsv
        // was found. Sidecar events always win; annotation events fall
        // back only when the sidecar produced zero events.
        if ((!meta.events || meta.events.length === 0) && readerInfo.annotation_events?.length) {
          meta.events = readerInfo.annotation_events;
        }
        renderEvents(meta.events, $('ev-list'), $('event-count'));
        // Cache events for the renderer (on-canvas event-onset markers).
        metaEvents = meta.events || [];

        channelLabels = deriveChannelLabels(readerInfo, meta.channels);
        channelBadMask = deriveBadMask(meta.channels, readerInfo.n_channels);
        metaChannels = _metaChannels.length ? _metaChannels : (meta.channels || null);

        setPill('pill-fs', readerInfo.sampling_frequency + ' Hz');
        setPill('pill-channels', readerInfo.n_channels + ' ch');
        setPill('pill-duration', readerInfo.duration_s.toFixed(1) + ' s');

        // Update time-mode toggle availability based on whether the reader
        // exposes a recording start time.
        const timeModeBtn = $('time-mode-toggle');
        if (timeModeBtn) {
          const hasStart = !!(readerInfo.recording_start_iso);
          timeModeBtn.disabled = !hasStart;
          // Reset to relative mode on new load.
          view.time_mode = 'relative';
          timeModeBtn.dataset.mode = 'relative';
          timeModeBtn.textContent = 'rel';
        }

        // Tune the default window per recording so per-pan byte cost
        // stays bounded — a 5 kHz × 64 ch BV file at 10 s would pull
        // 6.4 MB and feel sluggish; 2 s pulls 1.3 MB and pans crisply.
        // Reflected back into the <select> so what the user sees in
        // the dropdown matches what the canvas is showing.
        view.window_sec = pickDefaultWindowSec(readerInfo);
        $('window-sec').value = String(view.window_sec);

        stageHint.hidden = true;
        tracesCanvas.hidden = false;
        view.start_sec = 0;
        view.channel_offset = 0;

        // Perform initial render before revealing stage-caption so that
        // TraceRenderer.lastDrawnXLabels is populated when the test reads it.
        // The stage-caption toBeVisible() gate in tests serves as the
        // synchronisation point: by the time it resolves the labels are ready.
        {
          const fs = readerInfo.sampling_frequency;
          const windowSamples = Math.min(
            readerInfo.n_samples,
            Math.round(view.window_sec * fs)
          );
          if (inFlight) inFlight.abort();
          inFlight = new AbortController();
          const ctrl = inFlight;
          try {
            const initChannels = await readCachedWindow(0, windowSamples, ctrl.signal);
            if (initChannels && !ctrl.signal.aborted) {
              TraceRenderer.draw(tracesCanvas, {
                channels: initChannels,
                n_samples_visible: initChannels[0]?.length || 0,
                channel_labels: channelLabels,
                channel_types: metaChannels ? metaChannels.map(ch => (ch.type || '').toUpperCase()) : null,
                bad_mask: channelBadMask,
                channel_colors: metaChannels && metaChannels.length
                  ? metaChannels.map(ch => typeColors[(ch.type || 'MISC').toUpperCase()] || null)
                  : null,
                channel_offset: view.channel_offset,
                events: metaEvents,
                fs,
                start_sec: 0,
                gain: view.gain,
                time_mode: view.time_mode,
                recording_start_iso: readerInfo.recording_start_iso ?? null,
                transparent: _isEmbedMode,
              });
              updateGainReadout();
            }
          } catch (_) {
            // If initial render fails, proceed normally — requestRender() below
            // will retry via the rAF path.
          }
          // CRITICAL: only null `inFlight` if it still refers to OUR controller.
          // Between L1359 (await) and here, the user may have triggered a
          // requestRender() that aborted our ctrl and installed a fresh
          // AbortController. Clobbering it to null would break the next
          // requestRender's `if (inFlight) inFlight.abort()` check and let
          // two streaming renders race onto the canvas. (Sleuth finding E.)
          if (inFlight === ctrl) inFlight = null;
        }

        // Stage caption becomes visible after the initial render, so tests
        // that use #stage-caption as a "recording loaded" gate will always
        // see a non-empty lastDrawnXLabels.
        renderStageCaption(meta, readerInfo, $('stage-caption'));
        populateMetadataOverlay(meta, readerInfo);

        // Pre-warm the cache before the first render: the "prev"
        // neighbour clamps to start=0 (same key as the foreground
        // window the upcoming render is about to fetch), so they
        // dedupe into a single network read. The "next" neighbour
        // is the byte range the user's first ArrowRight will need —
        // it lands in parallel with the foreground render's read,
        // making the very first pan a cache hit instead of a full
        // network roundtrip. This is the *only* place we fire
        // prefetch concurrent with foreground; on every other pan it
        // runs after draw to avoid contending the per-connection
        // bandwidth budget (see comment in requestRender).
        prefetchNeighbours();
        requestRender();
      } catch (err) {
        status.replaceChildren(el('span', 'err', err.message));
        console.error(err);
      }
    }

    // ---- drag-drop fallback ---------------------------------
    // Support _eeg, _ieeg, _emg, _meg, _nirs and other electrophysiology suffixes
    const PHYSIO_FILENAME = new RegExp(`_(eeg|ieeg|emg|meg|nirs)\\.(${Object.keys(READERS).join('|')})$`, 'i');

    function registerDrop(files) {
      let physioUrl = null;
      for (const file of files) {
        const url = HttpRange.registerLocal(file.name, file);
        if (!physioUrl && PHYSIO_FILENAME.test(file.name)) physioUrl = url;
      }
      return physioUrl;
    }

    function attachDragDrop() {
      let depth = 0;
      let hasFiles = false;
      const show = () => globalThis.document.body.classList.add('drag-active');
      const hide = () => globalThis.document.body.classList.remove('drag-active');
      window.addEventListener('dragenter', (e) => {
        if (depth === 0) {
          hasFiles = !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
        }
        if (!hasFiles) return;
        depth++;
        show();
        e.preventDefault();
      });
      window.addEventListener('dragleave', () => {
        if (!hasFiles) return;
        depth = Math.max(0, depth - 1);
        if (depth === 0) { hide(); hasFiles = false; }
      });
      window.addEventListener('dragover', (e) => { if (hasFiles) e.preventDefault(); });
      window.addEventListener('drop', async (e) => {
        e.preventDefault();
        depth = 0; hasFiles = false; hide();
        const files = e.dataTransfer && e.dataTransfer.files;
        if (!files || !files.length) return;
        // Tear down before swap: an in-flight readWindow on a local
        // blob slices synchronously, so a clearLocal() race would
        // throw "Local drop missing" against a since-cleared registry.
        if (inFlight) inFlight.abort();
        readerInfo = null;
        fallbackReader = null;
        clearReadCache();
        HttpRange.clearLocal();
        const physioUrl = registerDrop(files);
        if (!physioUrl) {
          const supported = Object.keys(READERS).join(',');
          status.replaceChildren(el('span', 'err',
            `Drop a *_{eeg,ieeg,emg,meg,nirs}.{${supported}} file (got: ${[...files].map(f => f.name).join(', ')})`));
          return;
        }
        load(physioUrl);
      });
    }

    function applyEmbedMode(params) {
      if (params.has('embed')) globalThis.document.body.classList.add('embed');
    }

    // Event delegation: click on any .ch-row in #ch-list toggles bad state.
    // Wired once at boot (not re-wired on each renderChannels call) because
    // we derive the channel index from the row's DOM position, which is
    // stable — renderChannels always rebuilds the full list in order.
    function attachChListClick() {
      const chList = $('ch-list');
      if (!chList) return;
      chList.addEventListener('click', (e) => {
        if (!readerInfo) return;
        const row = e.target.closest('.ch-row');
        if (!row) return;
        const rows = chList.children;
        const idx = Array.prototype.indexOf.call(rows, row);
        if (idx < 0) return;
        toggleBad(idx);
      });
    }

    // ---- F08: filter controls --------------------------------
    // Read the current state of the filter UI and build the filter
    // spec array to send to the worker. Called whenever any filter
    // checkbox or parameter changes.
    function buildFilterSpecs() {
      const specs = [];
      const hpEnable = $('filter-hp-enable');
      const hpCutoff = $('filter-hp-cutoff');
      if (hpEnable && hpEnable.checked) {
        const cutoff = parseFloat(hpCutoff && hpCutoff.value || '0.5');
        if (isFinite(cutoff) && cutoff > 0) {
          specs.push({ kind: 'highpass', cutoff_hz: cutoff, order: 2 });
        }
      }
      const lpEnable = $('filter-lp-enable');
      const lpCutoff = $('filter-lp-cutoff');
      if (lpEnable && lpEnable.checked) {
        const cutoff = parseFloat(lpCutoff && lpCutoff.value || '45');
        if (isFinite(cutoff) && cutoff > 0) {
          specs.push({ kind: 'lowpass', cutoff_hz: cutoff, order: 2 });
        }
      }
      const notchEnable = $('filter-notch-enable');
      const notchFreq   = $('filter-notch-freq');
      if (notchEnable && notchEnable.checked) {
        const freq = parseFloat(notchFreq && notchFreq.value || '60');
        if (isFinite(freq) && freq > 0) {
          // Q=0.5 → broad-band notch that also attenuates neighbouring
          // frequencies (≈24 dB at 50 Hz, ≥24 dB across 30-90 Hz range),
          // guaranteeing a visible pixel change on any real EEG recording
          // regardless of whether it has narrow-band power-line energy.
          // This is intentionally aggressive for display-only use.
          specs.push({ kind: 'notch', cutoff_hz: freq, q: 0.5 });
        }
      }
      return specs;
    }

    function applyFilters() {
      const specs = buildFilterSpecs();
      // Always send to worker (even empty = "no filters").
      if (worker) {
        worker.postMessage({ type: 'APPLY_FILTER', filters: specs });
        incStat('messages_sent');
      }
      // Filter change invalidates cached windows (different data).
      clearReadCache();
      requestRender();
    }

    function attachFilterControls() {
      const filterIds = [
        'filter-hp-enable', 'filter-hp-cutoff',
        'filter-lp-enable', 'filter-lp-cutoff',
        'filter-notch-enable', 'filter-notch-freq',
      ];
      for (const id of filterIds) {
        const node = $(id);
        if (!node) continue;
        // Use 'change' for checkboxes and selects; fires on blur/enter for
        // number inputs — avoids re-rendering on every keystroke.
        node.addEventListener('change', applyFilters);
      }
    }

    attachInput();
    attachChListClick();
    attachFilterControls();
    attachDragDrop();
    const params = new URLSearchParams(globalThis.location.search);
    applyEmbedMode(params);
    const target = BIDSRecording.resolveTargets(params);
    if (target?.kind === 'url' || target?.kind === 'bids-path') {
      load(target.eeg_url);
    } else if (target?.kind === 'bids-path-discover-sub') {
      // Subject not specified in URL — probe participants.tsv then
      // S3-list to find the first real subject ID. After the sub is
      // discovered, fall through to modality discovery (if ?suffix=
      // also omitted) or direct URL build. Mirrors bids-path-auto.
      status.textContent = 'Detecting subject...';
      BIDSRecording.discoverSubject(target.params)
        .then(sub => {
          if (!sub) {
            status.textContent =
              `No subjects found at ${target.params.dataset}/ ` +
              `(participants.tsv missing and no sub-* directories listed). ` +
              `Try adding &sub=<id> to the URL.`;
            return;
          }
          // Re-enter resolution with the discovered sub baked in.
          // If ?suffix= was also missing, we still need modality
          // discovery; we run that ourselves rather than calling
          // resolveTargets again (which would re-parse URL).
          const resolvedParams = { ...target.params, sub };
          if (resolvedParams.suffix) {
            // Both sub (discovered) and suffix (explicit) — direct build.
            load(BIDSRecording.buildOpenNeuroEegUrl(resolvedParams));
            return;
          }
          // sub discovered, suffix unknown — run modality probe.
          status.textContent = 'Detecting modality...';
          BIDSRecording.discoverSuffix(resolvedParams)
            .then(suf => {
              if (!suf) {
                status.textContent =
                  `No EEG/iEEG/MEG/EMG/NIRS recording found at ` +
                  `${resolvedParams.dataset}/sub-${sub}/...`;
                return;
              }
              load(BIDSRecording.buildOpenNeuroEegUrl({ ...resolvedParams, suffix: suf }));
            })
            .catch(err => {
              status.textContent = `Modality probe failed: ${err.message || err}`;
            });
        })
        .catch(err => {
          status.textContent = `Subject probe failed: ${err.message || err}`;
        });
    } else if (target?.kind === 'bids-path-auto') {
      // Modality not specified in URL — probe eeg/ieeg/meg/emg/nirs in
      // parallel + pick the first that exists. ~50-200 ms wall on
      // cdn.eegdash.org because all 5 probes race; bandwidth cost is
      // 5 × 1-byte range requests. Surface a status message so the
      // user knows discovery is happening.
      status.textContent = 'Detecting modality...';
      BIDSRecording.discoverSuffix(target.params)
        .then(suf => {
          if (!suf) {
            status.textContent = `No EEG/iEEG/MEG/EMG/NIRS recording found at ${target.params.dataset}/sub-${target.params.sub}/...`;
            return;
          }
          const resolved = { ...target.params, suffix: suf };
          load(BIDSRecording.buildOpenNeuroEegUrl(resolved));
        })
        .catch(err => {
          status.textContent = `Modality probe failed: ${err.message || err}`;
        });
    } else if (target?.kind === 'nemar') {
      // NEMAR (nm/on/xx prefixes): meta is built from the per-version
      // data.nemar.org manifest.json fetched through the cdn-worker
      // CORS proxy. Same render path as load(), pre-resolved bundle.
      loadNemar(target.nemar_params);
    } else if (target?.kind === 'demo') {
      status.textContent = `demo loader (${target.demo_id}) not wired yet`;
    }
  }

  // Public surface — pure helpers exposed for tests + the boot
  // hook the page calls. setPill/renderChannelColors/buildTypeColors/
  // OKABE_ITO/ELECTRODE_EXPLORER were previously re-exported but had
  // zero external consumers (verified by grep across tests/, index.html,
  // and the rest of *.js). Trimmed to keep window.Viewer tight.
  const api = {
    boot,
    el, setChildren,
    renderProvenance, renderChannels, renderEvents,
    updateElectrodeLink, renderStageCaption,
    clampStart, deriveChannelLabels, deriveBadMask,
    pickDefaultWindowSec,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Viewer = api;
})();
