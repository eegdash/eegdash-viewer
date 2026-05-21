#!/usr/bin/env node
/**
 * scripts/make-nwb-fixture.mjs
 *
 * Generates a tiny synthetic NWB (Neurodata Without Borders) HDF5 file
 * that exercises the iEEG / ElectricalSeries read path of formats/nwb.js.
 *
 * NWB is HDF5-based — there is no pure-Node writer in jsfive (read-only).
 * We shell out to Python's h5py, which is available in the project's
 * conda environment and is a standard prerequisite for the upstream NWB
 * ecosystem (pynwb itself is built on h5py). The script writes only the
 * subset of the schema the reader actually touches:
 *
 *   /                              attrs: nwb_version, neurodata_type=NWBFile
 *   /acquisition/                  GROUP
 *   /acquisition/ECoG/             GROUP attrs: neurodata_type=ElectricalSeries
 *   /acquisition/ECoG/data         dataset [n_samples, n_channels] float32
 *   /acquisition/ECoG/starting_time scalar float64, attrs: rate, unit
 *   /general/extracellular_ephys/electrodes/  GROUP attrs: neurodata_type=DynamicTable
 *   /general/extracellular_ephys/electrodes/id     dataset [n_channels] int
 *   /general/extracellular_ephys/electrodes/label  dataset [n_channels] fixed-len ASCII
 *
 * Output: tests/fixtures/ieeg/nwb-tiny.nwb
 *
 * Usage:  node scripts/make-nwb-fixture.mjs
 *
 * Reference: https://nwb-schema.readthedocs.io/en/latest/format.html
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, '..', 'tests', 'fixtures', 'ieeg');
const OUT     = join(OUT_DIR, 'nwb-tiny.nwb');

mkdirSync(OUT_DIR, { recursive: true });

// We embed the Python writer inline so the script is self-contained.
// Numbers are deterministic (sinusoids at integer Hz per channel) so the
// fixture is bit-stable across regenerations — same SHA every run.
const PY = `
import h5py
import numpy as np
import sys

OUT = sys.argv[1]
N_SAMPLES = 5000           # 5 s @ 1000 Hz, well under 200 MB
N_CHANNELS = 4
FS = 1000.0

with h5py.File(OUT, 'w') as f:
    f.attrs['nwb_version'] = '2.6.0'
    f.attrs['neurodata_type'] = 'NWBFile'

    acq = f.create_group('acquisition')
    es = acq.create_group('ECoG')
    es.attrs['neurodata_type'] = 'ElectricalSeries'
    es.attrs['namespace'] = 'core'

    # Deterministic sinusoids: channel c gets sin(2*pi*(c+1)*t).
    t = np.arange(N_SAMPLES, dtype=np.float32) / FS
    data = np.zeros((N_SAMPLES, N_CHANNELS), dtype=np.float32)
    for c in range(N_CHANNELS):
        data[:, c] = np.sin(2 * np.pi * (c + 1) * t).astype(np.float32)
    es.create_dataset('data', data=data, dtype='float32')

    st = es.create_dataset('starting_time', data=0.0, dtype='float64')
    st.attrs['rate'] = FS
    st.attrs['unit'] = 'seconds'

    gen = f.create_group('general')
    ee = gen.create_group('extracellular_ephys')
    el = ee.create_group('electrodes')
    el.attrs['neurodata_type'] = 'DynamicTable'
    el.attrs['colnames'] = np.array(['label'], dtype='S')
    el.create_dataset('id', data=np.arange(N_CHANNELS, dtype='int32'))
    labels = np.array(['LFP1', 'LFP2', 'LFP3', 'LFP4'], dtype='S8')
    el.create_dataset('label', data=labels)

print('wrote', OUT)
`;

const r = spawnSync('python3', ['-c', PY, OUT], { stdio: 'inherit' });
if (r.status !== 0) {
  console.error('python3 + h5py is required to (re)generate the NWB fixture.');
  console.error('On macOS/Linux:  pip install h5py numpy');
  process.exit(r.status ?? 1);
}
