#!/usr/bin/env bash
# Records to probe through cdn.eegdash.org — three formats
records=(
  "EEGLAB|ds002893|sub-001|task-AuditoryVisualShift_run-01|set,fdt"
  "EDF   |ds002034|sub-01|ses-01_task-offline_run-01|edf"
  "BV    |ds002336|sub-01|ses-01_task-rest_run-01|vhdr,eeg,vmrk"
)
for rec in "${records[@]}"; do
  IFS='|' read -r fmt ds sub entity exts <<< "$rec"
  echo "=========================================="
  echo "  $fmt — $ds / $sub / $entity"
  echo "=========================================="
  prefix="https://cdn.eegdash.org/${ds}/${sub}"
  if [[ "$entity" == ses-* ]]; then
    ses=$(echo "$entity" | cut -d_ -f1)
    prefix="${prefix}/${ses}"
  fi
  prefix="${prefix}/eeg/${sub}_${entity}"
  for ext in $(echo "$exts" | tr , ' '); do
    url="${prefix}_eeg.${ext}"
    if [[ "$ext" == "set" || "$ext" == "vhdr" || "$ext" == "vmrk" ]]; then
      # text/header file: full GET
      curl -s -o /dev/null --max-time 15 \
        -w "  ${ext}        status=%{http_code}  bytes=%{size_download}  ttfb=%{time_starttransfer}s  cdn=%header{x-eegdash-cdn}\n" \
        "$url"
    else
      # binary: Range request (first 1 MB)
      curl -s -o /dev/null --max-time 15 \
        -H "Range: bytes=0-1048575" \
        -w "  ${ext}.range  status=%{http_code}  bytes=%{size_download}  ttfb=%{time_starttransfer}s  cdn=%header{x-eegdash-cdn}\n" \
        "$url"
    fi
  done
  # sidecars
  for sc in eeg.json channels.tsv events.tsv; do
    url="${prefix}_${sc}"
    curl -s -o /dev/null --max-time 10 \
      -w "  ${sc}  status=%{http_code}  bytes=%{size_download}  cdn=%header{x-eegdash-cdn}\n" \
      "$url"
  done
done
