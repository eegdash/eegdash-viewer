# Browser reality check — audit-claimed loadable datasets

**Date:** 2026-05-21
**Source JSONL:** `tests/evidence/audit-browser-reality/results.jsonl`
**Spec:** `tests/e2e/acceptance/audit-loadable.spec.mjs`
**Probe:** real Chromium navigation to `/?eeg=<cdn_url>` with stage-caption + canvas + console-error assertions.

## Headline

**13 of 20 datasets (65.0%) actually render in the browser.**

Median end-to-end render time: 1066 ms.

## Verdict breakdown

- **PASS**: 13
- **FAIL (render)**: 7

## Per-dataset results

| dataset_id | ext | datatype | verdict | render_time | pill | console_errors |
|---|---|---|---|---:|---|---|
| ds002578 | set | eeg | FAIL (render) | — | — | 1 (ds002578: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expecte |
| ds002718 | set | eeg | FAIL (render) | — | — | 1 (ds002718: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expecte |
| ds003392 | fif | meg | FAIL (render) | — | — | 1 (ds003392: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expecte |
| ds002001 | ds | meg | FAIL (render) | — | — | 1 (ds002001: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expecte |
| ds003694 | fif | meg | FAIL (render) | — | — | 1 (ds003694: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expecte |
| ds003682 | fif | meg | FAIL (render) | — | — | 1 (ds003682: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expecte |
| ds002908 | ds | meg | FAIL (render) | — | — | 1 (ds002908: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expecte |
| ds003506 | set | eeg | PASS | 355 ms | SET | 0 |
| ds001971 | set | eeg | PASS | 355 ms | SET | 0 |
| ds002725 | edf | eeg | PASS | 1155 ms | EDF | 0 |
| ds003801 | set | eeg | PASS | 232 ms | SET | 0 |
| ds003029 | vhdr | ieeg | PASS | 1103 ms | VHDR | 0 |
| ds003768 | vhdr | eeg | PASS | 1066 ms | VHDR | 0 |
| ds003602 | set | eeg | PASS | 1094 ms | SET | 0 |
| ds003490 | set | eeg | PASS | 345 ms | SET | 0 |
| ds003516 | set | eeg | PASS | 375 ms | SET | 0 |
| ds003766 | set | eeg | PASS | 19120 ms | SET | 0 |
| ds002691 | set | eeg | PASS | 574 ms | SET | 0 |
| ds003190 | vhdr | eeg | PASS | 1091 ms | VHDR | 0 |
| ds001849 | set | eeg | PASS | 16126 ms | SET | 0 |

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
