window.BENCHMARK_DATA = {
  "lastUpdate": 1780241012700,
  "repoUrl": "https://github.com/eegdash/eegdash-viewer",
  "entries": {
    "Benchmark": [
      {
        "commit": {
          "author": {
            "email": "b.aristimunha@gmail.com",
            "name": "Bru",
            "username": "bruAristimunha"
          },
          "committer": {
            "email": "b.aristimunha@gmail.com",
            "name": "Bru",
            "username": "bruAristimunha"
          },
          "distinct": true,
          "id": "66ab77ddb5d7e528673e36d34c70a9462eceb050",
          "message": "fix(ci): pin tinybench to v5 for CodSpeed plugin compatibility\n\nCodSpeed failed with \"TypeError: fn is not a function\" since tinybench\nwas bumped to v6: v6 made Task.fn private, but @codspeed/tinybench-plugin\n(built for tinybench v5, even at latest 5.5.0) destructures `const { fn }\n= task` and calls fn() directly in its instrumented runner. The break\nonly surfaces under the real CodSpeed/Valgrind runner, which is why plain\n`npm run test:bench` and local CSE_PERF=1 runs passed.\n\nDowngrade tinybench 6.0.2 -> ^5.1.0 (the version the plugin targets).\nThe bench harness already reads both v5 (flat result) and v6 (nested\nlatency) shapes, and only uses time/warmupTime constructor options that\nexist in both, so the statistical bench suite is unaffected — verified:\nfull no-network suite writes 35 metrics with no errors.",
          "timestamp": "2026-05-31T16:34:28+02:00",
          "tree_id": "3dc6e3c76fef18cc71a5e9688ae7faa8c6e1ebf3",
          "url": "https://github.com/eegdash/eegdash-viewer/commit/66ab77ddb5d7e528673e36d34c70a9462eceb050"
        },
        "date": 1780238472617,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "filter_hp_250hz",
            "value": 2.3359,
            "range": "±1.46%",
            "unit": "ms",
            "extra": "p99=4.311ms, n=857samples"
          },
          {
            "name": "filter_lp_250hz",
            "value": 2.3475,
            "range": "±1.42%",
            "unit": "ms",
            "extra": "p99=4.337ms, n=852samples"
          },
          {
            "name": "filter_notch_250hz",
            "value": 2.3387,
            "range": "±1.46%",
            "unit": "ms",
            "extra": "p99=4.368ms, n=856samples"
          },
          {
            "name": "filter_bp_250hz",
            "value": 4.1907,
            "range": "±1.36%",
            "unit": "ms",
            "extra": "p99=6.362ms, n=478samples"
          },
          {
            "name": "filter_hp_512hz",
            "value": 4.5816,
            "range": "±1.27%",
            "unit": "ms",
            "extra": "p99=6.726ms, n=437samples"
          },
          {
            "name": "filter_lp_512hz",
            "value": 4.6325,
            "range": "±1.34%",
            "unit": "ms",
            "extra": "p99=6.830ms, n=432samples"
          },
          {
            "name": "filter_notch_512hz",
            "value": 4.6169,
            "range": "±1.33%",
            "unit": "ms",
            "extra": "p99=6.798ms, n=434samples"
          },
          {
            "name": "filter_bp_512hz",
            "value": 8.5726,
            "range": "±1.35%",
            "unit": "ms",
            "extra": "p99=10.596ms, n=234samples"
          },
          {
            "name": "filter_hp_1000hz",
            "value": 8.9818,
            "range": "±1.33%",
            "unit": "ms",
            "extra": "p99=10.966ms, n=223samples"
          },
          {
            "name": "filter_lp_1000hz",
            "value": 9.0736,
            "range": "±1.38%",
            "unit": "ms",
            "extra": "p99=10.990ms, n=221samples"
          },
          {
            "name": "filter_notch_1000hz",
            "value": 9.0953,
            "range": "±1.41%",
            "unit": "ms",
            "extra": "p99=11.062ms, n=221samples"
          },
          {
            "name": "filter_bp_1000hz",
            "value": 16.6891,
            "range": "±1.06%",
            "unit": "ms",
            "extra": "p99=18.297ms, n=120samples"
          },
          {
            "name": "matv5_pipeline_32ch_250hz_30s_single",
            "value": 0.0101,
            "range": "±0.23%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=198418samples"
          },
          {
            "name": "matv5_pipeline_64ch_512hz_60s_single",
            "value": 0.0101,
            "range": "±0.59%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=197661samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_single",
            "value": 0.0101,
            "range": "±0.48%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=198001samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_double",
            "value": 8.1416,
            "range": "±0.73%",
            "unit": "ms",
            "extra": "p99=9.887ms, n=246samples"
          },
          {
            "name": "matv5_parse_raw_1MB",
            "value": 0.0028,
            "range": "±0.23%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=713536samples"
          },
          {
            "name": "matv5_parse_raw_10MB",
            "value": 0.0028,
            "range": "±1.75%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=705439samples"
          },
          {
            "name": "matv5_parse_raw_50MB",
            "value": 0.0029,
            "range": "±0.31%",
            "unit": "ms",
            "extra": "p99=0.007ms, n=679040samples"
          },
          {
            "name": "cache_scrub_lru",
            "value": 241.6765,
            "range": "±0.05%",
            "unit": "ms",
            "extra": "p99=243.304ms, n=64samples"
          },
          {
            "name": "cache_scrub_fifo",
            "value": 272.0444,
            "range": "±0.04%",
            "unit": "ms",
            "extra": "p99=273.276ms, n=64samples"
          },
          {
            "name": "cache_concurrent_dedup",
            "value": 30.2734,
            "range": "±0.11%",
            "unit": "ms",
            "extra": "p99=30.853ms, n=67samples"
          },
          {
            "name": "cache_concurrent_no_dedup",
            "value": 30.2912,
            "range": "±0.11%",
            "unit": "ms",
            "extra": "p99=30.943ms, n=67samples"
          },
          {
            "name": "readwindow_edf_2s",
            "value": 32.744,
            "range": "±1.13%",
            "unit": "ms",
            "extra": "p99=35.890ms, n=64samples"
          },
          {
            "name": "readwindow_edf_10s",
            "value": 36.534,
            "range": "±9.77%",
            "unit": "ms",
            "extra": "p99=86.596ms, n=64samples"
          },
          {
            "name": "readwindow_edf_30s",
            "value": 54.9924,
            "range": "±15.87%",
            "unit": "ms",
            "extra": "p99=170.985ms, n=64samples"
          },
          {
            "name": "readwindow_bv_large_2s",
            "value": 0,
            "range": "±NaN%",
            "unit": "ms",
            "extra": "p99=NaNms, n=0samples"
          },
          {
            "name": "readwindow_bv_large_10s",
            "value": 0,
            "range": "±NaN%",
            "unit": "ms",
            "extra": "p99=NaNms, n=0samples"
          },
          {
            "name": "readwindow_bv_large_30s",
            "value": 0,
            "range": "±NaN%",
            "unit": "ms",
            "extra": "p99=NaNms, n=0samples"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "b.aristimunha@gmail.com",
            "name": "Bru",
            "username": "bruAristimunha"
          },
          "committer": {
            "email": "b.aristimunha@gmail.com",
            "name": "Bru",
            "username": "bruAristimunha"
          },
          "distinct": true,
          "id": "612d7d5ba30d6a55a0bb93b0334d96cafff42a56",
          "message": "fix(bids): keep channel metadata when record dep_keys omit _channels.tsv\n\nThe records-API fast path resolved sidecars only from the per-recording\nstorage.dep_keys, but for some formats those list binary siblings (e.g.\nBrainVision .eeg/.vmrk/.dat) and omit _channels.tsv — leaving meta.channels\nnull and the channel panel empty (e2e regression: \"channel list must have\nrows\", ds002336 BrainVision).\n\n- Fall back to the BIDS-inheritance walk for any enrichment sidecar\n  (_channels/_events/_electrodes/_coordsystem) not present in dep_keys,\n  restoring channel/event/electrode metadata. The _eeg.json walk stays\n  skipped (sfreq comes from the record), so the fast-path win is preserved.\n- Synthesise a minimal channel list from the record's ch_names when no\n  _channels.tsv exists anywhere, so the channel panel always populates.\n\n149 bids-recording unit tests pass (+1 new), full suite 0 failures, typecheck clean.",
          "timestamp": "2026-05-31T16:52:38+02:00",
          "tree_id": "670aebad9413a4462ca3569a3541c3ab1a6312a6",
          "url": "https://github.com/eegdash/eegdash-viewer/commit/612d7d5ba30d6a55a0bb93b0334d96cafff42a56"
        },
        "date": 1780239376491,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "filter_hp_250hz",
            "value": 2.1565,
            "range": "±0.28%",
            "unit": "ms",
            "extra": "p99=2.419ms, n=928samples"
          },
          {
            "name": "filter_lp_250hz",
            "value": 2.1883,
            "range": "±0.95%",
            "unit": "ms",
            "extra": "p99=3.458ms, n=914samples"
          },
          {
            "name": "filter_notch_250hz",
            "value": 2.1456,
            "range": "±0.21%",
            "unit": "ms",
            "extra": "p99=2.361ms, n=933samples"
          },
          {
            "name": "filter_bp_250hz",
            "value": 3.939,
            "range": "±0.43%",
            "unit": "ms",
            "extra": "p99=4.229ms, n=508samples"
          },
          {
            "name": "filter_hp_512hz",
            "value": 4.3301,
            "range": "±0.25%",
            "unit": "ms",
            "extra": "p99=4.589ms, n=462samples"
          },
          {
            "name": "filter_lp_512hz",
            "value": 4.3237,
            "range": "±0.21%",
            "unit": "ms",
            "extra": "p99=4.515ms, n=463samples"
          },
          {
            "name": "filter_notch_512hz",
            "value": 4.3257,
            "range": "±0.21%",
            "unit": "ms",
            "extra": "p99=4.521ms, n=463samples"
          },
          {
            "name": "filter_bp_512hz",
            "value": 7.9534,
            "range": "±0.14%",
            "unit": "ms",
            "extra": "p99=8.138ms, n=252samples"
          },
          {
            "name": "filter_hp_1000hz",
            "value": 8.4091,
            "range": "±0.19%",
            "unit": "ms",
            "extra": "p99=8.717ms, n=238samples"
          },
          {
            "name": "filter_lp_1000hz",
            "value": 8.3852,
            "range": "±0.14%",
            "unit": "ms",
            "extra": "p99=8.590ms, n=239samples"
          },
          {
            "name": "filter_notch_1000hz",
            "value": 8.4796,
            "range": "±0.65%",
            "unit": "ms",
            "extra": "p99=10.603ms, n=236samples"
          },
          {
            "name": "filter_bp_1000hz",
            "value": 15.4305,
            "range": "±0.10%",
            "unit": "ms",
            "extra": "p99=15.709ms, n=130samples"
          },
          {
            "name": "matv5_pipeline_32ch_250hz_30s_single",
            "value": 0.01,
            "range": "±0.34%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=199590samples"
          },
          {
            "name": "matv5_pipeline_64ch_512hz_60s_single",
            "value": 0.01,
            "range": "±0.27%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=200533samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_single",
            "value": 0.01,
            "range": "±0.23%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=200413samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_double",
            "value": 8.2503,
            "range": "±0.85%",
            "unit": "ms",
            "extra": "p99=9.735ms, n=243samples"
          },
          {
            "name": "matv5_parse_raw_1MB",
            "value": 0.0028,
            "range": "±0.24%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=714489samples"
          },
          {
            "name": "matv5_parse_raw_10MB",
            "value": 0.0029,
            "range": "±1.70%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=700089samples"
          },
          {
            "name": "matv5_parse_raw_50MB",
            "value": 0.0028,
            "range": "±0.26%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=714922samples"
          },
          {
            "name": "cache_scrub_lru",
            "value": 241.6356,
            "range": "±0.04%",
            "unit": "ms",
            "extra": "p99=242.638ms, n=64samples"
          },
          {
            "name": "cache_scrub_fifo",
            "value": 271.73,
            "range": "±0.03%",
            "unit": "ms",
            "extra": "p99=272.893ms, n=64samples"
          },
          {
            "name": "cache_concurrent_dedup",
            "value": 30.1908,
            "range": "±0.06%",
            "unit": "ms",
            "extra": "p99=30.248ms, n=67samples"
          },
          {
            "name": "cache_concurrent_no_dedup",
            "value": 30.2042,
            "range": "±0.06%",
            "unit": "ms",
            "extra": "p99=30.316ms, n=67samples"
          },
          {
            "name": "readwindow_edf_2s",
            "value": 67.8731,
            "range": "±100.66%",
            "unit": "ms",
            "extra": "p99=1106.639ms, n=64samples"
          },
          {
            "name": "readwindow_edf_10s",
            "value": 758.7689,
            "range": "±101.25%",
            "unit": "ms",
            "extra": "p99=15760.677ms, n=64samples"
          },
          {
            "name": "readwindow_edf_30s",
            "value": 41.2589,
            "range": "±7.74%",
            "unit": "ms",
            "extra": "p99=85.751ms, n=64samples"
          },
          {
            "name": "readwindow_bv_large_2s",
            "value": 0,
            "range": "±NaN%",
            "unit": "ms",
            "extra": "p99=NaNms, n=0samples"
          },
          {
            "name": "readwindow_bv_large_10s",
            "value": 0,
            "range": "±NaN%",
            "unit": "ms",
            "extra": "p99=NaNms, n=0samples"
          },
          {
            "name": "readwindow_bv_large_30s",
            "value": 0,
            "range": "±NaN%",
            "unit": "ms",
            "extra": "p99=NaNms, n=0samples"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "b.aristimunha@gmail.com",
            "name": "Bru",
            "username": "bruAristimunha"
          },
          "committer": {
            "email": "b.aristimunha@gmail.com",
            "name": "Bru",
            "username": "bruAristimunha"
          },
          "distinct": true,
          "id": "a00b049ac36ad4ba39010f3b89308b81105eecc9",
          "message": "ci: route >500MB FIFF streaming to nightly; disable CodSpeed auto-run\n\n- streaming-large.spec.mjs: gate the 644MB/2GB MEG FIFF targets behind\n  STREAMING_NIGHTLY. Their open time is dominated by cold-CDN byte-transfer\n  of the huge file (24-40s cold vs ~3-4s warm) — variance no viewer-side\n  optimization controls — so they flake the PR gate. The .set/EDF streaming\n  targets stay in PR CI.\n- nightly.yml: add a \"Large-file streaming\" job that runs the spec with\n  STREAMING_NIGHTLY=1 so the huge-file path is still tracked daily.\n- codspeed.yml: drop push/PR triggers (workflow_dispatch only). The benches\n  run fine (tinybench pinned to v5) but the upload needs a CODSPEED_TOKEN +\n  repo registration that isn't set; perf is covered by bench.yml meanwhile.",
          "timestamp": "2026-05-31T17:21:20+02:00",
          "tree_id": "aab500f1b8afefc2d5c55d8d1994fb70f0df6ba0",
          "url": "https://github.com/eegdash/eegdash-viewer/commit/a00b049ac36ad4ba39010f3b89308b81105eecc9"
        },
        "date": 1780241011868,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "filter_hp_250hz",
            "value": 2.405,
            "range": "±1.75%",
            "unit": "ms",
            "extra": "p99=4.456ms, n=832samples"
          },
          {
            "name": "filter_lp_250hz",
            "value": 2.446,
            "range": "±1.76%",
            "unit": "ms",
            "extra": "p99=4.597ms, n=818samples"
          },
          {
            "name": "filter_notch_250hz",
            "value": 2.3611,
            "range": "±1.53%",
            "unit": "ms",
            "extra": "p99=4.433ms, n=848samples"
          },
          {
            "name": "filter_bp_250hz",
            "value": 4.384,
            "range": "±1.85%",
            "unit": "ms",
            "extra": "p99=7.497ms, n=457samples"
          },
          {
            "name": "filter_hp_512hz",
            "value": 4.7642,
            "range": "±1.67%",
            "unit": "ms",
            "extra": "p99=7.743ms, n=420samples"
          },
          {
            "name": "filter_lp_512hz",
            "value": 4.8856,
            "range": "±2.32%",
            "unit": "ms",
            "extra": "p99=7.883ms, n=410samples"
          },
          {
            "name": "filter_notch_512hz",
            "value": 4.721,
            "range": "±1.61%",
            "unit": "ms",
            "extra": "p99=7.723ms, n=424samples"
          },
          {
            "name": "filter_bp_512hz",
            "value": 8.8384,
            "range": "±1.87%",
            "unit": "ms",
            "extra": "p99=11.837ms, n=227samples"
          },
          {
            "name": "filter_hp_1000hz",
            "value": 9.9914,
            "range": "±1.98%",
            "unit": "ms",
            "extra": "p99=12.300ms, n=201samples"
          },
          {
            "name": "filter_lp_1000hz",
            "value": 9.6904,
            "range": "±1.88%",
            "unit": "ms",
            "extra": "p99=12.297ms, n=207samples"
          },
          {
            "name": "filter_notch_1000hz",
            "value": 9.6191,
            "range": "±1.81%",
            "unit": "ms",
            "extra": "p99=12.095ms, n=208samples"
          },
          {
            "name": "filter_bp_1000hz",
            "value": 16.9315,
            "range": "±1.58%",
            "unit": "ms",
            "extra": "p99=20.488ms, n=119samples"
          },
          {
            "name": "matv5_pipeline_32ch_250hz_30s_single",
            "value": 0.0098,
            "range": "±0.27%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=204443samples"
          },
          {
            "name": "matv5_pipeline_64ch_512hz_60s_single",
            "value": 0.0098,
            "range": "±0.30%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=204837samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_single",
            "value": 0.0098,
            "range": "±0.28%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=203363samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_double",
            "value": 8.4061,
            "range": "±1.82%",
            "unit": "ms",
            "extra": "p99=14.801ms, n=238samples"
          },
          {
            "name": "matv5_parse_raw_1MB",
            "value": 0.0027,
            "range": "±0.24%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=743721samples"
          },
          {
            "name": "matv5_parse_raw_10MB",
            "value": 0.0027,
            "range": "±0.28%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=740972samples"
          },
          {
            "name": "matv5_parse_raw_50MB",
            "value": 0.0027,
            "range": "±0.26%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=739276samples"
          },
          {
            "name": "cache_scrub_lru",
            "value": 241.5142,
            "range": "±0.04%",
            "unit": "ms",
            "extra": "p99=242.962ms, n=64samples"
          },
          {
            "name": "cache_scrub_fifo",
            "value": 271.8318,
            "range": "±0.05%",
            "unit": "ms",
            "extra": "p99=272.835ms, n=64samples"
          },
          {
            "name": "cache_concurrent_dedup",
            "value": 30.2334,
            "range": "±0.16%",
            "unit": "ms",
            "extra": "p99=31.267ms, n=67samples"
          },
          {
            "name": "cache_concurrent_no_dedup",
            "value": 30.2855,
            "range": "±0.05%",
            "unit": "ms",
            "extra": "p99=30.512ms, n=67samples"
          },
          {
            "name": "readwindow_edf_2s",
            "value": 30.3268,
            "range": "±0.99%",
            "unit": "ms",
            "extra": "p99=33.756ms, n=66samples"
          },
          {
            "name": "readwindow_edf_10s",
            "value": 40.7933,
            "range": "±23.06%",
            "unit": "ms",
            "extra": "p99=233.800ms, n=64samples"
          },
          {
            "name": "readwindow_edf_30s",
            "value": 49.4835,
            "range": "±11.64%",
            "unit": "ms",
            "extra": "p99=150.783ms, n=64samples"
          },
          {
            "name": "readwindow_bv_large_2s",
            "value": 0,
            "range": "±NaN%",
            "unit": "ms",
            "extra": "p99=NaNms, n=0samples"
          },
          {
            "name": "readwindow_bv_large_10s",
            "value": 0,
            "range": "±NaN%",
            "unit": "ms",
            "extra": "p99=NaNms, n=0samples"
          },
          {
            "name": "readwindow_bv_large_30s",
            "value": 0,
            "range": "±NaN%",
            "unit": "ms",
            "extra": "p99=NaNms, n=0samples"
          }
        ]
      }
    ]
  }
}