# NWB streaming reader — verification evidence

## Synthetic chunked-large fixture (22 MB)

`tests/fixtures/ieeg/nwb-chunked-large.nwb` — 100,000 samples × 64
channels at 1000 Hz, chunks `(1000, 64)`, gzip-compressed. Generated
via h5py with metadata written before the big data dataset (matches
the layout produced by pynwb's default writer for ElectricalSeries).

### Streaming reader perf — forced via probeLength=5 GB to bypass the
### whole-file path even though the fixture is small.

| Operation                  | Time   | HTTP calls | Bytes fetched |
|----------------------------|--------|-----------:|--------------:|
| open()                     | 6 ms   | 1          | 16 MB (head)  |
| readWindow(0, 1000)        | 19 ms  | 7          | 186 KB        |
| readWindow(95000, 1000)    | 12 ms  | 7          | 231 KB        |
| readWindow(0, 30000)       | 143 ms | 36         | 6.6 MB        |

`readWindow` bandwidth is O(window), not O(file). The 22 MB file
never gets fully downloaded.

## Test suite verification

```
$ npx node --test --test-reporter=spec tests/unit-nwb.test.mjs tests/unit-nwb-range.test.mjs
ℹ tests 23
ℹ pass 23
ℹ fail 0
```

13 original whole-file tests + 10 new streaming tests, all green.

## Real DANDI verification — known limitations

Real DANDI iEEG files (e.g. dandiset 000019 sub-EC2 sessions, 1-2 GB
each) routinely have HDF5 metadata that is *scattered* throughout the
file rather than packed into the first ~MB. Empirically:

- dandiset 000020 `sub-599387254_ses-601506492_icephys.nwb` (17 MB):
  jsfive fails on a 16 MB head buffer ("Offset is outside the bounds
  of the DataView"); requires the full 17 MB to parse the root group.

- dandiset 000051 `pons8-yo_16xdownsampled.nwb` (585 MB): jsfive
  fails on any head buffer up to 64 MB. Metadata is scattered into
  later regions of the file.

For these files the reader auto-falls-back to the whole-file path
(now capped at 1 GB instead of the previous 200 MB cap). This is
**the right behaviour today** — for files between 200 MB and 1 GB the
whole-file download is acceptable; above 1 GB we surface a clean
error pointing the user at pynwb / nwbinspector subsetting.

A future enhancement (tracked as a follow-up) would patch jsfive to
support a sparse-buffer wrapper that lazily fetches HDF5 metadata
pages on demand. That would extend streaming support to files with
scattered metadata at any size. The work is ~hours of jsfive
modification with regression risk for SNIRF + MAT v7.3 (which share
the same _jsfive.js); not in scope for this commit set.

## Per-format behaviour after this change

| File size              | Path taken                     | Behaviour vs Lane H1  |
|------------------------|--------------------------------|-----------------------|
| ≤ 200 MB               | whole-file (unchanged)         | byte-identical        |
| 200 MB - 1 GB chunked, metadata at head | streaming    | NEW: fetches O(window) |
| 200 MB - 1 GB metadata scattered      | streaming → fallback | NEW: still works |
| > 1 GB chunked, metadata at head      | streaming           | NEW: works (was: cap) |
| > 1 GB metadata scattered             | error               | NEW: clean error msg  |

The 200 MB cap from Lane H1 is replaced by:
- A 1 GB cap on the *whole-file* path (was 200 MB).
- No cap on the *streaming* path, but it requires metadata to fit
  in the first 16 MB (configurable in `formats/_h5-stream.js`).
