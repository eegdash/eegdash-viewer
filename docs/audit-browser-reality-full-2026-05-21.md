# Browser reality check — FULL audit (all loadable URLs)

**Date:** 2026-05-21
**Source JSONL:** `tests/evidence/audit-browser-reality/results-classified.jsonl`
**Spec:** `tests/e2e/acceptance/audit-loadable.spec.mjs` (AUDIT_FULL=1, 4 workers)
**Config:** `playwright.audit-full.config.mjs`
**Wall-clock:** 6m 13s

## Headline

**70 of 89 datasets (78.7%) actually render in the browser.**

Median end-to-end render time: 1094 ms.

## Self-comparison vs 20-sample baseline

**Baseline (20-sample, 20 datasets):** 18/20 = 90.0%
**Full run (this report, 89 datasets):** 70/89 = 78.7%
**Delta:** -11.3 pp

## Verdict breakdown

- **pass**: 70
- **render-fail**: 17
- **console-error**: 2

## Failure-mode classification

### format-CTF-residual — 1 row(s)

CTF .ds bundles that still fail after the .res4 offset fix (a52b74c). Each row needs a one-off look — likely a new .res4 header variant.

First example URLs:
- https://cdn.eegdash.org/ds002001/sub-0001/ses-20140502/meg/sub-0001_ses-20140502_task-rivalry_run-02_meg.ds/sub-0001_ses-20140502_task-rivalry_run-02_meg.meg4

| dataset_id | ext | datatype | verdict | render_ms | error_message |
|---|---|---|---|---:|---|
| ds002001 | ds | meg | render-fail | — | ds002001: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |

### format-FIFF-large — 0 row(s)

FIFF files that exceed the current 200 MB fetchBuffer cap in src/http-range.js. Lifting the cap requires streaming-decode work in formats/fiff.js.

_no rows_

### format-FIFF-no-raw-block — 2 row(s)

FIFF files that contain only events/projections/annotations (no FIFFB_RAW_DATA block). These are sidecar/companion files — the viewer has no recording to render. Surface a clearer error message and/or skip these in catalog discovery.

First example URLs:
- https://cdn.eegdash.org/ds002885/sub-01/meg/sub-01_task-DSMW_meg.fif
- https://cdn.eegdash.org/ds003352/sub-1/ses-01/meg/sub-1_ses-01_task-ColorSpirals_run-00_meg.fif

| dataset_id | ext | datatype | verdict | render_ms | error_message |
|---|---|---|---|---:|---|
| ds002885 | fif | meg | console-error | 3103 | console.error: Error: fiff: this file has no FIFFB_RAW_DATA block (events/projections/annotations only) at worker.onmessage (http://localhos |
| ds003352 | fif | meg | console-error | 3094 | console.error: Error: fiff: this file has no FIFFB_RAW_DATA block (events/projections/annotations only) at worker.onmessage (http://localhos |

### format-EEGLAB-large — 0 row(s)

Inline .set files larger than 200 MB (cap added in 91aeae3). Same streaming-decode story as FIFF.

_no rows_

### format-EEGLAB-v73-renamed-fdt — 0 row(s)

MAT v7.3 (HDF5) .set files where the companion .fdt has a different basename than the .set. Mat73 reader (d555923) needs cross-basename .fdt sidecar resolution.

_no rows_

### network-flake — 0 row(s)

Console errors that surfaced 5xx/TLS/DNS — likely flakes, not viewer bugs. Re-run the listed URLs in isolation to confirm.

_no rows_

### timeout-cold-cdn — 16 row(s)

stage-caption never appeared within 60 s. Cold CDN + first range-fetch latency. Confirm by re-running the listed URLs after a warm-up GET.

First example URLs:
- https://cdn.eegdash.org/ds002158/sub-02/ses-001/eeg/sub-02_ses-001_task-main_run-001_eeg.vhdr
- https://cdn.eegdash.org/ds002181/sub-1473/eeg/sub-1473_task-Baseline_eeg.set
- https://cdn.eegdash.org/ds002312/sub-A0023/meg/sub-A0023_task-OcularLDT_meg.fif
- https://cdn.eegdash.org/ds002578/sub-001/eeg/sub-001_task-attention_eeg.set
- https://cdn.eegdash.org/ds002712/sub-01/meg/sub-01_task-numbersletters_run-11_meg.fif

| dataset_id | ext | datatype | verdict | render_ms | error_message |
|---|---|---|---|---:|---|
| ds002158 | vhdr | eeg | render-fail | — | ds002158: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds002181 | set | eeg | render-fail | — | ds002181: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds002312 | fif | meg | render-fail | — | ds002312: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds002578 | set | eeg | render-fail | — | ds002578: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds002712 | fif | meg | render-fail | — | ds002712: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds002718 | set | eeg | render-fail | — | ds002718: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds003078 | set | ieeg | render-fail | — | ds003078: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds003343 | bdf | eeg | render-fail | — | ds003343: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds003483 | fif | meg | render-fail | — | ds003483: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds003570 | set | eeg | render-fail | — | ds003570: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds003645 | set | eeg | render-fail | — | ds003645: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds003682 | fif | meg | render-fail | — | ds003682: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds003694 | fif | meg | render-fail | — | ds003694: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds003702 | vhdr | eeg | render-fail | — | ds003702: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds003703 | fif | meg | render-fail | — | ds003703: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds003751 | set | eeg | render-fail | — | ds003751: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |

### unknown — 0 row(s)

Failures that did not match any classifier regex. Escalate to sleuth for one-by-one investigation.

_no rows_


## Top 10 surprising failures

(Sorted by rarest failing extension first, then by tests that never got a render_ms.)

| dataset_id | ext | datatype | verdict | render_ms | error_message |
|---|---|---|---|---:|---|
| ds002001 | ds | meg | render-fail | — | ds002001: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds002158 | vhdr | eeg | render-fail | — | ds002158: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds002181 | set | eeg | render-fail | — | ds002181: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds002578 | set | eeg | render-fail | — | ds002578: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds002718 | set | eeg | render-fail | — | ds002718: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds003078 | set | ieeg | render-fail | — | ds003078: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds003343 | bdf | eeg | render-fail | — | ds003343: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds003570 | set | eeg | render-fail | — | ds003570: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds003645 | set | eeg | render-fail | — | ds003645: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |
| ds003702 | vhdr | eeg | render-fail | — | ds003702: stage-caption never visible expect(locator).toBeVisible() failed Locator: locator('#stage-caption') Expected: visible Re |


## Per-dataset appendix

| dataset_id | ext | datatype | verdict | failure_class | render_ms | error_message |
|---|---|---|---|---|---:|---|
| ds000246 | ds | meg | pass | — | 1536 |  |
| ds000248 | fif | meg | pass | — | 1531 |  |
| ds001785 | set | eeg | pass | — | 36540 |  |
| ds001787 | bdf | eeg | pass | — | 1481 |  |
| ds001810 | vhdr | eeg | pass | — | 1485 |  |
| ds001849 | set | eeg | pass | — | 16500 |  |
| ds001971 | set | eeg | pass | — | 727 |  |
| ds002001 | ds | meg | render-fail | format-CTF-residual | — | ds002001: stage-caption never visible expect(locator).toBeVisible() failed Locator: locato |
| ds002034 | edf | eeg | pass | — | 1096 |  |
| ds002094 | vhdr | eeg | pass | — | 1099 |  |
| ds002158 | vhdr | eeg | render-fail | timeout-cold-cdn | — | ds002158: stage-caption never visible expect(locator).toBeVisible() failed Locator: locato |
| ds002181 | set | eeg | render-fail | timeout-cold-cdn | — | ds002181: stage-caption never visible expect(locator).toBeVisible() failed Locator: locato |
| ds002218 | set | eeg | pass | — | 327 |  |
| ds002312 | fif | meg | render-fail | timeout-cold-cdn | — | ds002312: stage-caption never visible expect(locator).toBeVisible() failed Locator: locato |
| ds002336 | vhdr | eeg | pass | — | 1093 |  |
| ds002338 | vhdr | eeg | pass | — | 1079 |  |
| ds002578 | set | eeg | render-fail | timeout-cold-cdn | — | ds002578: stage-caption never visible expect(locator).toBeVisible() failed Locator: locato |
| ds002680 | set | eeg | pass | — | 599 |  |
| ds002691 | set | eeg | pass | — | 589 |  |
| ds002712 | fif | meg | render-fail | timeout-cold-cdn | — | ds002712: stage-caption never visible expect(locator).toBeVisible() failed Locator: locato |
| ds002718 | set | eeg | render-fail | timeout-cold-cdn | — | ds002718: stage-caption never visible expect(locator).toBeVisible() failed Locator: locato |
| ds002720 | edf | eeg | pass | — | 1076 |  |
| ds002721 | edf | eeg | pass | — | 1073 |  |
| ds002722 | edf | eeg | pass | — | 1058 |  |
| ds002723 | edf | eeg | pass | — | 1104 |  |
| ds002724 | edf | eeg | pass | — | 1073 |  |
| ds002725 | edf | eeg | pass | — | 1062 |  |
| ds002761 | ds | meg | pass | — | 33128 |  |
| ds002778 | bdf | eeg | pass | — | 1094 |  |
| ds002791 | vhdr | eeg | pass | — | 1087 |  |
| ds002814 | set | eeg | pass | — | 1121 |  |
| ds002833 | vhdr | eeg | pass | — | 1100 |  |
| ds002885 | fif | meg | console-error | format-FIFF-no-raw-block | 3103 | console.error: Error: fiff: this file has no FIFFB_RAW_DATA block (events/projections/annotations on |
| ds002893 | set | eeg | pass | — | 384 |  |
| ds002908 | ds | meg | pass | — | 46139 |  |
| ds003004 | set | eeg | pass | — | 40137 |  |
| ds003029 | vhdr | ieeg | pass | — | 1112 |  |
| ds003039 | set | eeg | pass | — | 603 |  |
| ds003061 | set | eeg | pass | — | 2151 |  |
| ds003078 | set | ieeg | render-fail | timeout-cold-cdn | — | ds003078: stage-caption never visible expect(locator).toBeVisible() failed Locator: locato |
| ds003082 | ds | meg | pass | — | 49111 |  |
| ds003190 | vhdr | eeg | pass | — | 1111 |  |
| ds003194 | edf | eeg | pass | — | 1107 |  |
| ds003195 | edf | eeg | pass | — | 1073 |  |
| ds003343 | bdf | eeg | render-fail | timeout-cold-cdn | — | ds003343: stage-caption never visible expect(locator).toBeVisible() failed Locator: locato |
| ds003352 | fif | meg | console-error | format-FIFF-no-raw-block | 3094 | console.error: Error: fiff: this file has no FIFFB_RAW_DATA block (events/projections/annotations on |
| ds003374 | edf | ieeg | pass | — | 1139 |  |
| ds003392 | fif | meg | pass | — | 1068 |  |
| ds003420 | vhdr | eeg | pass | — | 1087 |  |
| ds003421 | vhdr | eeg | pass | — | 1090 |  |
| ds003458 | set | eeg | pass | — | 386 |  |
| ds003474 | set | eeg | pass | — | 341 |  |
| ds003478 | set | eeg | pass | — | 611 |  |
| ds003483 | fif | meg | render-fail | timeout-cold-cdn | — | ds003483: stage-caption never visible expect(locator).toBeVisible() failed Locator: locato |
| ds003490 | set | eeg | pass | — | 1115 |  |
| ds003498 | vhdr | ieeg | pass | — | 1130 |  |
| ds003506 | set | eeg | pass | — | 622 |  |
| ds003509 | set | eeg | pass | — | 645 |  |
| ds003516 | set | eeg | pass | — | 345 |  |
| ds003517 | set | eeg | pass | — | 405 |  |
| ds003518 | set | eeg | pass | — | 372 |  |
| ds003519 | set | eeg | pass | — | 615 |  |
| ds003522 | set | eeg | pass | — | 336 |  |
| ds003523 | set | eeg | pass | — | 335 |  |
| ds003555 | edf | eeg | pass | — | 1105 |  |
| ds003570 | set | eeg | render-fail | timeout-cold-cdn | — | ds003570: stage-caption never visible expect(locator).toBeVisible() failed Locator: locato |
| ds003602 | set | eeg | pass | — | 1139 |  |
| ds003626 | bdf | eeg | pass | — | 4078 |  |
| ds003638 | bdf | eeg | pass | — | 381 |  |
| ds003645 | set | eeg | render-fail | timeout-cold-cdn | — | ds003645: stage-caption never visible expect(locator).toBeVisible() failed Locator: locato |
| ds003655 | set | eeg | pass | — | 380 |  |
| ds003670 | set | eeg | pass | — | 48106 |  |
| ds003682 | fif | meg | render-fail | timeout-cold-cdn | — | ds003682: stage-caption never visible expect(locator).toBeVisible() failed Locator: locato |
| ds003688 | vhdr | ieeg | pass | — | 1114 |  |
| ds003690 | set | eeg | pass | — | 2159 |  |
| ds003694 | fif | meg | render-fail | timeout-cold-cdn | — | ds003694: stage-caption never visible expect(locator).toBeVisible() failed Locator: locato |
| ds003702 | vhdr | eeg | render-fail | timeout-cold-cdn | — | ds003702: stage-caption never visible expect(locator).toBeVisible() failed Locator: locato |
| ds003703 | fif | meg | render-fail | timeout-cold-cdn | — | ds003703: stage-caption never visible expect(locator).toBeVisible() failed Locator: locato |
| ds003710 | vhdr | eeg | pass | — | 1099 |  |
| ds003739 | set | eeg | pass | — | 339 |  |
| ds003751 | set | eeg | render-fail | timeout-cold-cdn | — | ds003751: stage-caption never visible expect(locator).toBeVisible() failed Locator: locato |
| ds003753 | set | eeg | pass | — | 362 |  |
| ds003766 | set | eeg | pass | — | 16076 |  |
| ds003768 | vhdr | eeg | pass | — | 1101 |  |
| ds003774 | set | eeg | pass | — | 636 |  |
| ds003775 | edf | eeg | pass | — | 1122 |  |
| ds003801 | set | eeg | pass | — | 340 |  |
| ds003805 | set | eeg | pass | — | 1105 |  |
| ds003810 | edf | eeg | pass | — | 1085 |  |


## How to reproduce

```bash
# Regenerate the audit JSON (file-existence probes, ~10 min):
node scripts/audit-100-datasets.mjs --full --out=scripts/audit-100-datasets.json

# Full 712-URL browser run (~50 min wall at 4 workers):
rm -f tests/evidence/audit-browser-reality/results.worker-*.jsonl
npm run test:audit-reality:full

# Merge per-worker shards + classify + render:
npm run merge:audit-shards
npm run classify:audit-failures
npm run report:audit-reality:full
```

## Notes

- The audit JSON marks "loadable" based on a 1-byte HEAD-range probe. This report verifies the viewer's reader actually decodes + renders the file in a real Chromium.
- Network flakes are classified separately from real reader bugs (see the `network-flake` bin). Re-run the listed URLs in isolation before opening an issue.
- The `unknown` bin is the action queue: failures with no matching regex bin. Escalate row-by-row to the `sleuth` agent.
