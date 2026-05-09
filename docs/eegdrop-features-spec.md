# eegdrop → eegdash-viewer feature incorporation spec

**Audience.** Two readers: (a) a human implementer who picks up a feature and
ships it, and (b) a *validator subagent* — a smaller LLM that has only this
file and a shell, and must answer "does feature F-XX work?" by running the
embedded commands and comparing outputs to the embedded predicates.

**Self-contained validation contract.** Every feature block below has six
fixed sections in the same order. The validator subagent reads them
mechanically and never has to interpret prose:

```
1. ID + ONE-LINE GOAL
2. USER STORY (what the user does, what they see)
3. DOM CONTRACT (exact selectors / text / classes that must exist when the
   feature is working — no ambiguity)
4. PRE-IMPLEMENTATION CHECK (a grep / file-exists predicate that tells the
   validator "the code hasn't been written yet, skip functional tests")
5. FUNCTIONAL VALIDATION (exact shell commands to run + exact expected
   stdout / exit status — copy-paste runnable, no improvisation)
6. EVIDENCE ARTIFACT (a file path the validator must produce so a human can
   audit the run after the fact: screenshot, JSON dump, or log)
```

**Validator decision tree** (the *only* logic the subagent runs):

```
for feature F in spec:
    if PRE-IMPLEMENTATION CHECK fails:
        emit  F: NOT-IMPLEMENTED   (skip remaining steps, no error)
        continue
    run FUNCTIONAL VALIDATION command
    if exit code != 0 or stdout doesn't match expected:
        emit  F: FAIL  +  copy of stdout + path to EVIDENCE ARTIFACT
        continue
    if EVIDENCE ARTIFACT path doesn't exist after run:
        emit  F: FAIL (no evidence)
        continue
    emit  F: PASS  +  path to EVIDENCE ARTIFACT
```

The subagent is **not** allowed to invent additional checks, edit code, or
"improve" tests. If the feature behaves correctly but the embedded predicate
disagrees, that's a spec bug — report it and move on.

---

## Project conventions the validator must respect

- **Static server**: the viewer is loaded over HTTP at `http://localhost:8011`.
  Playwright's config (`playwright.config.mjs`) auto-starts
  `python3 -m http.server 8011` from the repo root. `file://` won't work
  (CORS for OpenNeuro fetches blocks it).
- **Node ≥ 20** for the Node test harness (`npm test`).
- **Playwright** (`npx playwright test …`) for browser-driven evidence.
  Install browsers once with `npx playwright install chromium` before the
  first run.
- **No build step.** The viewer is vanilla JS loaded via `<script>` tags
  from `index.html`. Any new module must follow the same pattern: a
  classic script that attaches its public API to `window.<Name>` and
  `module.exports` if `module` is defined (see `viewer.js:489-490` for
  the canonical wrapper).
- **Test fixture for everything below**:
  `https://s3.amazonaws.com/openneuro.org/ds002893/sub-001/eeg/sub-001_task-AuditoryVisualShift_run-01_eeg.set`
  — 36-channel, 250 Hz, ~125 MB on disk but only ~14 KB needed for one
  10 s window via range fetch. This is the same dataset the existing
  e2e suite uses (`tests/e2e/viewer.spec.mjs:11`).

When a feature requires an EDF/EDF+/BDF dataset instead of EEGLAB:

- EDF: `https://s3.amazonaws.com/openneuro.org/ds002034/sub-001/eeg/sub-001_task-rest_eeg.edf`
- BrainVision: `https://s3.amazonaws.com/openneuro.org/ds002336/sub-01/ses-01/eeg/sub-01_ses-01_task-rest_run-01_eeg.vhdr`

Each feature's FUNCTIONAL VALIDATION block names which fixture it uses.

---

## Global evidence layout

All evidence files land under `tests/evidence/<feature-id>/`:

```
tests/evidence/F01-cursor-readout/
    screenshot.png         # visual proof
    dom-snapshot.json      # selector → text dump at moment of capture
    console.log            # full browser console output
```

Validator must `mkdir -p` the per-feature directory before running the
playwright spec. The Playwright tests below all write to that path.

---

# Feature catalogue

The features are ordered by recommended implementation priority (cheapest +
highest UX value first). Validator runs them in any order — there are no
inter-feature dependencies in the validation contract.

---

## F01 — Cursor readout (time, channel, amplitude)

**Goal.** When the mouse hovers the trace canvas, a non-modal info bar at
the bottom of the canvas displays the precise time, the channel under the
cursor, and the amplitude value at that sample. This is the single biggest
"professional EEG viewer" tell currently missing from eegdash-viewer.

**User story.**
> A researcher pans through a recording, sees a spike on Cz at ~12.3 s,
> and wants to know its exact amplitude. They move the mouse to the spike;
> a readout at the bottom of the canvas updates in real time:
> `t = 12.345 s · Cz · −34.2 µV`. They drag the mouse vertically across
> channels and the readout updates the channel name and value continuously.

**DOM contract.**

When the viewer is loaded with a recording AND the mouse has moved over
the canvas at least once:

| Selector              | Required state                                                  |
| --------------------- | --------------------------------------------------------------- |
| `#cursor-info-bar`    | exists, `display !== 'none'`, has 3 child `<span>`s             |
| `.cursor-time`        | text matches `/^t = -?\d+\.\d{3}\s*s$/`                         |
| `.cursor-channel`     | text matches one of the labels in `#ch-list .ch-name`           |
| `.cursor-value`       | text matches `/^-?\d+\.\d{1,2}\s*(µV|mV|V|au)$/`                |
| `#cursor-dot`         | exists, `position: absolute`, top/left set to numeric pixels    |

When no mouse has moved over the canvas yet, `#cursor-info-bar` may be
hidden (`display: none` or `hidden` attr), but the elements must still
exist in the DOM so we can detect "feature wired" vs "feature absent".

The implementation should follow the eegdrop class names already documented
in `assets/index-BdhgSB4l.css`: `.cursor-info-bar`, `.cursor-channel`,
`.cursor-dot`. Reuse them so the visual contract matches the reference.

**PRE-IMPLEMENTATION CHECK.**

```bash
grep -rln "cursor-info-bar" \
  /Users/bruaristimunha/Projects/eegdash-viewer/index.html \
  /Users/bruaristimunha/Projects/eegdash-viewer/viewer.js \
  /Users/bruaristimunha/Projects/eegdash-viewer/traces.js \
  /Users/bruaristimunha/Projects/eegdash-viewer/styles.css \
  2>/dev/null
```
- If exit code is non-zero (no matches): emit `F01: NOT-IMPLEMENTED` and stop.
- If exit code is zero: continue to FUNCTIONAL VALIDATION.

**FUNCTIONAL VALIDATION.**

```bash
mkdir -p tests/evidence/F01-cursor-readout
npx playwright test tests/e2e/eegdrop-features.spec.mjs -g "F01:" \
  --reporter=line 2>&1 | tee tests/evidence/F01-cursor-readout/run.log
```

Expected: exit code `0` AND `run.log` contains the line
`1 passed` (Playwright's standard line reporter format).

If exit code is non-zero, the test failure message and a screenshot will be
in `test-results/`. Copy `test-results/**/F01*.png` (if any) into the
evidence dir.

**Test logic the Playwright spec must implement** (the spec file itself is
F00 — the test scaffolding feature; see end of doc):

1. Navigate to the test fixture URL.
2. Wait for `#stage-caption` visible (recording loaded).
3. `page.mouse.move(canvasMidX, canvasMidY)` → wait 200 ms for any RAF debounce.
4. Assert `#cursor-info-bar` is visible.
5. Assert `.cursor-time` text matches the regex.
6. Assert `.cursor-channel` text is in `await page.locator('#ch-list .ch-name').allTextContents()`.
7. Assert `.cursor-value` text matches the regex.
8. Move mouse to a different Y coordinate; assert `.cursor-channel` text changed.
9. `page.screenshot({ path: 'tests/evidence/F01-cursor-readout/screenshot.png', clip: <canvas bbox> })`.
10. Dump DOM snapshot to `tests/evidence/F01-cursor-readout/dom-snapshot.json`:
    ```json
    {
      "cursor_time": "...", "cursor_channel": "...", "cursor_value": "...",
      "cursor_dot_top_px": 123, "cursor_dot_left_px": 456
    }
    ```

**EVIDENCE ARTIFACT.**

```
tests/evidence/F01-cursor-readout/screenshot.png
tests/evidence/F01-cursor-readout/dom-snapshot.json
tests/evidence/F01-cursor-readout/run.log
```

All three must exist and be non-empty (`-s` test) for the validator to
emit PASS.

**Failure modes to look for in `run.log`** (the validator may surface these
as hints when emitting FAIL):

- `TimeoutError waiting for #cursor-info-bar`: feature is wired but the
  info bar never gets `display: block` — implementation bug in the
  mousemove handler.
- `Expected /^t = .../ but got "NaN"`: pixel-to-time conversion uses a
  zero-divide path, probably `canvas.clientWidth - PAD_LEFT - PAD_RIGHT`
  is zero before first ResizeObserver tick.
- `Channel text "Ch37" not in known labels`: the row-index → label lookup
  is off by one (forgot the bad-mask offset).

---

## F02 — Keyboard shortcuts overlay

**Goal.** Pressing `?` (or `h`) opens a modal overlay listing every
keyboard binding the viewer supports. Pressing `Escape` or clicking a close
button closes it. This makes the viewer self-documenting; today the only
hint is one line of static help text in the left rail.

**User story.**
> A new user opens the viewer for the first time, presses `?`, and sees a
> labelled grid of keyboard shortcuts: arrows pan, Page keys jump a full
> window, +/− zoom amplitude, [/] change timebase, b toggles bad channel
> under cursor, i opens metadata, etc. Pressing Escape returns them to
> the recording.

**DOM contract.**

Before opening: `#shortcuts-overlay` must exist with attribute `hidden` (or
class `hidden`) so the overlay markup is statically present in `index.html`
(easier to validate without timing).

After pressing `?` (when no `<input>`/`<select>` is focused):

| Selector                          | Required state                                  |
| --------------------------------- | ----------------------------------------------- |
| `#shortcuts-overlay`              | exists, `hidden` attr removed, `display !== 'none'`  |
| `.overlay-backdrop`               | exists inside the overlay                       |
| `.overlay-panel`                  | exists inside the overlay                       |
| `.overlay-panel h2`               | text === `Keyboard Shortcuts`                   |
| `.overlay-close`                  | exists, role=button or `<button>`               |
| `.shortcut-key`                   | at least 8 distinct `<kbd>`-like elements       |

The shortcut rows must include at minimum these labels (substring match on
the row text — the prose can vary, the kbd content cannot):

| Required `.shortcut-key` text | Required adjacent description (substring)     |
| ----------------------------- | --------------------------------------------- |
| `←` and `→`                   | "Pan" or "page" or "Previous"/"Next"          |
| `PgUp` and `PgDn` (or `Page Up` / `Page Down`) | "page" or "window"            |
| `+` and `−` (or `-`)          | "amplitude" or "zoom"                         |
| `[` and `]`                   | "timebase" or "window"                        |
| `b`                           | "bad" channel                                 |
| `i`                           | "metadata" or "info"                          |
| `?`                           | "help" or "shortcut"                          |
| `Esc` or `Escape`             | "close"                                       |

After pressing `Escape`: `#shortcuts-overlay` is hidden again.

**PRE-IMPLEMENTATION CHECK.**

```bash
grep -ln "shortcuts-overlay\|Keyboard Shortcuts" \
  /Users/bruaristimunha/Projects/eegdash-viewer/index.html \
  /Users/bruaristimunha/Projects/eegdash-viewer/viewer.js \
  /Users/bruaristimunha/Projects/eegdash-viewer/styles.css \
  2>/dev/null
```
Non-zero exit → `F02: NOT-IMPLEMENTED`.

**FUNCTIONAL VALIDATION.**

```bash
mkdir -p tests/evidence/F02-shortcuts-overlay
npx playwright test tests/e2e/eegdrop-features.spec.mjs -g "F02:" \
  --reporter=line 2>&1 | tee tests/evidence/F02-shortcuts-overlay/run.log
```
Expected exit code `0`, log contains `1 passed`.

Test logic:

1. Goto fixture URL, wait for `#stage-caption`.
2. Assert `#shortcuts-overlay` exists in DOM (`page.locator('#shortcuts-overlay').count() === 1`).
3. Assert it is hidden (`isHidden()` true).
4. `page.keyboard.press('?')`.
5. Assert visible.
6. Assert `.overlay-panel h2` text === `Keyboard Shortcuts`.
7. Collect all `.shortcut-key` text contents; assert each required key from
   the table above is present (case-insensitive substring match).
8. Screenshot to `tests/evidence/F02-shortcuts-overlay/screenshot.png`.
9. Dump the captured shortcut rows to
   `tests/evidence/F02-shortcuts-overlay/shortcuts.json` — an array of
   `{ key: "…", description: "…" }`.
10. `page.keyboard.press('Escape')`; assert hidden again.

**EVIDENCE ARTIFACT.**

```
tests/evidence/F02-shortcuts-overlay/screenshot.png
tests/evidence/F02-shortcuts-overlay/shortcuts.json
tests/evidence/F02-shortcuts-overlay/run.log
```

---

## F03 — File metadata overlay

**Goal.** Pressing `i` opens an overlay showing the full sidecar-derived
metadata for the loaded recording: BIDS provenance (which sidecars were
resolved and from which paths), recording info (sampling frequency,
channel count, duration, samples, format), channel table (name, type,
units, status). Closes with `Escape`.

**User story.**
> A user loads an OpenNeuro recording, wants to confirm what `_eeg.json`
> the BIDS inheritance walk picked up, the patient/recording date, the
> physical units of the signal. They press `i`, see a structured metadata
> panel, copy/paste the sidecar URL into a browser tab to inspect the
> raw JSON.

**DOM contract.**

Before opening: `#metadata-overlay` exists with `hidden`.

After pressing `i`:

| Selector                                     | Required state                              |
| -------------------------------------------- | ------------------------------------------- |
| `#metadata-overlay`                          | not hidden                                  |
| `#metadata-overlay .overlay-panel h2`        | text === `File Information`                 |
| `#metadata-overlay table.metadata-table`     | exists, ≥ 1 row                             |
| `#metadata-overlay .meta-section-recording`  | contains text `Sample rate`, `Duration`, `Format`, `Channels` |
| `#metadata-overlay .meta-section-bids`       | contains at least one `<code>` with a URL containing `s3.amazonaws.com` (when loaded from OpenNeuro) |
| `#metadata-overlay .meta-section-channels table` | row count === reader's `n_channels`     |

Required key/value pairs visible (in `.meta-section-recording`, as
`<td>key</td><td>value</td>` rows):

| Key            | Value predicate (regex)                       |
| -------------- | --------------------------------------------- |
| Sample rate    | `/^\d+(\.\d+)?\s*Hz$/`                        |
| Channels       | `/^\d+$/`                                     |
| Duration       | `/^\d+(\.\d+)?\s*s$/`                         |
| Format         | one of `EDF`, `BDF`, `SET`, `VHDR`            |
| Samples        | `/^\d+$/`                                     |

Closes on `Escape` AND on click on `.overlay-close`.

**PRE-IMPLEMENTATION CHECK.**

```bash
grep -ln "metadata-overlay\|File Information" \
  /Users/bruaristimunha/Projects/eegdash-viewer/index.html \
  /Users/bruaristimunha/Projects/eegdash-viewer/viewer.js \
  2>/dev/null
```
Non-zero → `F03: NOT-IMPLEMENTED`.

**FUNCTIONAL VALIDATION.**

```bash
mkdir -p tests/evidence/F03-metadata-overlay
npx playwright test tests/e2e/eegdrop-features.spec.mjs -g "F03:" \
  --reporter=line 2>&1 | tee tests/evidence/F03-metadata-overlay/run.log
```
Expected exit `0`, log contains `1 passed`.

Test logic:

1. Goto fixture URL, wait for stage caption + `#ch-list .ch-row` count > 0.
2. Press `i`.
3. Assert `#metadata-overlay` visible, `h2` text matches.
4. For each required key in the table, find the row, capture the value text,
   assert regex match.
5. Channel-section row count === `await page.locator('#ch-list .ch-row').count()`.
6. Screenshot.
7. Dump captured key/value pairs to
   `tests/evidence/F03-metadata-overlay/metadata.json`.
8. Press `Escape`; assert hidden.
9. Press `i` again, click `.overlay-close`; assert hidden.

**EVIDENCE ARTIFACT.**

```
tests/evidence/F03-metadata-overlay/screenshot.png
tests/evidence/F03-metadata-overlay/metadata.json
tests/evidence/F03-metadata-overlay/run.log
```

---

## F04 — Click-to-toggle bad channel

**Goal.** Clicking a channel row in `#ch-list` toggles its bad status. A
bad channel renders with a visible bad-dot in the row AND its trace
greys out (or strikes through) on the canvas. Pressing `b` toggles the
channel currently under the cursor (depends on F01).

**User story.**
> A user spots a flatlined channel that's saturating the gain. They click
> its name in the left rail; the row gets a red dot and the trace fades
> to grey. They click again to undo. They hover a different bad channel
> and press `b` to mark it without leaving the canvas.

**DOM contract.**

Initially, channel rows that have `status === 'bad'` in the
`_channels.tsv` already render `.bad-dot` (per `viewer.js:73`). The new
contract:

| Action / state                                          | Required result                                 |
| ------------------------------------------------------- | ----------------------------------------------- |
| `.ch-row` is clickable (`cursor: pointer` in computed style) | always true                                |
| Click a `.ch-row` without `.bad-dot`                    | row gains `.bad-dot` child                      |
| Click a `.ch-row` with `.bad-dot`                       | `.bad-dot` removed                              |
| `.ch-row.is-bad` class on a bad row                     | optional but recommended for canvas styling     |
| Canvas pixel-color check: at row's Y band, mean R/G/B   | when bad: closer to text-muted grey than to the active trace color (delta ≥ 30 in R) |
| Press `b` while cursor is over a non-bad channel        | that channel becomes bad                        |
| Press `b` again                                         | reverts                                         |

**PRE-IMPLEMENTATION CHECK.**

```bash
grep -n "is-bad\|toggleBad\|toggle-bad" \
  /Users/bruaristimunha/Projects/eegdash-viewer/viewer.js \
  /Users/bruaristimunha/Projects/eegdash-viewer/traces.js \
  2>/dev/null
```
Non-zero → `F04: NOT-IMPLEMENTED`.

**FUNCTIONAL VALIDATION.**

```bash
mkdir -p tests/evidence/F04-toggle-bad
npx playwright test tests/e2e/eegdrop-features.spec.mjs -g "F04:" \
  --reporter=line 2>&1 | tee tests/evidence/F04-toggle-bad/run.log
```
Expected exit `0`, log contains `1 passed`.

Test logic:

1. Goto fixture URL, wait for `#ch-list .ch-row` count >= 30.
2. Pick row index 5 (zero-based). Capture its `.bad-dot` count (0 or 1).
3. Click the row. Assert `.bad-dot` count flipped.
4. Capture canvas image data over the row's Y band (use the same band-Y
   computation as `traces.js`); assert mean R-channel changed by ≥ 20
   compared to a baseline image captured before the click.
5. Click again. Assert `.bad-dot` flipped back.
6. (If F01 implemented) Move mouse over a different channel; press `b`;
   assert that channel toggled.
7. Screenshot showing one channel marked bad.
8. Dump `{ channel_name, was_bad, is_bad, canvas_r_mean_before, canvas_r_mean_after }`
   to `tests/evidence/F04-toggle-bad/toggle.json`.

**EVIDENCE ARTIFACT.**

```
tests/evidence/F04-toggle-bad/screenshot.png
tests/evidence/F04-toggle-bad/toggle.json
tests/evidence/F04-toggle-bad/run.log
```

---

## F05 — Per-channel-type colors with override

**Goal.** Traces are coloured by channel type (`EEG`, `EOG`, `ECG`, `EMG`,
`MISC`, etc., as recorded in `_channels.tsv`). Default palette is
**Okabe-Ito** (mandated by the project's data-viz preference). A small
per-type colour swatch row in the left rail lets the user override.
Settings persist for the page session (no localStorage needed for v1; in
the same tab is enough).

**User story.**
> A user loads a recording with mixed EEG + EOG + ECG channels. By default
> EEG is one colour, EOG another, ECG a third — easy to scan. They prefer
> EOG in red; they click the EOG swatch, pick red; all EOG traces re-render
> red.

**DOM contract.**

In the left rail, **above** `#ch-list`:

| Selector                              | Required state                                |
| ------------------------------------- | --------------------------------------------- |
| `#channel-colors`                     | exists                                        |
| `#channel-colors .color-swatch-row`   | one per distinct channel type in the recording |
| `#channel-colors .color-swatch-row .ch-type-label` | text === the type (e.g. `EEG`)   |
| `#channel-colors .color-swatch-row button.color-swatch` | ≥ 5 colour buttons per row     |
| `button.color-swatch.active`          | exactly 1 per row                             |

Default colours **must** be the Okabe-Ito set (project preference):
`#0072B2 #009E73 #D55E00 #CC79A7 #E69F00 #56B4E9 #F0E442 #000000`.

Canvas check: the trace pixel mean colour of an EEG channel and an EOG
channel (when both present) must differ by ≥ 50 in any single RGB channel.

**PRE-IMPLEMENTATION CHECK.**

The grep targets symbols specific to the new feature — NOT generic
colour hexes like `#0072B2`, which the project already uses as its
default trace colour (see `traces.js:38 TRACE_COLOR`) and would
false-positive.

```bash
grep -n "channel-colors\|color-swatch-row\|CHANNEL_TYPE_PALETTE\|applyChannelTypeColors" \
  /Users/bruaristimunha/Projects/eegdash-viewer/index.html \
  /Users/bruaristimunha/Projects/eegdash-viewer/viewer.js \
  /Users/bruaristimunha/Projects/eegdash-viewer/traces.js \
  /Users/bruaristimunha/Projects/eegdash-viewer/styles.css \
  2>/dev/null
```
Non-zero → `F05: NOT-IMPLEMENTED`.

**FUNCTIONAL VALIDATION.**

Note: the default fixture (ds002893) is mostly EEG-only. For F05 use the
EDF fixture which has heterogeneous types, OR fall back to a synthetic
recording. Pick the EDF fixture:

```bash
mkdir -p tests/evidence/F05-channel-colors
npx playwright test tests/e2e/eegdrop-features.spec.mjs -g "F05:" \
  --reporter=line 2>&1 | tee tests/evidence/F05-channel-colors/run.log
```
Expected exit `0`, log contains `1 passed`.

Test logic:

1. Goto EDF fixture URL.
2. Wait for stage caption.
3. Assert `#channel-colors .color-swatch-row` count >= 1.
4. Capture each row's `.ch-type-label` text into `types_present`.
5. For each row, capture the active swatch's `style.backgroundColor` (RGB).
6. Click a non-active swatch on the first row; assert that swatch becomes
   `.active` and the previous one loses `.active`.
7. Re-render canvas, capture pixel colour from a channel of that type;
   assert it changed.
8. Screenshot showing the swatch row + canvas.
9. Dump `{ types: [...], default_colors: {...}, after_change: {...} }` to
   `tests/evidence/F05-channel-colors/colors.json`.

**EVIDENCE ARTIFACT.**

```
tests/evidence/F05-channel-colors/screenshot.png
tests/evidence/F05-channel-colors/colors.json
tests/evidence/F05-channel-colors/run.log
```

---

## F06 — Clock vs relative time toggle

**Goal.** A toggle (button or hotkey `t`) flips the time axis between
"relative to recording start" (current behaviour: `0.0 s`, `10.0 s`, …)
and "wall-clock" (`14:32:01`, `14:32:11`, …) using the recording's
`MeasurementDate` from `_eeg.json` or the format header.

**User story.**
> A clinician reading a sleep recording wants to align an event with the
> patient's diary entries. They press `t`; the time axis labels switch to
> wall-clock. Pressing again flips back.

**DOM contract.**

| Selector                       | Required state                                   |
| ------------------------------ | ------------------------------------------------ |
| `#time-mode-toggle`            | exists, `<button>`, text is `rel` or `clock`     |
| `#time-mode-toggle[data-mode]` | one of `relative`, `clock`                       |
| Canvas X-axis tick labels      | match `/^\d+(\.\d+)?$/` (relative) OR `/^\d{2}:\d{2}:\d{2}$/` (clock) |

When the recording lacks a `MeasurementDate`, the toggle should be visible
but disabled (`<button disabled>`); attempting to click it leaves the
state unchanged.

**PRE-IMPLEMENTATION CHECK.**

```bash
grep -n "time-mode-toggle\|MeasurementDate\|clock-time\|relative-time" \
  /Users/bruaristimunha/Projects/eegdash-viewer/viewer.js \
  /Users/bruaristimunha/Projects/eegdash-viewer/traces.js \
  /Users/bruaristimunha/Projects/eegdash-viewer/index.html \
  2>/dev/null
```
Non-zero → `F06: NOT-IMPLEMENTED`.

**FUNCTIONAL VALIDATION.**

The default EEGLAB fixture lacks `MeasurementDate`; use the EDF fixture
which carries it in the EDF header.

```bash
mkdir -p tests/evidence/F06-time-mode
npx playwright test tests/e2e/eegdrop-features.spec.mjs -g "F06:" \
  --reporter=line 2>&1 | tee tests/evidence/F06-time-mode/run.log
```

Test logic:

1. Goto EDF fixture URL.
2. Wait for stage caption.
3. Assert `#time-mode-toggle[data-mode="relative"]` exists, enabled.
4. Capture canvas as PNG → OCR not required: read tick labels via the
   renderer's exposed API (`TraceRenderer.lastDrawnXLabels` — to be added).
5. Assert all labels match the relative regex.
6. Click toggle. Assert `data-mode === 'clock'`.
7. Re-capture labels; assert all match the clock regex.
8. Screenshot of clock-mode canvas.
9. Dump `{ rel_labels: [...], clock_labels: [...] }` to
   `tests/evidence/F06-time-mode/labels.json`.

**EVIDENCE ARTIFACT.**

```
tests/evidence/F06-time-mode/screenshot.png
tests/evidence/F06-time-mode/labels.json
tests/evidence/F06-time-mode/run.log
```

---

## F07 — Web Worker for reader + decimation (architectural)

**Goal.** Move format-reader I/O and trace decimation off the main thread
into a dedicated Web Worker. This is **architectural only** — the user
sees no visible new feature, but pan/zoom no longer jank during a 38 MB
window read, and F08 (filters) becomes possible without freezing the UI.

**User story.**
> A user pans rapidly through a 5 kHz × 64-channel BrainVision recording.
> The UI stays at 60 fps; the canvas keeps painting; the browser tab
> doesn't show the "page unresponsive" warning even on a 38 MB window.

**Worker message protocol** (modelled on eegdrop's, see `assets/eeg.worker-COIQXZ36.js`):

| Direction        | Message `type`        | Payload                                          |
| ---------------- | --------------------- | ------------------------------------------------ |
| main → worker    | `INIT`                | `{}`                                             |
| worker → main    | `INIT_OK`             | `{ formats: ["edf","bdf","set","vhdr"] }`        |
| main → worker    | `LOAD_FILE`           | `{ ext, eeg_url, sidecars }`                     |
| worker → main    | `HEADER`              | `{ n_channels, sampling_frequency, duration_s, channel_labels, bytes_per_sample }` |
| main → worker    | `FETCH_WINDOW`        | `{ start_sample, n_samples, request_id }`        |
| worker → main    | `WINDOW`              | `{ request_id, channels: Float32Array[] (transferred) }` |
| main → worker    | `APPLY_FILTER`        | `{ kind: 'highpass'\|'lowpass'\|'notch', cutoff_hz, order }` (used by F08) |
| worker → main    | `FILTERED`            | `{ filter_id }` (ack — filter applied to subsequent windows) |
| worker → main    | `ERROR`               | `{ request_id?, message }`                       |

**DOM contract.**

| Predicate                                                          | Required           |
| ------------------------------------------------------------------ | ------------------ |
| File `worker.js` exists at repo root                               | yes                |
| `index.html` has a `<script src="worker.js …">` OR `viewer.js` instantiates `new Worker('worker.js')` | yes |
| At runtime, `window.__viewerWorker instanceof Worker`              | yes (test hook)    |
| `viewer.js` no longer calls `reader.readWindow` directly from `requestRender` (uses worker.postMessage) | yes (grep test) |

The viewer must expose `window.__viewerWorker` for the test to inspect.
The implementation should also expose
`window.__viewerWorkerStats = { messages_sent, messages_received, last_round_trip_ms }`
to make perf-claims provable.

**PRE-IMPLEMENTATION CHECK.**

```bash
test -f /Users/bruaristimunha/Projects/eegdash-viewer/worker.js \
  && grep -q "FETCH_WINDOW" /Users/bruaristimunha/Projects/eegdash-viewer/worker.js
```
Non-zero → `F07: NOT-IMPLEMENTED`.

**FUNCTIONAL VALIDATION.**

```bash
mkdir -p tests/evidence/F07-worker
npx playwright test tests/e2e/eegdrop-features.spec.mjs -g "F07:" \
  --reporter=line 2>&1 | tee tests/evidence/F07-worker/run.log
```

Test logic:

1. Goto fixture URL.
2. `await page.waitForFunction(() => window.__viewerWorker instanceof Worker)`.
3. Wait for stage caption.
4. Run a measured pan: dispatch 10 ArrowRight events with 50 ms between each;
   measure main-thread blocked time using the Performance API
   (`performance.measure` between RAFs in an injected script).
5. Assert max main-thread blocked interval < 50 ms during the pan
   (should be in the single ms with the worker; was 100s of ms without).
6. Capture `window.__viewerWorkerStats`; assert `messages_sent ≥ 10` and
   `messages_received ≥ 10`.
7. Dump `tests/evidence/F07-worker/stats.json` with
   `{ messages_sent, messages_received, max_main_thread_block_ms,
      avg_round_trip_ms }`.
8. (No screenshot needed — feature is invisible. Save a 1×1 placeholder
   `screenshot.png` to satisfy the artifact-exists check.)

Additionally, run the existing test suite to confirm no regressions:

```bash
cd /Users/bruaristimunha/Projects/eegdash-viewer && npm test 2>&1 | tail -20
```
Expected: ends with `# pass <N>`, no `# fail` lines (or `0` failures).

**EVIDENCE ARTIFACT.**

```
tests/evidence/F07-worker/stats.json
tests/evidence/F07-worker/run.log
tests/evidence/F07-worker/screenshot.png
```

---

## F08 — In-browser HP / LP / notch filters (display-only)

**Goal.** A "Filters" control group lets the user enable highpass (default
0.5 Hz), lowpass (default 45 Hz), and notch (50 or 60 Hz) filters. Filters
apply in the worker (F07) to the post-fetch sample buffer; raw stored
samples are unchanged. This is `PLAN.md` Phase 8.

**User story.**
> A user looks at a noisy raw recording, can't see anything but 60 Hz hum.
> They tick "Notch 60 Hz"; the trace shows clean alpha rhythms. They add
> "Highpass 0.5 Hz" to remove drift; the baseline straightens.

**DOM contract.**

| Selector                          | Required state                                 |
| --------------------------------- | ---------------------------------------------- |
| `#filter-controls`                | exists in left rail or control panel           |
| `#filter-controls .filter-row`    | one per filter type (3 expected)               |
| `#filter-hp-enable`               | `<input type="checkbox">`                      |
| `#filter-hp-cutoff`               | `<input type="number">` or `<select>`, default `0.5` |
| `#filter-lp-enable`, `#filter-lp-cutoff`  | analogous, default cutoff `45`         |
| `#filter-notch-enable`            | checkbox                                       |
| `#filter-notch-freq`              | `<select>` with options `50`, `60`             |

Behaviour: enabling a filter must change pixels. Concretely, capture
canvas pixel-mean R for a fixed region with no filter; enable HP 30 Hz;
re-capture; assert mean R changed by ≥ 5.

The implementation must use a JS biquad (no WASM dependency). Reference
implementation: 2nd-order Butterworth, processed forward-then-backward
for zero phase distortion (filtfilt).

**PRE-IMPLEMENTATION CHECK.**

```bash
test -f /Users/bruaristimunha/Projects/eegdash-viewer/filters.js \
  && grep -lqn "highpass\|biquad\|filtfilt" /Users/bruaristimunha/Projects/eegdash-viewer/filters.js \
  && grep -lqn "filter-hp-enable" /Users/bruaristimunha/Projects/eegdash-viewer/index.html
```
Non-zero → `F08: NOT-IMPLEMENTED`.

**FUNCTIONAL VALIDATION.**

Two layers: (a) numerical correctness against a reference, (b) UI wiring.

**(a) Numerical correctness** — pure Node test, no browser:

```bash
node --test tests/unit-filters.test.mjs 2>&1 | \
  tee tests/evidence/F08-filters/numerical.log
```
Expected: log contains `# pass 4` (four cases: HP, LP, notch, filtfilt
zero-phase). The unit test compares against an oracle generated with
scipy's `signal.butter` + `filtfilt`, checked in at
`tests/oracle/filter-cases.json` (the implementer must produce this).
Tolerance: max abs difference ≤ 1e-6 µV on a 250 Hz × 1024-sample test
signal.

**(b) UI wiring** — Playwright:

```bash
mkdir -p tests/evidence/F08-filters
npx playwright test tests/e2e/eegdrop-features.spec.mjs -g "F08:" \
  --reporter=line 2>&1 | tee tests/evidence/F08-filters/run.log
```

Test logic:

1. Goto EDF fixture URL.
2. Wait for stage caption.
3. Capture canvas pixel-mean R over a fixed box (e.g. x:200-400, y:200-300)
   → `r_baseline`.
4. Tick `#filter-hp-enable`, set `#filter-hp-cutoff` to 30.
5. Wait for next render (`page.waitForFunction(() => window.__viewerWorkerStats.messages_received > before)`).
6. Re-capture pixel-mean R → `r_filtered`.
7. Assert `Math.abs(r_filtered - r_baseline) >= 5`.
8. Untick HP, tick `#filter-notch-enable`, set freq 60.
9. Re-render, re-capture → assert difference from baseline.
10. Screenshot showing all three controls + filtered canvas.
11. Dump `{ r_baseline, r_hp30, r_notch60 }` to
    `tests/evidence/F08-filters/pixel-deltas.json`.

**EVIDENCE ARTIFACT.**

```
tests/evidence/F08-filters/screenshot.png
tests/evidence/F08-filters/pixel-deltas.json
tests/evidence/F08-filters/numerical.log
tests/evidence/F08-filters/run.log
```

All four required.

---

## F09 — EDF+ Annotations channel parser

**Goal.** EDF+ stores events in a special pseudo-channel called
`EDF Annotations` (or `BDF Annotations` for BDF+). Currently
`formats/edf.js` reads signal channels but (likely) skips this. When a
dataset stores events ONLY in the annotations channel and has no
`_events.tsv`, those events are invisible. Parse them and render in
`#ev-list`.

**User story.**
> A user loads a clinical EDF+ recording from a dataset that doesn't ship
> a `_events.tsv` sidecar (clinical data often doesn't). The Events panel
> in the left rail shows the events that the EDF+ writer encoded directly
> in the annotations channel: stimulus onsets, page changes, technician
> notes.

**Behaviour contract.**

When loading an EDF+ recording:

1. The reader returns events from EITHER `_events.tsv` (priority) OR the
   `EDF Annotations` channel (fallback).
2. The annotations-channel pseudo-channel is **not** rendered as a trace
   (it's not a signal — it's TAL-encoded ASCII).
3. The visible channel count in `#pill-channels` excludes the annotations
   channel.
4. `#ev-list` shows the annotation events in the same `.ev-row` shape as
   `_events.tsv` events.

**DOM contract** when loading an EDF+ recording with no `_events.tsv` but
with annotations:

| Selector                           | Required state                                |
| ---------------------------------- | --------------------------------------------- |
| `#event-count`                     | text > `0`                                    |
| `#ev-list .ev-row`                 | count >= 1                                    |
| `#ev-list .ev-row .ev-onset`       | matches `/^-?\d+\.\d{3}s$/`                   |
| `#ev-list .ev-row .ev-label`       | non-empty                                     |
| `#ch-list .ch-row`                 | does NOT contain a row with `.ch-name` text === `EDF Annotations` |
| `#pill-channels` text === `<n - 1> ch` where the file's raw channel count is `n` | yes |

**PRE-IMPLEMENTATION CHECK.**

The grep targets the event-extraction symbols, not the annotation-channel
*recognition* (which already exists at `formats/edf.js:51` and just marks
the channel `is_annotation` to skip it from signal traces — that does NOT
constitute event parsing).

```bash
grep -n "parseAnnotations\|parseTAL\|extractAnnotationEvents\|annotation_events" \
  /Users/bruaristimunha/Projects/eegdash-viewer/formats/edf.js \
  /Users/bruaristimunha/Projects/eegdash-viewer/bids-recording.js \
  2>/dev/null
```
Non-zero → `F09: NOT-IMPLEMENTED`.

**FUNCTIONAL VALIDATION.**

This needs a fixture EDF+ file with annotations and no sidecar. Use the
PhysioNet sample (or check in a small fixture under `test-data/`):

Fixture URL (small, public, has EDF+ annotations):
`https://physionet.org/files/sleep-edfx/1.0.0/sleep-cassette/SC4001E0-PSG.edf`
(46 MB; range fetch keeps actual transfer < 200 KB).

If that URL is unreachable, the implementer must check in a local fixture
at `test-data/edfplus-with-annotations.edf` and the validation falls back
to `?eeg=/test-data/edfplus-with-annotations.edf`.

**Numerical correctness** — Node, no browser:

```bash
node --test tests/unit-edf-annotations.test.mjs 2>&1 | \
  tee tests/evidence/F09-edf-annotations/numerical.log
```
Expected: log contains `# pass 2` (synthetic TAL string parsed correctly;
roundtrip on a checked-in fixture matches mne's `read_annotations`).

**UI wiring** — Playwright:

```bash
mkdir -p tests/evidence/F09-edf-annotations
npx playwright test tests/e2e/eegdrop-features.spec.mjs -g "F09:" \
  --reporter=line 2>&1 | tee tests/evidence/F09-edf-annotations/run.log
```

Test logic:

1. Goto fixture URL (use a fixture known to have annotations + no
   `_events.tsv`).
2. Wait for stage caption.
3. Read `#event-count` text; parse as int; assert > 0.
4. Read `#pill-channels` text; assert it's the file's raw count minus 1.
5. Assert no `#ch-list .ch-row .ch-name` has text exactly
   `"EDF Annotations"` or `"BDF Annotations"`.
6. Capture first 5 events from `#ev-list` and dump to
   `tests/evidence/F09-edf-annotations/events.json`.
7. Screenshot.

**EVIDENCE ARTIFACT.**

```
tests/evidence/F09-edf-annotations/events.json
tests/evidence/F09-edf-annotations/numerical.log
tests/evidence/F09-edf-annotations/run.log
tests/evidence/F09-edf-annotations/screenshot.png
```

---

## F10 — Drag-reorder channel rows  *(deferred — spec only, do not validate yet)*

**Status.** Defined for completeness. The implementation is non-trivial
(must handle hi-DPI, virtual scrolling for ≥ 256 channel files, and
re-render the canvas after each frame). Validator should always emit
`F10: DEFERRED` and skip — the PRE-IMPLEMENTATION CHECK below will fail
until someone explicitly opts in.

**Goal.** A user can drag a channel name in `#ch-list` to reorder the
canvas display order. The new order persists for the session.

**DOM contract.** TBD — modelled on eegdrop's `.label-drag-indicator` +
`.label-drag-dot` + `.label-drag-name` classes.

**PRE-IMPLEMENTATION CHECK.**

```bash
grep -ln "label-drag-indicator" \
  /Users/bruaristimunha/Projects/eegdash-viewer/styles.css \
  2>/dev/null
```
Non-zero → emit `F10: DEFERRED` (this is the expected default state — we
do NOT promote to NOT-IMPLEMENTED, because the team has explicitly chosen
to defer per the spec).

**FUNCTIONAL VALIDATION.** *(not executed in v1)*

**EVIDENCE ARTIFACT.** *(none)*

---

## F00 — The test scaffolding itself

This is the meta-feature: the Playwright spec file
`tests/e2e/eegdrop-features.spec.mjs` that hosts F01–F09 must exist and
be loadable. The validator runs this check first; if it fails, every
feature emits `F-XX: BLOCKED-NO-TEST-FILE` and the run aborts.

**PRE-IMPLEMENTATION CHECK.**

```bash
test -f /Users/bruaristimunha/Projects/eegdash-viewer/tests/e2e/eegdrop-features.spec.mjs
```

**FUNCTIONAL VALIDATION.**

```bash
npx playwright test tests/e2e/eegdrop-features.spec.mjs --list 2>&1 | \
  tee /tmp/F00-list.log
grep -c "F0[1-9]:" /tmp/F00-list.log
```
Expected last command stdout: `9` (one entry per F01–F09).

**EVIDENCE ARTIFACT.** *(none — this is a gate, not a feature)*

---

# Validator subagent runbook

The validator subagent's prompt should be ≤ 500 words and amount to:

```
You are a feature validator. You have read access to the repo at
/Users/bruaristimunha/Projects/eegdash-viewer and shell access. The
spec is at docs/eegdrop-features-spec.md.

For each feature F00, F01, F02, F03, F04, F05, F06, F07, F08, F09, F10:
  1. Read the feature block.
  2. Run the PRE-IMPLEMENTATION CHECK exactly as written.
  3. If it fails (non-zero exit), emit one line:
       F-XX: NOT-IMPLEMENTED
     and continue to the next feature.
  4. Otherwise, run the FUNCTIONAL VALIDATION commands exactly as
     written (one feature at a time; do not parallelise — Playwright's
     webServer reuse is strict).
  5. Inspect the run log for the expected substring (e.g. "1 passed").
  6. Inspect the EVIDENCE ARTIFACT paths — each file listed must exist
     and be non-empty (`test -s`).
  7. Emit one of:
       F-XX: PASS    evidence at <path>
       F-XX: FAIL    reason: <one line> ; log at <path>
       F-XX: DEFERRED   (only valid for F10)

At the end, emit a summary:
  PASS: <count>   FAIL: <count>   NOT-IMPLEMENTED: <count>   DEFERRED: <count>
  Evidence root: tests/evidence/

Do not modify any source file. Do not invent additional checks. Do not
"fix" failing tests. If a PRE-IMPLEMENTATION CHECK and FUNCTIONAL
VALIDATION disagree (e.g. code present but tests fail), emit FAIL with
"spec/code disagreement" as the reason.

If `npx playwright` says browsers are not installed, run
`npx playwright install chromium` once and retry.
```

This runbook is intentionally rigid — it's what makes a smaller
(cheaper, faster) model fit for the job.

---

# Implementation hand-off summary

| Feature | Effort   | Files to touch                                                 | Tests to add                                       |
| ------- | -------- | -------------------------------------------------------------- | -------------------------------------------------- |
| F00     | trivial  | `tests/e2e/eegdrop-features.spec.mjs` (new)                    | n/a                                                |
| F01     | S        | `viewer.js`, `traces.js`, `index.html`, `styles.css`           | F01 e2e block                                      |
| F02     | S        | `index.html`, `viewer.js`, `styles.css`                        | F02 e2e block                                      |
| F03     | S        | `index.html`, `viewer.js`, `styles.css`                        | F03 e2e block                                      |
| F04     | S        | `viewer.js`, `traces.js`                                       | F04 e2e block                                      |
| F05     | M        | `index.html`, `viewer.js`, `traces.js`, `styles.css`           | F05 e2e block                                      |
| F06     | M        | `traces.js` (axis), `viewer.js`, `index.html`, format readers (expose `MeasurementDate`) | F06 e2e block          |
| F07     | L        | `worker.js` (new), `viewer.js` (refactor `requestRender`), `index.html` (script tag) | F07 e2e + run full `npm test` for regressions |
| F08     | M (after F07) | `worker.js`, `filters.js` (new), `index.html`             | `tests/unit-filters.test.mjs` (new) + F08 e2e      |
| F09     | M        | `formats/edf.js` (extend), `bids-recording.js` (event merge)   | `tests/unit-edf-annotations.test.mjs` (new) + F09 e2e |
| F10     | L        | DEFERRED                                                       | DEFERRED                                           |

S = ≤ 200 LOC, M = 200–600 LOC, L = > 600 LOC.

The two natural shipping units are **F00–F06** as one PR (pure UX
polish, no architectural change) and **F07+F08+F09** as a second PR (the
worker refactor + the two features it unblocks).
