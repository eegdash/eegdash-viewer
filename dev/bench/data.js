window.BENCHMARK_DATA = {
  "lastUpdate": 1780238473505,
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
      }
    ]
  }
}