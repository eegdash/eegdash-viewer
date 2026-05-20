# EEG fixture attribution

All files in this directory are derived from open-access BIDS datasets
distributed on OpenNeuro under the **CC0 1.0 Universal Public Domain
Dedication** ([creativecommons.org/publicdomain/zero/1.0](https://creativecommons.org/publicdomain/zero/1.0/)).

They are used as fuzz-test corpus seeds and parser-header regression
inputs. Binary files have been truncated to the smallest useful prefix
(typically the first 32–64 KB) so the repository stays compact; this
is sufficient for header-parser fuzzing and contract testing but is
NOT sufficient for full recording playback.

Per CC0 there is no legal requirement to attribute; we do so anyway as
a courtesy to the data depositors.

## Inventory

| File | Format | Bytes | Source dataset | Subject | Truncated? |
|---|---|---:|---|---|---|
| `sub-01_ses-01_task-offline_run-01_eeg.edf` | EDF | 32 KB | [ds002034 v1.0.3](https://openneuro.org/datasets/ds002034) | sub-01 | yes (header + first records of 60 MB original) |
| `sub-xp101_task-motorloc_eeg.vhdr` | BrainVision (.vhdr) | 12 KB | [ds002336](https://openneuro.org/datasets/ds002336) | sub-xp101 | no (full file) |
| `sub-xp101_task-motorloc_eeg.vmrk` | BrainVision (.vmrk) | 6 KB | [ds002336](https://openneuro.org/datasets/ds002336) | sub-xp101 | no (full file) |
| `sub-xp101_task-motorloc_eeg.eeg`  | BrainVision (.eeg)  | 32 KB | [ds002336](https://openneuro.org/datasets/ds002336) | sub-xp101 | yes (first 32 KB of 215 MB original) |
| `sub-001_task-AuditoryVisualShift_run-01_eeg.set` | EEGLAB (.set) | 64 KB | [ds002893 v2.0.0](https://openneuro.org/datasets/ds002893) | sub-001 | yes (header + part of MATLAB struct from 67 MB original) |

## Dataset citations

- **ds002034** — Schneider C., Pereira M., Tonin L., Millán J.d.R.
  *Real-time EEG feedback on alpha power lateralization leads to behavioral
  improvements in a covert attention task.*
  Brain Topogr (2019). doi:10.1007/s10548-019-00725-9
  Accession: doi:10.18112/openneuro.ds002034.v1.0.3

- **ds002336** — Lioi G., Cury C., Perronnet L., Mano M., Bannier E.,
  Lécuyer A., Barillot C.
  *Simultaneous MRI-EEG during a motor imagery neurofeedback task: an
  open access brain imaging dataset for multi-modal data integration.*
  bioRxiv 862375. doi:10.1101/862375

- **ds002893** — Ceponiene R., Westerfield M., Torki M., Townsend J.
  *Modality-specificity of sensory aging in vision and audition:
  Evidence from event-related potentials.*
  Brain Research 1215 (2008) 53-68. doi:10.1016/j.brainres.2008.02.010
  Accession: doi:10.18112/openneuro.ds002893.v2.0.0

## How to re-fetch / extend

Run from repo root:

```bash
mkdir -p tests/fixtures/eeg
# Small BrainVision headers (full files)
curl -sSL -o tests/fixtures/eeg/sub-xp101_task-motorloc_eeg.vhdr \
  "https://s3.amazonaws.com/openneuro.org/ds002336/sub-xp101/eeg/sub-xp101_task-motorloc_eeg.vhdr"
curl -sSL -o tests/fixtures/eeg/sub-xp101_task-motorloc_eeg.vmrk \
  "https://s3.amazonaws.com/openneuro.org/ds002336/sub-xp101/eeg/sub-xp101_task-motorloc_eeg.vmrk"
# Truncated binary samples (first 32-64 KB)
curl -sSL -H "Range: bytes=0-32767" -o tests/fixtures/eeg/sub-xp101_task-motorloc_eeg.eeg \
  "https://s3.amazonaws.com/openneuro.org/ds002336/sub-xp101/eeg/sub-xp101_task-motorloc_eeg.eeg"
curl -sSL -H "Range: bytes=0-32767" -o tests/fixtures/eeg/sub-01_ses-01_task-offline_run-01_eeg.edf \
  "https://s3.amazonaws.com/openneuro.org/ds002034/sub-01/ses-01/eeg/sub-01_ses-01_task-offline_run-01_eeg.edf"
curl -sSL -H "Range: bytes=0-65535" -o tests/fixtures/eeg/sub-001_task-AuditoryVisualShift_run-01_eeg.set \
  "https://s3.amazonaws.com/openneuro.org/ds002893/sub-001/eeg/sub-001_task-AuditoryVisualShift_run-01_eeg.set"
```

## TODO

- FIFF (MEG): no small public-domain sample identified. The existing
  `tests/prop-fiff.test.mjs` runs in synthetic-bytes mode; that's
  acceptable for header-parser fuzzing but a real fixture would tighten
  the mutation surface. Candidates: MNE-Python's BSD-licensed test data
  ([mne-tools/mne-testing-data](https://github.com/mne-tools/mne-testing-data)),
  or a NEMAR FIFF dataset.
- BDF: 24-bit EDF variant. Not yet added; pattern would be identical to
  EDF if a small CC0 source is found.
