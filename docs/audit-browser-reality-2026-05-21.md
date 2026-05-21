# Browser reality check — audit-claimed loadable datasets

**Date:** 2026-05-21
**Source JSONL:** `tests/evidence/audit-browser-reality/results.jsonl`
**Spec:** `tests/e2e/acceptance/audit-loadable.spec.mjs`
**Probe:** real Chromium navigation to `/?eeg=<cdn_url>` with stage-caption + canvas + console-error assertions.

## Headline

**18 of 20 datasets (90.0%) actually render in the browser.**

Median end-to-end render time: 2126 ms.

## Verdict breakdown

- **PASS**: 18
- **FAIL (render)**: 2

## Per-dataset results

| dataset_id | ext | datatype | verdict | render_time | pill | console_errors |
|---|---|---|---|---:|---|---|
| ds002578 | set | eeg | FAIL (render) | — | — | 1 (ds002578: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expecte |
| ds003694 | fif | meg | FAIL (render) | — | — | 1 (ds003694: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expecte |
| ds002722 | edf | eeg | PASS | 2126 ms | EDF | 0 |
| ds002908 | ds | meg | PASS | 35132 ms | DS | 0 |
| ds002094 | vhdr | eeg | PASS | 3110 ms | VHDR | 0 |
| ds003392 | fif | meg | PASS | 1070 ms | FIF | 0 |
| ds003801 | set | eeg | PASS | 244 ms | SET | 0 |
| ds003638 | bdf | eeg | PASS | 1090 ms | BDF | 0 |
| ds003498 | vhdr | ieeg | PASS | 3114 ms | VHDR | 0 |
| ds003478 | set | eeg | PASS | 375 ms | SET | 0 |
| ds002725 | edf | eeg | PASS | 1081 ms | EDF | 0 |
| ds001971 | set | eeg | PASS | 326 ms | SET | 0 |
| ds003194 | edf | eeg | PASS | 3100 ms | EDF | 0 |
| ds002761 | ds | meg | PASS | 36087 ms | DS | 0 |
| ds003710 | vhdr | eeg | PASS | 3070 ms | VHDR | 0 |
| ds003509 | set | eeg | PASS | 348 ms | SET | 0 |
| ds003506 | set | eeg | PASS | 321 ms | SET | 0 |
| ds003655 | set | eeg | PASS | 2175 ms | SET | 0 |
| ds003519 | set | eeg | PASS | 2273 ms | SET | 0 |
| ds002721 | edf | eeg | PASS | 2080 ms | EDF | 0 |

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
