// Shared scaffolding for the per-format smoke tests under scripts/.
// Captures only the bits that are genuinely identical across phases:
// reference loading, pass/fail accounting, the elementwise diff loop
// against a Python-emitted reference, and the per-channel stats print.
//
// Format-specific bits (which channels to skip, which disjoint-window
// offset exercises a meaningful boundary, custom shape checks against
// format-specific ref fields) stay inline in each smoke script.
import { readFileSync, existsSync } from 'node:fs';

export function loadRef(refPath, regenHint) {
  if (!existsSync(refPath)) {
    console.error(`Missing ${refPath}.${regenHint ? ' Run: ' + regenHint : ''}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(refPath, 'utf8'));
}

// Encapsulates the pass/fail counter so smoke scripts don't manage
// shared mutable state. `summary()` exits with the right code.
export function makeChecker() {
  let fails = 0;
  function check(name, ok, detail) {
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ': ' + detail : ''}`);
    if (!ok) fails++;
  }
  function summary() {
    console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
    process.exit(fails ? 1 : 0);
  }
  return { check, summary };
}

// Compare a per-channel readWindow result against a Python reference
// (channels × samples float matrix in `ref.values_uv`). `skip` is an
// optional boolean array marking channels to exclude (EDF stim
// channels are mne-re-encoded and would never match our raw decode).
// Returns the worst-case diff plus the offending sample so callers
// can print it.
export function maxAbsDiff(win, ref, opts = {}) {
  const skip = opts.skip || [];
  let max = 0;
  let argmax = { ch: -1, s: -1, ours: 0, ref: 0 };
  let nCompared = 0;
  for (let c = 0; c < win.length; c++) {
    if (skip[c]) continue;
    nCompared++;
    const refRow = ref.values_uv[c];
    const ourRow = win[c];
    // Bound by ourRow.length so a short read (real bug) shows up as a
    // small nCompared rather than silently NaN-ing through the diff.
    const n = Math.min(ref.first_n, ourRow.length);
    for (let s = 0; s < n; s++) {
      const d = Math.abs(ourRow[s] - refRow[s]);
      if (d > max) { max = d; argmax = { ch: c, s, ours: ourRow[s], ref: refRow[s] }; }
    }
  }
  return { max, argmax, nCompared };
}

// Mean / stddev for the first few channels — useful sanity print so
// the smoke output is human-readable as well as pass/fail.
export function printChannelStats(win, names, n = 100, kChannels = 3) {
  console.log('  per-channel stats (first 100 samples):');
  const k = Math.min(kChannels, win.length);
  for (let c = 0; c < k; c++) {
    let sum = 0, sumSq = 0;
    for (let s = 0; s < n; s++) { sum += win[c][s]; sumSq += win[c][s] * win[c][s]; }
    const mean = sum / n;
    const std = Math.sqrt(sumSq / n - mean * mean);
    console.log(`    ${names[c].padEnd(12)} mean=${mean.toFixed(3)} µV  std=${std.toFixed(3)} µV`);
  }
}
