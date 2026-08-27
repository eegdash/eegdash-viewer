# Frontend Defect Pass + DESIGN.md Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair seven verified defects in the trace viewer's chrome — corrupted physical units, uppercased user data, a layout that hides the canvas below ~720px, and missing keyboard focus affordances — then write down the design system that already exists so future edits stay in-system.

**Architecture:** No framework, no build step, no new dependencies. Five of the seven fixes are pure CSS in `styles.css`; two are single-line changes in `viewer.js`. Responsive behaviour uses CSS grid reflow only — `viewer.js:877` already runs a `ResizeObserver` on the canvas, so the trace re-renders on reflow with no JS change. Verification is Playwright, which the repo already uses.

**Tech Stack:** Vanilla HTML/CSS/JS (ES2020, IIFE globals), Playwright 1.59 for e2e, `scripts/serve.mjs` static server on :8011.

**Spec:** This plan is self-contained; the "Findings" table below is the spec. Each finding was verified by reading the file and screenshotting the running app at 1440×900 and 390×844.

## Global Constraints

- **No new dependencies.** `package.json` `dependencies` stays `{ "jsfive": "^0.4.0" }`.
- **No build step.** Every file loads directly via `<script>` / `<link>` from `index.html`.
- **Never `text-transform` user data.** Physical units, event labels, channel names, and filenames come from the recording. Tracked uppercase is reserved for static UI chrome.
- **Preserve the existing identity.** IBM Plex Sans/Mono + Fraunces, Okabe-Ito `--bad: #D55E00`, ink-inversion as the only primary state. Do not introduce cards, drop shadows, gradients, or border-radius above 6px.
- **Existing test gates must keep passing.** `#stage-caption` visibility is used as the "recording loaded" gate by the acceptance suite (`viewer.js:1076-1084`, `viewer.js:1190`) — the element must stay in the DOM and stay visible in standalone mode.
- **Bump the `?v=` query string** on any file you edit in `index.html` (the repo cache-busts by hand).
- **Test URL** for every manual and automated check:
  `http://localhost:8011/index.html?eeg=/test-data/edfplus-with-annotations.edf`
  Start the server with `node scripts/serve.mjs 8011`.
- **Local Chromium:** Playwright's own download is missing on this machine. Use `playwright.local-chromium.config.mjs`, and update its `executablePath` to the installed shell:
  `/Users/bruaristimunha/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`

## Findings this plan fixes

| # | Defect | Location | Task |
|---|--------|----------|------|
| 1 | `text-transform: uppercase` on `.ch-units` renders `mV` as `MV` (megavolt) and `µV` as `ΜV` | `styles.css:311-316` | 1 |
| 2 | Same rule on `.ev-label` uppercases event names read from `_events.tsv` | `styles.css:311-316` | 1 |
| 3 | Zero width breakpoints; `.app` is a hard `320px 1fr` grid, so below ~720px the canvas is a sliver | `styles.css:66-70` | 3 |
| 4 | `height: 100vh` is clipped under mobile Safari's toolbar | `styles.css:69` | 3 |
| 5 | Only 3 `:focus` rules in 1212 lines, none on buttons/links/rows, in a keyboard-driven app | `styles.css` (absent) | 2 |
| 6 | `.view-tip` sets a full sentence in tracked uppercase | `styles.css:575-584` | 1 |
| 7 | `#stage-caption` overlaps the canvas time axis; `#channel-colors` renders an orphaned heading with no empty state | `styles.css:696-710`, `viewer.js:148` | 4 |

Not a defect, deliberately left alone: `renderChannels` sets the channel count to `?` when no `_channels.tsv` resolves (`viewer.js:111`). That is an honest "unknown", not a bug.

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `styles.css` | Modify | All seven visual fixes. Already sectioned by `/* ----- name ----- */` banners; add new rules inside the matching section, and put the responsive block in a new final section. |
| `viewer.js` | Modify (2 lines) | Empty state for `#channel-colors` only. |
| `index.html` | Modify (2 lines) | Cache-bust `styles.css` and `viewer.js`. |
| `tests/e2e/chrome-integrity.spec.mjs` | Create | New spec covering findings 1, 2, 3, 5. Named for what it guards — the chrome around the canvas — not for this plan. |
| `DESIGN.md` | Create | Repo-root design system reference. |

---

### Task 1: Stop transforming data; set prose in sentence case

Findings 1, 2, 6. Pure CSS. This is the correctness fix — a scientific instrument must not print `MV` when the file says `mV`.

**Files:**
- Modify: `styles.css:311-316` (`.ch-type, .ch-units, .ev-label`)
- Modify: `styles.css:575-584` (`.view-tip`)
- Test: `tests/e2e/chrome-integrity.spec.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: the spec file `tests/e2e/chrome-integrity.spec.mjs` with a `test.describe('chrome integrity')` block. Tasks 2 and 3 append `test(...)` cases to this same file and reuse the `RECORDING` constant it defines.

- [ ] **Step 1: Write the failing test**

Create `tests/e2e/chrome-integrity.spec.mjs`:

```javascript
// Guards the chrome around the canvas: physical units and event labels
// must survive to the screen unmodified, and the sentence-case rule for
// prose. See docs/superpowers/plans/2026-08-27-frontend-defect-pass.md.
import { test, expect } from '@playwright/test';

export const RECORDING = '/index.html?eeg=/test-data/edfplus-with-annotations.edf';

test.describe('chrome integrity', () => {
  test('does not uppercase physical units or event labels', async ({ page }) => {
    await page.goto(RECORDING);
    await expect(page.locator('#stage-caption')).toBeVisible();

    // The gain readout is built in viewer.js as "1.00× (~47 µV/slot)".
    // computed text-transform must leave the µ/m case intact.
    const gain = page.locator('#gain-readout');
    await expect(gain).toHaveCSS('text-transform', 'none');
    await expect(gain).not.toHaveText(/MV|ΜV/);

    // Event labels come from the recording's annotations.
    const label = page.locator('.ev-label').first();
    await expect(label).toHaveCSS('text-transform', 'none');
    await expect(label).toHaveText('Stimulus');
  });

  test('sets the view tip as a sentence, not tracked uppercase', async ({ page }) => {
    await page.goto(RECORDING);
    const tip = page.locator('.view-tip');
    await expect(tip).toHaveCSS('text-transform', 'none');
    await expect(tip).toHaveText(/^Drag traces to pan/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node scripts/serve.mjs 8011 &
npx playwright test tests/e2e/chrome-integrity.spec.mjs --config=playwright.local-chromium.config.mjs
```

Expected: FAIL. `text-transform` resolves to `uppercase` on `.ev-label`, and the event label reads `STIMULUS` — the assertion reports the visible text, not the DOM text, so `toHaveText('Stimulus')` fails on case.

- [ ] **Step 3: Write minimal implementation**

In `styles.css`, replace the rule at 311-316:

```css
/* Channel type, units, and event labels are DATA read from the
   recording — never text-transform them. `mV` uppercased reads as
   megavolt, and an event named `stim_on/2` must render verbatim.
   They keep the muted/small treatment; only the casing is theirs. */
.ch-type, .ch-units, .ev-label {
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: none;
}
```

Then in `.view-tip` (styles.css:575-584) drop the uppercase and the tracking — this is prose, not a label:

```css
.view-tip {
  margin-top: 12px;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.01em;
  text-transform: none;
  color: var(--muted);
  line-height: 1.6;
}
```

The `#gain-readout` node inherits from `.view-controls` and is not in any uppercase rule, so no change is needed there — but confirm with the test.

- [ ] **Step 4: Update the source sentence**

In `index.html`, the `.view-tip` copy is currently written to survive uppercasing. Set it in real sentence case:

```html
<div class="view-tip" data-embed="hide">Drag traces to pan; <kbd>←</kbd>/<kbd>→</kbd> by half a window.</div>
```

(This is already the markup — verify it, and only edit if it differs.)

- [ ] **Step 5: Run test to verify it passes**

```bash
npx playwright test tests/e2e/chrome-integrity.spec.mjs --config=playwright.local-chromium.config.mjs
```

Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add styles.css index.html tests/e2e/chrome-integrity.spec.mjs
git commit -m "fix(ui): never text-transform recording data — mV was rendering as MV"
```

---

### Task 2: Add a focus-visible ring system

Finding 5. The app's primary interface is the keyboard (`←/→/PgUp/PgDn/+/−/[/]/b/i/?`), and there is no visible focus anywhere except a border-colour nudge on three inputs.

**Files:**
- Modify: `styles.css` — append a new section after the `:root` block, before `/* ----- header ----- */` (around line 71)
- Test: `tests/e2e/chrome-integrity.spec.mjs` (append)

**Interfaces:**
- Consumes: `RECORDING` from Task 1's spec file.
- Produces: a `--focus-ring` custom property on `:root` that Task 3's responsive rules do not need but Task 5's DESIGN.md documents.

- [ ] **Step 1: Write the failing test**

Append to `tests/e2e/chrome-integrity.spec.mjs`, inside the existing `test.describe` block:

```javascript
  test('gives every interactive control a visible focus ring', async ({ page }) => {
    await page.goto(RECORDING);
    await expect(page.locator('#stage-caption')).toBeVisible();

    // Tab from the address bar into the page and walk the first eight
    // stops; every one must paint an outline wider than a hairline.
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      const outline = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        return { tag: el.tagName, width: parseFloat(cs.outlineWidth), style: cs.outlineStyle };
      });
      if (!outline) continue;
      expect(outline.style, `${outline.tag} has no focus outline`).not.toBe('none');
      expect(outline.width, `${outline.tag} outline too thin`).toBeGreaterThanOrEqual(2);
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx playwright test tests/e2e/chrome-integrity.spec.mjs -g "focus ring" --config=playwright.local-chromium.config.mjs
```

Expected: FAIL with `outline too thin` or `has no focus outline` — Chromium's default focus ring is 1px `auto`, and headless reports `outlineStyle: 'none'` on several controls.

- [ ] **Step 3: Write minimal implementation**

Add to `:root` in `styles.css`, after `--label-tracking`:

```css
  --focus-ring: 2px solid var(--accent);
  --focus-offset: 2px;
```

Then insert this section immediately after the `::-webkit-scrollbar` rules (around styles.css:65), before `.app`:

```css
/* ----- focus ---------------------------------------------- */

/* This viewer is driven from the keyboard (←/→, PgUp/PgDn, +/−, [/],
   b, i, ?). Every focusable control gets one ring, defined once. Uses
   :focus-visible so pointer users never see it. */
:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-offset);
  border-radius: 3px;
}

/* The canvas is focusable for keyboard panning; ring it on the inside
   so a 2px offset does not get clipped by the stage's overflow. */
.traces:focus-visible {
  outline-offset: -2px;
}

/* Rows in the channel/event lists are div-based click targets. They
   need a tabindex to be reachable at all — until they have one the
   ring is inert, which is fine; this rule is here so it lands when
   they do. */
.ch-row:focus-visible,
.ev-row:focus-visible {
  outline: var(--focus-ring);
  outline-offset: -2px;
  background: var(--bg-2);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx playwright test tests/e2e/chrome-integrity.spec.mjs -g "focus ring" --config=playwright.local-chromium.config.mjs
```

Expected: PASS.

- [ ] **Step 5: Run the existing a11y suite to check for regressions**

```bash
npx playwright test tests/e2e/a11y.spec.mjs --config=playwright.local-chromium.config.mjs
```

Expected: PASS, same count as before the change.

- [ ] **Step 6: Commit**

```bash
git add styles.css tests/e2e/chrome-integrity.spec.mjs
git commit -m "feat(a11y): single focus-visible ring across every control"
```

---

### Task 3: Make the layout survive narrow viewports

Findings 3 and 4. At 390px the fixed 320px rail leaves the canvas — the entire product — about 30px wide, and the page scrolls horizontally.

The approach is CSS-only reflow. Below 760px the grid goes single-column: header, then the rail as a height-capped scrolling region, then the stage taking the remaining space. `viewer.js:877`'s `ResizeObserver` redraws the canvas on reflow, so no JS is needed.

**Files:**
- Modify: `styles.css:66-70` (`.app`) and append a new final section
- Test: `tests/e2e/chrome-integrity.spec.mjs` (append)

**Interfaces:**
- Consumes: `RECORDING` from Task 1's spec file.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Append to `tests/e2e/chrome-integrity.spec.mjs`, inside the existing `test.describe` block:

```javascript
  for (const [name, width, height] of [['phone', 390, 844], ['tablet', 834, 1000]]) {
    test(`keeps the canvas usable and the page unscrolled at ${name}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto(RECORDING);
      await expect(page.locator('#stage-caption')).toBeVisible();

      // The canvas is the product. It must get most of the width.
      const canvas = await page.locator('#traces').boundingBox();
      expect(canvas.width, 'canvas too narrow').toBeGreaterThan(width * 0.8);
      expect(canvas.height, 'canvas too short').toBeGreaterThan(200);

      // Nothing may overflow horizontally.
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'page scrolls horizontally').toBeLessThanOrEqual(1);
    });
  }
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx playwright test tests/e2e/chrome-integrity.spec.mjs -g "keeps the canvas" --config=playwright.local-chromium.config.mjs
```

Expected: FAIL at phone with `canvas too narrow` — the canvas measures roughly 30px against a 312px threshold.

- [ ] **Step 3: Write minimal implementation**

First change `.app` (styles.css:66-70) to use dynamic viewport height:

```css
.app {
  display: grid;
  grid-template-columns: 320px 1fr;
  grid-template-rows: 52px 1fr;
  height: 100dvh;
}
```

Then append this as the final section of `styles.css`:

```css
/* ----- responsive ----------------------------------------- */

/* Two steps only. At laptop widths the rail just narrows. Below 760px
   the two-column grid cannot hold both a readable rail and a usable
   canvas, so it reflows to a single column: the rail becomes a capped
   scrolling strip and the stage takes the rest. viewer.js's
   ResizeObserver on #traces redraws the canvas on reflow, so this is
   CSS-only. */

@media (max-width: 1080px) {
  .app { grid-template-columns: 268px 1fr; }
  .brand-sub { display: none; }          /* the tagline is the first thing to go */
}

@media (max-width: 760px) {
  .app {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 38dvh) minmax(0, 1fr);
  }
  .header {
    flex-wrap: wrap;
    row-gap: 6px;
    padding: 8px 14px;
  }
  .header-right {
    order: 3;
    width: 100%;
    overflow-x: auto;
    scrollbar-width: none;               /* the pills scroll, they do not wrap */
  }
  .header-right::-webkit-scrollbar { display: none; }
  .brand-eegdash { margin-left: auto; }

  .rail.left {
    border-right: none;
    border-bottom: 1px solid var(--line);
    padding: 14px 14px 18px;
  }
  /* The stage must never be squeezed out by the rail's content. */
  .stage { min-height: 0; }
  .ch-list, .ev-list { max-height: 160px; }
}

/* Below the fold on a phone the rail's animation-delay stagger reads
   as jank on an already-cramped screen. */
@media (max-width: 480px) {
  .rail.left .rail-section { animation: none; }
  .view-tip { display: none; }           /* drag/arrow-key tip is desktop-only advice */
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx playwright test tests/e2e/chrome-integrity.spec.mjs -g "keeps the canvas" --config=playwright.local-chromium.config.mjs
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Verify the desktop layout did not move**

```bash
npx playwright test tests/e2e/visual-regression.spec.mjs --config=playwright.local-chromium.config.mjs
```

Expected: PASS. The desktop snapshots are taken above 1080px, so no baseline should shift. If a snapshot fails, read the diff before updating it — a desktop change here means a media query leaked.

- [ ] **Step 6: Commit**

```bash
git add styles.css tests/e2e/chrome-integrity.spec.mjs
git commit -m "feat(ui): reflow to a single column below 760px so the canvas stays usable"
```

---

### Task 4: Fix the caption overlap and the orphaned Channel Colors heading

Finding 7. Two small, unrelated blemishes visible in the desktop screenshot.

**Files:**
- Modify: `styles.css:696-710` (`.stage-caption`)
- Modify: `viewer.js:148-152` (`renderChannelColors` early return)
- Modify: `index.html` (cache-bust both files)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Reproduce both blemishes**

```bash
node scripts/serve.mjs 8011 &
```

Open `http://localhost:8011/index.html?eeg=/test-data/edfplus-with-annotations.edf` and confirm two things at 1440×900:
1. `#stage-caption` at the bottom-left sits on top of the canvas's `0.00 s` axis label.
2. The `CHANNEL COLORS` heading has nothing underneath it.

- [ ] **Step 2: Move the caption clear of the axis**

The time axis is drawn along the bottom of the canvas across its full width. Move the caption up above it. In `styles.css:696-710`:

```css
.stage-caption {
  position: absolute;
  bottom: 40px;                 /* clears the canvas time-axis row */
  left: 18px;
  pointer-events: none;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: var(--label-tracking);
  text-transform: uppercase;    /* static chrome, not data — uppercase is correct here */
  color: var(--muted);
  display: flex;
  gap: 10px;
  align-items: center;
  z-index: 2;
}
```

Keep `text-transform: uppercase` here: the caption's content is composed of static labels (`ch`, `Hz`, `s`, format name), not values read verbatim from the file. If Task 1's test starts failing on this element, the caption is printing a unit and the transform must go.

- [ ] **Step 3: Give Channel Colors an empty state**

In `viewer.js`, `renderChannelColors` currently returns early leaving the container blank. Replace the early return so it renders the same `.muted` treatment the channel list uses:

```javascript
  function renderChannelColors(channels, containerEl, typeColors, onSwatchClick) {
    if (!channels || !channels.length) {
      setChildren(containerEl, el('div', 'muted', 'no channel types yet'));
      return;
    }
```

- [ ] **Step 4: Cache-bust**

In `index.html`, bump both query strings:

```html
<link rel="stylesheet" href="styles.css?v=4" />
```
```html
<script src="viewer.js?v=10"></script>
```

- [ ] **Step 5: Verify visually**

Reload the page. Confirm the caption no longer touches the `0.00 s` label, and `CHANNEL COLORS` now reads `no channel types yet` under it.

Then run the acceptance gate that depends on the caption:

```bash
npx playwright test tests/e2e/smoke.spec.mjs --config=playwright.local-chromium.config.mjs
```

Expected: PASS — `#stage-caption` is still in the DOM and still visible.

- [ ] **Step 6: Commit**

```bash
git add styles.css viewer.js index.html
git commit -m "fix(ui): lift stage caption clear of the time axis, add channel-colors empty state"
```

---

### Task 5: Write DESIGN.md

The taste in this repo is real but it lives in scattered CSS comments, so every fresh session rediscovers it or drifts away from it. Write it down once.

**Files:**
- Create: `DESIGN.md` (repo root)

**Interfaces:**
- Consumes: the token names and rules established in Tasks 1-4.
- Produces: nothing.

- [ ] **Step 1: Write the document**

Create `DESIGN.md` with exactly these sections, filled from the real values in `styles.css`:

1. **The thesis** — one paragraph. Quote the existing header comment: the viewer is a scientific instrument, not a SaaS dashboard. State what that rules out: cards, drop shadows, gradient fills, pill-shaped CTAs, border-radius above 6px, and any colour not in the token list.
2. **Tokens** — the full `:root` table copied from `styles.css`, one row per token with its value and what it is for. Include `--focus-ring` and `--focus-offset` from Task 2. Note that `--ink-3` and `--muted` were darkened specifically to clear WCAG AA, so they must not be lightened.
3. **Type** — the three families (`--sans` IBM Plex Sans, `--mono` IBM Plex Mono, `--display` Fraunces) and the rule for each: Plex Sans for body, Plex Mono for every value and label, Fraunces italic only for the single `M/EEG` monogram in the header. Base size is 13px; nothing in the chrome goes above 12px except the monogram.
4. **Casing — the rule that broke** — the most important section. Tracked uppercase (`letter-spacing: var(--label-tracking)`, `text-transform: uppercase`) is for **static UI chrome only**: section titles, pill labels, button text, the stage caption. It is **never** applied to: physical units, event labels, channel names, filenames, sidecar values, or any prose sentence. Cite the `mV` → `MV` bug as the reason.
5. **Colour** — `--accent` for interactive and selected state, `--bad` (Okabe-Ito vermillion `#D55E00`, shared with `traces.js`) for bad channels, `--good` for success. Ink inversion (`background: var(--ink); color: var(--bg)`) is the only "primary button" treatment. Trace colours are colourblind-safe and must stay Okabe-Ito.
6. **Layout** — the grid: `320px 1fr` / `52px 1fr` at `100dvh`. The two breakpoints from Task 3 (1080px narrows the rail, 760px reflows to one column) and the rule behind them: **the canvas is the product; chrome yields to it, never the reverse.**
7. **Motion** — transitions are 120-140ms on colour and border only. Nothing moves more than 1-2px. Every animation must have a `prefers-reduced-motion: reduce` opt-out; there is an existing block at the end of the animation section to extend.
8. **Focus** — one ring, defined once on `:focus-visible`. Never `outline: none` without a replacement.
9. **When adding a component** — a short checklist: use existing tokens, no new font, no new radius, ask whether the canvas needs the space more, add the `prefers-reduced-motion` opt-out if it animates, and confirm it does not text-transform data.
10. **What not to import** — a short honest note that this repo has no build step and no React, so Tailwind/shadcn-family component code cannot be dropped in, and that their visual language is the one this design deliberately rejects.

- [ ] **Step 2: Verify every token in the document exists**

```bash
grep -o '\-\-[a-z0-9-]*' DESIGN.md | sort -u > /tmp/doc-tokens.txt
grep -o '^\s*\-\-[a-z0-9-]*' styles.css | tr -d ' ' | sort -u > /tmp/css-tokens.txt
comm -23 /tmp/doc-tokens.txt /tmp/css-tokens.txt
```

Expected: empty output. Any line printed is a token documented but not defined — fix the document.

- [ ] **Step 3: Commit**

```bash
git add DESIGN.md
git commit -m "docs(design): write down the design system the CSS already follows"
```

---

### Task 6: Full verification

- [ ] **Step 1: Run the complete e2e suite**

```bash
npx playwright test --config=playwright.local-chromium.config.mjs
```

Expected: PASS. Report any failure with its output — do not update snapshots to make a failure go away without reading the diff first.

- [ ] **Step 2: Run the unit suite**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 3: Typecheck**

```bash
npm run test:typecheck
```

Expected: no errors. Task 4 touched `viewer.js`, which is covered by `jsconfig.json`.

- [ ] **Step 4: Re-screenshot all four viewports and compare against the originals**

```bash
node scripts/serve.mjs 8011 &
```

Capture 1440×900, 1180×760, 834×1000, 390×844 and confirm: units read `µV`, event labels read `Stimulus`/`page change` as written in the file, the canvas is the dominant element at every width, and no horizontal scrollbar appears.

- [ ] **Step 5: Commit any remaining changes**

```bash
git status
```

Expected: clean, or only the four screenshots (which should not be committed).
