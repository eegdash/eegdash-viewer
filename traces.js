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
  // labels (left), the time axis (bottom), and a vertical amplitude
  // scale bar (right). PAD_RIGHT was 12 before adding the scale bar
  // (data-viz review tier 1) — bumped to 70 to fit `[│] 100 µV`.
  const PAD_LEFT = 96;
  const PAD_RIGHT = 70;
  const PAD_TOP = 8;
  const PAD_BOTTOM = 28;

  // Minimum per-channel slot height in CSS pixels. When
  // n_channels × MIN_SLOT_PX exceeds plotH, the renderer paginates
  // the visible channels (caller controls offset via `opts.channel_offset`;
  // viewer.js wires PgUp/PgDn to scroll). 16 px keeps a single-pixel
  // trace plus 7 px of breathing room above and below.
  const MIN_SLOT_PX = 16;

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

  // Channel-type suffix in the row label. Suppressed for EEG (the
  // dominant type — would just clutter every row) and shown for
  // EOG/ECG/EMG/RESP/MISC/etc. so non-EEG rows are scannable.
  const TYPE_LABEL_COLOR = '#8b8e94';   // --muted in styles.css
  const TYPE_LABEL_FONT  = "8.5px 'IBM Plex Mono', ui-monospace, Menlo, monospace";

  // Event onset markers — muted Okabe-Ito green so events read as
  // background scaffolding rather than as another data trace.
  const EVENT_LINE_COLOR  = 'rgba(0, 158, 115, 0.30)';
  const EVENT_LABEL_COLOR = 'rgba(0, 110, 80, 0.95)';

  // Per-channel-type dash pattern. Redundant encoding for grayscale
  // print readability — colour alone collapses to mid-grey when
  // desaturated, dash patterns survive. EEG is solid (the default
  // case for almost every recording); the other types each get a
  // distinct rhythm.
  const TYPE_DASH = {
    EEG:  [],
    EOG:  [5, 2],
    ECG:  [2, 2],
    EMG:  [4, 1, 1, 1],
    RESP: [6, 3],
    TEMP: [3, 3],
    MISC: [],
  };

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

  function drawChannelLabels(ctx, labels, types, slotH, x, y0) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let c = 0; c < labels.length; c++) {
      const y = y0 + (c + 0.5) * slotH;
      const type = (types && types[c] || '').toUpperCase();
      const showType = type && type !== 'EEG';
      if (showType) {
        // Right-most: type chip in muted small mono.
        ctx.font = TYPE_LABEL_FONT;
        ctx.fillStyle = TYPE_LABEL_COLOR;
        ctx.fillText(type, x - 8, y + 0.5);
        const typeW = ctx.measureText(type).width;
        // Then: name immediately to the left of the type chip.
        ctx.font = LABEL_FONT;
        ctx.fillStyle = LABEL_COLOR;
        ctx.fillText(labels[c], x - 8 - typeW - 6, y);
      } else {
        ctx.font = LABEL_FONT;
        ctx.fillStyle = LABEL_COLOR;
        ctx.fillText(labels[c], x - 8, y);
      }
    }
  }

  // Round a positive number up to a "nice" round value from the
  // 1/2/5×10^N family. Used by the amplitude scale bar so its label
  // is human-friendly (50/100/200/500 µV, never 173 µV).
  function niceRound(v) {
    if (v <= 0) return 1;
    const exp = Math.floor(Math.log10(v));
    const f = v / Math.pow(10, exp);
    const niceF = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
    return niceF * Math.pow(10, exp);
  }

  // Format an amplitude scale value in human-readable units. EEG is
  // typically 1-500 µV; large drift channels can reach mV.
  function formatScale(microvolts) {
    if (microvolts < 1)    return microvolts.toFixed(2) + ' µV';
    if (microvolts < 1000) return Math.round(microvolts) + ' µV';
    return (microvolts / 1000).toFixed(1) + ' mV';
  }

  // Vertical amplitude scale bar in the right gutter. Picks a nice
  // round µV value that maps to ~50% of a slot height so the glyph
  // is visible without crowding adjacent slots.
  function drawScaleBar(ctx, slotH, slotMicrovolts, plotX1, plotY0, plotH) {
    if (!isFinite(slotMicrovolts) || slotMicrovolts <= 0) return;
    const targetMv = niceRound(slotMicrovolts * 0.5);
    const px = (targetMv / slotMicrovolts) * slotH;
    if (!isFinite(px) || px < 8) return;

    const x = plotX1 + 18;
    const yBottom = plotY0 + plotH - 12;
    const yTop = yBottom - px;

    ctx.save();
    ctx.strokeStyle = LABEL_COLOR;
    ctx.fillStyle = LABEL_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, yTop);
    ctx.lineTo(x + 0.5, yBottom);
    ctx.moveTo(x - 3, yTop + 0.5);
    ctx.lineTo(x + 4, yTop + 0.5);
    ctx.moveTo(x - 3, yBottom + 0.5);
    ctx.lineTo(x + 4, yBottom + 0.5);
    ctx.stroke();
    ctx.font = AXIS_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(formatScale(targetMv), x + 8, (yTop + yBottom) / 2);
    ctx.restore();
  }

  // Render event onsets as muted vertical hairlines, labelled at the
  // top edge. Filters to those falling in the visible window. Labels
  // are dropped when they would collide (< 32 px apart) so a
  // dense burst of events looks like a comb instead of a wall of text.
  function drawEventMarkers(ctx, events, t0, t1, plotX0, plotX1, plotY0, plotH) {
    if (!events || !events.length) return;
    const span = t1 - t0;
    if (span <= 0) return;
    const visible = [];
    for (const ev of events) {
      if (ev.onset < t0 || ev.onset > t1) continue;
      visible.push(ev);
    }
    if (!visible.length) return;
    ctx.save();
    ctx.strokeStyle = EVENT_LINE_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const ev of visible) {
      const x = Math.round(plotX0 + ((ev.onset - t0) / span) * (plotX1 - plotX0)) + 0.5;
      ctx.moveTo(x, plotY0);
      ctx.lineTo(x, plotY0 + plotH);
    }
    ctx.stroke();
    ctx.fillStyle = EVENT_LABEL_COLOR;
    ctx.font = AXIS_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    let lastLabelX = -100;
    for (const ev of visible) {
      const x = Math.round(plotX0 + ((ev.onset - t0) / span) * (plotX1 - plotX0));
      if (x - lastLabelX < 32) continue;
      if (ev.label) {
        ctx.fillText(String(ev.label).slice(0, 14), x + 3, plotY0 + 1);
        lastLabelX = x;
      }
    }
    ctx.restore();
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
    const { ticks, useClock, step } = computeTimeTicks(t0Sec, t1Sec, time_mode, recording_start_iso);

    // Minor ticks: 4 between each major (5 sub-divisions), no labels,
    // shorter (2 px vs 4 px). Visual scaffolding for fine time
    // discrimination without crowding the major-tick labels.
    const minorStep = step / 5;
    const firstMinor = Math.ceil(t0Sec / minorStep) * minorStep;
    ctx.beginPath();
    for (let t = firstMinor; t <= t1Sec + 1e-9; t += minorStep) {
      // Skip positions that coincide with a major tick.
      const r = (t / step);
      if (Math.abs(r - Math.round(r)) < 1e-6) continue;
      const x = x0 + ((t - t0Sec) / span) * (x1 - x0);
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + 2);
    }
    ctx.stroke();

    ctx.beginPath();
    for (const { t, label } of ticks) {
      const x = x0 + ((t - t0Sec) / span) * (x1 - x0);
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + 4);
      ctx.fillText(useClock ? label : label + ' s', x, y + 6);
    }
    ctx.stroke();

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

    const allChannels = opts.channels;
    const totalCh = allChannels.length;
    if (!totalCh) return;
    const allLabels = opts.channel_labels || [];
    const allTypes  = opts.channel_types  || [];
    const allColors = opts.channel_colors || null;
    const allBad    = opts.bad_mask       || null;

    const t0 = opts.start_sec;
    const nSamplesVisible0 = Math.min(opts.n_samples_visible, allChannels[0].length);
    const t1 = t0 + nSamplesVisible0 / opts.fs;
    const gain = opts.gain ?? 1;

    const plotX0 = PAD_LEFT;
    const plotX1 = cssW - PAD_RIGHT;
    const plotY0 = PAD_TOP;
    const plotH  = cssH - PAD_TOP - PAD_BOTTOM;
    const plotW  = plotX1 - plotX0;
    if (plotW <= 4 || plotH <= 4) return;

    // Virtual scroll: when n_channels would force slots smaller than
    // MIN_SLOT_PX, paginate. Caller (viewer.js) drives `channel_offset`
    // via PgUp/PgDn so pages stay in sync with the user's intent.
    const maxVisible = Math.max(1, Math.floor(plotH / MIN_SLOT_PX));
    const offsetRaw = opts.channel_offset || 0;
    const offset = Math.max(0, Math.min(Math.max(0, totalCh - 1), offsetRaw));
    const visibleN = Math.min(maxVisible, totalCh - offset);
    const slice = (arr) => (arr ? arr.slice(offset, offset + visibleN) : arr);
    const channels = totalCh > maxVisible ? slice(allChannels) : allChannels;
    const labels   = totalCh > maxVisible ? slice(allLabels)   : allLabels;
    const types    = totalCh > maxVisible ? slice(allTypes)    : allTypes;
    const colors   = totalCh > maxVisible ? slice(allColors)   : allColors;
    const badMask  = totalCh > maxVisible ? slice(allBad)      : allBad;

    const nCh = channels.length;
    const nVisible = Math.min(opts.n_samples_visible, channels[0].length);
    const slotH = plotH / nCh;
    const halfSlotPx = slotH * 0.45;

    drawSlotDividers(ctx, plotX0, plotX1, plotY0, slotH, nCh);
    drawChannelLabels(ctx, labels, types, slotH, plotX0, plotY0);
    const xLabels = drawTimeAxis(
      ctx, plotX0, plotX1, plotY0 + plotH + 4, t0, t1,
      opts.time_mode, opts.recording_start_iso
    );

    // Event onset markers: rendered BEFORE traces so they read as
    // background scaffolding (muted green hairlines) rather than as
    // additional data.
    drawEventMarkers(ctx, opts.events, t0, t1, plotX0, plotX1, plotY0, plotH);

    const decimated = nVisible > plotW * DECIMATE_RATIO;
    const stds = [];
    for (let c = 0; c < nCh; c++) {
      const data = channels[c];
      const isBad = badMask ? badMask[c] === true : false;

      const { mean, std } = meanStd(data, nVisible);
      stds.push(std);
      // Empty channel guard: a flat line stays at center, scale stays
      // finite, no NaN propagation.
      const ampl = std > 0 ? std * STDDEV_FILL_FACTOR : 1;
      const vToPx = (halfSlotPx * gain) / (ampl / 2);

      const yCenter = plotY0 + (c + 0.5) * slotH;
      ctx.save();
      // Outer clip: confine traces to the plot region (no leak into
      // PAD_LEFT label gutter, time-axis area, or PAD_TOP). Inside the
      // plot region, traces are NOT clipped to their per-channel slot
      // — over-driven gain is allowed to bleed into adjacent slots so
      // the user keeps seeing signal shape rather than a flat saturation
      // line. Trade-off: at very high gain a noisy channel can briefly
      // overlap its neighbours; that's preferable to losing detail.
      ctx.beginPath();
      ctx.rect(plotX0, plotY0, plotW, plotH);
      ctx.clip();

      if (isBad) {
        ctx.fillStyle = BAD_SLOT_COLOR;
        ctx.fillRect(plotX0, plotY0 + c * slotH, plotW, slotH);
      }

      const yC = yCenter + mean * vToPx;
      const typeColor = (colors && colors[c]) ? colors[c] : TRACE_COLOR;
      ctx.strokeStyle = isBad ? BAD_COLOR : typeColor;
      ctx.lineWidth = isBad ? TRACE_WIDTH_BAD : TRACE_WIDTH_DEFAULT;
      // Dash pattern by channel type — redundant encoding for
      // grayscale-safe distinction (color alone collapses to mid-grey
      // when desaturated).
      const type = (types && types[c] || '').toUpperCase();
      ctx.setLineDash(TYPE_DASH[type] || []);
      if (decimated) {
        drawChannelDecimated(ctx, data, nVisible, plotX0, plotW, yC, vToPx);
      } else {
        drawChannelPolyline(ctx, data, nVisible, plotX0, plotW, yC, vToPx);
      }
      ctx.restore();
    }

    // Vertical amplitude scale bar in the right gutter. Use median std
    // across visible channels as a representative amplitude — robust
    // to one or two saturated electrodes that would otherwise dominate
    // the mean.
    const sortedStds = stds.filter(s => s > 0).sort((a, b) => a - b);
    const medianStd = sortedStds.length ? sortedStds[Math.floor(sortedStds.length / 2)] : 0;
    // slot_µV = how many µV does one slot height represent?
    // From `vToPx = (halfSlotPx * gain) / (ampl/2)` with halfSlotPx = 0.45*slotH and ampl = 6*std:
    //   slot_µV = slotH / vToPx = std * 6 / (gain * 0.9) ≈ 6.67 * std / gain
    const slotMicrovolts = medianStd > 0 ? (medianStd * STDDEV_FILL_FACTOR) / (gain * 0.9) : 0;
    drawScaleBar(ctx, slotH, slotMicrovolts, plotX1, plotY0, plotH);

    // Persist for tests + viewer.js (gain readout, virtual-scroll
    // PgUp/PgDn clamping).
    api.lastDrawnXLabels = xLabels;
    api.lastSlotMicrovolts = slotMicrovolts;
    api.lastMaxVisibleChannels = maxVisible;
    api.lastChannelOffset = offset;
    api.lastTotalChannels = totalCh;
    if (typeof window !== 'undefined' && window.TraceRenderer) {
      window.TraceRenderer.lastDrawnXLabels = xLabels;
      window.TraceRenderer.lastSlotMicrovolts = slotMicrovolts;
      window.TraceRenderer.lastMaxVisibleChannels = maxVisible;
      window.TraceRenderer.lastChannelOffset = offset;
      window.TraceRenderer.lastTotalChannels = totalCh;
    }
    if (typeof globalThis !== 'undefined' && globalThis.TraceRenderer) {
      globalThis.TraceRenderer.lastDrawnXLabels = xLabels;
      globalThis.TraceRenderer.lastSlotMicrovolts = slotMicrovolts;
      globalThis.TraceRenderer.lastMaxVisibleChannels = maxVisible;
      globalThis.TraceRenderer.lastChannelOffset = offset;
      globalThis.TraceRenderer.lastTotalChannels = totalCh;
    }
  }

  // PAD_* are exported so the page can compute drag-pixel-to-time
  // mapping against the same plot geometry the renderer uses. Without
  // this, drag math would have to duplicate the magic numbers.
  const api = {
    draw, decimateMinMax, meanStd,
    PAD_LEFT, PAD_RIGHT, PAD_TOP, PAD_BOTTOM, MIN_SLOT_PX,
    lastDrawnXLabels: [],
    lastSlotMicrovolts: 0,
    lastMaxVisibleChannels: 0,
    lastChannelOffset: 0,
    lastTotalChannels: 0,
  };
  if (typeof window !== 'undefined') window.TraceRenderer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.TraceRenderer = api;
})();
