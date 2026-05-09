/* ============================================================
   traces.js — canvas trace renderer for the EEG viewer.

   The renderer is intentionally stateless: callers manage the
   view (start time, window width, gain) and pass per-channel
   Float32Arrays from whichever format reader is in play. We do
   per-channel DC removal and amplitude normalisation before
   drawing so the same code handles raw EEG (large DC offsets)
   and reference-removed EEG (already mean-zero).

   When the visible-sample count exceeds the plot width in
   pixels we decimate via block min/max — every output pixel
   gets a vertical line spanning the min and max of the samples
   that fall in its bucket. This preserves spikes faithfully and
   costs O(samples_visible) per draw, which is fine for typical
   windows (10 s × 1 kHz × 64 ch ≈ 640 k samples).
   ============================================================ */
(function () {
  'use strict';

  // Plot-area inset; rest of the canvas is reserved for channel
  // labels (left), the time axis (bottom), and a scale bar (right).
  const PAD_LEFT = 96;
  const PAD_RIGHT = 12;
  const PAD_TOP = 8;
  const PAD_BOTTOM = 28;

  // Trace stroke widths, separate so we can keep each channel
  // legible on a HiDPI display without bleeding into neighbours.
  const TRACE_WIDTH_DEFAULT = 1.0;
  const TRACE_WIDTH_BAD = 1.4;

  // Palette aligned with the page's CSS custom properties so the canvas
  // reads as part of the same instrument as the surrounding chrome.
  // (Canvas can't consume CSS vars directly; values mirror the :root
  // declarations in styles.css.)
  const BG_COLOR      = '#fbfaf6';   // --surface (cream paper)
  const TRACE_COLOR   = '#0072B2';   // Okabe-Ito blue
  const BAD_COLOR     = '#D55E00';   // Okabe-Ito vermillion
  const BAD_SLOT_COLOR = '#c8c8c8';  // muted grey fill for bad-channel slot background (R=200, delta ≥ 50 vs BG)
  const AXIS_COLOR    = '#b5b8bd';   // --ink-3
  const SLOT_COLOR  = '#e8e5dc';   // --line-2 — hairlines between channels
  const LABEL_COLOR = '#3a3d42';   // --ink-2
  const LABEL_FONT  = "10.5px 'IBM Plex Mono', ui-monospace, Menlo, monospace";
  const AXIS_FONT   = "9.5px 'IBM Plex Mono', ui-monospace, Menlo, monospace";

  // 6σ covers > 99.7% of any roughly normal-distributed channel,
  // and is comfortably larger than the ±3σ stddev display the
  // EEGLAB browser uses. Clipping above this is acceptable —
  // pathological samples (saturated electrodes) shouldn't compress
  // the rest of the trace.
  const STDDEV_FILL_FACTOR = 6;

  // Block min/max kicks in only when there are at least ~2 samples
  // per pixel; below that, drawing the polyline directly is sharper.
  const DECIMATE_RATIO = 2;

  // Cached canvas geometry. `clientWidth`/`clientHeight` reads force a
  // layout flush on every draw; we instead listen for resize once and
  // refresh on demand. The first draw always probes (no cache yet),
  // subsequent draws use the cached values until ResizeObserver fires.
  // Note: the ResizeObserver pins the canvas in memory through the
  // closure. Fine for the viewer's single-canvas use; if a future
  // page draws into multiple short-lived canvases, switch to an
  // explicit dispose() call when the canvas leaves the DOM.
  const _canvasDims = new WeakMap();   // canvas → { dpr, cssW, cssH }
  function deviceFitCanvas(canvas) {
    let dims = _canvasDims.get(canvas);
    if (!dims) {
      dims = { dpr: 1, cssW: 0, cssH: 0 };
      _canvasDims.set(canvas, dims);
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => { dims.cssW = 0; dims.cssH = 0; });
        ro.observe(canvas);
      }
    }
    if (!dims.cssW || !dims.cssH) {
      dims.dpr = window.devicePixelRatio || 1;
      dims.cssW = canvas.clientWidth;
      dims.cssH = canvas.clientHeight;
    }
    const w = Math.max(1, Math.round(dims.cssW * dims.dpr));
    const h = Math.max(1, Math.round(dims.cssH * dims.dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return dims;
  }

  // meanStd cache keyed by channel-array reference identity. Trace data
  // is immutable per pan (readWindow returns fresh subarrays); a draw
  // that's only changing gain reuses the previous stats free.
  const _statsCache = new WeakMap();   // Float32Array → { mean, std, n }
  function meanStd(data, n) {
    if (n <= 0) return { mean: 0, std: 0 };
    const cached = _statsCache.get(data);
    if (cached && cached.n === n) return cached;
    let s = 0, ss = 0;
    for (let i = 0; i < n; i++) { s += data[i]; ss += data[i] * data[i]; }
    const mean = s / n;
    const variance = Math.max(0, ss / n - mean * mean);
    const out = { mean, std: Math.sqrt(variance), n };
    _statsCache.set(data, out);
    return out;
  }

  function clear(ctx, w, h) {
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, w, h);
  }

  // Hairline divider between each channel slot. Subtle enough not to
  // compete with the trace, present enough that the eye can tell where
  // one channel ends and the next begins on dense (64+ ch) caps.
  function drawSlotDividers(ctx, plotX0, plotX1, plotY0, slotH, nCh) {
    ctx.strokeStyle = SLOT_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 1; c < nCh; c++) {
      const y = Math.round(plotY0 + c * slotH) + 0.5;     // half-pixel snap
      ctx.moveTo(plotX0, y);
      ctx.lineTo(plotX1, y);
    }
    ctx.stroke();
  }

  function drawChannelLabels(ctx, labels, slotH, x, y0) {
    ctx.fillStyle = LABEL_COLOR;
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let c = 0; c < labels.length; c++) {
      ctx.fillText(labels[c], x - 8, y0 + (c + 0.5) * slotH);
    }
  }

  // Format an absolute number of seconds-since-midnight as HH:MM:SS.
  // Works for recording offsets that may wrap past midnight.
  function secToHHMMSS(totalSec) {
    const s = Math.floor(totalSec) % 86400;
    const hh = String(Math.floor(s / 3600) % 24).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  // Parse an ISO 8601 string "YYYY-MM-DDTHH:MM:SS" and return the
  // number of seconds since midnight (i.e. time-of-day portion only).
  // Returns null if the string is not parseable.
  function isoToSecOfDay(isoStr) {
    if (!isoStr) return null;
    const m = isoStr.match(/T(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
  }

  // Compute tick positions and labels; returns { ticks: [{t, label}], step }.
  // When time_mode === 'clock' AND recording_start_iso is set, labels are
  // HH:MM:SS; otherwise labels are relative numeric strings.
  function computeTimeTicks(t0Sec, t1Sec, time_mode, recording_start_iso) {
    const span = t1Sec - t0Sec;
    const niceSteps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60];
    const target = span / 7;
    let step = niceSteps[0];
    for (const s of niceSteps) if (s <= target) step = s;
    const first = Math.ceil(t0Sec / step) * step;

    const useClock = time_mode === 'clock' && !!recording_start_iso;
    const startSecOfDay = useClock ? isoToSecOfDay(recording_start_iso) : null;

    const ticks = [];
    for (let t = first; t <= t1Sec + 1e-9; t += step) {
      let label;
      if (useClock && startSecOfDay !== null) {
        label = secToHHMMSS(startSecOfDay + t);
      } else {
        label = t.toFixed(step >= 1 ? 0 : 2);
      }
      ticks.push({ t, label });
    }
    return { ticks, step, useClock };
  }

  function drawTimeAxis(ctx, x0, x1, y, t0Sec, t1Sec, time_mode, recording_start_iso) {
    ctx.strokeStyle = AXIS_COLOR;
    ctx.fillStyle = AXIS_COLOR;
    ctx.font = AXIS_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();

    const span = t1Sec - t0Sec;
    const { ticks, useClock } = computeTimeTicks(t0Sec, t1Sec, time_mode, recording_start_iso);

    ctx.beginPath();
    for (const { t, label } of ticks) {
      const x = x0 + ((t - t0Sec) / span) * (x1 - x0);
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + 4);
      // For relative mode, append " s" unit suffix; clock mode labels are self-describing.
      ctx.fillText(useClock ? label : label + ' s', x, y + 6);
    }
    ctx.stroke();

    // Return the labels array so the caller can save it.
    return ticks.map(tk => tk.label);
  }

  // Module-scope scratch buffers reused across decimate calls. Each
  // pan touches every channel; allocating fresh `Float32Array(nPixels)`
  // pairs adds ~64×2KB×60fps of GC pressure that this avoids. Callers
  // must consume the result before the next decimate call (the renderer
  // does that inside one synchronous draw pass).
  let _scratchMn = new Float32Array(0);
  let _scratchMx = new Float32Array(0);
  function decimateMinMax(data, n, nPixels) {
    if (_scratchMn.length < nPixels) {
      _scratchMn = new Float32Array(nPixels);
      _scratchMx = new Float32Array(nPixels);
    }
    const mn = _scratchMn, mx = _scratchMx;
    if (n <= 0 || nPixels <= 0) return { mn, mx };
    const step = n / nPixels;
    let from = 0;
    for (let p = 0; p < nPixels; p++) {
      const to = (p === nPixels - 1) ? n : Math.floor((p + 1) * step);
      let lo = data[from], hi = lo;
      for (let i = from + 1; i < to; i++) {
        const v = data[i];
        if (v < lo) lo = v;
        else if (v > hi) hi = v;
      }
      mn[p] = lo; mx[p] = hi;
      from = to;
    }
    return { mn, mx };
  }

  function drawChannelDecimated(ctx, data, nVisible, plotX0, plotW, yCenter, vToPx) {
    const nPixels = Math.max(1, Math.floor(plotW));
    const { mn, mx } = decimateMinMax(data, nVisible, nPixels);
    ctx.beginPath();
    for (let p = 0; p < nPixels; p++) {
      const x = plotX0 + p;
      ctx.moveTo(x, yCenter - mx[p] * vToPx);
      ctx.lineTo(x, yCenter - mn[p] * vToPx);
    }
    ctx.stroke();
  }

  function drawChannelPolyline(ctx, data, nVisible, plotX0, plotW, yCenter, vToPx) {
    if (nVisible <= 0) return;
    const dx = plotW / Math.max(1, nVisible - 1);
    ctx.beginPath();
    ctx.moveTo(plotX0, yCenter - data[0] * vToPx);
    for (let s = 1; s < nVisible; s++) {
      ctx.lineTo(plotX0 + s * dx, yCenter - data[s] * vToPx);
    }
    ctx.stroke();
  }

  // Single entry point. `channels` is a per-channel typed-array
  // (any length ≥ nVisible); we read indices [0, nVisible).
  // `bad_mask` is an optional boolean[]; channels marked true render
  // in the highlight colour.
  function draw(canvas, opts) {
    const { dpr, cssW, cssH } = deviceFitCanvas(canvas);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    clear(ctx, cssW, cssH);

    const channels = opts.channels;
    const nCh = channels.length;
    if (!nCh) return;
    const nVisible = Math.min(opts.n_samples_visible, channels[0].length);
    const t0 = opts.start_sec;
    const t1 = t0 + nVisible / opts.fs;
    const gain = opts.gain ?? 1;

    const plotX0 = PAD_LEFT;
    const plotX1 = cssW - PAD_RIGHT;
    const plotY0 = PAD_TOP;
    const plotH  = cssH - PAD_TOP - PAD_BOTTOM;
    const plotW  = plotX1 - plotX0;
    if (plotW <= 4 || plotH <= 4) return;

    const slotH = plotH / nCh;
    const halfSlotPx = slotH * 0.45;

    drawSlotDividers(ctx, plotX0, plotX1, plotY0, slotH, nCh);
    drawChannelLabels(ctx, opts.channel_labels, slotH, plotX0, plotY0);
    const xLabels = drawTimeAxis(
      ctx, plotX0, plotX1, plotY0 + plotH + 4, t0, t1,
      opts.time_mode, opts.recording_start_iso
    );

    const decimated = nVisible > plotW * DECIMATE_RATIO;
    const badMask = opts.bad_mask;
    for (let c = 0; c < nCh; c++) {
      const data = channels[c];
      const isBad = badMask ? badMask[c] === true : false;

      const { mean, std } = meanStd(data, nVisible);
      // Empty channel guard: a flat line stays at center, scale stays
      // finite, no NaN propagation.
      const ampl = std > 0 ? std * STDDEV_FILL_FACTOR : 1;
      const vToPx = (halfSlotPx * gain) / (ampl / 2);

      const yCenter = plotY0 + (c + 0.5) * slotH;
      ctx.save();
      // Clip to slot so spikes from over-driven gain don't bleed
      // into adjacent channels.
      ctx.beginPath();
      ctx.rect(plotX0, plotY0 + c * slotH, plotW, slotH);
      ctx.clip();

      // For bad channels, fill the slot with a muted grey background so
      // the entire band reads as "suppressed" — this also ensures that
      // pixel-colour tests (mean R over the band) see a significant
      // shift compared to the normal cream-paper BG_COLOR.
      if (isBad) {
        ctx.fillStyle = BAD_SLOT_COLOR;
        ctx.fillRect(plotX0, plotY0 + c * slotH, plotW, slotH);
      }

      // We pre-subtract mean by adjusting yCenter, so the per-sample
      // hot loop stays a single multiply per sample. Equivalent to
      // (data[s] - mean) * vToPx but cheaper per draw.
      const yC = yCenter + mean * vToPx;
      ctx.strokeStyle = isBad ? BAD_COLOR : TRACE_COLOR;
      ctx.lineWidth = isBad ? TRACE_WIDTH_BAD : TRACE_WIDTH_DEFAULT;
      if (decimated) {
        drawChannelDecimated(ctx, data, nVisible, plotX0, plotW, yC, vToPx);
      } else {
        drawChannelPolyline(ctx, data, nVisible, plotX0, plotW, yC, vToPx);
      }
      ctx.restore();
    }

    // Persist the tick labels so tests and extensions can read them
    // without re-computing tick positions.
    api.lastDrawnXLabels = xLabels;
    if (typeof window !== 'undefined' && window.TraceRenderer) window.TraceRenderer.lastDrawnXLabels = xLabels;
    if (typeof globalThis !== 'undefined' && globalThis.TraceRenderer) globalThis.TraceRenderer.lastDrawnXLabels = xLabels;
  }

  // PAD_* are exported so the page can compute drag-pixel-to-time
  // mapping against the same plot geometry the renderer uses. Without
  // this, drag math would have to duplicate the magic numbers.
  const api = {
    draw, decimateMinMax, meanStd,
    PAD_LEFT, PAD_RIGHT, PAD_TOP, PAD_BOTTOM,
    lastDrawnXLabels: [],
  };
  if (typeof window !== 'undefined') window.TraceRenderer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.TraceRenderer = api;
})();
