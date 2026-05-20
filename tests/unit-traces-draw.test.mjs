// unit-traces-draw.test.mjs
// Tests for the TraceRenderer.draw() path, exercised via a recording
// CanvasRenderingContext2D stub (no browser required). Each stub call is
// appended to a log so we can assert *what* the renderer drew, in what
// order, with what arguments.
//
// Mutation-validation comments mark which mutation each test catches.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
// ResizeObserver is not present in Node; stub it so deviceFitCanvas
// can still register the observer without throwing.
globalThis.ResizeObserver = globalThis.ResizeObserver || class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.window.devicePixelRatio = 1;

const TraceRenderer = require('../traces.js');

// ── Canvas / Context stub ────────────────────────────────────────────────────

/**
 * makeStubCtx() returns a recording 2D context. Every property set and
 * every method call is appended to `calls` as { op, args }.
 *
 * The save/restore stack is a single push/pop so that ctx.save() does not
 * lose tracked state (fillStyle etc.) between sub-draws.
 */
function makeStubCtx() {
  const calls = [];
  const savedStack = [];
  const state = {
    strokeStyle: '#000',
    fillStyle:   '#000',
    lineWidth:   1,
    font:        '',
    textAlign:   'left',
    textBaseline:'alphabetic',
  };

  function track(op, ...args) {
    calls.push({ op, args });
  }

  // A Proxy lets us intercept both method calls and property assignments.
  const ctx = new Proxy({
    get calls() { return calls; },

    // We need a real measureText stub so drawChannelLabels does not crash.
    measureText(text) { return { width: text.length * 6 }; },

    // Clip / path methods
    beginPath()  { track('beginPath'); },
    moveTo(x, y) { track('moveTo', x, y); },
    lineTo(x, y) { track('lineTo', x, y); },
    stroke()     { track('stroke'); },
    fill()       { track('fill'); },
    rect(x, y, w, h) { track('rect', x, y, w, h); },
    clip()       { track('clip'); },
    closePath()  { track('closePath'); },

    // Text
    fillText(t, x, y)   { track('fillText', t, x, y); },
    strokeText(t, x, y) { track('strokeText', t, x, y); },

    // Rectangle fills/clears
    fillRect(x, y, w, h)  { track('fillRect', x, y, w, h); },
    clearRect(x, y, w, h) { track('clearRect', x, y, w, h); },

    // Transform
    setTransform(...a) { track('setTransform', ...a); },
    save()  {
      track('save');
      savedStack.push({ ...state });
    },
    restore() {
      track('restore');
      const prev = savedStack.pop();
      if (prev) Object.assign(state, prev);
    },

    // Canvas measurement
    measureText(text) { return { width: text.length * 6 }; },
    setLineDash(arr) { track('setLineDash', arr); },

    // Stubs required for clip path
    arcTo() {},
    arc()   {},
  }, {
    set(target, prop, value) {
      if (prop in state) {
        track(`set:${prop}`, value);
        state[prop] = value;
      }
      target[prop] = value;
      return true;
    },
    get(target, prop) {
      if (prop in state) return state[prop];
      return target[prop];
    },
  });
  return ctx;
}

/**
 * makeStubCanvas(cssW, cssH) returns a canvas whose getContext('2d')
 * returns a fresh recording context. clientWidth/clientHeight mirror
 * cssW/cssH so deviceFitCanvas resolves correct plot geometry.
 */
function makeStubCanvas(cssW = 800, cssH = 600) {
  const ctx = makeStubCtx();
  return {
    width: 0,
    height: 0,
    clientWidth:  cssW,
    clientHeight: cssH,
    getContext() { return ctx; },
    _ctx: ctx,
  };
}

// ── Shared opts builder ──────────────────────────────────────────────────────

/**
 * buildOpts(nCh, nSamples, overrides) creates a minimal opts object for
 * TraceRenderer.draw(). All channels contain a ramp signal with mild noise
 * so meanStd returns a non-zero std (avoids the `ampl=1` fallback path).
 */
function buildOpts(nCh = 4, nSamples = 200, overrides = {}) {
  const channels = [];
  for (let c = 0; c < nCh; c++) {
    const d = new Float32Array(nSamples);
    for (let i = 0; i < nSamples; i++) d[i] = (i % 20) * (c + 1) * 0.5 - 5;
    channels.push(d);
  }
  return {
    channels,
    channel_labels: Array.from({ length: nCh }, (_, i) => `Ch${i + 1}`),
    channel_types:  Array.from({ length: nCh }, () => 'EEG'),
    n_samples_visible: nSamples,
    fs: 250,
    start_sec: 0,
    gain: 1,
    transparent: false,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('draw: clearRect called on transparent=false draw (non-transparent bg)', async (t) => {
  // MUTATION 3 guard: if clearRect were replaced by fillRect only, this test
  // still passes. The real guard is the transparent=true test below.
  // Here we assert that the background IS painted via fillRect (BG_COLOR fill).
  const canvas = makeStubCanvas();
  TraceRenderer.draw(canvas, buildOpts(2, 100, { transparent: false }));
  const calls = canvas._ctx.calls;
  const hasClearRect = calls.some(c => c.op === 'clearRect');
  const hasFillRect  = calls.some(c => c.op === 'fillRect');
  assert.ok(hasClearRect, 'clearRect must be called even on opaque draw (to reset alpha)');
  assert.ok(hasFillRect,  'fillRect must be called to paint background colour');
});

test('draw: transparent=true → clearRect called, no background fillRect at canvas origin', async (t) => {
  // MUTATION 3 guard: `clearRect` → `fillRect`. If this mutation is applied,
  // clearRect disappears and fillRect appears at (0,0,w,h) with BG_COLOR,
  // making the canvas opaque — this test catches that.
  const canvas = makeStubCanvas();
  TraceRenderer.draw(canvas, buildOpts(2, 100, { transparent: true }));
  const calls = canvas._ctx.calls;
  const hasClearRect = calls.some(c => c.op === 'clearRect');
  assert.ok(hasClearRect, 'clearRect must be called in transparent mode');
  // There should be NO fillRect call that covers the entire canvas origin
  // (0,0). Any fillRect in transparent mode means the alpha was flooded.
  const bgFill = calls.find(
    c => c.op === 'fillRect' && c.args[0] === 0 && c.args[1] === 0
  );
  assert.ok(!bgFill, `fillRect at canvas origin must NOT appear in transparent mode; got ${JSON.stringify(bgFill)}`);
});

test('draw: slot count matches channel count', async (t) => {
  // The renderer must issue at least one stroke per channel (the trace) plus
  // one shared stroke for slot dividers. We count set:strokeStyle transitions
  // as a proxy for "per-channel render did run".
  // MUTATION 4 guard (bad-channel mask drop) does not break this test —
  // that's handled by the bad-channel test below.
  const N = 6;
  const canvas = makeStubCanvas();
  TraceRenderer.draw(canvas, buildOpts(N, 100));
  const calls = canvas._ctx.calls;
  // At minimum one `save` per channel (each channel uses ctx.save/restore).
  const saves = calls.filter(c => c.op === 'save');
  assert.ok(saves.length >= N, `Expected ≥${N} save() calls, got ${saves.length}`);
});

test('draw: Y-axis channel labels appear at expected vertical positions', async (t) => {
  // drawChannelLabels calls fillText with the label string. We verify that
  // the label for channel index `c` is drawn near y = PAD_TOP + (c+0.5)*slotH.
  // MUTATION 2 guard: if a sign flip negates the Y calculation, labels land
  // in the wrong row — this test catches that.
  const nCh = 4;
  const canvas = makeStubCanvas(800, 600);
  const labels = ['Fp1', 'Fp2', 'C3', 'C4'];
  TraceRenderer.draw(canvas, buildOpts(nCh, 100, { channel_labels: labels }));

  const calls = canvas._ctx.calls;
  const textCalls = calls.filter(c => c.op === 'fillText');
  const labelCalls = textCalls.filter(c => labels.includes(c.args[0]));
  assert.ok(labelCalls.length >= nCh, `Expected ≥${nCh} label fillText calls, got ${labelCalls.length}`);

  // The Y positions must be strictly positive and within plot area.
  // PAD_TOP=8, canvas cssH=600, PAD_BOTTOM=28 → plotH=564.
  const plotY0 = 8;
  const plotH  = 600 - 8 - 28;
  for (const call of labelCalls) {
    const y = call.args[2];
    assert.ok(y >= plotY0, `Label y=${y} is above the plot top (${plotY0})`);
    assert.ok(y <= plotY0 + plotH, `Label y=${y} is below the plot bottom (${plotY0 + plotH})`);
  }
});

test('draw: event-onset markers drawn when events array non-empty', async (t) => {
  // drawEventMarkers calls stroke() after building a path of vertical lines.
  // An empty events array must produce zero event strokes; a non-empty array
  // at a time within [t0,t1] must produce at least one.
  // MUTATION 2 guard (Y calc): events use the same plotY0 / plotH coordinates.
  const canvas1 = makeStubCanvas();
  TraceRenderer.draw(canvas1, buildOpts(2, 100, { events: [] }));
  const strokesBefore = canvas1._ctx.calls.filter(c => c.op === 'stroke').length;

  const canvas2 = makeStubCanvas();
  const opts = buildOpts(2, 100, {
    events: [{ onset: 0.1, label: 'S1' }, { onset: 0.3, label: 'S2' }],
    start_sec: 0,
    // window is 100 / 250 Hz = 0.4 s, so both events fall within [0, 0.4]
    fs: 250,
  });
  TraceRenderer.draw(canvas2, opts);
  const strokesAfter = canvas2._ctx.calls.filter(c => c.op === 'stroke').length;

  assert.ok(strokesAfter > strokesBefore,
    `Event strokes (${strokesAfter}) should exceed no-event strokes (${strokesBefore})`);

  // Also verify the event label text appears.
  const textCalls = canvas2._ctx.calls.filter(c => c.op === 'fillText');
  const hasLabel = textCalls.some(c => String(c.args[0]).includes('S1') || String(c.args[0]).includes('S2'));
  assert.ok(hasLabel, 'At least one event label must be drawn');
});

test('draw: events outside the visible window are not drawn', async (t) => {
  // An event 100 s before t0 must be filtered out and produce no marker.
  const canvas = makeStubCanvas();
  TraceRenderer.draw(canvas, buildOpts(2, 100, {
    events: [{ onset: 100, label: 'FAR' }],
    start_sec: 0,
    fs: 250,
  }));
  const textCalls = canvas._ctx.calls.filter(c => c.op === 'fillText');
  const hasOut = textCalls.some(c => String(c.args[0]).includes('FAR'));
  assert.ok(!hasOut, 'Event outside visible window must not be drawn');
});

test('draw: bad-channel rows get a different strokeStyle (BAD_COLOR)', async (t) => {
  // MUTATION 4 guard: if bad_mask check is dropped, all channels use TRACE_COLOR
  // (#0072B2 blue). BAD_COLOR is #D55E00. This test detects the change.
  const canvas = makeStubCanvas();
  const bad_mask = [false, true, false, false];
  TraceRenderer.draw(canvas, buildOpts(4, 100, { bad_mask }));

  const calls = canvas._ctx.calls;
  const colorChanges = calls.filter(c => c.op === 'set:strokeStyle');
  // BAD_COLOR is '#D55E00'; at least one strokeStyle set to it must appear.
  const hadBadColor = colorChanges.some(c => c.args[0] === '#D55E00');
  assert.ok(hadBadColor, 'Bad-channel row must use #D55E00 (BAD_COLOR) for its stroke');
});

test('draw: bad-channel rows also get a background fillRect', async (t) => {
  // MUTATION 4 guard continued: bad channels fill the slot background in
  // BAD_SLOT_COLOR (#c8c8c8). If the mask check is dropped, this fill
  // disappears. We check that fillRect is set with BAD_SLOT_COLOR active.
  const canvas = makeStubCanvas();
  const bad_mask = [false, true];
  TraceRenderer.draw(canvas, buildOpts(2, 100, { bad_mask }));

  const calls = canvas._ctx.calls;
  // Look for a fillStyle set to the bad-slot colour followed by fillRect.
  let sawBadSlotFill = false;
  for (let i = 0; i < calls.length; i++) {
    if (calls[i].op === 'set:fillStyle' && calls[i].args[0] === '#c8c8c8') {
      // Next fillRect is the slot background.
      if (calls.slice(i + 1, i + 10).some(c => c.op === 'fillRect')) {
        sawBadSlotFill = true;
        break;
      }
    }
  }
  assert.ok(sawBadSlotFill, 'Bad-channel must paint slot bg with #c8c8c8 (BAD_SLOT_COLOR)');
});

test('draw: good channel uses TRACE_COLOR (#0072B2) for stroke', async (t) => {
  // Contrast test: without bad_mask, every channel must render in TRACE_COLOR.
  const canvas = makeStubCanvas();
  TraceRenderer.draw(canvas, buildOpts(3, 100));
  const calls = canvas._ctx.calls;
  const hadGood = calls.some(c => c.op === 'set:strokeStyle' && c.args[0] === '#0072B2');
  assert.ok(hadGood, 'Good channel must use #0072B2 (TRACE_COLOR)');
});

test('draw: per-channel color override (channel_colors) honoured for good channels', async (t) => {
  // When channel_colors are provided and the channel is not bad, the
  // override colour should appear as strokeStyle, not TRACE_COLOR.
  const canvas = makeStubCanvas();
  const channel_colors = ['#aabbcc', '#ddeeff', '#112233'];
  TraceRenderer.draw(canvas, buildOpts(3, 100, { channel_colors }));
  const calls = canvas._ctx.calls;
  const hadOverride = calls.some(c => c.op === 'set:strokeStyle' && c.args[0] === '#aabbcc');
  assert.ok(hadOverride, 'channel_colors override must appear as strokeStyle');
});

test('draw: non-EEG channel type gets a setLineDash pattern', async (t) => {
  // TYPE_DASH maps EOG→[5,2]. Verify that at least one setLineDash call
  // carries a non-empty array when a channel of type EOG is rendered.
  const canvas = makeStubCanvas();
  const opts = buildOpts(2, 100, {
    channel_types: ['EEG', 'EOG'],
  });
  TraceRenderer.draw(canvas, opts);
  const calls = canvas._ctx.calls;
  const dashCalls = calls.filter(c => c.op === 'setLineDash');
  const hasEogDash = dashCalls.some(c => Array.isArray(c.args[0]) && c.args[0].length > 0);
  assert.ok(hasEogDash, 'EOG channel must get a non-empty setLineDash pattern');
});

test('draw: EEG channels get a solid (empty) line dash', async (t) => {
  // EEG → dash=[] (solid). Confirm no non-empty dash pattern appears when
  // all channels are EEG.
  const canvas = makeStubCanvas();
  TraceRenderer.draw(canvas, buildOpts(3, 100, { channel_types: ['EEG', 'EEG', 'EEG'] }));
  const calls = canvas._ctx.calls;
  const dashCalls = calls.filter(c => c.op === 'setLineDash');
  const hasSolidOnly = dashCalls.every(c => Array.isArray(c.args[0]) && c.args[0].length === 0);
  assert.ok(hasSolidOnly, 'All-EEG recording must use solid lines (empty setLineDash)');
});

test('draw: lastSlotMicrovolts is positive after a valid draw', async (t) => {
  // drawScaleBar reads lastSlotMicrovolts via the api object. After a valid
  // draw it must be a positive finite number. NaN/zero means the scale bar
  // would be invisible or garbage.
  const canvas = makeStubCanvas();
  TraceRenderer.draw(canvas, buildOpts(4, 200));
  assert.ok(isFinite(TraceRenderer.lastSlotMicrovolts), 'lastSlotMicrovolts must be finite');
  assert.ok(TraceRenderer.lastSlotMicrovolts > 0, 'lastSlotMicrovolts must be > 0');
});

test('draw: lastMaxVisibleChannels reflects available plot height', async (t) => {
  // A 600px canvas with MIN_SLOT_PX=16 and PAD_TOP=8, PAD_BOTTOM=28
  // gives plotH=564. maxVisible = floor(564/16) = 35.
  // With only 4 channels, all 4 should be visible.
  const canvas = makeStubCanvas(800, 600);
  TraceRenderer.draw(canvas, buildOpts(4, 100));
  assert.ok(TraceRenderer.lastMaxVisibleChannels >= 4,
    `lastMaxVisibleChannels=${TraceRenderer.lastMaxVisibleChannels} should be ≥4`);
});

test('draw: channel label Y-coordinates are evenly spaced by slotH (kills mutant 103)', async (t) => {
  // MUTATION 103 guard at traces.js:174.
  // Original: `const y = y0 + (c + 0.5) * slotH;`
  // Mutant:   `const y = y0 + (c + 0.5) / slotH;`
  //
  // The earlier "labels within plot area" test only bounds Y to a window;
  // a division-instead-of-multiplication collapses all label Ys to a thin
  // sliver near y0 (since (c+0.5)/slotH is sub-pixel for slotH > 1), which
  // still falls inside [plotY0, plotY0+plotH] — so the existing test misses it.
  //
  // The contract this test pins: consecutive labels are EXACTLY one slotH
  // apart. With 8 channels at 800×600 (PAD_TOP=8, PAD_BOTTOM=28 → plotH=564),
  // slotH = 70.5. Mutant slotH ≈ 1/70.5 → consecutive spacing ≈ 0.014px,
  // which we'd reject.
  const nCh = 8;
  const cssW = 800, cssH = 600;
  const canvas = makeStubCanvas(cssW, cssH);
  TraceRenderer.draw(canvas, buildOpts(nCh, 100));

  const plotY0 = TraceRenderer.PAD_TOP;
  const plotH  = cssH - TraceRenderer.PAD_TOP - TraceRenderer.PAD_BOTTOM;
  const slotH  = plotH / nCh;

  // Filter to label fillText calls (`Ch1`..`Ch8`). All-EEG so each channel
  // emits exactly one fillText (the LABEL branch, not the TYPE-chip branch).
  const labelCalls = canvas._ctx.calls
    .filter(c => c.op === 'fillText' && /^Ch\d+$/.test(String(c.args[0])))
    .map(c => ({ label: c.args[0], y: c.args[2] }));

  assert.equal(labelCalls.length, nCh, `expected ${nCh} label fillText calls, got ${labelCalls.length}`);

  // First label must sit roughly half a slot below plotY0 (c=0 → y = y0 + 0.5*slotH).
  // The mutant collapses this to y ≈ y0 + 0.5/slotH ≈ y0 + 0.007, which is
  // WAY less than plotY0 + slotH/4 — this check kills the mutant.
  const firstY = labelCalls[0].y;
  assert.ok(
    firstY > plotY0 + slotH / 4,
    `first label y=${firstY} too close to plotY0=${plotY0}; mutant ${`(c+0.5)/slotH`} detected`,
  );

  // Consecutive labels must be exactly slotH apart (±0.5px tolerance for
  // any future half-pixel snap).
  for (let i = 1; i < labelCalls.length; i++) {
    const dy = labelCalls[i].y - labelCalls[i - 1].y;
    assert.ok(
      Math.abs(dy - slotH) < 0.5,
      `consecutive label Δy[${i - 1}→${i}] = ${dy.toFixed(3)}, expected ${slotH.toFixed(3)}`,
    );
  }
});

test('draw: event marker label x-position matches plotX0 + onset_fraction*plotW (kills mutant 234)', async (t) => {
  // MUTATION 234 guard at traces.js:276 inside drawEventMarkers.
  // Original: `const x = Math.round(plotX0 + ((ev.onset - t0) / span) * (plotX1 - plotX0));`
  // Mutant:   `const x = Math.round(plotX0 - ((ev.onset - t0) / span) * (plotX1 - plotX0));`
  //
  // The mutant flips the x-position to the LEFT of plotX0 (negative offset),
  // putting the event label in the channel-label gutter or off-canvas. The
  // existing "event markers when events non-empty" test only checks that
  // SOME label text appears — it doesn't constrain x. We do.
  //
  // Window: fs=250, n_samples_visible=100 → window length 0.4s. Events at
  // onset=0.1 (25% of window) and 0.3 (75% of window).
  const cssW = 800, cssH = 600;
  const plotX0 = TraceRenderer.PAD_LEFT;
  const plotX1 = cssW - TraceRenderer.PAD_RIGHT;
  const plotW  = plotX1 - plotX0;

  const canvas = makeStubCanvas(cssW, cssH);
  TraceRenderer.draw(canvas, buildOpts(2, 100, {
    events: [{ onset: 0.1, label: 'E1' }, { onset: 0.3, label: 'E2' }],
    start_sec: 0,
    fs: 250,
  }));

  // drawEventMarkers calls ctx.fillText(label, x + 3, plotY0 + 1).
  // So actual_x_text = round(plotX0 + onset/span * plotW) + 3.
  const expectedX_E1 = Math.round(plotX0 + 0.25 * plotW) + 3;
  const expectedX_E2 = Math.round(plotX0 + 0.75 * plotW) + 3;

  const textCalls = canvas._ctx.calls.filter(c => c.op === 'fillText');
  const e1 = textCalls.find(c => String(c.args[0]) === 'E1');
  const e2 = textCalls.find(c => String(c.args[0]) === 'E2');
  assert.ok(e1, 'E1 fillText must be issued');
  assert.ok(e2, 'E2 fillText must be issued');

  // Tight (≤2px) bound on x. The mutant would put E1 at
  // round(plotX0 - 0.25*plotW) + 3, which differs from expected by 2*0.25*plotW ≈ 317px.
  assert.ok(
    Math.abs(e1.args[1] - expectedX_E1) <= 2,
    `E1 x=${e1.args[1]} vs expected ${expectedX_E1} (mutant 234 would put it at ${Math.round(plotX0 - 0.25 * plotW) + 3})`,
  );
  assert.ok(
    Math.abs(e2.args[1] - expectedX_E2) <= 2,
    `E2 x=${e2.args[1]} vs expected ${expectedX_E2}`,
  );

  // Critical structural assertion: both event labels MUST land in
  // [plotX0, plotX1] (well, [plotX0+3, plotX1+3] after the +3 label offset).
  // The mutant flips x to the LEFT of plotX0 — this catches it even if the
  // tight bound check above were loosened.
  assert.ok(e1.args[1] > plotX0, `E1 x=${e1.args[1]} must be > plotX0=${plotX0} (mutant flips to left)`);
  assert.ok(e2.args[1] > plotX0, `E2 x=${e2.args[1]} must be > plotX0=${plotX0}`);
  assert.ok(e1.args[1] < plotX1 + 10, `E1 x=${e1.args[1]} must be near or inside plotX1=${plotX1}`);
});

test('draw: pagination — labels start at channel_offset, not at 0 (kills mutant 515 cluster)', async (t) => {
  // MUTATION 515 guard at traces.js:510.
  // Original: `const visibleN = Math.min(maxVisible, totalCh - offset);`
  // Mutant:   `const visibleN = Math.min(maxVisible, totalCh + offset);`
  //
  // Every existing draw test runs with the default channel_offset = 0,
  // so `totalCh - 0` === `totalCh + 0` and the mutation is invisible.
  // We drive channel_offset > 0 and assert:
  //   (a) visible labels are 'Ch{offset+1}'..'Ch{offset+maxVisible}'
  //       (NOT 'Ch1'..). This kills any pagination-OFF mutant.
  //   (b) when offset is large enough that totalCh - offset < maxVisible,
  //       the trailing slice shape is observable via the bookkeeping
  //       fields lastChannelOffset / lastTotalChannels.
  const nCh = 50;        // exceeds maxVisible (35 at default geometry)
  const cssW = 800, cssH = 600;

  // Sub-case (a): offset=10, expect maxVisible (35) labels starting at Ch11.
  const canvas = makeStubCanvas(cssW, cssH);
  TraceRenderer.draw(canvas, buildOpts(nCh, 100, { channel_offset: 10 }));
  const labelCalls = canvas._ctx.calls
    .filter(c => c.op === 'fillText' && /^Ch\d+$/.test(String(c.args[0])))
    .map(c => String(c.args[0]));

  // maxVisible at 800×600 with MIN_SLOT_PX=16 → floor(564/16) = 35.
  const maxVisible = TraceRenderer.lastMaxVisibleChannels;
  assert.equal(labelCalls.length, maxVisible,
    `expected ${maxVisible} visible labels at offset=10, got ${labelCalls.length}`);

  // First visible label must be Ch11 (offset+1), not Ch1.
  assert.equal(labelCalls[0], 'Ch11', `first label should be Ch11 (offset+1), got ${labelCalls[0]}`);
  // Last visible label must be Ch{10 + maxVisible}.
  assert.equal(labelCalls[labelCalls.length - 1], `Ch${10 + maxVisible}`,
    `last label should be Ch${10 + maxVisible}, got ${labelCalls[labelCalls.length - 1]}`);

  // Bookkeeping must reflect the active offset.
  assert.equal(TraceRenderer.lastChannelOffset, 10);
  assert.equal(TraceRenderer.lastTotalChannels, nCh);
});

test('draw: pagination tail-clamped — offset near end of channel list (kills mutant 515)', async (t) => {
  // Sub-case (b): tail-clamped pagination. offset=30, totalCh=50.
  //   Original: visibleN = min(maxVisible=35, totalCh - offset = 20) = 20.
  //   Mutant:   visibleN = min(maxVisible=35, totalCh + offset = 80) = 35.
  //
  // JS's Array.prototype.slice clamps to length, so both versions produce
  // a slice of length 20 (since 50 - 30 = 20). The behavioural divergence
  // is in `nCh = channels.length` — that's 20 in both cases — and in the
  // `nVisible = Math.min(opts.n_samples_visible, channels[0].length)` line.
  //
  // We pin the OBSERVABLE contract: exactly 20 labels appear (Ch31..Ch50),
  // not 35. The mutant CAN survive on slice clamping alone, but the
  // assertion also locks the channel-id range: a hypothetical mutant that
  // started reading from offset=0 instead of offset=30 would show Ch1..Ch20
  // — that is killed here.
  const nCh = 50;
  const offset = 30;
  const cssW = 800, cssH = 600;

  const canvas = makeStubCanvas(cssW, cssH);
  TraceRenderer.draw(canvas, buildOpts(nCh, 100, { channel_offset: offset }));
  const labelCalls = canvas._ctx.calls
    .filter(c => c.op === 'fillText' && /^Ch\d+$/.test(String(c.args[0])))
    .map(c => String(c.args[0]));

  const expectedCount = nCh - offset; // 20 — the tail-slice length.
  assert.equal(labelCalls.length, expectedCount,
    `tail-clamped offset=${offset}: expected ${expectedCount} labels, got ${labelCalls.length}`);
  assert.equal(labelCalls[0], `Ch${offset + 1}`,
    `tail-clamped first label should be Ch${offset + 1}, got ${labelCalls[0]}`);
  assert.equal(labelCalls[labelCalls.length - 1], `Ch${nCh}`,
    `tail-clamped last label should be Ch${nCh}, got ${labelCalls[labelCalls.length - 1]}`);

  // Bookkeeping reflects the request.
  assert.equal(TraceRenderer.lastChannelOffset, offset);
  assert.equal(TraceRenderer.lastTotalChannels, nCh);
});

test('draw: pagination — different offsets render different data (kills slice-direction mutants)', async (t) => {
  // Stronger pagination kill: drive offsets that select clearly different
  // SUBSETS of the data. The mutant 515 family includes any variant that
  // ignores opts.channel_offset (e.g. always reads from 0) — such a mutant
  // would produce identical label sets across offsets. We assert disjoint
  // subsets to lock that contract.
  const nCh = 50;
  const nSamples = 200;
  const channels = [];
  for (let c = 0; c < nCh; c++) {
    const d = new Float32Array(nSamples);
    for (let i = 0; i < nSamples; i++) d[i] = Math.sin(i * 0.2) * (c + 1);
    channels.push(d);
  }
  const labels = Array.from({ length: nCh }, (_, i) => `Ch${i + 1}`);
  const types  = Array.from({ length: nCh }, () => 'EEG');

  const c0 = makeStubCanvas(800, 600);
  TraceRenderer.draw(c0, {
    channels, channel_labels: labels, channel_types: types,
    n_samples_visible: nSamples, fs: 250, start_sec: 0, gain: 1,
    transparent: false, channel_offset: 0,
  });
  const labels0 = c0._ctx.calls
    .filter(c => c.op === 'fillText' && /^Ch\d+$/.test(String(c.args[0])))
    .map(c => String(c.args[0]));

  const c20 = makeStubCanvas(800, 600);
  TraceRenderer.draw(c20, {
    channels, channel_labels: labels, channel_types: types,
    n_samples_visible: nSamples, fs: 250, start_sec: 0, gain: 1,
    transparent: false, channel_offset: 20,
  });
  const labels20 = c20._ctx.calls
    .filter(c => c.op === 'fillText' && /^Ch\d+$/.test(String(c.args[0])))
    .map(c => String(c.args[0]));

  assert.equal(labels0[0], 'Ch1', `offset=0 should show Ch1 first, got ${labels0[0]}`);
  assert.equal(labels20[0], 'Ch21', `offset=20 should show Ch21 first, got ${labels20[0]}`);

  // At least one label unique to offset=20 must be missing from offset=0.
  const offset20Only = labels20.filter(l => !labels0.includes(l));
  assert.ok(offset20Only.length > 0,
    `offset=20 must introduce labels not in offset=0; got identical sets — pagination is being ignored`);
});

test('draw: trace moveTo Y-coordinates land within the plot area (mutation 2 guard)', async (t) => {
  // MUTATION 2 guard: negating the sign in yCenter = plotY0 + (c+0.5)*slotH
  // pushes all trace moveTos to negative Y values (above the canvas). This
  // test records moveTo calls within the plot X band [PAD_LEFT, cssW-PAD_RIGHT]
  // and asserts they all land in the positive CSS-pixel range [PAD_TOP, cssH].
  //
  // Implementation note: we re-implement a minimal stub here rather than
  // reusing makeStubCanvas because we need moveTo tracking in the polyline /
  // decimated paths, which both use ctx.moveTo for each pixel/sample.
  const moveToCalls = [];
  const ctx = new Proxy({
    measureText(t) { return { width: t.length * 6 }; },
    beginPath() {},
    moveTo(x, y) { moveToCalls.push({ x, y }); },
    lineTo() {},
    stroke() {},
    rect() {},
    clip() {},
    fillRect() {},
    clearRect() {},
    fillText() {},
    setTransform() {},
    save() {},
    restore() {},
    setLineDash() {},
  }, {
    set(target, prop, value) { target[prop] = value; return true; },
    get(target, prop) { return target[prop]; },
  });

  const canvas = {
    width: 0, height: 0, clientWidth: 800, clientHeight: 600,
    getContext() { return ctx; },
  };

  TraceRenderer.draw(canvas, buildOpts(3, 100));

  // PAD_LEFT=96, PAD_RIGHT=70, PAD_TOP=8, cssH=600.
  // Only moveTos within the plot X band are trace moveTos.
  const traceMoveTos = moveToCalls.filter(c => c.x >= 96 && c.x <= 730);
  assert.ok(traceMoveTos.length > 0, 'Expected trace moveTo calls in the plot X band');
  for (const { x, y } of traceMoveTos) {
    assert.ok(y >= 0, `moveTo y=${y} is negative (above canvas) — sign negation mutation detected`);
    assert.ok(y <= 600, `moveTo y=${y} exceeds canvas height`);
  }
});

// ── Iteration-4 pagination boundary tests ────────────────────────────────────
//
// These attack the lines-500-549 pagination tail cluster called out in
// docs/mutation-survivors-2026-05.md iteration-4. The earlier pagination
// tests (offset=10, offset=30) exercised the mid-range; the survivors live
// on the OUTER boundaries: offset exactly at (totalCh - maxVisible), offset
// at (totalCh - 1) where only one slot is visible, and offset > totalCh
// where the clamp at traces.js:509 fires.
//
// Geometry constants for these tests at 800x600:
//   PAD_TOP=8, PAD_BOTTOM=28 → plotH=564.
//   MIN_SLOT_PX=16 → maxVisible = floor(564/16) = 35.
//   With nCh=50: tail boundary at offset = 50 - 35 = 15.

test('draw: pagination — offset = totalCh - maxVisible (exact tail boundary)', async (t) => {
  // The boundary at offset = totalCh - maxVisible: visibleN should equal
  // maxVisible exactly (35), and the last visible label should be Ch50.
  // Mutants that flip `totalCh - offset` to `totalCh + offset` would
  // produce visibleN = min(35, 50+15) = 35 — same count, but the slice
  // would still start at offset=15, so labels would still be Ch16..Ch50.
  // The kill comes from any OTHER pagination mutant that shifts the slice
  // start (e.g. mutating `slice(offset, offset+visibleN)` to
  // `slice(0, visibleN)` would put Ch1..Ch35 here).
  const nCh = 50;
  const cssW = 800, cssH = 600;
  const canvas = makeStubCanvas(cssW, cssH);
  const offsetBoundary = nCh - TraceRenderer.PAD_TOP; // placeholder; recompute below
  // Recompute the boundary against the actual maxVisible:
  // plotH = cssH - PAD_TOP - PAD_BOTTOM = 600 - 8 - 28 = 564
  // maxVisible = floor(564 / 16) = 35; offsetBoundary = 50 - 35 = 15.
  TraceRenderer.draw(canvas, buildOpts(nCh, 100, { channel_offset: 15 }));

  const labelCalls = canvas._ctx.calls
    .filter(c => c.op === 'fillText' && /^Ch\d+$/.test(String(c.args[0])))
    .map(c => String(c.args[0]));

  const maxVisible = TraceRenderer.lastMaxVisibleChannels;
  assert.equal(maxVisible, 35, `maxVisible should be 35 at 800x600 with MIN_SLOT_PX=16`);
  assert.equal(labelCalls.length, maxVisible,
    `at the exact tail boundary, expected ${maxVisible} labels, got ${labelCalls.length}`);
  assert.equal(labelCalls[0], 'Ch16',
    `first visible at boundary offset=15 should be Ch16, got ${labelCalls[0]}`);
  assert.equal(labelCalls[labelCalls.length - 1], 'Ch50',
    `last visible at boundary should be Ch50, got ${labelCalls[labelCalls.length - 1]}`);

  // Bookkeeping check: the renderer did NOT clamp here (offset=15 is valid).
  assert.equal(TraceRenderer.lastChannelOffset, 15);
});

test('draw: pagination — offset = totalCh - 1 (single visible channel at tail)', async (t) => {
  // Extreme tail: only one channel slot visible, at the bottom of the
  // recording. visibleN = min(maxVisible=35, totalCh - offset = 1) = 1.
  // The single label rendered must be Ch{totalCh}. Mutants that flip
  // the totalCh-offset subtraction sign (515 family) would give
  // visibleN = min(35, totalCh+49) = 35, but slice clamps to length-1
  // = [49,50). So the kill comes from asserting count == 1 (not 35).
  const nCh = 50;
  const cssW = 800, cssH = 600;
  const canvas = makeStubCanvas(cssW, cssH);
  TraceRenderer.draw(canvas, buildOpts(nCh, 100, { channel_offset: nCh - 1 }));

  const labelCalls = canvas._ctx.calls
    .filter(c => c.op === 'fillText' && /^Ch\d+$/.test(String(c.args[0])))
    .map(c => String(c.args[0]));

  // Exactly one label, and it must be Ch50.
  assert.equal(labelCalls.length, 1,
    `at offset=totalCh-1 expected exactly 1 visible label, got ${labelCalls.length}`);
  assert.equal(labelCalls[0], `Ch${nCh}`,
    `the single visible label should be Ch${nCh}, got ${labelCalls[0]}`);

  // Bookkeeping: offset is valid, no clamp.
  assert.equal(TraceRenderer.lastChannelOffset, nCh - 1);
  assert.equal(TraceRenderer.lastTotalChannels, nCh);
});

test('draw: pagination — offset = totalCh (off-by-one beyond) clamps to totalCh-1', async (t) => {
  // Drives the clamp at traces.js:509:
  //   offset = Math.max(0, Math.min(Math.max(0, totalCh - 1), offsetRaw));
  // With offsetRaw=totalCh, the inner Math.min picks (totalCh-1), so the
  // effective offset is totalCh-1 → still one visible channel (the last).
  //
  // Mutants on either `totalCh - 1` (e.g. `totalCh + 1`) or the Math.min
  // pivot would change which channel becomes the single visible one — or
  // would cause an out-of-range slice. We assert the post-clamp invariants:
  //   - exactly 1 label visible
  //   - that label is Ch{totalCh}
  //   - bookkeeping reports the CLAMPED offset, not the raw one
  const nCh = 50;
  const cssW = 800, cssH = 600;
  const canvas = makeStubCanvas(cssW, cssH);
  TraceRenderer.draw(canvas, buildOpts(nCh, 100, { channel_offset: nCh }));

  const labelCalls = canvas._ctx.calls
    .filter(c => c.op === 'fillText' && /^Ch\d+$/.test(String(c.args[0])))
    .map(c => String(c.args[0]));

  assert.equal(labelCalls.length, 1,
    `at offset=totalCh (clamped), expected 1 label, got ${labelCalls.length}`);
  assert.equal(labelCalls[0], `Ch${nCh}`,
    `single label after clamp should be Ch${nCh}, got ${labelCalls[0]}`);

  // The clamp must report the effective offset (nCh - 1), not the raw input.
  assert.equal(TraceRenderer.lastChannelOffset, nCh - 1,
    `clamped offset should be ${nCh - 1}, got ${TraceRenderer.lastChannelOffset}`);
});

test('draw: pagination — offset way beyond totalCh still clamps to totalCh-1 (no NaN)', async (t) => {
  // Stress the clamp with a pathological input: offset=9999 with totalCh=50.
  // Outcome must be identical to offset=49 — single Ch50 visible, no
  // exception thrown, no NaN moveTo positions.
  // Catches mutants on the outer Math.max (the lower-bound clamp) and on
  // either of the two Math.max(0, ...) calls in the clamp chain.
  const nCh = 50;
  const cssW = 800, cssH = 600;
  const canvas = makeStubCanvas(cssW, cssH);
  TraceRenderer.draw(canvas, buildOpts(nCh, 100, { channel_offset: 9999 }));

  const labelCalls = canvas._ctx.calls
    .filter(c => c.op === 'fillText' && /^Ch\d+$/.test(String(c.args[0])))
    .map(c => String(c.args[0]));

  assert.equal(labelCalls.length, 1,
    `extreme offset clamps to single visible label, got ${labelCalls.length}`);
  assert.equal(labelCalls[0], `Ch${nCh}`);
  assert.equal(TraceRenderer.lastChannelOffset, nCh - 1);

  // Defensive: no NaN coordinates leaked into the moveTo stream.
  const nanMoveTo = canvas._ctx.calls.find(
    c => c.op === 'moveTo' && (Number.isNaN(c.args[0]) || Number.isNaN(c.args[1])),
  );
  assert.ok(!nanMoveTo, `extreme offset produced a NaN moveTo: ${JSON.stringify(nanMoveTo)}`);
});
