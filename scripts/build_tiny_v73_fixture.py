#!/usr/bin/env python3
# Builds tests/fixtures/eeg/tiny_v73_eeg.set — a 6 KB MAT v7.3 (HDF5)
# EEGLAB-shape file used by tests/unit-eeglab-mat73.test.mjs to verify
# the v7.3 inline-data path. The fixture is hand-rolled (rather than
# fetched from mne-testing-data) so:
#
#   1. The repo doesn't need a 2.4 MB binary for a parser test
#      (the real-world fixtures still live in /tmp/eegdash-fixtures
#      and the test skips when they're absent).
#   2. Field shape + scale + first-sample values are *deterministic*,
#      so a regression in the reader fails with a stable diff.
#
# The output is committed (do not re-run unless the fixture format
# changes); the script is here for documentation and reproducibility.
#
# Requirements: numpy, h5py.

import os
import numpy as np
import h5py

OUT = os.path.join(
    os.path.dirname(__file__),
    '..',
    'tests',
    'fixtures',
    'eeg',
    'tiny_v73_eeg.set',
)

# Deterministic seed: any change in the random stream would change
# the on-disk bytes (which we want to keep stable across runs).
np.random.seed(42)
fs, nch, nsamp = 100, 4, 50

# MATLAB stores EEG.data as (nbchan, pnts) in column-major. In HDF5
# (row-major) we declare the transpose so the same on-disk byte
# sequence reads correctly when MATLAB / EEGLAB / scipy.io re-load
# the file. The MatV5.extractEegInline path uses MATLAB's dim order
# (nbchan, pnts), so our Mat73 reader transposes back.
data = (np.random.randn(nch, nsamp).astype('float32') * 10)

# Write the HDF5 portion first to a temp file, then prepend a 512-byte
# MAT v7.3 legacy header. We do it this way because h5py won't write
# into an existing buffer at offset 512; the cleanest path is two-pass.
HDF_TMP = OUT + '.hdf'
with h5py.File(HDF_TMP, 'w', libver='earliest') as f:
    eeg = f.create_group('EEG')
    # data — transpose for HDF5 dim order
    ds = eeg.create_dataset('data', data=data.T, dtype='float32')
    ds.attrs['MATLAB_class'] = np.array(b'single')
    # scalars — small 1x1 doubles, stored as compact-layout by h5py
    # for tiny payloads (which is exactly the path our compact-storage
    # patch is needed for).
    for name, val in [('srate', fs), ('nbchan', nch),
                       ('pnts', nsamp), ('trials', 1)]:
        d = eeg.create_dataset(name, data=np.array([[val]], dtype='float64'))
        d.attrs['MATLAB_class'] = np.array(b'double')

# 512-byte legacy MAT v7.3 header. MATLAB / Octave / scipy.io all
# recognise this prefix; without it, even readers that handle plain
# HDF5 won't accept the file as a .set.
hdr = bytearray(512)
text = b'MATLAB 7.3 MAT-file (made for eegdash-viewer test)'
hdr[:len(text)] = text
hdr[124:126] = (0x0200).to_bytes(2, 'little')  # version v7.3
hdr[126:128] = (0x4D49).to_bytes(2, 'little')  # IM = little-endian

with open(HDF_TMP, 'rb') as f:
    hdf_body = f.read()
with open(OUT, 'wb') as f:
    f.write(hdr)
    f.write(hdf_body)
os.remove(HDF_TMP)
size = os.path.getsize(OUT)
print(f'wrote {OUT} ({size} bytes)')
