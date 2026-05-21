# Subject Auto-Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a viewer URL omits `?sub=`, auto-discover the first real subject ID (via `participants.tsv` then S3 prefix listing) instead of blindly defaulting to `sub-01` and 404-ing on datasets that use non-standard subject IDs (`sub-001`, `sub-hc1`, `sub-xp101`, `sub-283`).

**Architecture:** Mirror the existing `?suffix=` auto-detect pattern (commit `4a36aa6`, see `bids-recording.js:156-180`). Add a new `api.discoverSubject(params)` helper that probes two sources in order — (1) `participants.tsv` (fast, 1 fetch), (2) S3 ListObjectsV2 with `prefix=<dataset>/sub-` (parses XML, 1 fetch). `resolveTargets()` returns a new descriptor `kind: 'bids-path-discover-sub'` when `?sub=` is omitted; boot() dispatches that to the discovery pipeline, then composes with the existing `bids-path-auto` flow when `?suffix=` is also omitted. Zero overhead when `?sub=` is supplied (most common case).

**Tech Stack:** Vanilla JS (no build step), `node:test` for tests, existing `globalThis.fetch` mock pattern (see `tests/unit-bids-recording.test.mjs:1730-1794`), no new dependencies.

---

## Background

From `docs/audit-100-datasets-2026-05-21.md` (commit `194d6c4`) — 4 EEG datasets fail to load in the viewer because they:
- Lack `participants.tsv` (`ds003774`, `ds003620`), OR
- Use non-standard subject IDs that don't match the `sub-01` default (`sub-001`, `sub-hc1`, `sub-xp101`, `sub-283`, `sub-0001`)

Today's failing flow: `?dataset=ds003774&task=MusicListening&ext=set` → `buildBidsRelpath` defaults `sub` to `01` → 404 because the dataset uses `sub-001`. The user has to know to add `&sub=001` manually.

After this plan, the same URL probes `participants.tsv` → reads `sub-001` → retries → loads successfully.

---

## File Structure

```
bids-recording.js                      MODIFY — add api.discoverSubject (~50 lines)
                                                + new 'bids-path-discover-sub' branch in resolveTargets
viewer.js                              MODIFY — boot() dispatch for the new kind
tests/unit-bids-recording.test.mjs     MODIFY — add 8 tests for discoverSubject
                                                + update 2 existing resolveTargets tests
tests/unit-api-surface.test.mjs        MODIFY — add bids-recording.js entry with
                                                discoverSubject in the snapshot
docs/audit-100-datasets-2026-05-21.md  MODIFY — append "coverage lift" section
index.html                             MODIFY — bump bids-recording.js?v=5 → ?v=6
                                                + viewer.js?v=4 → ?v=5
```

No new files. All changes are localized to the BIDS resolution layer and its tests.

---

## Task 1: Ground assumptions by reading the affected code paths

**Files:** read-only

- [ ] **Step 1: Re-read the existing modality-discovery helper**

Read: `bids-recording.js:144-180` — the `discoverSuffix` function that this plan mirrors.

Expected understanding after read:
- Race all candidate URLs with `fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } })`.
- Accept 200 OR 206 as "exists".
- Walk `Promise.allSettled` results in declared order to pick the priority winner.
- Return `null` when nothing matches.

- [ ] **Step 2: Re-read the URL resolver**

Read: `bids-recording.js:877-939` — `api.resolveTargets`. Note the existing branches: `url`, `nemar`, `bids-path`, `bids-path-auto`, `demo`. Note the suffix policy block at lines 909-929 where `bids-path-auto` is returned when `?suffix=` is missing.

- [ ] **Step 3: Re-read the boot dispatcher**

Read: `viewer.js:1635-1668` — the `boot()` switch on `target?.kind`. Note how `bids-path-auto` calls `BIDSRecording.discoverSuffix(target.params)` then composes a `{ ...target.params, suffix: suf }` object and dispatches to `load(buildOpenNeuroEegUrl(...))`.

- [ ] **Step 4: Re-read the audit script's discovery logic to confirm protocol shape**

Read: `scripts/audit-100-datasets.mjs:53-95` — both the `participants.tsv` parse loop and the S3 `ListObjectsV2` XML matcher. This is the reference implementation we are porting into the viewer. Key constants reused verbatim:
- URL: `https://s3.amazonaws.com/openneuro.org?list-type=2&prefix=<dataset>/sub-&max-keys=20`
- XML key regex: `/<Key>([^<]+)<\/Key>/g`
- Subject-extract regex: `/^[^/]+\/sub-([^/]+)\//`
- `participants.tsv` shape: `participant_id\t...\n` header, then `sub-XXX\t...` rows; strip the leading `sub-` prefix from column 0.

This task is observation-only — no code changes, no commit. Proceed to Task 2.

---

## Task 2: Add `api.discoverSubject` (RED — write the failing tests first)

**Files:**
- Modify: `tests/unit-bids-recording.test.mjs` (append after line 1794, the end of the `discoverSuffix` block)

- [ ] **Step 1: Add the 6 discoverSubject unit tests at the bottom of the file**

Open `tests/unit-bids-recording.test.mjs` and append at the end:

```js
// ─── discoverSubject: participants.tsv + S3-list fallback ─────────
//
// Mirrors discoverSuffix's mock-fetch pattern. The helper probes two
// sources in order:
//   1. participants.tsv  (fast, 1 fetch, parses TSV column 0)
//   2. S3 ListObjectsV2  (1 fetch, parses XML <Key> tags)
// Returns the first subject ID (without 'sub-' prefix) or null.

test('discoverSubject: returns first sub from participants.tsv when present', async () => {
  // Mock fetch: participants.tsv responds with a valid TSV body; S3
  // listing would never be called because participants.tsv hit first.
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/participants.tsv')) {
      return {
        ok: true, status: 200,
        text: async () => 'participant_id\tage\tsex\nsub-001\t25\tF\nsub-002\t30\tM\n',
      };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  try {
    const sub = await BIDSRecording.discoverSubject({ dataset: 'ds003774' });
    assert.equal(sub, '001');
    assert.equal(calls.length, 1, 'should not have fallen back to S3-list');
    assert.match(calls[0], /\/ds003774\/participants\.tsv$/);
  } finally {
    delete globalThis.fetch;
  }
});

test('discoverSubject: strips sub- prefix from participants.tsv row', async () => {
  // participant_id values are stored as `sub-XXX` per BIDS spec. The
  // helper returns the bare ID (no prefix) because buildBidsRelpath
  // re-adds the prefix.
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    text: async () => 'participant_id\nsub-hc1\nsub-hc2\n',
  });
  try {
    const sub = await BIDSRecording.discoverSubject({ dataset: 'ds002778' });
    assert.equal(sub, 'hc1');
  } finally {
    delete globalThis.fetch;
  }
});

test('discoverSubject: falls back to S3 list when participants.tsv 404s', async () => {
  // ds003774 is the canonical case — no participants.tsv, but the
  // bucket has sub-001/ under the dataset prefix.
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/participants.tsv')) {
      return { ok: false, status: 404, text: async () => '' };
    }
    if (url.includes('list-type=2') && url.includes('prefix=ds003774%2Fsub-')) {
      return {
        ok: true, status: 200,
        text: async () =>
          '<?xml version="1.0"?><ListBucketResult>' +
          '<Key>ds003774/sub-001/eeg/sub-001_task-MusicListening_eeg.set</Key>' +
          '<Key>ds003774/sub-001/eeg/sub-001_task-MusicListening_eeg.fdt</Key>' +
          '</ListBucketResult>',
      };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  try {
    const sub = await BIDSRecording.discoverSubject({ dataset: 'ds003774' });
    assert.equal(sub, '001');
    assert.equal(calls.length, 2, 'should have tried participants.tsv then S3 list');
  } finally {
    delete globalThis.fetch;
  }
});

test('discoverSubject: S3 list parses non-numeric subject IDs (sub-hc1)', async () => {
  // ds002778 uses sub-hc1, sub-hc2, etc. — letters allowed in BIDS.
  // Regression test that the extract regex doesn't anchor on digits.
  globalThis.fetch = async (url) => {
    if (url.endsWith('/participants.tsv')) {
      return { ok: false, status: 404, text: async () => '' };
    }
    return {
      ok: true, status: 200,
      text: async () =>
        '<ListBucketResult>' +
        '<Key>ds002778/sub-hc1/ses-hc/eeg/sub-hc1_ses-hc_task-rest_eeg.bdf</Key>' +
        '</ListBucketResult>',
    };
  };
  try {
    const sub = await BIDSRecording.discoverSubject({ dataset: 'ds002778' });
    assert.equal(sub, 'hc1');
  } finally {
    delete globalThis.fetch;
  }
});

test('discoverSubject: returns null when both participants.tsv AND S3 list fail', async () => {
  // Truly empty / nonexistent dataset — caller surfaces an error.
  globalThis.fetch = async () => ({
    ok: false, status: 404, text: async () => '',
  });
  try {
    const sub = await BIDSRecording.discoverSubject({ dataset: 'nonexistent000' });
    assert.equal(sub, null);
  } finally {
    delete globalThis.fetch;
  }
});

test('discoverSubject: returns null when S3 list returns no sub- keys', async () => {
  // Defensive: bucket exists but contains only top-level files (e.g.
  // CHANGES, dataset_description.json) — listing returns 200 with no
  // sub-* matches.
  globalThis.fetch = async (url) => {
    if (url.endsWith('/participants.tsv')) {
      return { ok: false, status: 404, text: async () => '' };
    }
    return {
      ok: true, status: 200,
      text: async () =>
        '<ListBucketResult>' +
        '<Key>ds999999/dataset_description.json</Key>' +
        '<Key>ds999999/CHANGES</Key>' +
        '</ListBucketResult>',
    };
  };
  try {
    const sub = await BIDSRecording.discoverSubject({ dataset: 'ds999999' });
    assert.equal(sub, null);
  } finally {
    delete globalThis.fetch;
  }
});
```

- [ ] **Step 2: Run the new tests — expect 6 failures**

Run: `node --test tests/unit-bids-recording.test.mjs 2>&1 | grep -E "discoverSubject|fail|pass" | head -20`

Expected: 6 `fail` lines, all with `TypeError: BIDSRecording.discoverSubject is not a function`. If any test passes, the production function already exists — abort and re-investigate.

- [ ] **Step 3: Commit (RED state)**

```bash
git add tests/unit-bids-recording.test.mjs
git commit -m "test(bids-recording): add 6 failing tests for discoverSubject helper"
```

---

## Task 3: Implement `api.discoverSubject` (GREEN)

**Files:**
- Modify: `bids-recording.js` (insert after line 180, i.e. right after `discoverSuffix`)

- [ ] **Step 1: Add the implementation**

Open `bids-recording.js`. After the closing `};` of `api.discoverSuffix` on line 180, insert:

```js
  // Subject auto-detection: when ?sub= is omitted from the URL, walk
  // two sources in priority order to find a real subject ID. This
  // unblocks 4+ datasets identified in docs/audit-100-datasets-2026-05-21.md
  // that use non-standard subject IDs (sub-001, sub-hc1, sub-xp101,
  // sub-283, sub-0001) and would 404 against the `sub-01` default.
  //
  // Priority:
  //   1. participants.tsv  (fast: 1 fetch, ~10KB body, present in
  //      ~95% of OpenNeuro datasets per the audit). The first data
  //      row's column 0 is `participant_id`, formatted as `sub-XXX`.
  //   2. S3 ListObjectsV2 with prefix=<dataset>/sub-  (1 fetch, XML
  //      response, ~20 keys returned). Extract the first sub-<X>/
  //      segment we see.
  //
  // Returns the bare subject ID (no `sub-` prefix) so it can be passed
  // straight to buildBidsRelpath, which re-adds the prefix. Returns
  // null when both sources fail — caller surfaces a clear error.
  //
  // Mirrors the discoverSuffix pattern: fetch + Range-byte probe is
  // intentionally NOT used here because (a) participants.tsv is small
  // enough to fetch in full, and (b) S3 ListObjectsV2 doesn't honor
  // Range. We use full GETs.
  const _S3_LIST_BASE = 'https://s3.amazonaws.com/openneuro.org';
  api.discoverSubject = async function (params) {
    const ds = required(params, 'dataset');

    // 1. participants.tsv — primary source.
    try {
      const res = await fetch(`${api.buildOpenNeuroEegUrl({
        dataset: ds, sub: '__placeholder__', task: '__t__', ext: '__e__',
      }).replace(/\/sub-__placeholder__\/.*$/, '')}/participants.tsv`);
      if (res.ok) {
        const text = await res.text();
        const lines = text.split('\n').filter(l => l.trim());
        // Header + at least 1 data row.
        if (lines.length >= 2) {
          const firstCol = lines[1].split('\t')[0].trim();
          // BIDS: participant_id is formatted `sub-XXX`. Strip the
          // prefix because buildBidsRelpath re-adds it.
          const sub = firstCol.replace(/^sub-/, '');
          if (sub) return sub;
        }
      }
    } catch { /* swallow: fall through to S3 list */ }

    // 2. S3 ListObjectsV2 — fallback for datasets that lack a
    // participants.tsv (ds003774, ds003620). XML-parsed by regex —
    // good enough for ListBucketResult, no DOMParser needed.
    try {
      const url = `${_S3_LIST_BASE}?list-type=2&prefix=${encodeURIComponent(ds + '/sub-')}&max-keys=20`;
      const res = await fetch(url);
      if (res.ok) {
        const xml = await res.text();
        for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
          // m[1] is e.g. "ds003774/sub-001/eeg/sub-001_task-X_eeg.set"
          const sm = /^[^/]+\/sub-([^/]+)\//.exec(m[1]);
          if (sm) return sm[1];
        }
      }
    } catch { /* swallow: return null below */ }

    return null;
  };
```

NOTE: the `participants.tsv` URL build above is awkward because `buildOpenNeuroEegUrl` is BIDS-recording-aware. Simplify by using the bucket constant directly. Replace the implementation's `participants.tsv` URL line with this cleaner version:

```js
  // bucket selection lockstep with buildOpenNeuroEegUrl
  const _PARTICIPANTS_BUCKET = _DIRECT_S3
    ? 'https://s3.amazonaws.com/openneuro.org'
    : 'https://cdn.eegdash.org';
  api.discoverSubject = async function (params) {
    const ds = required(params, 'dataset');

    // 1. participants.tsv — primary source.
    try {
      const res = await fetch(`${_PARTICIPANTS_BUCKET}/${ds}/participants.tsv`);
      if (res.ok) {
        const text = await res.text();
        const lines = text.split('\n').filter(l => l.trim());
        if (lines.length >= 2) {
          const firstCol = lines[1].split('\t')[0].trim();
          const sub = firstCol.replace(/^sub-/, '');
          if (sub) return sub;
        }
      }
    } catch { /* fall through to S3 list */ }

    // 2. S3 ListObjectsV2 — fallback. Always hits raw S3 (the CDN
    // worker doesn't proxy ?list-type=2 requests, only object GETs).
    try {
      const url = `${_S3_LIST_BASE}?list-type=2&prefix=${encodeURIComponent(ds + '/sub-')}&max-keys=20`;
      const res = await fetch(url);
      if (res.ok) {
        const xml = await res.text();
        for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
          const sm = /^[^/]+\/sub-([^/]+)\//.exec(m[1]);
          if (sm) return sm[1];
        }
      }
    } catch { /* return null */ }

    return null;
  };
```

Use the second (cleaner) version. Discard the first version — it was scratch reasoning to confirm the URL shape.

- [ ] **Step 2: Run the 6 new tests — expect all to pass**

Run: `node --test tests/unit-bids-recording.test.mjs 2>&1 | grep -E "discoverSubject" | head -10`

Expected: 6 `pass` lines, 0 fail.

If anything fails, the most likely cause is: (a) `_DIRECT_S3` undefined in Node test context (it's read from `globalThis.location.search`, which is undefined under Node — should default to `false`, giving `cdn.eegdash.org`); (b) the mock fetch's `url.endsWith('/participants.tsv')` check doesn't match because the URL contains a query string. Inspect the actual `url` parameter the mock receives.

- [ ] **Step 3: Run the full bids-recording test file to confirm no regression**

Run: `node --test tests/unit-bids-recording.test.mjs 2>&1 | tail -5`

Expected: `# pass <N+6>`, `# fail 0`.

- [ ] **Step 4: Commit (GREEN state)**

```bash
git add bids-recording.js
git commit -m "feat(bids-recording): add discoverSubject helper (participants.tsv + S3-list)"
```

---

## Task 4: Wire `?sub=` omission into `resolveTargets`

**Files:**
- Modify: `tests/unit-bids-recording.test.mjs` (insert after the last resolveTargets test, around line 1727 — search for the existing `?acq= propagated` test)
- Modify: `bids-recording.js` (modify the `if (p.has('dataset'))` block around line 889-934)

- [ ] **Step 1: Write the failing test for the new descriptor kind**

Open `tests/unit-bids-recording.test.mjs`. Find the test `'resolveTargets: ?acq= propagated through to params.acq'` (around line 1713). Insert AFTER that test's closing `});`:

```js
test('resolveTargets: ?dataset= without ?sub= returns bids-path-discover-sub', () => {
  // ds003774 omits ?sub= → resolveTargets defers subject discovery to
  // the viewer's boot dispatcher, which calls discoverSubject. This
  // avoids the prior failure mode where buildBidsRelpath blindly used
  // 'sub-01' and 404'd against a dataset using 'sub-001'.
  const t = BIDSRecording.resolveTargets(new URLSearchParams(
    'dataset=ds003774&task=MusicListening&ext=set'));
  assert.equal(t.kind, 'bids-path-discover-sub');
  assert.equal(t.params.dataset, 'ds003774');
  assert.equal(t.params.sub, null,
    'sub should be null — discovery happens in boot()');
  assert.equal(t.params.task, 'MusicListening');
  assert.equal(t.params.ext, 'set');
});

test('resolveTargets: ?dataset= without ?sub= AND without ?suffix= still returns bids-path-discover-sub (discovery handles both)', () => {
  // Both suffix and sub are missing. The new descriptor kind owns both
  // discovery passes — once the sub is known, the existing
  // discoverSuffix pipeline runs in boot() to find the modality.
  const t = BIDSRecording.resolveTargets(new URLSearchParams(
    'dataset=ds003774&ext=set'));
  assert.equal(t.kind, 'bids-path-discover-sub');
  assert.equal(t.params.sub, null);
  assert.equal(t.params.suffix, undefined,
    'no explicit suffix yet — boot() will discover after sub');
});

test('resolveTargets: ?dataset= WITH explicit ?sub= still returns bids-path-auto (no subject discovery)', () => {
  // Regression guard: when the user spelled out ?sub=, we MUST NOT
  // engage subject discovery — that would be wasted fetches. The
  // existing modality-auto-detect path is used unchanged.
  const t = BIDSRecording.resolveTargets(new URLSearchParams(
    'dataset=ds003774&sub=001&task=MusicListening&ext=set'));
  assert.equal(t.kind, 'bids-path-auto',
    'explicit ?sub= should bypass subject discovery entirely');
  assert.equal(t.params.sub, '001');
});

test('resolveTargets: ?dataset= WITH ?sub= AND ?suffix= still returns bids-path (no discovery at all)', () => {
  // Full deep-link path. Zero discovery overhead.
  const t = BIDSRecording.resolveTargets(new URLSearchParams(
    'dataset=ds003774&sub=001&task=MusicListening&suffix=eeg&ext=set'));
  assert.equal(t.kind, 'bids-path');
  assert.ok(t.eeg_url.includes('/sub-001/'),
    'URL should be pre-built with the explicit sub');
});
```

- [ ] **Step 2: Run the new tests — expect 4 failures**

Run: `node --test tests/unit-bids-recording.test.mjs 2>&1 | grep -E "bids-path-discover-sub|fail" | head -20`

Expected: 2 fails on the discover-sub tests (because the current code returns `bids-path-auto` instead). The 2 regression-guard tests already pass (because `?sub=001` is supplied — current behavior is correct for those).

- [ ] **Step 3: Modify `resolveTargets` to emit the new kind**

Open `bids-recording.js`. Find the block starting `if (p.has('dataset'))` at line 889. Locate the suffix-policy block (lines 909-929). REPLACE the entire block from `const explicitSuffix = p.get('suffix');` through the closing `}` of the `if (p.has('dataset'))` body with:

```js
      const explicitSuffix = p.get('suffix');
      if (explicitSuffix) params.suffix = explicitSuffix;
      // NEMAR (nm-prefixed) datasets resolve via the eegdash records
      // API instead of a direct bucket URL — git-annex SHA addressing.
      // NEMAR manifests enumerate subjects, so subject discovery is
      // not needed for the NEMAR branch — it falls through to nemar
      // regardless of whether sub is set.
      if (api.isNemarDatasetId(ds)) {
        params.suffix = params.suffix || 'eeg';
        return { kind: 'nemar', nemar_params: params };
      }
      // Subject discovery: when ?sub= is omitted, defer building the
      // URL to boot(), which calls api.discoverSubject and then
      // re-enters the (sub-set) resolution path. Owns both discovery
      // passes — once the sub is known, modality discovery may also
      // need to run if ?suffix= was also omitted.
      if (!params.sub) {
        return { kind: 'bids-path-discover-sub', params };
      }
      if (!explicitSuffix) {
        return { kind: 'bids-path-auto', params };
      }
      return {
        kind: 'bids-path',
        eeg_url: api.buildOpenNeuroEegUrl(params),
      };
```

- [ ] **Step 4: Run the 4 new tests — expect all pass**

Run: `node --test tests/unit-bids-recording.test.mjs 2>&1 | grep -E "resolveTargets.*discover|resolveTargets.*sub.*suffix" | head -10`

Expected: 4 pass.

- [ ] **Step 5: Run the full file and check no resolveTargets regression**

Run: `node --test tests/unit-bids-recording.test.mjs 2>&1 | tail -10`

Expected: 0 failures. If `resolveTargets: ?dataset= (no ?suffix=) returns bids-path-auto for modality probe` (line 192) or `resolveTargets: ?dataset=ds001 (no ?suffix=) → kind:bids-path-auto for probe` (line 666) now fails, those tests were exercising the no-sub case unintentionally — they were always assuming `sub` was implicit. Inspect those tests and confirm they include `sub=...` in their URLSearchParams. If they don't, FIX the test by adding `&sub=01` to its URL (those tests are about modality probing, not subject discovery — making the sub explicit is the correct fix). Do NOT relax the production code.

Likely affected:
- Line 192-205: `'resolveTargets: ?dataset= (no ?suffix=) returns bids-path-auto for modality probe'` — its URLSearchParams likely is `'dataset=ds003688&sub=01&...'`. Verify by Read.
- Line 666-672: `'resolveTargets: ?dataset=ds001 (no ?suffix=) → kind:bids-path-auto for probe'` — same.

Both likely already include `sub=01`. If so, no edit needed. If not, add `&sub=01` to the param string.

- [ ] **Step 6: Commit**

```bash
git add bids-recording.js tests/unit-bids-recording.test.mjs
git commit -m "feat(bids-recording): emit bids-path-discover-sub when ?sub= omitted"
```

---

## Task 5: Wire the new descriptor into `viewer.js` boot()

**Files:**
- Modify: `viewer.js:1640-1668` (the boot() dispatch switch)

- [ ] **Step 1: Read the current dispatch order**

Read: `viewer.js:1639-1668`. Confirm structure: `if-else if-else if` chain on `target?.kind`. We will insert a new `else if (target?.kind === 'bids-path-discover-sub')` branch BEFORE `bids-path-auto` so that the discover-sub case can fall through to modality auto-detect after the sub is found.

- [ ] **Step 2: Modify the dispatch chain**

Open `viewer.js`. Locate the block starting on line 1640:

```js
    if (target?.kind === 'url' || target?.kind === 'bids-path') {
      load(target.eeg_url);
    } else if (target?.kind === 'bids-path-auto') {
```

REPLACE that block through the end of the `else if (target?.kind === 'bids-path-auto')` branch (the entire `.then().catch()` chain ending around line 1660) with:

```js
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
```

- [ ] **Step 3: Run the entire test suite to confirm no boot()-adjacent regression**

Run: `node --test tests/ 2>&1 | tail -10`

Expected: All tests pass. boot() isn't directly tested (it's a DOM entry point), but viewer-adjacent tests (e.g. `unit-viewer-api.test.mjs`, `integration*.test.mjs`) should still pass.

- [ ] **Step 4: Commit**

```bash
git add viewer.js
git commit -m "feat(viewer): dispatch bids-path-discover-sub through discoverSubject pipeline"
```

---

## Task 6: Add `discoverSubject` to the api-surface snapshot

**Files:**
- Modify: `tests/unit-api-surface.test.mjs`

- [ ] **Step 1: Inspect the current snapshot — `bids-recording.js` not yet listed**

Read: `tests/unit-api-surface.test.mjs:37-88`. Confirm `'../bids-recording.js'` is NOT a key in `EXPECTED`. The snapshot test does not currently cover the BIDS-recording module's surface — we will add it now.

- [ ] **Step 2: Determine the current public surface of `bids-recording.js`**

Run: `node -e "globalThis.window=globalThis.window||{}; const m=require('./bids-recording.js'); console.log(Object.keys(m).filter(k=>!k.startsWith('_')).sort().join('\n'))"`

Expected output (after Task 3 lands `discoverSubject`):
```
buildOpenNeuroEegUrl
discoverSubject
discoverSuffix
isNemarDatasetId
loadNemarRecordingMetadata
loadRecordingMetadata
parseChannelsTsv
parseEegUrl
parseEventsTsv
parsePhysioUrl
resolveTargets
```

(The actual list may include 1-2 more entries — copy the actual output verbatim into the snapshot.)

- [ ] **Step 3: Add the `bids-recording.js` entry to EXPECTED**

Open `tests/unit-api-surface.test.mjs`. After the `'../bids-loader.js': [ ... ]` entry (line 84-87), insert:

```js
  '../bids-recording.js': [
    'buildOpenNeuroEegUrl',
    'discoverSubject',
    'discoverSuffix',
    'isNemarDatasetId',
    'loadNemarRecordingMetadata',
    'loadRecordingMetadata',
    'parseChannelsTsv',
    'parseEegUrl',
    'parseEventsTsv',
    'parsePhysioUrl',
    'resolveTargets',
  ],
```

If the actual output from Step 2 differs from the above, USE THE ACTUAL OUTPUT. The snapshot must match reality, not this plan's guess.

- [ ] **Step 4: Run the api-surface test**

Run: `node --test tests/unit-api-surface.test.mjs 2>&1 | tail -15`

Expected: All tests pass, including the new `api-surface: ../bids-recording.js public keys are stable`.

If it fails with `added: [...]` or `removed: [...]`, replace the snapshot literal with the exact contents of the `actual` list reported in the assertion error message.

- [ ] **Step 5: Commit**

```bash
git add tests/unit-api-surface.test.mjs
git commit -m "test(api-surface): snapshot bids-recording.js public keys (includes discoverSubject)"
```

---

## Task 7: Bump cache-busting versions in `index.html`

**Files:**
- Modify: `index.html:17` (`bids-recording.js?v=5` → `?v=6`)
- Modify: `index.html:24` (`viewer.js?v=4` → `?v=5`)

- [ ] **Step 1: Bump bids-recording.js cache version**

Edit `index.html` line 17. Change:

```html
<script src="bids-recording.js?v=5"></script>
```

To:

```html
<script src="bids-recording.js?v=6"></script>
```

- [ ] **Step 2: Bump viewer.js cache version**

Edit `index.html` line 24. Change:

```html
<script src="viewer.js?v=4"></script>
```

To:

```html
<script src="viewer.js?v=5"></script>
```

Per the convention in commit `714772d` (`fix(cache): bump ?v= on JS files changed since last bump`), every JS file modified in this plan that is referenced from `index.html` must have its `?v=N` incremented to bust browser caches. `bids-recording.js` and `viewer.js` are the two we touched.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "fix(cache): bump ?v= on bids-recording.js + viewer.js for subject discovery"
```

---

## Task 8: Manual browser verification

**Files:** none (manual)

- [ ] **Step 1: Start the local dev server**

Run: `node scripts/serve.mjs &`

Expected: Server listens on `http://localhost:8080` (or the port the script prints — note it).

- [ ] **Step 2: Open the broken-before URL in Firefox**

Open in Firefox: `http://localhost:8080/?dataset=ds003774&task=MusicListening&ext=set`

Expected: Brief status text "Detecting subject..." → then "Detecting modality..." → then the recording loads and the traces render. No 404 in the network panel.

If the load fails:
- Check the browser console for the actual error.
- Check the Network panel for the request to `cdn.eegdash.org/ds003774/participants.tsv` (expected: 404, since ds003774 has no participants.tsv) followed by `s3.amazonaws.com/openneuro.org?list-type=2&prefix=ds003774%2Fsub-` (expected: 200 with XML).
- If the S3 list 200s but the next fetch 404s, the discovered `sub` may be wrong — inspect the XML response body.

- [ ] **Step 3: Verify the zero-overhead path still works**

Open in Firefox: `http://localhost:8080/?dataset=ds003774&sub=001&task=MusicListening&suffix=eeg&ext=set`

Expected: Loads immediately. No "Detecting subject..." status. Network panel shows ONE request (the recording itself), zero discovery fetches.

- [ ] **Step 4: Verify the sub-discovery + modality-discovery combo**

Open in Firefox: `http://localhost:8080/?dataset=ds002778&ext=bdf`

Expected: "Detecting subject..." → discovers `sub-hc1` → "Detecting modality..." → discovers `eeg` → loads. Note that ds002778 was listed in the audit with `sub-hc1` — the non-numeric ID is the regression case.

- [ ] **Step 5: Save evidence**

Run: `mkdir -p tests/evidence/subject-discovery && curl -s "http://localhost:8080/?dataset=ds003774&task=MusicListening&ext=set" -o tests/evidence/subject-discovery/index.html` (this just captures the HTML, not the rendered state — the real proof is the working Firefox tab).

Take a Firefox screenshot of the rendered traces and save to `tests/evidence/subject-discovery/ds003774-loaded.png`. (Use Firefox Devtools → Take screenshot, or the OS screenshot tool.)

- [ ] **Step 6: Kill the dev server**

Run: `pkill -f "scripts/serve.mjs"`

- [ ] **Step 7: Commit evidence**

```bash
git add tests/evidence/subject-discovery/
git commit -m "test(evidence): subject discovery loads ds003774 without ?sub="
```

---

## Task 9: Update the audit doc with the coverage lift

**Files:**
- Modify: `docs/audit-100-datasets-2026-05-21.md` (the "What would push the number to 95%+" table around line 70 + the "EEG (4 failures)" subsection around line 44)

- [ ] **Step 1: Update the EEG failures subsection**

Find the section `### EEG (4 failures) — mixed root causes` (around line 44). REPLACE the bullet list with:

```markdown
- `ds003620`: subject discovery falls back to `sub-01` but no `participants.tsv` exists and the S3 listing for `sub-*` returns derived/processed files first. **FIXED 2026-05-21**: viewer now auto-discovers subject via `participants.tsv` → S3-list fallback (see `bids-recording.js` `api.discoverSubject`, plan `docs/superpowers/plans/2026-05-21-subject-discovery.md`).
- `ds003774`: same root cause — missing `participants.tsv`, S3 listing surfaces `Code/ESongs/*.wav` instead of subject directories. **FIXED 2026-05-21**: same fix as above.

Both are now loadable from minimal URLs (`?dataset=ds003774&task=MusicListening&ext=set` — no `?sub=` needed). The fix raises overall loadable rate from 80% → **82%** (4 → 6 EEG loadable, 66 → 68 EEG total, project-wide 80 → 82).
```

- [ ] **Step 2: Update the "What would push the number to 95%+" table**

Find the table around line 70. REPLACE the row about "Better subject discovery" with:

```markdown
| Better subject discovery (fall back to S3 prefix list when participants.tsv missing) | +2 | **SHIPPED 2026-05-21** (plan `docs/superpowers/plans/2026-05-21-subject-discovery.md`) |
```

- [ ] **Step 3: Update the headline**

Find the headline at the top: `**80 of 100 datasets are loadable in the viewer.**`. REPLACE with:

```markdown
**82 of 100 datasets are loadable in the viewer (post subject-discovery fix, 2026-05-21).**

> Original audit: 80/100. The +2 lift came from `api.discoverSubject` (commit landing 2026-05-21), which probes `participants.tsv` → S3 prefix-list when `?sub=` is omitted from the viewer URL. See plan `docs/superpowers/plans/2026-05-21-subject-discovery.md`.
```

Update the per-datatype table immediately below the headline:

```markdown
| Datatype | Loadable | Total in sample | % |
|---|---:|---:|---:|
| iEEG | 3 | 3 | **100.0%** |
| EEG | 68 | 70 | **97.1%** |
| MEG | 11 | 27 | **40.7%** |
```

(EEG went from 66 → 68 of 70; iEEG and MEG unchanged.)

- [ ] **Step 4: Commit**

```bash
git add docs/audit-100-datasets-2026-05-21.md
git commit -m "docs(audit): record +2 EEG coverage lift from subject auto-discovery"
```

---

## Task 10: Final test sweep + commit-log review

**Files:** none

- [ ] **Step 1: Run the full unit test suite**

Run: `node --test tests/ 2>&1 | tail -10`

Expected: All tests pass. No regressions. Total test count should be up by ~10 (6 discoverSubject tests + 4 resolveTargets tests + 1 api-surface snapshot).

- [ ] **Step 2: Lint check (if configured)**

Run: `npx eslint bids-recording.js viewer.js tests/unit-bids-recording.test.mjs tests/unit-api-surface.test.mjs 2>&1 | tail -20`

Expected: No new lint errors. If eslint is not configured, skip this step (check `package.json` for a `lint` script — if absent, this step is a no-op).

- [ ] **Step 3: Confirm commit log shape**

Run: `git log --oneline -10`

Expected (top 7-8 commits, in order):
```
docs(audit): record +2 EEG coverage lift from subject auto-discovery
test(evidence): subject discovery loads ds003774 without ?sub=
fix(cache): bump ?v= on bids-recording.js + viewer.js for subject discovery
test(api-surface): snapshot bids-recording.js public keys (includes discoverSubject)
feat(viewer): dispatch bids-path-discover-sub through discoverSubject pipeline
feat(bids-recording): emit bids-path-discover-sub when ?sub= omitted
feat(bids-recording): add discoverSubject helper (participants.tsv + S3-list)
test(bids-recording): add 6 failing tests for discoverSubject helper
```

- [ ] **Step 4: Final smoke — run only the touched test files**

Run: `node --test tests/unit-bids-recording.test.mjs tests/unit-api-surface.test.mjs 2>&1 | tail -10`

Expected: All pass.

- [ ] **Step 5: Push? (only if user explicitly approves)**

Do NOT push without explicit user approval. End the plan with a summary message:

> "Subject discovery shipped. 10 commits across `bids-recording.js`, `viewer.js`, 2 test files, `index.html`, and the audit doc. Verified manually on ds003774 and ds002778. Ready to push?"

---

## Self-review notes (engineer reading the plan)

- Every test uses the exact `globalThis.fetch = async (url) => {...}; try { ... } finally { delete globalThis.fetch }` pattern from the existing `discoverSuffix` tests — no new test infrastructure.
- The `_PARTICIPANTS_BUCKET` constant in Task 3 mirrors the `_DIRECT_S3` bucket-selection logic of `buildOpenNeuroEegUrl` (line 137-141), so `?direct=1` continues to route correctly.
- The S3 list URL hits raw `s3.amazonaws.com` always (not the CDN), because the Cloudflare Worker proxy in `cdn-worker/` only handles object GETs, not `?list-type=2` queries.
- `viewer.js` Task 5 nests `discoverSuffix` inside the `discoverSubject` callback when both are needed. This is sequential (not parallel) — we can't probe modality until we know the subject, because the URL path includes `/sub-<X>/<datatype>/`. Wall-clock impact: ~100ms for participants.tsv + ~200ms for modality probe = ~300ms total. Acceptable for a once-per-page-load discovery.
- The 6 discoverSubject tests + 4 resolveTargets tests + 1 api-surface snapshot = 11 new test assertions covering: TSV-present, TSV strip-prefix, S3-fallback, non-numeric sub IDs, both-fail-null, S3-empty-null, descriptor with no sub, descriptor with no sub+no suffix, explicit-sub-skips-discovery, full deep-link skips all discovery, surface stability.
- No new dependencies. No build step changes. Cache-bust convention matches commit `714772d`.
