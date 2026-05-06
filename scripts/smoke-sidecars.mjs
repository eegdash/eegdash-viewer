// Smoke test: fetch BIDS sidecars for a handful of OpenNeuro recordings
// across all three raw formats and print what we get back. Run with:
//   node scripts/smoke-sidecars.mjs
// Exits non-zero if any required sidecar fails to load.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../bids-loader.js');                 // attaches BIDSLoader to globalThis
require('../formats/_http_range.js');         // attaches HttpRange (fetchTextOrNull, …)
const BIDSRecording = require('../bids-recording.js');

const cases = [
  { label: 'EEGLAB .set+.fdt (ds002893)',
    url: 'https://s3.amazonaws.com/openneuro.org/ds002893/sub-001/eeg/sub-001_task-AuditoryVisualShift_run-01_eeg.set' },
  { label: 'EEGLAB .set+.fdt (ds003478)',
    url: 'https://s3.amazonaws.com/openneuro.org/ds003478/sub-001/eeg/sub-001_task-Rest_run-01_eeg.set' },
  { label: 'EEGLAB .set+.fdt (ds004504)',
    url: 'https://s3.amazonaws.com/openneuro.org/ds004504/sub-001/eeg/sub-001_task-eyesclosed_eeg.set' },
  { label: 'EDF (ds002034)',
    url: 'https://s3.amazonaws.com/openneuro.org/ds002034/sub-01/ses-01/eeg/sub-01_ses-01_task-offline_run-01_eeg.edf' },
  { label: 'BrainVision (ds002336)',
    url: 'https://s3.amazonaws.com/openneuro.org/ds002336/sub-xp101/eeg/sub-xp101_task-eegfmriNF_eeg.vhdr' },
];

let fails = 0;
for (const { label, url } of cases) {
  process.stdout.write(`\n=== ${label} ===\n`);
  try {
    const meta = await BIDSRecording.loadRecordingMetadata(url);
    const e = meta.eeg_json;
    console.log(`  ext=${meta.ext}  fs=${e.sampling_frequency}Hz  dur=${e.recording_duration ?? '?'}s  ref=${e.eeg_reference ?? '?'}`);
    console.log(`  channels=${meta.channels?.length ?? 'absent'}  events=${meta.events.length}  electrodes=${meta.electrodes?.length ?? 'absent'}  coordsys=${meta.coordsystem ? meta.coordsystem.space : 'absent'}`);
    if (meta.channels?.length) {
      const ch0 = meta.channels[0], chN = meta.channels[meta.channels.length - 1];
      console.log(`  ch[0]=${ch0.name} (${ch0.type ?? '?'}, ${ch0.units ?? '?'})  ch[-1]=${chN.name}`);
    }
    if (meta.events.length) {
      console.log(`  ev[0] onset=${meta.events[0].onset}s label=${meta.events[0].label ?? '?'}`);
    }
  } catch (err) {
    console.error(`  FAIL: ${err.message}`);
    fails++;
  }
}

console.log(`\n${cases.length - fails}/${cases.length} ok`);
process.exit(fails ? 1 : 0);
