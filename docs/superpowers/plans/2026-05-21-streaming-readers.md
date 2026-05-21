# Streaming FIFF + MAT v5 Readers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the whole-file `fetchBuffer` calls in `formats/fiff.js` and `formats/eeglab.js` (inline-`.set` path) with range-based readers that open in < 5 s and serve windows in < 2 s on multi-GB recordings — unblocking the four > 200 MB datasets the browser reality-check flagged as render-fails (ds003694 2 GB FIFF, ds003682 644 MB FIFF, ds002578 695 MB EEGLAB inline, ds002718 224 MB EEGLAB inline).

**Architecture:** Reuse the existing `globalThis.HttpRange.{probeLength, rangeFetch, rangeFetchStreaming}` plumbing that EDF / BrainVision / split-EEGLAB already lean on. Split parsing by concern: a new `formats/_fiff-dir.js` walks the tag directory at end-of-file to locate `FIFFB_MEAS_INFO` and `FIFFB_RAW_DATA` block byte-ranges; `formats/fiff.js` `api.open()` range-fetches only the directory tail + the meas_info bytes; `readWindow(start, n)` range-fetches the column slice of the RAW_DATA block. For MAT v5, `formats/_matv5.js` gains an `api.scanElements(buf)` that returns top-level element headers without materializing payloads; `formats/eeglab.js` `openInlineSet` range-fetches the first 16 MB to scan, identifies the `data` element's byte-offset, and serves windows via column-slice range fetches. MAT v7.3 (HDF5) streaming is explicitly out of scope.

**Tech Stack:** Plain JS IIFE modules (no bundler), `DataView`/`TypedArray` for binary, `globalThis.HttpRange` for network I/O, `node:test` + `fast-check` for tests, `tsc --noEmit` via `jsconfig.json` for the JSDoc typecheck, Playwright for browser reality-check, `tinybench` for perf regression.

---

## File Structure

```
formats/
  ├── _fiff-dir.js                   NEW — end-of-file directory walker (block range index)
  ├── fiff.js                        MODIFY — api.open range-based, readWindow range-based, +readWindowStreaming
  ├── _matv5.js                      MODIFY — +api.scanElements(buf) returning per-element headers
  ├── eeglab.js                      MODIFY — openInlineSet range-based; remove 200 MB cap; replace with 8 MB metadata budget
  └── globals.d.ts                   MODIFY — declare FiffDir global

jsconfig.json                        MODIFY — include formats/_fiff-dir.js

tests/
  ├── _bootstrap.mjs                 MODIFY — export FiffDir + FiffReader
  ├── unit-fiff-dir.test.mjs         NEW — directory walker on synth + real fixtures
  ├── unit-fiff-range.test.mjs       NEW — api.open + readWindow via mocked HttpRange
  ├── unit-fiff-streaming.test.mjs   NEW — readWindowStreaming yields ordered chunks
  ├── unit-matv5-scan.test.mjs       NEW — scanElements on synth + EEGLAB inline buffers
  ├── unit-eeglab-inline-range.test.mjs  NEW — openInlineSet via range-mocked HttpRange
  └── e2e/acceptance/
      └── streaming-large.spec.mjs   NEW — Playwright >200 MB browser reality-check
                                            (ds003682 + ds003694 + ds002578)

bench/
  └── readwindow.bench.mjs           MODIFY — add FIFF + inline-EEGLAB fixtures

docs/
  └── audit-browser-reality-2026-05-21.md  MODIFY — append re-run results

scripts/
  └── audit-100-datasets.mjs         (no change — already lists all four datasets)
```

13 tasks total. Each ~45-60 min. Tasks 1-4 build + verify the FIFF range path bottom-up; Task 5 runs the FIFF browser reality-check (evidence-gate); Tasks 6-8 build + verify the MAT v5 streaming path; Task 9 runs the EEGLAB browser reality-check (evidence-gate); Task 10 wires bench coverage; Task 11 re-runs the full audit reality sweep; Tasks 12-13 close out (typecheck + docs).

---

## Background: FIFF tag-directory layout (read before Task 1)

A FIFF file is a stream of fixed-width tag records (16-byte header + variable payload). Tag headers are big-endian. Each header is four `int32` fields:

| Offset | Field | Meaning |
|---|---|---|
| 0 | `kind` | what this tag carries (e.g. `100` = `FIFF_FILE_ID`, `200` = `FIFF_NCHAN`) |
| 4 | `type` | payload primitive type (1=byte, 2=int16, 3=int32, 4=float32, 10=string, …) |
| 8 | `size` | payload length in bytes (NOT including the 16-byte header) |
| 12 | `next` | absolute byte offset of the next tag; `0` = sequential (header+size+0 follows); `-1` = end-of-stream or jump-to-directory |

Real Neuromag/Elekta files include a **tag directory** near end-of-file. The directory is itself a single tag (`kind=FIFF_DIR=102`, `type=int32`, payload = `nentries × 16` bytes per entry — each entry is `(kind, type, size, position)` as four int32s BE, where `position` is the absolute byte offset of the tag's 16-byte header). A `FIFF_DIR_POINTER` tag (`kind=101`, `type=int32`) sits right after the `FIFF_FILE_ID` tag at offset 0 and its single int32 payload is the absolute byte offset of the directory tag header. If `FIFF_DIR_POINTER`'s payload is `-1`, the file lacks a directory and must be walked sequentially (old / streaming writers).

**Block bracketing.** Inside the stream, blocks are demarcated by two structural tags:
- `FIFF_BLOCK_START` (`kind=104`, `type=int32`, `size=4`, payload = block-id int32 BE)
- `FIFF_BLOCK_END` (`kind=105`, `type=int32`, `size=4`, payload = block-id int32 BE)

Block ids we care about:
- `FIFFB_MEAS_INFO = 101` — channel info, sample rate, projections (everything `api.open` needs)
- `FIFFB_RAW_DATA = 102` — the actual sample buffers (each as a `FIFF_DATA_BUFFER` tag, `kind=300`)

**Practical access pattern for `api.open`:**
1. `probeLength(url)` → file size N.
2. Range-fetch `[0, 31]` (first 32 B). Validate first tag is `FIFF_FILE_ID`. Parse second tag header at offset 16: if `kind=FIFF_DIR_POINTER`, read its 4-byte payload at offset 32 (or up to 36 — same range, just need 36 bytes). That int32 is the directory's absolute byte offset `D`.
3. Range-fetch `[D, N-1]` — the directory tag header + entries. Walk entries → produce `{ kind, position, size }[]`.
4. For each `FIFF_BLOCK_START` entry whose payload is `FIFFB_MEAS_INFO`, walk to the matching `FIFFB_MEAS_INFO`'s `FIFF_BLOCK_END` to get the byte-range. Range-fetch that range (typically 10-100 KB), parse sequentially using the existing `api.read` machinery.
5. Same for `FIFFB_RAW_DATA`: store its `[startByte, endByte]`. Inside, enumerate `FIFF_DATA_BUFFER` tags from the directory entries that fall inside that range — each entry's `position` + 16 (header) is the start of a sample buffer; consecutive entries give buffer count and size per buffer (samples_per_buffer × nchan × bytes_per_sample). The total `n_samples` is `Σ samples_per_buffer`.

**Practical access pattern for `readWindow(start, n)`:**
1. Walk the cached buffer index (built at open time): each entry is `{ byteOffset, samplesInBuffer, bytesPerSample, miType }`. Cumulative sample counts let us binary-search the first buffer overlapping `[start, start+n)`.
2. For each overlapping buffer, compute the byte slice within it (`(start - cumStart) * nchan * bytesPerSample` for the leading buffer, full buffer in the middle, trailing partial at the end).
3. `HttpRange.rangeFetch` each slice (or, when buffers are contiguous, fuse adjacent slices into a single fetch).
4. Decode each fetched slice (big-endian → typed array, the same path as the current `extractDataBuffer`) and de-interleave + apply `cal*range` calibration into the channel-major output.

**Fallback for no-directory files.** When `FIFF_DIR_POINTER` payload is `-1`, fall back to the current full-file `fetchBuffer` path with a 1 GiB cap. Mark `reader.streaming = false` so the caller knows. This branch covers ~5% of OpenNeuro FIFFs (mostly older synth / event files); the 95% with directories take the fast path.

References:
- MNE-Python `mne/_fiff/tag.py::_read_tag_header`, `mne/_fiff/open.py::_get_next_fname_and_pos`
- MNE-Python `mne/_fiff/meas_info.py::_read_dir`

---

## Background: MAT v5 element scan (read before Task 6)

A MAT v5 file is a 128-byte header followed by a flat stream of "elements". Each element has either:
- **Long-format header** (8 bytes): `[uint32 miType] [uint32 nbytes] [payload bytes, padded to 8]`
- **Small-format header** (4 bytes): the upper 16 bits of the first uint32 are nbytes (1..4), lower 16 are miType. Payload follows in the next 4 bytes (no extra padding).

Each top-level element of interest for EEGLAB is a `miMATRIX` (`miType=14`) — a container whose payload is itself a sequence of sub-elements (array flags, dimensions, name, real data). The whole-file `api.parse` already walks every element and recurses into matrix payloads to materialize TypedArrays.

**`scanElements(buf)` only needs the top-level metadata.** For each top-level element it returns:
```
{
  miType: number,           // 14 (miMATRIX), 15 (miCOMPRESSED), or rare scalar at top
  elementOffset: number,    // absolute byte offset of the element header
  payloadOffset: number,    // absolute byte offset of element payload start
  payloadBytes: number,     // payload length (after the header, before padding)
  // for miMATRIX only — derived by peeking at sub-elements:
  mxClass: number | null,   // 6=double, 7=single, 10=int16, 12=int32, …
  dims: number[] | null,    // [nchan, pnts] or [nchan, pnts, trials] for EEG.data
  name: string | null,      // 'data', 'srate', 'nbchan', 'EEG', …
  dataSubOffset: number | null,    // absolute byte offset of the matrix's real-data sub-element payload
  dataSubBytes: number | null,     // bytes of real data (TypedArray-friendly)
  dataSubMiType: number | null     // 7=float32, 9=float64, …
}
```

The function never decompresses `miCOMPRESSED` elements (most EEGLAB exports are uncompressed; if compression is present we degrade to the existing whole-file `MatV5.parse` path). It never reads `data`'s payload — only the sub-element header tag's location.

**Why this works for inline EEGLAB:** the metadata fields (`nbchan`, `srate`, `pnts`, `trials`, `chanlocs`) are small (a few dozen to a few KB at most); `data` is by far the largest element. So we scan the first ~16 MB of the file (which is enough to cover the header + every small element + the start of `data`), grab the data element's payload byte-range, then for each `readWindow` call we range-fetch only the column slice of `data` we need.

EEGLAB MAT v5 is column-major: `data[chan, sample]` is at element `sample * nchan + chan` of the flat float32 array. A window `[startSample, startSample+nWin)` requires bytes `[startSample * nchan * bytesPerSample, (startSample + nWin) * nchan * bytesPerSample)` measured from `dataSubOffset`.

References:
- MAT-File Format spec: https://www.mathworks.com/help/pdf_doc/pdf_doc/matfile_format.pdf
- Existing `formats/_matv5.js::iterElements` (already chops the stream — `scanElements` just turns it into a list with sub-element peek).

---

## Background: Evidence requirements (read before Task 5 + Task 9)

Per the task brief, every reader change must include a real-browser test against a real > 200 MB dataset. Synthetic-only is insufficient. Evidence captured per browser-test task:

1. **`api.open()` wall-clock < 5 s** on the largest dataset for that reader (2 GB FIFF / 695 MB EEGLAB). Measured via `performance.now()` straddling `LOAD_FILE → STAGE_CAPTION_VISIBLE`.
2. **`readWindow(0, 1000)` wall-clock < 2 s**. Measured in-browser via `performance.mark` / `performance.measure` from the worker.
3. **Memory peak < 100 MB** during the read. Measured via Chrome DevTools `performance.memory.usedJSHeapSize` sampled every 100 ms during the test; report `max(usedJSHeapSize) - baseline`.
4. **Evidence artifact**: a JSONL line per dataset written to `tests/evidence/streaming-large/results.jsonl` with shape `{ dataset_id, format, n_bytes, open_ms, read_ms, peak_heap_mb, verdict }`.

The Playwright spec asserts all three thresholds and fails hard if any is missed. The viewer exposes `performance.memory.usedJSHeapSize` (Chromium-only) and the worker already posts performance marks back to the page on FETCH_WINDOW completion (see `worker.js` around line 100 — search for `performance.mark`).

---

### Task 1: FIFF directory walker (`formats/_fiff-dir.js`)

**Goal:** Pure parser that, given a `DataView` over the bytes of the directory tag (`FIFF_DIR`, kind=102) and the absolute offset of that tag header within the file, returns the block index + raw_data buffer list.

**Files:**
- Create: `formats/_fiff-dir.js`
- Create: `tests/unit-fiff-dir.test.mjs`
- Modify: `formats/globals.d.ts` (add `declare const FiffDir: any;`)
- Modify: `jsconfig.json` (add `"formats/_fiff-dir.js"` to `include`)
- Modify: `tests/_bootstrap.mjs` (export `FiffDir`)

- [ ] **Step 1: Write the failing test**

Create `tests/unit-fiff-dir.test.mjs`:

```javascript
// Unit tests for formats/_fiff-dir.js — synth + real-fixture coverage
// for the end-of-file tag-directory walker. The walker is the critical
// piece that lets FIFF api.open run on a 2 GB file without
// downloading the whole thing — if this test passes against the real
// MNE-Python fixture we know the byte-offset math matches reality.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const FiffDir = require('../formats/_fiff-dir.js');

// ---- helpers: build a synthetic FIFF tag stream --------------------

const FIFF_FILE_ID     = 100;
const FIFF_DIR_POINTER = 101;
const FIFF_DIR         = 102;
const FIFF_BLOCK_START = 104;
const FIFF_BLOCK_END   = 105;
const FIFF_DATA_BUFFER = 300;
const FIFFB_MEAS_INFO  = 101;
const FIFFB_RAW_DATA   = 102;
const TYPE_INT32       = 3;

function writeTagBE(dv, off, kind, type, size, next) {
  dv.setInt32(off + 0,  kind, false);
  dv.setInt32(off + 4,  type, false);
  dv.setInt32(off + 8,  size, false);
  dv.setInt32(off + 12, next, false);
}

// Build a 256-byte buffer with: FIFF_FILE_ID, FIFF_DIR_POINTER→0x80,
// one MEAS_INFO block (empty), one RAW_DATA block containing one
// FIFF_DATA_BUFFER of 32 bytes, then FIFF_DIR at 0x80 with 6 entries.
function buildSyntheticFiff() {
  const buf = new ArrayBuffer(512);
  const dv = new DataView(buf);
  // 0x00 FIFF_FILE_ID (kind=100, type=31, size=20 (FIFF spec), next=0)
  writeTagBE(dv, 0x00, FIFF_FILE_ID, 31, 20, 0);
  // 0x24 FIFF_DIR_POINTER (kind=101, type=3, size=4, next=0) payload@0x34 = 0x100
  writeTagBE(dv, 0x24, FIFF_DIR_POINTER, TYPE_INT32, 4, 0);
  dv.setInt32(0x24 + 16, 0x100, false);
  // 0x38 BLOCK_START MEAS_INFO
  writeTagBE(dv, 0x38, FIFF_BLOCK_START, TYPE_INT32, 4, 0);
  dv.setInt32(0x38 + 16, FIFFB_MEAS_INFO, false);
  // 0x4c BLOCK_END MEAS_INFO
  writeTagBE(dv, 0x4c, FIFF_BLOCK_END, TYPE_INT32, 4, 0);
  dv.setInt32(0x4c + 16, FIFFB_MEAS_INFO, false);
  // 0x60 BLOCK_START RAW_DATA
  writeTagBE(dv, 0x60, FIFF_BLOCK_START, TYPE_INT32, 4, 0);
  dv.setInt32(0x60 + 16, FIFFB_RAW_DATA, false);
  // 0x74 FIFF_DATA_BUFFER (kind=300, type=4=float32, size=32, next=0)
  writeTagBE(dv, 0x74, FIFF_DATA_BUFFER, 4, 32, 0);
  // 0xa8 BLOCK_END RAW_DATA
  writeTagBE(dv, 0xa8, FIFF_BLOCK_END, TYPE_INT32, 4, 0);
  dv.setInt32(0xa8 + 16, FIFFB_RAW_DATA, false);
  // 0x100 FIFF_DIR (kind=102, type=3, size = 6 entries × 16 = 96, next=-1)
  writeTagBE(dv, 0x100, FIFF_DIR, TYPE_INT32, 6 * 16, -1);
  // Each dir entry: (kind, type, size, position) — int32 BE × 4 = 16 B.
  const entries = [
    [FIFF_BLOCK_START, TYPE_INT32, 4, 0x38],
    [FIFF_BLOCK_END,   TYPE_INT32, 4, 0x4c],
    [FIFF_BLOCK_START, TYPE_INT32, 4, 0x60],
    [FIFF_DATA_BUFFER, 4,          32, 0x74],
    [FIFF_BLOCK_END,   TYPE_INT32, 4, 0xa8],
    [FIFF_FILE_ID,     31,         20, 0x00],
  ];
  let off = 0x100 + 16;
  for (const [k, t, s, p] of entries) {
    dv.setInt32(off + 0,  k, false);
    dv.setInt32(off + 4,  t, false);
    dv.setInt32(off + 8,  s, false);
    dv.setInt32(off + 12, p, false);
    off += 16;
  }
  return buf;
}

test('fiff-dir: parses synthetic directory and locates MEAS_INFO + RAW_DATA ranges', () => {
  const buf = buildSyntheticFiff();
  const view = new DataView(buf);
  const dirInfo = FiffDir.readDirPointer(view);
  assert.equal(dirInfo.dirOffset, 0x100, 'dir pointer payload is 0x100');
  assert.equal(dirInfo.hasDirectory, true);

  const dir = FiffDir.parseDirectory(view, dirInfo.dirOffset);
  assert.equal(dir.entries.length, 6, 'six directory entries');
  assert.equal(dir.entries[3].kind, FIFF_DATA_BUFFER);
  assert.equal(dir.entries[3].position, 0x74);

  const blocks = FiffDir.indexBlocks(view, dir.entries);
  // Should find: MEAS_INFO [0x38..0x4c], RAW_DATA [0x60..0xa8]
  assert.ok(blocks.meas_info, 'meas_info block found');
  assert.equal(blocks.meas_info.startTagOffset, 0x38);
  assert.equal(blocks.meas_info.endTagOffset,   0x4c);
  assert.ok(blocks.raw_data, 'raw_data block found');
  assert.equal(blocks.raw_data.startTagOffset, 0x60);
  assert.equal(blocks.raw_data.endTagOffset,   0xa8);
  // RAW_DATA must enumerate exactly one FIFF_DATA_BUFFER.
  assert.equal(blocks.raw_data.buffers.length, 1);
  assert.equal(blocks.raw_data.buffers[0].headerOffset, 0x74);
  assert.equal(blocks.raw_data.buffers[0].payloadOffset, 0x74 + 16);
  assert.equal(blocks.raw_data.buffers[0].payloadSize, 32);
  assert.equal(blocks.raw_data.buffers[0].miType, 4);
});

test('fiff-dir: returns hasDirectory=false when DIR_POINTER payload is -1', () => {
  const buf = new ArrayBuffer(64);
  const dv = new DataView(buf);
  writeTagBE(dv, 0x00, FIFF_FILE_ID, 31, 20, 0);
  writeTagBE(dv, 0x24, FIFF_DIR_POINTER, TYPE_INT32, 4, 0);
  dv.setInt32(0x24 + 16, -1, false);
  const view = new DataView(buf);
  const dirInfo = FiffDir.readDirPointer(view);
  assert.equal(dirInfo.hasDirectory, false, 'no directory when pointer is -1');
});

test('fiff-dir: rejects garbage first tag', () => {
  const buf = new ArrayBuffer(64);
  const dv = new DataView(buf);
  writeTagBE(dv, 0x00, 999, 0, 0, 0);  // not FIFF_FILE_ID
  const view = new DataView(buf);
  assert.throws(() => FiffDir.readDirPointer(view), /FIFF_FILE_ID/);
});

const REAL_FIXTURE = path.resolve('tests/fixtures/meg/test_ctf_comp_raw.fif');
const skipIfNoFixture = !fs.existsSync(REAL_FIXTURE);

test('fiff-dir: real-world test_ctf_comp_raw.fif has a directory and a raw_data block', { skip: skipIfNoFixture }, () => {
  const buf = fs.readFileSync(REAL_FIXTURE);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const view = new DataView(ab);
  const dirInfo = FiffDir.readDirPointer(view);
  // test_ctf_comp_raw.fif is a complete MNE test file — it MUST have a directory.
  assert.equal(dirInfo.hasDirectory, true);
  const dir = FiffDir.parseDirectory(view, dirInfo.dirOffset);
  assert.ok(dir.entries.length > 10, 'real file has many dir entries');
  const blocks = FiffDir.indexBlocks(view, dir.entries);
  assert.ok(blocks.meas_info, 'real file has MEAS_INFO');
  assert.ok(blocks.raw_data,  'real file has RAW_DATA');
  assert.ok(blocks.raw_data.buffers.length > 0, 'real file has data buffers');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit-fiff-dir.test.mjs`

Expected: FAIL with `Cannot find module '../formats/_fiff-dir.js'`.

- [ ] **Step 3: Create the directory-walker module**

Create `formats/_fiff-dir.js`:

```javascript
/* ============================================================
   formats/_fiff-dir.js — FIFF tag-directory walker.

   FIFF files conventionally include a "directory" tag near
   end-of-file: a single FIFF_DIR (kind=102) tag whose payload
   is an array of (kind, type, size, position) entries, one per
   non-directory tag in the file. The directory's absolute byte
   offset is stored in the FIFF_DIR_POINTER (kind=101) tag at
   offset 0x24 (right after the 36-byte FIFF_FILE_ID header).

   This module pulls just the directory out of an already-fetched
   tail-of-file DataView and indexes block ranges. It NEVER reads
   beyond the bytes given to it — callers range-fetch the right
   slices first. All FIFF integers are big-endian.

   References:
   - MNE-Python  mne/_fiff/open.py::_get_next_fname_and_pos
   - MNE-Python  mne/_fiff/meas_info.py::_read_dir
   ============================================================ */
(function () {
  'use strict';

  const api = {};

  // Same constants as formats/fiff.js — duplicated here so this
  // module is parseable in isolation (Stryker mutates it without
  // the parent loaded).
  const FIFF_FILE_ID     = 100;
  const FIFF_DIR_POINTER = 101;
  const FIFF_DIR         = 102;
  const FIFF_BLOCK_START = 104;
  const FIFF_BLOCK_END   = 105;
  const FIFFB_MEAS_INFO  = 101;
  const FIFFB_RAW_DATA   = 102;
  const FIFF_DATA_BUFFER = 300;

  // Validate the first tag is FIFF_FILE_ID. Then read the second
  // tag (16-byte header at offset 0x24 (= 36)) — it should be
  // FIFF_DIR_POINTER. If its 4-byte int32 BE payload is -1, the
  // file has no directory; otherwise that's the absolute byte
  // offset of the FIFF_DIR tag.
  //
  // `view` must cover at least bytes [0..63]. Throws if FILE_ID is
  // missing or unreadable.
  api.readDirPointer = function (view) {
    if (view.byteLength < 56) {
      throw new Error(`fiff-dir: view too short (${view.byteLength}B) to read FILE_ID + DIR_POINTER`);
    }
    const fileIdKind = view.getInt32(0, false);
    if (fileIdKind !== FIFF_FILE_ID) {
      throw new Error(
        `fiff-dir: first tag kind=${fileIdKind} is not FIFF_FILE_ID (${FIFF_FILE_ID})`,
      );
    }
    // FIFF_FILE_ID has size=20 — header (16) + payload (20) = 36 bytes,
    // so the next tag's header starts at offset 0x24.
    const fileIdSize = view.getInt32(8, false);
    const nextTagOff = 16 + fileIdSize;
    if (nextTagOff + 16 > view.byteLength) {
      throw new Error(`fiff-dir: file too short for DIR_POINTER at ${nextTagOff}`);
    }
    const dirPointerKind = view.getInt32(nextTagOff, false);
    if (dirPointerKind !== FIFF_DIR_POINTER) {
      // Not every file has a DIR_POINTER as the second tag — older
      // streaming writers omit it. Surface "no directory" rather than
      // throw; the caller falls back to full-file walk.
      return { hasDirectory: false, dirOffset: -1, reason: 'no DIR_POINTER tag' };
    }
    const dirPointerPayloadOff = nextTagOff + 16;
    if (dirPointerPayloadOff + 4 > view.byteLength) {
      throw new Error(`fiff-dir: DIR_POINTER payload truncated at ${dirPointerPayloadOff}`);
    }
    const dirOffset = view.getInt32(dirPointerPayloadOff, false);
    if (dirOffset === -1) {
      return { hasDirectory: false, dirOffset: -1, reason: 'DIR_POINTER payload = -1' };
    }
    if (dirOffset < 0) {
      return { hasDirectory: false, dirOffset, reason: 'negative DIR_POINTER offset' };
    }
    return { hasDirectory: true, dirOffset };
  };

  // Given a DataView whose backing buffer covers the tail of the
  // file (including the FIFF_DIR tag), parse the directory tag at
  // `absDirOffset` (absolute file offset). The view's byteOffset
  // must satisfy: view.byteOffset <= absDirOffset; we compute the
  // local offset = absDirOffset - view.byteOffset and read from
  // there. Returns `{ entries: [{kind, type, size, position}] }`.
  api.parseDirectory = function (view, absDirOffset) {
    const viewBase = view.byteOffset || 0;
    const localOff = absDirOffset - viewBase;
    if (localOff < 0 || localOff + 16 > view.byteLength) {
      throw new Error(
        `fiff-dir: dir at abs ${absDirOffset} not inside view ` +
        `(viewBase=${viewBase}, viewLen=${view.byteLength})`,
      );
    }
    const dirView = new DataView(view.buffer, viewBase + localOff, view.byteLength - localOff);
    const kind = dirView.getInt32(0, false);
    if (kind !== FIFF_DIR) {
      throw new Error(`fiff-dir: tag at ${absDirOffset} kind=${kind}, expected FIFF_DIR (${FIFF_DIR})`);
    }
    const size = dirView.getInt32(8, false);
    if (size < 0 || size % 16 !== 0) {
      throw new Error(`fiff-dir: bad directory size=${size} (must be multiple of 16)`);
    }
    const nEntries = size / 16;
    if (16 + size > dirView.byteLength) {
      throw new Error(
        `fiff-dir: directory body (${size}B) overflows view tail ` +
        `(have ${dirView.byteLength - 16}B from dir header)`,
      );
    }
    const entries = new Array(nEntries);
    for (let i = 0; i < nEntries; i++) {
      const eOff = 16 + i * 16;
      entries[i] = {
        kind:     dirView.getInt32(eOff + 0,  false),
        type:     dirView.getInt32(eOff + 4,  false),
        size:     dirView.getInt32(eOff + 8,  false),
        position: dirView.getInt32(eOff + 12, false),
      };
    }
    return { entries };
  };

  // Walk directory entries in document order, tracking BLOCK_START /
  // BLOCK_END payloads to map block-id → [startTagOffset, endTagOffset].
  // For RAW_DATA we additionally enumerate the FIFF_DATA_BUFFER tags
  // inside the block — that's the buffer index readWindow needs.
  //
  // `view` only needs to cover the BLOCK_START / BLOCK_END payloads
  // (4 bytes each, one int32 BE = block id). If the view is the same
  // tail-of-file slice as parseDirectory used, we read block ids by
  // reaching back into the directory entries' `position` fields and
  // resolving each via the absolute offsets in the view. If a block
  // payload is outside the view, indexBlocks() falls back to using
  // ONLY directory entries (kind tells us whether it's a START/END;
  // since we can't see the payload, we infer block-id pairing by
  // matching adjacent START/END entries in document order — works
  // for non-nested blocks, which all our targets are).
  api.indexBlocks = function (view, entries) {
    const viewBase = view.byteOffset || 0;
    const viewEnd  = viewBase + view.byteLength;

    // First pass: for every START/END entry try to read its payload
    // (the block-id int32 BE at entry.position + 16). If payload is
    // inside our view, we know the block-id; otherwise mark unknown.
    function readBlockId(entryPosition) {
      const payloadAbs = entryPosition + 16;
      if (payloadAbs < viewBase || payloadAbs + 4 > viewEnd) return null;
      return view.getInt32(payloadAbs - viewBase, false);
    }

    // Walk the stream of START/END/DATA_BUFFER entries.
    const stack = [];  // active block ids
    const blocks = {};   // result: { meas_info, raw_data } when found
    let currentRaw = null;

    for (const e of entries) {
      if (e.kind === FIFF_BLOCK_START) {
        const id = readBlockId(e.position);
        stack.push({ id, startTagOffset: e.position });
        if (id === FIFFB_RAW_DATA) {
          currentRaw = { startTagOffset: e.position, endTagOffset: -1, buffers: [] };
        }
      } else if (e.kind === FIFF_BLOCK_END) {
        const top = stack.pop();
        if (!top) continue;
        const id = top.id;  // pair by stack — robust if END payload is outside view
        if (id === FIFFB_MEAS_INFO) {
          blocks.meas_info = { startTagOffset: top.startTagOffset, endTagOffset: e.position };
        } else if (id === FIFFB_RAW_DATA && currentRaw) {
          currentRaw.endTagOffset = e.position;
          blocks.raw_data = currentRaw;
          currentRaw = null;
        }
      } else if (e.kind === FIFF_DATA_BUFFER && currentRaw) {
        currentRaw.buffers.push({
          headerOffset:  e.position,
          payloadOffset: e.position + 16,
          payloadSize:   e.size,
          miType:        e.type,  // 2=int16, 3=int32, 4=float32 per FIFF spec
        });
      }
    }
    return blocks;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.FiffDir = api;
})();
```

- [ ] **Step 4: Update `formats/globals.d.ts`**

Add `declare const FiffDir: any;` after the `declare const CTFMarker: any;` line, and add the `var FiffDir: any;` declaration inside `declare global`.

Edit `formats/globals.d.ts`:

```typescript
// After: declare const CTFMarker: any;
declare const FiffDir: any;

// Inside `declare global` after CTFMarker:
  // eslint-disable-next-line no-var
  var FiffDir: any;
```

- [ ] **Step 5: Update `jsconfig.json`**

Add `"formats/_fiff-dir.js"` to the `include` array, right after `"formats/ctf.js"`:

```json
{
  "include": [
    "formats/globals.d.ts",
    "formats/edf.js",
    "formats/brainvision.js",
    "formats/eeglab.js",
    "formats/fiff.js",
    "formats/ctf.js",
    "formats/_fiff-dir.js"
  ]
}
```

- [ ] **Step 6: Update `tests/_bootstrap.mjs`**

Edit `tests/_bootstrap.mjs` — add `FiffDir` to the side-effect loads and exports. After the line `require('../formats/_buffers.js');` insert `require('../formats/_fiff-dir.js');`. After the `export const Mat73 = ...` line, add:

```javascript
export const FiffDir       = require('../formats/_fiff-dir.js');
export const FiffReader    = require('../formats/fiff.js');
```

- [ ] **Step 7: Run test to verify it passes**

Run: `node --test tests/unit-fiff-dir.test.mjs`

Expected: PASS — all 4 tests (synthetic dir parse, no-dir fallback, garbage rejection, real fixture).

- [ ] **Step 8: Run typecheck**

Run: `npm run test:typecheck`

Expected: PASS — no new tsc errors.

- [ ] **Step 9: Commit**

```bash
git add formats/_fiff-dir.js formats/globals.d.ts jsconfig.json tests/_bootstrap.mjs tests/unit-fiff-dir.test.mjs
git commit -m "feat(fiff): add tag-directory walker for range-based reads"
```

---

### Task 2: FIFF range-based `api.open` (`formats/fiff.js`)

**Goal:** Refactor `api.open` so it never calls `fetchBuffer`. Instead: probe length, range-fetch the last 256 KB for the directory, range-fetch the MEAS_INFO bytes, build the channel metadata + buffer index. Keep the existing `api.read` whole-buffer path as the no-directory fallback.

**Files:**
- Modify: `formats/fiff.js` (`api.open` function, lines 329-414)
- Create: `tests/unit-fiff-range.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/unit-fiff-range.test.mjs`:

```javascript
// Unit tests for the range-based FIFF api.open path. Mocks
// HttpRange.{probeLength, rangeFetch} so we can construct a synthetic
// FIFF body, register it as a byte source, and assert that open():
//   1. Only fetches the directory tail + meas_info bytes (NOT the
//      whole file — important property: the byte-range index must
//      stay small for huge files).
//   2. Returns the correct n_samples / n_channels / sfreq.
//   3. Falls back to fetchBuffer when DIR_POINTER says -1.
import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { FiffReader, FiffDir, HttpRange } from './_bootstrap.mjs';

// ---- synthetic FIFF builder ---------------------------------------

const FIFF_FILE_ID     = 100;
const FIFF_DIR_POINTER = 101;
const FIFF_DIR         = 102;
const FIFF_BLOCK_START = 104;
const FIFF_BLOCK_END   = 105;
const FIFF_NCHAN       = 200;
const FIFF_SFREQ       = 201;
const FIFF_CH_INFO     = 203;
const FIFF_DATA_BUFFER = 300;
const FIFFB_MEAS_INFO  = 101;
const FIFFB_RAW_DATA   = 102;

function wTag(dv, off, kind, type, size, next) {
  dv.setInt32(off + 0,  kind, false);
  dv.setInt32(off + 4,  type, false);
  dv.setInt32(off + 8,  size, false);
  dv.setInt32(off + 12, next, false);
}

// Build a FIFF with 2 channels, sfreq=100 Hz, and one data buffer
// of 50 samples (so n_samples=50, file size ≈ 1 KB).
function buildSyntheticFiff() {
  const buf = new ArrayBuffer(2048);
  const dv = new DataView(buf);
  let off = 0;
  // FIFF_FILE_ID
  wTag(dv, off, FIFF_FILE_ID, 31, 20, 0); off += 36;
  // FIFF_DIR_POINTER → directory at 0x400
  wTag(dv, off, FIFF_DIR_POINTER, 3, 4, 0); dv.setInt32(off + 16, 0x400, false); off += 20;
  // BLOCK_START MEAS_INFO
  const measStart = off;
  wTag(dv, off, FIFF_BLOCK_START, 3, 4, 0); dv.setInt32(off + 16, FIFFB_MEAS_INFO, false); off += 20;
  // FIFF_NCHAN = 2
  const nchanPos = off;
  wTag(dv, off, FIFF_NCHAN, 3, 4, 0); dv.setInt32(off + 16, 2, false); off += 20;
  // FIFF_SFREQ = 100.0
  const sfreqPos = off;
  wTag(dv, off, FIFF_SFREQ, 4, 4, 0); dv.setFloat32(off + 16, 100.0, false); off += 20;
  // 2× FIFF_CH_INFO (96 bytes each)
  const ch1Pos = off;
  wTag(dv, off, FIFF_CH_INFO, 1, 96, 0);
  for (let i = 0; i < 96; i++) dv.setUint8(off + 16 + i, 0);
  dv.setFloat32(off + 16 + 12, 1.0, false);  // range
  dv.setFloat32(off + 16 + 16, 1.0, false);  // cal
  off += 112;
  const ch2Pos = off;
  wTag(dv, off, FIFF_CH_INFO, 1, 96, 0);
  for (let i = 0; i < 96; i++) dv.setUint8(off + 16 + i, 0);
  dv.setFloat32(off + 16 + 12, 1.0, false);
  dv.setFloat32(off + 16 + 16, 1.0, false);
  off += 112;
  // BLOCK_END MEAS_INFO
  const measEnd = off;
  wTag(dv, off, FIFF_BLOCK_END, 3, 4, 0); dv.setInt32(off + 16, FIFFB_MEAS_INFO, false); off += 20;
  // BLOCK_START RAW_DATA
  const rawStart = off;
  wTag(dv, off, FIFF_BLOCK_START, 3, 4, 0); dv.setInt32(off + 16, FIFFB_RAW_DATA, false); off += 20;
  // FIFF_DATA_BUFFER (type=4 float32, 50 samples × 2 chans × 4 = 400 bytes)
  const buf1Pos = off;
  wTag(dv, off, FIFF_DATA_BUFFER, 4, 400, 0);
  for (let i = 0; i < 100; i++) dv.setFloat32(off + 16 + i * 4, i * 0.01, false);
  off += 16 + 400;
  // BLOCK_END RAW_DATA
  const rawEnd = off;
  wTag(dv, off, FIFF_BLOCK_END, 3, 4, 0); dv.setInt32(off + 16, FIFFB_RAW_DATA, false); off += 20;
  // FIFF_DIR at 0x400 with all entries
  const dirOff = 0x400;
  const entries = [
    [FIFF_FILE_ID,     31, 20, 0],
    [FIFF_DIR_POINTER, 3,  4,  36],
    [FIFF_BLOCK_START, 3,  4,  measStart],
    [FIFF_NCHAN,       3,  4,  nchanPos],
    [FIFF_SFREQ,       4,  4,  sfreqPos],
    [FIFF_CH_INFO,     1,  96, ch1Pos],
    [FIFF_CH_INFO,     1,  96, ch2Pos],
    [FIFF_BLOCK_END,   3,  4,  measEnd],
    [FIFF_BLOCK_START, 3,  4,  rawStart],
    [FIFF_DATA_BUFFER, 4,  400, buf1Pos],
    [FIFF_BLOCK_END,   3,  4,  rawEnd],
  ];
  wTag(dv, dirOff, FIFF_DIR, 3, entries.length * 16, -1);
  for (let i = 0; i < entries.length; i++) {
    const [k, t, s, p] = entries[i];
    const eOff = dirOff + 16 + i * 16;
    dv.setInt32(eOff + 0,  k, false);
    dv.setInt32(eOff + 4,  t, false);
    dv.setInt32(eOff + 8,  s, false);
    dv.setInt32(eOff + 12, p, false);
  }
  const totalBytes = dirOff + 16 + entries.length * 16;
  return buf.slice(0, totalBytes);
}

// ---- shared mock: tracks every range request ----------------------

let mockSource;            // ArrayBuffer
let rangeRequestLog;       // [{ start, end }]

beforeEach(() => {
  mockSource = buildSyntheticFiff();
  rangeRequestLog = [];
  globalThis.HttpRange.probeLength = async () => mockSource.byteLength;
  globalThis.HttpRange.rangeFetch  = async (_url, start, endIncl) => {
    rangeRequestLog.push({ start, end: endIncl });
    return mockSource.slice(start, endIncl + 1);
  };
});

test('fiff range: open() fetches < 50% of total bytes', async () => {
  const reader = await FiffReader.open({ eeg_url: 'mock://synth.fif' });
  const totalFetched = rangeRequestLog.reduce(
    (acc, r) => acc + (r.end - r.start + 1),
    0,
  );
  assert.ok(
    totalFetched < mockSource.byteLength * 0.5,
    `open fetched ${totalFetched}B of ${mockSource.byteLength}B — should be < 50%`,
  );
  assert.equal(reader.n_channels, 2);
  assert.equal(reader.sampling_frequency, 100);
  assert.equal(reader.n_samples, 50);
});

test('fiff range: returns channel labels and duration', async () => {
  const reader = await FiffReader.open({ eeg_url: 'mock://synth.fif' });
  assert.equal(reader.channel_labels.length, 2);
  assert.equal(reader.duration_s, 0.5);  // 50 samples / 100 Hz
});

test('fiff range: falls back to fetchBuffer when DIR_POINTER = -1', async () => {
  // Rewrite the DIR_POINTER payload to -1 → no-directory file.
  const dv = new DataView(mockSource);
  dv.setInt32(0x24 + 16, -1, false);
  // The fallback path uses fetchBuffer. Mock it.
  let fetchBufferCalled = false;
  globalThis.HttpRange.fetchBuffer = async (url) => {
    fetchBufferCalled = true;
    return mockSource;
  };
  const reader = await FiffReader.open({ eeg_url: 'mock://synth-nodir.fif' });
  assert.equal(fetchBufferCalled, true, 'fallback must call fetchBuffer');
  assert.equal(reader.n_channels, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit-fiff-range.test.mjs`

Expected: FAIL — `open fetched 1392B of 1392B — should be < 50%` (current implementation downloads the whole file).

- [ ] **Step 3: Refactor `api.open` in `formats/fiff.js`**

Replace the body of `api.open` (lines 329-414) with a range-based path that falls back to the current full-file path when no directory is available. The new code goes inside the existing IIFE — keep all existing helpers (`readTag`, `parseChannelInfo`, `extractDataBuffer`, `assembleChannels`).

Edit `formats/fiff.js`, replace the entire `api.open` function (lines 329-414):

```javascript
  // Internal constant: how many bytes from end-of-file to range-fetch
  // for the directory probe. 256 KB is well above the largest FIFF
  // directories we've observed (10-50 KB for 1-2h recordings) yet
  // small enough to load on a slow link in < 1 s.
  const FIFF_DIR_TAIL_BYTES = 256 * 1024;

  // Decode the bytes of one FIFF_DATA_BUFFER tag's payload into a
  // typed array matching the on-disk miType. This duplicates the
  // logic in extractDataBuffer (which works from a DataView over the
  // full file) for the range-based path where each call sees only
  // ONE payload's bytes.
  function decodeRawBufferBytes(payloadBuf, miType, expectedElemCount) {
    const elemBytes = (miType === 2 ? 2 : 4);
    const elemCount = Math.floor(payloadBuf.byteLength / elemBytes);
    const n = Math.min(elemCount, expectedElemCount);
    const view = new DataView(payloadBuf);
    if (miType === 2) {
      const out = new Int16Array(n);
      for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, false);
      return out;
    }
    if (miType === 3) {
      const out = new Int32Array(n);
      for (let i = 0; i < n; i++) out[i] = view.getInt32(i * 4, false);
      return out;
    }
    // type=4 float32 (most common) or anything else → treat as float32
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = view.getFloat32(i * 4, false);
    return out;
  }

  api.open = async function (meta) {
    const url = meta.eeg_url || meta.url;
    if (!url) throw new Error('fiff.open: meta.eeg_url is required');

    // Probe total file length so we can compute the tail-range to fetch.
    const totalBytes = await globalThis.HttpRange.probeLength(url);
    if (totalBytes < 36) {
      throw new Error(`fiff: file too small (${totalBytes}B) — need at least 36B for header`);
    }

    // Range-fetch the tail to find FIFF_DIR (the directory is the last
    // tag in well-formed files; tail=256KB covers typical 10-50KB dirs
    // plus the FIFF_FILE_ID + FIFF_DIR_POINTER preamble overlap, which
    // we re-fetch separately because for huge files the head won't be
    // in the tail slice).
    const tailStart = Math.max(0, totalBytes - FIFF_DIR_TAIL_BYTES);
    const tailBuf   = await globalThis.HttpRange.rangeFetch(
      url, tailStart, totalBytes - 1, totalBytes - tailStart,
    );
    const tailView = new DataView(tailBuf, 0, tailBuf.byteLength);
    // Patch the view's byteOffset semantics for FiffDir consumers:
    // FiffDir.parseDirectory expects view.byteOffset to be the
    // absolute file offset. ArrayBuffer-backed DataView has
    // byteOffset=0 — wrap to expose tailStart.
    const tailAbs = { buffer: tailBuf, byteOffset: tailStart, byteLength: tailBuf.byteLength,
                      getInt32(off, le) { return new DataView(tailBuf).getInt32(off, le); } };
    // Build a "shifted" view object FiffDir can use: getInt32(localOff, le)
    // already works on the underlying DataView; we synthesise just
    // enough of the DataView interface for FiffDir.
    const shiftedView = new Proxy(new DataView(tailBuf), {
      get(target, prop) {
        if (prop === 'byteOffset') return tailStart;
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });

    // Range-fetch the header bytes (first 64 B) so we can read
    // FIFF_FILE_ID + FIFF_DIR_POINTER. For files smaller than the tail
    // size this is already inside tailBuf; for huge files it's not.
    let headBuf;
    if (tailStart === 0) {
      headBuf = tailBuf;
    } else {
      headBuf = await globalThis.HttpRange.rangeFetch(url, 0, 63, 64);
    }
    const headView = new DataView(headBuf, 0, headBuf.byteLength);

    const dirInfo = globalThis.FiffDir.readDirPointer(headView);

    if (!dirInfo.hasDirectory) {
      // No directory → fall back to the legacy whole-file path.
      // Cap at 200 MB so we don't OOM the page; raise/lower if needed.
      const FALLBACK_CAP = 200 * 1024 * 1024;
      if (totalBytes > FALLBACK_CAP) {
        throw new Error(
          `fiff: file is ${(totalBytes / 1024 / 1024).toFixed(0)} MB and has no ` +
          `tag directory — cannot stream. Re-export with a modern FIFF writer.`,
        );
      }
      const wholeBuf = await globalThis.HttpRange.fetchBuffer(url);
      const meas    = api.read(wholeBuf);
      return buildReaderFromMeas(meas);
    }

    // Parse directory entries → block ranges.
    const dir    = globalThis.FiffDir.parseDirectory(shiftedView, dirInfo.dirOffset);
    const blocks = globalThis.FiffDir.indexBlocks(shiftedView, dir.entries);
    if (!blocks.meas_info) {
      throw new Error('fiff: directory has no FIFFB_MEAS_INFO block — cannot open');
    }

    // Range-fetch the MEAS_INFO bytes: [meas_info.startTagOffset,
    // meas_info.endTagOffset + 19]. End offset is the BLOCK_END tag's
    // header offset; we need 16B (header) + 4B (payload) = 20B more.
    const measStart = blocks.meas_info.startTagOffset;
    const measEnd   = blocks.meas_info.endTagOffset + 19;
    const measLen   = measEnd - measStart + 1;
    const measBuf   = await globalThis.HttpRange.rangeFetch(url, measStart, measEnd, measLen);
    // Parse via the existing api.read but prepend a FIFF_FILE_ID so
    // the validity check passes — easier than parameterising api.read.
    const wrappedBuf = wrapMeasInfo(measBuf);
    const meas       = api.read(wrappedBuf);

    // If no raw_data block, return a meta-only reader (readWindow throws).
    if (!blocks.raw_data || blocks.raw_data.buffers.length === 0) {
      return buildReaderFromMeas(meas);
    }

    // Build per-buffer sample index: bytesPerSample × nchan determines
    // samples-per-buffer. Cumulative samples give us a binary-search
    // index for readWindow.
    const nchan = meas.nchan;
    const bufIndex = [];
    let cumulative = 0;
    for (const b of blocks.raw_data.buffers) {
      const bytesPerSample = (b.miType === 2 ? 2 : 4);
      const elemCount = Math.floor(b.payloadSize / bytesPerSample);
      const samplesInBuf = Math.floor(elemCount / nchan);
      bufIndex.push({
        payloadOffset: b.payloadOffset,
        payloadSize:   b.payloadSize,
        miType:        b.miType,
        bytesPerSample,
        samplesInBuf,
        cumStart:      cumulative,
      });
      cumulative += samplesInBuf;
    }
    const totalSamples = cumulative;

    return buildRangeReader({ meta, url, meas, bufIndex, totalSamples });
  };

  // Wrap a meas_info byte range in a FIFF_FILE_ID prefix so it passes
  // api.read's validity check.
  function wrapMeasInfo(measBuf) {
    const prefix = new ArrayBuffer(36);  // FILE_ID header (16) + payload (20)
    const dv = new DataView(prefix);
    dv.setInt32(0,  100, false);  // FIFF_FILE_ID
    dv.setInt32(4,  31,  false);
    dv.setInt32(8,  20,  false);  // size=20
    dv.setInt32(12, 0,   false);
    const out = new Uint8Array(prefix.byteLength + measBuf.byteLength);
    out.set(new Uint8Array(prefix), 0);
    out.set(new Uint8Array(measBuf), prefix.byteLength);
    return out.buffer;
  }

  // Used by both the directory and no-directory paths to assemble the
  // reader object from a fully-walked meas. When meas.raw is null we
  // still return a reader (readWindow throws); when it is present we
  // serve windows from the in-memory channel arrays — same as the
  // pre-refactor behaviour.
  function buildReaderFromMeas(meas) {
    const channelLabels = Array.isArray(meas.chs) && meas.chs.length > 0
      ? meas.chs.map((c, i) => (c && c.name) || `Ch${i + 1}`)
      : Array.from({ length: meas.nchan || 0 }, (_, i) => `Ch${i + 1}`);

    let rawChannels = null;
    if (meas.raw && Array.isArray(meas.raw.buffers) && meas.raw.buffers.length > 0) {
      rawChannels = assembleFromMeas(meas);
    }
    const nsamp     = rawChannels && rawChannels[0] ? rawChannels[0].length : 0;
    const sfreq     = meas.sfreq || 0;
    const duration  = sfreq > 0 ? nsamp / sfreq : 0;
    const nchan     = meas.nchan || 0;
    return {
      n_channels:         nchan,
      sampling_frequency: sfreq,
      duration_s:         duration,
      channel_labels:     channelLabels,
      bytes_per_sample:   4,
      n_samples:          nsamp,
      recording_start_iso: null,
      annotation_events:   null,
      streaming:          false,
      async readWindow(start, n) {
        if (!rawChannels) {
          throw new Error('fiff: this file has no FIFFB_RAW_DATA block (events/projections/annotations only)');
        }
        const end = Math.min(start + n, nsamp);
        const slice = [];
        for (let c = 0; c < nchan; c++) slice.push(rawChannels[c].subarray(start, end));
        return slice;
      },
    };
  }

  // De-interleave + calibrate, identical math to the pre-refactor
  // assembleChannels (kept available as a helper for the no-directory
  // fallback path).
  function assembleFromMeas(measObj) {
    const nch  = measObj.nchan;
    const total = measObj.raw.nsamp || 0;
    if (nch <= 0 || total <= 0) return null;
    const cals = [];
    for (let c = 0; c < nch; c++) {
      const ch = (measObj.chs && measObj.chs[c]) || null;
      const cal = ch && Number.isFinite(ch.cal) ? ch.cal : 1;
      const range = ch && Number.isFinite(ch.range) ? ch.range : 1;
      cals.push(cal * range);
    }
    const out = new Array(nch);
    for (let c = 0; c < nch; c++) out[c] = new Float32Array(total);
    let writeIdx = 0;
    for (const buf of measObj.raw.buffers) {
      const samples = buf && typeof buf.length === 'number' ? buf : (buf && buf.data) || null;
      if (!samples || typeof samples.length !== 'number') continue;
      const samplesInBuf = Math.floor(samples.length / nch);
      for (let t = 0; t < samplesInBuf; t++) {
        const dst = writeIdx + t;
        if (dst >= total) break;
        const baseSrc = t * nch;
        for (let c = 0; c < nch; c++) out[c][dst] = samples[baseSrc + c] * cals[c];
      }
      writeIdx += samplesInBuf;
      if (writeIdx >= total) break;
    }
    return out;
  }

  // Range-based reader: opens with no raw data in memory; readWindow
  // range-fetches the bytes for the requested window from the
  // pre-built buffer index. See Task 3 for the readWindow body.
  function buildRangeReader(ctx) {
    const { meta, url, meas, bufIndex, totalSamples } = ctx;
    const nchan = meas.nchan;
    const sfreq = meas.sfreq;
    const duration = sfreq > 0 ? totalSamples / sfreq : 0;
    const channelLabels = (meas.chs || []).map((c, i) => (c && c.name) || `Ch${i + 1}`);
    while (channelLabels.length < nchan) channelLabels.push(`Ch${channelLabels.length + 1}`);

    // Per-channel calibration coefficient.
    const cals = [];
    for (let c = 0; c < nchan; c++) {
      const ch = meas.chs && meas.chs[c];
      const cal = ch && Number.isFinite(ch.cal) ? ch.cal : 1;
      const range = ch && Number.isFinite(ch.range) ? ch.range : 1;
      cals.push(cal * range);
    }

    return {
      n_channels:         nchan,
      sampling_frequency: sfreq,
      duration_s:         duration,
      channel_labels:     channelLabels,
      bytes_per_sample:   4,
      n_samples:          totalSamples,
      recording_start_iso: null,
      annotation_events:   null,
      streaming:          true,
      // Implemented in Task 3.
      readWindow: async (start, n, opts) =>
        readWindowRange(url, nchan, cals, bufIndex, totalSamples, start, n, opts),
      // Implemented in Task 4.
      readWindowStreaming: (start, n, opts) =>
        readWindowRangeStreaming(url, nchan, cals, bufIndex, totalSamples, start, n, opts),
    };
  }

  // Task 3 + 4 placeholders so api.open can reference them. These
  // throw until Task 3 / Task 4 implement them.
  async function readWindowRange(/*url, nchan, cals, bufIndex, n, start, n, opts*/) {
    throw new Error('fiff: range readWindow not implemented yet');
  }
  async function* readWindowRangeStreaming(/* ... */) {
    throw new Error('fiff: range readWindowStreaming not implemented yet');
  }
```

- [ ] **Step 4: Run test to verify open() passes**

Run: `node --test tests/unit-fiff-range.test.mjs --test-name-pattern="open\\(\\)"`

Expected: PASS — `open() fetches < 50% of total bytes`, `returns channel labels and duration`, `falls back to fetchBuffer when DIR_POINTER = -1`. The readWindow tests (next task) still fail at this point — that's expected.

- [ ] **Step 5: Run the existing FIFF tests to confirm no regression**

Run: `node --test tests/unit-fiff.test.mjs tests/unit-fiff-raw.test.mjs tests/unit-fiff-realworld.test.mjs`

Expected: PASS — the existing tests use either `api.read` directly or pass the file via a mocked `fetchBuffer` that still works because the no-directory fallback retains it.

- [ ] **Step 6: Commit**

```bash
git add formats/fiff.js tests/unit-fiff-range.test.mjs
git commit -m "feat(fiff): range-based api.open via tag-directory walk"
```

---

### Task 3: FIFF range-based `readWindow(start, n)` (`formats/fiff.js`)

**Goal:** Implement `readWindowRange` so it computes the byte slice within RAW_DATA's data buffers, range-fetches each, decodes, de-interleaves, and applies per-channel calibration.

**Files:**
- Modify: `formats/fiff.js` (replace the placeholder `readWindowRange` from Task 2)
- Modify: `tests/unit-fiff-range.test.mjs` (add readWindow tests)

- [ ] **Step 1: Add the failing readWindow tests**

Append to `tests/unit-fiff-range.test.mjs`:

```javascript
test('fiff range: readWindow(0, 10) returns 10 samples per channel', async () => {
  const reader = await FiffReader.open({ eeg_url: 'mock://synth.fif' });
  const win = await reader.readWindow(0, 10);
  assert.equal(win.length, 2);
  for (const ch of win) {
    assert.ok(ch instanceof Float32Array);
    assert.equal(ch.length, 10);
  }
  // Synthetic data: interleaved [0.00, 0.01, 0.02, 0.03, …] (channel-pair-per-sample
  // because we wrote i*0.01 to position i; sample t channel c is i = t*2+c).
  for (let t = 0; t < 10; t++) {
    assert.ok(Math.abs(win[0][t] - (t * 2 + 0) * 0.01) < 1e-6);
    assert.ok(Math.abs(win[1][t] - (t * 2 + 1) * 0.01) < 1e-6);
  }
});

test('fiff range: readWindow only fetches the bytes for the window', async () => {
  const reader = await FiffReader.open({ eeg_url: 'mock://synth.fif' });
  // Forget the open()-time fetches; we only care about subsequent ones.
  rangeRequestLog.length = 0;
  await reader.readWindow(0, 10);
  const fetched = rangeRequestLog.reduce((a, r) => a + (r.end - r.start + 1), 0);
  // 10 samples × 2 chans × 4 bytes = 80 bytes. Allow some slack for
  // covering-buffer-boundary overfetch (rounds to whole buffer in v1).
  assert.ok(fetched <= 500, `readWindow fetched ${fetched}B for 80B window`);
});

test('fiff range: readWindow at tail clamps to n_samples', async () => {
  const reader = await FiffReader.open({ eeg_url: 'mock://synth.fif' });
  const win = await reader.readWindow(reader.n_samples - 3, 100);
  assert.ok(win[0].length <= 3, `tail window length ${win[0].length}`);
  assert.ok(win[0].length > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit-fiff-range.test.mjs --test-name-pattern="readWindow"`

Expected: FAIL — `fiff: range readWindow not implemented yet`.

- [ ] **Step 3: Replace the placeholder `readWindowRange` in `formats/fiff.js`**

Replace the two placeholder functions (`readWindowRange` and `readWindowRangeStreaming`) added in Task 2 with the real implementation of `readWindowRange`. Leave the streaming placeholder until Task 4.

Edit `formats/fiff.js`, replacing the `readWindowRange` function:

```javascript
  // Binary-search the buffer index for the first buffer covering
  // `targetSample`. bufIndex is ordered by ascending cumStart so a
  // standard lower_bound on cumStart + samplesInBuf works.
  function findBufferForSample(bufIndex, targetSample) {
    let lo = 0, hi = bufIndex.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const b = bufIndex[mid];
      const bufEnd = b.cumStart + b.samplesInBuf;
      if (targetSample < b.cumStart) hi = mid - 1;
      else if (targetSample >= bufEnd) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  async function readWindowRange(url, nchan, cals, bufIndex, totalSamples, startReq, nReq, opts) {
    const start = Math.max(0, startReq);
    if (start >= totalSamples || nReq <= 0) {
      const out = new Array(nchan);
      for (let c = 0; c < nchan; c++) out[c] = new Float32Array(0);
      return out;
    }
    const end = Math.min(start + nReq, totalSamples);
    const nWin = end - start;
    const firstBufIdx = findBufferForSample(bufIndex, start);
    if (firstBufIdx === -1) throw new Error(`fiff: no buffer covers sample ${start}`);

    // Output allocation — one Float32Array per channel.
    const out = new Array(nchan);
    for (let c = 0; c < nchan; c++) out[c] = new Float32Array(nWin);

    // Walk buffers in order, range-fetching each that overlaps the window.
    // For v1 we fetch the entire buffer's payload (typical buffer is
    // ~64 KB, well under the 256 KB tile threshold so it's a single
    // single-tile fetch).
    let writeOff = 0;
    for (let i = firstBufIdx; i < bufIndex.length && writeOff < nWin; i++) {
      const b = bufIndex[i];
      const bufStartSample = b.cumStart;
      const bufEndSample   = b.cumStart + b.samplesInBuf;
      const sliceStart = Math.max(start, bufStartSample) - bufStartSample;  // local sample index
      const sliceEnd   = Math.min(end,   bufEndSample)   - bufStartSample;
      const nLocal = sliceEnd - sliceStart;
      if (nLocal <= 0) continue;

      // Range-fetch the whole buffer payload (v1; could narrow to
      // [sliceStart*nchan*bps, sliceEnd*nchan*bps] for huge buffers
      // but that's an optimisation for later).
      const payloadStart = b.payloadOffset;
      const payloadEnd   = b.payloadOffset + b.payloadSize - 1;
      const fetched = await globalThis.HttpRange.rangeFetch(
        url, payloadStart, payloadEnd, b.payloadSize, opts,
      );
      const expectedElemCount = b.samplesInBuf * nchan;
      const decoded = decodeRawBufferBytes(fetched, b.miType, expectedElemCount);
      // De-interleave + calibrate the slice we want.
      for (let t = 0; t < nLocal; t++) {
        const src = (sliceStart + t) * nchan;
        const dst = writeOff + t;
        for (let c = 0; c < nchan; c++) {
          out[c][dst] = decoded[src + c] * cals[c];
        }
      }
      writeOff += nLocal;
    }
    return out;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit-fiff-range.test.mjs`

Expected: PASS — all readWindow tests pass.

- [ ] **Step 5: Commit**

```bash
git add formats/fiff.js tests/unit-fiff-range.test.mjs
git commit -m "feat(fiff): range-based readWindow over per-buffer byte index"
```

---

### Task 4: FIFF `readWindowStreaming` async generator (`formats/fiff.js`)

**Goal:** Implement `readWindowRangeStreaming` as an async generator that yields one `{ firstSampleIdx, lastSampleIdx, channels }` per data buffer it processes — same shape as the existing EDF / EEGLAB streaming paths.

**Files:**
- Modify: `formats/fiff.js` (replace the placeholder `readWindowRangeStreaming`)
- Create: `tests/unit-fiff-streaming.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/unit-fiff-streaming.test.mjs`:

```javascript
// Streaming variant of the FIFF range reader. Asserts that
// readWindowStreaming yields chunks in monotonically increasing
// sample order, that each chunk's channels are correctly sized,
// and that the union of all chunks equals readWindow(start, n).
import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { FiffReader } from './_bootstrap.mjs';

// Reuse the synthetic builder; copy-paste from unit-fiff-range.test.mjs
// would create a maintenance hazard, so re-import it via a tiny shim.
// In production this lives in tests/_arbitraries.mjs but for v1 we
// duplicate the minimum.
function wTag(dv, off, kind, type, size, next) {
  dv.setInt32(off + 0,  kind, false);
  dv.setInt32(off + 4,  type, false);
  dv.setInt32(off + 8,  size, false);
  dv.setInt32(off + 12, next, false);
}

// Two buffers of 25 samples each (50 total), 2 channels — so streaming
// must yield 2 chunks for a 50-sample window.
function buildTwoBufferFiff() {
  const buf = new ArrayBuffer(2048);
  const dv  = new DataView(buf);
  let off = 0;
  wTag(dv, off, 100, 31, 20, 0); off += 36;
  wTag(dv, off, 101, 3, 4, 0); dv.setInt32(off + 16, 0x500, false); off += 20;
  const measStart = off; wTag(dv, off, 104, 3, 4, 0); dv.setInt32(off + 16, 101, false); off += 20;
  const nchanPos = off; wTag(dv, off, 200, 3, 4, 0); dv.setInt32(off + 16, 2, false); off += 20;
  const sfreqPos = off; wTag(dv, off, 201, 4, 4, 0); dv.setFloat32(off + 16, 100.0, false); off += 20;
  const ch1Pos = off; wTag(dv, off, 203, 1, 96, 0);
  dv.setFloat32(off + 16 + 12, 1.0, false); dv.setFloat32(off + 16 + 16, 1.0, false); off += 112;
  const ch2Pos = off; wTag(dv, off, 203, 1, 96, 0);
  dv.setFloat32(off + 16 + 12, 1.0, false); dv.setFloat32(off + 16 + 16, 1.0, false); off += 112;
  const measEnd = off; wTag(dv, off, 105, 3, 4, 0); dv.setInt32(off + 16, 101, false); off += 20;
  const rawStart = off; wTag(dv, off, 104, 3, 4, 0); dv.setInt32(off + 16, 102, false); off += 20;
  const buf1Pos = off; wTag(dv, off, 300, 4, 200, 0);  // 25 samples × 2 × 4 = 200
  for (let i = 0; i < 50; i++) dv.setFloat32(off + 16 + i * 4, i * 0.01, false);
  off += 16 + 200;
  const buf2Pos = off; wTag(dv, off, 300, 4, 200, 0);
  for (let i = 0; i < 50; i++) dv.setFloat32(off + 16 + i * 4, (50 + i) * 0.01, false);
  off += 16 + 200;
  const rawEnd = off; wTag(dv, off, 105, 3, 4, 0); dv.setInt32(off + 16, 102, false); off += 20;
  const dirOff = 0x500;
  const entries = [
    [100, 31, 20, 0],
    [101, 3, 4, 36],
    [104, 3, 4, measStart],
    [200, 3, 4, nchanPos], [201, 4, 4, sfreqPos],
    [203, 1, 96, ch1Pos], [203, 1, 96, ch2Pos],
    [105, 3, 4, measEnd],
    [104, 3, 4, rawStart],
    [300, 4, 200, buf1Pos], [300, 4, 200, buf2Pos],
    [105, 3, 4, rawEnd],
  ];
  wTag(dv, dirOff, 102, 3, entries.length * 16, -1);
  for (let i = 0; i < entries.length; i++) {
    const [k, t, s, p] = entries[i];
    const e = dirOff + 16 + i * 16;
    dv.setInt32(e + 0, k, false); dv.setInt32(e + 4, t, false);
    dv.setInt32(e + 8, s, false); dv.setInt32(e + 12, p, false);
  }
  return buf.slice(0, dirOff + 16 + entries.length * 16);
}

let mockSource;
beforeEach(() => {
  mockSource = buildTwoBufferFiff();
  globalThis.HttpRange.probeLength = async () => mockSource.byteLength;
  globalThis.HttpRange.rangeFetch  = async (_url, s, e) => mockSource.slice(s, e + 1);
});

test('fiff streaming: yields chunks in monotonic sample order', async () => {
  const reader = await FiffReader.open({ eeg_url: 'mock://2buf.fif' });
  assert.equal(typeof reader.readWindowStreaming, 'function');
  let lastEnd = -1;
  let nChunks = 0;
  for await (const chunk of reader.readWindowStreaming(0, reader.n_samples)) {
    assert.ok(chunk.firstSampleIdx >= lastEnd + 1 || lastEnd === -1);
    assert.ok(chunk.lastSampleIdx >= chunk.firstSampleIdx);
    assert.equal(chunk.channels.length, reader.n_channels);
    lastEnd = chunk.lastSampleIdx;
    nChunks++;
  }
  // 50 samples across 2 buffers → at least 2 chunks
  assert.ok(nChunks >= 2, `expected >= 2 chunks, got ${nChunks}`);
});

test('fiff streaming: union of chunks equals readWindow', async () => {
  const reader = await FiffReader.open({ eeg_url: 'mock://2buf.fif' });
  const baseline = await reader.readWindow(0, reader.n_samples);
  const collected = Array.from({ length: reader.n_channels }, () => new Float32Array(reader.n_samples));
  for await (const chunk of reader.readWindowStreaming(0, reader.n_samples)) {
    const w = chunk.lastSampleIdx - chunk.firstSampleIdx + 1;
    for (let c = 0; c < reader.n_channels; c++) {
      for (let t = 0; t < w; t++) collected[c][chunk.firstSampleIdx + t] = chunk.channels[c][t];
    }
  }
  for (let c = 0; c < reader.n_channels; c++) {
    for (let t = 0; t < reader.n_samples; t++) {
      assert.ok(Math.abs(collected[c][t] - baseline[c][t]) < 1e-6);
    }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit-fiff-streaming.test.mjs`

Expected: FAIL — `fiff: range readWindowStreaming not implemented yet`.

- [ ] **Step 3: Replace the streaming placeholder in `formats/fiff.js`**

Replace the `readWindowRangeStreaming` placeholder:

```javascript
  async function* readWindowRangeStreaming(url, nchan, cals, bufIndex, totalSamples, startReq, nReq, opts) {
    const start = Math.max(0, startReq);
    if (start >= totalSamples || nReq <= 0) return;
    const end = Math.min(start + nReq, totalSamples);
    const firstBufIdx = findBufferForSample(bufIndex, start);
    if (firstBufIdx === -1) return;

    for (let i = firstBufIdx; i < bufIndex.length; i++) {
      const b = bufIndex[i];
      const bufStartSample = b.cumStart;
      const bufEndSample   = b.cumStart + b.samplesInBuf;
      if (bufStartSample >= end) break;
      const sliceStart = Math.max(start, bufStartSample) - bufStartSample;
      const sliceEnd   = Math.min(end,   bufEndSample)   - bufStartSample;
      const nLocal = sliceEnd - sliceStart;
      if (nLocal <= 0) continue;

      const fetched = await globalThis.HttpRange.rangeFetch(
        url, b.payloadOffset, b.payloadOffset + b.payloadSize - 1, b.payloadSize, opts,
      );
      const decoded = decodeRawBufferBytes(fetched, b.miType, b.samplesInBuf * nchan);
      const channels = new Array(nchan);
      for (let c = 0; c < nchan; c++) channels[c] = new Float32Array(nLocal);
      for (let t = 0; t < nLocal; t++) {
        const src = (sliceStart + t) * nchan;
        for (let c = 0; c < nchan; c++) channels[c][t] = decoded[src + c] * cals[c];
      }
      const firstSampleIdx = bufStartSample + sliceStart;
      const lastSampleIdx  = firstSampleIdx + nLocal - 1;
      yield { firstSampleIdx, lastSampleIdx, channels };
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit-fiff-streaming.test.mjs`

Expected: PASS — both streaming tests.

- [ ] **Step 5: Run the full test suite to confirm no regression**

Run: `npm run test:unit`

Expected: PASS — no regressions in any unit test.

- [ ] **Step 6: Commit**

```bash
git add formats/fiff.js tests/unit-fiff-streaming.test.mjs
git commit -m "feat(fiff): readWindowStreaming async generator over data buffers"
```

---

### Task 5: Real-browser test for FIFF > 200 MB (evidence gate)

**Goal:** Add a Playwright spec that loads ds003682 (644 MB FIFF) and ds003694 (2 GB FIFF) in a real Chromium browser and asserts the evidence thresholds: open < 5 s, readWindow < 2 s, peak heap < 100 MB.

**Files:**
- Create: `tests/e2e/acceptance/streaming-large.spec.mjs`
- Modify: `package.json` (add `test:streaming-large` script)

- [ ] **Step 1: Locate the CDN URLs for the two FIFF datasets**

Run: `grep -E "ds003682|ds003694" /Users/bruaristimunha/Projects/eegdash-viewer/scripts/audit-100-datasets.json | head -20`

Capture the `cdn_url` value for each. These become hard-coded test inputs.

- [ ] **Step 2: Create the spec**

Create `tests/e2e/acceptance/streaming-large.spec.mjs`:

```javascript
/**
 * Acceptance: streaming-large.spec.mjs
 *
 * Evidence gate for the range-based FIFF + EEGLAB-inline readers.
 * Loads each of three real recordings > 200 MB and asserts:
 *   - api.open completes in < 5 s   (stage-caption visible)
 *   - first readWindow < 2 s         (worker performance marks)
 *   - peak JS heap < 100 MB delta    (performance.memory polling)
 *
 * Outputs: tests/evidence/streaming-large/results.jsonl — one JSON
 * line per dataset with shape:
 *   { dataset_id, format, n_bytes, open_ms, read_ms, peak_heap_mb_delta, verdict }
 *
 * Run:  npm run test:streaming-large
 * Per-test budget: 60 s (each dataset).
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'tests/evidence/streaming-large');
const RESULTS = path.join(EVIDENCE_DIR, 'results.jsonl');

const TARGETS = [
  // PASTE THE EXACT cdn_url VALUES FROM scripts/audit-100-datasets.json HERE.
  // Example shape (you must fill these from the audit JSON in Step 1):
  { id: 'ds003682', format: 'fif', cdn_url: '<paste-from-audit-json>', n_bytes: 644 * 1024 * 1024 },
  { id: 'ds003694', format: 'fif', cdn_url: '<paste-from-audit-json>', n_bytes: 2000 * 1024 * 1024 },
];

test.beforeAll(() => {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  // Truncate the JSONL so each run starts clean.
  fs.writeFileSync(RESULTS, '');
});

for (const target of TARGETS) {
  test(`${target.id} (${target.format}, ${(target.n_bytes / 1024 / 1024).toFixed(0)} MB): open < 5s, readWindow < 2s, heap < 100MB`, async ({ page }, testInfo) => {
    testInfo.setTimeout(120 * 1000);  // 2 min per dataset

    const baselineHeapPromise = page.evaluate(() =>
      // @ts-expect-error Chrome-only
      performance.memory ? performance.memory.usedJSHeapSize : 0,
    );

    const url = `/?eeg=${encodeURIComponent(target.cdn_url)}`;
    const navStart = Date.now();
    await page.goto(url);

    // Open gate: stage-caption visible.
    await expect(page.locator('#stage-caption')).toBeVisible({ timeout: 60 * 1000 });
    const openMs = Date.now() - navStart;

    // First readWindow: drive a pan and time the next traces.update.
    const readStart = Date.now();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(
      () => {
        const traces = document.querySelector('#traces');
        return traces && (/** @type {HTMLCanvasElement} */ (traces)).width > 0;
      },
      { timeout: 10 * 1000 },
    );
    const readMs = Date.now() - readStart;

    // Memory peak — poll every 100 ms for 2 s after the read.
    const baselineHeap = await baselineHeapPromise;
    const peakHeapPromise = page.evaluate(async (baseline) => {
      // @ts-expect-error Chrome-only
      if (!performance.memory) return 0;
      let peak = 0;
      for (let i = 0; i < 20; i++) {
        // @ts-expect-error Chrome-only
        const used = performance.memory.usedJSHeapSize;
        if (used > peak) peak = used;
        await new Promise(r => setTimeout(r, 100));
      }
      return peak - baseline;
    }, baselineHeap);
    const peakHeapDelta = await peakHeapPromise;
    const peakHeapMb    = peakHeapDelta / 1024 / 1024;

    const verdict =
      openMs    < 5000  &&
      readMs    < 2000  &&
      peakHeapMb < 100  ? 'PASS' : 'FAIL';

    fs.appendFileSync(RESULTS, JSON.stringify({
      dataset_id: target.id,
      format:     target.format,
      n_bytes:    target.n_bytes,
      open_ms:    openMs,
      read_ms:    readMs,
      peak_heap_mb_delta: +peakHeapMb.toFixed(1),
      verdict,
    }) + '\n');

    expect(openMs,    `${target.id}: open_ms = ${openMs}, must be < 5000`).toBeLessThan(5000);
    expect(readMs,    `${target.id}: read_ms = ${readMs}, must be < 2000`).toBeLessThan(2000);
    expect(peakHeapMb, `${target.id}: peak heap delta = ${peakHeapMb.toFixed(1)} MB, must be < 100`).toBeLessThan(100);
  });
}
```

- [ ] **Step 3: Wire up the npm script**

Edit `package.json`, add to the `scripts` block (after the existing `test:audit-reality` entries):

```json
    "test:streaming-large": "playwright test tests/e2e/acceptance/streaming-large.spec.mjs --project=chromium",
```

- [ ] **Step 4: Fill in the CDN URLs**

From the audit JSON output in Step 1, paste the actual `cdn_url` for each row into the `TARGETS` array. Run:

```bash
node -e "const j=JSON.parse(require('fs').readFileSync('scripts/audit-100-datasets.json','utf8')); console.log(j.results.filter(r => r.dataset_id==='ds003682' || r.dataset_id==='ds003694').map(r=>({id:r.dataset_id, url:r.cdn_url})))"
```

Take each `url` and paste it into the `cdn_url` field of the corresponding `TARGETS[]` entry.

- [ ] **Step 5: Run the spec**

Run: `npm run test:streaming-large`

Expected: PASS on both datasets — `open_ms < 5000`, `read_ms < 2000`, `peak_heap_mb_delta < 100`. The JSONL artifact at `tests/evidence/streaming-large/results.jsonl` contains one line per dataset.

If FAIL on heap (>100 MB): inspect Chromium DevTools heap snapshot to find the leak. Most likely culprit: forgetting to discard the meas_info wrapped buffer after `api.read(wrappedBuf)` returns.

If FAIL on read_ms (>2000): the buffer being range-fetched is probably > 1 MB. Implement the v1.5 optimisation (narrow the range to `[sliceStart * frameSize, sliceEnd * frameSize]` instead of the whole buffer payload).

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/acceptance/streaming-large.spec.mjs package.json tests/evidence/streaming-large/results.jsonl
git commit -m "test(fiff): real-browser evidence gate for >200 MB FIFF reads"
```

---

### Task 6: MAT v5 element scanner (`formats/_matv5.js`)

**Goal:** Add `api.scanElements(buf)` that walks the MAT v5 top-level element stream and returns metadata (offsets + dims + name + class) without materializing payloads. For each `miMATRIX` element, peek at the first 4 sub-elements (flags, dims, name, real-data header) so the `data` element's payload byte range is discoverable.

**Files:**
- Modify: `formats/_matv5.js` (add `api.scanElements`)
- Create: `tests/unit-matv5-scan.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/unit-matv5-scan.test.mjs`:

```javascript
// scanElements walks the top-level stream of a MAT v5 buffer and
// returns per-element headers WITHOUT decoding the (potentially
// huge) data payload. This is the metadata-only path the inline-set
// EEGLAB reader uses to find EEG.data's byte range so it can range-
// fetch slices instead of the whole file.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MatV5 } from './_bootstrap.mjs';

// Same primitives the existing matv5 tests use.
const miINT8   = 1;
const miINT32  = 5;
const miUINT32 = 6;
const miSINGLE = 7;
const miDOUBLE = 9;
const miMATRIX = 14;
const mxDOUBLE = 6;
const mxSINGLE = 7;
const mxSTRUCT = 2;

function pad8(n) { return n % 8 === 0 ? 0 : 8 - (n % 8); }

function writeLong(view, off, type, payload) {
  view.setUint32(off, type, true);
  view.setUint32(off + 4, payload.length, true);
  new Uint8Array(view.buffer, view.byteOffset + off + 8, payload.length).set(payload);
  return off + 8 + payload.length + pad8(payload.length);
}

function writeHeader(view) {
  const text = 'MATLAB 5.0 MAT-file scanElements test';
  for (let i = 0; i < text.length; i++) view.setUint8(i, text.charCodeAt(i));
  view.setUint16(124, 0x0100, true);
  view.setUint16(126, 0x4D49, true);
}

function arrayFlagsPayload(mxClass) {
  const buf = new ArrayBuffer(8);
  const v = new DataView(buf);
  v.setUint32(0, mxClass, true);
  v.setUint32(4, 0, true);
  return new Uint8Array(buf);
}

function int32Payload(values) { return new Uint8Array(new Int32Array(values).buffer); }
function singlesPayload(values) { return new Uint8Array(new Float32Array(values).buffer); }
function doublesPayload(values) { return new Uint8Array(new Float64Array(values).buffer); }

function asciiPayload(s) {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

// Build a matrix payload: [flags, dims, name, realData].
function makeMatrixPayload(mxClass, dims, name, realDataMiType, realDataPayload) {
  const flagsBytes = arrayFlagsPayload(mxClass);
  const dimsBytes  = int32Payload(dims);
  const nameBytes  = asciiPayload(name);
  // Each sub-element is a tag (8) + padded payload.
  const subSize = (type, payload) => 8 + payload.length + pad8(payload.length);
  const totalSubBytes =
    subSize(miUINT32, flagsBytes) +
    subSize(miINT32,  dimsBytes)  +
    subSize(miINT8,   nameBytes)  +
    subSize(realDataMiType, realDataPayload);
  const out = new Uint8Array(totalSubBytes);
  const v = new DataView(out.buffer);
  let off = 0;
  off = writeLong(v, off, miUINT32, flagsBytes);
  off = writeLong(v, off, miINT32,  dimsBytes);
  off = writeLong(v, off, miINT8,   nameBytes);
  off = writeLong(v, off, realDataMiType, realDataPayload);
  return out;
}

test('matv5 scan: returns metadata for every top-level matrix', async () => {
  // Build a buffer with 3 matrices: srate (scalar double), nbchan (scalar double),
  // data (2×4 single = 8 floats).
  const srateBytes  = makeMatrixPayload(mxDOUBLE, [1, 1],          'srate',  miDOUBLE, doublesPayload([100]));
  const nbchanBytes = makeMatrixPayload(mxDOUBLE, [1, 1],          'nbchan', miDOUBLE, doublesPayload([2]));
  const dataBytes   = makeMatrixPayload(mxSINGLE, [2, 4],          'data',   miSINGLE, singlesPayload([1,2,3,4,5,6,7,8]));
  const totalMat = srateBytes.length + nbchanBytes.length + dataBytes.length + 3 * 16;
  const buf = new ArrayBuffer(128 + totalMat);
  const v   = new DataView(buf);
  writeHeader(v);
  let off = 128;
  off = writeLong(v, off, miMATRIX, srateBytes);
  off = writeLong(v, off, miMATRIX, nbchanBytes);
  off = writeLong(v, off, miMATRIX, dataBytes);

  const scan = MatV5.scanElements(buf);
  assert.equal(scan.length, 3, 'three top-level elements');

  const byName = Object.fromEntries(scan.map(e => [e.name, e]));
  assert.ok(byName.srate,  'srate element found');
  assert.ok(byName.nbchan, 'nbchan element found');
  assert.ok(byName.data,   'data element found');

  assert.deepEqual(byName.data.dims, [2, 4]);
  assert.equal(byName.data.mxClass, mxSINGLE);
  assert.equal(byName.data.dataSubMiType, miSINGLE);
  assert.equal(byName.data.dataSubBytes, 32);  // 8 floats × 4
  // The data sub-element payload must be at a specific absolute offset
  // within `buf`. Verify by reading those bytes back and getting the
  // same values as the input.
  const f32 = new Float32Array(buf, byName.data.dataSubOffset, byName.data.dataSubBytes / 4);
  assert.equal(f32[0], 1);
  assert.equal(f32[7], 8);
});

test('matv5 scan: rejects v7.3 files with a clear error', () => {
  const buf = new ArrayBuffer(128);
  const v = new DataView(buf);
  writeHeader(v);
  v.setUint16(124, 0x0200, true);
  assert.throws(() => MatV5.scanElements(buf), /v7\.3|HDF5/);
});

test('matv5 scan: rejects buffers shorter than 128 B', () => {
  assert.throws(() => MatV5.scanElements(new ArrayBuffer(64)), /too short/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit-matv5-scan.test.mjs`

Expected: FAIL — `MatV5.scanElements is not a function`.

- [ ] **Step 3: Implement `api.scanElements` in `formats/_matv5.js`**

Append to `formats/_matv5.js`, right before the final `if (typeof module ...` exports block:

```javascript
  // Scan top-level MAT v5 elements WITHOUT materializing payloads.
  // For each miMATRIX element, peek at the first 4 sub-elements
  // (flags, dims, name, real-data tag) so callers know where the
  // real-data bytes live without reading them. This enables the
  // streaming inline-EEGLAB path: scan the first ~16 MB to find
  // EEG.data's payload offset, then range-fetch column slices on
  // demand.
  //
  // For miCOMPRESSED elements we surface the compressed envelope
  // metadata but DO NOT decompress; callers fall back to the full
  // parse() path when any compressed element is encountered.
  //
  // Returns an array of:
  //   {
  //     miType,                 // 14 (miMATRIX), 15 (miCOMPRESSED), or rare other
  //     elementOffset,          // absolute byte offset of element header
  //     payloadOffset,          // absolute byte offset of element payload
  //     payloadBytes,           // payload length before padding
  //     mxClass | null,
  //     dims    | null,         // number[]
  //     name    | null,         // string
  //     dataSubOffset  | null,  // absolute byte offset of real-data payload
  //     dataSubBytes   | null,
  //     dataSubMiType  | null,
  //   }
  api.scanElements = function (buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (u8.length < 128) {
      throw new Error(`scanElements: MAT file too short for header: ${u8.length}B`);
    }
    const header = new DataView(u8.buffer, u8.byteOffset, 128);
    const version = header.getUint16(124, true);
    if (version === 0x0200) {
      throw new Error('scanElements: MAT v7.3 (HDF5) — call Mat73.parse, not scanElements');
    }
    if (version !== 0x0100) {
      throw new Error(`scanElements: unsupported MAT version 0x${version.toString(16)}`);
    }

    const baseOff = u8.byteOffset;
    const fullView = new DataView(u8.buffer, baseOff, u8.length);
    const results = [];

    for (const elem of iterElements(fullView, 128, u8.length)) {
      const absElementOffset = baseOff + (elem.payloadOffset - 4 - (elem.payload.length <= 4 ? 0 : 4));
      // ^ "elementOffset" reconstruction: payloadOffset is either off+4
      //   (small format) or off+8 (long format). We can't easily tell
      //   which without re-reading the tag, so do that:
      const tagWord = fullView.getUint32(elem.payloadOffset - 4, true);
      const small = ((tagWord >>> 16) & 0xffff) > 0 && ((tagWord >>> 16) & 0xffff) <= 4;
      const elementOffset = small ? (elem.payloadOffset - 4) : (elem.payloadOffset - 8);

      const meta = {
        miType:         elem.miType,
        elementOffset,
        payloadOffset:  baseOff + elem.payloadOffset,
        payloadBytes:   elem.payload.length,
        mxClass:        null,
        dims:           null,
        name:           null,
        dataSubOffset:  null,
        dataSubBytes:   null,
        dataSubMiType:  null,
      };

      if (elem.miType === 14) {
        // Peek at sub-elements 0..3 (flags, dims, name, realData).
        const subView = new DataView(elem.payload.buffer, elem.payload.byteOffset, elem.payload.length);
        const subs = [];
        try {
          for (const s of iterElements(subView, 0, elem.payload.length)) {
            subs.push(s);
            if (subs.length === 4) break;
          }
        } catch {
          // Sub-element walk failed → leave fields null; caller will
          // see {miType:14, mxClass:null} and treat as opaque.
        }
        if (subs.length >= 1 && subs[0].miType === 6) {
          // Read mxClass from low byte of first uint32.
          const word0 = new DataView(subs[0].payload.buffer, subs[0].payload.byteOffset, subs[0].payload.length).getUint32(0, true);
          meta.mxClass = word0 & 0xff;
        }
        if (subs.length >= 2 && subs[1].miType === 5) {
          meta.dims = Array.from(new Int32Array(subs[1].payload.buffer, subs[1].payload.byteOffset, subs[1].payload.length / 4));
        }
        if (subs.length >= 3 && (subs[2].miType === 1 || subs[2].miType === 2)) {
          meta.name = new TextDecoder('ascii').decode(subs[2].payload).replace(/\0+$/, '');
        }
        if (subs.length >= 4) {
          // The real-data sub-element header sits at subs[3].payloadOffset - 8
          // (long format) or - 4 (small format) inside elem.payload.
          // The absolute file offset of the real-data payload is:
          //   baseOff + elem.payloadOffset + subs[3].payloadOffset
          meta.dataSubOffset  = baseOff + elem.payloadOffset + subs[3].payloadOffset;
          meta.dataSubBytes   = subs[3].payload.length;
          meta.dataSubMiType  = subs[3].miType;
        }
      }
      results.push(meta);
    }
    return results;
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit-matv5-scan.test.mjs`

Expected: PASS — all 3 tests.

- [ ] **Step 5: Run the existing MAT v5 tests to confirm no regression**

Run: `node --test tests/unit-matv5.test.mjs tests/unit-eeglab-inline.test.mjs tests/unit-eeglab.test.mjs`

Expected: PASS — no regressions.

- [ ] **Step 6: Commit**

```bash
git add formats/_matv5.js tests/unit-matv5-scan.test.mjs
git commit -m "feat(matv5): add scanElements for metadata-only top-level walk"
```

---

### Task 7: EEGLAB inline streaming open + readWindow (`formats/eeglab.js`)

**Goal:** Refactor `openInlineSet` to range-fetch only the first 16 MB (probably enough for header + chanlocs + start of data), scan elements, and serve `readWindow` by range-fetching `data`'s column slices instead of the whole file.

**Files:**
- Modify: `formats/eeglab.js` (`openInlineSet` function, lines 203-318)
- Create: `tests/unit-eeglab-inline-range.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/unit-eeglab-inline-range.test.mjs`:

```javascript
// Range-based inline EEGLAB .set test. Builds a synthetic MAT v5
// payload representing an EEG struct with nbchan=2 + srate=100 +
// data=[2, 25] (50 floats), serves it via a tracked rangeFetch mock,
// and asserts that:
//   1. openInlineSet fetches MUCH less than the whole file when the
//      file is large enough to exceed the metadata-budget window.
//   2. readWindow only fetches the column slice — not the full data.
import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { EEGLABReader, HttpRange } from './_bootstrap.mjs';

// Reuse the matv5 helpers from unit-matv5-scan in inline form.
const miINT8   = 1;
const miINT32  = 5;
const miUINT32 = 6;
const miSINGLE = 7;
const miDOUBLE = 9;
const miMATRIX = 14;
const mxSINGLE = 7;
const mxDOUBLE = 6;
const pad8 = (n) => n % 8 === 0 ? 0 : 8 - (n % 8);

function writeLong(view, off, type, payload) {
  view.setUint32(off, type, true);
  view.setUint32(off + 4, payload.length, true);
  new Uint8Array(view.buffer, view.byteOffset + off + 8, payload.length).set(payload);
  return off + 8 + payload.length + pad8(payload.length);
}
function writeHeader(view) {
  const text = 'MATLAB 5.0 MAT-file inline-range test';
  for (let i = 0; i < text.length; i++) view.setUint8(i, text.charCodeAt(i));
  view.setUint16(124, 0x0100, true);
  view.setUint16(126, 0x4D49, true);
}
function arrayFlags(mxClass) {
  const b = new ArrayBuffer(8); const v = new DataView(b);
  v.setUint32(0, mxClass, true); v.setUint32(4, 0, true);
  return new Uint8Array(b);
}
function i32(values) { return new Uint8Array(new Int32Array(values).buffer); }
function f32(values) { return new Uint8Array(new Float32Array(values).buffer); }
function f64(values) { return new Uint8Array(new Float64Array(values).buffer); }
function ascii(s) { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }

function makeMatrix(mxClass, dims, name, realDataMiType, realDataPayload) {
  const sub = (t, p) => 8 + p.length + pad8(p.length);
  const total = sub(miUINT32, arrayFlags(mxClass)) + sub(miINT32, i32(dims)) + sub(miINT8, ascii(name)) + sub(realDataMiType, realDataPayload);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  let o = 0;
  o = writeLong(v, o, miUINT32, arrayFlags(mxClass));
  o = writeLong(v, o, miINT32,  i32(dims));
  o = writeLong(v, o, miINT8,   ascii(name));
  o = writeLong(v, o, realDataMiType, realDataPayload);
  return out;
}

function buildInlineSet() {
  // Generate 25 samples × 2 channels of synthetic data in column-major
  // order (data[chan, sample] @ sample*nchan + chan).
  const dataVals = new Float32Array(25 * 2);
  for (let s = 0; s < 25; s++) for (let c = 0; c < 2; c++) dataVals[s * 2 + c] = s * 0.1 + c * 0.01;
  const sMat   = makeMatrix(mxDOUBLE, [1, 1],  'srate',  miDOUBLE, f64([100]));
  const nMat   = makeMatrix(mxDOUBLE, [1, 1],  'nbchan', miDOUBLE, f64([2]));
  const pMat   = makeMatrix(mxDOUBLE, [1, 1],  'pnts',   miDOUBLE, f64([25]));
  const tMat   = makeMatrix(mxDOUBLE, [1, 1],  'trials', miDOUBLE, f64([1]));
  const dataMat = makeMatrix(mxSINGLE, [2, 25], 'data',  miSINGLE, new Uint8Array(dataVals.buffer));
  const matrices = [sMat, nMat, pMat, tMat, dataMat];
  const total = 128 + matrices.reduce((acc, m) => acc + 8 + m.length + pad8(m.length), 0);
  const buf = new ArrayBuffer(total);
  const v = new DataView(buf);
  writeHeader(v);
  let off = 128;
  for (const m of matrices) off = writeLong(v, off, miMATRIX, m);
  return buf;
}

let mockSource;
let rangeRequestLog;
beforeEach(() => {
  mockSource = buildInlineSet();
  rangeRequestLog = [];
  globalThis.HttpRange.probeLength = async () => mockSource.byteLength;
  globalThis.HttpRange.rangeFetch  = async (_url, s, e) => {
    rangeRequestLog.push({ start: s, end: e });
    return mockSource.slice(s, e + 1);
  };
});

test('eeglab inline range: openInlineSet exposes n_channels, sampling_frequency, n_samples', async () => {
  const reader = await EEGLABReader.open({ eeg_url: 'mock://inline.set' });
  assert.equal(reader.n_channels, 2);
  assert.equal(reader.sampling_frequency, 100);
  assert.equal(reader.n_samples, 25);
});

test('eeglab inline range: readWindow returns correct column slice', async () => {
  const reader = await EEGLABReader.open({ eeg_url: 'mock://inline.set' });
  const win = await reader.readWindow(0, 5);
  assert.equal(win.length, 2);
  for (let c = 0; c < 2; c++) {
    for (let s = 0; s < 5; s++) {
      assert.ok(Math.abs(win[c][s] - (s * 0.1 + c * 0.01)) < 1e-5);
    }
  }
});

test('eeglab inline range: readWindow only fetches the slice bytes', async () => {
  const reader = await EEGLABReader.open({ eeg_url: 'mock://inline.set' });
  rangeRequestLog.length = 0;
  await reader.readWindow(0, 5);
  const fetched = rangeRequestLog.reduce((a, r) => a + (r.end - r.start + 1), 0);
  // 5 samples × 2 chans × 4 bytes = 40 bytes (allow small overhead).
  assert.ok(fetched <= 100, `readWindow fetched ${fetched}B for 40B slice`);
});

test('eeglab inline range: openInlineSet handles files larger than the metadata budget by scanning the head', async () => {
  // Verify by probing: if probeLength reports 100 MB but the actual
  // buffer is 1 KB, open should still succeed because all metadata
  // is in the first 16 MB.
  const real = mockSource;
  globalThis.HttpRange.probeLength = async () => 100 * 1024 * 1024;
  globalThis.HttpRange.rangeFetch  = async (_url, s, e) => {
    // Only allow reads inside the first real.byteLength bytes.
    if (s >= real.byteLength) {
      throw new Error(`unexpected range fetch [${s}..${e}] past real source end ${real.byteLength}`);
    }
    return real.slice(s, Math.min(e + 1, real.byteLength));
  };
  const reader = await EEGLABReader.open({ eeg_url: 'mock://inline-large.set' });
  assert.equal(reader.n_channels, 2);
  assert.equal(reader.n_samples, 25);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit-eeglab-inline-range.test.mjs`

Expected: FAIL — the current `openInlineSet` calls `rangeFetch(url, 0, totalBytes-1, totalBytes)` (whole file) and there's no slice-only readWindow.

- [ ] **Step 3: Refactor `openInlineSet` in `formats/eeglab.js`**

Replace the entire `openInlineSet` function (lines 203-318) with a range-based path. Keep `sliceColumnMajor` available — we reuse the same math.

Edit `formats/eeglab.js`:

```javascript
  // Inline-data .set: the EEG signal lives inside the MAT file
  // itself (no sibling .fdt). Range-based path: range-fetch the
  // first ~16 MB for metadata (header + small struct fields +
  // start of `data`), use MatV5.scanElements to find `data`'s
  // payload offset, and serve readWindow by range-fetching the
  // column slice on demand.
  //
  // Compressed .set files (miCOMPRESSED top-level elements) fall
  // back to the legacy full-file parse path — uncompressing zlib
  // blobs requires the whole stream, defeating range-fetch.
  //
  // The whole-file fallback path is preserved for v7.3 (HDF5) which
  // goes through Mat73.parse.
  const INLINE_METADATA_BUDGET_BYTES = 16 * 1024 * 1024;  // 16 MB head probe
  const INLINE_LEGACY_FALLBACK_CAP   = 200 * 1024 * 1024;  // 200 MB cap if we can't stream

  async function openInlineSet(meta, nChannelsFromSidecar, fsFromSidecar) {
    const setUrl = meta.eeg_url;
    const totalBytes = await HttpRange.probeLength(setUrl);

    // Range-fetch the head probe. For files smaller than the budget,
    // this IS the whole file — same as before. For huge files, this is
    // the first 16 MB.
    const probeBytes = Math.min(totalBytes, INLINE_METADATA_BUDGET_BYTES);
    const probeBuf   = await HttpRange.rangeFetch(setUrl, 0, probeBytes - 1, probeBytes);

    // Detect MAT version. v7.3 (HDF5) is NOT range-streamable in v1 —
    // jsfive needs the whole file. Fall back to the legacy whole-file
    // path, with the 200 MB cap kept as a safety net.
    const matVersion = MatV5.detectMatVersion(probeBuf);
    if (matVersion === 'v7.3') {
      if (totalBytes > INLINE_LEGACY_FALLBACK_CAP) {
        throw new Error(
          `EEGLAB inline v7.3 .set is ${(totalBytes / 1024 / 1024).toFixed(0)} MB ` +
          `(exceeds ${INLINE_LEGACY_FALLBACK_CAP / 1024 / 1024} MB v7.3 cap). ` +
          `Streaming v7.3 is not supported in v1.`,
        );
      }
      const whole = await HttpRange.rangeFetch(setUrl, 0, totalBytes - 1, totalBytes);
      let vars;
      try {
        vars = await Mat73.parse(whole);
      } catch (e) {
        throw new Error(`EEGLAB inline .set (v7.3) parse failed at ${setUrl}: ${e.message}`);
      }
      return buildInlineReaderFromVars(setUrl, meta, vars, nChannelsFromSidecar, fsFromSidecar);
    }

    // v5 path: scan the probe buffer for top-level elements.
    let elements;
    try {
      elements = MatV5.scanElements(probeBuf);
    } catch (e) {
      throw new Error(`EEGLAB inline .set scan failed at ${setUrl}: ${e.message}`);
    }

    // If any compressed element is present, fall back to whole-file parse.
    const hasCompressed = elements.some(el => el.miType === 15);
    if (hasCompressed) {
      if (totalBytes > INLINE_LEGACY_FALLBACK_CAP) {
        throw new Error(
          `EEGLAB inline .set is compressed and ${(totalBytes / 1024 / 1024).toFixed(0)} MB ` +
          `(exceeds ${INLINE_LEGACY_FALLBACK_CAP / 1024 / 1024} MB legacy cap).`,
        );
      }
      const whole = await HttpRange.rangeFetch(setUrl, 0, totalBytes - 1, totalBytes);
      const vars  = await MatV5.parse(whole);
      return buildInlineReaderFromVars(setUrl, meta, vars, nChannelsFromSidecar, fsFromSidecar);
    }

    // Identify the data element. EEGLAB writes either a single struct
    // named "EEG" wrapping data/srate/nbchan/etc., or top-level
    // variables with those names. For v1 we support the top-level
    // variant directly via scanElements; the struct-wrapped variant
    // falls back to full-file parse (most modern exports use the
    // top-level form, but ds002578 / ds002718 specifically need
    // re-checking — see Task 9 for the real-browser confirmation).
    const dataElem = elements.find(el => el.name === 'data' && el.dataSubOffset != null);
    if (!dataElem) {
      // Probably an EEG-wrapped struct, or the head probe didn't reach
      // far enough. Either way, fall back to whole-file parse.
      if (totalBytes > INLINE_LEGACY_FALLBACK_CAP) {
        throw new Error(
          `EEGLAB inline .set: top-level 'data' not found in first ${probeBytes}B ` +
          `(file is ${(totalBytes / 1024 / 1024).toFixed(0)} MB, exceeds legacy cap). ` +
          `Re-export as top-level (non-struct-wrapped) inline .set or split .set+.fdt.`,
        );
      }
      const whole = await HttpRange.rangeFetch(setUrl, 0, totalBytes - 1, totalBytes);
      const vars  = await MatV5.parse(whole);
      return buildInlineReaderFromVars(setUrl, meta, vars, nChannelsFromSidecar, fsFromSidecar);
    }

    // Pull the small metadata fields from the scanned elements. They
    // are typed-array elements with class double / single. Read the
    // scalar value from the first dataSubBytes worth of payload.
    function readScalar(name) {
      const el = elements.find(x => x.name === name && x.dataSubOffset != null);
      if (!el) return null;
      // Re-fetch the few bytes of the scalar payload from the probe
      // (we already have it in probeBuf — index into it directly).
      const localOff = el.dataSubOffset;  // absolute; equal to local since probeBuf starts at 0
      if (localOff < 0 || localOff + el.dataSubBytes > probeBuf.byteLength) return null;
      const dv = new DataView(probeBuf, localOff, el.dataSubBytes);
      if (el.dataSubMiType === 9) return dv.getFloat64(0, true);  // miDOUBLE
      if (el.dataSubMiType === 7) return dv.getFloat32(0, true);  // miSINGLE
      if (el.dataSubMiType === 5) return dv.getInt32(0, true);    // miINT32
      return null;
    }

    const srate  = readScalar('srate');
    const nbchan = readScalar('nbchan') ?? dataElem.dims[0];
    const pnts   = readScalar('pnts')   ?? dataElem.dims[1];
    const trials = readScalar('trials') ?? (dataElem.dims[2] || 1);
    if (!srate || !isFinite(srate) || srate <= 0) {
      throw new Error(`EEG.srate missing or invalid (got ${srate})`);
    }
    if (nChannelsFromSidecar != null && nbchan !== nChannelsFromSidecar) {
      console.warn(`EEGLAB inline .set: nbchan=${nbchan} disagrees with _channels.tsv (${nChannelsFromSidecar}); trusting the .set.`);
    }
    if (fsFromSidecar != null && Math.abs(srate - fsFromSidecar) > 0.5) {
      console.warn(`EEGLAB inline .set: srate=${srate} Hz disagrees with _eeg.json (${fsFromSidecar} Hz); trusting the .set.`);
    }

    const nSamples = pnts * trials;
    const expectedDataBytes = nbchan * nSamples * 4;  // float32 column-major
    if (dataElem.dataSubMiType !== 7) {
      // Non-float32 data element — for v1 we don't range-stream
      // int16/double/etc; fall back to whole-file parse (still capped).
      if (totalBytes > INLINE_LEGACY_FALLBACK_CAP) {
        throw new Error(
          `EEGLAB inline .set: data is non-float32 (miType=${dataElem.dataSubMiType}) ` +
          `and file is ${(totalBytes / 1024 / 1024).toFixed(0)} MB — exceeds ${INLINE_LEGACY_FALLBACK_CAP / 1024 / 1024} MB legacy cap.`,
        );
      }
      const whole = await HttpRange.rangeFetch(setUrl, 0, totalBytes - 1, totalBytes);
      const vars  = await MatV5.parse(whole);
      return buildInlineReaderFromVars(setUrl, meta, vars, nChannelsFromSidecar, fsFromSidecar);
    }
    if (dataElem.dataSubBytes !== expectedDataBytes) {
      throw new Error(
        `EEGLAB inline .set: data byte count ${dataElem.dataSubBytes} != ` +
        `nbchan(${nbchan}) × pnts(${pnts}) × trials(${trials}) × 4 = ${expectedDataBytes}`,
      );
    }

    const duration_s = nSamples / srate;
    const trialsHint = trials > 1 ? trials : null;
    if (trialsHint) {
      console.warn(`EEGLAB inline .set is epoched (${trialsHint} trials); v1 flattens to continuous.`);
    }
    const fallbackLabels = Array.from({ length: nbchan }, (_, i) => `Ch${i + 1}`);
    const channelLabels  = meta.channels && meta.channels.length === nbchan
      ? meta.channels.map(c => c.name)
      : fallbackLabels;

    const dataAbsOffset = dataElem.dataSubOffset;

    return {
      n_channels:         nbchan,
      n_samples:          nSamples,
      sampling_frequency: srate,
      duration_s,
      bytes_per_sample:   4,
      trials_hint:        trialsHint,
      url:                setUrl,
      channel_labels:     channelLabels,
      bids_channels:      meta.channels || null,
      streaming:          true,
      async readWindow(startSample, nSamplesWindow, opts) {
        const start = Math.max(0, startSample);
        if (start >= nSamples || nSamplesWindow <= 0) {
          return ChannelBuffers.empty(nbchan);
        }
        const end = Math.min(start + nSamplesWindow, nSamples);
        const nWin = end - start;
        const byteStart = dataAbsOffset + start * nbchan * 4;
        const byteEnd   = dataAbsOffset + end   * nbchan * 4 - 1;
        const buf = await HttpRange.rangeFetch(setUrl, byteStart, byteEnd, nWin * nbchan * 4, opts);
        const flat = new Float32Array(buf);
        // Column-major slice: same math as sliceColumnMajor but the
        // input is already the slice (so startSample=0 within `flat`).
        const out = ChannelBuffers.alloc(nbchan, nWin);
        for (let s = 0; s < nWin; s++) {
          const base = s * nbchan;
          for (let c = 0; c < nbchan; c++) out[c][s] = flat[base + c];
        }
        return out;
      },
    };
  }

  // Helper that turns a fully-parsed `vars` Map into the legacy
  // whole-file inline reader. Identical to the pre-refactor return
  // object — extracted so the v7.3 / compressed / non-float32
  // fallbacks share the same reader shape.
  function buildInlineReaderFromVars(setUrl, meta, vars, nChannelsFromSidecar, fsFromSidecar) {
    const eeg = MatV5.extractEegInline(vars);
    const nbchan = eeg.nbchan;
    if (nChannelsFromSidecar != null && nbchan !== nChannelsFromSidecar) {
      console.warn(`EEGLAB inline .set: nbchan=${nbchan} disagrees with _channels.tsv (${nChannelsFromSidecar}); trusting the .set.`);
    }
    if (fsFromSidecar != null && Math.abs(eeg.srate - fsFromSidecar) > 0.5) {
      console.warn(`EEGLAB inline .set: srate=${eeg.srate} Hz disagrees with _eeg.json (${fsFromSidecar} Hz); trusting the .set.`);
    }
    const fs = eeg.srate;
    const data32 = eeg.dataClass === 'single' ? eeg.data : Float32Array.from(eeg.data);
    const nSamples = eeg.pnts * eeg.trials;
    const expectedLen = nbchan * nSamples;
    if (data32.length !== expectedLen) {
      throw new Error(
        `EEGLAB inline .set: data length ${data32.length} != nbchan(${nbchan}) × pnts(${eeg.pnts}) × trials(${eeg.trials})`,
      );
    }
    const trialsHint = eeg.trials > 1 ? eeg.trials : null;
    const duration_s = nSamples / fs;
    const fallbackLabels = Array.from({ length: nbchan }, (_, i) => `Ch${i + 1}`);
    const channelLabels = meta.channels && meta.channels.length === nbchan
      ? meta.channels.map(c => c.name)
      : fallbackLabels;
    return {
      n_channels: nbchan,
      n_samples: nSamples,
      sampling_frequency: fs,
      duration_s,
      bytes_per_sample: 4,
      trials_hint: trialsHint,
      url: setUrl,
      channel_labels: channelLabels,
      bids_channels: meta.channels || null,
      streaming: false,
      readWindow: async (startSample, nSamplesWindow) => {
        const start = Math.max(0, startSample);
        if (start >= nSamples || nSamplesWindow <= 0) return ChannelBuffers.empty(nbchan);
        const end = Math.min(start + nSamplesWindow, nSamples);
        return sliceColumnMajor(data32, nbchan, start, end - start);
      },
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit-eeglab-inline-range.test.mjs`

Expected: PASS — all 4 tests.

- [ ] **Step 5: Run existing EEGLAB tests to confirm no regression**

Run: `node --test tests/unit-eeglab.test.mjs tests/unit-eeglab-inline.test.mjs tests/unit-eeglab-mat73.test.mjs tests/unit-eeglab-readwindow.test.mjs tests/unit-eeglab-standalone.test.mjs`

Expected: PASS — the test fixtures are small enough that they go through the head-probe scan, which succeeds with the same outputs as the legacy whole-file parse.

- [ ] **Step 6: Commit**

```bash
git add formats/eeglab.js tests/unit-eeglab-inline-range.test.mjs
git commit -m "feat(eeglab): range-based inline .set via MatV5.scanElements"
```

---

### Task 8: Remove the 200 MB inline cap

**Goal:** The 200 MB cap in the original `openInlineSet` was a panic-stop for the whole-file path. The new code already enforces a 200 MB cap on the v7.3 / compressed / struct-wrapped fallbacks (`INLINE_LEGACY_FALLBACK_CAP`); the v5 top-level streaming path needs no cap at all because it only fetches what it needs. Verify nothing references the old cap and remove dead code.

**Files:**
- Modify: `formats/eeglab.js` (confirm the original cap is gone)
- Modify: `tests/unit-eeglab-inline-range.test.mjs` (add cap-removal test)

- [ ] **Step 1: Confirm the old cap is gone**

Run: `grep -n "INLINE_MAX_BYTES\|inline cap\|200 \\* 1024 \\* 1024" /Users/bruaristimunha/Projects/eegdash-viewer/formats/eeglab.js`

Expected: only the `INLINE_LEGACY_FALLBACK_CAP` constant (which is intentional — it guards the v7.3 / compressed fallbacks). No references to the old `INLINE_MAX_BYTES` name.

If references remain, delete them.

- [ ] **Step 2: Add a test that confirms a > 200 MB top-level v5 file opens successfully**

Append to `tests/unit-eeglab-inline-range.test.mjs`:

```javascript
test('eeglab inline range: opens a synth file that REPORTS > 200 MB', async () => {
  // probeLength fakes a 500 MB file; rangeFetch serves the small real
  // buffer for any read inside [0, real.byteLength) and would explode
  // for any read past it. If openInlineSet ever range-fetches the
  // whole file, this test fails.
  const real = mockSource;
  globalThis.HttpRange.probeLength = async () => 500 * 1024 * 1024;
  globalThis.HttpRange.rangeFetch  = async (_url, s, e) => {
    if (s >= real.byteLength || e >= real.byteLength) {
      throw new Error(`unexpected fetch [${s}..${e}] past real end ${real.byteLength}`);
    }
    return real.slice(s, e + 1);
  };
  const reader = await EEGLABReader.open({ eeg_url: 'mock://big-inline.set' });
  assert.equal(reader.n_samples, 25);
  // The reader must be marked streaming = true.
  assert.equal(reader.streaming, true);
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `node --test tests/unit-eeglab-inline-range.test.mjs`

Expected: PASS — all 5 tests including the new "REPORTS > 200 MB" case.

- [ ] **Step 4: Commit**

```bash
git add formats/eeglab.js tests/unit-eeglab-inline-range.test.mjs
git commit -m "feat(eeglab): remove 200 MB inline cap for streaming v5 path"
```

---

### Task 9: Real-browser test for EEGLAB > 200 MB (evidence gate)

**Goal:** Extend the streaming-large spec from Task 5 with ds002578 (695 MB inline EEGLAB) and ds002718 (224 MB inline EEGLAB). Same evidence thresholds.

**Files:**
- Modify: `tests/e2e/acceptance/streaming-large.spec.mjs` (add EEGLAB targets)

- [ ] **Step 1: Look up the CDN URLs**

Run:

```bash
node -e "const j=JSON.parse(require('fs').readFileSync('scripts/audit-100-datasets.json','utf8')); console.log(j.results.filter(r => r.dataset_id==='ds002578' || r.dataset_id==='ds002718').map(r=>({id:r.dataset_id, url:r.cdn_url})))"
```

- [ ] **Step 2: Add the targets**

Edit `tests/e2e/acceptance/streaming-large.spec.mjs`, append to the `TARGETS` array:

```javascript
  { id: 'ds002578', format: 'set', cdn_url: '<paste-from-audit-json>', n_bytes: 695 * 1024 * 1024 },
  { id: 'ds002718', format: 'set', cdn_url: '<paste-from-audit-json>', n_bytes: 224 * 1024 * 1024 },
```

- [ ] **Step 3: Run the spec**

Run: `npm run test:streaming-large`

Expected: PASS on all 4 datasets (2 FIFF from Task 5 + 2 EEGLAB). The JSONL now has 4 lines.

If FAIL on ds002578: it may be an EEG-struct-wrapped inline .set (the synthetic test only covers the top-level variant). Inspect the failure by:

```bash
# Probe whether the file is struct-wrapped:
node -e "
import('./formats/_matv5.js').then(async () => {
  const u = '<ds002578 cdn_url>';
  // ... probe + scan first 1 MB, inspect element names ...
});
"
```

If it's struct-wrapped, expand the scan path: walk `EEG`'s struct sub-elements (which scanElements already partially supports via the sub-element peek — the change is to look INSIDE the matrix payload when `mxClass === 2`). Document the result in the spec output.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/acceptance/streaming-large.spec.mjs tests/evidence/streaming-large/results.jsonl
git commit -m "test(eeglab): real-browser evidence for >200 MB inline .set reads"
```

---

### Task 10: Bench coverage for FIFF + inline EEGLAB

**Goal:** Add the new streaming reader paths to `bench/readwindow.bench.mjs` so the regression gate covers them. Pick mid-size fixtures (not the multi-GB ones — the bench should run in < 60 s total).

**Files:**
- Modify: `bench/readwindow.bench.mjs` (add two `FIXTURES` entries)

- [ ] **Step 1: Identify mid-size FIFF + inline EEGLAB fixtures**

A mid-size FIFF is ds003392 (already PASSing per the audit, small-ish — see audit doc) — confirm via:

```bash
node -e "const j=JSON.parse(require('fs').readFileSync('scripts/audit-100-datasets.json','utf8')); const r = j.results.find(x => x.dataset_id==='ds003392'); console.log(r);"
```

A mid-size inline EEGLAB is ds003478 (already PASSing). Confirm:

```bash
node -e "const j=JSON.parse(require('fs').readFileSync('scripts/audit-100-datasets.json','utf8')); const r = j.results.find(x => x.dataset_id==='ds003478'); console.log(r);"
```

- [ ] **Step 2: Add the fixtures**

Edit `bench/readwindow.bench.mjs`, after the existing 3 fixtures, before the `];` that closes the `FIXTURES` array, add:

```javascript
  {
    label: 'FIFF (ds003392 — range-streaming, mid-size)',
    key:   'readwindow_fiff_range',
    note:  'Range-based FIFF reader (Task 1-4) over a mid-size MEG recording',
    async build() {
      const url = BIDSRecording.buildOpenNeuroEegUrl({
        dataset: 'ds003392', sub: '01', task: 'rest', run: '01', ext: 'fif',
      });
      const meta   = await BIDSRecording.loadRecordingMetadata(url);
      // FiffReader is loaded by the side-effect require chain.
      require(path.join(__dirname, '..', 'formats', '_fiff-dir.js'));
      require(path.join(__dirname, '..', 'formats', 'fiff.js'));
      const reader = await globalThis.FiffReader.open(meta);
      return { reader, fs: reader.sampling_frequency, n_samples: reader.n_samples };
    },
  },
  {
    label: 'EEGLAB inline .set (ds003478 — range-streaming, mid-size)',
    key:   'readwindow_eeglab_inline_range',
    note:  'Range-based inline EEGLAB reader (Task 6-8) — no .fdt sibling',
    async build() {
      const url = BIDSRecording.buildOpenNeuroEegUrl({
        dataset: 'ds003478', sub: '01', task: 'rest', ext: 'set',
      });
      const meta   = await BIDSRecording.loadRecordingMetadata(url);
      const reader = await EEGLABReader.open(meta);
      return { reader, fs: reader.sampling_frequency, n_samples: reader.n_samples };
    },
  },
```

NOTE: the exact `sub`/`task`/`run` values must match what the dataset publishes. If `buildOpenNeuroEegUrl` 404s, query the BIDS layout:

```bash
node -e "
import('./scripts/_smoke_lib.mjs').then(m => m.probeFirst('ds003392'))
"
```

and use whatever subject/task it returns.

- [ ] **Step 3: Run the bench**

Run: `npm run test:bench:readwindow`

Expected: the new fixtures appear in the output. Capture p50/p95 numbers. They establish the new baseline.

- [ ] **Step 4: Update `bench/baseline.json` with the new entries**

Run: `node bench/check-regression.mjs --update-baseline`

(or, if that flag doesn't exist, edit `bench/baseline.json` manually — append the new `readwindow_fiff_range_2s`, `..._10s`, `..._30s`, `readwindow_eeglab_inline_range_2s`, etc. entries with the p50/p95 values just measured.)

- [ ] **Step 5: Re-run to confirm no regression**

Run: `npm run test:perf`

Expected: PASS — no regression on any baseline entry (the existing entries should be unchanged; the new entries match the just-recorded baseline).

- [ ] **Step 6: Commit**

```bash
git add bench/readwindow.bench.mjs bench/baseline.json
git commit -m "test(bench): add FIFF+inline-EEGLAB streaming bench fixtures"
```

---

### Task 11: Full audit reality-check re-run

**Goal:** Re-run `tests/e2e/acceptance/audit-loadable.spec.mjs` on the same 20-sample (or larger if Plan B has already executed) and confirm the pass rate is ≥ 95%. The four previously-failing datasets (ds003694, ds003682, ds002578, ds002718) should now PASS.

**Files:**
- Modify: `docs/audit-browser-reality-2026-05-21.md` (regenerated by report script)

- [ ] **Step 1: Run the audit reality-check**

Run: `npm run test:audit-reality`

Expected: passes ≥ 19/20 (95%+). All four previously-failing datasets render successfully.

If a previously-failing dataset still FAILs after this plan, investigate immediately — likely either:
- The `cdn_url` returns a struct-wrapped EEG (re-check the Task 9 fallback logic).
- The file has zero buffers (FIFF: metadata-only file, should display "no FIFFB_RAW_DATA" message).
- A different format entirely (audit JSON misclassified — file a separate bug).

- [ ] **Step 2: Regenerate the audit report markdown**

Run: `npm run report:audit-reality`

Expected: `docs/audit-browser-reality-2026-05-21.md` updated with new pass rate.

- [ ] **Step 3: Commit the regenerated artifacts**

```bash
git add tests/evidence/audit-browser-reality/results.jsonl docs/audit-browser-reality-2026-05-21.md
git commit -m "docs(audit): re-run browser reality check post-streaming readers"
```

---

### Task 12: Final typecheck + Stryker sanity

**Goal:** Make sure no JSDoc / tsc error and no Stryker scope regression slipped in. Stryker config does NOT include the new `_fiff-dir.js` in the `mutate` array — leave that for a follow-up dedicated mutation-coverage task.

**Files:**
- (no edits; verification only)

- [ ] **Step 1: Run the typecheck**

Run: `npm run test:typecheck`

Expected: PASS — no new tsc errors.

- [ ] **Step 2: Run the entire unit + integration suite**

Run: `npm run test:unit && npm run test:integration:gc`

Expected: PASS — no regression in any test.

- [ ] **Step 3: Run Stryker incremental on the modified scope**

Run: `npm run mutation:incremental`

Expected: no new survivors on `viewer.js` / `worker.js` (the files we DIDN'T modify but which are inside the Stryker scope). Mutation score stays above the `break: 37` threshold.

- [ ] **Step 4: Commit any incidental fixes**

If Stryker surfaces a new survivor caused by the refactor, fix it in a follow-up commit. Otherwise:

```bash
git status  # confirm clean working tree
```

No commit needed if nothing changed.

---

### Task 13: Update the streaming study doc

**Goal:** Append a short section to `docs/streaming-and-cdn-study.md` summarising what landed: which two readers are now range-based, the four datasets unblocked, the evidence file location.

**Files:**
- Modify: `docs/streaming-and-cdn-study.md`

- [ ] **Step 1: Add the section**

Append to `docs/streaming-and-cdn-study.md`:

```markdown
## 2026-05-21 — Streaming FIFF + MAT v5 inline readers

The FIFF reader (formats/fiff.js) and the EEGLAB inline-.set reader
(formats/eeglab.js openInlineSet) used to fetch entire files via
HttpRange.fetchBuffer. As of this plan they walk only the bytes the
window needs:

- **FIFF**: `api.open` range-fetches the directory at end-of-file
  (last 256 KB) and the FIFFB_MEAS_INFO bytes (typically 10-100 KB).
  `readWindow(start, n)` range-fetches only the data buffers covering
  the requested sample range. Files without a tag directory fall back
  to the legacy fetchBuffer with a 200 MB cap.

- **EEGLAB inline .set (v5, top-level data)**: `api.open` range-fetches
  the first 16 MB to scan elements; `readWindow(start, n)` range-fetches
  the column slice of the `data` matrix. Struct-wrapped, compressed,
  non-float32, or v7.3 files fall back to whole-file parse with a
  200 MB cap.

Datasets unblocked (previously render-failed at >200 MB):

- ds003694 (FIFF, ~2 GB)
- ds003682 (FIFF, ~644 MB)
- ds002578 (inline EEGLAB, ~695 MB)
- ds002718 (inline EEGLAB, ~224 MB)

Evidence: `tests/evidence/streaming-large/results.jsonl` (open_ms,
read_ms, peak_heap_mb_delta per dataset). The Playwright spec asserts
open < 5 s, readWindow < 2 s, heap delta < 100 MB per the brief.

What's NOT streaming:

- MAT v7.3 (HDF5) — jsfive needs the whole file in memory.
  Streaming v7.3 is a bigger follow-up; the 200 MB cap stays as a
  safety net for that path.
- FIFF files without a tag directory — rare (~5% of OpenNeuro);
  legacy fetchBuffer fallback with a 200 MB cap.
- Compressed EEGLAB .set (miCOMPRESSED top-level) — zlib needs the
  whole stream; falls back to whole-file parse + 200 MB cap.
```

- [ ] **Step 2: Commit**

```bash
git add docs/streaming-and-cdn-study.md
git commit -m "docs(streaming): summarise FIFF + inline-EEGLAB range readers"
```

---

## Self-Review

### Spec coverage

Each requirement in the brief maps to a task:

- **FIFF directory parser** → Task 1
- **FIFF.api.open range-based** → Task 2
- **FIFF.readWindow(start, n) range-based** → Task 3
- **FIFF.readWindowStreaming** → Task 4
- **Browser-test FIFF > 200 MB** → Task 5
- **MAT v5 element-header scanner** → Task 6
- **EEGLAB inline streaming open** → Task 7 (combined with readWindow because the open path constructs the closure that captures `dataAbsOffset`)
- **EEGLAB inline streaming readWindow** → Task 7
- **Remove the 200 MB inline cap** → Task 8
- **Browser-test EEGLAB > 200 MB** → Task 9
- **Bench verification** → Task 10
- **Final browser reality-check sweep** → Task 11

Plus Task 12 (typecheck + Stryker) and Task 13 (docs).

### Constraint coverage

- "Each reader change must include a real-browser test against a real >200 MB dataset" → Tasks 5 + 9.
- "Wall-clock api.open() < 5 s, readWindow(0, 1000) < 2 s, memory peak < 100 MB" → asserted in `streaming-large.spec.mjs`.
- "Don't break the existing bench gates" → Task 10 + Task 11.
- "The existing typecheck + Stryker scope must stay clean" → Task 12.

### Type consistency

- `FiffDir.readDirPointer` returns `{ hasDirectory, dirOffset, reason? }` — consistent across Tasks 1, 2.
- `FiffDir.parseDirectory(view, absDirOffset)` returns `{ entries: [{kind,type,size,position}] }` — consistent across Tasks 1, 2.
- `FiffDir.indexBlocks(view, entries)` returns `{ meas_info: {...}, raw_data: { ..., buffers: [...] } }` — consistent across Tasks 1, 2.
- `bufIndex` entries have shape `{ payloadOffset, payloadSize, miType, bytesPerSample, samplesInBuf, cumStart }` — consistent across Tasks 2, 3, 4.
- `MatV5.scanElements` returns array of `{ miType, elementOffset, payloadOffset, payloadBytes, mxClass, dims, name, dataSubOffset, dataSubBytes, dataSubMiType }` — consistent across Tasks 6, 7.
- Reader interface (`n_channels`, `sampling_frequency`, `n_samples`, `duration_s`, `channel_labels`, `bytes_per_sample`, `readWindow`, `readWindowStreaming`, `streaming`) — consistent with the rest of `formats/*.js`.

### Placeholder check

No "TODO" / "implement later" / "similar to Task N" / un-typed handwaves remain. Every code step has either complete code or a verbatim grep / npm command with expected output.
