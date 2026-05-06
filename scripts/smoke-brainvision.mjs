// Smoke test for the BrainVision reader (Phase 4). Tolerance is
// 1e-3 µV elementwise vs mne's read_raw_brainvision. Run:
//   node scripts/smoke-brainvision.mjs
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRef, makeChecker, maxAbsDiff, printChannelStats } from './_smoke_lib.mjs';

const require = createRequire(import.meta.url);
require('../bids-loader.js');
require('../formats/_buffers.js');
require('../formats/_http_range.js');
const BIDSRecording = require('../bids-recording.js');
const BrainVisionReader = require('../formats/brainvision.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const ref = loadRef(join(HERE, 'cross_check_brainvision.json'),
                    'python scripts/cross_check_brainvision.py');
const { check, summary } = makeChecker();

console.log(`source: ${ref.source}`);
const meta = await BIDSRecording.loadRecordingMetadata(ref.source);
console.log(`sidecars: channels=${meta.channels?.length ?? 'absent'}  fs=${meta.eeg_json.sampling_frequency ?? 'absent'} Hz`);

const reader = await BrainVisionReader.open(meta);
console.log(`.eeg:  n_channels=${reader.n_channels}  n_samples=${reader.n_samples}  fs=${reader.sampling_frequency}Hz  format=${reader.binary_format}  bps=${reader.bytes_per_sample}`);

check('n_channels matches mne', reader.n_channels === ref.n_channels,
      `${reader.n_channels} vs ${ref.n_channels}`);
check('sampling_frequency matches mne', reader.sampling_frequency === ref.sampling_frequency,
      `${reader.sampling_frequency} vs ${ref.sampling_frequency}`);
check('n_samples matches mne', reader.n_samples === ref.n_samples_total,
      `${reader.n_samples} vs ${ref.n_samples_total}`);

const win = await reader.readWindow(0, ref.first_n);
check('every channel returned the requested window length',
      win.every(ch => ch.length === ref.first_n));

const TOL_UV = 1e-3;
const { max, argmax } = maxAbsDiff(win, ref);
check(`values match mne (tol ${TOL_UV} µV)`, max <= TOL_UV,
      `max |Δ| = ${max.toExponential(3)} µV` +
      (max > TOL_UV
        ? `  worst @ ${ref.channel_names[argmax.ch]}[${argmax.s}]: ours=${argmax.ours}, ref=${argmax.ref}`
        : ''));

// Disjoint window across a non-trivial time gap. BrainVision is flat
// (no records), so this just exercises a different byte range.
const win2 = await reader.readWindow(10000, 100);
check('disjoint windows differ',
      win.some((ch, c) => ch.some((v, s) => v !== win2[c][s])));

printChannelStats(win, ref.channel_names, ref.first_n);
summary();
