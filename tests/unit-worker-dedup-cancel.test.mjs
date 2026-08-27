// unit-worker-dedup-cancel.test.mjs — a cancelled upstream must not poison
// the requests that deduped onto it.
//
// Observed on cold load of a large remote EEGLAB recording: the viewer
// issues FETCH_WINDOW_STREAM for the first window, cancels it as layout
// settles, issues it again, cancels again, issues a third. Requests 2 and
// 3 dedup onto request 1's in-flight assembly. When request 1 is
// cancelled it calls resolveInflight([]), so both waiters received an
// empty array and reported it as "fetch returned no data
// (end-of-recording or aborted)" — a spurious console error for the
// already-cancelled request 2, and a stranded request 3 that never
// rendered despite being live.
//
// Live browser trace before the fix (13 worker messages):
//   -> STREAM 1 / CANCEL 1 / STREAM 2 / CANCEL 2 / STREAM 3
//   <- CANCELLED 1, CANCELLED 2, ERROR 2, ERROR 3
// After (76 messages): <- CANCELLED 1, CANCELLED 2, WINDOW_CHUNK 3.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const workerSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../worker.js'),
  'utf8',
);

// ── Behaviour model ──────────────────────────────────────────────────────
// Mirrors the dedup branch's contract: an empty upstream result is not
// evidence about this request, so a live waiter must read for itself and
// a cancelled waiter must stay silent.
function makeDedupBranch({ cancelled = new Set(), current = true } = {}) {
  const sent = [];
  const inflight = new Map();

  async function handle(requestId, cacheKey, upstream, ownRead) {
    const isCancelled = () => cancelled.has(requestId);
    const isCurrent = () => current;

    const pending = inflight.get(cacheKey) ?? upstream;
    if (pending) {
      const raw = await pending;
      const gotData = raw && raw.length && raw[0] && raw[0].length;
      if (gotData) { sent.push({ id: requestId, type: 'WINDOW_CHUNK' }); return; }
      if (!isCurrent() || isCancelled()) return;          // silent
      const own = await ownRead();                        // fall through
      if (own && own.length && own[0] && own[0].length) {
        sent.push({ id: requestId, type: 'WINDOW_CHUNK' });
      } else {
        sent.push({ id: requestId, type: 'ERROR' });
      }
      return;
    }
    sent.push({ id: requestId, type: 'ERROR' });
  }

  return { handle, sent };
}

const EMPTY = [];
const DATA = [new Float32Array([1, 2, 3])];

test('live waiter on a cancelled upstream reads for itself instead of erroring', async () => {
  const d = makeDedupBranch();
  await d.handle(3, '0-7500', Promise.resolve(EMPTY), async () => DATA);
  assert.deepEqual(d.sent, [{ id: 3, type: 'WINDOW_CHUNK' }],
    'request 3 was live and must render, not inherit the cancelled stream');
});

test('cancelled waiter on a cancelled upstream stays silent', async () => {
  const d = makeDedupBranch({ cancelled: new Set([2]) });
  await d.handle(2, '0-7500', Promise.resolve(EMPTY), async () => DATA);
  assert.deepEqual(d.sent, [],
    'request 2 already got CANCELLED; a second ERROR is spurious');
});

test('superseded waiter stays silent even when not explicitly cancelled', async () => {
  const d = makeDedupBranch({ current: false });
  await d.handle(4, '0-7500', Promise.resolve(EMPTY), async () => DATA);
  assert.deepEqual(d.sent, [], 'a superseded recording must not paint');
});

test('waiter still forwards a genuine upstream result', async () => {
  const d = makeDedupBranch();
  await d.handle(5, '0-7500', Promise.resolve(DATA), async () => {
    throw new Error('must not re-read when the upstream succeeded');
  });
  assert.deepEqual(d.sent, [{ id: 5, type: 'WINDOW_CHUNK' }]);
});

test('a live waiter that genuinely has no data still reports the error', async () => {
  const d = makeDedupBranch();
  await d.handle(6, '0-7500', Promise.resolve(EMPTY), async () => EMPTY);
  assert.deepEqual(d.sent, [{ id: 6, type: 'ERROR' }],
    'real end-of-recording must still surface');
});

// ── Source guards ────────────────────────────────────────────────────────
// The model above cannot observe worker.js itself, and this repo's worker
// tests assert on source for exactly that reason.

test('worker.js does not send the dedup result unconditionally', () => {
  assert.ok(
    !/const rawChannels = await inflight;\s*\n\s*sendFinalFromRaw\(rawChannels\);/.test(workerSrc),
    'the dedup branch must gate sendFinalFromRaw on the upstream actually having data',
  );
  assert.ok(
    /const gotData = rawChannels && rawChannels\.length/.test(workerSrc),
    'expected the gotData guard in the dedup branch',
  );
});

test('inflight cleanup only clears its own entry', () => {
  assert.ok(
    !/} finally \{\s*\n\s*inflightRawFetches\.delete\(cacheKey\);\s*\n\s*}/.test(workerSrc),
    'unguarded delete strands the promise a fell-through request registered',
  );
  assert.ok(
    /inflightRawFetches\.get\(cacheKey\) === inflightP/.test(workerSrc),
    'expected the identity check before deleting the in-flight entry',
  );
});
