// unit-worker-races.test.mjs
//
// Regression tests for the 3 worker.js race fixes landed in this session
// (filter-snapshot, reader-epoch, null-resolve). The worker runs in a
// dedicated Web Worker context that node:test cannot host directly, so
// these are CONTRACT tests — they re-implement the small pieces of
// state-management logic from worker.js as pure functions and pin
// the expected behaviour. The existing worker integration tests in
// tests/unit-worker-protocol.test.mjs exercise the live worker
// through its postMessage interface.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// ─── Worker finding 1: filter chain must be SNAPSHOTTED, not live-read ───

function makeFilterSnapshotter() {
  let activeFilterCoefs = [];
  return {
    setFilter(coefs) { activeFilterCoefs = coefs; },
    // CORRECT: snapshot at entry, use throughout the request lifecycle
    snapshotAndProcess() {
      const snapshot = activeFilterCoefs.slice();
      return async () => {
        // Simulate awaits inside the request (e.g. await readWindow)
        await new Promise(r => setImmediate(r));
        // Use the SNAPSHOT, not the live activeFilterCoefs
        return snapshot.length > 0 ? `filtered-with-${snapshot.join(',')}` : 'raw';
      };
    },
    // BUGGY: read live state each time
    liveReadProcess() {
      return async () => {
        await new Promise(r => setImmediate(r));
        return activeFilterCoefs.length > 0
          ? `filtered-with-${activeFilterCoefs.join(',')}` : 'raw';
      };
    },
  };
}

test('worker-find-1: snapshot path returns the filter active at request entry', async () => {
  const f = makeFilterSnapshotter();
  f.setFilter(['hp-0.5']);
  const fn = f.snapshotAndProcess();   // snapshot now contains ['hp-0.5']
  // User toggles filter mid-request:
  f.setFilter(['hp-0.5', 'lp-45']);
  const result = await fn();
  assert.equal(result, 'filtered-with-hp-0.5',
    'snapshot path must honour what was active when the user clicked Pan');
});

test('worker-find-1: BUGGY live-read path silently returns NEW filter result', async () => {
  // Contrast test — proves the snapshot fix actually matters.
  const f = makeFilterSnapshotter();
  f.setFilter(['hp-0.5']);
  const fn = f.liveReadProcess();
  f.setFilter(['hp-0.5', 'lp-45']);
  const result = await fn();
  assert.equal(result, 'filtered-with-hp-0.5,lp-45',
    'live-read DOES change result — demonstrates the race the fix prevents');
});

test('worker-find-1: empty snapshot yields raw even if filter toggled on after', async () => {
  const f = makeFilterSnapshotter();
  // No filter at request entry
  const fn = f.snapshotAndProcess();
  f.setFilter(['hp-0.5']); // toggle on mid-request
  const result = await fn();
  assert.equal(result, 'raw',
    'snapshot was empty — must NOT apply the later-added filter');
});

// ─── Worker finding 2: reader epoch must guard every await boundary ───

function makeEpochGuard() {
  let currentEpoch = 0;
  return {
    bumpEpoch() { currentEpoch++; },
    currentEpoch() { return currentEpoch; },
    async streamWithEpochCheck(stepCount, bumpAtStep) {
      const epoch = currentEpoch;
      const results = [];
      for (let i = 0; i < stepCount; i++) {
        await new Promise(r => setImmediate(r));
        if (epoch !== currentEpoch) {
          return { results, abortedAt: i };
        }
        if (i === bumpAtStep) this.bumpEpoch();
        results.push(`step-${i}-epoch-${epoch}`);
      }
      // Final epoch check before writeback
      if (epoch !== currentEpoch) return { results, abortedAtEnd: true };
      return { results, completed: true };
    },
  };
}

test('worker-find-2: epoch bump mid-stream aborts the stream before writeback', async () => {
  const g = makeEpochGuard();
  // Bump at step 2 → step 3's check should detect and bail
  const r = await g.streamWithEpochCheck(5, 2);
  assert.equal(r.completed, undefined, 'stream must NOT complete after epoch bump');
  assert.equal(r.abortedAt, 3, 'must abort at the next await boundary after the bump');
  assert.equal(r.results.length, 3, 'only the 3 pre-bump steps were emitted');
});

test('worker-find-2: no bump → stream completes normally', async () => {
  const g = makeEpochGuard();
  const r = await g.streamWithEpochCheck(3, -1); // never bump
  assert.equal(r.completed, true);
  assert.equal(r.results.length, 3);
});

test('worker-find-2: 100 concurrent streams + 1 LOAD_FILE → only post-load completes', async () => {
  const g = makeEpochGuard();
  // Kick off 100 streams; bump epoch after they all start; only those
  // initiated after the bump complete.
  const before = [];
  for (let i = 0; i < 100; i++) before.push(g.streamWithEpochCheck(3, -1));
  await Promise.resolve(); // let them all enter the loop
  g.bumpEpoch();
  const after = [];
  for (let i = 0; i < 5; i++) after.push(g.streamWithEpochCheck(3, -1));
  const beforeResults = await Promise.all(before);
  const afterResults = await Promise.all(after);
  const beforeCompleted = beforeResults.filter(r => r.completed).length;
  const afterCompleted = afterResults.filter(r => r.completed).length;
  assert.equal(beforeCompleted, 0, 'no pre-bump stream may complete');
  assert.equal(afterCompleted, 5, 'all post-bump streams must complete');
});

// ─── Worker finding 4: null-resolve must surface to caller cleanly ───

function makeSendFinalGuard() {
  return {
    send(raw) {
      if (!raw || raw.length === 0 || !raw[0] || raw[0].length === 0) {
        return { error: 'no data' };
      }
      return { ok: true, length: raw[0].length };
    },
  };
}

test('worker-find-4: sendFinalFromRaw guards against null raw', () => {
  const g = makeSendFinalGuard();
  assert.deepEqual(g.send(null), { error: 'no data' });
});

test('worker-find-4: sendFinalFromRaw guards against empty array', () => {
  const g = makeSendFinalGuard();
  assert.deepEqual(g.send([]), { error: 'no data' });
});

test('worker-find-4: sendFinalFromRaw guards against zero-length channels', () => {
  const g = makeSendFinalGuard();
  assert.deepEqual(g.send([new Float32Array(0)]), { error: 'no data' });
});

test('worker-find-4: sendFinalFromRaw passes valid raw through', () => {
  const g = makeSendFinalGuard();
  assert.deepEqual(g.send([new Float32Array(100)]), { ok: true, length: 100 });
});
