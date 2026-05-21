// Ambient declarations for the format-reader globals attached to
// globalThis by formats/_*.js helpers. These files are loaded as
// classic scripts in the browser and expose objects under fixed
// names; tsc --checkJs needs to know about them.
//
// All types are intentionally `any` — these are runtime-checked
// helper bundles and we don't want JSDoc maintenance overhead here.
// The goal of tsc on formats/ is to catch the public-API entry-point
// drift, not to type the internal helpers.

declare const HttpRange: any;
declare const ChannelBuffers: any;
declare const BIDSRecording: any;
declare const MatV5: any;
declare const SidecarChecks: any;
declare const StreamingUtils: any;

// Some call sites reach through globalThis explicitly.
declare global {
  // eslint-disable-next-line no-var
  var HttpRange: any;
  // eslint-disable-next-line no-var
  var ChannelBuffers: any;
  // eslint-disable-next-line no-var
  var BIDSRecording: any;
  // eslint-disable-next-line no-var
  var MatV5: any;
  // eslint-disable-next-line no-var
  var SidecarChecks: any;
  // eslint-disable-next-line no-var
  var StreamingUtils: any;
}

export {};
