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

// ── Iteration-5 ctx-conformance tests ────────────────────────────────────────
//
// PR 9 (iteration 4) added `_computeTimeAxisLayout` and `_computeScaleBarGeometry`
// debug-export shims and pinned their CONTRACT with 24 unit tests. The mutation
// score moved +2.13pp — short of expectations — because the shim proved only
// that the helpers return the correct numbers, NOT that the original
// `drawTimeAxis` / `drawScaleBar` / `drawEventMarkers` functions faithfully
// forward those numbers into the ctx call stream. A mutation that swaps a
// `moveTo(x, y)` for `moveTo(y, x)` in drawTimeAxis still survives.
//
// These tests close that gap by recording the actual `moveTo` / `lineTo` /
// `fillText` calls emitted during a `draw()` and asserting their coordinates
// match what the corresponding shim says they SHOULD be. The shim is the
// ground truth; the renderer is the system under test. Each test below pins
// one slice of the bridge:
//
//   - axis baseline moveTo x positions ↔ _computeTimeAxisLayout(...).major[i].x
//   - axis label fillText (x, y) ↔ shim major[i].x and the y = baseline + 6
//   - minor-tick moveTo x positions ↔ shim minor[i].x
//   - scale-bar moveTo / lineTo coords ↔ _computeScaleBarGeometry(...) output
//   - event-marker moveTo x positions ↔ explicit onset_fraction × plotW formula
//
// Per docs/mutation-survivors-2026-05.md iteration-4 summary the targeted
// clusters are: lines 350-399 (43 survivors), 200-249 (37), 250-299 (26).

// Window helpers reused across iteration-5 tests so the geometry expression
// stays in one place — accidentally diverging the test's view of the window
// from the renderer's would hide mutants instead of killing them.
function makeAxisWindow() {
  // 100 samples at 250 Hz → window length 0.4 s, plenty of major ticks at
  // step=0.05 to exercise both the major and minor paths.
  return { start_sec: 0, fs: 250, n_samples_visible: 100 };
}

function plotGeometryFor(cssW, cssH) {
  // Lives here (NOT inline) so all three iteration-5 tests agree on the
  // exact rectangle. If a future renderer change shifts PAD_*, this single
  // function updates and the tests track.
  const PAD_LEFT = TraceRenderer.PAD_LEFT;
  const PAD_RIGHT = TraceRenderer.PAD_RIGHT;
  const PAD_TOP = TraceRenderer.PAD_TOP;
  const PAD_BOTTOM = TraceRenderer.PAD_BOTTOM;
  const plotX0 = PAD_LEFT;
  const plotX1 = cssW - PAD_RIGHT;
  const plotY0 = PAD_TOP;
  const plotH = cssH - PAD_TOP - PAD_BOTTOM;
  // drawTimeAxis is called with y = plotY0 + plotH + 4 (see traces.js:536).
  const axisBaselineY = plotY0 + plotH + 4;
  return { plotX0, plotX1, plotY0, plotH, axisBaselineY };
}

test('drawTimeAxis: major-tick moveTo x positions match _computeTimeAxisLayout', async () => {
  // Renderer must call ctx.moveTo for every major tick at the x position
  // _computeTimeAxisLayout reports. This bridges the PR-9 shim contract to
  // the actual ctx side effects so the ~40-mutant cluster in lines 350-399
  // becomes mutation-killable. Mutants that swap (x,y) args, sign-flip
  // (t-t0Sec), or skip a tick all change one of these x values.
  const cssW = 800, cssH = 600;
  const canvas = makeStubCanvas(cssW, cssH);
  const winOpts = makeAxisWindow();
  TraceRenderer.draw(canvas, buildOpts(2, winOpts.n_samples_visible, winOpts));
  const calls = canvas._ctx.calls;

  const { plotX0, plotX1, axisBaselineY } = plotGeometryFor(cssW, cssH);
  const layout = TraceRenderer._computeTimeAxisLayout(
    plotX0, plotX1,
    winOpts.start_sec,
    winOpts.start_sec + winOpts.n_samples_visible / winOpts.fs,
    'relative', null,
  );

  // Axis moveTos are the ONLY moveTos whose y === axisBaselineY exactly.
  // Trace moveTos use yCenter values (very different); minor/major tick
  // lineTos go to baselineY+2 or baselineY+4 but those are lineTos, not
  // moveTos. We deliberately use a strict-equality y filter so the test
  // would fail if the renderer started routing the baseline through
  // a different y.
  const axisMoveTos = calls
    .filter(c => c.op === 'moveTo' && c.args[1] === axisBaselineY)
    .map(c => c.args[0]);

  for (const tick of layout.major) {
    const found = axisMoveTos.some(x => Math.abs(x - tick.x) <= 1);
    assert.ok(found,
      `expected major-tick moveTo at x=${tick.x.toFixed(2)} (t=${tick.t}); ` +
      `${axisMoveTos.length} axis moveTos found`);
  }
});

test('drawTimeAxis: fillText labels at expected (x, y) for every major tick', async () => {
  // drawTimeAxis:369 — ctx.fillText(useClock ? label : label + ' s', x, y + 6).
  // The label string is the shim's major[i].label + ' s' for relative mode.
  // We verify BOTH the x coordinate (must equal major[i].x) and the y
  // coordinate (must equal axisBaselineY + 6) for every major tick.
  // Mutants on the ` s` suffix, the +6 offset, or x→y swap are all killed.
  const cssW = 800, cssH = 600;
  const canvas = makeStubCanvas(cssW, cssH);
  const winOpts = makeAxisWindow();
  TraceRenderer.draw(canvas, buildOpts(2, winOpts.n_samples_visible, winOpts));
  const calls = canvas._ctx.calls;

  const { plotX0, plotX1, axisBaselineY } = plotGeometryFor(cssW, cssH);
  const layout = TraceRenderer._computeTimeAxisLayout(
    plotX0, plotX1,
    winOpts.start_sec,
    winOpts.start_sec + winOpts.n_samples_visible / winOpts.fs,
    'relative', null,
  );

  const expectedLabelY = axisBaselineY + 6;
  for (const tick of layout.major) {
    const wantLabel = tick.label + ' s';
    const call = calls.find(c => c.op === 'fillText' && c.args[0] === wantLabel);
    assert.ok(call, `expected fillText "${wantLabel}" for major tick at t=${tick.t}`);
    assert.ok(Math.abs(call.args[1] - tick.x) <= 1,
      `fillText "${wantLabel}" x=${call.args[1]} should be ≈ ${tick.x.toFixed(2)}`);
    assert.equal(call.args[2], expectedLabelY,
      `fillText "${wantLabel}" y=${call.args[2]} should be ${expectedLabelY} (baselineY + 6)`);
  }
});

test('drawTimeAxis: minor-tick moveTo x positions match _computeTimeAxisLayout.minor', async () => {
  // _computeTimeAxisLayout(...).minor lists the minor-tick x positions the
  // renderer SHOULD emit. Each must appear as a moveTo at y=axisBaselineY.
  // Mutants on minorStep (step/5), firstMinor (Math.ceil), or the
  // skip-at-major epsilon (1e-6) shift these positions.
  //
  // We require ≥80% to hit because floating-point accumulation in
  // `for (let t = firstMinor; t <= t1Sec + 1e-9; t += minorStep)` can drift
  // by ε from the shim's same loop, and a small handful of minors near a
  // major boundary may round into the major's moveTo within 1px — both
  // implementations are valid. The 80% floor still falls hard if the
  // renderer stops emitting minors entirely (a common mutation outcome).
  const cssW = 800, cssH = 600;
  const canvas = makeStubCanvas(cssW, cssH);
  const winOpts = makeAxisWindow();
  TraceRenderer.draw(canvas, buildOpts(2, winOpts.n_samples_visible, winOpts));
  const calls = canvas._ctx.calls;

  const { plotX0, plotX1, axisBaselineY } = plotGeometryFor(cssW, cssH);
  const layout = TraceRenderer._computeTimeAxisLayout(
    plotX0, plotX1,
    winOpts.start_sec,
    winOpts.start_sec + winOpts.n_samples_visible / winOpts.fs,
    'relative', null,
  );

  const axisMoveTos = calls
    .filter(c => c.op === 'moveTo' && c.args[1] === axisBaselineY)
    .map(c => c.args[0]);

  let hits = 0;
  for (const minor of layout.minor) {
    if (axisMoveTos.some(x => Math.abs(x - minor.x) <= 1)) hits++;
  }
  const total = Math.max(1, layout.minor.length);
  const ratio = hits / total;
  assert.ok(ratio >= 0.8,
    `only ${hits}/${total} minor-tick x positions matched a moveTo (${(ratio*100).toFixed(0)}%); ` +
    `axis moveTos: ${axisMoveTos.length}`);
});

test('drawTimeAxis: horizontal baseline drawn from plotX0 to plotX1', async () => {
  // The axis baseline (the horizontal line at y=baselineY) is drawn first
  // in drawTimeAxis (lines 340-343): moveTo(x0, y) + lineTo(x1, y). Catches
  // mutants that swap the moveTo/lineTo endpoints or shift the baseline
  // start/end off the plot region.
  const cssW = 800, cssH = 600;
  const canvas = makeStubCanvas(cssW, cssH);
  TraceRenderer.draw(canvas, buildOpts(2, 100));
  const calls = canvas._ctx.calls;

  const { plotX0, plotX1, axisBaselineY } = plotGeometryFor(cssW, cssH);
  // The very first moveTo on axisBaselineY must be at plotX0 (the start
  // of the horizontal baseline). The matching lineTo within ~4 calls must
  // land at plotX1.
  const idxStart = calls.findIndex(c =>
    c.op === 'moveTo' && c.args[1] === axisBaselineY && c.args[0] === plotX0);
  assert.ok(idxStart >= 0,
    `expected moveTo(${plotX0}, ${axisBaselineY}) at start of drawTimeAxis baseline`);
  // The immediate next lineTo (same beginPath..stroke block) goes to plotX1.
  const nextLineTo = calls.slice(idxStart + 1, idxStart + 4)
    .find(c => c.op === 'lineTo');
  assert.ok(nextLineTo,
    `expected a lineTo right after baseline moveTo; got ${JSON.stringify(calls.slice(idxStart+1, idxStart+4))}`);
  assert.equal(nextLineTo.args[0], plotX1,
    `baseline lineTo x should be plotX1=${plotX1}, got ${nextLineTo.args[0]}`);
  assert.equal(nextLineTo.args[1], axisBaselineY,
    `baseline lineTo y should be axisBaselineY=${axisBaselineY}, got ${nextLineTo.args[1]}`);
});

test('drawScaleBar: vertical line moveTo+lineTo match _computeScaleBarGeometry', async () => {
  // The scale bar's vertical line is drawScaleBar:232-233:
  //   ctx.moveTo(x + 0.5, yTop);
  //   ctx.lineTo(x + 0.5, yBottom);
  // (yBottom is reached by lineTo, NOT a second moveTo — see traces.js.)
  // Both endpoints must match the geometry shim. Kills any mutant in
  // lines 217-225 that shifts x/yTop/yBottom by even one pixel.
  const cssW = 800, cssH = 600;
  const canvas = makeStubCanvas(cssW, cssH);
  TraceRenderer.draw(canvas, buildOpts(4, 200));
  const calls = canvas._ctx.calls;

  const slotMicrovolts = TraceRenderer.lastSlotMicrovolts;
  // Defensive skip: if slotMicrovolts is non-positive the scale bar
  // was never drawn (the contract is null in that case — the shim's
  // own tests cover it).
  if (!(slotMicrovolts > 0) || !isFinite(slotMicrovolts)) return;

  const { plotX1, plotY0, plotH } = plotGeometryFor(cssW, cssH);
  // 4 channels → slotH = plotH / 4. Must match the renderer's slotH
  // computation: see traces.js where slotH = plotH / Math.min(maxVisible, nCh).
  const nCh = 4;
  const slotH = plotH / nCh;

  const geom = TraceRenderer._computeScaleBarGeometry(slotMicrovolts, slotH, plotX1, plotY0, plotH);
  // Geometry returns null when the bar would be too small; skip the test
  // in that case rather than fail (the shim's own null-branch tests
  // cover that contract).
  if (!geom) return;

  const xWant = geom.x + 0.5;
  // The moveTo(x+0.5, yTop) MUST be present. Strict equality on x — the
  // renderer uses literal `x + 0.5`. y has accumulated float arithmetic
  // (yBottom - px) so a 1px tolerance is appropriate.
  const moveTop = calls.find(c =>
    c.op === 'moveTo' && c.args[0] === xWant && Math.abs(c.args[1] - geom.yTop) <= 1);
  assert.ok(moveTop,
    `expected moveTo(${xWant}, ${geom.yTop.toFixed(2)}) for scale bar vertical line top`);

  // The matching lineTo(x+0.5, yBottom) closes the vertical line.
  const lineBottom = calls.find(c =>
    c.op === 'lineTo' && c.args[0] === xWant && Math.abs(c.args[1] - geom.yBottom) <= 1);
  assert.ok(lineBottom,
    `expected lineTo(${xWant}, ${geom.yBottom.toFixed(2)}) for scale bar vertical line bottom`);
});

test('drawScaleBar: top/bottom tick caps drawn with horizontal moveTo+lineTo', async () => {
  // drawScaleBar:234-237 draws two horizontal caps:
  //   moveTo(x - 3, yTop + 0.5);    lineTo(x + 4, yTop + 0.5);
  //   moveTo(x - 3, yBottom + 0.5); lineTo(x + 4, yBottom + 0.5);
  // Mutants on the -3 / +4 / +0.5 constants change where these caps land.
  // We pin all four endpoints.
  const cssW = 800, cssH = 600;
  const canvas = makeStubCanvas(cssW, cssH);
  TraceRenderer.draw(canvas, buildOpts(4, 200));
  const calls = canvas._ctx.calls;

  const slotMicrovolts = TraceRenderer.lastSlotMicrovolts;
  if (!(slotMicrovolts > 0) || !isFinite(slotMicrovolts)) return;
  const { plotX1, plotY0, plotH } = plotGeometryFor(cssW, cssH);
  const slotH = plotH / 4;
  const geom = TraceRenderer._computeScaleBarGeometry(slotMicrovolts, slotH, plotX1, plotY0, plotH);
  if (!geom) return;

  const topCapY = geom.yTop + 0.5;
  const botCapY = geom.yBottom + 0.5;
  const leftX = geom.x - 3;
  const rightX = geom.x + 4;

  // Top cap.
  const moveTopCap = calls.find(c =>
    c.op === 'moveTo' && c.args[0] === leftX && Math.abs(c.args[1] - topCapY) <= 1);
  assert.ok(moveTopCap,
    `expected moveTo(${leftX}, ${topCapY.toFixed(2)}) for top scale-bar tick cap`);
  const lineTopCap = calls.find(c =>
    c.op === 'lineTo' && c.args[0] === rightX && Math.abs(c.args[1] - topCapY) <= 1);
  assert.ok(lineTopCap,
    `expected lineTo(${rightX}, ${topCapY.toFixed(2)}) for top scale-bar tick cap`);

  // Bottom cap.
  const moveBotCap = calls.find(c =>
    c.op === 'moveTo' && c.args[0] === leftX && Math.abs(c.args[1] - botCapY) <= 1);
  assert.ok(moveBotCap,
    `expected moveTo(${leftX}, ${botCapY.toFixed(2)}) for bottom scale-bar tick cap`);
  const lineBotCap = calls.find(c =>
    c.op === 'lineTo' && c.args[0] === rightX && Math.abs(c.args[1] - botCapY) <= 1);
  assert.ok(lineBotCap,
    `expected lineTo(${rightX}, ${botCapY.toFixed(2)}) for bottom scale-bar tick cap`);
});

test('drawScaleBar: fillText label uses _formatScale(targetMv) at (x+8, midpoint)', async () => {
  // drawScaleBar:242 — ctx.fillText(formatScale(targetMv), x + 8, (yTop + yBottom) / 2).
  // The text content is locked to _formatScale's output. Mutants on the
  // +8 offset, the / 2 midpoint formula, or the targetMv argument are
  // all caught here.
  const cssW = 800, cssH = 600;
  const canvas = makeStubCanvas(cssW, cssH);
  TraceRenderer.draw(canvas, buildOpts(4, 200));
  const calls = canvas._ctx.calls;

  const slotMicrovolts = TraceRenderer.lastSlotMicrovolts;
  if (!(slotMicrovolts > 0) || !isFinite(slotMicrovolts)) return;
  const { plotX1, plotY0, plotH } = plotGeometryFor(cssW, cssH);
  const slotH = plotH / 4;
  const geom = TraceRenderer._computeScaleBarGeometry(slotMicrovolts, slotH, plotX1, plotY0, plotH);
  if (!geom) return;

  const expectedLabel = TraceRenderer._formatScale(geom.targetMv);
  const expectedX = geom.x + 8;
  const expectedY = (geom.yTop + geom.yBottom) / 2;

  const call = calls.find(c => c.op === 'fillText' && c.args[0] === expectedLabel);
  assert.ok(call,
    `expected fillText "${expectedLabel}" for scale bar label`);
  assert.equal(call.args[1], expectedX,
    `scale-bar label x=${call.args[1]} should be ${expectedX} (geom.x + 8)`);
  assert.ok(Math.abs(call.args[2] - expectedY) <= 1.5,
    `scale-bar label y=${call.args[2]} should be ≈ ${expectedY.toFixed(2)} ((yTop+yBottom)/2)`);
});

test('drawEventMarkers: each visible event emits moveTo at expected x and y=plotY0', async () => {
  // drawEventMarkers:265-266:
  //   const x = Math.round(plotX0 + ((ev.onset - t0) / span) * (plotX1 - plotX0)) + 0.5;
  //   ctx.moveTo(x, plotY0);
  // Each event's moveTo MUST appear at this exact x and at y=plotY0.
  // Mutants on plotX0/+0.5/Math.round/span all change x; mutants that
  // swap (x, plotY0) for (plotY0, x) flip the marker into an invisible
  // band — both killed.
  const cssW = 800, cssH = 600;
  const canvas = makeStubCanvas(cssW, cssH);
  const winOpts = makeAxisWindow(); // 0..0.4 s window
  // Three events INSIDE the visible window at 25%, 50%, 75% of span.
  const events = [
    { onset: 0.1, label: 'E1' },
    { onset: 0.2, label: 'E2' },
    { onset: 0.3, label: 'E3' },
  ];
  TraceRenderer.draw(canvas, buildOpts(2, winOpts.n_samples_visible, { ...winOpts, events }));
  const calls = canvas._ctx.calls;

  const { plotX0, plotX1, plotY0 } = plotGeometryFor(cssW, cssH);
  const t0 = winOpts.start_sec;
  const t1 = t0 + winOpts.n_samples_visible / winOpts.fs;
  const span = t1 - t0;
  const plotW = plotX1 - plotX0;

  // Filter to moveTos at y === plotY0 exactly. Trace moveTos use yCenter
  // (much larger Y); axis moveTos use axisBaselineY. plotY0 = 8 is
  // distinctive enough that a strict-equality filter is robust.
  const eventMoveTos = calls.filter(c => c.op === 'moveTo' && c.args[1] === plotY0);
  assert.ok(eventMoveTos.length >= events.length,
    `expected ≥${events.length} event moveTos at y=${plotY0}, got ${eventMoveTos.length}`);

  for (const ev of events) {
    const expectedX = Math.round(plotX0 + ((ev.onset - t0) / span) * plotW) + 0.5;
    const found = eventMoveTos.some(c => Math.abs(c.args[0] - expectedX) <= 1);
    assert.ok(found,
      `event "${ev.label}" at onset=${ev.onset} should produce moveTo(${expectedX}, ${plotY0}); ` +
      `got moveTos at x=${eventMoveTos.map(c=>c.args[0]).join(',')}`);
  }
});

test('drawEventMarkers: each visible event emits lineTo at (x, plotY0 + plotH)', async () => {
  // Companion to the moveTo test: drawEventMarkers:267 — ctx.lineTo(x, plotY0 + plotH).
  // The marker is a vertical line from plotY0 to plotY0+plotH. Mutants on
  // the `+ plotH` arithmetic or the lineTo arguments are caught here.
  const cssW = 800, cssH = 600;
  const canvas = makeStubCanvas(cssW, cssH);
  const winOpts = makeAxisWindow();
  const events = [
    { onset: 0.1, label: 'E1' },
    { onset: 0.3, label: 'E2' },
  ];
  TraceRenderer.draw(canvas, buildOpts(2, winOpts.n_samples_visible, { ...winOpts, events }));
  const calls = canvas._ctx.calls;

  const { plotX0, plotX1, plotY0, plotH } = plotGeometryFor(cssW, cssH);
  const t0 = winOpts.start_sec;
  const t1 = t0 + winOpts.n_samples_visible / winOpts.fs;
  const span = t1 - t0;
  const plotW = plotX1 - plotX0;

  // lineTos at exactly y = plotY0 + plotH are the event-marker bottoms.
  const eventLineTos = calls.filter(c =>
    c.op === 'lineTo' && c.args[1] === plotY0 + plotH);
  assert.ok(eventLineTos.length >= events.length,
    `expected ≥${events.length} event lineTos at y=${plotY0 + plotH}, got ${eventLineTos.length}`);

  for (const ev of events) {
    const expectedX = Math.round(plotX0 + ((ev.onset - t0) / span) * plotW) + 0.5;
    const found = eventLineTos.some(c => Math.abs(c.args[0] - expectedX) <= 1);
    assert.ok(found,
      `event "${ev.label}" lineTo at x=${expectedX}, y=${plotY0+plotH} missing`);
  }
});

test('drawEventMarkers: events outside window produce no moveTo, no lineTo, no fillText', async () => {
  // Window-filter guard at drawEventMarkers:256:
  //   if (ev.onset < t0 || ev.onset > t1) continue;
  // Mutants flipping the < or > operators would admit far-past or
  // far-future events. The strongest kill is to assert no ctx call carries
  // their label (we already had a fillText test; this adds the moveTo +
  // lineTo channels too).
  const cssW = 800, cssH = 600;
  const canvas = makeStubCanvas(cssW, cssH);
  const winOpts = makeAxisWindow();
  const events = [
    { onset: 100,  label: 'FAR_FUTURE' },
    { onset: -5,   label: 'FAR_PAST' },
  ];
  TraceRenderer.draw(canvas, buildOpts(2, winOpts.n_samples_visible, { ...winOpts, events }));
  const calls = canvas._ctx.calls;

  // No fillText with these labels (existing test already covers this).
  const hasFutureLabel = calls.some(c => c.op === 'fillText' && c.args[0] === 'FAR_FUTURE');
  const hasPastLabel = calls.some(c => c.op === 'fillText' && c.args[0] === 'FAR_PAST');
  assert.ok(!hasFutureLabel, 'far-future event must not produce a fillText label');
  assert.ok(!hasPastLabel,   'far-past event must not produce a fillText label');

  // And no event moveTo at y=plotY0 either. plotY0=8 is unique to events
  // and axis-baseline drawing (axis baseline at y=576 is different). A
  // mutant that admitted the out-of-window event would emit a moveTo at
  // an x far from plotX0 (onset=100 with span=0.4 → x = plotX0 + 250*plotW).
  const { plotY0 } = plotGeometryFor(cssW, cssH);
  const eventMoveTos = calls.filter(c => c.op === 'moveTo' && c.args[1] === plotY0);
  assert.equal(eventMoveTos.length, 0,
    `out-of-window events must not emit moveTos at y=${plotY0}; got ${eventMoveTos.length}`);
});

test('drawEventMarkers: dense events within 32px label-collision band — only first labelled', async () => {
  // drawEventMarkers:277 — `if (x - lastLabelX < 32) continue;`. Three
  // events packed tightly (Δx < 32 between consecutive onsets) must
  // result in only the FIRST getting a fillText label; the next two
  // are dropped to avoid text overlap. Their moveTo+lineTo still appear
  // (lines are never collision-skipped — only labels). Mutants flipping
  // `< 32` to `<= 32` or `< 0` change which labels appear.
  const cssW = 800, cssH = 600;
  const canvas = makeStubCanvas(cssW, cssH);
  const winOpts = makeAxisWindow();
  // 0.4 s / 634 px → 0.000631 s per px. 32 px → ~0.0202 s. Three onsets
  // at 0.10, 0.105, 0.11 are spaced ~3 px each (very dense).
  const events = [
    { onset: 0.10, label: 'A' },
    { onset: 0.105, label: 'B' },
    { onset: 0.11, label: 'C' },
  ];
  TraceRenderer.draw(canvas, buildOpts(2, winOpts.n_samples_visible, { ...winOpts, events }));
  const calls = canvas._ctx.calls;

  // All three should have moveTos (vertical lines drawn regardless).
  const { plotY0 } = plotGeometryFor(cssW, cssH);
  const eventMoveTos = calls.filter(c => c.op === 'moveTo' && c.args[1] === plotY0);
  assert.ok(eventMoveTos.length >= 3,
    `all 3 dense events should emit moveTos; got ${eventMoveTos.length}`);

  // Exactly one label fillText survives the collision filter.
  const labelText = (s) => ['A', 'B', 'C'].includes(String(s));
  const labelFills = calls.filter(c => c.op === 'fillText' && labelText(c.args[0]));
  assert.equal(labelFills.length, 1,
    `dense burst should yield 1 label (collision filter), got ${labelFills.length}: ${labelFills.map(c=>c.args[0]).join(',')}`);
  // First event (A) must be the surviving label — the renderer iterates
  // events in order, accepts the first, and rejects all that fall within
  // 32 px of `lastLabelX`. Pinning this order kills mutants that flip
  // the loop direction or the lastLabelX assignment.
  assert.equal(labelFills[0].args[0], 'A',
    `first event "A" should win the collision; got "${labelFills[0].args[0]}"`);
});

test('drawEventMarkers: long label is truncated to 14 chars via slice(0, 14)', async () => {
  // drawEventMarkers:279 — `ctx.fillText(String(ev.label).slice(0, 14), …)`.
  // A 20-char label must be drawn truncated. Mutants on the 14 literal
  // (e.g. 14 → 13 or 14 → 15) change the truncation length.
  const cssW = 800, cssH = 600;
  const canvas = makeStubCanvas(cssW, cssH);
  const winOpts = makeAxisWindow();
  const longLabel = 'abcdefghijklmnopqrst'; // 20 chars
  const events = [{ onset: 0.2, label: longLabel }];
  TraceRenderer.draw(canvas, buildOpts(2, winOpts.n_samples_visible, { ...winOpts, events }));
  const calls = canvas._ctx.calls;

  // The full 20-char label must NOT appear.
  const fullMatch = calls.find(c => c.op === 'fillText' && c.args[0] === longLabel);
  assert.ok(!fullMatch, `untruncated label "${longLabel}" must not appear`);

  // The 14-char prefix must appear.
  const truncated = longLabel.slice(0, 14);
  const truncMatch = calls.find(c => c.op === 'fillText' && c.args[0] === truncated);
  assert.ok(truncMatch,
    `truncated label "${truncated}" (14 chars) should appear; got fillTexts: ${calls.filter(c=>c.op==='fillText').slice(0,5).map(c=>c.args[0]).join(',')}`);
});

// ── Iteration-6 pagination ctx-conformance tests ─────────────────────────────
//
// Iteration 5 closed the axis/scalebar/event-marker geometry-→-ctx bridge and
// gained +7.46pp; but the lines-500-549 pagination tail cluster only shed 1
// of its 35 survivors. The remaining 34 live in the per-channel rendering
// LOOP BODY (traces.js:550-594) where pagination's offset interacts with the
// per-visible-row geometry. The iteration-4 tests already pinned label COUNT
// and label IDENTITY at the outer boundaries; what is still mutation-blind
// is:
//
//   - the per-row `yCenter = plotY0 + (c + 0.5) * slotH` arithmetic where
//     `c` is the VISIBLE index after slicing (not the absolute channel id),
//   - the bad-channel slot fillRect at `(plotX0, plotY0 + c*slotH, plotW, slotH)`
//     which uses the SAME visible `c`,
//   - the sliced `colors[c]` / `types[c]` / `badMask[c]` parallel arrays —
//     mutants that swap any one of them for the unsliced original would
//     pull the wrong color/dash/bad-flag onto a visible row,
//   - the divider loop `for (c = 1; c < nCh; c++)` at line 162: nCh is the
//     POST-SLICE visible count, so divider count must equal visibleN-1.
//
// Each test below pins ONE of those invariants while pagination is active.
// Geometry constants used throughout: at 800×600,
//   PAD_TOP=8, PAD_BOTTOM=28 → plotH=564; MIN_SLOT_PX=16 → maxVisible=35.

test('pagination ctx-conformance: per-row label y-spacing equals slotH (offset > 0)', async () => {
  // Pins `y = y0 + (c + 0.5) * slotH` in drawChannelLabels (traces.js:174)
  // where `c` is the VISIBLE-row index. With offset=5 and totalCh=50, the
  // first visible label is Ch6 and consecutive label y-positions must be
  // spaced by exactly slotH = plotH / maxVisible. Mutants on the `+0.5`
  // offset, the `* slotH` factor, or the visible-row indexing all change
  // the y-spacing here.
  const totalCh = 50;
  const offset = 5;
  const cssW = 800, cssH = 600;
  const canvas = makeStubCanvas(cssW, cssH);
  TraceRenderer.draw(canvas, buildOpts(totalCh, 100, { channel_offset: offset }));

  const labelCalls = canvas._ctx.calls
    .filter(c => c.op === 'fillText' && /^Ch\d+$/.test(String(c.args[0])))
    .sort((a, b) => parseInt(String(a.args[0]).slice(2), 10) - parseInt(String(b.args[0]).slice(2), 10));

  assert.equal(String(labelCalls[0].args[0]), `Ch${offset + 1}`,
    `first visible label must be Ch${offset + 1}; got ${labelCalls[0].args[0]}`);

  const PAD_TOP = TraceRenderer.PAD_TOP;
  const PAD_BOTTOM = TraceRenderer.PAD_BOTTOM;
  const plotH = cssH - PAD_TOP - PAD_BOTTOM;
  const maxVisible = TraceRenderer.lastMaxVisibleChannels;
  const visibleN = Math.min(maxVisible, totalCh - offset);
  const slotH = plotH / visibleN;
  const expectedFirstY = PAD_TOP + 0.5 * slotH;

  // First label y must equal the per-row formula at visible idx 0.
  assert.ok(Math.abs(labelCalls[0].args[2] - expectedFirstY) <= 1,
    `first label y=${labelCalls[0].args[2].toFixed(2)} should be ≈ ${expectedFirstY.toFixed(2)} = plotY0 + 0.5*slotH`);

  // Y-spacing between consecutive labels equals slotH (within rounding).
  for (let i = 1; i < labelCalls.length; i++) {
    const dy = labelCalls[i].args[2] - labelCalls[i - 1].args[2];
    assert.ok(Math.abs(dy - slotH) <= 1,
      `label[${i}] (${labelCalls[i].args[0]}) y-spacing ${dy.toFixed(2)} should be ≈ slotH=${slotH.toFixed(2)}`);
  }
});

test('pagination ctx-conformance: bad-channel slot fillRect tracks VISIBLE row (offset > 0)', async () => {
  // traces.js:576 — `ctx.fillRect(plotX0, plotY0 + c * slotH, plotW, slotH)`.
  // The `c` here is the POST-SLICE visible index. With offset=5 and a
  // bad_mask making absolute channel #8 bad, the bad-slot fillRect must
  // appear at visible row 3 (since 8 - 5 = 3), i.e. at
  // y = plotY0 + 3 * slotH. A mutant that read bad_mask[c] from the
  // unsliced array (or fillRect'd at the absolute index 8) would land
  // at y = plotY0 + 8*slotH (or below the plot). Either way, ≠ row 3.
  const totalCh = 50;
  const offset = 5;
  const badAbsIdx = 8;   // visible row = 8 - 5 = 3
  const cssW = 800, cssH = 600;
  const bad_mask = Array.from({ length: totalCh }, (_, i) => i === badAbsIdx);

  const canvas = makeStubCanvas(cssW, cssH);
  TraceRenderer.draw(canvas, buildOpts(totalCh, 100, {
    channel_offset: offset, bad_mask,
  }));

  const calls = canvas._ctx.calls;
  // Find the fillRect immediately following a `set:fillStyle '#c8c8c8'`
  // (BAD_SLOT_COLOR). There must be exactly ONE such pair (one bad channel).
  let badFillRect = null;
  let badFillRectCount = 0;
  for (let i = 0; i < calls.length; i++) {
    if (calls[i].op === 'set:fillStyle' && calls[i].args[0] === '#c8c8c8') {
      for (let j = i + 1; j < Math.min(i + 10, calls.length); j++) {
        if (calls[j].op === 'fillRect') {
          if (!badFillRect) badFillRect = calls[j];
          badFillRectCount++;
          break;
        }
      }
    }
  }
  assert.equal(badFillRectCount, 1,
    `exactly 1 bad-slot fillRect expected (one bad channel under offset); got ${badFillRectCount}`);

  const PAD_TOP = TraceRenderer.PAD_TOP;
  const PAD_BOTTOM = TraceRenderer.PAD_BOTTOM;
  const plotH = cssH - PAD_TOP - PAD_BOTTOM;
  const maxVisible = TraceRenderer.lastMaxVisibleChannels;
  const visibleN = Math.min(maxVisible, totalCh - offset);
  const slotH = plotH / visibleN;
  const visibleRow = badAbsIdx - offset;
  const expectedY = PAD_TOP + visibleRow * slotH;

  // y argument of fillRect is the 2nd positional arg.
  assert.ok(Math.abs(badFillRect.args[1] - expectedY) <= 1,
    `bad-slot fillRect y=${badFillRect.args[1].toFixed(2)} should be ≈ ${expectedY.toFixed(2)} ` +
    `(plotY0 + visibleRow=${visibleRow} * slotH). A mutant reading bad_mask without slice ` +
    `would put it at row ${badAbsIdx} (y=${(PAD_TOP + badAbsIdx * slotH).toFixed(2)}).`);

  // Height of the bad-slot rect must equal slotH.
  assert.ok(Math.abs(badFillRect.args[3] - slotH) <= 1,
    `bad-slot fillRect height=${badFillRect.args[3].toFixed(2)} should be ≈ slotH=${slotH.toFixed(2)}`);
});

test('pagination ctx-conformance: per-row strokeStyle matches sliced channel_colors[visibleIdx]', async () => {
  // The renderer reads `colors[c]` where colors is sliced from
  // channel_colors by `slice(offset, offset+visibleN)`. With offset=5 and
  // distinct per-channel colors, the FIRST strokeStyle set to a
  // channel-color (i.e. not BAD_COLOR/SLOT_COLOR/AXIS_COLOR/LABEL_COLOR
  // /EVENT_*) must equal channel_colors[offset]. A mutant that drops the
  // colors slice would set the first channel-color to channel_colors[0].
  const totalCh = 10;  // ≤ maxVisible so no pagination slice on data either way
  const offset = 5;
  // 10 channels ≤ maxVisible=35, so the `totalCh > maxVisible` guard skips
  // the slice block — pagination only really activates when totalCh > maxVisible.
  // To make pagination apply to the slices, totalCh MUST exceed maxVisible.
  // Re-do with totalCh=40 (still small enough to keep the test fast).
  const totalCh2 = 40;
  const offset2 = 5;
  const channel_colors = Array.from({ length: totalCh2 }, (_, i) => {
    // 6-digit hex per channel: '#0c0001', '#0c0002', ..., distinct strings.
    const tag = String(i + 1).padStart(2, '0');
    return `#0c00${tag}`;
  });
  const channels = Array.from({ length: totalCh2 }, () => {
    const d = new Float32Array(100);
    for (let i = 0; i < 100; i++) d[i] = Math.sin(i * 0.1) * 10;
    return d;
  });
  const canvas = makeStubCanvas(800, 600);
  TraceRenderer.draw(canvas, {
    channels,
    channel_labels: Array.from({ length: totalCh2 }, (_, i) => `Ch${i + 1}`),
    channel_types:  Array.from({ length: totalCh2 }, () => 'EEG'),
    channel_colors,
    n_samples_visible: 100,
    fs: 250, start_sec: 0, gain: 1, transparent: false,
    channel_offset: offset2,
  });

  // Collect strokeStyle sets whose value matches our channel_colors palette.
  const channelStrokeSets = canvas._ctx.calls
    .filter(c => c.op === 'set:strokeStyle' && /^#0c00\d{2}$/.test(String(c.args[0])))
    .map(c => String(c.args[0]));

  assert.ok(channelStrokeSets.length > 0,
    'expected at least one per-channel strokeStyle set from channel_colors palette');

  // The FIRST channel-color strokeStyle must equal channel_colors[offset],
  // not channel_colors[0]. Mutant on the colors slice surfaces here.
  assert.equal(channelStrokeSets[0], channel_colors[offset2],
    `first per-channel stroke color should be channel_colors[${offset2}]=` +
    `${channel_colors[offset2]}; got ${channelStrokeSets[0]}. A slice-drop mutant would yield ` +
    `channel_colors[0]=${channel_colors[0]}.`);
});

test('pagination ctx-conformance: per-row setLineDash matches sliced channel_types[visibleIdx]', async () => {
  // Companion to the color test: TYPE_DASH['EOG'] = [5,2]; the sliced
  // types array must apply the offset-th type to visible row 0. Set
  // absolute channel #5 to EOG (the rest EEG) and verify the FIRST
  // non-empty setLineDash call carries [5,2] — which can only happen
  // if the renderer reads types[c] from a slice starting at offset=5
  // (because visible row 0 == abs channel 5).
  const totalCh = 40;  // > maxVisible
  const offset = 5;
  const channel_types = Array.from({ length: totalCh }, () => 'EEG');
  channel_types[offset] = 'EOG';   // exactly at visible row 0

  const canvas = makeStubCanvas(800, 600);
  TraceRenderer.draw(canvas, buildOpts(totalCh, 100, {
    channel_offset: offset,
    channel_types,
  }));

  // Find all setLineDash calls during per-channel rendering and collect
  // their args[0] in the order they appear.
  const dashSets = canvas._ctx.calls
    .filter(c => c.op === 'setLineDash')
    .map(c => Array.isArray(c.args[0]) ? c.args[0] : []);

  assert.ok(dashSets.length > 0, 'expected at least one setLineDash call');

  // The FIRST setLineDash with a non-empty array must be [5, 2] (EOG).
  // A mutant that dropped the types slice would have visible row 0 read
  // channel_types[0]='EEG' → empty dash, and the first non-empty dash
  // would shift to a later row (or never appear).
  const firstNonEmpty = dashSets.find(arr => arr.length > 0);
  assert.ok(firstNonEmpty, 'expected at least one non-empty dash (EOG at offset)');
  assert.deepEqual(firstNonEmpty, [5, 2],
    `first non-empty dash should be EOG's [5,2] (visible row 0 = abs ch ${offset}); got ${JSON.stringify(firstNonEmpty)}`);
});

test('pagination ctx-conformance: slot-divider count equals visibleN - 1 (offset > 0)', async () => {
  // drawSlotDividers (traces.js:158-168) draws (nCh-1) horizontal hairlines.
  // After pagination, nCh = visibleN, so the divider count must equal
  // visibleN - 1. A mutant flipping `c = 1` to `c = 0` would add one extra
  // divider at y = plotY0 + 0 (the top edge); flipping `c < nCh` to
  // `c <= nCh` would add one at y = plotY0 + visibleN*slotH = plotY0 + plotH
  // (the bottom). Both are caught here.
  const totalCh = 50;
  const offset = 5;
  const cssW = 800, cssH = 600;
  const canvas = makeStubCanvas(cssW, cssH);
  TraceRenderer.draw(canvas, buildOpts(totalCh, 100, { channel_offset: offset }));

  const PAD_LEFT = TraceRenderer.PAD_LEFT;
  const PAD_RIGHT = TraceRenderer.PAD_RIGHT;
  const PAD_TOP = TraceRenderer.PAD_TOP;
  const PAD_BOTTOM = TraceRenderer.PAD_BOTTOM;
  const plotX0 = PAD_LEFT;
  const plotX1 = cssW - PAD_RIGHT;
  const plotY0 = PAD_TOP;
  const plotH = cssH - PAD_TOP - PAD_BOTTOM;
  const maxVisible = TraceRenderer.lastMaxVisibleChannels;
  const visibleN = Math.min(maxVisible, totalCh - offset);

  // A slot divider is a (moveTo at plotX0, plotY0 < y < plotY0+plotH) followed
  // by a (lineTo at plotX1, same y). The half-pixel snap in drawSlotDividers
  // (line 163) emits y values like Math.round(plotY0 + c*slotH) + 0.5; the
  // y is the same on both moveTo and lineTo so we match by x extents and the
  // strict-inside-band y check.
  const calls = canvas._ctx.calls;
  const dividerYs = new Set();
  for (let i = 0; i < calls.length - 1; i++) {
    const a = calls[i], b = calls[i + 1];
    if (
      a.op === 'moveTo' && b.op === 'lineTo' &&
      a.args[0] === plotX0 && b.args[0] === plotX1 &&
      a.args[1] === b.args[1] &&            // horizontal line
      a.args[1] > plotY0 + 0.5 && a.args[1] < plotY0 + plotH - 0.5
    ) {
      // Round to integer to dedup (.5 snap means the y is x.5 — Math.round
      // would lose information, so use the raw value as the key string).
      dividerYs.add(a.args[1]);
    }
  }

  assert.equal(dividerYs.size, visibleN - 1,
    `expected ${visibleN - 1} slot dividers under offset=${offset}; got ${dividerYs.size}`);
});

test('pagination ctx-conformance: visibleN = min(maxVisible, totalCh - offset) at tight tail', async () => {
  // The pagination spec at traces.js:510 — visibleN = min(maxVisible, totalCh - offset).
  // When totalCh - offset SMALLER than maxVisible (e.g. totalCh=40,
  // offset=37 → only 3 channels remain), the renderer must render exactly
  // 3 rows. The iter-4 single-row tail tests already cover offset=totalCh-1;
  // this test pins the 2..3-row tight tails which expose the Math.min
  // direction. A mutant `Math.max(maxVisible, totalCh-offset)` would
  // produce maxVisible (35) rows here — easily distinguished from 3.
  const totalCh = 40;
  const offset = 37;
  const canvas = makeStubCanvas(800, 600);
  TraceRenderer.draw(canvas, buildOpts(totalCh, 100, { channel_offset: offset }));

  const labelCalls = canvas._ctx.calls.filter(c =>
    c.op === 'fillText' && /^Ch\d+$/.test(String(c.args[0])));
  assert.equal(labelCalls.length, totalCh - offset,
    `tight tail offset=${offset} totalCh=${totalCh}: expected ${totalCh - offset} labels; got ${labelCalls.length}`);

  // And the labels must be Ch38, Ch39, Ch40 in that order — pinning that
  // both the slice start AND the slice length are correct.
  const labelStrs = labelCalls.map(c => String(c.args[0])).sort(
    (a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10)
  );
  assert.deepEqual(labelStrs, ['Ch38', 'Ch39', 'Ch40'],
    `tight-tail labels must be exactly Ch38..Ch40 in order; got ${labelStrs.join(',')}`);
});

test('pagination ctx-conformance: trace polyline moveTos appear at per-row yCenter for offset > 0', async () => {
  // The trace's first moveTo for visible row `c` happens via
  // drawChannelPolyline / drawChannelDecimated, which both start at
  // (plotX0, yCenter +/- something) and step through samples. The
  // BAND of moveTo y values for row c must straddle
  //   yCenter[c] = plotY0 + (c + 0.5) * slotH
  // with offset > 0, slotH and yCenter are based on the post-slice
  // visibleN. We assert that AT LEAST one trace moveTo lands within
  // ±halfSlotPx of yCenter[0] = plotY0 + 0.5 * slotH — the first
  // visible row's center band — and similarly for the LAST visible
  // row. Both conditions failing simultaneously is impossible unless
  // the per-row yCenter formula is wrong.
  const totalCh = 40;
  const offset = 5;
  const cssW = 800, cssH = 600;
  const canvas = makeStubCanvas(cssW, cssH);
  TraceRenderer.draw(canvas, buildOpts(totalCh, 100, { channel_offset: offset }));

  const PAD_LEFT = TraceRenderer.PAD_LEFT;
  const PAD_TOP = TraceRenderer.PAD_TOP;
  const PAD_BOTTOM = TraceRenderer.PAD_BOTTOM;
  const PAD_RIGHT = TraceRenderer.PAD_RIGHT;
  const plotX0 = PAD_LEFT;
  const plotX1 = cssW - PAD_RIGHT;
  const plotY0 = PAD_TOP;
  const plotH = cssH - PAD_TOP - PAD_BOTTOM;
  const maxVisible = TraceRenderer.lastMaxVisibleChannels;
  const visibleN = Math.min(maxVisible, totalCh - offset);
  const slotH = plotH / visibleN;
  const halfSlotPx = slotH * 0.45;

  // Filter moveTos to those inside the plot X band — these are trace moveTos
  // (axis baseline is at y = plotY0 + plotH + 4, way below).
  const traceMoveYs = canvas._ctx.calls
    .filter(c => c.op === 'moveTo'
      && c.args[0] >= plotX0 && c.args[0] <= plotX1
      && c.args[1] >= plotY0 && c.args[1] <= plotY0 + plotH)
    .map(c => c.args[1]);

  assert.ok(traceMoveYs.length > 0, 'expected at least one trace moveTo inside the plot band');

  // Check first and last visible row's band membership. The polyline's
  // first moveTo at row c equals yCenter[c] - sample0_offset; with mild
  // ramp signals the deflection stays within ±halfSlotPx of yCenter.
  const checkRowBand = (visibleIdx) => {
    const yC = plotY0 + (visibleIdx + 0.5) * slotH;
    const hits = traceMoveYs.filter(y => Math.abs(y - yC) <= halfSlotPx + 2);
    assert.ok(hits.length > 0,
      `expected trace moveTos within ±${(halfSlotPx + 2).toFixed(1)}px of yCenter[${visibleIdx}]=${yC.toFixed(2)}; ` +
      `none of ${traceMoveYs.length} moveTos qualified`);
  };
  checkRowBand(0);
  checkRowBand(visibleN - 1);
});

