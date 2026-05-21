# CTF MEG Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CTF (`.ds/` directory-bundle) MEG reader so the viewer can load the 16 OpenNeuro MEG datasets that ship CTF instead of FIFF, lifting MEG loadability from 40.7% to ~85% and overall audit loadability from 80% to ~96%.

**Architecture:** Mirror the FIFF reader's surface but split the parser by concern: `formats/ctf.js` owns the public `api.open(meta)` + `api.read(buf)` + `readWindow(start, n)`; `formats/_ctf-res4.js` parses the `.res4` big-endian header (channels, sample rate, gains, calibrations); `formats/_ctf-marker.js` parses the text `MarkerFile.mrk` + `BadChannels` siblings. URL plumbing in `bids-recording.js` learns to treat `ext=ds` specially — the canonical recording URL points at the `<entities>_meg.meg4` file *inside* the `.ds/` directory; sibling `.res4`/`.mrk`/`BadChannels` URLs are derived alongside.

**Tech Stack:** Plain JS IIFE modules (no bundler), `DataView`/`TypedArray` for binary, `globalThis.HttpRange` (probeLength/rangeFetch/rangeFetchStreaming) for network, `node:test` + `fast-check` for tests, `tsc --noEmit` via `jsconfig.json` for the JSDoc typecheck, Stryker for mutation testing.

---

## File Structure

```
formats/
  ├── ctf.js                         NEW — public api (open + read + readWindow)
  ├── _ctf-res4.js                   NEW — .res4 binary header parser (BE)
  ├── _ctf-marker.js                 NEW — MarkerFile.mrk + BadChannels text parsers
  └── globals.d.ts                   MODIFY — declare CTFRes4 + CTFMarker globals

bids-recording.js                    MODIFY — buildBidsRelpath: ext=ds routes to <entities>_meg.meg4 inside .ds/

viewer.js                            MODIFY — defaultReaders(): + ds: globalThis.CTFReader
worker.js                            MODIFY — importScripts + READERS map: + ds: globalThis.CTFReader
index.html                           MODIFY — <script src> tags for the 3 new files

jsconfig.json                        MODIFY — include formats/ctf.js
stryker.conf.json                    MODIFY — mutate: + formats/ctf.js

tests/
  ├── fixtures/meg/ctf-tiny.ds/      NEW — synthesised CC0 fixture (~30-50 KB)
  │   ├── ctf-tiny_meg.res4          (resource header, BE)
  │   ├── ctf-tiny_meg.meg4          (interleaved int16 samples)
  │   ├── ctf-tiny_meg.acq           (text acquisition metadata)
  │   ├── ctf-tiny_meg.hc            (head coordinates, text)
  │   ├── ctf-tiny_meg.hist          (history log, text)
  │   ├── MarkerFile.mrk             (events, text)
  │   └── BadChannels                (bad-channel list, text)
  ├── fixtures/meg/LICENSE-ATTRIBUTION.md  MODIFY — append CTF fixture license
  ├── unit-ctf-res4.test.mjs         NEW — header parser fixture + invalid-input rejection
  ├── unit-ctf.test.mjs              NEW — api.read + api.open + readWindow happy path
  ├── unit-ctf-marker.test.mjs       NEW — MarkerFile.mrk + BadChannels parser
  ├── unit-ctf-bids-path.test.mjs    NEW — buildBidsRelpath ext=ds → .meg4 inside .ds/
  ├── prop-ctf.test.mjs              NEW — fast-check property test (300+ runs)
  ├── unit-api-surface.test.mjs      MODIFY — register CTFReader keys
  └── fuzz-formats.test.mjs          MODIFY — append CTF target (10k mutated rounds)

scripts/
  ├── make-ctf-fixture.mjs           NEW — synthesises tests/fixtures/meg/ctf-tiny.ds/
  └── audit-100-datasets.mjs         MODIFY — add 'ds' to SUPPORTED_EXTS

docs/
  └── audit-100-datasets-2026-05-21.md  MODIFY — append re-run results
```

15 tasks total. Each ~30-45 min. Tasks 1-4 build the parser bottom-up with TDD; tasks 5-7 wire it into the viewer; tasks 8-12 add the test contract surface; tasks 13-15 re-run the audit and close out.

---

## Background: CTF binary layout (read before Task 2)

A CTF MEG recording is a **directory** like `sub-01_ses-movie_task-movie_run-01_meg.ds/`. Inside, files use the same entity prefix but the directory's own basename (minus `.ds`) — e.g.:

```
sub-01_ses-movie_task-movie_run-01_meg.ds/
  sub-01_ses-movie_task-movie_run-01_meg.res4     # 1844 + nchan*1328-byte header (BE)
  sub-01_ses-movie_task-movie_run-01_meg.meg4     # interleaved int16 samples (BE)
  sub-01_ses-movie_task-movie_run-01_meg.acq      # text
  sub-01_ses-movie_task-movie_run-01_meg.hc       # head coordinates (text)
  sub-01_ses-movie_task-movie_run-01_meg.hist     # history log (text)
  MarkerFile.mrk                                   # events (text)
  ClassFile.cls                                    # trial classes (text)
  BadChannels                                      # bad-channel list (text, one per line)
```

**`.res4` binary layout (all big-endian, verified against `mne/io/ctf/res4.py`):**

| Offset | Size | Meaning |
|---|---|---|
| 0     | 8     | `"MEG41RS\x00"` magic (or `MEG42RS` — both accepted) |
| 8     | 778   | appName / dataOrigin / dataDescription / no_trials_avgd ASCII strings (mostly ignored) |
| 786   | 256   | `nfSetUp` text |
| 1042  | 32    | run name (ASCII) |
| 1074  | 256   | run title (ASCII) |
| 1330  | 32    | instruments (ASCII) |
| 1362  | 32    | collection description (ASCII) |
| 1394  | 32    | run description (ASCII) |
| 1426  | 256   | dataTime (ASCII) |
| 1682  | 2     | `no_samples` int16 (samples per trial — for continuous = total samples per chunk) |
| 1684  | 2     | `no_channels` int16 |
| 1686  | 4     | `sample_rate` float32 |
| 1690  | 4     | `epoch_time` float32 (trial length in seconds) |
| 1694  | 2     | `no_trials` int16 |
| 1696  | 4     | `preTrigPts` int32 |
| 1700  | 2     | `no_trials_done` int16 |
| 1702  | 2     | `no_trials_display` int16 |
| 1704  | 4     | `save_trials` int32 |
| 1708  | 1     | `primaryTrigger` |
| 1709  | 10*4  | `secondaryTrigger[10]` |
| 1749  | 1     | `triggerPolarityMask` |
| 1750  | 2     | `trigger_mode` int16 |
| 1752  | 4     | `accept_reject_Flag` int32 |
| 1756  | 2     | `run_time_display` int16 |
| 1758  | 4     | `zero_Head_Flag` int32 |
| 1762  | 4     | `artifact_mode` int32 |
| 1766  | 78    | padding / extras (ignore) |
| **1844** | **32 × nchan** | **`channel_names` (32 ASCII bytes per channel, null-padded)** |
| 1844 + 32*nchan | **1328 × nchan** | **`sensor_res` structs (1328 bytes each)** |

**`sensor_res` struct (1328 bytes per channel, fields we care about):**

| Field offset (within struct) | Size | Meaning |
|---|---|---|
| 0  | 2  | `sensorTypeIndex` int16 (5=MEG ref grad, 9=MEG, 14=EEG, etc.) |
| 2  | 2  | `originalRunNum` int16 |
| 4  | 4  | `coilShape` int32 |
| 8  | 8  | `properGain` double (BE) — physical scaling |
| 16 | 8  | `qGain` double (BE) — ADC scaling |
| 24 | 8  | `ioGain` double (BE) — IO scaling |
| 32 | 8  | `ioOffset` double (BE) |
| 40 | 2  | `numCoils` int16 |
| 42 | 2  | `grad_order_no` int16 |
| 44 | 4  | `stimPolarity` int32 |
| ... | ... | per-coil geometry; we skip it |

**Calibration:** raw int16 sample → physical units via `value = (sample - 0) / (properGain * qGain * ioGain)`. Most channels have `ioOffset=0`. EEG channels use the same formula (units = volts); MEG = tesla.

**`.meg4` layout:** 8-byte header `"MEG41CP\x00"` (or `MEG42CP`), then `(no_trials × no_samples × no_channels)` big-endian int16 samples, interleaved as `meg4[trial * no_samples * no_channels + sample * no_channels + channel]` — sample-major within a trial, channel-major within a sample. For continuous recordings (`no_trials=1`) this collapses to standard `samples × channels` interleave.

**`MarkerFile.mrk` text layout:**
```
PATH OF DATASET:
/path/to/dataset.ds

NUMBER OF MARKERS:
3

CLASSGROUPID:
0
NAME:
Trigger1
COMMENT:
...
COLOR:
red
...
NUMBER OF SAMPLES:
12
LIST OF SAMPLES:
TRIAL NUMBER		TIME FROM SYNC POINT (in seconds)
                +0		   +0.523000
                +0		   +1.046000
```

**`BadChannels` text layout:** one channel name per line (ignore blank lines + lines starting with `#`).

---

## Task 1: Synthesise the CC0 `.ds/` fixture

**Files:**
- Create: `scripts/make-ctf-fixture.mjs`
- Create (via script): `tests/fixtures/meg/ctf-tiny.ds/*` (7 files, ~30-50 KB total)
- Modify: `tests/fixtures/meg/LICENSE-ATTRIBUTION.md` (append CTF entry)

**Why:** We need a small, license-clean fixture before any reader test can be written. Cloning a real OpenNeuro CTF dataset would pull 100+ MB and possibly non-CC0 bytes; synthesising a 4-channel, 250-sample sine-wave recording is deterministic and small enough to commit. We use the same approach the FIFF synth-raw fixture used (`scripts/make-edfplus-fixture.mjs` style).

- [ ] **Step 1: Write the synthesis script**

```bash
ls /Users/bruaristimunha/Projects/eegdash-viewer/scripts/make-edfplus-fixture.mjs
```

Expected: file exists (use as a stylistic template).

Create `scripts/make-ctf-fixture.mjs`:

```js
#!/usr/bin/env node
/**
 * Synthesise a tiny CC0 CTF `.ds/` directory bundle for testing.
 *
 * Output: tests/fixtures/meg/ctf-tiny.ds/
 *   - ctf-tiny_meg.res4   (1844 + N*32 + N*1328 bytes, big-endian header)
 *   - ctf-tiny_meg.meg4   (8-byte magic + N*S*2 bytes interleaved int16 BE)
 *   - ctf-tiny_meg.acq    (text, dummy)
 *   - ctf-tiny_meg.hc     (text, dummy)
 *   - ctf-tiny_meg.hist   (text, dummy)
 *   - MarkerFile.mrk      (text, 2 markers)
 *   - BadChannels         (text, 1 entry)
 *
 * Reference: mne/io/ctf/res4.py for the binary layout (BSD-3, MIT-compatible).
 */
import fs from 'node:fs';
import path from 'node:path';

const N_CHANNELS = 4;
const N_SAMPLES_PER_TRIAL = 250;
const N_TRIALS = 1;
const SAMPLE_RATE = 100.0;
const CHANNEL_NAMES = ['MLT11-1609', 'MLT12-1609', 'MLT13-1609', 'EEG001'];
const SENSOR_TYPES = [9, 9, 9, 14]; // MEG, MEG, MEG, EEG

const outDir = path.resolve('tests/fixtures/meg/ctf-tiny.ds');
fs.mkdirSync(outDir, { recursive: true });
const prefix = 'ctf-tiny_meg';

// ---- .res4 ----------------------------------------------------------
const HEADER_FIXED = 1844;
const NAME_BYTES = 32;
const SENSOR_BYTES = 1328;
const res4Size = HEADER_FIXED + N_CHANNELS * (NAME_BYTES + SENSOR_BYTES);
const res4 = Buffer.alloc(res4Size, 0);

// Magic
res4.write('MEG41RS\x00', 0, 8, 'binary');

// no_samples (offset 1682, int16 BE)
res4.writeInt16BE(N_SAMPLES_PER_TRIAL, 1682);
// no_channels (offset 1684, int16 BE)
res4.writeInt16BE(N_CHANNELS, 1684);
// sample_rate (offset 1686, float32 BE)
res4.writeFloatBE(SAMPLE_RATE, 1686);
// epoch_time (offset 1690, float32 BE)
res4.writeFloatBE(N_SAMPLES_PER_TRIAL / SAMPLE_RATE, 1690);
// no_trials (offset 1694, int16 BE)
res4.writeInt16BE(N_TRIALS, 1694);

// Channel names: 32 bytes each, null-padded ASCII, starting at offset 1844
const namesOff = HEADER_FIXED;
for (let c = 0; c < N_CHANNELS; c++) {
  res4.write(CHANNEL_NAMES[c], namesOff + c * NAME_BYTES, NAME_BYTES, 'ascii');
}

// Sensor_res structs: 1328 bytes each, starting after names
const sensorOff = namesOff + N_CHANNELS * NAME_BYTES;
for (let c = 0; c < N_CHANNELS; c++) {
  const base = sensorOff + c * SENSOR_BYTES;
  res4.writeInt16BE(SENSOR_TYPES[c], base + 0);   // sensorTypeIndex
  res4.writeInt16BE(1, base + 2);                  // originalRunNum
  res4.writeInt32BE(0, base + 4);                  // coilShape
  res4.writeDoubleBE(1.0e-12, base + 8);           // properGain
  res4.writeDoubleBE(1.0, base + 16);              // qGain
  res4.writeDoubleBE(1.0, base + 24);              // ioGain
  res4.writeDoubleBE(0.0, base + 32);              // ioOffset
}

fs.writeFileSync(path.join(outDir, `${prefix}.res4`), res4);

// ---- .meg4 ----------------------------------------------------------
const meg4Size = 8 + N_TRIALS * N_SAMPLES_PER_TRIAL * N_CHANNELS * 2;
const meg4 = Buffer.alloc(meg4Size, 0);
meg4.write('MEG41CP\x00', 0, 8, 'binary');
let off = 8;
for (let t = 0; t < N_TRIALS; t++) {
  for (let s = 0; s < N_SAMPLES_PER_TRIAL; s++) {
    for (let c = 0; c < N_CHANNELS; c++) {
      const v = Math.round(1000 * Math.sin(2 * Math.PI * (s / SAMPLE_RATE) * (c + 1)));
      meg4.writeInt16BE(v, off);
      off += 2;
    }
  }
}
fs.writeFileSync(path.join(outDir, `${prefix}.meg4`), meg4);

// ---- text siblings --------------------------------------------------
fs.writeFileSync(path.join(outDir, `${prefix}.acq`),
  'acquisition: ctf-tiny synthetic\n');
fs.writeFileSync(path.join(outDir, `${prefix}.hc`),
  'standard nasion-coordinates\nx = 0\ny = 0\nz = 0\n');
fs.writeFileSync(path.join(outDir, `${prefix}.hist`),
  '2026-05-21: synthesised by scripts/make-ctf-fixture.mjs\n');
fs.writeFileSync(path.join(outDir, 'MarkerFile.mrk'),
  [
    'PATH OF DATASET:',
    '/synthetic/ctf-tiny.ds',
    '',
    'NUMBER OF MARKERS:',
    '1',
    '',
    'CLASSGROUPID:',
    '0',
    'NAME:',
    'Trigger1',
    'COMMENT:',
    '',
    'COLOR:',
    'red',
    'EDITABLE:',
    'Yes',
    'CLASSID:',
    '1',
    'NUMBER OF SAMPLES:',
    '2',
    'LIST OF SAMPLES:',
    'TRIAL NUMBER\t\tTIME FROM SYNC POINT (in seconds)',
    '                +0\t\t   +0.500000',
    '                +0\t\t   +1.250000',
    '',
  ].join('\n'));
fs.writeFileSync(path.join(outDir, 'BadChannels'),
  'EEG001\n');

console.log(`wrote ${outDir} (${fs.readdirSync(outDir).length} files)`);
```

- [ ] **Step 2: Run the script + verify outputs**

Run: `node scripts/make-ctf-fixture.mjs`
Expected: `wrote /Users/bruaristimunha/Projects/eegdash-viewer/tests/fixtures/meg/ctf-tiny.ds (7 files)`

Then: `ls -la tests/fixtures/meg/ctf-tiny.ds/ && du -sh tests/fixtures/meg/ctf-tiny.ds`
Expected: 7 files; total size under 60 KB.

- [ ] **Step 3: Append fixture license**

Modify `tests/fixtures/meg/LICENSE-ATTRIBUTION.md` — append at the bottom:

```markdown

## ctf-tiny.ds/ (synthesised, CC0)

Files in `ctf-tiny.ds/` are synthesised by `scripts/make-ctf-fixture.mjs`
(this repo) — no upstream data. Released under CC0. Binary layout follows
the CTF MEG format documented in MNE-Python's `mne/io/ctf/res4.py`
(BSD-3 clause).

- 4 channels (3 MEG + 1 EEG), 250 samples @ 100 Hz = 2.5 s recording.
- Sample values: deterministic sine waves at increasing frequency per channel.
- One marker at t=0.5 s and t=1.25 s. One bad channel: EEG001.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/make-ctf-fixture.mjs tests/fixtures/meg/ctf-tiny.ds/ tests/fixtures/meg/LICENSE-ATTRIBUTION.md
git commit -m "test(ctf): add synthesised CC0 .ds/ fixture for CTF reader"
```

---

## Task 2: `.res4` binary header parser (TDD)

**Files:**
- Create: `formats/_ctf-res4.js`
- Create: `tests/unit-ctf-res4.test.mjs`

**Why:** The `.res4` parser is the riskiest piece — big-endian doubles + offset arithmetic — so we isolate it in its own file and test it directly without faking HTTP. Mirrors how `formats/_matv5.js` lives alongside `formats/eeglab.js`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit-ctf-res4.test.mjs`:

```js
// Unit tests for formats/_ctf-res4.js — the CTF .res4 binary header
// parser. Fixture is the deterministic synth at tests/fixtures/meg/
// ctf-tiny.ds/ctf-tiny_meg.res4 (see scripts/make-ctf-fixture.mjs).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const CTFRes4 = require('../formats/_ctf-res4.js');

function readBuf(rel) {
  const b = fs.readFileSync(rel);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

test('ctf-res4: parses synth fixture without throwing', () => {
  const ab = readBuf('tests/fixtures/meg/ctf-tiny.ds/ctf-tiny_meg.res4');
  const h = CTFRes4.parse(ab);
  assert.ok(h && typeof h === 'object', 'parse() returned non-object');
});

test('ctf-res4: header fields match the synth values', () => {
  const ab = readBuf('tests/fixtures/meg/ctf-tiny.ds/ctf-tiny_meg.res4');
  const h = CTFRes4.parse(ab);
  assert.equal(h.no_channels, 4);
  assert.equal(h.no_samples, 250);
  assert.equal(h.sample_rate, 100);
  assert.equal(h.no_trials, 1);
  assert.equal(h.channels.length, 4);
  assert.equal(h.channels[0].name, 'MLT11-1609');
  assert.equal(h.channels[3].name, 'EEG001');
  // sensorTypeIndex from the synth: 9, 9, 9, 14
  assert.equal(h.channels[0].sensor_type, 9);
  assert.equal(h.channels[3].sensor_type, 14);
  // Calibration scalar: 1 / (properGain * qGain * ioGain)
  // synth uses properGain=1e-12, qGain=1, ioGain=1 → 1e12
  assert.ok(Math.abs(h.channels[0].cal - 1e12) < 1, 'cal mismatch');
});

test('ctf-res4: rejects buffer smaller than header', () => {
  const ab = new ArrayBuffer(100);
  assert.throws(() => CTFRes4.parse(ab), /too small|res4/i);
});

test('ctf-res4: rejects buffer with wrong magic', () => {
  // 1844 + 4*(32+1328) = 7284 bytes — large enough; bad magic only.
  const ab = new ArrayBuffer(7284);
  const v = new Uint8Array(ab);
  v.set(new TextEncoder().encode('NOTAMAG\x00'));
  // Set no_channels=4 so size checks pass but magic fails.
  const dv = new DataView(ab);
  dv.setInt16(1684, 4, false);
  assert.throws(() => CTFRes4.parse(ab), /magic|MEG4\dRS/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit-ctf-res4.test.mjs`
Expected: FAIL with `Cannot find module '../formats/_ctf-res4.js'`.

- [ ] **Step 3: Implement `_ctf-res4.js`**

Create `formats/_ctf-res4.js`:

```js
/* ============================================================
   formats/_ctf-res4.js — parse the CTF MEG `.res4` binary header.

   Layout (all integers BIG-ENDIAN; doubles BE; ASCII strings
   null-padded). Verified against MNE-Python's mne/io/ctf/res4.py
   (BSD-3-clause).

   Fixed header (1844 bytes):
     0..7      "MEG41RS\0" or "MEG42RS\0" magic
     8..1681   appName / dataOrigin / dataDescription / sample-info
               text fields and timestamps (ignored by this reader)
     1682..1683  no_samples           int16 BE  (samples per trial)
     1684..1685  no_channels          int16 BE
     1686..1689  sample_rate          float32 BE
     1690..1693  epoch_time           float32 BE  (trial length, s)
     1694..1695  no_trials            int16 BE
     1696..1843  trigger / display / artifact-flag bag (ignored)

   After the fixed header:
     1844                  channel-name table: 32 bytes per channel,
                           null-padded ASCII.
     1844 + 32*nchan       sensor_res structs: 1328 bytes per channel
                           (only the first ~44 bytes carry gain/type
                           fields we use; the rest is per-coil geometry).

   sensor_res fields used by the viewer (offsets within the 1328-B struct):
     0..1   sensor_type      int16 BE  (5=MEGref, 9=MEG, 14=EEG, …)
     2..3   originalRunNum   int16 BE
     4..7   coilShape        int32 BE
     8..15  properGain       double BE
     16..23 qGain            double BE
     24..31 ioGain           double BE
     32..39 ioOffset         double BE

   Per-channel calibration applied to raw int16 samples:
     value = (sample - 0) / (properGain * qGain * ioGain)
   We collapse this to a single multiplicative `cal` so the hot
   readWindow loop is one multiply per sample. ioOffset is preserved
   separately for channels whose offset is non-zero (rare).
   ============================================================ */
(function () {
  'use strict';

  const api = {};

  const HEADER_FIXED = 1844;
  const NAME_BYTES = 32;
  const SENSOR_BYTES = 1328;

  // Hard cap on no_channels we'll accept — protects us from a
  // corrupt res4 claiming 2^15 channels and OOMing the browser.
  const MAX_CHANNELS = 4096;
  const MAX_SAMPLES_PER_TRIAL = 1 << 26;  // 64 Msamples per trial cap
  const MAX_TRIALS = 1 << 16;

  /**
   * Parse a CTF `.res4` ArrayBuffer into a structured header.
   *
   * @param {ArrayBuffer} buf - the entire .res4 file as one buffer.
   * @returns {{
   *   no_samples: number,
   *   no_channels: number,
   *   sample_rate: number,
   *   epoch_time: number,
   *   no_trials: number,
   *   channels: Array<{
   *     name: string,
   *     sensor_type: number,
   *     proper_gain: number,
   *     q_gain: number,
   *     io_gain: number,
   *     io_offset: number,
   *     cal: number,
   *   }>
   * }}
   * @throws {Error} when buf is shorter than the fixed header, the
   *   magic doesn't match, or the declared channel count exceeds
   *   MAX_CHANNELS / leaves the buffer over-/under-flown.
   */
  api.parse = function (buf) {
    if (!buf || buf.byteLength < HEADER_FIXED) {
      throw new Error(`CTF .res4 too small: need ≥${HEADER_FIXED} bytes, got ${buf ? buf.byteLength : 0}`);
    }
    const v = new DataView(buf);
    const bytes = new Uint8Array(buf);

    // Magic: "MEG41RS\0" or "MEG42RS\0". Some research datasets ship
    // 4.0 / 4.2 generators — accept both. Anything else is not CTF.
    const magic = ascii(bytes, 0, 8).replace(/\0.*$/, '');
    if (!/^MEG4[12]RS$/.test(magic)) {
      throw new Error(`CTF .res4: bad magic ${JSON.stringify(magic)} — expected MEG41RS or MEG42RS`);
    }

    const no_samples  = v.getInt16(1682, false);
    const no_channels = v.getInt16(1684, false);
    const sample_rate = v.getFloat32(1686, false);
    const epoch_time  = v.getFloat32(1690, false);
    const no_trials   = v.getInt16(1694, false);

    if (no_channels <= 0 || no_channels > MAX_CHANNELS) {
      throw new Error(`CTF .res4: no_channels ${no_channels} out of range (1..${MAX_CHANNELS})`);
    }
    if (no_samples <= 0 || no_samples > MAX_SAMPLES_PER_TRIAL) {
      throw new Error(`CTF .res4: no_samples ${no_samples} out of range (1..${MAX_SAMPLES_PER_TRIAL})`);
    }
    if (no_trials <= 0 || no_trials > MAX_TRIALS) {
      throw new Error(`CTF .res4: no_trials ${no_trials} out of range (1..${MAX_TRIALS})`);
    }
    if (!(sample_rate > 0) || !Number.isFinite(sample_rate)) {
      throw new Error(`CTF .res4: sample_rate ${sample_rate} invalid`);
    }

    const expectedSize = HEADER_FIXED + no_channels * (NAME_BYTES + SENSOR_BYTES);
    if (buf.byteLength < expectedSize) {
      throw new Error(`CTF .res4: ${buf.byteLength} bytes < expected ${expectedSize} for ${no_channels} channels`);
    }

    // Channel names
    const namesOff = HEADER_FIXED;
    const channels = new Array(no_channels);
    for (let c = 0; c < no_channels; c++) {
      const off = namesOff + c * NAME_BYTES;
      channels[c] = { name: ascii(bytes, off, NAME_BYTES) };
    }

    // sensor_res structs
    const sensorOff = namesOff + no_channels * NAME_BYTES;
    for (let c = 0; c < no_channels; c++) {
      const base = sensorOff + c * SENSOR_BYTES;
      const sensor_type = v.getInt16(base + 0, false);
      const proper_gain = v.getFloat64(base + 8, false);
      const q_gain      = v.getFloat64(base + 16, false);
      const io_gain     = v.getFloat64(base + 24, false);
      const io_offset   = v.getFloat64(base + 32, false);
      // Combined per-sample calibration. Guard against a zero or
      // non-finite gain product turning every sample into Inf/NaN —
      // fall back to 1.0 with a stable display value.
      const denom = proper_gain * q_gain * io_gain;
      const cal = (Number.isFinite(denom) && denom !== 0) ? (1 / denom) : 1;
      channels[c].sensor_type = sensor_type;
      channels[c].proper_gain = proper_gain;
      channels[c].q_gain = q_gain;
      channels[c].io_gain = io_gain;
      channels[c].io_offset = Number.isFinite(io_offset) ? io_offset : 0;
      channels[c].cal = cal;
    }

    return { no_samples, no_channels, sample_rate, epoch_time, no_trials, channels };
  };

  function ascii(bytes, offset, length) {
    let s = '';
    const end = Math.min(offset + length, bytes.length);
    for (let i = offset; i < end; i++) {
      const b = bytes[i];
      if (b === 0) break;
      // Reject non-printable so we never feed garbage into the UI.
      if (b < 0x20 || b > 0x7e) continue;
      s += String.fromCharCode(b);
    }
    return s;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.CTFRes4 = api;
})();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit-ctf-res4.test.mjs`
Expected: 4 passing, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add formats/_ctf-res4.js tests/unit-ctf-res4.test.mjs
git commit -m "feat(ctf): add .res4 big-endian header parser"
```

---

## Task 3: `MarkerFile.mrk` + `BadChannels` text parsers (TDD)

**Files:**
- Create: `formats/_ctf-marker.js`
- Create: `tests/unit-ctf-marker.test.mjs`

**Why:** Events and bad-channel lists are tiny text files but isolated parsers keep `ctf.js` short. Outputs map onto the existing viewer shapes (`annotation_events` and bad-channel mask).

- [ ] **Step 1: Write the failing test**

Create `tests/unit-ctf-marker.test.mjs`:

```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const CTFMarker = require('../formats/_ctf-marker.js');

test('ctf-marker: parses synth MarkerFile.mrk into 2 events', () => {
  const text = fs.readFileSync('tests/fixtures/meg/ctf-tiny.ds/MarkerFile.mrk', 'utf-8');
  const events = CTFMarker.parseMarkerFile(text);
  assert.ok(Array.isArray(events), 'parseMarkerFile must return array');
  assert.equal(events.length, 2, `expected 2 events, got ${events.length}`);
  assert.equal(events[0].label, 'Trigger1');
  assert.ok(Math.abs(events[0].onset - 0.5) < 0.0001);
  assert.ok(Math.abs(events[1].onset - 1.25) < 0.0001);
  // duration defaults to 0 for markers (point events).
  assert.equal(events[0].duration, 0);
});

test('ctf-marker: parseMarkerFile returns [] on empty / non-marker text', () => {
  assert.deepEqual(CTFMarker.parseMarkerFile(''), []);
  assert.deepEqual(CTFMarker.parseMarkerFile('garbage with no markers'), []);
});

test('ctf-marker: parses synth BadChannels into a list', () => {
  const text = fs.readFileSync('tests/fixtures/meg/ctf-tiny.ds/BadChannels', 'utf-8');
  const bad = CTFMarker.parseBadChannels(text);
  assert.deepEqual(bad, ['EEG001']);
});

test('ctf-marker: BadChannels ignores blanks and # comments', () => {
  const bad = CTFMarker.parseBadChannels('# header\nMLT11-1609\n\n#noise\nMLT12-1609\n');
  assert.deepEqual(bad, ['MLT11-1609', 'MLT12-1609']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit-ctf-marker.test.mjs`
Expected: FAIL with `Cannot find module '../formats/_ctf-marker.js'`.

- [ ] **Step 3: Implement `_ctf-marker.js`**

Create `formats/_ctf-marker.js`:

```js
/* ============================================================
   formats/_ctf-marker.js — parse CTF MEG MarkerFile.mrk + BadChannels.

   MarkerFile.mrk text format (whitespace tolerant):
     PATH OF DATASET:
     /some/path/foo.ds

     NUMBER OF MARKERS:
     <N>

     [repeated N times:]
     CLASSGROUPID:
     0
     NAME:
     <label>
     COMMENT:
     <comment>
     COLOR:
     <colour>
     EDITABLE:
     Yes|No
     CLASSID:
     <id>
     NUMBER OF SAMPLES:
     <M>
     LIST OF SAMPLES:
     TRIAL NUMBER       TIME FROM SYNC POINT (in seconds)
                  +<trial>     +<seconds>
                  +<trial>     +<seconds>
                  ...

   We only extract (label, trial, onset) tuples — that's all the viewer
   needs to draw event markers. Other fields (CLASSGROUPID, COLOR, …)
   are deliberately dropped.

   BadChannels: plain text, one channel name per line. Blank lines and
   '#'-comment lines are skipped.
   ============================================================ */
(function () {
  'use strict';

  const api = {};

  /**
   * Parse a CTF MarkerFile.mrk into a flat list of point events.
   * @param {string} text - file contents.
   * @returns {Array<{ onset: number, duration: number, label: string|null, trial: number, sample: number|null }>}
   *   Always returns an array. `onset` is in seconds, `duration` is 0
   *   (CTF markers are point events). `sample` is null because the
   *   sample index requires knowing the sample rate; convert downstream.
   */
  api.parseMarkerFile = function (text) {
    if (typeof text !== 'string' || !text.length) return [];

    const lines = text.split(/\r?\n/);
    const events = [];

    let i = 0;
    while (i < lines.length) {
      // Look for the marker section: NAME: header followed by the
      // label on the next line, then a NUMBER OF SAMPLES / LIST OF
      // SAMPLES block. Each marker is independent.
      if (/^\s*NAME:\s*$/i.test(lines[i])) {
        const label = (lines[i + 1] || '').trim() || null;
        // Skip ahead until we find LIST OF SAMPLES (or a new NAME:
        // which means a malformed marker — just abandon it).
        let j = i + 2;
        while (j < lines.length && !/^\s*LIST OF SAMPLES:?\s*$/i.test(lines[j])) {
          if (/^\s*NAME:\s*$/i.test(lines[j])) { j = -1; break; }
          j++;
        }
        if (j < 0 || j >= lines.length) { i = i + 2; continue; }
        // Skip the header row (TRIAL NUMBER ... TIME ...).
        let k = j + 1;
        if (k < lines.length && /TRIAL NUMBER/i.test(lines[k])) k++;
        // Collect rows until a blank line or a new section header.
        while (k < lines.length) {
          const ln = lines[k];
          if (/^\s*$/.test(ln)) break;
          if (/^\s*[A-Z][A-Z\s]*:\s*$/.test(ln)) break;
          // Two whitespace-separated numbers: trial, onsetSeconds.
          const m = /([+-]?\d+(?:\.\d*)?)\s+([+-]?\d+(?:\.\d*)?)/.exec(ln);
          if (m) {
            const trial = parseInt(m[1], 10);
            const onset = parseFloat(m[2]);
            if (Number.isFinite(trial) && Number.isFinite(onset)) {
              events.push({ onset, duration: 0, label, trial, sample: null });
            }
          }
          k++;
        }
        i = k;
        continue;
      }
      i++;
    }

    return events;
  };

  /**
   * Parse the CTF BadChannels text file (one channel name per line).
   * Skips blank lines and lines starting with '#'.
   * @param {string} text
   * @returns {string[]}
   */
  api.parseBadChannels = function (text) {
    if (typeof text !== 'string' || !text.length) return [];
    return text.split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('#'));
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.CTFMarker = api;
})();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit-ctf-marker.test.mjs`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add formats/_ctf-marker.js tests/unit-ctf-marker.test.mjs
git commit -m "feat(ctf): add MarkerFile.mrk + BadChannels text parsers"
```

---

## Task 4: BIDS path layer — route `ext=ds` into the `.ds/` bundle

**Files:**
- Modify: `bids-recording.js` — `buildBidsRelpath`, `parsePhysioUrl`
- Create: `tests/unit-ctf-bids-path.test.mjs`

**Why:** A CTF recording's user-facing URL ends with `.ds` (the directory), but the actual binary lives at `.ds/<entities>_meg.meg4` and siblings sit beside it. The path builder needs to special-case `ext=ds` so OpenNeuro / NEMAR URLs constructed from `?dataset=&sub=&...&ext=ds` resolve to the meg4 file, and `parsePhysioUrl` needs to accept both `<entities>_meg.ds/<entities>_meg.meg4` (direct URL) and the bare `_meg.ds/` form (so sidecar inheritance still works).

- [ ] **Step 1: Write the failing test**

Create `tests/unit-ctf-bids-path.test.mjs`:

```js
// Verifies the CTF-specific URL routing in bids-recording.js.
//
// CTF is the only format whose `ext` URL parameter names a *directory*
// (the .ds/ bundle), not a single file. The path builder must expand
// `ext=ds` into `<entities>_meg.ds/<entities>_meg.meg4` so HttpRange
// can stream the actual binary.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BIDSRecording = require('../bids-recording.js');

test('bids-recording: ext=ds builds a path ending in .ds/<entities>_meg.meg4', () => {
  const url = BIDSRecording.buildOpenNeuroEegUrl({
    dataset: 'ds003633',
    sub: '01',
    ses: 'movie',
    task: 'movie',
    run: '01',
    ext: 'ds',
    suffix: 'meg',
  });
  assert.match(url, /sub-01_ses-movie_task-movie_run-01_meg\.ds\/sub-01_ses-movie_task-movie_run-01_meg\.meg4$/,
    `expected .ds/<entities>_meg.meg4 tail, got: ${url}`);
});

test('bids-recording: ext=ds threads the bundle path into the meg directory', () => {
  const url = BIDSRecording.buildOpenNeuroEegUrl({
    dataset: 'ds003633',
    sub: '01',
    ses: 'movie',
    ext: 'ds',
    suffix: 'meg',
  });
  // Must still slot under sub-01/ses-movie/meg/.
  assert.match(url, /\/ds003633\/sub-01\/ses-movie\/meg\//);
});

test('bids-recording: parsePhysioUrl accepts a URL pointing inside a .ds bundle', () => {
  const u = 'https://example.com/ds/sub-01/ses-movie/meg/sub-01_ses-movie_task-movie_run-01_meg.ds/sub-01_ses-movie_task-movie_run-01_meg.meg4';
  const p = BIDSRecording.parsePhysioUrl(u);
  // The reader extension is 'ds' (the bundle), not 'meg4'. This is
  // what viewer.js + worker.js dispatch on — READERS['ds'] === CTFReader.
  assert.equal(p.ext, 'ds');
  assert.equal(p.prefix, 'sub-01_ses-movie_task-movie_run-01');
  assert.equal(p.suffix, 'meg');
  // dir is the *meg directory*, NOT the .ds/ bundle — sidecar
  // inheritance walks above the bundle, not inside it.
  assert.match(p.dir, /\/meg\/$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit-ctf-bids-path.test.mjs`
Expected: FAIL — `ext=ds` currently builds `.ds` with no inner-file suffix, and `parsePhysioUrl` doesn't know about `.ds/<entities>_meg.meg4`.

- [ ] **Step 3: Edit `bids-recording.js` — `buildBidsRelpath`**

In `bids-recording.js` find the `buildBidsRelpath` function (around line 92-119). Replace its final two lines (the `entities` assembly + return) with a CTF-aware branch:

```js
    if (ext === 'ds') {
      // CTF directory-bundle: the URL the reader fetches is
      // `<entities>_meg.ds/<entities>_meg.meg4`, the actual binary
      // inside the bundle. The bundle directory and the inner file
      // share the same entity-prefixed basename, just with different
      // extensions (.ds for the directory, .meg4 for the binary).
      // This mirrors how mne-python's mne.io.read_raw_ctf opens the
      // .ds/ path and discovers .meg4/.res4 siblings.
      return `${segs.join('/')}/${entities}_${suf}.ds/${entities}_${suf}.meg4`;
    }
    return `${segs.join('/')}/${entities}_${suf}.${ext}`;
```

- [ ] **Step 4: Edit `bids-recording.js` — `parsePhysioUrl`**

In `bids-recording.js` find `parsePhysioUrl` (around line 50-66). Insert a CTF case BEFORE the canonical match (lines 52-54):

```js
  api.parsePhysioUrl = function (physioUrl) {
    // CTF MEG directory bundle: URLs look like
    //   .../<entities>_meg.ds/<entities>_meg.meg4
    // We surface ext='ds' (the bundle is what the reader registers
    // against in READERS) but dir = the *parent meg directory* so
    // BIDS sidecar inheritance walks the meg/ → ses/ → sub/ → root
    // chain, never into the bundle. The bundle itself owns the
    // .res4/.meg4/.mrk/BadChannels siblings — those are resolved by
    // ctf.js, not the inheritance walker.
    const ctf = /^(.*\/)([^/]+?)_(eeg|ieeg|emg|meg|nirs)\.ds\/\2_\3\.meg4$/.exec(physioUrl);
    if (ctf) return { dir: ctf[1], prefix: ctf[2], suffix: ctf[3], ext: 'ds' };
    // Primary: BIDS canonical `<prefix>_{suffix}.<ext>` form.
    // Matches any suffix (eeg, ieeg, emg, meg, nirs, etc.)
    const m = /^(.*\/)([^/]+?)_(eeg|ieeg|emg|meg|nirs)\.([A-Za-z0-9+]+)$/.exec(physioUrl);
    if (m) return { dir: m[1], prefix: m[2], suffix: m[3], ext: m[4].toLowerCase() };
```

(Keep the rest of `parsePhysioUrl` unchanged.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/unit-ctf-bids-path.test.mjs`
Expected: 3 passing.

- [ ] **Step 6: Run the rest of bids-recording tests to confirm no regression**

Run: `node --test tests/unit-bids-recording.test.mjs tests/unit-bids-recording-assemble.test.mjs tests/unit-nemar.test.mjs`
Expected: all pre-existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add bids-recording.js tests/unit-ctf-bids-path.test.mjs
git commit -m "feat(bids): route ext=ds through .ds/<entities>_meg.meg4 bundle path"
```

---

## Task 5: `formats/ctf.js` — `api.read(buf)` synchronous parser (TDD)

**Files:**
- Create: `formats/ctf.js`
- Create: `tests/unit-ctf.test.mjs` (first 4 tests only)

**Why:** Like `fiff.js`, we keep an `api.read(buf)` synchronous entry point so the property/fuzz tests can hammer the parser with random bytes without involving HTTP. `read` here parses a `.res4` buffer (passed in directly); `open` later glues `.res4` + `.meg4` + text siblings together via HttpRange.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit-ctf.test.mjs`:

```js
// Unit tests for formats/ctf.js — both api.read(.res4 buffer) and
// the wrapper api.open(meta) + readWindow(start, n).
//
// Fixture: tests/fixtures/meg/ctf-tiny.ds/ (synthesised — see
// scripts/make-ctf-fixture.mjs). 4 channels × 250 samples @ 100 Hz.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
// Helper modules attach to globalThis on require — load them first.
require('../formats/_ctf-res4.js');
require('../formats/_ctf-marker.js');
const CTFReader = require('../formats/ctf.js');

function readBuf(rel) {
  const b = fs.readFileSync(rel);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

// ─── api.read(.res4 buf) ─────────────────────────────────────────

test('ctf: read() parses the .res4 fixture into a header', () => {
  const ab = readBuf('tests/fixtures/meg/ctf-tiny.ds/ctf-tiny_meg.res4');
  const h = CTFReader.read(ab);
  assert.ok(h && typeof h === 'object');
  assert.equal(h.no_channels, 4);
  assert.equal(h.sample_rate, 100);
});

test('ctf: read() rejects a truncated buffer with a regular Error', () => {
  assert.throws(() => CTFReader.read(new ArrayBuffer(50)), Error);
});

test('ctf: read() rejects null/undefined input with a regular Error', () => {
  assert.throws(() => CTFReader.read(null), Error);
  assert.throws(() => CTFReader.read(undefined), Error);
});

test('ctf: read() never returns null/undefined for accepted input', () => {
  const ab = readBuf('tests/fixtures/meg/ctf-tiny.ds/ctf-tiny_meg.res4');
  const h = CTFReader.read(ab);
  assert.notEqual(h, null);
  assert.notEqual(h, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit-ctf.test.mjs`
Expected: FAIL — `formats/ctf.js` doesn't exist.

- [ ] **Step 3: Implement `formats/ctf.js` skeleton with `api.read`**

Create `formats/ctf.js`:

```js
/* ============================================================
   formats/ctf.js — minimal CTF MEG reader for eegdash-viewer.

   CTF recordings are *directory bundles*: the user-facing URL is
   `<entities>_meg.ds/`, a directory containing:
     <entities>_meg.res4    big-endian binary header (channels, srate,
                            gains) — parsed by formats/_ctf-res4.js
     <entities>_meg.meg4    big-endian int16 interleaved samples;
                            8-byte "MEG4xCP\0" magic + body
     <entities>_meg.acq     text acquisition metadata (ignored)
     <entities>_meg.hc      text head coordinates (ignored)
     <entities>_meg.hist    text history log (ignored)
     MarkerFile.mrk         text events → annotation_events
     BadChannels            text — one bad channel per line
     ClassFile.cls          text trial classifications (ignored)

   This reader fetches the .res4 + .meg4 over HTTP Range and serves
   windows directly from a cached `.meg4` body (small datasets) or
   range-fetches every readWindow call (large datasets). The cutoff
   is FULL_LOAD_MAX_BYTES below.

   References:
   - MNE-Python  mne/io/ctf/info.py         (CTF info-block assembly)
   - MNE-Python  mne/io/ctf/res4.py         (binary layout source of truth)
   - MNE-Python  mne/io/ctf/eeg.py          (.meg4 read path)
   - MNE-Python  mne/io/ctf/markers.py      (MarkerFile.mrk parsing)
   ============================================================ */
(function () {
  'use strict';

  const api = {};

  // CTF samples are int16 BE; 2 bytes per sample.
  const BYTES_PER_SAMPLE = 2;
  // 8-byte ASCII magic at the head of .meg4 — "MEG41CP\0" or "MEG42CP\0".
  const MEG4_HEADER_BYTES = 8;
  // Above this size we don't pre-fetch the full .meg4 — each readWindow
  // issues its own HTTP range. 64 MiB ≈ 100 channels × 30 minutes @ 1 kHz,
  // which still fits in browser memory but bumping the cutoff would have
  // us greedily holding multi-GB MEG sessions.
  const FULL_LOAD_MAX_BYTES = 64 * 1024 * 1024;

  /**
   * Parse a CTF `.res4` ArrayBuffer into a header object.
   * Synchronous entry point exposed for unit + property tests so the
   * parser can be exercised without network. Production `api.open`
   * calls this internally after HttpRange.fetchBuffer'ing the .res4.
   *
   * @param {ArrayBuffer} buf - the .res4 file as one buffer.
   * @returns {{
   *   no_samples: number, no_channels: number, sample_rate: number,
   *   epoch_time: number, no_trials: number,
   *   channels: Array<{ name: string, sensor_type: number, cal: number,
   *     io_offset: number, proper_gain: number, q_gain: number, io_gain: number }>
   * }}
   * @throws {Error} on any parse failure — never returns null.
   */
  api.read = function (buf) {
    // Delegates to the per-format helper. _ctf-res4.js is loaded into
    // globalThis.CTFRes4 by its own IIFE (in worker.js + index.html).
    if (!globalThis.CTFRes4) {
      throw new Error('ctf.read: globalThis.CTFRes4 missing — load formats/_ctf-res4.js first');
    }
    return globalThis.CTFRes4.parse(buf);
  };

  // api.open lives in Task 6.

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.CTFReader = api;
})();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit-ctf.test.mjs`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add formats/ctf.js tests/unit-ctf.test.mjs
git commit -m "feat(ctf): add ctf.js skeleton with api.read(.res4 buf)"
```

---

## Task 6: `formats/ctf.js` — `api.open(meta)` + `readWindow(start, n)` (TDD)

**Files:**
- Modify: `formats/ctf.js` (add `api.open`)
- Modify: `tests/unit-ctf.test.mjs` (append open + readWindow tests)

**Why:** The async wrapper is what viewer.js + worker.js actually call. It needs to (a) fetch and parse `.res4`, (b) probe `.meg4` length to determine total samples, (c) opportunistically fetch the rest of the bundle (markers, bad channels), (d) hand back a reader matching the cross-format contract (n_channels, sampling_frequency, …, readWindow).

- [ ] **Step 1: Write the failing tests (append to `tests/unit-ctf.test.mjs`)**

Append after the existing tests:

```js
// ─── api.open + readWindow ─────────────────────────────────────────
// Mock HttpRange so open() resolves against the local .ds/ fixture.
// The reader is told the eeg_url is .../<entities>_meg.meg4 (inside
// the bundle) — exactly what bids-recording.js's ext=ds branch builds.

const FIXTURE_DS = path.resolve('tests/fixtures/meg/ctf-tiny.ds');
const EEG_URL    = 'file://' + FIXTURE_DS + '/ctf-tiny_meg.meg4';

function installLocalHttpRange() {
  globalThis.HttpRange = {
    async probeLength(url) {
      const p = url.replace(/^file:\/\//, '');
      return fs.statSync(p).size;
    },
    async fetchBuffer(url) {
      const p = url.replace(/^file:\/\//, '');
      const b = fs.readFileSync(p);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    async rangeFetch(url, start, endIncl) {
      const p = url.replace(/^file:\/\//, '');
      const b = fs.readFileSync(p);
      const slice = b.slice(start, endIncl + 1);
      return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    },
    async fetchText(url) {
      const p = url.replace(/^file:\/\//, '');
      return fs.readFileSync(p, 'utf-8');
    },
    async fetchTextOrNull(url) {
      try { return await this.fetchText(url); }
      catch { return null; }
    },
  };
}

test('ctf: open() returns a reader-shaped object', async () => {
  installLocalHttpRange();
  const reader = await CTFReader.open({ eeg_url: EEG_URL });
  assert.ok(reader, 'open() returned null');
  assert.equal(reader.n_channels, 4);
  assert.equal(reader.sampling_frequency, 100);
  assert.equal(reader.n_samples, 250);
  assert.ok(Math.abs(reader.duration_s - 2.5) < 0.001);
  assert.equal(reader.channel_labels.length, 4);
  assert.equal(reader.channel_labels[0], 'MLT11-1609');
  assert.equal(reader.bytes_per_sample, 2);
  assert.equal(typeof reader.readWindow, 'function');
});

test('ctf: open() surfaces MarkerFile.mrk as annotation_events', async () => {
  installLocalHttpRange();
  const reader = await CTFReader.open({ eeg_url: EEG_URL });
  assert.ok(Array.isArray(reader.annotation_events));
  assert.equal(reader.annotation_events.length, 2);
  assert.equal(reader.annotation_events[0].label, 'Trigger1');
});

test('ctf: readWindow(0, 100) returns nCh Float32Arrays of length 100', async () => {
  installLocalHttpRange();
  const reader = await CTFReader.open({ eeg_url: EEG_URL });
  const win = await reader.readWindow(0, 100);
  assert.equal(win.length, reader.n_channels);
  for (let c = 0; c < win.length; c++) {
    assert.ok(win[c] instanceof Float32Array,
      `channel ${c} window must be Float32Array`);
    assert.equal(win[c].length, 100);
  }
});

test('ctf: readWindow at tail clamps to n_samples', async () => {
  installLocalHttpRange();
  const reader = await CTFReader.open({ eeg_url: EEG_URL });
  const win = await reader.readWindow(reader.n_samples - 10, 1000);
  assert.equal(win.length, reader.n_channels);
  assert.ok(win[0].length <= 10);
  assert.ok(win[0].length > 0);
});

test('ctf: readWindow applies per-channel calibration (non-zero gain)', async () => {
  installLocalHttpRange();
  const reader = await CTFReader.open({ eeg_url: EEG_URL });
  const win = await reader.readWindow(0, 50);
  // The synth fixture stamps a sine wave with amplitude ≈ 1000 ints.
  // After calibration (cal = 1e12), samples should be ≈ 1e15 in
  // magnitude — at minimum, *some* value must be finite-non-zero.
  let nonZero = 0;
  for (const v of win[0]) if (v !== 0 && Number.isFinite(v)) nonZero++;
  assert.ok(nonZero > 0, 'calibration produced all-zero or non-finite values');
});

test('ctf: open() requires meta.eeg_url', async () => {
  installLocalHttpRange();
  await assert.rejects(() => CTFReader.open({}), /eeg_url is required/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit-ctf.test.mjs`
Expected: FAIL — `CTFReader.open is not a function`.

- [ ] **Step 3: Add `api.open` + `readWindow` to `formats/ctf.js`**

Edit `formats/ctf.js` — insert this block AFTER `api.read` and BEFORE the export footer:

```js
  /**
   * Open a CTF MEG `.ds/` recording for windowed reading.
   *
   * `meta.eeg_url` must point at the `.meg4` file INSIDE the bundle
   * (e.g. `…/foo_meg.ds/foo_meg.meg4`); this is what bids-recording.js
   * builds when ext=ds. The reader derives the sibling URLs by string
   * arithmetic: replace `.meg4` with `.res4` / strip filename and
   * append `MarkerFile.mrk` / `BadChannels`.
   *
   * @param {object} meta - { eeg_url: string, … } as produced by
   *   bids-recording.js or a drag-and-drop bundle.
   * @returns {Promise<object>} reader with the cross-format contract:
   *   n_channels, sampling_frequency, n_samples, duration_s,
   *   channel_labels, bytes_per_sample, recording_start_iso,
   *   annotation_events, readWindow(start, n).
   */
  api.open = async function (meta) {
    const meg4Url = meta && (meta.eeg_url || meta.url);
    if (!meg4Url) throw new Error('ctf.open: meta.eeg_url is required (point at <entities>_meg.meg4)');

    const HttpRange = globalThis.HttpRange;
    if (!HttpRange) throw new Error('ctf.open: globalThis.HttpRange missing');

    // Derive sibling URLs. CTF guarantees the bundle's binary children
    // share the bundle basename: .meg4 → .res4 within the same .ds/.
    const res4Url = meg4Url.replace(/\.meg4$/, '.res4');
    if (res4Url === meg4Url) {
      throw new Error(`ctf.open: meta.eeg_url must end with .meg4 (got ${meg4Url})`);
    }
    const bundleDir = meg4Url.slice(0, meg4Url.lastIndexOf('/') + 1);
    const markerUrl = `${bundleDir}MarkerFile.mrk`;
    const badUrl    = `${bundleDir}BadChannels`;

    // Header first — everything else depends on it.
    const res4Buf = await HttpRange.fetchBuffer(res4Url);
    const header = api.read(res4Buf);

    // .meg4 body length tells us the true sample count when the recording
    // is continuous (no_trials=1) and gives us the per-trial chunk size
    // otherwise. We always trust the body length over no_samples *
    // no_trials because some converters write the header before knowing
    // the final sample count.
    const meg4Length = await HttpRange.probeLength(meg4Url);
    const bodyBytes = meg4Length - MEG4_HEADER_BYTES;
    if (bodyBytes < 0) {
      throw new Error(`ctf.open: .meg4 is ${meg4Length} bytes, smaller than the 8-byte magic header`);
    }
    if (bodyBytes % (header.no_channels * BYTES_PER_SAMPLE) !== 0) {
      throw new Error(
        `ctf.open: .meg4 body ${bodyBytes} bytes is not a multiple of ` +
        `${header.no_channels} channels × 2 bytes — header/body mismatch`
      );
    }
    const n_samples = bodyBytes / (header.no_channels * BYTES_PER_SAMPLE);

    // Markers + bad channels are optional. Failures are warnings, never
    // hard errors — viewer should still load the recording.
    let annotation_events = [];
    let bad_channels = [];
    try {
      const mrkText = await HttpRange.fetchTextOrNull(markerUrl);
      if (mrkText && globalThis.CTFMarker) {
        annotation_events = globalThis.CTFMarker.parseMarkerFile(mrkText);
      }
    } catch (e) {
      console.warn(`ctf.open: MarkerFile.mrk fetch failed (${e.message}); events skipped`);
    }
    try {
      const badText = await HttpRange.fetchTextOrNull(badUrl);
      if (badText && globalThis.CTFMarker) {
        bad_channels = globalThis.CTFMarker.parseBadChannels(badText);
      }
    } catch (e) {
      console.warn(`ctf.open: BadChannels fetch failed (${e.message}); bad-list skipped`);
    }

    // Pre-fetch the whole .meg4 if it fits in the in-memory budget;
    // otherwise readWindow issues a Range fetch per call. The cutoff
    // matches what eeglab.js does for inline-data .set files.
    let cachedBody = null;
    if (meg4Length <= FULL_LOAD_MAX_BYTES) {
      cachedBody = await HttpRange.fetchBuffer(meg4Url);
      // Sanity-check the magic; this is the first byte the user sees
      // out of the .meg4, so getting it wrong here means something is
      // very wrong with the bundle.
      const mag = new Uint8Array(cachedBody, 0, 8);
      const magStr = String.fromCharCode(...mag).replace(/\0.*$/, '');
      if (!/^MEG4[12]CP$/.test(magStr)) {
        throw new Error(`ctf.open: .meg4 bad magic ${JSON.stringify(magStr)} — expected MEG41CP or MEG42CP`);
      }
    }

    const channel_labels = header.channels.map(c => c.name);
    const cals    = header.channels.map(c => c.cal);
    const offsets = header.channels.map(c => c.io_offset);
    const nch     = header.no_channels;

    async function readWindow(startSample, nWin) {
      const start = Math.max(0, startSample | 0);
      if (start >= n_samples || nWin <= 0) {
        // Empty channels, length 0 — matches what edf.js returns at EOF.
        return Array.from({ length: nch }, () => new Float32Array(0));
      }
      const end = Math.min(start + nWin, n_samples);
      const nOut = end - start;

      // CTF samples are interleaved: sample[t] of channel[c] sits at
      // body byte (t * nch + c) * 2. Read the required byte range
      // (one shot via Range or one slice of the cached body), then
      // de-interleave into channel-major Float32 with calibration.
      const byteStart = MEG4_HEADER_BYTES + start * nch * BYTES_PER_SAMPLE;
      const byteEnd   = MEG4_HEADER_BYTES + end   * nch * BYTES_PER_SAMPLE - 1;
      let buf;
      if (cachedBody) {
        // cachedBody includes the 8-byte magic; slice by the absolute
        // byte offsets so the arithmetic matches the range-fetch branch.
        buf = cachedBody.slice(byteStart, byteEnd + 1);
      } else {
        buf = await HttpRange.rangeFetch(meg4Url, byteStart, byteEnd, byteEnd - byteStart + 1);
      }
      const dv = new DataView(buf);

      const out = new Array(nch);
      for (let c = 0; c < nch; c++) out[c] = new Float32Array(nOut);

      for (let t = 0; t < nOut; t++) {
        const base = t * nch * BYTES_PER_SAMPLE;
        for (let c = 0; c < nch; c++) {
          const raw = dv.getInt16(base + c * BYTES_PER_SAMPLE, false);
          out[c][t] = (raw - offsets[c]) * cals[c];
        }
      }
      return out;
    }

    return {
      n_channels:          nch,
      sampling_frequency:  header.sample_rate,
      duration_s:          n_samples / header.sample_rate,
      channel_labels,
      bytes_per_sample:    BYTES_PER_SAMPLE,
      n_samples,
      recording_start_iso: null,  // TODO: parse from .acq dataTime field
      annotation_events,
      bad_channels,
      readWindow,
    };
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit-ctf.test.mjs`
Expected: 10 passing.

- [ ] **Step 5: Commit**

```bash
git add formats/ctf.js tests/unit-ctf.test.mjs
git commit -m "feat(ctf): add api.open + readWindow with HttpRange streaming"
```

---

## Task 7: Wire CTFReader into viewer.js, worker.js, index.html

**Files:**
- Modify: `viewer.js` (around line 263-272 — `defaultReaders()`)
- Modify: `worker.js` (around lines 25-37 — `importScripts` and `READERS` map)
- Modify: `index.html` (around lines 11-21 — `<script src>` tags)

**Why:** Once the reader works in isolation, the three production entry points need to dispatch on `ext=ds`. We add the helper scripts in dependency order (helpers before ctf.js, ctf.js before viewer.js).

- [ ] **Step 1: Add `<script src>` tags to `index.html`**

Edit `index.html`. After the line `<script src="formats/fiff.js?v=2"></script>` (line 21), insert:

```html
<script src="formats/_ctf-res4.js?v=1"></script>
<script src="formats/_ctf-marker.js?v=1"></script>
<script src="formats/ctf.js?v=1"></script>
```

- [ ] **Step 2: Add CTFReader to `viewer.js` defaultReaders**

Edit `viewer.js`. Find `defaultReaders()` (around line 263). Replace its return block so it reads:

```js
  function defaultReaders() {
    return {
      set:  globalThis.EEGLABReader,
      edf:  globalThis.EDFReader,
      bdf:  globalThis.EDFReader,
      vhdr: globalThis.BrainVisionReader,
      fif:  globalThis.FiffReader,
      fiff: globalThis.FiffReader,
      ds:   globalThis.CTFReader,
    };
  }
```

- [ ] **Step 3: Add CTFReader to `worker.js` importScripts + READERS**

Edit `worker.js`. In the `importScripts(...)` call (lines 25-37), add the 3 CTF files after `'formats/fiff.js'`:

```js
importScripts(
  'formats/_buffers.js',
  'formats/_http_range.js',
  'formats/_streaming.js',
  'formats/_sidecar.js',
  'formats/_matv5.js',
  'bids-recording.js',
  'formats/eeglab.js',
  'formats/edf.js',
  'formats/brainvision.js',
  'formats/fiff.js',
  'formats/_ctf-res4.js',
  'formats/_ctf-marker.js',
  'formats/ctf.js',
  'filters.js',
);
```

Then in the `READERS` object (lines 39-46), add the `ds` entry so it reads:

```js
const READERS = {
  set:  globalThis.EEGLABReader,
  edf:  globalThis.EDFReader,
  bdf:  globalThis.EDFReader,
  vhdr: globalThis.BrainVisionReader,
  fif:  globalThis.FiffReader,
  fiff: globalThis.FiffReader,
  ds:   globalThis.CTFReader,
};
```

- [ ] **Step 4: Smoke-test that the page still boots**

Run: `node scripts/serve.mjs` in one terminal (background it or use a second terminal), then in this one:
`curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8000/index.html http://localhost:8000/formats/ctf.js http://localhost:8000/formats/_ctf-res4.js http://localhost:8000/formats/_ctf-marker.js`

Expected: `200 200 200 200` (or `0` if no server — in which case skip and rely on the unit tests).

- [ ] **Step 5: Confirm jsdom-based worker tests still pass**

Run: `node --test tests/unit-worker-jsdom.test.mjs tests/unit-worker-protocol.test.mjs tests/unit-viewer-boot.test.mjs`
Expected: all pre-existing tests pass; no new failures from the imports.

- [ ] **Step 6: Commit**

```bash
git add viewer.js worker.js index.html
git commit -m "feat(ctf): wire CTFReader into viewer, worker, index.html"
```

---

## Task 8: JSDoc + jsconfig.json — add ctf.js to the typecheck

**Files:**
- Modify: `formats/globals.d.ts` (declare CTFRes4 + CTFMarker globals)
- Modify: `jsconfig.json` (include `formats/ctf.js`)

**Why:** The other format readers run through `tsc --noEmit --checkJs` so JSDoc drift gets caught at PR time. ctf.js carries JSDoc on `api.read` + `api.open` already (Task 5+6) but won't be checked unless it's in `jsconfig.json`'s `include` list. The helpers' globals also need to be declared so ctf.js's reach-through references typecheck.

- [ ] **Step 1: Add CTFRes4 + CTFMarker to `formats/globals.d.ts`**

Edit `formats/globals.d.ts`. After the existing declarations, add:

```ts
declare const CTFRes4: any;
declare const CTFMarker: any;
```

And inside the `declare global { … }` block:

```ts
  // eslint-disable-next-line no-var
  var CTFRes4: any;
  // eslint-disable-next-line no-var
  var CTFMarker: any;
```

- [ ] **Step 2: Add `formats/ctf.js` to `jsconfig.json`**

Edit `jsconfig.json`. In the `include` array, append `"formats/ctf.js"` so it reads:

```json
"include": [
  "formats/globals.d.ts",
  "formats/edf.js",
  "formats/brainvision.js",
  "formats/eeglab.js",
  "formats/fiff.js",
  "formats/ctf.js"
],
```

- [ ] **Step 3: Run tsc --noEmit to confirm no type errors**

Run: `npx tsc --noEmit -p jsconfig.json`
Expected: no output (success — `tsc` is silent on a clean run).

If tsc reports errors in ctf.js, fix the JSDoc to match the actual return shape (most likely a mismatch in optional fields like `recording_start_iso: null`).

- [ ] **Step 4: Commit**

```bash
git add formats/globals.d.ts jsconfig.json
git commit -m "chore(ctf): add ctf.js to tsc --checkJs surface"
```

---

## Task 9: Property test for `api.read` (300+ runs)

**Files:**
- Create: `tests/prop-ctf.test.mjs`

**Why:** Property-based fuzzing on `api.read` confirms the parser refuses arbitrary bytes gracefully (regular Error, never crash/hang/RangeError). Same pattern as `tests/prop-fiff.test.mjs`. 300 runs per PR is fast (~1 s); the 10k-run soak lives in Task 10.

- [ ] **Step 1: Write the property test**

Create `tests/prop-ctf.test.mjs`:

```js
// Property-based test for the CTF MEG reader.
//
// formats/ctf.js's api.read(buf) parses a .res4 ArrayBuffer. This
// test confirms it refuses arbitrary byte input gracefully: it must
// throw a regular Error or return a plain object, never produce a
// host-level crash, NaN-laden header object, or hang.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { fc, uint8Buffer } from './_arbitraries.mjs';

const require = createRequire(import.meta.url);
require('../formats/_ctf-res4.js');
require('../formats/_ctf-marker.js');
const CTFReader = require('../formats/ctf.js');

test('property: ctf.read never crashes on arbitrary byte input', () => {
  fc.assert(
    fc.property(uint8Buffer, (bytes) => {
      // api.read takes ArrayBuffer; uint8Buffer yields Uint8Array.
      const ab = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
      try {
        const h = CTFReader.read(ab);
        // If the parser returns at all, it must be a plain object
        // with sane numeric fields. Downstream consumers dereference
        // .no_channels / .sample_rate without null-checking.
        assert.ok(h && typeof h === 'object',
          'read() returned non-object on accepted input');
        assert.ok(Number.isFinite(h.no_channels) && h.no_channels > 0);
        assert.ok(Number.isFinite(h.sample_rate) && h.sample_rate > 0);
      } catch (e) {
        if (!(e instanceof Error)) {
          throw new Error(`Non-Error thrown: ${typeof e}: ${e}`);
        }
      }
      return true;
    }),
    { numRuns: 300 },
  );
});
```

- [ ] **Step 2: Run the test**

Run: `node --test tests/prop-ctf.test.mjs`
Expected: PASS in <2 s. If a counterexample shrinks out, paste it back as an examples entry and commit a fix in `_ctf-res4.js`.

- [ ] **Step 3: Commit**

```bash
git add tests/prop-ctf.test.mjs
git commit -m "test(ctf): property test for api.read (300 runs per PR)"
```

---

## Task 10: Add CTF target to the nightly fuzz suite (10k runs)

**Files:**
- Modify: `tests/fuzz-formats.test.mjs`

**Why:** The per-PR `prop-*` tests cap at 100-300 runs; the nightly fuzz job hits 10k mutated-corpus rounds. CTF gets added to that pool so any shrunk counterexample shows up the morning after a parser change, not weeks later in the wild.

- [ ] **Step 1: Append a CTF block to `tests/fuzz-formats.test.mjs`**

Edit `tests/fuzz-formats.test.mjs`. After the FIFF block at the end, append:

```js

// ---------------------------------------------------------------------
// CTF MEG
// ---------------------------------------------------------------------
//
// formats/ctf.js's api.read parses a .res4 ArrayBuffer. The synth
// fixture under tests/fixtures/meg/ctf-tiny.ds/ctf-tiny_meg.res4 seeds
// the corpus — small (~7 KB) so the mutator can still reach realistic
// byte distributions across 10k rounds.

// Load helpers so globalThis.CTFRes4 / CTFMarker resolve when ctf.js
// is required. _bootstrap.mjs doesn't include them yet (they're new
// in the CTF reader plan) so we side-load here.
require('../formats/_ctf-res4.js');
require('../formats/_ctf-marker.js');
const CTFReader = require('../formats/ctf.js');

test('fuzz: CTF read survives 10k corpus-mutated rounds', () => {
  fc.assert(
    fc.property(corpusFuzzedBuffer([
      'meg/ctf-tiny.ds/ctf-tiny_meg.res4',
    ]), (bytes) => {
      const ab = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
      try {
        const h = CTFReader.read(ab);
        if (h !== undefined) {
          assert.ok(h && typeof h === 'object',
            'read() returned a non-object on accepted input');
        }
      } catch (e) {
        if (!(e instanceof Error)) {
          throw new Error(`Non-Error thrown: ${typeof e}: ${e}`);
        }
      }
      return true;
    }),
    { numRuns: FUZZ_RUNS },
  );
});
```

- [ ] **Step 2: Run the new block in isolation**

Run: `node --test tests/fuzz-formats.test.mjs --test-name-pattern='CTF'`
Expected: PASS in <15 s.

- [ ] **Step 3: Commit**

```bash
git add tests/fuzz-formats.test.mjs
git commit -m "test(ctf): add CTF target to nightly 10k-run fuzz suite"
```

---

## Task 11: API-surface snapshot test for CTFReader

**Files:**
- Modify: `tests/unit-api-surface.test.mjs`

**Why:** The cross-module contract test snapshots every public reader's exported keys. Adding CTFReader catches future drift (e.g. someone renaming `api.open` to `api.load` will fail this test, not just the unit tests).

- [ ] **Step 1: Register the expected CTF surface**

Edit `tests/unit-api-surface.test.mjs`. In the `EXPECTED` object (around lines 37-88), add the CTF entry after the FIFF one:

```js
  '../formats/ctf.js': [
    'open',
    'read',
  ],
```

- [ ] **Step 2: Extend the cross-module test to include CTF**

In the same file, the `test('api-surface: format readers share the open() return shape', …)` block ends by checking the FIFF reader's keys. Append a parallel CTF check before its closing brace:

```js
  // CTF — synth .ds/ fixture
  require('../formats/_ctf-res4.js');
  require('../formats/_ctf-marker.js');
  const CTFReader = require('../formats/ctf.js');
  const ctfReader = await CTFReader.open({
    eeg_url: 'file://' + process.cwd() + '/tests/fixtures/meg/ctf-tiny.ds/ctf-tiny_meg.meg4',
  });
  for (const k of REQUIRED_KEYS) {
    assert.ok(k in ctfReader, `ctf reader missing required key: ${k}`);
  }
  assert.equal(typeof ctfReader.readWindow, 'function',
    'ctf reader must expose readWindow function');
```

- [ ] **Step 3: Run the test to confirm it passes**

Run: `node --test tests/unit-api-surface.test.mjs`
Expected: all api-surface tests pass, including the new CTF check.

- [ ] **Step 4: Commit**

```bash
git add tests/unit-api-surface.test.mjs
git commit -m "test(ctf): snapshot CTFReader public API + add to cross-reader contract"
```

---

## Task 12: Add `formats/ctf.js` to Stryker mutation scope

**Files:**
- Modify: `stryker.conf.json`

**Why:** Stryker mutates each line of the listed files and re-runs tests; survivors flag under-tested branches. Per the spec we only add `formats/ctf.js` (the public api) — `_ctf-res4.js` and `_ctf-marker.js` are tested through that public api and would inflate runtime without lifting confidence.

- [ ] **Step 1: Edit `stryker.conf.json`**

In `stryker.conf.json`, find the `commandRunner.command` string (around line 8) and append the three new CTF test files to the `node --test` arg list, before the closing quote:

```
... tests/unit-worker-roundtrip.test.mjs tests/unit-ctf.test.mjs tests/unit-ctf-res4.test.mjs tests/unit-ctf-marker.test.mjs tests/unit-ctf-bids-path.test.mjs"
```

Also in the same file, find the `mutate` array (lines 11-17) and append `"formats/ctf.js"` so it reads:

```json
"mutate": [
  "traces.js",
  "filters.js",
  "bids-recording.js",
  "viewer.js",
  "worker.js",
  "formats/ctf.js"
],
```

Update the `_comment` field's "Scope" sentence to mention `formats/ctf.js` (CTF reader).

- [ ] **Step 2: Run a one-file mutation pass to confirm config is valid**

Run: `npx stryker run --mutate 'formats/ctf.js' --concurrency=2`
Expected: report appears in `reports/mutation/mutation.html`. Aim for survivors ≤ 30%; if survivors exceed 50%, add a focused test to kill them and re-run.

- [ ] **Step 3: Commit**

```bash
git add stryker.conf.json
git commit -m "test(ctf): add formats/ctf.js to Stryker mutation scope"
```

---

## Task 13: Update audit script to include `.ds` extension

**Files:**
- Modify: `scripts/audit-100-datasets.mjs`

**Why:** The audit's `SUPPORTED_EXTS` set decides which file extensions count as "viewer-loadable" — adding `'ds'` is the one-line change that lets the script credit CTF datasets now that the reader exists.

- [ ] **Step 1: Add `'ds'` to `SUPPORTED_EXTS`**

Edit `scripts/audit-100-datasets.mjs`. Find the line:

```js
const SUPPORTED_EXTS = new Set(['edf', 'bdf', 'set', 'vhdr', 'fif', 'snirf']);
```

Replace with:

```js
const SUPPORTED_EXTS = new Set(['edf', 'bdf', 'set', 'vhdr', 'fif', 'snirf', 'ds']);
```

- [ ] **Step 2: Adjust the recording-picker regex if needed**

In the same file, find `pickRecording()` (around line 97-109). The regex `/${datatype}/[^/]+_${datatype}\.([a-z0-9]+)$/` requires the key to END with `.<ext>`. CTF bundles end with `.ds/`, so when S3 lists them they appear as the *directory* key (no trailing slash) PLUS the inner files. Confirm by adding a sanity test:

```bash
curl -s 'https://s3.amazonaws.com/openneuro.org/?list-type=2&prefix=ds003633/sub-01/ses-movie/meg/&max-keys=20' | head -40
```

Expected: keys like `ds003633/sub-01/ses-movie/meg/sub-01_ses-movie_task-movie_run-01_meg.ds/sub-01_ses-movie_task-movie_run-01_meg.meg4`. Each .ds/ surfaces as multiple keys (one per inner file) — the regex needs to accept the .meg4 child as evidence of a CTF dataset.

If the existing regex matches `.meg4` (it does — `.meg4` is a `[a-z0-9]+` extension), then a `ext=meg4` would be filed in `SUPPORTED_EXTS`. Instead, post-process the matched key: when ext is `meg4`, treat the dataset as `ext='ds'` and store the parent `.ds/` directory path as the canonical URL. Replace `pickRecording` with:

```js
function pickRecording(keys, datatype) {
  // From a list of S3 keys, pick the first one whose path matches:
  //   sub-X/[ses-Y/]<datatype>/<entities>_<suffix>.<ext>
  // where ext is a viewer-supported extension. For CTF (.ds/ bundles),
  // S3 lists each inner file separately — we match the .meg4 child and
  // canonicalise back to ext='ds' so the viewer URL points at the
  // bundle, not the inner binary directly.
  const re = new RegExp(`/${datatype}/[^/]+_${datatype}\\.([a-z0-9]+)(?:/[^/]+_${datatype}\\.meg4)?$`, 'i');
  for (const key of keys) {
    const m = re.exec(key);
    if (!m) continue;
    let ext = m[1].toLowerCase();
    let canonicalKey = key;
    // CTF bundle: the matched ext is 'ds' (when we hit the directory
    // path itself) or the recursive group matched (when we hit a child
    // file). In the child-file case `key` ends with `.ds/<child>.meg4`;
    // we want the bundle's *inner .meg4* as the URL so the viewer's
    // ext=ds route resolves correctly.
    if (key.includes('.ds/')) {
      ext = 'ds';
      // Keep canonicalKey pointing at the meg4 child — that's what
      // bids-recording.js's ext=ds branch builds.
    }
    if (SUPPORTED_EXTS.has(ext)) {
      return { key: canonicalKey, ext };
    }
  }
  return null;
}
```

- [ ] **Step 3: Smoke-test the audit on one known CTF dataset**

Run:
```bash
node -e "
import('./scripts/audit-100-datasets.mjs').then(async () => {
  // The module's main() runs immediately on import — skip in this smoke.
});
" 2>&1 | head -5
```

Better: write a one-liner direct probe to confirm the URL the audit would build is reachable via the existing CDN:

```bash
curl -sI 'https://cdn.eegdash.org/ds003633/sub-01/ses-movie/meg/sub-01_ses-movie_task-movie_run-01_meg.ds/sub-01_ses-movie_task-movie_run-01_meg.meg4' | head -1
```

Expected: `HTTP/2 200` or `HTTP/2 206`. (If 404, the dataset structure differs and the regex/canonicalisation needs tweaking; pick another CTF dataset from the audit doc's list.)

- [ ] **Step 4: Commit**

```bash
git add scripts/audit-100-datasets.mjs
git commit -m "fix(audit): credit CTF .ds/ bundles toward the loadable count"
```

---

## Task 14: Re-run the audit and capture the new numbers

**Files:**
- Re-runs: `scripts/audit-100-datasets.mjs` (no edit — already updated in Task 13)
- Generated: `scripts/audit-100-datasets.json` (overwritten)

**Why:** The whole point of the project. Confirms that adding CTF actually moves the headline number, and gives us the JSON snapshot to point at in Task 15's doc update.

- [ ] **Step 1: Run the full audit**

Run: `node scripts/audit-100-datasets.mjs 2>&1 | tail -40`
Expected: ~5-10 min runtime; final block prints:

```
=== AUDIT SUMMARY ===
Catalog total:  800 (or current)
Sampled:        100
Verdict counts:
  loadable                 96  (96.0%)   ← UP from 80
  ...
Loadable rate by datatype:
  meg          22/27  (≥80%)              ← UP from 11/27 (40.7%)
  eeg          ...
  ieeg         3/3   (100%)
```

If MEG loadability is below 80%, investigate which datasets still failed: the `audit-100-datasets.json` contains per-dataset verdicts. Common cause: the dataset uses a non-standard subdirectory layout that `pickRecording`'s regex still misses.

- [ ] **Step 2: Save the new JSON output as a comparison snapshot**

```bash
cp scripts/audit-100-datasets.json scripts/audit-100-datasets-after-ctf.json
```

This keeps the pre/post snapshots both available for diffing in the doc update.

- [ ] **Step 3: Commit the new JSON snapshot**

```bash
git add scripts/audit-100-datasets.json scripts/audit-100-datasets-after-ctf.json
git commit -m "audit: re-run after CTF reader landed (~96% loadable, ~80%+ MEG)"
```

---

## Task 15: Update audit doc with new numbers + close out

**Files:**
- Modify: `docs/audit-100-datasets-2026-05-21.md`

**Why:** The audit document is the project's headline doc; future readers need to see the CTF win and the new ceiling. We append a dated update rather than rewriting history.

- [ ] **Step 1: Append the "After CTF reader" section**

Edit `docs/audit-100-datasets-2026-05-21.md`. After the existing "What would push the number to 95%+" section, append a new section:

```markdown

## Update — CTF MEG reader landed (2026-05-21)

CTF support shipped via `formats/ctf.js` + `formats/_ctf-res4.js` +
`formats/_ctf-marker.js`. URL plumbing in `bids-recording.js`
routes `ext=ds` through `<entities>_meg.ds/<entities>_meg.meg4`
inside the bundle. See plan: `docs/superpowers/plans/2026-05-21-ctf-meg-reader.md`.

### New headline

**[N] of 100 datasets are loadable in the viewer.**  (UP from 80)

| Datatype | Loadable | Total in sample | % | Δ vs pre-CTF |
|---|---:|---:|---:|---:|
| iEEG | 3 | 3 | **100.0%** | — |
| EEG | [N] | 70 | **[%]** | — |
| MEG | [N] | 27 | **[%]** | **+[Δ pp]** |

(Numbers from `scripts/audit-100-datasets-after-ctf.json`.)

### CTF MEG datasets that now load (sample)

```
ds003633  meg   sub-01   .../sub-01_ses-movie_task-movie_run-01_meg.ds/...
ds000117  meg   sub-01   .../sub-01_ses-meg_task-facerecognition_run-01_meg.ds/...
ds002001  meg   sub-01   .../...
```

(Full list in `scripts/audit-100-datasets-after-ctf.json`.)

### Remaining failure modes

- A small handful of CTF datasets still fail — investigation needed:
  - Datasets where the `.ds/` bundle name does NOT match the
    entity-prefix convention (rare; some Yokogawa-converted CTF
    recordings stash files at non-canonical names).
  - Datasets where the audit's S3 list returns the .ds/ directory's
    inner files in an order that hides the .meg4 from `pickRecording`.

These edge cases are tracked as follow-ups, not blockers.
```

Replace the bracketed `[N]` / `[%]` / `[Δ pp]` placeholders with the actual numbers from `scripts/audit-100-datasets.json`'s `verdictCounts` + `loadable rate by datatype` block (Task 14 step 1).

- [ ] **Step 2: Run the full test suite as a final smoke**

Run: `npm run test:unit 2>&1 | tail -20`
Expected: 0 failures. Catches any cross-test breakage from the changes in this plan (especially Task 4's `parsePhysioUrl` edit which could in theory disturb other URL parsers).

- [ ] **Step 3: Commit the doc update**

```bash
git add docs/audit-100-datasets-2026-05-21.md
git commit -m "docs(audit): record CTF reader impact on dataset loadability"
```

- [ ] **Step 4: Final summary commit (optional)**

If anything else changed (e.g. README mentions of supported formats), commit those too. Otherwise, the plan is complete.

---

## Self-Review

**Spec coverage:** All 13 required deliverables are mapped to tasks — fixture (T1), `_ctf-res4.js` (T2), `_ctf-marker.js` (T3), `ctf.js` `api.read` (T5), `ctf.js` `api.open` + `readWindow` (T6), viewer/worker wiring (T7), `bids-recording.js` ext=ds (T4), JSDoc + jsconfig (T8), unit tests (T2/T3/T5/T6), property test (T9), fuzz test (T10), API-surface snapshot (T11), Stryker scope (T12), audit script update (T13), audit re-run (T14), audit doc update (T15). 15 tasks total, in spec's "12-15 tasks" range.

**Placeholder scan:** No TBDs. The `[N]` / `[%]` placeholders in Task 15 step 1 are explicitly flagged for the engineer to fill from the audit JSON (Task 14 step 1 prints the values they need).

**Type consistency:** Reader fields follow the FIFF/EDF/EEGLAB contract: `n_channels`, `sampling_frequency`, `duration_s`, `channel_labels`, `bytes_per_sample`, `n_samples`, `recording_start_iso`, `annotation_events`, `readWindow`. The `bad_channels` field is CTF-only (matches `viewer.js`'s existing optional handling — see `deriveBadMask`). `api.read` returns the same header shape across `_ctf-res4.js` and `ctf.js` (the latter just delegates). `parsePhysioUrl` returns `{ dir, prefix, suffix, ext: 'ds' }` for CTF — same field set as the EEG/MEG case, which keeps `bids-recording.js`'s downstream callers (`loadRecordingMetadata`, sidecar walker) happy.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-21-ctf-meg-reader.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
