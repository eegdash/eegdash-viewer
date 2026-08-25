window.BENCHMARK_DATA = {
  "lastUpdate": 1787695216823,
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
      },
      {
        "commit": {
          "author": {
            "email": "b.aristimunha@gmail.com",
            "name": "Bru",
            "username": "bruAristimunha"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "4101c562a83b265e02adc6a37c870860f5e8341c",
          "message": "Merge pull request #1 from eegdash/feat/pose-panel\n\nfeat(pose): synchronized hand-pose panel from JSON sidecars (F10)",
          "timestamp": "2026-08-25T13:28:46+02:00",
          "tree_id": "6c9c38bd1bfa098b775c49dc8e83bd72a9343379",
          "url": "https://github.com/eegdash/eegdash-viewer/commit/4101c562a83b265e02adc6a37c870860f5e8341c"
        },
        "date": 1787657810637,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "filter_hp_250hz",
            "value": 2.2077,
            "range": "±1.44%",
            "unit": "ms",
            "extra": "p99=3.842ms, n=906samples"
          },
          {
            "name": "filter_lp_250hz",
            "value": 2.1648,
            "range": "±1.31%",
            "unit": "ms",
            "extra": "p99=3.844ms, n=924samples"
          },
          {
            "name": "filter_notch_250hz",
            "value": 2.1481,
            "range": "±1.25%",
            "unit": "ms",
            "extra": "p99=3.846ms, n=932samples"
          },
          {
            "name": "filter_bp_250hz",
            "value": 4.2477,
            "range": "±2.07%",
            "unit": "ms",
            "extra": "p99=7.264ms, n=471samples"
          },
          {
            "name": "filter_hp_512hz",
            "value": 4.3547,
            "range": "±1.59%",
            "unit": "ms",
            "extra": "p99=7.658ms, n=460samples"
          },
          {
            "name": "filter_lp_512hz",
            "value": 4.3563,
            "range": "±1.63%",
            "unit": "ms",
            "extra": "p99=7.680ms, n=460samples"
          },
          {
            "name": "filter_notch_512hz",
            "value": 4.249,
            "range": "±1.26%",
            "unit": "ms",
            "extra": "p99=7.597ms, n=471samples"
          },
          {
            "name": "filter_bp_512hz",
            "value": 8.0506,
            "range": "±1.77%",
            "unit": "ms",
            "extra": "p99=12.976ms, n=249samples"
          },
          {
            "name": "filter_hp_1000hz",
            "value": 8.3353,
            "range": "±1.61%",
            "unit": "ms",
            "extra": "p99=13.620ms, n=240samples"
          },
          {
            "name": "filter_lp_1000hz",
            "value": 8.4218,
            "range": "±1.86%",
            "unit": "ms",
            "extra": "p99=13.619ms, n=238samples"
          },
          {
            "name": "filter_notch_1000hz",
            "value": 8.35,
            "range": "±1.70%",
            "unit": "ms",
            "extra": "p99=13.594ms, n=240samples"
          },
          {
            "name": "filter_bp_1000hz",
            "value": 14.95,
            "range": "±0.82%",
            "unit": "ms",
            "extra": "p99=19.152ms, n=134samples"
          },
          {
            "name": "matv5_pipeline_32ch_250hz_30s_single",
            "value": 0.0097,
            "range": "±0.17%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=206326samples"
          },
          {
            "name": "matv5_pipeline_64ch_512hz_60s_single",
            "value": 0.0097,
            "range": "±0.18%",
            "unit": "ms",
            "extra": "p99=0.021ms, n=205217samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_single",
            "value": 0.0097,
            "range": "±0.21%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=207106samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_double",
            "value": 7.9651,
            "range": "±0.77%",
            "unit": "ms",
            "extra": "p99=9.987ms, n=252samples"
          },
          {
            "name": "matv5_parse_raw_1MB",
            "value": 0.0026,
            "range": "±0.19%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=759415samples"
          },
          {
            "name": "matv5_parse_raw_10MB",
            "value": 0.0026,
            "range": "±0.21%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=755606samples"
          },
          {
            "name": "matv5_parse_raw_50MB",
            "value": 0.0026,
            "range": "±0.20%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=757564samples"
          },
          {
            "name": "cache_scrub_lru",
            "value": 241.4957,
            "range": "±0.05%",
            "unit": "ms",
            "extra": "p99=242.401ms, n=64samples"
          },
          {
            "name": "cache_scrub_fifo",
            "value": 271.496,
            "range": "±0.03%",
            "unit": "ms",
            "extra": "p99=272.462ms, n=64samples"
          },
          {
            "name": "cache_concurrent_dedup",
            "value": 30.2088,
            "range": "±0.15%",
            "unit": "ms",
            "extra": "p99=31.220ms, n=67samples"
          },
          {
            "name": "cache_concurrent_no_dedup",
            "value": 30.208,
            "range": "±0.12%",
            "unit": "ms",
            "extra": "p99=30.827ms, n=67samples"
          },
          {
            "name": "readwindow_edf_2s",
            "value": 14.6576,
            "range": "±2.31%",
            "unit": "ms",
            "extra": "p99=21.099ms, n=137samples"
          },
          {
            "name": "readwindow_edf_10s",
            "value": 17.8615,
            "range": "±2.54%",
            "unit": "ms",
            "extra": "p99=27.906ms, n=113samples"
          },
          {
            "name": "readwindow_edf_30s",
            "value": 26.526,
            "range": "±3.48%",
            "unit": "ms",
            "extra": "p99=47.607ms, n=76samples"
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
          "id": "cbdabf1ac8bb57da921183a50fcafa98082441d2",
          "message": "feat(pose): UmeTrack FK sidecar exporter for emg2pose BDF recordings\n\nscripts/export-pose-sidecar.py reads a recording with joint* channels\n(emg2pose BIDS conversions), runs UmeTrack forward kinematics and writes\nthe <prefix>_desc-pose.json skeleton sidecar next to it.\n\n- FK convention: forward_kinematics takes (B, n_dof=20, T) channels-first\n  and returns the 21 landmarks as [wrist, finger0 x4, ... finger4 x4];\n  bones use the standard 21-point hand topology (each finger chains off\n  the wrist). Left/right auto-detected from the BIDS recording-<side>\n  entity and mirrored via x-negation.\n- Bundles umetrack_generic_hand_model.json (the kinematic contract for\n  the sidecar format; the emg2pose wheel omits it).\n- Imports emg2pose.kinematics with PEP-563 forced: upstream evaluates a\n  NamedTuple | Any annotation at class-body time, which raises TypeError\n  on Python 3.10+ without .\n- Validated end-to-end on a real sub-01 session (1314 frames @ 29.9 Hz,\n  100% valid, left-hand mirror).",
          "timestamp": "2026-08-25T14:56:34+02:00",
          "tree_id": "d4bde116828e6d5fa357c328891973bae128c5e7",
          "url": "https://github.com/eegdash/eegdash-viewer/commit/cbdabf1ac8bb57da921183a50fcafa98082441d2"
        },
        "date": 1787663085728,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "filter_hp_250hz",
            "value": 1.9542,
            "range": "±1.91%",
            "unit": "ms",
            "extra": "p99=3.494ms, n=1024samples"
          },
          {
            "name": "filter_lp_250hz",
            "value": 1.9659,
            "range": "±1.94%",
            "unit": "ms",
            "extra": "p99=3.526ms, n=1018samples"
          },
          {
            "name": "filter_notch_250hz",
            "value": 1.9199,
            "range": "±1.83%",
            "unit": "ms",
            "extra": "p99=3.515ms, n=1042samples"
          },
          {
            "name": "filter_bp_250hz",
            "value": 3.4893,
            "range": "±2.19%",
            "unit": "ms",
            "extra": "p99=6.356ms, n=574samples"
          },
          {
            "name": "filter_hp_512hz",
            "value": 3.8394,
            "range": "±2.25%",
            "unit": "ms",
            "extra": "p99=6.823ms, n=521samples"
          },
          {
            "name": "filter_lp_512hz",
            "value": 3.8007,
            "range": "±2.15%",
            "unit": "ms",
            "extra": "p99=6.775ms, n=527samples"
          },
          {
            "name": "filter_notch_512hz",
            "value": 3.6777,
            "range": "±2.00%",
            "unit": "ms",
            "extra": "p99=6.969ms, n=544samples"
          },
          {
            "name": "filter_bp_512hz",
            "value": 7.0572,
            "range": "±2.51%",
            "unit": "ms",
            "extra": "p99=11.789ms, n=284samples"
          },
          {
            "name": "filter_hp_1000hz",
            "value": 8.7624,
            "range": "±2.60%",
            "unit": "ms",
            "extra": "p99=12.380ms, n=229samples"
          },
          {
            "name": "filter_lp_1000hz",
            "value": 9.2495,
            "range": "±2.84%",
            "unit": "ms",
            "extra": "p99=13.269ms, n=217samples"
          },
          {
            "name": "filter_notch_1000hz",
            "value": 8.6531,
            "range": "±2.73%",
            "unit": "ms",
            "extra": "p99=12.451ms, n=232samples"
          },
          {
            "name": "filter_bp_1000hz",
            "value": 12.3188,
            "range": "±1.56%",
            "unit": "ms",
            "extra": "p99=17.848ms, n=163samples"
          },
          {
            "name": "matv5_pipeline_32ch_250hz_30s_single",
            "value": 0.0077,
            "range": "±0.17%",
            "unit": "ms",
            "extra": "p99=0.012ms, n=260537samples"
          },
          {
            "name": "matv5_pipeline_64ch_512hz_60s_single",
            "value": 0.0079,
            "range": "±0.23%",
            "unit": "ms",
            "extra": "p99=0.016ms, n=254140samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_single",
            "value": 0.0077,
            "range": "±0.22%",
            "unit": "ms",
            "extra": "p99=0.014ms, n=259511samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_double",
            "value": 6.4098,
            "range": "±0.60%",
            "unit": "ms",
            "extra": "p99=7.711ms, n=313samples"
          },
          {
            "name": "matv5_parse_raw_1MB",
            "value": 0.0021,
            "range": "±0.20%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=938691samples"
          },
          {
            "name": "matv5_parse_raw_10MB",
            "value": 0.0021,
            "range": "±0.21%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=944879samples"
          },
          {
            "name": "matv5_parse_raw_50MB",
            "value": 0.0021,
            "range": "±0.25%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=936203samples"
          },
          {
            "name": "cache_scrub_lru",
            "value": 241.1587,
            "range": "±0.03%",
            "unit": "ms",
            "extra": "p99=241.551ms, n=64samples"
          },
          {
            "name": "cache_scrub_fifo",
            "value": 271.6103,
            "range": "±0.05%",
            "unit": "ms",
            "extra": "p99=272.889ms, n=64samples"
          },
          {
            "name": "cache_concurrent_dedup",
            "value": 30.2205,
            "range": "±0.18%",
            "unit": "ms",
            "extra": "p99=31.232ms, n=67samples"
          },
          {
            "name": "cache_concurrent_no_dedup",
            "value": 30.2186,
            "range": "±0.16%",
            "unit": "ms",
            "extra": "p99=31.238ms, n=67samples"
          },
          {
            "name": "readwindow_edf_2s",
            "value": 46.8545,
            "range": "±1.86%",
            "unit": "ms",
            "extra": "p99=58.475ms, n=64samples"
          },
          {
            "name": "readwindow_edf_10s",
            "value": 54.4713,
            "range": "±8.70%",
            "unit": "ms",
            "extra": "p99=119.971ms, n=64samples"
          },
          {
            "name": "readwindow_edf_30s",
            "value": 68.4921,
            "range": "±10.60%",
            "unit": "ms",
            "extra": "p99=209.939ms, n=64samples"
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
          "id": "bcf328e66ac267f9a87b24fd2f5fb6efa6b6c8be",
          "message": "docs(pose): point sidecar spec at the bundled FK exporter",
          "timestamp": "2026-08-25T14:57:45+02:00",
          "tree_id": "fd8f38895eaa84fb1dcb03f7bbba09f9c57608e4",
          "url": "https://github.com/eegdash/eegdash-viewer/commit/bcf328e66ac267f9a87b24fd2f5fb6efa6b6c8be"
        },
        "date": 1787663153841,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "filter_hp_250hz",
            "value": 1.6543,
            "range": "±1.18%",
            "unit": "ms",
            "extra": "p99=3.013ms, n=1209samples"
          },
          {
            "name": "filter_lp_250hz",
            "value": 1.6612,
            "range": "±1.17%",
            "unit": "ms",
            "extra": "p99=3.000ms, n=1205samples"
          },
          {
            "name": "filter_notch_250hz",
            "value": 1.6516,
            "range": "±1.11%",
            "unit": "ms",
            "extra": "p99=2.953ms, n=1211samples"
          },
          {
            "name": "filter_bp_250hz",
            "value": 3.0826,
            "range": "±1.29%",
            "unit": "ms",
            "extra": "p99=4.692ms, n=649samples"
          },
          {
            "name": "filter_hp_512hz",
            "value": 3.4136,
            "range": "±1.39%",
            "unit": "ms",
            "extra": "p99=5.409ms, n=587samples"
          },
          {
            "name": "filter_lp_512hz",
            "value": 3.3233,
            "range": "±1.32%",
            "unit": "ms",
            "extra": "p99=4.891ms, n=603samples"
          },
          {
            "name": "filter_notch_512hz",
            "value": 3.3227,
            "range": "±1.30%",
            "unit": "ms",
            "extra": "p99=4.877ms, n=602samples"
          },
          {
            "name": "filter_bp_512hz",
            "value": 6.2821,
            "range": "±1.40%",
            "unit": "ms",
            "extra": "p99=8.641ms, n=319samples"
          },
          {
            "name": "filter_hp_1000hz",
            "value": 6.6068,
            "range": "±1.38%",
            "unit": "ms",
            "extra": "p99=8.772ms, n=303samples"
          },
          {
            "name": "filter_lp_1000hz",
            "value": 6.4747,
            "range": "±1.22%",
            "unit": "ms",
            "extra": "p99=7.848ms, n=310samples"
          },
          {
            "name": "filter_notch_1000hz",
            "value": 6.4562,
            "range": "±1.30%",
            "unit": "ms",
            "extra": "p99=7.781ms, n=311samples"
          },
          {
            "name": "filter_bp_1000hz",
            "value": 12.7222,
            "range": "±1.64%",
            "unit": "ms",
            "extra": "p99=15.939ms, n=158samples"
          },
          {
            "name": "matv5_pipeline_32ch_250hz_30s_single",
            "value": 0.0052,
            "range": "±0.20%",
            "unit": "ms",
            "extra": "p99=0.009ms, n=382619samples"
          },
          {
            "name": "matv5_pipeline_64ch_512hz_60s_single",
            "value": 0.0053,
            "range": "±0.70%",
            "unit": "ms",
            "extra": "p99=0.009ms, n=374788samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_single",
            "value": 0.0055,
            "range": "±0.67%",
            "unit": "ms",
            "extra": "p99=0.010ms, n=366509samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_double",
            "value": 27.7467,
            "range": "±1.65%",
            "unit": "ms",
            "extra": "p99=34.012ms, n=73samples"
          },
          {
            "name": "matv5_parse_raw_1MB",
            "value": 0.0016,
            "range": "±0.34%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=1267089samples"
          },
          {
            "name": "matv5_parse_raw_10MB",
            "value": 0.0016,
            "range": "±0.69%",
            "unit": "ms",
            "extra": "p99=0.002ms, n=1283215samples"
          },
          {
            "name": "matv5_parse_raw_50MB",
            "value": 0.0017,
            "range": "±0.73%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=1155448samples"
          },
          {
            "name": "cache_scrub_lru",
            "value": 241.5452,
            "range": "±0.04%",
            "unit": "ms",
            "extra": "p99=242.046ms, n=64samples"
          },
          {
            "name": "cache_scrub_fifo",
            "value": 271.7021,
            "range": "±0.03%",
            "unit": "ms",
            "extra": "p99=272.140ms, n=64samples"
          },
          {
            "name": "cache_concurrent_dedup",
            "value": 30.2423,
            "range": "±0.11%",
            "unit": "ms",
            "extra": "p99=30.477ms, n=67samples"
          },
          {
            "name": "cache_concurrent_no_dedup",
            "value": 30.2892,
            "range": "±0.09%",
            "unit": "ms",
            "extra": "p99=30.706ms, n=67samples"
          },
          {
            "name": "readwindow_edf_2s",
            "value": 45.0304,
            "range": "±4.64%",
            "unit": "ms",
            "extra": "p99=70.563ms, n=64samples"
          },
          {
            "name": "readwindow_edf_10s",
            "value": 54.2068,
            "range": "±6.47%",
            "unit": "ms",
            "extra": "p99=101.653ms, n=64samples"
          },
          {
            "name": "readwindow_edf_30s",
            "value": 62.7418,
            "range": "±10.43%",
            "unit": "ms",
            "extra": "p99=158.321ms, n=64samples"
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
          "id": "081fd0363825495073b64e693eda4c94cb14c8de",
          "message": "ci(pages): stage pose-panel.js — index.html references it (F10 follow-up)",
          "timestamp": "2026-08-25T15:03:56+02:00",
          "tree_id": "00974e6fe6a83b17f5080964fc221fce2a77fd30",
          "url": "https://github.com/eegdash/eegdash-viewer/commit/081fd0363825495073b64e693eda4c94cb14c8de"
        },
        "date": 1787663524255,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "filter_hp_250hz",
            "value": 1.7804,
            "range": "±1.18%",
            "unit": "ms",
            "extra": "p99=3.468ms, n=1124samples"
          },
          {
            "name": "filter_lp_250hz",
            "value": 1.7577,
            "range": "±1.08%",
            "unit": "ms",
            "extra": "p99=3.508ms, n=1138samples"
          },
          {
            "name": "filter_notch_250hz",
            "value": 1.7842,
            "range": "±1.15%",
            "unit": "ms",
            "extra": "p99=3.469ms, n=1121samples"
          },
          {
            "name": "filter_bp_250hz",
            "value": 3.3481,
            "range": "±1.77%",
            "unit": "ms",
            "extra": "p99=6.270ms, n=598samples"
          },
          {
            "name": "filter_hp_512hz",
            "value": 3.5592,
            "range": "±1.44%",
            "unit": "ms",
            "extra": "p99=6.693ms, n=562samples"
          },
          {
            "name": "filter_lp_512hz",
            "value": 3.5442,
            "range": "±1.41%",
            "unit": "ms",
            "extra": "p99=6.673ms, n=565samples"
          },
          {
            "name": "filter_notch_512hz",
            "value": 3.5103,
            "range": "±1.34%",
            "unit": "ms",
            "extra": "p99=6.688ms, n=570samples"
          },
          {
            "name": "filter_bp_512hz",
            "value": 6.3131,
            "range": "±1.30%",
            "unit": "ms",
            "extra": "p99=10.304ms, n=317samples"
          },
          {
            "name": "filter_hp_1000hz",
            "value": 6.6975,
            "range": "±1.40%",
            "unit": "ms",
            "extra": "p99=11.376ms, n=299samples"
          },
          {
            "name": "filter_lp_1000hz",
            "value": 6.6183,
            "range": "±1.20%",
            "unit": "ms",
            "extra": "p99=10.651ms, n=303samples"
          },
          {
            "name": "filter_notch_1000hz",
            "value": 6.74,
            "range": "±1.55%",
            "unit": "ms",
            "extra": "p99=11.645ms, n=297samples"
          },
          {
            "name": "filter_bp_1000hz",
            "value": 12.1275,
            "range": "±0.98%",
            "unit": "ms",
            "extra": "p99=17.503ms, n=165samples"
          },
          {
            "name": "matv5_pipeline_32ch_250hz_30s_single",
            "value": 0.0079,
            "range": "±0.20%",
            "unit": "ms",
            "extra": "p99=0.015ms, n=254388samples"
          },
          {
            "name": "matv5_pipeline_64ch_512hz_60s_single",
            "value": 0.0078,
            "range": "±0.21%",
            "unit": "ms",
            "extra": "p99=0.013ms, n=256646samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_single",
            "value": 0.0079,
            "range": "±0.24%",
            "unit": "ms",
            "extra": "p99=0.013ms, n=252011samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_double",
            "value": 6.5986,
            "range": "±1.11%",
            "unit": "ms",
            "extra": "p99=8.127ms, n=304samples"
          },
          {
            "name": "matv5_parse_raw_1MB",
            "value": 0.0022,
            "range": "±0.22%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=917244samples"
          },
          {
            "name": "matv5_parse_raw_10MB",
            "value": 0.0022,
            "range": "±0.22%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=922204samples"
          },
          {
            "name": "matv5_parse_raw_50MB",
            "value": 0.0022,
            "range": "±0.30%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=900113samples"
          },
          {
            "name": "cache_scrub_lru",
            "value": 241.4343,
            "range": "±0.05%",
            "unit": "ms",
            "extra": "p99=242.946ms, n=64samples"
          },
          {
            "name": "cache_scrub_fifo",
            "value": 271.3742,
            "range": "±0.02%",
            "unit": "ms",
            "extra": "p99=272.415ms, n=64samples"
          },
          {
            "name": "cache_concurrent_dedup",
            "value": 30.1842,
            "range": "±0.04%",
            "unit": "ms",
            "extra": "p99=30.345ms, n=67samples"
          },
          {
            "name": "cache_concurrent_no_dedup",
            "value": 30.2004,
            "range": "±0.05%",
            "unit": "ms",
            "extra": "p99=30.396ms, n=67samples"
          },
          {
            "name": "readwindow_edf_2s",
            "value": 27.7421,
            "range": "±3.48%",
            "unit": "ms",
            "extra": "p99=39.902ms, n=73samples"
          },
          {
            "name": "readwindow_edf_10s",
            "value": 32.784,
            "range": "±3.95%",
            "unit": "ms",
            "extra": "p99=49.460ms, n=64samples"
          },
          {
            "name": "readwindow_edf_30s",
            "value": 47.1108,
            "range": "±14.76%",
            "unit": "ms",
            "extra": "p99=156.375ms, n=64samples"
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
          "id": "72984a3f43702ea96876654fbe1dd565f9b2d89e",
          "message": "docs(pose): real sub-01 emg2pose screenshot (EMG + FK hand at t=3.27s)",
          "timestamp": "2026-08-25T15:29:15+02:00",
          "tree_id": "f00b5e80122abee8017b8562496587e18e66fb74",
          "url": "https://github.com/eegdash/eegdash-viewer/commit/72984a3f43702ea96876654fbe1dd565f9b2d89e"
        },
        "date": 1787665041165,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "filter_hp_250hz",
            "value": 2.1855,
            "range": "±1.13%",
            "unit": "ms",
            "extra": "p99=3.835ms, n=916samples"
          },
          {
            "name": "filter_lp_250hz",
            "value": 2.1994,
            "range": "±1.17%",
            "unit": "ms",
            "extra": "p99=3.826ms, n=910samples"
          },
          {
            "name": "filter_notch_250hz",
            "value": 2.1878,
            "range": "±1.12%",
            "unit": "ms",
            "extra": "p99=3.833ms, n=915samples"
          },
          {
            "name": "filter_bp_250hz",
            "value": 4.1042,
            "range": "±1.26%",
            "unit": "ms",
            "extra": "p99=6.088ms, n=488samples"
          },
          {
            "name": "filter_hp_512hz",
            "value": 4.5828,
            "range": "±1.42%",
            "unit": "ms",
            "extra": "p99=6.489ms, n=437samples"
          },
          {
            "name": "filter_lp_512hz",
            "value": 4.5951,
            "range": "±1.38%",
            "unit": "ms",
            "extra": "p99=6.470ms, n=436samples"
          },
          {
            "name": "filter_notch_512hz",
            "value": 4.5671,
            "range": "±1.45%",
            "unit": "ms",
            "extra": "p99=6.509ms, n=438samples"
          },
          {
            "name": "filter_bp_512hz",
            "value": 8.3784,
            "range": "±1.30%",
            "unit": "ms",
            "extra": "p99=10.159ms, n=239samples"
          },
          {
            "name": "filter_hp_1000hz",
            "value": 9.1771,
            "range": "±1.46%",
            "unit": "ms",
            "extra": "p99=11.610ms, n=219samples"
          },
          {
            "name": "filter_lp_1000hz",
            "value": 9.2107,
            "range": "±1.73%",
            "unit": "ms",
            "extra": "p99=13.436ms, n=218samples"
          },
          {
            "name": "filter_notch_1000hz",
            "value": 9.0208,
            "range": "±1.45%",
            "unit": "ms",
            "extra": "p99=10.816ms, n=222samples"
          },
          {
            "name": "filter_bp_1000hz",
            "value": 16.5137,
            "range": "±0.95%",
            "unit": "ms",
            "extra": "p99=17.917ms, n=122samples"
          },
          {
            "name": "matv5_pipeline_32ch_250hz_30s_single",
            "value": 0.0095,
            "range": "±0.19%",
            "unit": "ms",
            "extra": "p99=0.021ms, n=209539samples"
          },
          {
            "name": "matv5_pipeline_64ch_512hz_60s_single",
            "value": 0.0095,
            "range": "±0.19%",
            "unit": "ms",
            "extra": "p99=0.021ms, n=211102samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_single",
            "value": 0.0095,
            "range": "±0.21%",
            "unit": "ms",
            "extra": "p99=0.021ms, n=209730samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_double",
            "value": 8.1495,
            "range": "±1.02%",
            "unit": "ms",
            "extra": "p99=10.571ms, n=246samples"
          },
          {
            "name": "matv5_parse_raw_1MB",
            "value": 0.0026,
            "range": "±0.21%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=762698samples"
          },
          {
            "name": "matv5_parse_raw_10MB",
            "value": 0.0026,
            "range": "±1.47%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=760002samples"
          },
          {
            "name": "matv5_parse_raw_50MB",
            "value": 0.0026,
            "range": "±1.28%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=761402samples"
          },
          {
            "name": "cache_scrub_lru",
            "value": 241.5146,
            "range": "±0.05%",
            "unit": "ms",
            "extra": "p99=243.139ms, n=64samples"
          },
          {
            "name": "cache_scrub_fifo",
            "value": 271.4821,
            "range": "±0.03%",
            "unit": "ms",
            "extra": "p99=272.467ms, n=64samples"
          },
          {
            "name": "cache_concurrent_dedup",
            "value": 30.1613,
            "range": "±0.05%",
            "unit": "ms",
            "extra": "p99=30.203ms, n=67samples"
          },
          {
            "name": "cache_concurrent_no_dedup",
            "value": 30.181,
            "range": "±0.11%",
            "unit": "ms",
            "extra": "p99=30.488ms, n=67samples"
          },
          {
            "name": "readwindow_edf_2s",
            "value": 59.3711,
            "range": "±67.05%",
            "unit": "ms",
            "extra": "p99=661.598ms, n=64samples"
          },
          {
            "name": "readwindow_edf_10s",
            "value": 72.6976,
            "range": "±55.39%",
            "unit": "ms",
            "extra": "p99=652.677ms, n=64samples"
          },
          {
            "name": "readwindow_edf_30s",
            "value": 66.1007,
            "range": "±8.54%",
            "unit": "ms",
            "extra": "p99=106.034ms, n=64samples"
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
          "id": "74ec81a8a7f8ea667df9b730e0b84a491159062f",
          "message": "fix(pose,embed): review pass — stale-hand/stale-load guards, canvas clear, effective window, FK module split\n\n- pose-kinematics.js: FK + LBS split out (closed-form Rodrigues, zero\n  per-frame allocations); pose-panel.js back under 800 lines.\n- Sidecar: honour start_s (windowed exports were played from t=0), any\n  NaN angle invalidates a frame, n_angles derived when omitted, root\n  index for the wrist; exporter emits the true UmeTrack landmark order\n  (fingertips, wrist, per-finger frames, palm) — the skeleton bones\n  were wired as [wrist, finger×4] and drew garbage; camera + names.\n- Panel: hidden panels stop redrawing (the canvas.width fallback\n  doubled the bitmap every frame on dpr>1), one clear per frame (mesh\n  mode ghosted, 'both' erased the mesh), hideActive() forgets the\n  sidecar and hides the header button, load() drops superseded\n  fetches, no synthetic resize (viewer.js observes the canvas box).\n- viewer.js: pose window = what is on screen (was nominal window, so a\n  2 s recording centred the hand at 5 s), load epoch keeps a superseded\n  load from shipping LOAD_FILE, unsupported payloads no longer tear\n  down the current recording, meta.suffix from the loader names the\n  modality (NEMAR/BTi/MEF safe), page pill from the existing\n  lastChannelOffset/lastTotalChannels/lastMaxVisibleChannels.\n- worker-rpc: only a LOAD_FILE error (no request_id) rejects __LOAD__.\n- walker: file:/// (empty authority) keeps its levels.\n- exporter: sample slicing instead of crop() (last sample kept,\n  windows clamped), load_model()/load_angles()/build_sidecar() split,\n  pytest in scripts/; docs no longer claim torch/emg2pose or 'no\n  kinematics'.\n- e2e: legacy embed specs assert the new toolbar/pills contract.",
          "timestamp": "2026-08-25T23:26:13+02:00",
          "tree_id": "1137871fdc4851b216de8ed6acb583d153b1babd",
          "url": "https://github.com/eegdash/eegdash-viewer/commit/74ec81a8a7f8ea667df9b730e0b84a491159062f"
        },
        "date": 1787694248764,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "filter_hp_250hz",
            "value": 2.4903,
            "range": "±1.13%",
            "unit": "ms",
            "extra": "p99=4.066ms, n=804samples"
          },
          {
            "name": "filter_lp_250hz",
            "value": 2.4995,
            "range": "±1.14%",
            "unit": "ms",
            "extra": "p99=4.115ms, n=801samples"
          },
          {
            "name": "filter_notch_250hz",
            "value": 2.4822,
            "range": "±1.02%",
            "unit": "ms",
            "extra": "p99=4.036ms, n=806samples"
          },
          {
            "name": "filter_bp_250hz",
            "value": 4.6815,
            "range": "±1.21%",
            "unit": "ms",
            "extra": "p99=6.722ms, n=428samples"
          },
          {
            "name": "filter_hp_512hz",
            "value": 5.0129,
            "range": "±1.14%",
            "unit": "ms",
            "extra": "p99=6.885ms, n=400samples"
          },
          {
            "name": "filter_lp_512hz",
            "value": 4.9371,
            "range": "±1.23%",
            "unit": "ms",
            "extra": "p99=6.940ms, n=406samples"
          },
          {
            "name": "filter_notch_512hz",
            "value": 5.0706,
            "range": "±1.11%",
            "unit": "ms",
            "extra": "p99=6.954ms, n=395samples"
          },
          {
            "name": "filter_bp_512hz",
            "value": 9.1439,
            "range": "±1.22%",
            "unit": "ms",
            "extra": "p99=11.202ms, n=219samples"
          },
          {
            "name": "filter_hp_1000hz",
            "value": 9.8727,
            "range": "±1.25%",
            "unit": "ms",
            "extra": "p99=11.573ms, n=203samples"
          },
          {
            "name": "filter_lp_1000hz",
            "value": 9.9158,
            "range": "±1.35%",
            "unit": "ms",
            "extra": "p99=11.722ms, n=202samples"
          },
          {
            "name": "filter_notch_1000hz",
            "value": 9.9012,
            "range": "±1.33%",
            "unit": "ms",
            "extra": "p99=11.722ms, n=203samples"
          },
          {
            "name": "filter_bp_1000hz",
            "value": 17.9245,
            "range": "±1.07%",
            "unit": "ms",
            "extra": "p99=19.846ms, n=112samples"
          },
          {
            "name": "matv5_pipeline_32ch_250hz_30s_single",
            "value": 0.0089,
            "range": "±0.21%",
            "unit": "ms",
            "extra": "p99=0.018ms, n=224321samples"
          },
          {
            "name": "matv5_pipeline_64ch_512hz_60s_single",
            "value": 0.0092,
            "range": "±0.61%",
            "unit": "ms",
            "extra": "p99=0.019ms, n=216865samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_single",
            "value": 0.009,
            "range": "±0.56%",
            "unit": "ms",
            "extra": "p99=0.019ms, n=222113samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_double",
            "value": 13.1967,
            "range": "±1.51%",
            "unit": "ms",
            "extra": "p99=16.014ms, n=152samples"
          },
          {
            "name": "matv5_parse_raw_1MB",
            "value": 0.0027,
            "range": "±0.08%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=746867samples"
          },
          {
            "name": "matv5_parse_raw_10MB",
            "value": 0.0026,
            "range": "±0.12%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=777731samples"
          },
          {
            "name": "matv5_parse_raw_50MB",
            "value": 0.0026,
            "range": "±0.08%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=776400samples"
          },
          {
            "name": "cache_scrub_lru",
            "value": 241.972,
            "range": "±0.06%",
            "unit": "ms",
            "extra": "p99=243.409ms, n=64samples"
          },
          {
            "name": "cache_scrub_fifo",
            "value": 272.1069,
            "range": "±0.04%",
            "unit": "ms",
            "extra": "p99=273.132ms, n=64samples"
          },
          {
            "name": "cache_concurrent_dedup",
            "value": 30.2807,
            "range": "±0.12%",
            "unit": "ms",
            "extra": "p99=30.874ms, n=67samples"
          },
          {
            "name": "cache_concurrent_no_dedup",
            "value": 30.2723,
            "range": "±0.12%",
            "unit": "ms",
            "extra": "p99=30.669ms, n=67samples"
          },
          {
            "name": "readwindow_edf_2s",
            "value": 35.2878,
            "range": "±6.02%",
            "unit": "ms",
            "extra": "p99=55.566ms, n=64samples"
          },
          {
            "name": "readwindow_edf_10s",
            "value": 39.3852,
            "range": "±6.20%",
            "unit": "ms",
            "extra": "p99=65.212ms, n=64samples"
          },
          {
            "name": "readwindow_edf_30s",
            "value": 47.332,
            "range": "±8.76%",
            "unit": "ms",
            "extra": "p99=117.718ms, n=64samples"
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
          "id": "40063fb8a8b8ed277bcca552ca8b46293c53dc6e",
          "message": "refactor(pose,embed): simplify pass — shared sampler, controller-owned toggle, URL-resolver walker, tagged embed markup, batched exporter FK\n\n- pose-panel: one sampleAt() for frameAt/anglesAt, dead rotateAroundAxis\n  removed, resetCam(), no-op syncWindow/syncCursor skip the repaint,\n  the header toggle is passed into mount() and owned by the controller,\n  angles decode pinned by decodeBlock when n_angles is declared.\n- viewer: page pill resolved once and written only on change, single\n  PHYSIO_FILENAME scan in openLocalFiles, canvas ResizeObserver\n  unconditional, meta.suffix guaranteed by the loader (eegdash fast path\n  now forwards it).\n- bids-recording: inheritance walk climbs with new URL('..') — stops at\n  the origin by construction, manifest-relative dirs keep the strip.\n- embed CSS: index.html tags rail parts with data-embed=\"hide\" (one\n  rule, no :has() id list); dock width derived from --pose-canvas.\n- exporter: vectorised FK + skinning over frames (~70× faster), fs_pose\n  is the single rate (dt dropped).",
          "timestamp": "2026-08-25T23:52:13+02:00",
          "tree_id": "f3360d531ed8cb100db87a0d467b319af2072792",
          "url": "https://github.com/eegdash/eegdash-viewer/commit/40063fb8a8b8ed277bcca552ca8b46293c53dc6e"
        },
        "date": 1787695216106,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "filter_hp_250hz",
            "value": 2.3789,
            "range": "±1.70%",
            "unit": "ms",
            "extra": "p99=4.545ms, n=841samples"
          },
          {
            "name": "filter_lp_250hz",
            "value": 2.3657,
            "range": "±1.60%",
            "unit": "ms",
            "extra": "p99=4.375ms, n=846samples"
          },
          {
            "name": "filter_notch_250hz",
            "value": 2.3337,
            "range": "±1.55%",
            "unit": "ms",
            "extra": "p99=4.436ms, n=858samples"
          },
          {
            "name": "filter_bp_250hz",
            "value": 4.2698,
            "range": "±1.68%",
            "unit": "ms",
            "extra": "p99=6.777ms, n=469samples"
          },
          {
            "name": "filter_hp_512hz",
            "value": 4.6932,
            "range": "±2.11%",
            "unit": "ms",
            "extra": "p99=8.871ms, n=427samples"
          },
          {
            "name": "filter_lp_512hz",
            "value": 4.6092,
            "range": "±1.76%",
            "unit": "ms",
            "extra": "p99=7.030ms, n=434samples"
          },
          {
            "name": "filter_notch_512hz",
            "value": 4.6035,
            "range": "±1.46%",
            "unit": "ms",
            "extra": "p99=6.911ms, n=435samples"
          },
          {
            "name": "filter_bp_512hz",
            "value": 8.5396,
            "range": "±1.73%",
            "unit": "ms",
            "extra": "p99=12.853ms, n=235samples"
          },
          {
            "name": "filter_hp_1000hz",
            "value": 9.1681,
            "range": "±1.47%",
            "unit": "ms",
            "extra": "p99=11.155ms, n=219samples"
          },
          {
            "name": "filter_lp_1000hz",
            "value": 9.2136,
            "range": "±1.71%",
            "unit": "ms",
            "extra": "p99=11.444ms, n=218samples"
          },
          {
            "name": "filter_notch_1000hz",
            "value": 9.164,
            "range": "±1.55%",
            "unit": "ms",
            "extra": "p99=11.334ms, n=219samples"
          },
          {
            "name": "filter_bp_1000hz",
            "value": 16.7102,
            "range": "±1.11%",
            "unit": "ms",
            "extra": "p99=18.251ms, n=120samples"
          },
          {
            "name": "matv5_pipeline_32ch_250hz_30s_single",
            "value": 0.0099,
            "range": "±0.22%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=202392samples"
          },
          {
            "name": "matv5_pipeline_64ch_512hz_60s_single",
            "value": 0.0098,
            "range": "±0.62%",
            "unit": "ms",
            "extra": "p99=0.019ms, n=203370samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_single",
            "value": 0.0098,
            "range": "±0.21%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=204246samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_double",
            "value": 8.2356,
            "range": "±1.02%",
            "unit": "ms",
            "extra": "p99=10.017ms, n=243samples"
          },
          {
            "name": "matv5_parse_raw_1MB",
            "value": 0.0027,
            "range": "±0.21%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=736020samples"
          },
          {
            "name": "matv5_parse_raw_10MB",
            "value": 0.0028,
            "range": "±1.53%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=725621samples"
          },
          {
            "name": "matv5_parse_raw_50MB",
            "value": 0.0027,
            "range": "±1.49%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=727696samples"
          },
          {
            "name": "cache_scrub_lru",
            "value": 241.7092,
            "range": "±0.06%",
            "unit": "ms",
            "extra": "p99=243.492ms, n=64samples"
          },
          {
            "name": "cache_scrub_fifo",
            "value": 271.6575,
            "range": "±0.03%",
            "unit": "ms",
            "extra": "p99=272.588ms, n=64samples"
          },
          {
            "name": "cache_concurrent_dedup",
            "value": 30.1829,
            "range": "±0.06%",
            "unit": "ms",
            "extra": "p99=30.235ms, n=67samples"
          },
          {
            "name": "cache_concurrent_no_dedup",
            "value": 30.2101,
            "range": "±0.05%",
            "unit": "ms",
            "extra": "p99=30.436ms, n=67samples"
          },
          {
            "name": "readwindow_edf_2s",
            "value": 30.6635,
            "range": "±7.64%",
            "unit": "ms",
            "extra": "p99=61.381ms, n=66samples"
          },
          {
            "name": "readwindow_edf_10s",
            "value": 25.7423,
            "range": "±4.17%",
            "unit": "ms",
            "extra": "p99=40.152ms, n=78samples"
          },
          {
            "name": "readwindow_edf_30s",
            "value": 31.9409,
            "range": "±5.76%",
            "unit": "ms",
            "extra": "p99=56.886ms, n=64samples"
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