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
   ============================================================ */
(function () {
  'use strict';

  const ELECTRODE_EXPLORER = 'https://electrodes.eegdash.org/';

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
    };
  }

  function boot(opts) {
    opts = opts || {};
    const READERS = opts.readers || defaultReaders();

    const status = $('status');
    const provenance = $('provenance');
    const tracesCanvas = $('traces');
    const stageHint = $('stage-hint');

    const view = { start_sec: 0, window_sec: 10, gain: 1 };
    let reader = null;
    let channelLabels = [];
    let channelBadMask = [];
    let pending = null;
    let inFlight = null;

    // Tiny LRU cache + neighbour prefetch. The bottleneck on 5 kHz BV
    // recordings is bytes-on-the-wire (perf-trace.mjs: 5 s read, 6 ms
    // decode), so the highest-leverage win is not to fetch the same
    // window twice. After each render lands we kick off a fetch for
    // the next anticipated window in the background; the user's next
    // ArrowRight keystroke hits a warm cache.
    const READ_CACHE_MAX = 4;
    const readCache = new Map();             // "start-n" → Promise<channels>
    function clearReadCache() { readCache.clear(); }
    function readCachedWindow(start, n, signal) {
      const key = `${start}-${n}`;
      const hit = readCache.get(key);
      if (hit) {
        if (globalThis.__perf) globalThis.__perf.cacheHits++;
        return hit;                          // promise — pre-fetched or already in flight
      }
      if (globalThis.__perf) globalThis.__perf.cacheMisses++;
      const p = reader.readWindow(start, n, { signal });
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
      const fs = reader.sampling_frequency;
      const n = Math.round(view.window_sec * fs);
      return Math.max(0, Math.min(reader.n_samples - n, Math.round(secs * fs)));
    }
    function prefetchNeighbours() {
      if (!reader) return;
      const fs = reader.sampling_frequency;
      const n = Math.round(view.window_sec * fs);
      // Pre-fetch a half-window step in each direction — that's what
      // ArrowLeft/ArrowRight produce; mouse drag pans usually land
      // somewhere between, hitting partial-overlap browser HTTP cache.
      const next = clampStartSamples(view.start_sec + view.window_sec / 2);
      const prev = clampStartSamples(view.start_sec - view.window_sec / 2);
      for (const s of [next, prev]) {
        const key = `${s}-${n}`;
        if (readCache.has(key)) continue;
        // No abort signal: prefetch is best-effort. Errors get caught
        // so they don't pollute the cache; viewer.boot's error handler
        // catches everything user-visible anyway.
        readCache.set(key, reader.readWindow(s, n).catch(() => null));
        while (readCache.size > READ_CACHE_MAX) {
          readCache.delete(readCache.keys().next().value);
        }
      }
    }

    function requestRender() {
      if (pending) return;
      pending = requestAnimationFrame(async () => {
        pending = null;
        if (!reader) return;
        if (inFlight) inFlight.abort();
        inFlight = new AbortController();
        const ctrl = inFlight;
        const fs = reader.sampling_frequency;
        const startSample = Math.max(0,
          Math.min(reader.n_samples - 1, Math.round(view.start_sec * fs)));
        const windowSamples = Math.min(
          reader.n_samples - startSample,
          Math.round(view.window_sec * fs)
        );
        let channels;
        try {
          channels = await readCachedWindow(startSample, windowSamples, ctrl.signal);
        } catch (err) {
          if (err.name === 'AbortError') return;
          status.replaceChildren(el('span', 'err', `read window failed: ${err.message}`));
          console.error(err);
          return;
        }
        if (!channels || ctrl.signal.aborted) return;
        TraceRenderer.draw(tracesCanvas, {
          channels,
          n_samples_visible: channels[0]?.length || 0,
          channel_labels: channelLabels,
          bad_mask: channelBadMask,
          fs,
          start_sec: startSample / fs,
          gain: view.gain,
        });
        // Prefetch fires AFTER the foreground draw lands. Initial
        // experiments with parallel-with-foreground prefetch (firing
        // both reads concurrently) regressed all three recordings —
        // the OpenNeuro S3 per-connection bandwidth budget (~3-4 MB/s
        // tiled max) is real, and concurrent reads stole from each
        // other rather than packing the pipeline. Bytes-on-wire is the
        // bottleneck for high-Hz recordings, so the win comes from
        // decimation (fewer bytes), not parallelism.
        prefetchNeighbours();
      });
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
      tracesCanvas.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const w = tracesCanvas.clientWidth - TraceRenderer.PAD_LEFT - TraceRenderer.PAD_RIGHT;
        if (w <= 0) return;
        const dt = -(e.clientX - dragX0) * (view.window_sec / w);
        view.start_sec = clampStart(t0 + dt, reader && reader.duration_s, view.window_sec);
        requestRender();
      });
      tracesCanvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        view.start_sec = clampStart(view.start_sec + e.deltaX * (view.window_sec / 800),
                                    reader && reader.duration_s, view.window_sec);
        requestRender();
      }, { passive: false });
      window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        if (e.key === 'ArrowLeft')  { view.start_sec = clampStart(view.start_sec - view.window_sec / 2, reader && reader.duration_s, view.window_sec); requestRender(); }
        if (e.key === 'ArrowRight') { view.start_sec = clampStart(view.start_sec + view.window_sec / 2, reader && reader.duration_s, view.window_sec); requestRender(); }
      });
      window.addEventListener('resize', requestRender);
      $('window-sec').addEventListener('change', (e) => {
        view.window_sec = parseFloat(e.target.value);
        // Cache is keyed by sample count; changing the window
        // invalidates every entry. Drop them so we don't waste
        // memory on data we'll never re-display.
        clearReadCache();
        view.start_sec = clampStart(view.start_sec, reader && reader.duration_s, view.window_sec);
        requestRender();
      });
      $('gain').addEventListener('input', (e) => {
        view.gain = parseFloat(e.target.value);
        $('gain-readout').textContent = view.gain.toFixed(2) + '×';
        requestRender();
      });
    }

    async function load(eegUrl) {
      // New recording → previous reader's sample-keyed cache is moot.
      clearReadCache();
      status.replaceChildren(globalThis.document.createTextNode(`Loading sidecars from ${eegUrl} …`));
      try {
        const meta = await BIDSRecording.loadRecordingMetadata(eegUrl);
        status.replaceChildren(el('strong', null, `${meta.prefix}_eeg.${meta.ext}`));
        setPill('pill-format', meta.ext.toUpperCase());
        setPill('pill-fs', (meta.eeg_json.sampling_frequency ?? '?') + ' Hz');
        setPill('pill-channels', (meta.channels?.length ?? '?') + ' ch');
        setPill('pill-duration', (meta.eeg_json.recording_duration ?? '?') + ' s');
        renderProvenance(meta, provenance);
        renderChannels(meta.channels, $('ch-list'), $('channel-count'));
        renderEvents(meta.events, $('ev-list'), $('event-count'));
        updateElectrodeLink(meta, $('electrode-link'));

        const readerModule = READERS[meta.ext];
        if (!readerModule) {
          throw new Error(`No reader for *_eeg.${meta.ext} (supported: ${Object.keys(READERS).join(', ')})`);
        }
        reader = await readerModule.open(meta);
        channelLabels = deriveChannelLabels(reader, meta.channels);
        channelBadMask = deriveBadMask(meta.channels, reader.n_channels);

        setPill('pill-fs', reader.sampling_frequency + ' Hz');
        setPill('pill-channels', reader.n_channels + ' ch');
        setPill('pill-duration', reader.duration_s.toFixed(1) + ' s');
        renderStageCaption(meta, reader, $('stage-caption'));

        // Tune the default window per recording so per-pan byte cost
        // stays bounded — a 5 kHz × 64 ch BV file at 10 s would pull
        // 6.4 MB and feel sluggish; 2 s pulls 1.3 MB and pans crisply.
        // Reflected back into the <select> so what the user sees in
        // the dropdown matches what the canvas is showing.
        view.window_sec = pickDefaultWindowSec(reader);
        $('window-sec').value = String(view.window_sec);

        stageHint.hidden = true;
        tracesCanvas.hidden = false;
        view.start_sec = 0;
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
    const EEG_FILENAME = new RegExp(`_eeg\\.(${Object.keys(READERS).join('|')})$`, 'i');

    function registerDrop(files) {
      let eegUrl = null;
      for (const file of files) {
        const url = HttpRange.registerLocal(file.name, file);
        if (!eegUrl && EEG_FILENAME.test(file.name)) eegUrl = url;
      }
      return eegUrl;
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
        reader = null;
        clearReadCache();
        HttpRange.clearLocal();
        const eegUrl = registerDrop(files);
        if (!eegUrl) {
          const supported = Object.keys(READERS).join(',');
          status.replaceChildren(el('span', 'err',
            `Drop a *_eeg.{${supported}} file (got: ${[...files].map(f => f.name).join(', ')})`));
          return;
        }
        load(eegUrl);
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
        if (!reader) return;
        const row = e.target.closest('.ch-row');
        if (!row) return;
        const rows = chList.children;
        const idx = Array.prototype.indexOf.call(rows, row);
        if (idx < 0) return;
        toggleBad(idx);
      });
    }

    attachInput();
    attachChListClick();
    attachDragDrop();
    const params = new URLSearchParams(globalThis.location.search);
    applyEmbedMode(params);
    const target = BIDSRecording.resolveTargets(params);
    if (target?.kind === 'url' || target?.kind === 'bids-path') {
      load(target.eeg_url);
    } else if (target?.kind === 'demo') {
      status.textContent = `demo loader (${target.demo_id}) not wired yet`;
    }
  }

  // Public surface — pure helpers exposed for tests + the boot
  // hook the page calls.
  const api = {
    boot,
    el, setChildren, setPill,
    renderProvenance, renderChannels, renderEvents,
    updateElectrodeLink, renderStageCaption,
    clampStart, deriveChannelLabels, deriveBadMask,
    pickDefaultWindowSec,
    ELECTRODE_EXPLORER,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Viewer = api;
})();
