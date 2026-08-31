window.BENCHMARK_DATA = {
  "lastUpdate": 1788209025241,
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
          "id": "984ffa13875eb6d79773774f8aa4b97457078998",
          "message": "docs(images): BIDSDataset.plot() cell rendering the real sub-01 recording + skinned hand",
          "timestamp": "2026-08-26T00:42:47+02:00",
          "tree_id": "be5cd818a22c7055b933c7c70bf5ceabfbcd36c0",
          "url": "https://github.com/eegdash/eegdash-viewer/commit/984ffa13875eb6d79773774f8aa4b97457078998"
        },
        "date": 1787698240514,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "filter_hp_250hz",
            "value": 2.3403,
            "range": "±1.41%",
            "unit": "ms",
            "extra": "p99=3.945ms, n=855samples"
          },
          {
            "name": "filter_lp_250hz",
            "value": 2.354,
            "range": "±1.59%",
            "unit": "ms",
            "extra": "p99=4.039ms, n=850samples"
          },
          {
            "name": "filter_notch_250hz",
            "value": 2.3564,
            "range": "±1.69%",
            "unit": "ms",
            "extra": "p99=3.985ms, n=849samples"
          },
          {
            "name": "filter_bp_250hz",
            "value": 4.3024,
            "range": "±1.47%",
            "unit": "ms",
            "extra": "p99=6.384ms, n=466samples"
          },
          {
            "name": "filter_hp_512hz",
            "value": 4.7076,
            "range": "±1.41%",
            "unit": "ms",
            "extra": "p99=6.665ms, n=425samples"
          },
          {
            "name": "filter_lp_512hz",
            "value": 4.8406,
            "range": "±1.85%",
            "unit": "ms",
            "extra": "p99=9.118ms, n=414samples"
          },
          {
            "name": "filter_notch_512hz",
            "value": 4.6853,
            "range": "±1.37%",
            "unit": "ms",
            "extra": "p99=6.531ms, n=428samples"
          },
          {
            "name": "filter_bp_512hz",
            "value": 8.8588,
            "range": "±1.69%",
            "unit": "ms",
            "extra": "p99=12.866ms, n=226samples"
          },
          {
            "name": "filter_hp_1000hz",
            "value": 9.4349,
            "range": "±1.65%",
            "unit": "ms",
            "extra": "p99=13.380ms, n=212samples"
          },
          {
            "name": "filter_lp_1000hz",
            "value": 9.3051,
            "range": "±1.38%",
            "unit": "ms",
            "extra": "p99=11.094ms, n=215samples"
          },
          {
            "name": "filter_notch_1000hz",
            "value": 9.438,
            "range": "±1.58%",
            "unit": "ms",
            "extra": "p99=12.600ms, n=213samples"
          },
          {
            "name": "filter_bp_1000hz",
            "value": 16.5953,
            "range": "±1.00%",
            "unit": "ms",
            "extra": "p99=18.273ms, n=121samples"
          },
          {
            "name": "matv5_pipeline_32ch_250hz_30s_single",
            "value": 0.0094,
            "range": "±0.24%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=211866samples"
          },
          {
            "name": "matv5_pipeline_64ch_512hz_60s_single",
            "value": 0.0096,
            "range": "±0.62%",
            "unit": "ms",
            "extra": "p99=0.021ms, n=209210samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_single",
            "value": 0.0094,
            "range": "±0.31%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=211998samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_double",
            "value": 8.217,
            "range": "±0.92%",
            "unit": "ms",
            "extra": "p99=9.501ms, n=244samples"
          },
          {
            "name": "matv5_parse_raw_1MB",
            "value": 0.0026,
            "range": "±0.29%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=760984samples"
          },
          {
            "name": "matv5_parse_raw_10MB",
            "value": 0.0026,
            "range": "±0.33%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=760017samples"
          },
          {
            "name": "matv5_parse_raw_50MB",
            "value": 0.0026,
            "range": "±1.44%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=755443samples"
          },
          {
            "name": "cache_scrub_lru",
            "value": 241.7375,
            "range": "±0.03%",
            "unit": "ms",
            "extra": "p99=242.730ms, n=64samples"
          },
          {
            "name": "cache_scrub_fifo",
            "value": 271.7021,
            "range": "±0.04%",
            "unit": "ms",
            "extra": "p99=272.488ms, n=64samples"
          },
          {
            "name": "cache_concurrent_dedup",
            "value": 30.2538,
            "range": "±0.21%",
            "unit": "ms",
            "extra": "p99=31.288ms, n=67samples"
          },
          {
            "name": "cache_concurrent_no_dedup",
            "value": 30.2446,
            "range": "±0.19%",
            "unit": "ms",
            "extra": "p99=31.280ms, n=67samples"
          },
          {
            "name": "readwindow_edf_2s",
            "value": 15.6016,
            "range": "±2.22%",
            "unit": "ms",
            "extra": "p99=20.913ms, n=129samples"
          },
          {
            "name": "readwindow_edf_10s",
            "value": 19.7284,
            "range": "±2.84%",
            "unit": "ms",
            "extra": "p99=27.974ms, n=102samples"
          },
          {
            "name": "readwindow_edf_30s",
            "value": 29.4126,
            "range": "±4.90%",
            "unit": "ms",
            "extra": "p99=53.200ms, n=68samples"
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
          "id": "33c121cd5b3619632d91f8415b6fc0ef31a139bc",
          "message": "fix(local): a missing local blob reads as HTTP 404 so optional siblings fall back\n\neeglab.js only tolerates /HTTP 404/ when probing <prefix>_eeg.fdt; an\ninline-data .set handed over the bridge (or dropped alone) has no .fdt\nto register, so the probe threw 'Local drop missing' and the load died\ninstead of reading the embedded data.",
          "timestamp": "2026-08-26T12:31:19+02:00",
          "tree_id": "bd06c9cc5d62827ed800938c1cd44ecccf4e77f2",
          "url": "https://github.com/eegdash/eegdash-viewer/commit/33c121cd5b3619632d91f8415b6fc0ef31a139bc"
        },
        "date": 1787740764388,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "filter_hp_250hz",
            "value": 2.4827,
            "range": "±1.97%",
            "unit": "ms",
            "extra": "p99=4.466ms, n=806samples"
          },
          {
            "name": "filter_lp_250hz",
            "value": 2.4736,
            "range": "±1.88%",
            "unit": "ms",
            "extra": "p99=3.921ms, n=809samples"
          },
          {
            "name": "filter_notch_250hz",
            "value": 2.5102,
            "range": "±1.97%",
            "unit": "ms",
            "extra": "p99=3.944ms, n=798samples"
          },
          {
            "name": "filter_bp_250hz",
            "value": 4.2501,
            "range": "±1.96%",
            "unit": "ms",
            "extra": "p99=6.982ms, n=471samples"
          },
          {
            "name": "filter_hp_512hz",
            "value": 4.7352,
            "range": "±2.09%",
            "unit": "ms",
            "extra": "p99=7.738ms, n=423samples"
          },
          {
            "name": "filter_lp_512hz",
            "value": 4.7718,
            "range": "±2.09%",
            "unit": "ms",
            "extra": "p99=7.764ms, n=420samples"
          },
          {
            "name": "filter_notch_512hz",
            "value": 4.725,
            "range": "±2.07%",
            "unit": "ms",
            "extra": "p99=7.705ms, n=424samples"
          },
          {
            "name": "filter_bp_512hz",
            "value": 9.0169,
            "range": "±2.48%",
            "unit": "ms",
            "extra": "p99=13.574ms, n=222samples"
          },
          {
            "name": "filter_hp_1000hz",
            "value": 10.4828,
            "range": "±2.64%",
            "unit": "ms",
            "extra": "p99=14.425ms, n=191samples"
          },
          {
            "name": "filter_lp_1000hz",
            "value": 10.8165,
            "range": "±2.61%",
            "unit": "ms",
            "extra": "p99=14.439ms, n=185samples"
          },
          {
            "name": "filter_notch_1000hz",
            "value": 10.5737,
            "range": "±2.60%",
            "unit": "ms",
            "extra": "p99=14.458ms, n=190samples"
          },
          {
            "name": "filter_bp_1000hz",
            "value": 16.8975,
            "range": "±2.47%",
            "unit": "ms",
            "extra": "p99=21.522ms, n=119samples"
          },
          {
            "name": "matv5_pipeline_32ch_250hz_30s_single",
            "value": 0.0096,
            "range": "±0.19%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=208865samples"
          },
          {
            "name": "matv5_pipeline_64ch_512hz_60s_single",
            "value": 0.0095,
            "range": "±0.20%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=210024samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_single",
            "value": 0.0095,
            "range": "±0.20%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=210605samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_double",
            "value": 7.9477,
            "range": "±0.75%",
            "unit": "ms",
            "extra": "p99=9.490ms, n=252samples"
          },
          {
            "name": "matv5_parse_raw_1MB",
            "value": 0.0026,
            "range": "±0.22%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=769642samples"
          },
          {
            "name": "matv5_parse_raw_10MB",
            "value": 0.0026,
            "range": "±1.73%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=757841samples"
          },
          {
            "name": "matv5_parse_raw_50MB",
            "value": 0.0026,
            "range": "±1.33%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=762914samples"
          },
          {
            "name": "cache_scrub_lru",
            "value": 241.5975,
            "range": "±0.03%",
            "unit": "ms",
            "extra": "p99=242.455ms, n=64samples"
          },
          {
            "name": "cache_scrub_fifo",
            "value": 271.68,
            "range": "±0.03%",
            "unit": "ms",
            "extra": "p99=272.615ms, n=64samples"
          },
          {
            "name": "cache_concurrent_dedup",
            "value": 30.1608,
            "range": "±0.06%",
            "unit": "ms",
            "extra": "p99=30.211ms, n=67samples"
          },
          {
            "name": "cache_concurrent_no_dedup",
            "value": 30.1898,
            "range": "±0.05%",
            "unit": "ms",
            "extra": "p99=30.399ms, n=67samples"
          },
          {
            "name": "readwindow_edf_2s",
            "value": 13.8974,
            "range": "±14.07%",
            "unit": "ms",
            "extra": "p99=23.094ms, n=144samples"
          },
          {
            "name": "readwindow_edf_10s",
            "value": 18.2571,
            "range": "±3.02%",
            "unit": "ms",
            "extra": "p99=28.261ms, n=110samples"
          },
          {
            "name": "readwindow_edf_30s",
            "value": 27.2148,
            "range": "±4.05%",
            "unit": "ms",
            "extra": "p99=48.536ms, n=74samples"
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
          "id": "73fdf240d6a1ecf9643e9cb6d607d9bf50bfaedf",
          "message": "Merge branch 'fix/frontend-defect-pass'\n\nFrontend defect pass: units and event labels no longer destroyed by\ntext-transform, responsive layout so the canvas survives narrow\nviewports, a single focus-visible ring, WCAG AA fixes on error text and\ncanvas labels, time-axis tick density scaled to plot width, and a worker\ndedup fix where a cancelled stream stranded the live request that had\ndeduped onto it. Adds DESIGN.md.\n\ne2e 32/32, unit 1038/1038, typecheck clean.",
          "timestamp": "2026-08-27T13:11:55+02:00",
          "tree_id": "d9d290f9e93c4248f4f7faecd826f4a91e5ff72f",
          "url": "https://github.com/eegdash/eegdash-viewer/commit/73fdf240d6a1ecf9643e9cb6d607d9bf50bfaedf"
        },
        "date": 1787829337677,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "filter_hp_250hz",
            "value": 2.5194,
            "range": "±2.00%",
            "unit": "ms",
            "extra": "p99=4.483ms, n=794samples"
          },
          {
            "name": "filter_lp_250hz",
            "value": 2.5096,
            "range": "±2.02%",
            "unit": "ms",
            "extra": "p99=4.437ms, n=798samples"
          },
          {
            "name": "filter_notch_250hz",
            "value": 2.5055,
            "range": "±2.00%",
            "unit": "ms",
            "extra": "p99=4.448ms, n=799samples"
          },
          {
            "name": "filter_bp_250hz",
            "value": 4.5592,
            "range": "±2.49%",
            "unit": "ms",
            "extra": "p99=7.976ms, n=440samples"
          },
          {
            "name": "filter_hp_512hz",
            "value": 4.9099,
            "range": "±2.39%",
            "unit": "ms",
            "extra": "p99=9.683ms, n=408samples"
          },
          {
            "name": "filter_lp_512hz",
            "value": 4.9389,
            "range": "±2.27%",
            "unit": "ms",
            "extra": "p99=8.610ms, n=406samples"
          },
          {
            "name": "filter_notch_512hz",
            "value": 4.9157,
            "range": "±2.22%",
            "unit": "ms",
            "extra": "p99=8.461ms, n=407samples"
          },
          {
            "name": "filter_bp_512hz",
            "value": 9.2094,
            "range": "±2.43%",
            "unit": "ms",
            "extra": "p99=13.329ms, n=218samples"
          },
          {
            "name": "filter_hp_1000hz",
            "value": 10.2134,
            "range": "±2.45%",
            "unit": "ms",
            "extra": "p99=13.511ms, n=196samples"
          },
          {
            "name": "filter_lp_1000hz",
            "value": 10.1039,
            "range": "±2.46%",
            "unit": "ms",
            "extra": "p99=13.703ms, n=198samples"
          },
          {
            "name": "filter_notch_1000hz",
            "value": 10.1784,
            "range": "±2.47%",
            "unit": "ms",
            "extra": "p99=13.649ms, n=197samples"
          },
          {
            "name": "filter_bp_1000hz",
            "value": 17.5515,
            "range": "±2.23%",
            "unit": "ms",
            "extra": "p99=24.359ms, n=114samples"
          },
          {
            "name": "matv5_pipeline_32ch_250hz_30s_single",
            "value": 0.0103,
            "range": "±0.26%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=194856samples"
          },
          {
            "name": "matv5_pipeline_64ch_512hz_60s_single",
            "value": 0.0107,
            "range": "±0.35%",
            "unit": "ms",
            "extra": "p99=0.023ms, n=187345samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_single",
            "value": 0.0103,
            "range": "±0.50%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=194978samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_double",
            "value": 8.2133,
            "range": "±1.11%",
            "unit": "ms",
            "extra": "p99=10.345ms, n=244samples"
          },
          {
            "name": "matv5_parse_raw_1MB",
            "value": 0.0028,
            "range": "±0.26%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=711704samples"
          },
          {
            "name": "matv5_parse_raw_10MB",
            "value": 0.0028,
            "range": "±0.33%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=705698samples"
          },
          {
            "name": "matv5_parse_raw_50MB",
            "value": 0.0028,
            "range": "±0.27%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=708889samples"
          },
          {
            "name": "cache_scrub_lru",
            "value": 241.8136,
            "range": "±0.03%",
            "unit": "ms",
            "extra": "p99=242.909ms, n=64samples"
          },
          {
            "name": "cache_scrub_fifo",
            "value": 272.0388,
            "range": "±0.03%",
            "unit": "ms",
            "extra": "p99=273.017ms, n=64samples"
          },
          {
            "name": "cache_concurrent_dedup",
            "value": 30.2643,
            "range": "±0.12%",
            "unit": "ms",
            "extra": "p99=30.893ms, n=67samples"
          },
          {
            "name": "cache_concurrent_no_dedup",
            "value": 30.2873,
            "range": "±0.12%",
            "unit": "ms",
            "extra": "p99=30.943ms, n=67samples"
          },
          {
            "name": "readwindow_edf_2s",
            "value": 17.9785,
            "range": "±2.10%",
            "unit": "ms",
            "extra": "p99=23.306ms, n=112samples"
          },
          {
            "name": "readwindow_edf_10s",
            "value": 28.2958,
            "range": "±12.80%",
            "unit": "ms",
            "extra": "p99=79.054ms, n=71samples"
          },
          {
            "name": "readwindow_edf_30s",
            "value": 38.2294,
            "range": "±14.52%",
            "unit": "ms",
            "extra": "p99=115.617ms, n=64samples"
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
          "id": "5587f9832eeeaaaab5c7bddbe778dd2ff0ce8684",
          "message": "fix(traces): never widen the tick step into a one- or zero-label axis\n\nThe width-aware widening added earlier walks up the nice-step table until\nthe labels fit the plot. Nothing bounded that walk, so a narrow plot could\nland on a step larger than the visible window: with t0=10 and step=60 the\nfirst multiple is 60, past the window end, and the axis drew NO labels at\nall. A 270-combination sweep found 11 such cases. The old count-based rule\ncould not produce this, because its step never exceeded span/7.\n\nThe first guard counted multiples inside [t0, t1], which fixed the empty\naxis but made the bound depend on the pan offset -- at one width and window\nsize, t0=0 allowed a step that t0=5 rejected, so label density flipped back\nand forth while panning. The bound is now span/2: a window of length span\nalways contains floor(span/s) or floor(span/s)+1 multiples of s, so\ns <= span/2 guarantees two labels at any offset, with no t0 term. It\ncarries a 1e-9 epsilon because t0+window drifts by an ulp for some offsets\n(t0=1.3, win=2 gives span 1.9999999999999998, which rejected step 1).\n\n400-combination sweep: 0 zero-label, 0 one-label, 0 pan-unstable. Desktop\noutput stays byte-identical to the historical path.",
          "timestamp": "2026-08-27T14:35:28+02:00",
          "tree_id": "417460bbce437ed321a29a262debc6c6ed1f23f3",
          "url": "https://github.com/eegdash/eegdash-viewer/commit/5587f9832eeeaaaab5c7bddbe778dd2ff0ce8684"
        },
        "date": 1787834275760,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "filter_hp_250hz",
            "value": 2.2454,
            "range": "±1.07%",
            "unit": "ms",
            "extra": "p99=3.903ms, n=891samples"
          },
          {
            "name": "filter_lp_250hz",
            "value": 2.2016,
            "range": "±0.94%",
            "unit": "ms",
            "extra": "p99=3.869ms, n=909samples"
          },
          {
            "name": "filter_notch_250hz",
            "value": 2.2195,
            "range": "±1.00%",
            "unit": "ms",
            "extra": "p99=3.933ms, n=902samples"
          },
          {
            "name": "filter_bp_250hz",
            "value": 4.0605,
            "range": "±1.09%",
            "unit": "ms",
            "extra": "p99=7.117ms, n=493samples"
          },
          {
            "name": "filter_hp_512hz",
            "value": 4.4376,
            "range": "±1.10%",
            "unit": "ms",
            "extra": "p99=7.550ms, n=451samples"
          },
          {
            "name": "filter_lp_512hz",
            "value": 4.4293,
            "range": "±1.02%",
            "unit": "ms",
            "extra": "p99=7.373ms, n=452samples"
          },
          {
            "name": "filter_notch_512hz",
            "value": 4.4636,
            "range": "±1.09%",
            "unit": "ms",
            "extra": "p99=7.784ms, n=449samples"
          },
          {
            "name": "filter_bp_512hz",
            "value": 8.1723,
            "range": "±1.09%",
            "unit": "ms",
            "extra": "p99=12.552ms, n=245samples"
          },
          {
            "name": "filter_hp_1000hz",
            "value": 8.8545,
            "range": "±1.87%",
            "unit": "ms",
            "extra": "p99=14.233ms, n=226samples"
          },
          {
            "name": "filter_lp_1000hz",
            "value": 8.8353,
            "range": "±1.72%",
            "unit": "ms",
            "extra": "p99=14.069ms, n=227samples"
          },
          {
            "name": "filter_notch_1000hz",
            "value": 8.8732,
            "range": "±1.90%",
            "unit": "ms",
            "extra": "p99=14.161ms, n=226samples"
          },
          {
            "name": "filter_bp_1000hz",
            "value": 15.6824,
            "range": "±0.65%",
            "unit": "ms",
            "extra": "p99=16.874ms, n=128samples"
          },
          {
            "name": "matv5_pipeline_32ch_250hz_30s_single",
            "value": 0.0099,
            "range": "±0.30%",
            "unit": "ms",
            "extra": "p99=0.021ms, n=201587samples"
          },
          {
            "name": "matv5_pipeline_64ch_512hz_60s_single",
            "value": 0.0099,
            "range": "±0.31%",
            "unit": "ms",
            "extra": "p99=0.021ms, n=202339samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_single",
            "value": 0.0099,
            "range": "±0.29%",
            "unit": "ms",
            "extra": "p99=0.021ms, n=202331samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_double",
            "value": 8.0253,
            "range": "±0.70%",
            "unit": "ms",
            "extra": "p99=9.620ms, n=250samples"
          },
          {
            "name": "matv5_parse_raw_1MB",
            "value": 0.0027,
            "range": "±0.31%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=744087samples"
          },
          {
            "name": "matv5_parse_raw_10MB",
            "value": 0.0027,
            "range": "±0.40%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=734962samples"
          },
          {
            "name": "matv5_parse_raw_50MB",
            "value": 0.0027,
            "range": "±0.35%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=739120samples"
          },
          {
            "name": "cache_scrub_lru",
            "value": 242.3965,
            "range": "±0.05%",
            "unit": "ms",
            "extra": "p99=243.562ms, n=64samples"
          },
          {
            "name": "cache_scrub_fifo",
            "value": 272.5641,
            "range": "±0.05%",
            "unit": "ms",
            "extra": "p99=273.402ms, n=64samples"
          },
          {
            "name": "cache_concurrent_dedup",
            "value": 30.3393,
            "range": "±0.18%",
            "unit": "ms",
            "extra": "p99=31.342ms, n=66samples"
          },
          {
            "name": "cache_concurrent_no_dedup",
            "value": 30.2991,
            "range": "±0.06%",
            "unit": "ms",
            "extra": "p99=30.538ms, n=67samples"
          },
          {
            "name": "readwindow_edf_2s",
            "value": 15.1569,
            "range": "±2.61%",
            "unit": "ms",
            "extra": "p99=21.246ms, n=132samples"
          },
          {
            "name": "readwindow_edf_10s",
            "value": 19.9881,
            "range": "±3.01%",
            "unit": "ms",
            "extra": "p99=28.272ms, n=101samples"
          },
          {
            "name": "readwindow_edf_30s",
            "value": 28.7352,
            "range": "±4.13%",
            "unit": "ms",
            "extra": "p99=49.184ms, n=70samples"
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
          "id": "c14dc7bb1e2f78d014ddf1ac96f5b653befd1bc5",
          "message": "fix(viewer): reveal the stage caption only after a draw produced an axis\n\nThe code above this line documents the contract:\n\n    Perform initial render before revealing stage-caption so that\n    TraceRenderer.lastDrawnXLabels is populated when the test reads it.\n    The stage-caption toBeVisible() gate in tests serves as the\n    synchronisation point: by the time it resolves the labels are ready.\n\nK3 later moved the reveal to ~5% of the streamed window so slow MEG fetches\nconfirm the recording sooner. That is worth keeping, but it silently broke\nthe contract: TraceRenderer.draw() returns early when the canvas has no\nlayout yet (`plotW <= 4 || plotH <= 4`), which is exactly the state\nimmediately after `tracesCanvas.hidden = false` on a cold load. The first\nchunk therefore paints nothing, the axis is never drawn, and the caption\nwas revealed anyway -- so anything synchronising on it observed an\nunpainted instrument with lastDrawnXLabels still empty.\n\nThat is not only a test concern: the audit suite's \"recording loaded\" gate\nwatches the same element.\n\nThe reveal now additionally requires that a draw has produced an axis,\nwhich keeps K3's early feedback (it fires on the first *effective* paint)\nwhile making the gate honest again.\n\ne2e F06 was failing on `expect(labelsRel.length).toBeGreaterThan(0)` in 2\nof 2 runs; it now gets past that assertion consistently.",
          "timestamp": "2026-08-27T14:45:44+02:00",
          "tree_id": "88a2b58eb5e3e3b1f7a3e804bbe2cd9c492b99ac",
          "url": "https://github.com/eegdash/eegdash-viewer/commit/c14dc7bb1e2f78d014ddf1ac96f5b653befd1bc5"
        },
        "date": 1787834994876,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "filter_hp_250hz",
            "value": 2.111,
            "range": "±0.80%",
            "unit": "ms",
            "extra": "p99=3.373ms, n=948samples"
          },
          {
            "name": "filter_lp_250hz",
            "value": 2.1184,
            "range": "±0.82%",
            "unit": "ms",
            "extra": "p99=3.646ms, n=945samples"
          },
          {
            "name": "filter_notch_250hz",
            "value": 2.1218,
            "range": "±0.75%",
            "unit": "ms",
            "extra": "p99=3.374ms, n=943samples"
          },
          {
            "name": "filter_bp_250hz",
            "value": 3.9101,
            "range": "±0.73%",
            "unit": "ms",
            "extra": "p99=5.340ms, n=512samples"
          },
          {
            "name": "filter_hp_512hz",
            "value": 4.2058,
            "range": "±0.44%",
            "unit": "ms",
            "extra": "p99=5.063ms, n=476samples"
          },
          {
            "name": "filter_lp_512hz",
            "value": 4.2257,
            "range": "±0.48%",
            "unit": "ms",
            "extra": "p99=5.396ms, n=474samples"
          },
          {
            "name": "filter_notch_512hz",
            "value": 4.23,
            "range": "±0.51%",
            "unit": "ms",
            "extra": "p99=5.268ms, n=473samples"
          },
          {
            "name": "filter_bp_512hz",
            "value": 7.6867,
            "range": "±0.19%",
            "unit": "ms",
            "extra": "p99=8.236ms, n=261samples"
          },
          {
            "name": "filter_hp_1000hz",
            "value": 8.4588,
            "range": "±1.88%",
            "unit": "ms",
            "extra": "p99=14.644ms, n=237samples"
          },
          {
            "name": "filter_lp_1000hz",
            "value": 8.5763,
            "range": "±2.22%",
            "unit": "ms",
            "extra": "p99=14.551ms, n=234samples"
          },
          {
            "name": "filter_notch_1000hz",
            "value": 8.2213,
            "range": "±0.94%",
            "unit": "ms",
            "extra": "p99=12.103ms, n=244samples"
          },
          {
            "name": "filter_bp_1000hz",
            "value": 14.9668,
            "range": "±0.19%",
            "unit": "ms",
            "extra": "p99=15.692ms, n=134samples"
          },
          {
            "name": "matv5_pipeline_32ch_250hz_30s_single",
            "value": 0.0097,
            "range": "±0.18%",
            "unit": "ms",
            "extra": "p99=0.021ms, n=206548samples"
          },
          {
            "name": "matv5_pipeline_64ch_512hz_60s_single",
            "value": 0.0096,
            "range": "±0.18%",
            "unit": "ms",
            "extra": "p99=0.021ms, n=207352samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_single",
            "value": 0.0097,
            "range": "±0.60%",
            "unit": "ms",
            "extra": "p99=0.021ms, n=207064samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_double",
            "value": 8.2335,
            "range": "±0.78%",
            "unit": "ms",
            "extra": "p99=9.894ms, n=243samples"
          },
          {
            "name": "matv5_parse_raw_1MB",
            "value": 0.0027,
            "range": "±0.20%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=751874samples"
          },
          {
            "name": "matv5_parse_raw_10MB",
            "value": 0.0027,
            "range": "±0.23%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=749721samples"
          },
          {
            "name": "matv5_parse_raw_50MB",
            "value": 0.0027,
            "range": "±1.60%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=747910samples"
          },
          {
            "name": "cache_scrub_lru",
            "value": 241.4815,
            "range": "±0.05%",
            "unit": "ms",
            "extra": "p99=242.773ms, n=64samples"
          },
          {
            "name": "cache_scrub_fifo",
            "value": 271.4223,
            "range": "±0.02%",
            "unit": "ms",
            "extra": "p99=272.408ms, n=64samples"
          },
          {
            "name": "cache_concurrent_dedup",
            "value": 30.1598,
            "range": "±0.04%",
            "unit": "ms",
            "extra": "p99=30.188ms, n=67samples"
          },
          {
            "name": "cache_concurrent_no_dedup",
            "value": 30.195,
            "range": "±0.12%",
            "unit": "ms",
            "extra": "p99=30.685ms, n=67samples"
          },
          {
            "name": "readwindow_edf_2s",
            "value": 23.1826,
            "range": "±4.40%",
            "unit": "ms",
            "extra": "p99=35.006ms, n=87samples"
          },
          {
            "name": "readwindow_edf_10s",
            "value": 28.1395,
            "range": "±7.92%",
            "unit": "ms",
            "extra": "p99=61.945ms, n=72samples"
          },
          {
            "name": "readwindow_edf_30s",
            "value": 37.1479,
            "range": "±10.93%",
            "unit": "ms",
            "extra": "p99=103.167ms, n=64samples"
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
          "id": "880315397435a48af95bf31fd95cfddef5007df4",
          "message": "feat(bridge): accept a Blob pose over the host-page bridge\n\nThe bridge took `pose` only as a URL, so a host holding the sidecar in\nmemory had to base64 it into a data: URL — a third more bytes for JSON\nthe viewer immediately parses back. That cost lands in every notebook\ncell braindecode's BIDSDataset.plot() renders.\n\n`pose` may now be a Blob or File as well. The panel reads it with\n.text() instead of fetch(), which also means no object URL to revoke.\nURL strings, data: URLs included, keep working unchanged.",
          "timestamp": "2026-08-27T15:02:35+02:00",
          "tree_id": "165a5fbcbc7e908a665a415d9a1f12f6a58d4584",
          "url": "https://github.com/eegdash/eegdash-viewer/commit/880315397435a48af95bf31fd95cfddef5007df4"
        },
        "date": 1787836125375,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "filter_hp_250hz",
            "value": 2.6418,
            "range": "±0.63%",
            "unit": "ms",
            "extra": "p99=3.817ms, n=758samples"
          },
          {
            "name": "filter_lp_250hz",
            "value": 2.6564,
            "range": "±0.73%",
            "unit": "ms",
            "extra": "p99=3.968ms, n=753samples"
          },
          {
            "name": "filter_notch_250hz",
            "value": 2.6453,
            "range": "±0.64%",
            "unit": "ms",
            "extra": "p99=3.748ms, n=757samples"
          },
          {
            "name": "filter_bp_250hz",
            "value": 4.9142,
            "range": "±0.49%",
            "unit": "ms",
            "extra": "p99=5.947ms, n=407samples"
          },
          {
            "name": "filter_hp_512hz",
            "value": 5.3061,
            "range": "±0.52%",
            "unit": "ms",
            "extra": "p99=6.417ms, n=377samples"
          },
          {
            "name": "filter_lp_512hz",
            "value": 5.2535,
            "range": "±0.35%",
            "unit": "ms",
            "extra": "p99=6.052ms, n=381samples"
          },
          {
            "name": "filter_notch_512hz",
            "value": 5.2678,
            "range": "±0.35%",
            "unit": "ms",
            "extra": "p99=5.956ms, n=380samples"
          },
          {
            "name": "filter_bp_512hz",
            "value": 9.9376,
            "range": "±0.70%",
            "unit": "ms",
            "extra": "p99=11.173ms, n=202samples"
          },
          {
            "name": "filter_hp_1000hz",
            "value": 10.7898,
            "range": "±1.78%",
            "unit": "ms",
            "extra": "p99=15.114ms, n=186samples"
          },
          {
            "name": "filter_lp_1000hz",
            "value": 11.043,
            "range": "±1.95%",
            "unit": "ms",
            "extra": "p99=15.263ms, n=182samples"
          },
          {
            "name": "filter_notch_1000hz",
            "value": 10.9226,
            "range": "±1.85%",
            "unit": "ms",
            "extra": "p99=15.794ms, n=184samples"
          },
          {
            "name": "filter_bp_1000hz",
            "value": 19.0238,
            "range": "±0.17%",
            "unit": "ms",
            "extra": "p99=19.615ms, n=106samples"
          },
          {
            "name": "matv5_pipeline_32ch_250hz_30s_single",
            "value": 0.0102,
            "range": "±0.24%",
            "unit": "ms",
            "extra": "p99=0.019ms, n=196411samples"
          },
          {
            "name": "matv5_pipeline_64ch_512hz_60s_single",
            "value": 0.0102,
            "range": "±0.23%",
            "unit": "ms",
            "extra": "p99=0.018ms, n=196862samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_single",
            "value": 0.0101,
            "range": "±0.25%",
            "unit": "ms",
            "extra": "p99=0.018ms, n=197392samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_double",
            "value": 11.8872,
            "range": "±1.10%",
            "unit": "ms",
            "extra": "p99=14.446ms, n=169samples"
          },
          {
            "name": "matv5_parse_raw_1MB",
            "value": 0.0029,
            "range": "±0.27%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=689548samples"
          },
          {
            "name": "matv5_parse_raw_10MB",
            "value": 0.0029,
            "range": "±0.29%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=689303samples"
          },
          {
            "name": "matv5_parse_raw_50MB",
            "value": 0.0029,
            "range": "±0.28%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=689337samples"
          },
          {
            "name": "cache_scrub_lru",
            "value": 241.6897,
            "range": "±0.04%",
            "unit": "ms",
            "extra": "p99=242.619ms, n=64samples"
          },
          {
            "name": "cache_scrub_fifo",
            "value": 271.6489,
            "range": "±0.02%",
            "unit": "ms",
            "extra": "p99=272.125ms, n=64samples"
          },
          {
            "name": "cache_concurrent_dedup",
            "value": 30.2297,
            "range": "±0.06%",
            "unit": "ms",
            "extra": "p99=30.545ms, n=67samples"
          },
          {
            "name": "cache_concurrent_no_dedup",
            "value": 30.2348,
            "range": "±0.16%",
            "unit": "ms",
            "extra": "p99=30.613ms, n=67samples"
          },
          {
            "name": "readwindow_edf_2s",
            "value": 53.6936,
            "range": "±43.00%",
            "unit": "ms",
            "extra": "p99=343.932ms, n=64samples"
          },
          {
            "name": "readwindow_edf_10s",
            "value": 53.3592,
            "range": "±11.48%",
            "unit": "ms",
            "extra": "p99=146.579ms, n=64samples"
          },
          {
            "name": "readwindow_edf_30s",
            "value": 54.5715,
            "range": "±9.16%",
            "unit": "ms",
            "extra": "p99=117.181ms, n=64samples"
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
          "id": "4f5c58c7b40687a9a36ec2031d559a7380edf9d1",
          "message": "fix: preserve BIDS stimulus ids and hover state",
          "timestamp": "2026-08-31T20:22:50+02:00",
          "tree_id": "b392a6ab44ed433558c020ac1dc3225c01f84678",
          "url": "https://github.com/eegdash/eegdash-viewer/commit/4f5c58c7b40687a9a36ec2031d559a7380edf9d1"
        },
        "date": 1788201765727,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "filter_hp_250hz",
            "value": 1.7703,
            "range": "±1.34%",
            "unit": "ms",
            "extra": "p99=4.396ms, n=1130samples"
          },
          {
            "name": "filter_lp_250hz",
            "value": 1.698,
            "range": "±0.38%",
            "unit": "ms",
            "extra": "p99=2.203ms, n=1178samples"
          },
          {
            "name": "filter_notch_250hz",
            "value": 1.6899,
            "range": "±0.37%",
            "unit": "ms",
            "extra": "p99=1.905ms, n=1184samples"
          },
          {
            "name": "filter_bp_250hz",
            "value": 3.2211,
            "range": "±1.61%",
            "unit": "ms",
            "extra": "p99=7.948ms, n=621samples"
          },
          {
            "name": "filter_hp_512hz",
            "value": 3.4845,
            "range": "±0.55%",
            "unit": "ms",
            "extra": "p99=4.153ms, n=574samples"
          },
          {
            "name": "filter_lp_512hz",
            "value": 3.3861,
            "range": "±0.29%",
            "unit": "ms",
            "extra": "p99=3.945ms, n=591samples"
          },
          {
            "name": "filter_notch_512hz",
            "value": 3.393,
            "range": "±0.29%",
            "unit": "ms",
            "extra": "p99=3.665ms, n=590samples"
          },
          {
            "name": "filter_bp_512hz",
            "value": 6.4167,
            "range": "±1.92%",
            "unit": "ms",
            "extra": "p99=12.822ms, n=312samples"
          },
          {
            "name": "filter_hp_1000hz",
            "value": 6.5402,
            "range": "±0.16%",
            "unit": "ms",
            "extra": "p99=6.763ms, n=306samples"
          },
          {
            "name": "filter_lp_1000hz",
            "value": 6.6844,
            "range": "±1.34%",
            "unit": "ms",
            "extra": "p99=9.827ms, n=300samples"
          },
          {
            "name": "filter_notch_1000hz",
            "value": 6.7064,
            "range": "±1.20%",
            "unit": "ms",
            "extra": "p99=8.717ms, n=299samples"
          },
          {
            "name": "filter_bp_1000hz",
            "value": 12.2978,
            "range": "±1.63%",
            "unit": "ms",
            "extra": "p99=16.662ms, n=163samples"
          },
          {
            "name": "matv5_pipeline_32ch_250hz_30s_single",
            "value": 0.0077,
            "range": "±0.20%",
            "unit": "ms",
            "extra": "p99=0.014ms, n=258294samples"
          },
          {
            "name": "matv5_pipeline_64ch_512hz_60s_single",
            "value": 0.0078,
            "range": "±0.23%",
            "unit": "ms",
            "extra": "p99=0.014ms, n=258016samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_single",
            "value": 0.0077,
            "range": "±0.20%",
            "unit": "ms",
            "extra": "p99=0.013ms, n=258264samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_double",
            "value": 6.5121,
            "range": "±0.75%",
            "unit": "ms",
            "extra": "p99=8.269ms, n=308samples"
          },
          {
            "name": "matv5_parse_raw_1MB",
            "value": 0.0021,
            "range": "±0.21%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=935508samples"
          },
          {
            "name": "matv5_parse_raw_10MB",
            "value": 0.0021,
            "range": "±0.22%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=933035samples"
          },
          {
            "name": "matv5_parse_raw_50MB",
            "value": 0.0022,
            "range": "±0.32%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=913392samples"
          },
          {
            "name": "cache_scrub_lru",
            "value": 241.6252,
            "range": "±0.07%",
            "unit": "ms",
            "extra": "p99=243.412ms, n=64samples"
          },
          {
            "name": "cache_scrub_fifo",
            "value": 271.5789,
            "range": "±0.05%",
            "unit": "ms",
            "extra": "p99=273.446ms, n=64samples"
          },
          {
            "name": "cache_concurrent_dedup",
            "value": 30.1885,
            "range": "±0.11%",
            "unit": "ms",
            "extra": "p99=30.758ms, n=67samples"
          },
          {
            "name": "cache_concurrent_no_dedup",
            "value": 30.1787,
            "range": "±0.04%",
            "unit": "ms",
            "extra": "p99=30.365ms, n=67samples"
          },
          {
            "name": "readwindow_edf_2s",
            "value": 50.6322,
            "range": "±1.30%",
            "unit": "ms",
            "extra": "p99=56.344ms, n=64samples"
          },
          {
            "name": "readwindow_edf_10s",
            "value": 89.9958,
            "range": "±2.56%",
            "unit": "ms",
            "extra": "p99=125.413ms, n=64samples"
          },
          {
            "name": "readwindow_edf_30s",
            "value": 134.9541,
            "range": "±9.36%",
            "unit": "ms",
            "extra": "p99=324.848ms, n=64samples"
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
          "id": "2719825daae4d0767fb32eb83af83796362fe256",
          "message": "fix: deploy stimulus panel",
          "timestamp": "2026-08-31T20:56:14+02:00",
          "tree_id": "efff417589e03d9dc1cc819e7d87171de5b36ceb",
          "url": "https://github.com/eegdash/eegdash-viewer/commit/2719825daae4d0767fb32eb83af83796362fe256"
        },
        "date": 1788202783617,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "filter_hp_250hz",
            "value": 2.1609,
            "range": "±1.05%",
            "unit": "ms",
            "extra": "p99=3.997ms, n=926samples"
          },
          {
            "name": "filter_lp_250hz",
            "value": 2.1405,
            "range": "±0.94%",
            "unit": "ms",
            "extra": "p99=4.004ms, n=935samples"
          },
          {
            "name": "filter_notch_250hz",
            "value": 2.1441,
            "range": "±0.96%",
            "unit": "ms",
            "extra": "p99=3.959ms, n=933samples"
          },
          {
            "name": "filter_bp_250hz",
            "value": 3.9039,
            "range": "±1.11%",
            "unit": "ms",
            "extra": "p99=7.065ms, n=513samples"
          },
          {
            "name": "filter_hp_512hz",
            "value": 4.2717,
            "range": "±0.91%",
            "unit": "ms",
            "extra": "p99=6.256ms, n=469samples"
          },
          {
            "name": "filter_lp_512hz",
            "value": 4.1853,
            "range": "±0.70%",
            "unit": "ms",
            "extra": "p99=5.645ms, n=478samples"
          },
          {
            "name": "filter_notch_512hz",
            "value": 4.1911,
            "range": "±0.55%",
            "unit": "ms",
            "extra": "p99=4.519ms, n=478samples"
          },
          {
            "name": "filter_bp_512hz",
            "value": 7.8464,
            "range": "±0.99%",
            "unit": "ms",
            "extra": "p99=9.989ms, n=255samples"
          },
          {
            "name": "filter_hp_1000hz",
            "value": 8.19,
            "range": "±0.32%",
            "unit": "ms",
            "extra": "p99=8.791ms, n=245samples"
          },
          {
            "name": "filter_lp_1000hz",
            "value": 8.1538,
            "range": "±0.21%",
            "unit": "ms",
            "extra": "p99=8.538ms, n=246samples"
          },
          {
            "name": "filter_notch_1000hz",
            "value": 8.148,
            "range": "±0.21%",
            "unit": "ms",
            "extra": "p99=8.621ms, n=246samples"
          },
          {
            "name": "filter_bp_1000hz",
            "value": 14.9858,
            "range": "±0.25%",
            "unit": "ms",
            "extra": "p99=15.633ms, n=134samples"
          },
          {
            "name": "matv5_pipeline_32ch_250hz_30s_single",
            "value": 0.0096,
            "range": "±0.19%",
            "unit": "ms",
            "extra": "p99=0.021ms, n=207661samples"
          },
          {
            "name": "matv5_pipeline_64ch_512hz_60s_single",
            "value": 0.0096,
            "range": "±0.19%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=209373samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_single",
            "value": 0.0096,
            "range": "±0.18%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=208897samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_double",
            "value": 8.0262,
            "range": "±0.87%",
            "unit": "ms",
            "extra": "p99=10.657ms, n=250samples"
          },
          {
            "name": "matv5_parse_raw_1MB",
            "value": 0.0026,
            "range": "±0.20%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=763071samples"
          },
          {
            "name": "matv5_parse_raw_10MB",
            "value": 0.0027,
            "range": "±1.46%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=752314samples"
          },
          {
            "name": "matv5_parse_raw_50MB",
            "value": 0.0027,
            "range": "±1.24%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=747129samples"
          },
          {
            "name": "cache_scrub_lru",
            "value": 241.6352,
            "range": "±0.06%",
            "unit": "ms",
            "extra": "p99=243.318ms, n=64samples"
          },
          {
            "name": "cache_scrub_fifo",
            "value": 271.7536,
            "range": "±0.05%",
            "unit": "ms",
            "extra": "p99=272.999ms, n=64samples"
          },
          {
            "name": "cache_concurrent_dedup",
            "value": 30.2045,
            "range": "±0.12%",
            "unit": "ms",
            "extra": "p99=30.910ms, n=67samples"
          },
          {
            "name": "cache_concurrent_no_dedup",
            "value": 30.2294,
            "range": "±0.16%",
            "unit": "ms",
            "extra": "p99=31.260ms, n=67samples"
          },
          {
            "name": "readwindow_edf_2s",
            "value": 23.1633,
            "range": "±12.77%",
            "unit": "ms",
            "extra": "p99=48.923ms, n=90samples"
          },
          {
            "name": "readwindow_edf_10s",
            "value": 31.483,
            "range": "±8.89%",
            "unit": "ms",
            "extra": "p99=69.369ms, n=64samples"
          },
          {
            "name": "readwindow_edf_30s",
            "value": 39.0579,
            "range": "±7.91%",
            "unit": "ms",
            "extra": "p99=93.007ms, n=64samples"
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
          "id": "3058498453eb552f19a8a80e0fe15485c7655433",
          "message": "fix: align sparse stimulus events",
          "timestamp": "2026-08-31T22:39:45+02:00",
          "tree_id": "f49423c9c5b0e1ef24c00e7ee13b3c3c79bbb213",
          "url": "https://github.com/eegdash/eegdash-viewer/commit/3058498453eb552f19a8a80e0fe15485c7655433"
        },
        "date": 1788209024592,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "filter_hp_250hz",
            "value": 2.22,
            "range": "±1.22%",
            "unit": "ms",
            "extra": "p99=3.843ms, n=901samples"
          },
          {
            "name": "filter_lp_250hz",
            "value": 2.145,
            "range": "±1.10%",
            "unit": "ms",
            "extra": "p99=3.825ms, n=934samples"
          },
          {
            "name": "filter_notch_250hz",
            "value": 2.1304,
            "range": "±0.97%",
            "unit": "ms",
            "extra": "p99=3.811ms, n=939samples"
          },
          {
            "name": "filter_bp_250hz",
            "value": 4.0449,
            "range": "±1.43%",
            "unit": "ms",
            "extra": "p99=6.945ms, n=495samples"
          },
          {
            "name": "filter_hp_512hz",
            "value": 4.4312,
            "range": "±1.45%",
            "unit": "ms",
            "extra": "p99=7.678ms, n=452samples"
          },
          {
            "name": "filter_lp_512hz",
            "value": 4.453,
            "range": "±1.52%",
            "unit": "ms",
            "extra": "p99=7.706ms, n=450samples"
          },
          {
            "name": "filter_notch_512hz",
            "value": 4.3544,
            "range": "±1.41%",
            "unit": "ms",
            "extra": "p99=7.620ms, n=460samples"
          },
          {
            "name": "filter_bp_512hz",
            "value": 7.9033,
            "range": "±1.25%",
            "unit": "ms",
            "extra": "p99=12.352ms, n=254samples"
          },
          {
            "name": "filter_hp_1000hz",
            "value": 8.5718,
            "range": "±2.01%",
            "unit": "ms",
            "extra": "p99=14.734ms, n=234samples"
          },
          {
            "name": "filter_lp_1000hz",
            "value": 8.2796,
            "range": "±1.19%",
            "unit": "ms",
            "extra": "p99=13.414ms, n=242samples"
          },
          {
            "name": "filter_notch_1000hz",
            "value": 8.2736,
            "range": "±1.25%",
            "unit": "ms",
            "extra": "p99=13.059ms, n=242samples"
          },
          {
            "name": "filter_bp_1000hz",
            "value": 14.9368,
            "range": "±0.62%",
            "unit": "ms",
            "extra": "p99=17.150ms, n=134samples"
          },
          {
            "name": "matv5_pipeline_32ch_250hz_30s_single",
            "value": 0.0094,
            "range": "±0.18%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=213475samples"
          },
          {
            "name": "matv5_pipeline_64ch_512hz_60s_single",
            "value": 0.0094,
            "range": "±0.53%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=212985samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_single",
            "value": 0.0094,
            "range": "±0.19%",
            "unit": "ms",
            "extra": "p99=0.020ms, n=213084samples"
          },
          {
            "name": "matv5_pipeline_64ch_1000hz_120s_double",
            "value": 8.0286,
            "range": "±0.63%",
            "unit": "ms",
            "extra": "p99=9.986ms, n=250samples"
          },
          {
            "name": "matv5_parse_raw_1MB",
            "value": 0.0026,
            "range": "±0.20%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=769360samples"
          },
          {
            "name": "matv5_parse_raw_10MB",
            "value": 0.0026,
            "range": "±1.43%",
            "unit": "ms",
            "extra": "p99=0.004ms, n=756270samples"
          },
          {
            "name": "matv5_parse_raw_50MB",
            "value": 0.0026,
            "range": "±1.69%",
            "unit": "ms",
            "extra": "p99=0.003ms, n=759914samples"
          },
          {
            "name": "cache_scrub_lru",
            "value": 241.5359,
            "range": "±0.04%",
            "unit": "ms",
            "extra": "p99=242.422ms, n=64samples"
          },
          {
            "name": "cache_scrub_fifo",
            "value": 271.4242,
            "range": "±0.02%",
            "unit": "ms",
            "extra": "p99=272.415ms, n=64samples"
          },
          {
            "name": "cache_concurrent_dedup",
            "value": 30.1563,
            "range": "±0.06%",
            "unit": "ms",
            "extra": "p99=30.242ms, n=67samples"
          },
          {
            "name": "cache_concurrent_no_dedup",
            "value": 30.192,
            "range": "±0.05%",
            "unit": "ms",
            "extra": "p99=30.422ms, n=67samples"
          },
          {
            "name": "readwindow_edf_2s",
            "value": 17.1838,
            "range": "±13.03%",
            "unit": "ms",
            "extra": "p99=45.172ms, n=117samples"
          },
          {
            "name": "readwindow_edf_10s",
            "value": 108.1123,
            "range": "±1.20%",
            "unit": "ms",
            "extra": "p99=128.284ms, n=64samples"
          },
          {
            "name": "readwindow_edf_30s",
            "value": 120.3071,
            "range": "±13.43%",
            "unit": "ms",
            "extra": "p99=317.648ms, n=64samples"
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