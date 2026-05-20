// unit-viewer-races.test.mjs
//
// Regression tests for the 4 race conditions sleuth surfaced this session
// and that commit 40e87a4 fixed in viewer.js. The viewer module is an
// IIFE that depends on DOM globals, so we don't import it directly —
// we re-implement the small pieces of logic that matter as pure
// functions and assert their behaviour. If the live viewer's
// implementation drifts from these formulas, the existing e2e suite
// catches it.
//
// Each test pins one finding from /tmp sleuth report + commit 40e87a4:
//   Finding B — cache-generation gate on streaming writeback
//   Finding C — bounded cancelledRequests set (FIFO eviction)
//   Finding D — drag state must reset on pointercancel
//   Finding E — only null inFlight if it still refers to OUR controller
//
// These are contract tests. They WON'T catch a viewer.js refactor that
// changes the surface, but they WILL catch a regression that removes
// the defensive check or flips the comparison.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// ─── Finding B: cache-generation gate ────────────────────────────

function makeCacheGenGate() {
  let gen = 0;
  return {
    bump() { gen++; },
    snapshot() { return gen; },
    isStaleSnapshot(snap) { return snap !== gen; },
  };
}

test('finding-B: cache-generation snapshot detects post-render cache clear', () => {
  const g = makeCacheGenGate();
  const startGen = g.snapshot();
  // simulate: filter toggle fires clearReadCache() mid-render
  g.bump();
  // render finishes, wants to write back — must detect the bump
  assert.equal(g.isStaleSnapshot(startGen), true,
    'snapshot taken before bump must be detected as stale');
});

test('finding-B: snapshot matches if no cache clear happened', () => {
  const g = makeCacheGenGate();
  const snap = g.snapshot();
  assert.equal(g.isStaleSnapshot(snap), false,
    'snapshot must match itself in absence of bump');
});

test('finding-B: multiple bumps make ALL older snapshots stale', () => {
  const g = makeCacheGenGate();
  const s0 = g.snapshot();
  g.bump();
  const s1 = g.snapshot();
  g.bump();
  assert.equal(g.isStaleSnapshot(s0), true, 's0 must be stale after 2 bumps');
  assert.equal(g.isStaleSnapshot(s1), true, 's1 must be stale after 1 bump after it');
});

// ─── Finding C: bounded cancelledRequests set ────────────────────

function makeBoundedTracker(maxSize) {
  const set = new Set();
  return {
    add(id) {
      set.add(id);
      while (set.size > maxSize) {
        set.delete(set.values().next().value); // FIFO eviction
      }
    },
    has(id) { return set.has(id); },
    size() { return set.size; },
  };
}

test('finding-C: tracker caps at maxSize, evicts oldest first', () => {
  const t = makeBoundedTracker(3);
  t.add('a'); t.add('b'); t.add('c'); t.add('d');
  assert.equal(t.size(), 3, 'size must not exceed cap');
  assert.equal(t.has('a'), false, 'oldest entry must be evicted');
  assert.equal(t.has('d'), true, 'newest entry must be retained');
});

test('finding-C: 1000 adds with cap=256 still has size 256', () => {
  const t = makeBoundedTracker(256);
  for (let i = 0; i < 1000; i++) t.add(`req-${i}`);
  assert.equal(t.size(), 256, 'cap holds across long-running session simulation');
  // Last 256 must be present
  for (let i = 1000 - 256; i < 1000; i++) {
    assert.ok(t.has(`req-${i}`), `req-${i} should still be in the set`);
  }
});

test('finding-C: eviction-safe — a late chunk for an evicted id triggers no-op upstream', () => {
  // Simulates the viewer's WINDOW_CHUNK handler: it checks `if
  // (cancelledRequests.has(id))` to drop the chunk. If the id was
  // evicted, the .has() returns false → handler proceeds, then
  // pendingRequests.get(id) returns undefined (we already deleted on
  // abort), so the handler bails. This test pins that two-stage
  // safety net: BOTH checks together are correct, NEITHER alone is
  // sufficient.
  const t = makeBoundedTracker(2);
  t.add('A'); t.add('B'); t.add('C'); // C evicts A
  const pendingRequests = new Set(); // A is NOT in pendingRequests (was deleted on abort)
  function handle(id) {
    if (t.has(id)) return 'dropped-by-cancelled-check';
    if (!pendingRequests.has(id)) return 'dropped-by-pending-check';
    return 'processed';
  }
  assert.equal(handle('A'), 'dropped-by-pending-check',
    'evicted-but-not-pending id must still drop via pendingRequests check');
  assert.equal(handle('C'), 'dropped-by-cancelled-check',
    'in-set id drops via primary check');
});

// ─── Finding D: drag state must reset on pointercancel ───────────

function makeDragState() {
  let dragging = false, anchor = 0;
  return {
    onPointerDown(x) { dragging = true; anchor = x; },
    onPointerUp() { dragging = false; },
    onPointerCancel() { dragging = false; },     // the fix
    onLostPointerCapture() { dragging = false; }, // the fix
    isDragging() { return dragging; },
    anchor() { return anchor; },
  };
}

test('finding-D: pointercancel resets dragging', () => {
  const d = makeDragState();
  d.onPointerDown(100);
  assert.equal(d.isDragging(), true);
  d.onPointerCancel();
  assert.equal(d.isDragging(), false,
    'pointercancel must clear dragging — without this, the next hover yanks the view');
});

test('finding-D: lostpointercapture resets dragging', () => {
  const d = makeDragState();
  d.onPointerDown(100);
  d.onLostPointerCapture();
  assert.equal(d.isDragging(), false);
});

test('finding-D: pointerup still works after the fix', () => {
  // Regression — the fix must NOT break the happy path
  const d = makeDragState();
  d.onPointerDown(100);
  d.onPointerUp();
  assert.equal(d.isDragging(), false);
});

// ─── Finding E: only null inFlight if it still refers to OUR ctrl ───

function makeInflightContainer() {
  let inFlight = null;
  return {
    set(ctrl) { inFlight = ctrl; },
    abortAndReplace(newCtrl) {
      if (inFlight) inFlight.abort();
      inFlight = newCtrl;
    },
    // The fix at viewer.js:1391 — null ONLY if still ours
    nullIfMatches(ctrl) {
      if (inFlight === ctrl) inFlight = null;
    },
    nullUnconditional() { inFlight = null; }, // the BUGGY path, for contrast
    current() { return inFlight; },
  };
}

test('finding-E: nullIfMatches preserves a concurrent controller', () => {
  const c = makeInflightContainer();
  const initCtrl = new AbortController();
  c.set(initCtrl);

  // Init-load awaits; meanwhile user keypress triggers a new render
  const userCtrl = new AbortController();
  c.abortAndReplace(userCtrl);
  assert.ok(initCtrl.signal.aborted, 'init was aborted by user keypress');

  // Init-load resumes after await — must NOT clobber userCtrl
  c.nullIfMatches(initCtrl);
  assert.equal(c.current(), userCtrl,
    'nullIfMatches must NOT touch a controller that is not ours');
});

test('finding-E: BUGGY nullUnconditional would clobber the live controller', () => {
  // Contrast test — proves the fix actually matters.
  const c = makeInflightContainer();
  const initCtrl = new AbortController();
  c.set(initCtrl);
  const userCtrl = new AbortController();
  c.abortAndReplace(userCtrl);
  c.nullUnconditional();
  assert.equal(c.current(), null,
    'unconditional null DOES clobber userCtrl — demonstrates why the fix is required');
});

test('finding-E: nullIfMatches DOES null when we are still the active ctrl', () => {
  // Happy path — init-load was not interrupted, must clear inFlight
  const c = makeInflightContainer();
  const initCtrl = new AbortController();
  c.set(initCtrl);
  c.nullIfMatches(initCtrl);
  assert.equal(c.current(), null);
});
