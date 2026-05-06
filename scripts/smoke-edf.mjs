// Smoke test for the EDF reader (Phase 3). Tolerance is 1e-3 µV on
// elementwise diff against mne's read_raw_edf. Run:
//   node scripts/smoke-edf.mjs
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRef, makeChecker, maxAbsDiff, printChannelStats } from './_smoke_lib.mjs';

const require = createRequire(import.meta.url);
require('../bids-loader.js');
require('../formats/_buffers.js');
require('../formats/_http_range.js');
const BIDSRecording = require('../bids-recording.js');
const EDFReader     = require('../formats/edf.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const ref = loadRef(join(HERE, 'cross_check_edf.json'),
                    'python scripts/cross_check_edf.py');
const { check, summary } = makeChecker();

console.log(`source: ${ref.source}`);
const meta = await BIDSRecording.loadRecordingMetadata(ref.source);
console.log(`sidecars: channels=${meta.channels?.length}  fs=${meta.eeg_json.sampling_frequency}Hz`);

const reader = await EDFReader.open(meta);
console.log(`EDF:  n_channels=${reader.n_channels}  n_samples=${reader.n_samples}  fs=${reader.sampling_frequency}Hz  duration=${reader.duration_s.toFixed(3)}s  bps=${reader.bytes_per_sample}`);

check('n_channels matches mne (excluding annotation channels)',
      reader.n_channels === ref.n_channels,
      `${reader.n_channels} vs ${ref.n_channels}`);
check('sampling_frequency matches mne',
      reader.sampling_frequency === ref.sampling_frequency,
      `${reader.sampling_frequency} vs ${ref.sampling_frequency}`);
check('n_samples matches mne',
      reader.n_samples === ref.n_samples_total,
      `${reader.n_samples} vs ${ref.n_samples_total}`);

const win = await reader.readWindow(0, ref.first_n);
check('every channel returned the requested window length',
      win.every(ch => ch.length === ref.first_n));

// mne re-encodes stim channels as integer event codes; skip them
// in the value-equality check since our reader honours the EDF
// physical formula uniformly.
const TOL_UV = 1e-3;
const { max, argmax, nCompared } = maxAbsDiff(win, ref, { skip: ref.is_stim });
check(`physical values match mne on ${nCompared} non-stim channels (tol ${TOL_UV} µV)`,
      max <= TOL_UV,
      `max |Δ| = ${max.toExponential(3)} µV` +
      (max > TOL_UV
        ? `  worst @ ${ref.channel_names[argmax.ch]}[${argmax.s}]: ours=${argmax.ours}, ref=${argmax.ref}`
        : ''));

// Reading across a record boundary exercises the inter-record stitch.
// EDF records are 1 s each here, so [510, 514) straddles records 0 and 1.
const cross = await reader.readWindow(510, 4);
check('cross-record window has correct length', cross[0].length === 4);

printChannelStats(win, ref.channel_names, ref.first_n);
summary();
