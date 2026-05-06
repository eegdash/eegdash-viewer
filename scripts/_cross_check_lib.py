"""Shared scaffolding for the per-format cross-check Python scripts.

Captures only the bits that are genuinely identical: cached HTTP fetch
(with atomic rename to avoid corrupt partial caches on Ctrl-C) and the
JSON envelope that Node smokes consume. Format-specific bits (which
mne reader to call, which extra fields to attach) stay inline.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path
from typing import Any, Callable


def make_fetcher(s3_base: str, cache_dir: Path) -> Callable[[str], Path]:
    """Return a `fetch(name) -> Path` that caches under `cache_dir`.

    Downloads stream into `<dst>.part` and are atomically renamed on
    success. A Ctrl-C mid-download leaves only the .part file around;
    the next run re-downloads cleanly instead of mistaking a partial
    file for a complete cache hit.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)

    def fetch(name: str) -> Path:
        dst = cache_dir / name
        if dst.exists() and dst.stat().st_size > 0:
            return dst
        partial = dst.with_suffix(dst.suffix + ".part")
        print(f"  downloading {name}", file=sys.stderr)
        urllib.request.urlretrieve(f"{s3_base}/{name}", partial)
        os.replace(partial, dst)
        return dst

    return fetch


def dump_reference(
    out_path: Path,
    *,
    source: str,
    raw,
    n_ref: int,
    values_uv,
    extras: dict[str, Any] | None = None,
) -> None:
    """Write the JSON the Node smoke tests load.

    `raw` is an mne Raw object; we pull n_channels / n_samples / fs /
    channel names from it. `values_uv` is a (n_channels, n_ref) float32
    array already converted to microvolts (mne returns volts). Pass
    format-specific extras (e.g. `is_stim` for EDF) via `extras`.
    """
    payload = {
        "source": source,
        "n_channels": int(raw.info["nchan"]),
        "n_samples_total": int(raw.n_times),
        "sampling_frequency": float(raw.info["sfreq"]),
        "channel_names": raw.ch_names,
        "first_n": n_ref,
        "values_uv": values_uv.tolist(),
    }
    if extras:
        payload.update(extras)
    out_path.write_text(json.dumps(payload))
    print(
        f"wrote {out_path}  "
        f"channels={payload['n_channels']}  fs={payload['sampling_frequency']}Hz  "
        f"n_samples={payload['n_samples_total']}",
        file=sys.stderr,
    )
