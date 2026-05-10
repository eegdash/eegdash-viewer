/**
 * tests/fixtures/synthetic.mjs
 *
 * In-memory synthetic EEG recording builders for offline unit tests.
 * All helpers return Blobs (or raw ArrayBuffers) that can be fed
 * directly to the reader modules without any network calls.
 *
 * EEGLAB split layout is the simplest to construct in-memory
 * because the data format is just flat little-endian float32 stored
 * in column-major order: sample0_ch0, sample0_ch1, ..., sample1_ch0, ...
 *
 * USAGE
 *   import { synthEEGLABSplit, synthEDF } from '../fixtures/synthetic.mjs';
 *
 *   // Build a 4-channel, 256 Hz, 2-second recording
 *   const { setBlob, fdtBlob, sidecars } = await synthEEGLABSplit({ nCh: 4, fs: 256, durationS: 2 });
 *
 *   // Mount as object URLs for in-browser tests, or pass as Blobs
 *   // to node-based reader unit tests via a FileBlob shim.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Write a little-endian float32 at the given byte offset.
 * @param {DataView} view
 * @param {number} offset
 * @param {number} value
 */
function writeF32LE(view, offset, value) {
  view.setFloat32(offset, value, /*littleEndian=*/true);
}

/**
 * Write a null-padded ASCII string into a DataView.
 * @param {DataView} view
 * @param {number} offset
 * @param {string} str
 * @param {number} length — total bytes to fill (pad with null)
 */
function writeASCII(view, offset, str, length) {
  for (let i = 0; i < length; i++) {
    view.setUint8(offset + i, i < str.length ? str.charCodeAt(i) : 0);
  }
}

// ---------------------------------------------------------------------------
// EEGLAB split: minimal .set header + .fdt data blob
// ---------------------------------------------------------------------------

/**
 * Build a minimal EEGLAB split (.set + .fdt) recording in memory.
 *
 * The .set is a MAT v5 file with just enough structure for the reader:
 *   EEG.nbchan, EEG.pnts, EEG.srate, EEG.data = 'EEGDATA' (points at .fdt).
 *
 * The .fdt is flat float32 column-major: each frame is [nCh floats].
 * Signal: a simple sine wave at `freqHz` per channel, different phase per ch.
 *
 * @param {{ nCh?: number, fs?: number, durationS?: number, freqHz?: number }} opts
 * @returns {{ setBlob: Blob, fdtBlob: Blob, sidecars: object, meta: object }}
 */
export function synthEEGLABSplit({ nCh = 4, fs = 256, durationS = 2, freqHz = 10 } = {}) {
  const nPts = Math.round(fs * durationS);
  const channelNames = Array.from({ length: nCh }, (_, i) => `Ch${i + 1}`);

  // --- Build .fdt (data) ---
  // Column-major: for each sample point, write all channels
  const fdtBuf = new ArrayBuffer(nCh * nPts * 4);
  const fdtView = new DataView(fdtBuf);
  for (let s = 0; s < nPts; s++) {
    const t = s / fs;
    for (let c = 0; c < nCh; c++) {
      const phase = (2 * Math.PI * c) / nCh;
      const sample = Math.sin(2 * Math.PI * freqHz * t + phase) * 10; // µV amplitude
      writeF32LE(fdtView, (s * nCh + c) * 4, sample);
    }
  }
  const fdtBlob = new Blob([fdtBuf], { type: 'application/octet-stream' });

  // --- Build minimal .set (MAT v5) ---
  // We construct just enough MAT v5 structure for the reader's open() path.
  // A proper MAT v5 file would be complex to build byte-by-byte, so we
  // return a structured descriptor instead that tests can use to mock
  // the reader's `parseMat` output directly.
  //
  // For tests that need the actual .set blob, use the `setDescriptor` form
  // with your own MAT v5 builder, or use the `mockMeta` helper below which
  // bypasses the .set parsing entirely and builds the meta object directly.
  const setDescriptor = {
    format: 'eeglab-split',
    nbchan: nCh,
    pnts: nPts,
    srate: fs,
    dataFile: 'EEGDATA', // points at sibling .fdt
  };

  // The minimal MAT v5 blob: 128-byte header + one variable.
  // We skip actual MAT encoding here because the unit tests that need it
  // call the reader via mockMeta (see below). If you need an actual parseable
  // .set blob, use scripts/make-edfplus-fixture.mjs as a reference.
  const setBlob = _buildMinimalMatBlob(setDescriptor);

  // Sidecars: minimal BIDS _channels.tsv and _eeg.json
  const sidecars = {
    channels_tsv: [
      'name\ttype\tunits\tsampling_frequency',
      ...channelNames.map(n => `${n}\tEEG\tuV\t${fs}`),
    ].join('\n'),
    eeg_json: JSON.stringify({
      SamplingFrequency: fs,
      EEGChannelCount: nCh,
      RecordingDuration: durationS,
    }, null, 2),
  };

  const meta = {
    channels: channelNames.map((name, i) => ({ name, type: 'EEG', units: 'uV', index: i })),
    fs,
    nPts,
    nCh,
    durationS,
    layout: 'split',
  };

  return { setBlob, fdtBlob, sidecars, meta, setDescriptor };
}

/**
 * Build mock reader meta for a synthetic EEGLAB split recording.
 * Use this when you want to bypass .set parsing and test the read-window
 * path directly (reader.open() usually builds this meta from the .set).
 *
 * @param {{ nCh?: number, fs?: number, durationS?: number }} opts
 * @returns {object} meta — the shape that EEGLABReader.open() resolves to
 */
export function synthEEGLABMeta({ nCh = 4, fs = 256, durationS = 2 } = {}) {
  const nPts = Math.round(fs * durationS);
  return {
    channels: Array.from({ length: nCh }, (_, i) => ({
      name: `Ch${i + 1}`,
      type: 'EEG',
      units: 'uV',
      index: i,
    })),
    fs,
    nPts,
    durationS,
    layout: 'split',
  };
}

// ---------------------------------------------------------------------------
// EDF builder — minimal but parseable
// ---------------------------------------------------------------------------

/**
 * Build a minimal EDF (European Data Format) blob in memory.
 *
 * Spec: https://www.edfplus.info/specs/edf.html
 * The EDF header is 256 + (nCh * 256) bytes.
 * Signal data is stored as int16 in record-sized chunks.
 *
 * @param {{ nCh?: number, fs?: number, durationS?: number, freqHz?: number }} opts
 * @returns {{ blob: Blob, meta: object }}
 */
export function synthEDF({ nCh = 4, fs = 256, durationS = 2, freqHz = 10 } = {}) {
  const recordDurationS = 1; // 1-second data records
  const nRecords = Math.ceil(durationS / recordDurationS);
  const samplesPerRecord = fs * recordDurationS; // samples per channel per record

  // EDF header sizes
  const HEADER_BYTES = 256 + nCh * 256;
  const RECORD_BYTES = nCh * samplesPerRecord * 2; // int16 = 2 bytes
  const totalBytes = HEADER_BYTES + nRecords * RECORD_BYTES;

  const buf = new ArrayBuffer(totalBytes);
  const u8 = new Uint8Array(buf);
  const view = new DataView(buf);

  // Helper: write fixed-width ASCII at offset
  const ascii = (offset, str, width) => {
    const padded = str.slice(0, width).padEnd(width, ' ');
    for (let i = 0; i < width; i++) u8[offset + i] = padded.charCodeAt(i);
  };

  // --- EDF header (256-byte global section) ---
  ascii(0, '0', 8);                          // version
  ascii(8, 'Synthetic', 80);                 // patient info
  ascii(88, 'Startdate 10.MAY.26', 80);      // recording info
  ascii(168, '01.01.00', 8);                 // startdate dd.mm.yy
  ascii(176, '00.00.00', 8);                 // starttime hh.mm.ss
  ascii(184, String(HEADER_BYTES), 8);       // bytes in header
  ascii(192, '', 44);                        // reserved
  ascii(236, String(nRecords), 8);           // number of data records
  ascii(244, String(recordDurationS), 8);    // duration of data record
  ascii(252, String(nCh), 4);               // number of signals

  // --- Per-channel signal header (nCh * 256 bytes) ---
  const CH_FIELDS = [
    { offset: 0,   width: 16, value: (i) => `Ch${i + 1}` },          // label
    { offset: 16,  width: 80, value: () => 'EEG' },                   // transducer
    { offset: 96,  width: 8,  value: () => 'uV' },                    // physical dim
    { offset: 104, width: 8,  value: () => '-500' },                  // physical min
    { offset: 112, width: 8,  value: () => '500' },                   // physical max
    { offset: 120, width: 8,  value: () => '-32768' },                // digital min
    { offset: 128, width: 8,  value: () => '32767' },                 // digital max
    { offset: 136, width: 80, value: () => '' },                      // prefiltering
    { offset: 216, width: 8,  value: () => String(samplesPerRecord) },// samples/record
    { offset: 224, width: 32, value: () => '' },                      // reserved
  ];

  for (let c = 0; c < nCh; c++) {
    const chBase = 256 + c * 256;
    for (const f of CH_FIELDS) {
      ascii(chBase + f.offset, f.value(c), f.width);
    }
  }

  // --- Signal data: int16 records ---
  let pos = HEADER_BYTES;
  for (let r = 0; r < nRecords; r++) {
    for (let c = 0; c < nCh; c++) {
      const phase = (2 * Math.PI * c) / nCh;
      for (let s = 0; s < samplesPerRecord; s++) {
        const t = (r * recordDurationS) + s / fs;
        const volt = Math.sin(2 * Math.PI * freqHz * t + phase) * 100; // µV
        // scale to int16 via the gain: physRange=1000, digRange=65535
        const raw = Math.round(volt * (32767 / 500));
        const clamped = Math.max(-32768, Math.min(32767, raw));
        view.setInt16(pos, clamped, /*littleEndian=*/true);
        pos += 2;
      }
    }
  }

  const blob = new Blob([buf], { type: 'application/octet-stream' });
  const meta = {
    nCh,
    fs,
    durationS: nRecords * recordDurationS,
    nRecords,
    samplesPerRecord,
    headerBytes: HEADER_BYTES,
    recordBytes: RECORD_BYTES,
  };

  return { blob, meta };
}

// ---------------------------------------------------------------------------
// Private: minimal MAT v5 blob builder (enough for header identification)
// ---------------------------------------------------------------------------

/**
 * Build a minimal MAT v5 blob whose 128-byte header identifies it as a
 * v5 file. The body is intentionally minimal (no variables) — this is
 * sufficient for tests that only probe file-type detection, not actual
 * variable parsing.
 *
 * @param {object} _descriptor — ignored, kept for documentation
 * @returns {Blob}
 */
function _buildMinimalMatBlob(_descriptor) {
  const buf = new ArrayBuffer(128);
  const u8 = new Uint8Array(buf);
  const view = new DataView(buf);

  // Bytes 0–115: description text
  const desc = 'MATLAB 5.0 MAT-file (synthetic EEGLab fixture)';
  for (let i = 0; i < Math.min(desc.length, 116); i++) {
    u8[i] = desc.charCodeAt(i);
  }
  // Pad with spaces
  for (let i = desc.length; i < 116; i++) u8[i] = 0x20;

  // Bytes 116–123: subsystem data offset (zero — no subsystem)
  for (let i = 116; i < 124; i++) u8[i] = 0;

  // Bytes 124–125: version 0x0100
  view.setUint16(124, 0x0100, /*littleEndian=*/false);

  // Bytes 126–127: endian indicator 'IM' = little-endian
  u8[126] = 0x49; // 'I'
  u8[127] = 0x4D; // 'M'

  return new Blob([buf], { type: 'application/octet-stream' });
}
