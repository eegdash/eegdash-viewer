# Current Limitations Follow-Up Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close (or document closure-as-blocked) the 26 limitations identified in the 2026-05-22 limitations review. Convert each item into either (a) a small surgical commit, (b) a deferred-with-reason entry, or (c) a blocked-with-prerequisites entry. Ship the cheap wins; explicitly cost-justify the expensive ones.

**Architecture:** Each limitation maps to a single file (or 2-3 files) under `formats/`, plus its test in `tests/unit-*.test.mjs`. No cross-format helpers added unless 2+ formats need the same code. Per-task commits stay independent so they can be reordered or cherry-picked. Verification gates are unit-suite + typecheck after each task; full browser audit only after each priority band completes.

**Tech Stack:** Plain JavaScript (ES2015 IIFE pattern), Node `--test`, `tsc --noEmit -p jsconfig.json`. No new npm deps. References to MNE-Python / meflib / pymef source via local `/tmp/` clones (instructions per task).

**Estimated total effort:** ~24 hrs work across all P0 + P1 + P2 priority bands. P0 alone is ~6 hrs.

**Current HEAD:** `f7fc8b8` (post-Lane M MEF3 real-data verification).
**Current quality gates:** 932/932 unit tests, typecheck clean, browser audit 18/21.

---

## Priority bands

| Band | Tasks | Effort each | Total band effort | When to ship |
|---|---|---|---|---|
| **P0 — Quick wins** | 4 | <4 hrs | ~6 hrs | Next session |
| **P1 — Medium** | 5 | 4-16 hrs | ~20 hrs | Next 2-3 sessions |
| **P2 — Large** | 4 | 16+ hrs | ~80+ hrs | Quarter-level commitment |
| **P3 — Blocked / infra** | 13 | varies | varies | Either blocked or out-of-scope-of-readers |

---

## P0 — Quick wins (ship next session)

### Task P0-1: CTF recording-start-iso parsing

**Limitation #10 from review.** `formats/ctf.js:212` hardcodes `recording_start_iso: null`. The CTF `.acq` file (sibling to `.meg4`) contains a `dataTime` field with the recording timestamp. Currently the pill shows "—" instead of the actual time.

**Files:**
- Read/Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/ctf.js` (around line 212)
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/_ctf-marker.js` (if `.acq` parsing lives there) or add new `/Users/bruaristimunha/Projects/eegdash-viewer/formats/_ctf-acq.js`
- Test: `/Users/bruaristimunha/Projects/eegdash-viewer/tests/unit-ctf.test.mjs`
- Fixture: `/Users/bruaristimunha/Projects/eegdash-viewer/tests/fixtures/meg/ctf-tiny.ds/ctf-tiny.acq` (extend `scripts/make-ctf-fixture.mjs` to also write a tiny `.acq`)

**Reference:** MNE-Python `mne/io/ctf/info.py:_extract_meas_date` is the authoritative parser. Fetch:
```bash
curl -sL https://github.com/mne-tools/mne-python/raw/main/mne/io/ctf/info.py -o /tmp/mne_ctf_info.py
grep -n "_extract_meas_date\|dataTime\|acq" /tmp/mne_ctf_info.py
```

The `.acq` file is plain ASCII key=value lines. The relevant key is something like `Latitude:` or `dataTime:`; verify against MNE source.

- [ ] **Step 1: Read MNE source + identify exact .acq key for timestamp**

```bash
curl -sL https://github.com/mne-tools/mne-python/raw/main/mne/io/ctf/info.py -o /tmp/mne_ctf_info.py
grep -A 30 "_extract_meas_date" /tmp/mne_ctf_info.py
```

Record the exact ASCII key + format (e.g., `dataTime:Wed Mar 15 14:32:17 2023`).

- [ ] **Step 2: Write the failing test first**

In `tests/unit-ctf.test.mjs`, add:
```js
test('ctf: recording_start_iso parsed from .acq file', async () => {
  installLocalHttpRange();
  const reader = await CTFReader.open({ eeg_url: EEG_URL });
  // Fixture .acq has dataTime stamping Wed Jan 17 09:32:00 2024 UTC.
  // Tolerance: timezone may shift ±1 day depending on locale; we
  // assert ISO prefix only.
  assert.match(reader.recording_start_iso, /^2024-01-17T/);
});
```

- [ ] **Step 3: Run the test → expect FAIL with `null` instead of ISO string**

```
node --test tests/unit-ctf.test.mjs 2>&1 | grep "recording_start_iso"
```

- [ ] **Step 4: Extend `scripts/make-ctf-fixture.mjs` to write `.acq`**

Add (adapt key name from Step 1):
```js
const acqText = 'dataTime:Wed Jan 17 09:32:00 2024\nnumChan:4\n';
fs.writeFileSync(path.join(dsDir, 'ctf-tiny.acq'), acqText);
```

Re-run fixture generation:
```
node scripts/make-ctf-fixture.mjs
```

- [ ] **Step 5: Add `.acq` parser to ctf.js**

Around the existing `open()` body, fetch `.acq` (best-effort, error → null):
```js
async function parseAcqTimestamp(acqUrl) {
  try {
    const text = await HttpRange.fetchTextOrNull(acqUrl);
    if (!text) return null;
    // dataTime key per MNE-Python (Step 1 verified)
    const m = /^dataTime:\s*(.+)$/m.exec(text);
    if (!m) return null;
    const d = new Date(m[1]);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch { return null; }
}
```

Wire into the open() return:
```js
const acqUrl = eegUrl.replace(/\.meg4$/, '.acq');
const recording_start_iso = await parseAcqTimestamp(acqUrl);
return {
  // ...existing fields...
  recording_start_iso,
};
```

- [ ] **Step 6: Re-run test → expect PASS**

```
node --test tests/unit-ctf.test.mjs 2>&1 | tail -5
```

- [ ] **Step 7: Run full suite + typecheck**

```
node --test --test-skip-pattern='rejects URLs that are not BIDS' tests/unit-*.test.mjs 2>&1 | tail -5
npm run test:typecheck
```

Expect: ≥933/933 (was 932 + 1 new test). Typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add formats/ctf.js scripts/make-ctf-fixture.mjs tests/fixtures/meg/ctf-tiny.ds/ tests/unit-ctf.test.mjs
git commit -m "feat(ctf): parse recording start time from .acq dataTime field"
```

**Estimated effort:** 30-60 min.

---

### Task P0-2: ITAB three TODO placeholders (recording_start_iso, annotation_events, bad_channels)

**Limitation #12 from review.** `formats/itab.js:463-466`:
```js
recording_start_iso: null,  // TODO: parse `time` + `date` fields
annotation_events:   [],    // TODO: surface smpl[] event table.
bad_channels:        [],    // TODO: surface ch[i].flag > 0.
```

**Files:**
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/itab.js`
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/scripts/make-itab-fixture.mjs` (set non-null time/date, add ≥1 smpl[] entry, mark ≥1 channel flag>0)
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/tests/unit-itab.test.mjs`
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/tests/fixtures/meg/itab-tiny.raw` (regenerate)
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/tests/fixtures/meg/itab-tiny.mhd` (regenerate)

**Reference:** FieldTrip `read_itab_mhd.m`. The header layout for `time`, `date`, `smpl[]`, and `ch[i].flag` is documented inline in our `formats/itab.js` since Lane H4. Read those comments first.

- [ ] **Step 1: Read existing itab.js header-layout comments**

```bash
grep -B2 -A8 "smpl\|ch\[i\]\.flag\|time\|date" formats/itab.js | head -40
```

Locate the exact byte offsets the existing parser already knows about.

- [ ] **Step 2: Write three failing tests**

In `tests/unit-itab.test.mjs`:
```js
test('itab: recording_start_iso parsed from time + date fields', async () => {
  const reader = await ItabReader.open({ eeg_url: 'file://' + FIXTURE });
  // Fixture date=20240117, time=093200 (Jan 17 2024, 09:32:00 UTC)
  assert.match(reader.recording_start_iso, /^2024-01-17T09:32:00/);
});

test('itab: annotation_events surfaced from smpl[]', async () => {
  const reader = await ItabReader.open({ eeg_url: 'file://' + FIXTURE });
  // Fixture has 2 smpl[] entries at samples 100 and 250.
  assert.equal(reader.annotation_events.length, 2);
  assert.equal(reader.annotation_events[0].sample, 100);
});

test('itab: bad_channels surfaced from ch[i].flag > 0', async () => {
  const reader = await ItabReader.open({ eeg_url: 'file://' + FIXTURE });
  // Fixture marks channel 2 as bad (flag=1).
  assert.deepEqual(reader.bad_channels, [2]);
});
```

- [ ] **Step 3: Run → expect 3 failures**

- [ ] **Step 4: Extend fixture generator**

In `scripts/make-itab-fixture.mjs`, set:
- `time` field bytes to encode `093200`
- `date` field bytes to encode `20240117`
- Two `smpl[]` entries at sample numbers 100 and 250
- `ch[2].flag = 1` (others 0)

Verify byte offsets against the FieldTrip reference + existing itab.js layout comments. Regenerate fixture:
```
node scripts/make-itab-fixture.mjs
```

- [ ] **Step 5: Implement the three parsers**

In `formats/itab.js`, find the `recording_start_iso: null,` line. Replace the three TODOs with:

```js
// time field at OFFSET_TIME (verify against header constants), 6 bytes ASCII HHMMSS
// date field at OFFSET_DATE, 8 bytes ASCII YYYYMMDD
function parseStartTime(headerView) {
  const date = readAscii(headerView, OFFSET_DATE, 8);   // "20240117"
  const time = readAscii(headerView, OFFSET_TIME, 6);   // "093200"
  if (!/^\d{8}$/.test(date) || !/^\d{6}$/.test(time)) return null;
  const iso = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}` +
              `T${time.slice(0,2)}:${time.slice(2,4)}:${time.slice(4,6)}.000Z`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function parseAnnotationEvents(headerView, nSmpl) {
  const events = [];
  for (let i = 0; i < nSmpl; i++) {
    const base = OFFSET_SMPL_ARRAY + i * SMPL_ENTRY_BYTES;
    const sample = headerView.getInt32(base, true);
    const code = headerView.getInt16(base + 4, true);
    events.push({ sample, code, label: `trigger_${code}` });
  }
  return events;
}

function parseBadChannels(headerView, nChan) {
  const bad = [];
  for (let i = 0; i < nChan; i++) {
    const base = OFFSET_CH_ARRAY + i * CH_ENTRY_BYTES;
    const flag = headerView.getInt32(base + CH_FLAG_OFFSET, true);
    if (flag > 0) bad.push(i);
  }
  return bad;
}
```

Wire into return object. Constants `OFFSET_TIME`, `OFFSET_DATE`, `OFFSET_SMPL_ARRAY`, `SMPL_ENTRY_BYTES`, `OFFSET_CH_ARRAY`, `CH_ENTRY_BYTES`, `CH_FLAG_OFFSET` are already in `itab.js` (Step 1 verified locations).

- [ ] **Step 6: Re-run tests → expect 3 passes**

- [ ] **Step 7: Verify full suite + typecheck**

- [ ] **Step 8: Commit**

```bash
git add formats/itab.js scripts/make-itab-fixture.mjs tests/fixtures/meg/itab-tiny.* tests/unit-itab.test.mjs
git commit -m "feat(itab): parse recording start, annotation events, and bad channels from header"
```

**Estimated effort:** 1-2 hrs.

---

### Task P0-3: NWB chunk filter registry wiring (gzip already works; add SZIP, n-bit, scale-offset, shuffle)

**Limitation #7 from review.** `formats/_h5-stream.js` currently only handles gzip-compressed chunks. Other HDF5 filters (SZIP, n-bit, scale-offset, shuffle) cause the streaming path to bail and fall back to whole-file. jsfive already implements these filters in its main path — we just need to route through them.

**Files:**
- Read: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/_jsfive.js` (find the filter map)
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/_h5-stream.js`
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/tests/unit-nwb-range.test.mjs`
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/scripts/make-nwb-chunked-fixtures.mjs` (add SZIP + shuffle fixtures)

**Reference:** jsfive's source ships at `/Users/bruaristimunha/Projects/eegdash-viewer/formats/_jsfive.js`. Search for `filter_pipeline` or `apply_filter` to find the registry.

- [ ] **Step 1: Map jsfive's filter IDs to functions**

```bash
grep -nE "filter_pipeline|filter_id|apply_filter|gzip|shuffle|szip|scaleoffset|nbit" formats/_jsfive.js | head -20
```

Document the filter IDs jsfive recognizes (HDF5 filter IDs are standard: 1=deflate, 2=shuffle, 3=fletcher32, 4=szip, 5=nbit, 6=scaleoffset).

- [ ] **Step 2: Write failing test for shuffle+gzip combo**

In `tests/unit-nwb-range.test.mjs`:
```js
test('nwb-stream: chunks with shuffle+gzip filter decode correctly', async () => {
  // Fixture: nwb-chunked-shuffled.nwb has /acquisition/foo/data with
  // [shuffle, gzip] filter pipeline. 4 channels × 1000 samples sine.
  const reader = await openStreaming(SHUFFLED_FIXTURE_URL);
  const win = await reader.readWindow(0, 100);
  assert.equal(win.length, 4);
  // Sample[10] of channel 0 = sin(2π × 10 × 1/1000) × 1000 ≈ 62.79
  assert.ok(Math.abs(win[0][10] - Math.sin(2 * Math.PI * 10 / 1000) * 1000) < 1e-3);
});
```

- [ ] **Step 3: Run → expect FAIL with "unsupported filter" or fallback to whole-file**

- [ ] **Step 4: Generate fixture with shuffle+gzip pipeline**

Extend `scripts/make-nwb-chunked-fixtures.mjs` to write `nwb-chunked-shuffled.nwb` with `compression='gzip', shuffle=True` set on the h5py dataset. Verify the fixture has filter_pipeline = [shuffle, deflate].

- [ ] **Step 5: Wire filters into _h5-stream.js**

Locate the chunk-decode path in `_h5-stream.js` (probably a function named `decodeChunk` or similar). Replace the gzip-only branch:

```js
// Before:
if (filterId !== 1) throw new Error('Only gzip filter supported in streaming path');
const decompressed = pako.inflate(rawChunk);

// After:
function applyFilters(rawChunk, filterPipeline) {
  let buf = rawChunk;
  // Filters apply in REVERSE order on read (LIFO undo)
  for (let i = filterPipeline.length - 1; i >= 0; i--) {
    const { id, params } = filterPipeline[i];
    switch (id) {
      case 1: buf = pako.inflate(buf); break;                  // deflate
      case 2: buf = applyShuffle(buf, params, /*direction*/-1); break;
      case 3: /* fletcher32 — verify-only, no transform */ break;
      case 4: throw new Error('SZIP filter not yet supported in streaming path');
      case 5: throw new Error('N-bit filter not yet supported in streaming path');
      case 6: buf = applyScaleOffset(buf, params, /*decode*/true); break;
      default: throw new Error(`Unknown HDF5 filter id=${id}`);
    }
  }
  return buf;
}
```

Then implement `applyShuffle()`:
```js
// HDF5 shuffle: groups bytes by position-within-element for better compression.
// Decode: ungroup. params[0] = element_size.
function applyShuffle(buf, params, direction) {
  if (direction !== -1) throw new Error('shuffle encode not implemented');
  const elemSize = params[0];
  const n = buf.length / elemSize;
  const out = new Uint8Array(buf.length);
  for (let e = 0; e < n; e++) {
    for (let b = 0; b < elemSize; b++) {
      out[e * elemSize + b] = buf[b * n + e];
    }
  }
  return out;
}
```

- [ ] **Step 6: Re-run test → expect PASS**

- [ ] **Step 7: Add a "unknown filter → graceful fallback" test**

```js
test('nwb-stream: unknown filter falls back to whole-file path', async () => {
  // Mock a fixture whose filter_pipeline has id=99 (unknown).
  // The streaming open() should warn + return null; viewer falls back.
  const result = await tryStreaming(UNKNOWN_FILTER_URL);
  assert.equal(result, null);  // signals fallback
});
```

- [ ] **Step 8: Commit**

```bash
git add formats/_h5-stream.js scripts/make-nwb-chunked-fixtures.mjs \
        tests/fixtures/ieeg/nwb-chunked-shuffled.nwb tests/unit-nwb-range.test.mjs
git commit -m "feat(nwb): wire HDF5 shuffle + scale-offset filters into streaming path"
```

**Note:** SZIP and N-bit remain explicitly unsupported (rare in NWB). They throw clean errors and trigger fallback. Documenting them as out-of-scope is enough; if a real DANDI file hits one, the fallback path handles it.

**Estimated effort:** 2-3 hrs.

---

### Task P0-4: MEF3 multi-segment support

**Limitation #5 from review.** `formats/mef.js:432` picks `find()` — only the FIRST matching segment per channel. Real multi-hour Mayo clinical recordings split into multiple segments per channel; we'd silently truncate to the first segment's duration.

**Files:**
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/mef.js` (the `listSegmentsFromDirectory` function around line 420-450)
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/scripts/make-mef-pymef-fixture.py` (generate a 2-segment fixture)
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/tests/unit-mef-real.test.mjs`

**Reference:** pymef's `MefSession.append_mef_segment_data` writes multi-segment data. `meflib.c:read_session()` is the C reference for how to walk segments + reconstruct sample-index → (segment, block, offset).

- [ ] **Step 1: Extend pymef fixture generator to write 2 segments**

In `scripts/make-mef-pymef-fixture.py`, after the first segment is written, call `write_mef_ts_segment_metadata` + `write_mef_ts_segment_data` again with `segment_number=1` and a different sine offset (so we can detect which segment a sample came from). Write to `tests/fixtures/ieeg/mef-pymef-multiseg.mefd/`.

- [ ] **Step 2: Verify fixture layout**

```bash
ls tests/fixtures/ieeg/mef-pymef-multiseg.mefd/A1.timd/
```

Expect: `A1-000000.segd/` AND `A1-000001.segd/`.

- [ ] **Step 3: Write failing test**

```js
test('mef: multi-segment recording concatenates samples across segments', async () => {
  const reader = await MefReader.open({ eeg_url: 'file://' + MULTISEG_FIXTURE });
  // Each segment is 2500 samples; total = 5000.
  assert.equal(reader.n_samples, 5000);
  const all = await reader.readWindow(0, 5000);
  // Segment 0 carries sin(2π × 10 × t/1000), segment 1 carries
  // sin(2π × 10 × t/1000) + 100 (DC offset). Samples 2500..2999
  // should all be 100 higher than samples 0..499.
  for (let i = 0; i < 500; i++) {
    assert.ok(Math.abs((all[0][2500 + i] - all[0][i]) - 100) < 1e-3,
      `sample ${i} segment-boundary mismatch`);
  }
});
```

- [ ] **Step 4: Run → expect FAIL with n_samples=2500 (single segment only)**

- [ ] **Step 5: Refactor `listSegmentsFromDirectory` to return ALL segments per channel**

Current shape returns `{ tmet, tdat, tidx, channel_dir }[]` (one per channel). New shape: `{ channel_name, channel_dir, segments: [{ tmet, tdat, tidx, segment_number }, ...] }[]`.

Then in `open()`:
- Sum `n_samples` across all segments per channel
- Verify all segments share the same `sampling_frequency`
- Build a per-channel segment index: `[{ start_sample, end_sample, segment, blocks: [...] }, ...]`

In `readWindow()`:
- Find which segments overlap the requested window
- Read from each segment's blocks, concatenate

This is ~150 LOC. The single-segment fast path stays — multi-segment is only triggered when `segments.length > 1`.

- [ ] **Step 6: Re-run test → expect PASS**

- [ ] **Step 7: Verify boundary case — window straddling segment boundary**

Add another test:
```js
test('mef: readWindow straddling segment boundary stitches correctly', async () => {
  const reader = await MefReader.open({ eeg_url: 'file://' + MULTISEG_FIXTURE });
  // Window [2480, 2520) spans the segment-0 → segment-1 boundary
  const win = await reader.readWindow(2480, 40);
  // First 20 samples from segment 0, last 20 from segment 1.
  // Segment 1 has +100 offset, so sample[20] should be ~100 higher than sample[19].
  assert.ok(win[0][20] - win[0][19] > 50, 'segment offset visible at boundary');
});
```

- [ ] **Step 8: Run full suite + typecheck**

- [ ] **Step 9: Commit**

```bash
git add formats/mef.js scripts/make-mef-pymef-fixture.py \
        tests/fixtures/ieeg/mef-pymef-multiseg.mefd/ tests/unit-mef-real.test.mjs
git commit -m "feat(mef): concatenate samples across multi-segment .mefd/ recordings"
```

**Estimated effort:** 1-2 hrs.

---

## P1 — Medium effort (next 2-3 sessions)

### Task P1-1: KIT epoched/evoked data support

**Limitation #8 from review.** `formats/kit.js:320` rejects `acq_type !== 1` with a clean error. Some KIT systems output `.con` files with epoched (acq_type=2) or evoked (acq_type=3) data.

**Files:**
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/kit.js`
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/scripts/make-kit-fixture.mjs` (add epoched variant)
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/tests/unit-kit.test.mjs`
- Create: `/Users/bruaristimunha/Projects/eegdash-viewer/tests/fixtures/meg/kit-tiny-epoched.con`

**Reference:** `/tmp/kit_kit.py` (already downloaded). The epoched branch is at `kit.py:719-727`:
```python
elif acq_type == KIT.EVOKED or acq_type == KIT.EPOCHS:
    (sqd["frame_length"],) = np.fromfile(fid, INT32, 1)
    (sqd["pretrigger_length"],) = np.fromfile(fid, INT32, 1)
    (sqd["average_count"],) = np.fromfile(fid, INT32, 1)
    (sqd["n_epochs"],) = np.fromfile(fid, INT32, 1)
    if acq_type == KIT.EVOKED:
        sqd["n_samples"] = sqd["frame_length"]
    else:
        sqd["n_samples"] = sqd["frame_length"] * sqd["n_epochs"]
```

- [ ] **Step 1: Read MNE source — confirm field layout** (see above).

- [ ] **Step 2: Write failing test** — open an epoched fixture, expect `n_samples = frame_length × n_epochs`.

- [ ] **Step 3: Generate epoched fixture** with `acq_type=2`, `frame_length=500`, `n_epochs=5` → 2500 samples concatenated.

- [ ] **Step 4: Replace the rejection branch in kit.js with full handling**

```js
// Around line 320 — replace:
if (acq_type !== KIT.CONTINUOUS) {
  throw new Error('Epoched/evoked support is tracked as a future enhancement.');
}
// With:
if (acq_type === KIT.CONTINUOUS) {
  // existing path
} else if (acq_type === KIT.EVOKED) {
  sqd.n_samples = readInt32(view, offset + 4);   // frame_length
  // pretrigger_length, average_count, n_epochs follow but unused for read
} else if (acq_type === KIT.EPOCHS) {
  const frameLen = readInt32(view, offset + 4);
  // skip pretrigger_length (i32) + average_count (i32)
  const nEpochs = readInt32(view, offset + 16);
  sqd.n_samples = frameLen * nEpochs;
} else {
  throw new Error(`KIT: unknown acq_type=${acq_type}`);
}
```

- [ ] **Step 5: Verify readWindow works across epoch boundaries** — for epoched data, samples are stored contiguously; we just compute `n_samples = frame × epochs` and let the existing interleaved decode handle it.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(kit): support epoched (acq_type=3) and evoked (acq_type=2) recordings"
```

**Estimated effort:** 3-4 hrs.

---

### Task P1-2: BTi epoched/evoked support

**Limitation #9 from review.** `formats/bti.js:449-453` rejects `total_epochs > 1`. Multi-epoch BTi PDFs (e.g., evoked-response paradigms) need to concatenate epochs the same way KIT does.

**Files:**
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/bti.js`
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/scripts/make-bti-fixture.mjs`
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/tests/unit-bti.test.mjs`

**Reference:** MNE-Python `mne/io/bti/bti.py` — `_read_bti_header_pdf` parses epoch records; the actual epoch concatenation happens in `_read_segments_bti`.

Steps mirror P1-1 KIT. Key difference: BTi PDFs use `int32_t total_epochs` at offset (read existing constant from bti.js) followed by an array of `Epoch` records, each describing per-epoch sample count + start offset.

- [ ] **Step 1: Read MNE bti.py epoch-handling code**
- [ ] **Step 2: Write failing test for 3-epoch fixture (each 100 samples)**
- [ ] **Step 3: Generate 3-epoch BTi fixture**
- [ ] **Step 4: Replace rejection with concatenation**
- [ ] **Step 5: Verify boundary-spanning readWindow works**
- [ ] **Step 6: Commit**

**Estimated effort:** 4-6 hrs (BTi is denser than KIT).

---

### Task P1-3: BTi full config-file parser → real channel labels

**Limitation #11 from review.** `formats/_bti-config.js:41-44` is a stub. Currently channel labels fall back to `Ch1..ChN`. The `config` file (the BTi bundle's metadata file, multi-MB) contains the real channel names in user-block `B_E_TABLE` or `B_WHC_CHAN_MAP`.

**Files:**
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/_bti-config.js` (implement parser)
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/bti.js` (use real labels when available)
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/scripts/make-bti-fixture.mjs` (write a real config with labels)
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/tests/unit-bti.test.mjs`

**Reference:** MNE-Python `mne/io/bti/_constants.py` defines the user-block magic constants. `_read_user_block` in `bti.py` is the walker.

This is the largest BTi task because the config file is structured as a sequence of typed user blocks with magic+length prefixes; we need to walk them, find the channel-naming block, and extract names.

- [ ] **Step 1: Fetch MNE constants + parser**
```bash
curl -sL https://github.com/mne-tools/mne-python/raw/main/mne/io/bti/_constants.py -o /tmp/mne_bti_constants.py
grep -nE "B_E_TABLE|B_WHC_CHAN_MAP|B_MAG_INFO|user_block" /tmp/mne_bti_constants.py
```

- [ ] **Step 2: Document the user-block walker logic in `formats/_bti-config.js` header comment**

The config file layout (from MNE):
- Fixed initial header (~2 KB)
- Followed by N user blocks, each:
  - magic (4 bytes ASCII)
  - block size (uint32 BE)
  - payload (block_size bytes)

We walk until we find `B_WHC_CHAN_MAP` (channel position + name table) and `B_NAMES` (channel name list).

- [ ] **Step 3: Write failing test for real labels**

```js
test('bti: channel labels come from B_WHC_CHAN_MAP, not Ch1..ChN', async () => {
  const reader = await BtiReader.open({ eeg_url: 'file://' + FIXTURE_DIR + '/config' });
  // Fixture config has named channels: ['MLF11', 'MLF12', 'MLT11', 'MEG_REF']
  assert.deepEqual(reader.channel_labels.slice(0, 4), ['MLF11', 'MLF12', 'MLT11', 'MEG_REF']);
});
```

- [ ] **Step 4: Extend make-bti-fixture.mjs to write a real config with B_WHC_CHAN_MAP user block**

- [ ] **Step 5: Implement the walker in _bti-config.js**

Pseudo:
```js
function parse(configBuf) {
  const view = new DataView(configBuf);
  let offset = HEADER_FIXED_BYTES;
  const blocks = {};
  while (offset < view.byteLength - 8) {
    const magic = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, false);
    if (size === 0 || offset + 8 + size > view.byteLength) break;
    blocks[magic] = { offset: offset + 8, size, view };
    offset += 8 + size;
  }
  return blocks;
}

function parseLabelsOnly(configBuf, nChan) {
  const blocks = parse(configBuf);
  const chanMap = blocks['B_WHC_CHAN_MAP'] || blocks['B_NAMES'];
  if (!chanMap) return null;
  // ChannelMap entry: 16-byte name + 64 bytes coords + ...
  const labels = new Array(nChan);
  for (let i = 0; i < nChan; i++) {
    labels[i] = readAscii(chanMap.view, chanMap.offset + i * CHAN_ENTRY_BYTES, 16).trim();
  }
  return labels;
}
```

- [ ] **Step 6: Wire into bti.js — fall back to Ch1..ChN only if parser returns null**

- [ ] **Step 7: Verify against real BTi config if obtainable**

Optional: if MNE-Python's test data ships a real BTi config, fetch + verify. If not, document as "real BTi data unavailable; spec-conformant fixture only".

- [ ] **Step 8: Commit**

**Estimated effort:** 6-10 hrs.

---

### Task P1-4: MEF3 .rdat annotation record parsing

**Limitation #13 from review.** `formats/mef.js:381` hardcodes `annotation_events: []`. MEF3 stores user-defined annotations / triggers / seizure markers in `.rdat` + `.ridx` + `.rmet` files (alongside `.tdat/.tidx/.tmet` per channel).

**Files:**
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/_mef-segment.js` (add `parseRmet`, `parseRdat`)
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/mef.js` (discover + parse record files)
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/scripts/make-mef-pymef-fixture.py` (write annotations via pymef)
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/tests/unit-mef-real.test.mjs`

**Reference:** `meflib.c:read_record_data_3` is the C parser. Records are stored in MEF3's record-data files (one set per session, not per channel). Each record has:
- Universal header (already parsed)
- Record header: type code, version, sample/time alignment
- Record body: free-form per type (`Note`, `Trigger`, `Seizure`, etc.)

The most common types are `Note` (text annotation) and `Trigger` (sample-aligned event).

- [ ] **Step 1: Read meflib.c record-data layout**

```bash
grep -nE "read_record_data_3|RECORD_HEADER_BYTES|MEFREC_Note|MEFREC_Trigger" /tmp/meflib/meflib/meflib/meflib.c | head -20
```

- [ ] **Step 2: Write failing test (pymef-encoded record fixture)**

```js
test('mef: annotation_events surfaced from .rdat records', async () => {
  const reader = await MefReader.open({ eeg_url: 'file://' + REC_FIXTURE });
  // Fixture has 3 trigger records at samples 100, 500, 1000.
  assert.equal(reader.annotation_events.length, 3);
  assert.equal(reader.annotation_events[0].sample, 100);
});
```

- [ ] **Step 3: Use pymef to write a fixture with records**

`pymef.MefSession.write_mef_records()` accepts a list of record dicts. Pick the simplest type (`Note` or `Trigger`).

- [ ] **Step 4: Implement parseRmet + parseRdat in _mef-segment.js**

The record-files are at `<session>.mefd/<session>.rdat` + `.ridx` + `.rmet` (NOT per-channel — session-level). The walker fetches all three, parses metadata, walks the record-index to get block offsets, and reads each record.

- [ ] **Step 5: Wire into mef.js open() — populate annotation_events from records**

- [ ] **Step 6: Commit**

**Estimated effort:** 6-10 hrs (record format is denser than time-series; need to also handle the indexing).

---

### Task P1-5: Error-message format unification across format readers

**Limitation #14 from review** (architect inconsistency #3). Different readers emit different wording for the same condition. Examples:

| Reader | Size-mismatch error |
|---|---|
| EDF | `EDF data section ${dataBytes}B is not a multiple of record size ${recordSize}B` |
| BrainVision | `.eeg size ${totalBytes}B not a multiple of n_channels·bps=${recordBytes}B` |
| EEGLAB | `.fdt size ${totalBytes} is not a multiple of ${nChannels}×4` |
| CTF | `ctf.open: .meg4 body ${bodyBytes} bytes is not a multiple of...` |

User-visible inconsistency. Pick one format + apply.

**Files:**
- Modify: All `formats/*.js` readers' error messages
- Modify: tests that pin error messages (find via `grep -rn "is not a multiple" tests/`)

**Suggested format:** `{fmt}: {fileLabel} size {N}B not a multiple of {divisor}B ({why})`

Example: `eeglab: .fdt size 3072B not a multiple of 96B (n_channels=24 × 4 bytes/sample)`

- [ ] **Step 1: Catalog every size-mismatch error site**

```bash
grep -nE "is not a multiple|not a multiple" formats/*.js
```

- [ ] **Step 2: Catalog every other repeated-pattern error (e.g., "magic mismatch", "missing field")**

- [ ] **Step 3: Define a shared error-builder helper**

Add to `formats/_buffers.js` (or new `formats/_errors.js`):

```js
function sizeMismatchError(fmt, fileLabel, totalBytes, divisor, why) {
  return new Error(
    `${fmt}: ${fileLabel} size ${totalBytes}B not a multiple of ${divisor}B (${why})`
  );
}
function magicMismatchError(fmt, fileLabel, expected, actual) {
  return new Error(
    `${fmt}: ${fileLabel} magic mismatch — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}
```

- [ ] **Step 4: Migrate each site one reader at a time**

For each reader: update error sites, update pinned-error tests, run that reader's tests, commit.

- [ ] **Step 5: Verify all error-message tests still pass**

Likely candidates: `tests/unit-eeglab-security.test.mjs`, `tests/unit-bids-recording-security.test.mjs`, format-specific tests.

- [ ] **Step 6: One commit per migrated reader**

**Estimated effort:** 8-12 hrs (lots of small edits, low per-edit risk, many tests need wording updates).

---

## P2 — Large effort (quarter-level commitment)

### Task P2-1: MEF3 encrypted-segment support

**Limitation #2 from review.** Mayo clinical epilepsy datasets (the main MEF3 use case) frequently encrypt subject identifiers + recordings. Our reader rejects any segment with `section_2_encryption_level > 0`.

**Files:**
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/_mef-segment.js` (add AES decrypt)
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/mef.js` (accept password param in `open()`)
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/scripts/make-mef-pymef-fixture.py` (generate encrypted fixture)
- New: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/_aes-128-ecb.js` (or vendor a tiny AES implementation)
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/tests/unit-mef-real.test.mjs`

**Reference:** `meflib.c:AES_KeyExpansion`, `AES_decrypt`. MEF3 uses AES-128 ECB with the password hashed via SHA-256 (truncated to 16 bytes for the key).

The MEF3 encryption layer encrypts:
- Section 2 metadata (subject metadata)
- Section 3 metadata (recording metadata)
- Optionally the RED block data itself (Level 2 encryption)

- [ ] **Step 1: Study `meflib.c:AES_decrypt` + key derivation**

```bash
grep -nE "AES_decrypt|sha256_password|password_hint|EncryptionLevel" /tmp/meflib/meflib/meflib/meflib.c | head -30
```

- [ ] **Step 2: Vendor a tiny AES-128 ECB implementation**

Browser `crypto.subtle.decrypt` supports AES-CBC and AES-GCM but NOT ECB natively. Options:
- (a) Vendor a 200-LOC pure-JS AES-128 (e.g., from aes-js library, MIT licensed)
- (b) Use `crypto.subtle` AES-CBC with a zero IV and decrypt-per-block (ECB is CBC with no IV chaining)

Option (b) is hacky. Recommend (a) — pure-JS AES-128 ECB, tested against NIST test vectors.

- [ ] **Step 3: Implement key derivation: password → SHA-256 → take first 16 bytes → AES key**

- [ ] **Step 4: Generate encrypted fixture via pymef with `password='test'`**

- [ ] **Step 5: Wire `password` parameter through `MefReader.open({ eeg_url, password })`**

- [ ] **Step 6: In `parseTmet`, detect encryption level + decrypt sections before parsing**

- [ ] **Step 7: For Level 2 (data encryption), decrypt RED blocks before passing to `_mef-red.js`**

- [ ] **Step 8: Add tests for encrypted, password-correct → decode; encrypted, password-missing → clean error; encrypted, password-wrong → clean error**

- [ ] **Step 9: UI surface: viewer.js needs to prompt for password when MefReader throws "encrypted, password required". Defer this to a follow-up — for now, the URL grammar accepts `&password=foo`.**

- [ ] **Step 10: Commit (multiple commits — AES vendor, key derivation, section decrypt, RED-block decrypt)**

**Estimated effort:** 20-30 hrs. Critical for clinical use.

---

### Task P2-2: NWB sparse-page jsfive wrapper (multi-GB DANDI support)

**Limitation #3 + #4 from review.** Some pynwb writers append small datasets after the big chunked one. Our streaming path can only see HDF5 metadata in the first 16 MB. Files > 200 MB with append-style metadata fall back to whole-file (which hits the 1 GB cap).

**Files:**
- Major modify: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/_jsfive.js` (the vendored jsfive — needs sparse-page interface)
- OR new: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/_jsfive-sparse.js` (wrap jsfive's API with lazy fetches)
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/nwb.js`
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/snirf.js` (verify no regression)
- Modify: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/_mat73.js` (verify no regression)

**Reference:** jsfive's parser accesses bytes via `_unpack_integer` and `unpack_from` over a single ArrayBuffer. To make it lazy:

**Approach A — fork jsfive:** Replace direct array indexing with an async page-fetcher. Cache 64 KB pages keyed by `Math.floor(offset / 65536)`. ~500 LOC patch + risk to SNIRF + MAT-v7.3 + NWB whole-file path.

**Approach B — wrap jsfive:** Pre-fetch a "metadata digest" by walking only the small parts of the file jsfive will need. This is brittle (depends on knowing jsfive's access pattern).

**Approach C — replace jsfive entirely:** Build a tiny HDF5 metadata-only reader that walks just the superblock + group tree + dataset object headers, fetching each via Range. Then for chunks, use the existing `_h5-stream.js` path. This means jsfive only handles the small-file fallback path; large-file goes through new code.

Recommend Approach A (fork + patch). It's the most-aligned with the existing code, and the sparse-page abstraction is reusable for SNIRF + MAT-v7.3 too.

- [ ] **Step 1: Map jsfive's access patterns**

```bash
grep -nE "_unpack_integer|unpack_from|new DataView" formats/_jsfive.js | head -30
```

Categorize each: random offset reads vs sequential scans. Plan a 64 KB page cache that satisfies the random-access pattern with bounded fetches.

- [ ] **Step 2: Define the sparse-page interface**

```js
class SparsePagedBuffer {
  constructor(url, totalBytes, pageSize = 65536) { /* ... */ }
  async fetchPage(pageIdx) { /* HttpRange.rangeFetch */ }
  async ensurePages(byteStart, byteLen) { /* fetch all pages covering this range */ }
  view(byteStart, byteLen) { /* assemble a DataView spanning pages */ }
}
```

- [ ] **Step 3: Patch jsfive to use SparsePagedBuffer when given one instead of ArrayBuffer**

This is the invasive part. Find every `new DataView` / `Uint8Array` constructor in jsfive and route through `buf.view(off, len)`.

- [ ] **Step 4: Test against existing SNIRF + MAT-v7.3 fixtures**

Both must still pass with the sparse-page wrapper.

- [ ] **Step 5: Test against multi-GB DANDI fixture**

```bash
# Download a 500 MB-1 GB DANDI file with append-style metadata
curl -L https://api.dandiarchive.org/api/assets/... -o /tmp/big-nwb.nwb
```

Then write a test that opens it via the streaming path and reads a window. Assert <10s open and <5s readWindow.

- [ ] **Step 6: Bench against synthetic 5 GB fixture (masquerade via probeLength)**

Mirror the existing `tests/evidence/nwb-streaming/README.md` benchmarks.

- [ ] **Step 7: Multiple atomic commits**

1. Add SparsePagedBuffer + tests
2. Patch jsfive to support it (without removing the in-memory path)
3. Wire NWB to use sparse when totalBytes > threshold
4. Verify SNIRF + MAT-v7.3 don't regress
5. Real-DANDI integration test

**Estimated effort:** 20-30 hrs.

**Stop conditions:** if jsfive's access pattern is so densely random that sparse-page hit rates fall below 50%, abandon and pivot to Approach C (build new HDF5 metadata reader). Document the pivot.

---

### Task P2-3: NWB compound dtypes, references, variable-length strings

**Limitation #6 from review.** `formats/_h5-stream.js` only handles fixed-width LE numeric types. NWB ElectricalSeries can use:
- Compound types (e.g., electrodes table rows)
- Object references (e.g., DynamicTableRegion pointing into another table)
- Variable-length strings (channel labels)

Today these fall back to whole-file jsfive (which handles them). But once we're in sparse-page land (Task P2-2), we need the streaming reader to handle them too OR document that they always trigger fallback.

**Effort estimate:** 15-25 hrs. Recommend deferring until P2-2 is done and we have a real DANDI dataset that hits these.

- [ ] **Step 1: Catalog which NWB files in DANDI actually use compound types**

- [ ] **Step 2: If common, implement in `_h5-stream.js`. If rare, document as a known fallback trigger.**

---

### Task P2-4: ds002001 CTF .meg4 trailing-data investigation

**Limitation #17 from review.** ds002001 fails the audit with "stage-caption never visible". The .meg4 file has trailing bytes that don't divide cleanly by `nchan × bytes_per_sample`. Previously documented as intentional rejection.

**Files:**
- Read: `/Users/bruaristimunha/Projects/eegdash-viewer/formats/ctf.js`
- Investigate the actual file: download ds002001's .meg4 and inspect the trailing bytes
- Possible fix: tolerate trailing bytes as long as the first N samples are clean

**Effort estimate:** 4-8 hrs of investigation + 2-4 hrs of fix. Marked P2 because it's exotic data.

---

## P3 — Blocked or infrastructure

These don't get "tasks" because they're either blocked by external factors or out-of-scope-of-readers. They're tracked here so they don't get lost.

### P3-1 (Blocked): KRISS .kdf binary spec — Limitation #1

**Status:** Stub-reader ships clean error. Real implementation blocked on either:
- Public release of KRISS .kdf binary spec
- Access to a real .kdf sample file for reverse-engineering
- KRISS lab cooperation

**Action:** None. If someone shows up with a real .kdf, revisit.

---

### P3-2 (Infra): Stryker mutation re-run on all changed modules — Limitation #15

**Status:** Stryker takes >30 min/run. Hasn't run since Lane B (format DRY) + Lane E (decomposition). Aggregate score from previous session was 42.34%; current is unknown.

**Action:** Next CI cycle. Run `npm run test:mutation` against the changed modules and update `docs/mutation-survivors-2026-05.md`. Don't add new mutation tests until we see the survivor diff.

---

### P3-3 to P3-7 (Real-world data validation gaps) — Limitations from review §B

| # | Format | Limitation | Action |
|---|---|---|---|
| P3-3 | EEGLAB v7.3 | No EEGDash dataset uses single-file v7.3 | Wait for one to appear; current synthetic + fixture coverage is sufficient |
| P3-4 | KIT (.con/.sqd) | ds004738 exists but rarely sampled in audit | Bump audit sample size to 50 to surface it more often, OR pin ds004738 as a mandatory audit dataset |
| P3-5 | SNIRF | No EEGDash fNIRS datasets | Same as P3-3 |
| P3-6 | NWB | DANDI integration is one-off, not in CI audit | Add a dedicated `dandi-audit.spec.mjs` that pins 3-5 small DANDI files and runs nightly |
| P3-7 | BTi / ITAB | No real datasets accessible publicly | Document; revisit if MNE-Python testing-data ships them |

---

### P3-8 to P3-11 (Test-infrastructure limitations) — Limitations from review §D

| # | Limitation | Action |
|---|---|---|
| P3-8 | Sample-size 20 misses some flakiness (e.g., ds002908 60s CTF timeout) | Add a separate `audit-large-files.spec.mjs` with a 180s timeout for >100 MB files |
| P3-9 | JSDOM doesn't enforce Window-method `this` binding (Lane F4 bug) | Document. The browser audit is the only catch. Consider adding a tiny "boot-and-render" Playwright spec that exercises the rAF path with real browser semantics. |
| P3-10 | Chrome-only verification | Out of scope without CI runners for Firefox + Safari. Document. |
| P3-11 | data.eegdash.org CORS-block on localhost | Already whitelisted in audit. No action. |

---

### P3-12 to P3-15 (UX / product limitations) — Limitations from review §E

| # | Limitation | Status |
|---|---|---|
| P3-12 | No Topo2D rendering | Archived in `archive/topo2d/`; product decision |
| P3-13 | No multi-run / multi-session comparison | Product decision |
| P3-14 | Filter UI defaults don't switch per modality (EEG vs MEG) | UX work; needs designer input |
| P3-15 | Cancellation cascade stress-testing incomplete | Add a chaos-style spec that pans rapidly + toggles filters; verify no orphaned `pendingRequests` entries. Owner: TBD. |

---

## Self-Review

**Spec coverage check:** Walked through the 26 limitations from the 2026-05-22 review. Every one is in this plan (P0/P1/P2/P3). Coverage: ✓

**Placeholder scan:** Each P0 task has full code snippets. P1 tasks have code snippets for the harder parts. P2 tasks have reference pointers but defer detailed code to the implementer (the agents who pick them up have authority to refine). P3 has actions but no code (correctly — they're not coding tasks). No "TODO: implement later" in P0/P1.

**Type consistency:** No new shared API surfaces proposed. Each task either extends existing reader objects or adds isolated helpers (`_aes-128-ecb.js`, `_errors.js`). No method-name drift.

---

## Execution Handoff

**Recommended approach:** Subagent-Driven Development. Ship P0 in one session (4 small surgical tasks), then evaluate whether to continue into P1.

**Per-task isolation:** Every task touches 2-5 files. Parallel-safe in pairs (P0-1 + P0-2 don't conflict, P0-3 + P0-4 don't conflict). P1-1 + P1-2 + P1-3 all touch different format readers, parallel-safe in any combination.

**Stopping condition for the human:** After P0 ships, decide whether P1 effort is worth the value. P2 only if a real user need surfaces (encrypted Mayo data, multi-GB DANDI streaming).

**Anti-goal:** do not tackle P3 from this plan. They're tracked here so they don't get lost, not because they should be done.

---

## Quick-reference: file-touch matrix

| Task | formats/ | tests/unit-*.test.mjs | scripts/make-*-fixture.* | tests/fixtures/ |
|---|---|---|---|---|
| P0-1 CTF start time | ctf.js (+ maybe _ctf-acq.js) | unit-ctf.test.mjs | make-ctf-fixture.mjs | meg/ctf-tiny.ds/ |
| P0-2 ITAB TODOs | itab.js | unit-itab.test.mjs | make-itab-fixture.mjs | meg/itab-tiny.{raw,mhd} |
| P0-3 NWB filters | _h5-stream.js | unit-nwb-range.test.mjs | make-nwb-chunked-fixtures.mjs | ieeg/nwb-chunked-*.nwb |
| P0-4 MEF multi-seg | mef.js | unit-mef-real.test.mjs | make-mef-pymef-fixture.py | ieeg/mef-pymef-multiseg.mefd/ |
| P1-1 KIT epoched | kit.js | unit-kit.test.mjs | make-kit-fixture.mjs | meg/kit-tiny-epoched.con |
| P1-2 BTi epoched | bti.js | unit-bti.test.mjs | make-bti-fixture.mjs | meg/bti-tiny-epoched/ |
| P1-3 BTi config | _bti-config.js, bti.js | unit-bti.test.mjs | make-bti-fixture.mjs | meg/bti-tiny/config |
| P1-4 MEF .rdat | _mef-segment.js, mef.js | unit-mef-real.test.mjs | make-mef-pymef-fixture.py | ieeg/mef-pymef-records.mefd/ |
| P1-5 Error unification | many | many | none | none |
| P2-1 MEF encrypted | _mef-segment.js, mef.js, new _aes-128-ecb.js | unit-mef-real.test.mjs | make-mef-pymef-fixture.py | ieeg/mef-pymef-encrypted.mefd/ |
| P2-2 NWB sparse-page | _jsfive.js (fork) or new _jsfive-sparse.js | unit-nwb-range.test.mjs | new big-fixture script | ieeg/ |
| P2-3 NWB compound types | _h5-stream.js | unit-nwb-range.test.mjs | (none — needs real DANDI) | (none) |
| P2-4 ds002001 CTF | ctf.js | (probe in tests/oracle/) | none | (none) |

---

## Sign-off

**Author:** Generated 2026-05-22 from the post-Lane-M limitations review.
**Reviewed-by:** TBD (next session).
**Approved-for-execution:** P0 only by default. P1 + P2 require explicit go-ahead per task.
