// tests/_render-invariants.mjs
//
// Generic invariants for canvas-based rendering. Designed to catch the
// CLASS of bug we hit twice in this codebase:
//
//   Bug A — "ghost trace": polyline drawn for partial samples stretched
//           across the full plot width; band-clear only erases the new
//           samples' x-range, so previous stretched polylines stay
//           visible. (Fixed: commit 35a486d.)
//   Bug B — "alpha compound": semi-transparent paint (event line/label)
//           re-applied to the same pixel on every streaming chunk.
//           1 draw → 30% alpha; 10 draws → 97% alpha. (Fixed: 4ebac6e.)
//
// Both are invisible to call-count assertions ("did the function run")
// but visible to invariants over the operation TRACE ("did the operation
// land where/how many times it should").
//
// This module exports invariants that any future canvas-rendering test
// can pull in. Each invariant takes a recorded call log + the relevant
// context (clear regions, plot bounds, etc.) and asserts a property.

import { strict as assert } from 'node:assert';

// ─── Tracking canvas ─────────────────────────────────────────────
//
// Returns { canvas, calls } where `calls` is a flat array of every
// ctx operation. Each entry: { op: string, args: any[] }.
// Used by every invariant below. If a future render path needs more
// granular tracking (e.g. tag each call with the current strokeStyle
// + globalAlpha state), extend this in place.

export function makeRecordingCanvas(cssW = 800, cssH = 600) {
  const calls = [];
  const state = {
    strokeStyle: '#000', fillStyle: '#000',
    lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic',
    globalAlpha: 1,
  };
  function track(op, ...args) { calls.push({ op, args, state: { ...state } }); }
  const ctx = new Proxy({
    measureText(t) { return { width: t.length * 6 }; },
    beginPath()        { track('beginPath'); },
    moveTo(x, y)       { track('moveTo', x, y); },
    lineTo(x, y)       { track('lineTo', x, y); },
    stroke()           { track('stroke'); },
    fill()             { track('fill'); },
    rect(x, y, w, h)   { track('rect', x, y, w, h); },
    clip()             { track('clip'); },
    closePath()        { track('closePath'); },
    fillText(t, x, y)  { track('fillText', t, x, y); },
    strokeText(t, x, y){ track('strokeText', t, x, y); },
    fillRect(x, y, w, h)  { track('fillRect', x, y, w, h); },
    clearRect(x, y, w, h) { track('clearRect', x, y, w, h); },
    setTransform(...a) { track('setTransform', ...a); },
    save()             { track('save'); },
    restore()          { track('restore'); },
    setLineDash(a)     { track('setLineDash', a); },
    arcTo() {}, arc() {},
  }, {
    set(t, p, v) { if (p in state) { track(`set:${p}`, v); state[p] = v; } t[p] = v; return true; },
    get(t, p) { if (p in state) return state[p]; return t[p]; },
  });
  return {
    canvas: { width: 0, height: 0, clientWidth: cssW, clientHeight: cssH, getContext() { return ctx; } },
    calls,
  };
}

// ─── Invariant 1: no alpha-compound on identical paints ──────────
//
// For every text/line drawn with a semi-transparent color in a single
// render cycle, the (text, x, y, color) tuple must appear AT MOST ONCE.
// A second identical draw at <1 alpha is the alpha-compound bug pattern.
//
// Returns a list of violations (empty = clean). Each violation:
//   { kind: 'fillText'|'stroke-line', sample, count, color }

// Split the call log into RENDER CYCLES, one per draw() call. Each
// cycle starts at the setTransform call (the first op every draw()
// emits). Across cycles, the renderer's clears reset the pixels we
// care about — so we check alpha-compounds WITHIN a single cycle.
function splitCycles(calls) {
  const cycles = [];
  let current = null;
  for (const c of calls) {
    if (c.op === 'setTransform') {
      if (current) cycles.push(current);
      current = [];
    }
    if (current) current.push(c);
  }
  if (current) cycles.push(current);
  // If no setTransform anywhere (synthetic logs), treat the whole log
  // as one cycle.
  return cycles.length ? cycles : [calls];
}

export function findAlphaCompounds(calls) {
  const violations = [];

  for (const cycle of splitCycles(calls)) {
    // 1a — fillText with alpha < 1 within a single render cycle
    const textCounts = new Map();
    for (const c of cycle) {
      if (c.op !== 'fillText') continue;
      const color = c.state.fillStyle;
      if (typeof color !== 'string' || !/rgba?\([^)]+,\s*0?\.[0-9]+\)/.test(color)) continue;
      const [text, x, y] = c.args;
      const key = `${color}|${x.toFixed(1)}|${y.toFixed(1)}|${text}`;
      textCounts.set(key, (textCounts.get(key) || 0) + 1);
    }
    for (const [key, count] of textCounts) {
      if (count > 1) {
        const [color, x, y, text] = key.split('|');
        violations.push({ kind: 'fillText', text, x: +x, y: +y, color, count });
      }
    }

    // 1b — identical-path strokes at <1 alpha within a single cycle.
    // A stroke() commits the accumulated path; pair-up identical paths
    // by hashing (op, x, y) tuples between beginPath boundaries.
    let currentPath = [];
    const strokeCounts = new Map();
    for (const c of cycle) {
      if (c.op === 'beginPath') currentPath = [];
      if (c.op === 'moveTo' || c.op === 'lineTo') currentPath.push([c.op, c.args[0], c.args[1]]);
      if (c.op === 'stroke') {
        const color = c.state.strokeStyle;
        if (typeof color === 'string' && /rgba?\([^)]+,\s*0?\.[0-9]+\)/.test(color)) {
          const key = `${color}|${JSON.stringify(currentPath)}`;
          strokeCounts.set(key, (strokeCounts.get(key) || 0) + 1);
        }
        currentPath = [];
      }
    }
    for (const [key, count] of strokeCounts) {
      if (count > 1) {
        const [color] = key.split('|');
        violations.push({ kind: 'stroke-line', color, count });
      }
    }
  }

  return violations;
}

// ─── Invariant 2: partial_fill ops ⊆ full-draw ops ───────────────
//
// Run the same draw twice — once with partial_fill, once without.
// The partial_fill version's ops (minus the band-clear fillRect)
// must be a SUBSET of the full-draw version's ops at the same x range.
// Catches "partial draw paints something the full draw doesn't" — the
// shape of bug A.

export function findPartialDrawDivergence(partialCalls, fullCalls, cleared) {
  // Group ops by (op, rounded-coords). For partial_fill, every op
  // (other than the band-clear fillRect) should be present in fullCalls.
  const sigOf = (c) => {
    if (c.op === 'fillText') return `fillText|${c.args[0]}|${Math.round(c.args[1])}|${Math.round(c.args[2])}`;
    if (c.op === 'moveTo' || c.op === 'lineTo') return `${c.op}|${Math.round(c.args[0])}|${Math.round(c.args[1])}`;
    if (c.op === 'fillRect') return `fillRect|${Math.round(c.args[0])}|${Math.round(c.args[1])}|${Math.round(c.args[2])}|${Math.round(c.args[3])}`;
    return c.op;
  };
  const fullSigs = new Set(fullCalls.map(sigOf));
  const orphans = [];
  for (const c of partialCalls) {
    if (c.op === 'fillRect' && cleared) {
      const [x, , w] = c.args;
      // Ignore the band-clear fillRect (expected, not in full draw).
      if (Math.abs(x - cleared.xStart) < 4 && Math.abs((x + w) - cleared.xEnd) < 4) continue;
    }
    const sig = sigOf(c);
    if (!fullSigs.has(sig)) orphans.push({ sig, op: c.op, args: c.args });
  }
  return orphans;
}

// ─── Invariant 3: paints inside an unrelated band are not repeated ──
//
// If a partial_fill cleared band [xStart, xEnd], anything drawn at
// x < xStart - SLACK or x > xEnd + SLACK should be drawn AT MOST
// ONCE per render cycle. Repeated draws outside the band are the
// "ghost" pattern.

const ALPHA_RE = /rgba?\([^)]+,\s*0?\.[0-9]+\)/;
function isSemiTransparent(color) {
  return typeof color === 'string' && ALPHA_RE.test(color);
}

export function findRepeatedOutsideBand(calls, band, slack = 0) {
  // Cross-cycle invariant: across multiple draw() calls (e.g. a
  // streaming pan), any SEMI-TRANSPARENT paint outside the cleared
  // band should appear AT MOST ONCE in total. Opaque paints are
  // lossless overpaints so we don't count those (they're allowed
  // to redraw on every chunk — the polyline being a classic example).
  // This invariant is what's needed to catch the event-ghost bug
  // (event color is rgba(...,0.3)) — opaque polyline repeats are
  // expected and ignored.
  if (!band) return [];
  const lo = band.xStart - slack;
  const hi = band.xEnd + slack;
  const violations = [];
  const counts = new Map();
  for (const c of calls) {
    let x, color;
    if (c.op === 'fillText') {
      x = c.args[1];
      color = c.state.fillStyle;
    } else if (c.op === 'stroke') {
      // Strokes don't have a single (x, y) — skip; alpha-compound
      // detector handles stroke repeats by path-hash already.
      continue;
    } else {
      continue;
    }
    if (!isSemiTransparent(color)) continue;
    if (x >= lo && x <= hi) continue;
    const key = `${c.op}|${typeof c.args[0] === 'string' ? c.args[0] : ''}|${Math.round(x)}|${Math.round(c.args[c.op === 'fillText' ? 2 : 1])}|${color}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const [key, count] of counts) {
    if (count > 1) violations.push({ key, count });
  }
  return violations;
}

// ─── Convenience: assertNoAlphaCompound ──────────────────────────
//
// Wrap findAlphaCompounds in an assertion suitable for test bodies.
// Pass the call log captured by makeRecordingCanvas.

export function assertNoAlphaCompound(calls, msg = '') {
  const v = findAlphaCompounds(calls);
  if (v.length === 0) return;
  const detail = v.map(x =>
    x.kind === 'fillText'
      ? `  fillText "${x.text}" at (${x.x},${x.y}) drawn ${x.count}× with ${x.color}`
      : `  stroke-line ${x.color} drawn ${x.count}× (identical path)`
  ).join('\n');
  assert.fail(`${msg}\nalpha-compound violations:\n${detail}`);
}
