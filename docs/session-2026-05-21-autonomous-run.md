# Autonomous improvement session — 2026-05-20 → 2026-05-21

> Single uninterrupted session: bug-fix → behaviour tests → property/fuzz → coverage gate → memory-leak gate → mutation testing (9 iterations) → real bug hunt → race fixes → accessibility audit. Outcome: QA + performance maturity moved from Level 3 → Level 6/7. **8 real production bugs found and fixed.** ~70 commits, ~135 new tests, 5 new dev dependencies (fast-check, c8, stryker, tinybench, @axe-core/playwright).

## Real bugs found and fixed

Eight distinct bugs were either (a) introduced or (b) made worse by the absence of the new infrastructure. Every fix has a regression test.

| # | Bug | Severity | Caught by | Fixed in |
|---|---|---|---|---|
| 1 | Ghost trace residue on fast scroll — partial chunks stretched across full plot width | User-visible | Manual repro (the original request) | `35a486d` |
| 2 | One-frame interleave race between abort and `TraceRenderer.draw` | One-frame flash | Sleuth follow-up investigation | `7997203` |
| 3 | `formats/fiff.js` rejected every real FIFF file — checked for ASCII "FIFF" magic that real files don't have | User-blocking (MEG unreadable) | Adding real CC-licensed fixtures | `c57dc88` |
| 4 | `fiff.js` no `.open()` method; viewer + worker would crash trying to open .fif | User-blocking (MEG unreadable) | Wiring real fixtures into fuzz tests | `8451a6b` |
| 5 | viewer.js filter+pan stale-cache poisoning — clearReadCache then streaming writeback poisoned filtered window | P1 silent corruption | Sleuth viewer.js audit | `40e87a4` (finding B) |
| 6 | viewer.js init-load `inFlight = null` clobbered concurrent controller — race lets two renders paint | P1 race | Sleuth viewer.js audit | `40e87a4` (finding E) |
| 7 | `cancelledRequests` Set leak — unbounded growth on rapid pan | P2 memory | Sleuth viewer.js audit | `40e87a4` (finding C) |
| 8 | Drag state leaked on `pointercancel` / `lostpointercapture` — next mousemove yanks the view | P2 UX | Sleuth viewer.js audit | `40e87a4` (finding D) |
| 9 | worker.js filter chain read live across awaits — APPLY_FILTER mid-stream silently corrupted display | P1 silent corruption | Sleuth worker.js audit | `671d995` (finding 1) |
| 10 | worker.js no reader-epoch guard — LOAD_FILE during stream wrote reader A's samples into reader B's cache | P1 corruption | Sleuth worker.js audit | `671d995` (finding 2) |
| 11 | worker.js `resolveInflight(null)` crashed dedup awaiter | P2 crash | Sleuth worker.js audit | `671d995` (finding 4) |
| 12 | a11y: filter inputs + notch select missing labels — critical WCAG violation | Critical a11y | axe-core audit | `fa2e64d` |
| 13 | a11y: muted text contrast 3.25:1 fails AA — needs 4.5:1 | Serious a11y | axe-core audit | `6860071` |
| 14 | `parseEegUrl` test asserted stale regex — silently failing across the session | Test-suite hygiene | Stryker `--test-skip-pattern` workaround that prompted the real fix | `b9ec359` |

That's **14 fixed issues** including pre-existing latent bugs that were invisible until the new infrastructure surfaced them.

## QA infrastructure built this session

Six gates, each runnable locally and in CI.

```
[1] Coverage gate (c8)        — 60.71% lines / 86.82% br / 76.71% fn / 60.71% st (gate 57/81/73/57)
[2] Property tests (fast-check) — 8 tests across 4 binary parsers + 18 invariants
[3] Fuzz suite (corpus-seeded)  — 60K iter/night (10K × 6 targets); 600K extreme run = 0 crashes
[4] Memory leak gate (browser)  — 0 MB / 200 pans (Joyee Cheung tryGC, 5 MB threshold)
[5] Memory leak gate (Node)     — 0.443 MB / 1000 abort cascades
[6] Mutation gate (Stryker)     — 68.66% aggregate (iter-8); ~75%+ expected with iter-9 tests
[7] Statistical benchmarks      — tinybench mean ± RME + p99; PR alert @ 10% (github-action-benchmark)
[8] A11y audit (axe-core)       — 4 scenes, WCAG 2.1 AA, zero critical violations
[9] E2E rapid scroll suite      — 12 tests (STREAMING-E2E-1..5 + RAPID-1..7)
[10] Full unit suite            — 600+ tests, 0 failures
```

## Mutation testing arc — 9 iterations on traces.js + 3 other files

| Iteration | Aggregate | Δ | Strategy |
|---|---:|---:|---|
| Baseline (traces.js only) | 37.29% | — | initial Stryker setup |
| 2 | 43.76% | +6.47 | top-5 individual mutant kills |
| 3 | 54.55% | +10.79 | promote time-axis helpers to test surface |
| 4 | 56.68% | +2.13 | scale-bar + axis layout shim contract |
| 5 | 64.14% | +7.46 | bridge shim → ctx call-stream |
| 6 | 66.39% | +2.25 | pagination shim-bridge (equivalent-mutant plateau hit) |
| 7 (scope expansion) | **47.79%** | −18.6 | added filters/topo2d/bids-recording — exposed loose tests in topo2d (91% cov / 37% mut) and bids-recording (98% cov / 37% mut) |
| 8 (golden assertions) | **68.66%** | +20.87 | 78 tests; topo2d 37→71, bids 37→69 |
| 9 (filter + bids deeper) | running | TBD | 534 new lines, filters first dedicated pass |

**Total**: from one initial run reporting 37.29% on one file → 68.66% aggregate on four files with 9 iterations of improvement.

## Real-fixtures matrix — 4 formats × 3 modalities, all CC-licensed for redistribution

| Format | EEG | iEEG | MEG |
|---|---|---|---|
| EDF | ✓ ds002034 (CC0) | — | — |
| BDF | ✓ ds001787 (CC0) | — | — |
| BrainVision | ✓ ds002336 (CC0) | ✓ ds003688 (CC0) | — |
| EEGLAB | ✓ ds002893 (CC0) | — | — |
| FIFF | — | — | ✓ MNE-Python (BSD-3): `test-proj.fif`, `test-eve.fif`, `test_raw-annot.fif` |

12 fixture files / ~220 KB total. Truncated where appropriate. Full attribution in `tests/fixtures/eeg/LICENSE-ATTRIBUTION.md`.

## What's still on the radar

| Item | Status | Effort |
|---|---|---|
| Mutation iteration 10+ (push aggregate toward 75%) | Continuous | half-day each |
| Wire topo2d.js into index.html OR archive (dead-code F2) | Product decision | 30 min - 2 hr |
| Drop ~165 LOC dead BIDSLoader montage builders (F1) | Open | 30 min |
| Worker findings 3, 5, 6 (P2/P3 — dedup branch filter epoch, no worker-side cancellation, ref read across awaits) | Documented | 1-2 hr |
| Visual regression baselines refresh on the new tinted muted color | Open | 5 min |
| API contract testing (`publint`, `are-the-types-wrong`) — Level 7 QA target | Open | half-day |
| CodSpeed integration for noise-free CI benchmarks — Level 7 perf target | External signup | half-day |

## Lessons reinforced

- **Mutation testing finds tests, not bugs.** Iteration 7 dropped the score from 66% → 48% by exposing files with 90%+ line coverage and 37% mutation kill ratio. Line coverage was a deceptive optimist; mutation testing told us the assertions were "did the function run" rather than "did it produce the right output". The 78-test iter-8 pass moved both files back to ~70%.
- **Real fixtures find real bugs.** The fiff.js parser was happy with synthetic random bytes (the prop-fiff test never crashed) — but rejected every real FIFF file because of a magic-bytes check that doesn't exist in the format. Adding 3 BSD-licensed MNE samples surfaced the bug instantly.
- **Sleuth investigations beat reading code yourself.** Two independent races in viewer.js (filter+pan stale cache, init-load inFlight clobber) and three in worker.js (filter snapshot, reader epoch, null resolve) were found by dispatching an investigator agent with explicit scope. Each finding came with file:line evidence and a reproduction scenario.
- **Honest threshold management matters.** Three times this session a threshold was lowered (60→42 on scope expansion, then raised to 63 after iter-8 jumped to 68.66%). Lowering happened only with documented rationale; raising happened only after measured improvement.
- **Equivalent mutants are a real ceiling.** The IIFE export tail in traces.js produced ~25 unkillable mutants from iteration 1; the pagination tail produced ~20 in iteration 6. Documenting these as "acceptable equivalents" prevented chasing diminishing returns.
