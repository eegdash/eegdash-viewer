// Shared bootstrap for the node:test suite. Every test file does the
// same dance: createRequire, side-effect-load globals, then require
// the modules under test. Centralising it means each test file can
// `import { … } from './_bootstrap.mjs'` and skip the preamble.
//
// The module cache makes the side-effect requires a no-op after the
// first import, but the *cognitive* duplication was the issue.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Side-effect loads attach BIDSLoader / HttpRange / ChannelBuffers
// to globalThis, which the format readers consume.
require('../bids-loader.js');
require('../formats/_buffers.js');
require('../formats/_labels.js');
require('../formats/_decode.js');
require('../formats/_fiff-dir.js');

export const HttpRange         = require('../formats/_http_range.js');
export const StreamingUtils    = require('../formats/_streaming.js');
export const SidecarChecks     = require('../formats/_sidecar.js');
export const MatV5             = require('../formats/_matv5.js');
export const Mat73             = require('../formats/_mat73.js');
export const BIDSRecording     = require('../bids-recording.js');
export const EEGLABReader      = require('../formats/eeglab.js');
export const EDFReader         = require('../formats/edf.js');
export const BrainVisionReader = require('../formats/brainvision.js');
export const FiffDir           = require('../formats/_fiff-dir.js');
export const FiffReader        = require('../formats/fiff.js');
export const KitReader         = require('../formats/kit.js');
// Lane H readers (BIDS-allowed formats). Dependency order: helpers first,
// then the public reader. Each module attaches its API to globalThis on
// require so other code can reach through globalThis.<Name>Reader.
// _h5-stream is the range-fetch HDF5 reader nwb.js delegates to for files
// > 200 MB; it must be required BEFORE nwb.js so the global resolver
// finds H5Stream when openStreaming runs.
export const H5Stream          = require('../formats/_h5-stream.js');
export const NwbReader         = require('../formats/nwb.js');
export const MefSegment        = require('../formats/_mef-segment.js');
export const MefRed            = require('../formats/_mef-red.js');
export const MefReader         = require('../formats/mef.js');
export const BtiConfig         = require('../formats/_bti-config.js');
export const BtiReader         = require('../formats/bti.js');
export const ItabReader        = require('../formats/itab.js');
export const KrissReader       = require('../formats/kriss.js');
