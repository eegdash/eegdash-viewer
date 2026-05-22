// Dev-only: inspect root structure of a v7.3 .set that fails our reader.
import { HttpRange } from '../tests/_bootstrap.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const jsfive = require('jsfive');

const urls = [
  'https://cdn.eegdash.org/ds004105/sub-01/ses-01/eeg/sub-01_ses-01_task-DriveRandomSound_run-1_eeg.set',
  'https://cdn.eegdash.org/ds004118/sub-01/ses-01/eeg/sub-01_ses-01_task-Drive_run-1_eeg.set',
];
for (const url of urls) {
  console.log(`\n=== ${url.split('/').slice(-1)} ===`);
  const buf = await HttpRange.fetchBuffer(url);
  const hdf5 = buf.slice(512);
  const file = new jsfive.File(hdf5);
  console.log(`  Root keys: ${JSON.stringify(file.keys)}`);
  for (const k of file.keys) {
    const node = file.get(k);
    if (node.keys) {
      console.log(`  ${k}: group, children=${node.keys.slice(0, 12).join(',')}`);
    } else {
      console.log(`  ${k}: dataset`);
    }
  }
}
