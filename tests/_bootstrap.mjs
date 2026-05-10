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

export const HttpRange         = require('../formats/_http_range.js');
export const StreamingUtils    = require('../formats/_streaming.js');
export const SidecarChecks     = require('../formats/_sidecar.js');
export const MatV5             = require('../formats/_matv5.js');
export const BIDSRecording     = require('../bids-recording.js');
export const EEGLABReader      = require('../formats/eeglab.js');
export const EDFReader         = require('../formats/edf.js');
export const BrainVisionReader = require('../formats/brainvision.js');
