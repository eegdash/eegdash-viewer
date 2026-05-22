#!/usr/bin/env node
/**
 * scripts/make-nwb-chunked-fixtures.mjs
 *
 * Generates two chunked + gzip-compressed NWB fixtures that the
 * streaming-reader test suite (tests/unit-nwb-range.test.mjs)
 * exercises:
 *
 *   tests/fixtures/ieeg/nwb-chunked.nwb        ~530 KB
 *     20,000 samples × 8 channels, chunks (1000, 8). 20 chunks.
 *     Smallest fixture that has a non-degenerate chunk B-tree.
 *
 *   tests/fixtures/ieeg/nwb-chunked-large.nwb  ~22 MB
 *     100,000 samples × 64 channels, chunks (1000, 64). 100 chunks.
 *     Big enough to assert that the streaming reader fetches
 *     O(window) bytes, not O(file). Tested against a HEAD-buffer
 *     reader path with a tracking HttpRange.
 *
 * Both files write the small metadata datasets (starting_time,
 * electrodes/{id,label}, attributes) BEFORE the big data dataset so
 * the metadata lives at the head of the file — matching the layout
 * that pynwb's default ElectricalSeries writer produces. Some
 * real-world DANDI files (notably those produced by older neurodata
 * conversion scripts) write metadata datasets after the big data
 * dataset; those files fall back to the whole-file path. See
 * tests/evidence/nwb-streaming/README.md.
 *
 * Both fixtures are deterministic (sinusoids per channel) so the
 * SHA256 is stable across regenerations.
 *
 * Usage: node scripts/make-nwb-chunked-fixtures.mjs
 *
 * Requires python3 + h5py (same as scripts/make-nwb-fixture.mjs).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, '..', 'tests', 'fixtures', 'ieeg');
mkdirSync(OUT_DIR, { recursive: true });

const PY = `
import h5py
import numpy as np
import sys

OUT = sys.argv[1]
N_SAMPLES = int(sys.argv[2])
N_CHANNELS = int(sys.argv[3])
FS = 1000.0

with h5py.File(OUT, 'w') as f:
    # Write metadata FIRST so it lives at the head of the file.
    # In well-behaved pynwb output the small datasets (starting_time,
    # electrodes table) are created before the big data dataset; we
    # mirror that ordering so the streaming reader's head-buffer
    # probe succeeds without needing to fetch the tail.
    f.attrs['nwb_version'] = '2.6.0'
    f.attrs['neurodata_type'] = 'NWBFile'

    acq = f.create_group('acquisition')
    es = acq.create_group('ECoG')
    es.attrs['neurodata_type'] = 'ElectricalSeries'
    es.attrs['namespace'] = 'core'

    st = es.create_dataset('starting_time', data=0.0, dtype='float64')
    st.attrs['rate'] = FS
    st.attrs['unit'] = 'seconds'

    gen = f.create_group('general')
    ee = gen.create_group('extracellular_ephys')
    el = ee.create_group('electrodes')
    el.attrs['neurodata_type'] = 'DynamicTable'
    el.attrs['colnames'] = np.array(['label'], dtype='S')
    el.create_dataset('id', data=np.arange(N_CHANNELS, dtype='int32'))
    labels = np.array(['LFP{}'.format(i+1) for i in range(N_CHANNELS)], dtype='S8')
    el.create_dataset('label', data=labels)

    # Now the big chunked dataset. Sinusoids per channel match the
    # tiny fixture's convention (channel c carries sin(2*pi*(c+1)*t))
    # so the streaming-vs-whole-file equality assertions in the unit
    # tests are robust.
    t = np.arange(N_SAMPLES, dtype=np.float32) / FS
    data = np.zeros((N_SAMPLES, N_CHANNELS), dtype=np.float32)
    for c in range(N_CHANNELS):
        data[:, c] = np.sin(2 * np.pi * (c + 1) * t).astype(np.float32)
    es.create_dataset('data', data=data, dtype='float32',
                      chunks=(1000, N_CHANNELS), compression='gzip')

print('wrote', OUT, 'size:', sys.getsizeof(0))  # placeholder; real size in caller
`;

function runPy(outPath, nSamples, nChannels) {
  const r = spawnSync('python3', ['-c', PY, outPath, String(nSamples), String(nChannels)], {
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error('python3 + h5py is required (pip install h5py numpy)');
    process.exit(r.status ?? 1);
  }
}

runPy(join(OUT_DIR, 'nwb-chunked.nwb'), 20000, 8);
runPy(join(OUT_DIR, 'nwb-chunked-large.nwb'), 100000, 64);
