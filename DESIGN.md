# Design system — M/EEG Trace Viewer

This file exists so that a fresh session does not have to rediscover the
taste already encoded in `styles.css`, and does not drift away from it.
`styles.css` is the source of truth for values; this is the source of
truth for *reasons*.

---

## 1. The thesis

> The viewer is a scientific instrument, not a SaaS dashboard.
> — `styles.css`, header comment

Everything below follows from that one line. The screen belongs to the
signal. Chrome is thin, quiet, monospaced, and gets out of the way.

This rules out, by default:

- cards, panels with drop shadows, elevation systems
- gradient fills on anything interactive
- pill-shaped call-to-action buttons in accent colour
- `border-radius` outside the established set. The system uses 2–6px for
  controls and wells, 10px for modal overlay panels (`.overlay-panel`),
  50% for dots, and 999px for the header readout pills — where it reads
  as an instrument legend, not a button. Do not introduce a new value.
- any colour not in the token table below
- decorative illustration

The two gradients that *do* exist (`.stage` background, `.stage::before`
watermark) are both sub-6%-opacity atmosphere behind the canvas, never
behind text or controls.

---

## 2. Tokens

Defined once in `:root` in `styles.css`. Never hard-code a colour.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#ffffff` | page background |
| `--bg-2` | `#f3f3f3` | deeper page; row hover; inline `code` |
| `--surface` | `#ffffff` | elevated surface — list wells, inputs, `kbd` |
| `--ink` | `#17181a` | primary text |
| `--ink-2` | `#3a3d42` | secondary text; pill labels; hover borders |
| `--ink-3` | `#797d83` | tertiary; separators inside captions |
| `--muted` | `#6a6e74` | labels, units, empty states, tips |
| `--line` | `#dddddd` | borders, rules, control outlines |
| `--line-2` | `#e8e8e8` | lighter internal rules |
| `--accent` | `oklch(0.55 0.15 240)` | interactive + selected state; the `M/EEG` monogram |
| `--accent-soft` | `oklch(0.92 0.04 240)` | accent wash, backgrounds only |
| `--bad` | `#D55E00` | bad channels — Okabe-Ito vermillion, shared with `traces.js` |
| `--bad-text` | `#B85200` | error **text** only — `--bad` is 3.87:1 on white and fails AA |
| `--good` | `oklch(0.62 0.14 150)` | success / resolved state |
| `--label-tracking` | `0.12em` | the tracked-uppercase letter-spacing, see §4 |
| `--focus-ring` | `2px solid var(--accent)` | the one focus ring, see §8 |
| `--focus-offset` | `2px` | its offset |

The hand-pose panel defines three further tokens (`--pose-dock-w`,
`--pose-dock-gap`, `--pose-canvas`) scoped to that component. They are
layout constants for one panel, not part of the global system, and are
documented in `pose-panel.js` itself.

**Do not lighten `--ink-3` or `--muted`.** Both were deliberately
darkened from their original values (`#b5b8bd` and `#8b8e94`) to clear
the WCAG AA 4.5:1 threshold. The original values are recorded in the CSS
comments as a warning, not as an option.

`--bad` is shared with the canvas renderer. If you change it here you
must change it in `traces.js` too, and it must stay inside the Okabe-Ito
colourblind-safe set.

---

## 3. Type

Three families, three jobs. Do not add a fourth.

| Token | Family | Job |
|---|---|---|
| `--sans` | IBM Plex Sans | body copy — which in practice is almost nothing |
| `--mono` | IBM Plex Mono | every label, every value, every readout, every list |
| `--display` | Fraunces | exactly one thing: the `M/EEG` monogram in the header |

Base size is **13px**. Nothing in the chrome exceeds 12px except the
monogram at 22px. The scale in active use is 9.5 / 10 / 10.5 / 11 / 12.
Prefer an existing size over a new one.

Fraunces is a variable font used at `opsz 144, SOFT 50`, italic, 400. It
appears **once**. It is the single editorial flourish that keeps the page
from reading as a terminal. Adding a second one spends the effect.

Numeric readouts get `font-variant-numeric: tabular-nums` so values do
not jitter as they update.

---

## 4. Casing — the rule that broke

This is the most important section, because getting it wrong produced a
real bug.

**Tracked uppercase is for static UI chrome only.**

```css
font-family: var(--mono);
letter-spacing: var(--label-tracking);
text-transform: uppercase;
```

Apply it to: section titles (`.rail-title`), pill labels, button text,
the stage caption, table headers, overlay headings.

**Never apply it to anything that came out of the recording.** That
means:

- physical units (`.ch-units`)
- event labels (`.ev-label`)
- channel names (`.ch-name`)
- filenames and sidecar values (`.status`, `.provenance`)
- any full sentence of prose (`.view-tip`, `.stage-hint`)

### Why

`text-transform: uppercase` on `.ch-units` rendered **`mV` as `MV`** —
millivolt as megavolt, a six-order-of-magnitude unit error printed on
the face of a scientific instrument — and `µV` as `ΜV`. The same rule
turned an event named `Page change` into `PAGE CHANGE`, so an event
named `stim_on/2` would have rendered as `STIM_ON/2`.

The data is not yours to restyle. If the file says `mV`, print `mV`.

Prose gets sentence case and near-zero tracking. Tracked uppercase at
`0.12em` is legible for a two-word label and actively hostile for a
sentence.

---

## 5. Colour

- `--accent` marks **interactive or selected**. It is not decoration.
- `--bad` marks **bad channels only**, and is Okabe-Ito vermillion so it
  survives every common form of colour vision deficiency. It is a *mark*
  colour, not a text colour: at 3.87:1 on white it fails WCAG AA for
  text. Error copy uses `--bad-text` (4.95:1) instead. Keep `--bad`
  itself unchanged — `traces.js` depends on the exact hue.
- Ink inversion — `background: var(--ink); color: var(--bg)` — is the
  only "primary button" treatment in the system. There is no filled
  accent button. See `#time-mode-toggle[data-mode="clock"]`.
- Trace colours live in `traces.js` and must stay Okabe-Ito. Never
  encode channel identity by hue alone.

### Canvas colours are hand-copied — keep them in sync

`traces.js` cannot read CSS custom properties, so it holds its own
copies of several token values. They drift. Two of them were stale
copies of `--ink-3` and `--muted` from before those tokens were darkened
for AA, and were drawing **text** at 1.90:1 and 3.14:1 on the cream
canvas — invisible to `axe`, which cannot inspect canvas pixels.

Rules for canvas colour constants:

| Constant | Value | Role |
|---|---|---|
| `BG_COLOR` | `#fbfaf6` | cream paper |
| `AXIS_COLOR` | `#b5b8bd` | axis rule + tick marks — **hairlines, not text**, so it stays light |
| `AXIS_LABEL_COLOR` | `#6a6e74` | tick label **text** — 4.91:1 on cream, 5.13:1 on white |
| `TYPE_LABEL_COLOR` | `#6a6e74` | channel-type suffix **text** |
| `LABEL_COLOR` | `#3a3d42` | channel-name text |

Any canvas constant that ends up in a `fillStyle` for `fillText` is text
and owes 4.5:1. Check it against **both** `#fbfaf6` (standalone) and
`#ffffff` (embed draws transparent over the host page). A constant used
only for `strokeStyle` on decorative rules does not.

---

## 6. Layout

```
grid-template-columns: 320px 1fr;   /* rail | stage */
grid-template-rows:    52px  1fr;   /* header spans both columns */
height: 100dvh;                     /* dvh, not vh — mobile toolbars */
```

Three breakpoints, and only three:

| Width | Behaviour |
|---|---|
| `≤ 1080px` | rail narrows to 268px; header tagline dropped; the gain readout moves to its own row |
| `≤ 760px` | single column: header, rail capped at `38dvh` and scrolling, stage takes the rest |
| `≤ 480px` | rail entry animation and the drag/arrow-key tip are dropped |

A range input carries a ~129px intrinsic minimum width, so any `1fr`
track holding one must be written `minmax(0, 1fr)` with `min-width: 0`
on the input — otherwise the slider refuses to shrink and pushes its
neighbour's text out past the rail edge.

The rule behind them: **the canvas is the product. Chrome yields to it,
never the reverse.** When space runs out, the thing that disappears is a
label, a tip, or a tagline — never the signal.

Reflow is CSS-only. `viewer.js` runs a `ResizeObserver` on `#traces`, so
the canvas redraws itself on any layout change without JS help.

---

## 7. Motion

- Transitions run **120–140ms**, on `color`, `border-color`, `background`
  and `opacity` only.
- Nothing translates more than 1–2px. `.electrode-link:hover` moves 1px.
- Every animation needs a `prefers-reduced-motion: reduce` opt-out.
  There is an existing block at the end of the animation section —
  extend it rather than writing a new media query.

Motion here signals state, it does not entertain.

---

## 8. Focus

One ring, defined once:

```css
:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-offset);
  border-radius: 3px;
}
```

This viewer is driven from the keyboard — `←`/`→`, `PgUp`/`PgDn`, `+`/`−`,
`[`/`]`, `b`, `i`, `?`. A keyboard user who cannot see where focus is
cannot use it at all.

Use `:focus-visible`, not `:focus`, so pointer users never see the ring.
Never write `outline: none` without providing a replacement in the same
rule. Inside `overflow: hidden` containers use a negative
`outline-offset` so the ring is not clipped.

A scrollable region must be reachable by keyboard, or its content is
unreachable to anyone not using a mouse. `#ch-list` and `#ev-list` carry
`tabindex="0"` with a `role`/`aria-label` for this reason — apply the
same to any new `overflow-y: auto` container.

---

## 9. Adding a component

- [ ] Uses existing tokens; introduces no new colour
- [ ] Uses `--mono` (or `--sans` for prose); introduces no new font
- [ ] Reuses an existing size from the 9.5–12px scale
- [ ] `border-radius` reuses an existing value (2–6px control, 10px overlay, 999px pill)
- [ ] Does not `text-transform` anything read from the recording (§4)
- [ ] Reachable by keyboard, and inherits the `:focus-visible` ring
- [ ] If it animates, it has a `prefers-reduced-motion` opt-out
- [ ] At `≤ 760px` it either collapses or yields — it does not squeeze the canvas
- [ ] Ask first: does the canvas need this space more than this control does?

---

## 10. What not to import

This repo has **no build step and no framework**. `index.html` loads
~40 plain `<script>` tags; `styles.css` is hand-written CSS with custom
properties. There is no JSX, no Tailwind, no PostCSS, no bundler.

That means component code from the Tailwind/shadcn family — shadcn/ui,
and the various `*ui.dev` galleries built on it — cannot be dropped in.
It would have to be hand-transliterated from utility classes into CSS.

More importantly, it should not be. Their visual language — cards,
`rounded-2xl`, `shadow-sm`, muted-foreground scales, gradient CTAs — is
the SaaS-dashboard idiom this design deliberately rejects (§1). Porting
it would cost real effort to make the instrument look more generic.

If you want a specific interaction from one of those libraries, take the
*behaviour* and re-dress it in the tokens above. Do not take the CSS.

Framework-neutral references (easing curves, transition timings) are
fine to consult; they carry no visual identity with them.
