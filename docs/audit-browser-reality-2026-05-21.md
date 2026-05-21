# Browser reality check — audit-claimed loadable datasets

**Date:** 2026-05-21
**Source JSONL:** `tests/evidence/audit-browser-reality/results.jsonl`
**Spec:** `tests/e2e/acceptance/audit-loadable.spec.mjs`
**Probe:** real Chromium navigation to `/?eeg=<cdn_url>` with stage-caption + canvas + console-error assertions.

## Headline

**14 of 20 datasets (70.0%) actually render in the browser.**

Median end-to-end render time: 1067 ms.

## Verdict breakdown

- **PASS**: 14
- **FAIL (render)**: 6

## Per-dataset results

| dataset_id | ext | datatype | verdict | render_time | pill | console_errors |
|---|---|---|---|---:|---|---|
| ds002578 | set | eeg | FAIL (render) | — | — | 1 (ds002578: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expecte |
| ds002718 | set | eeg | FAIL (render) | — | — | 1 (ds002718: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expecte |
| ds003392 | fif | meg | FAIL (render) | — | — | 1 (ds003392: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expecte |
| ds002001 | ds | meg | FAIL (render) | — | — | 1 (ds002001: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expecte |
| ds003694 | fif | meg | FAIL (render) | — | — | 1 (ds003694: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expecte |
| ds003682 | fif | meg | FAIL (render) | — | — | 1 (ds003682: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expecte |
| ds003506 | set | eeg | PASS | 345 ms | SET | 0 |
| ds001971 | set | eeg | PASS | 357 ms | SET | 0 |
| ds002725 | edf | eeg | PASS | 1090 ms | EDF | 0 |
| ds003801 | set | eeg | PASS | 396 ms | SET | 0 |
| ds003029 | vhdr | ieeg | PASS | 1079 ms | VHDR | 0 |
| ds003768 | vhdr | eeg | PASS | 1102 ms | VHDR | 0 |
| ds003602 | set | eeg | PASS | 1067 ms | SET | 0 |
| ds003490 | set | eeg | PASS | 582 ms | SET | 0 |
| ds003516 | set | eeg | PASS | 339 ms | SET | 0 |
| ds003766 | set | eeg | PASS | 17100 ms | SET | 0 |
| ds002691 | set | eeg | PASS | 596 ms | SET | 0 |
| ds003190 | vhdr | eeg | PASS | 1067 ms | VHDR | 0 |
| ds002908 | ds | meg | PASS | 47175 ms | DS | 0 |
| ds001849 | set | eeg | PASS | 21120 ms | SET | 0 |

## How to reproduce

```bash
# Default 10-sample run (strict assertions)
npm run test:audit-reality

# Soft-fail mode (every per-dataset test marked fixme; JSONL still written)
AUDIT_SOFT_FAIL=1 npm run test:audit-reality:soft

# Manual full run (all 80 loadable URLs — ~40 min)
AUDIT_SAMPLE_SIZE=80 npm run test:audit-reality

# Regenerate this report from the existing JSONL
npm run report:audit-reality
```

## Notes

- The audit JSON (`scripts/audit-100-datasets.json`) marks "loadable" based on a 1-byte HEAD-range probe. This report verifies the viewer's reader actually decodes + renders.
- Failures here that the audit marked loadable are real reader/parser bugs (or sidecar-resolution bugs); failures that the audit also missed are network flakes — re-run with a different `AUDIT_SEED` to subsample a different slice.

---

## 2026-05-21 — Plan A re-run after streaming readers landed

Re-ran the same 20-sample audit (`AUDIT_SAMPLE_SIZE=20 AUDIT_SEED=42 npm run test:audit-reality`) after Plan A's range-based FIFF + EEGLAB-inline readers landed.

**Result: 15/20 pass (75.0%), +1 net vs the Plan E baseline above.**

The single dataset that flipped from FAIL → PASS is the largest target the plan was designed to unblock:

- **ds003694** (FIFF, 2 GB) — was `render-fail` (whole-file `fetchBuffer` exhausted browser memory); now PASS at `render_ms=8112` via the tag-directory walker + range-based readWindow.

The four other previously-failing rows are still failing, with diagnosed root causes that are out of Plan A v1 scope or are file-level limitations:

| dataset_id | format | bytes | root cause | scope |
|---|---|---:|---|---|
| ds003682 | FIFF  | 644 MB | `FIFF_DIR_POINTER = -1` (no tag directory; stream-writer output). The 200 MB whole-file fallback rejects, as designed. | Documented in `tests/evidence/streaming-large/README.md` Blocker B. |
| ds002578 | EEGLAB inline `.set` | 695 MB | `EEG.data` is wrapped inside an `EEG` struct (mxClass=2), not a top-level matrix; v1 scan only finds top-level `data`. | Documented in the plan's Task 9 follow-up note (struct-wrapped variant). |
| ds002718 | EEGLAB inline `.set` | 224 MB | Same struct-wrapped variant as ds002578. | Same. |
| ds002001 | CTF `.ds/.meg4`      | — | Not a Plan A format (CTF). | Out of plan scope. |
| ds003392 | FIFF crosstalk-calib | small | Calibration file (not raw data). Different fault than Plan A targets. | Diagnosed by Plan E; not addressed by streaming work. |

### Streaming-reader commits

The 9 Plan A commits that produced this win are:

```
7e5b121 feat(fiff): add tag-directory walker for range-based reads
0a5489c feat(fiff): range-based api.open via tag-directory walk
7f753b1 feat(fiff): range-based readWindow over per-buffer byte index
cc00285 feat(fiff): readWindowStreaming async generator over data buffers
4bbc060 test(fiff): real-browser evidence gate for >200 MB FIFF reads
d45fa3c feat(matv5): add scanElements for metadata-only top-level walk
4458d90 feat(eeglab): range-based inline .set via MatV5.scanElements
5643ad2 feat(eeglab): remove 200 MB inline cap for streaming v5 path
5a25aac test(eeglab): real-browser evidence for >200 MB inline .set reads
```

### Post-A jsonl snapshot

`tests/evidence/audit-browser-reality-plan-a/results.jsonl` (mirrors the post-run state at the moment Plan A finished, so future plans can A/B against it without re-running the audit).
