/* ============================================================
   formats/_ctf-res4.js — parse the CTF MEG `.res4` binary header.

   Layout (all integers BIG-ENDIAN; doubles BE; ASCII strings
   null-padded). Verified against MNE-Python's mne/io/ctf/res4.py
   (BSD-3-clause).

   Fixed header (1844 bytes):
     0..7      "MEG41RS\0" or "MEG42RS\0" magic
     8..1681   appName / dataOrigin / dataDescription / sample-info
               text fields and timestamps (ignored by this reader)
     1682..1683  no_samples           int16 BE  (samples per trial)
     1684..1685  no_channels          int16 BE
     1686..1689  sample_rate          float32 BE
     1690..1693  epoch_time           float32 BE  (trial length, s)
     1694..1695  no_trials            int16 BE
     1696..1843  trigger / display / artifact-flag bag (ignored)

   After the fixed header:
     1844                  channel-name table: 32 bytes per channel,
                           null-padded ASCII.
     1844 + 32*nchan       sensor_res structs: 1328 bytes per channel
                           (only the first ~44 bytes carry gain/type
                           fields we use; the rest is per-coil geometry).

   sensor_res fields used by the viewer (offsets within the 1328-B struct):
     0..1   sensor_type      int16 BE  (5=MEGref, 9=MEG, 14=EEG, …)
     2..3   originalRunNum   int16 BE
     4..7   coilShape        int32 BE
     8..15  properGain       double BE
     16..23 qGain            double BE
     24..31 ioGain           double BE
     32..39 ioOffset         double BE

   Per-channel calibration applied to raw int16 samples:
     value = (sample - 0) / (properGain * qGain * ioGain)
   We collapse this to a single multiplicative `cal` so the hot
   readWindow loop is one multiply per sample. ioOffset is preserved
   separately for channels whose offset is non-zero (rare).
   ============================================================ */
(function () {
  'use strict';

  const api = {};

  const HEADER_FIXED = 1844;
  const NAME_BYTES = 32;
  const SENSOR_BYTES = 1328;

  // Hard cap on no_channels we'll accept — protects us from a
  // corrupt res4 claiming 2^15 channels and OOMing the browser.
  const MAX_CHANNELS = 4096;
  const MAX_SAMPLES_PER_TRIAL = 1 << 26;  // 64 Msamples per trial cap
  const MAX_TRIALS = 1 << 16;

  /**
   * Parse a CTF `.res4` ArrayBuffer into a structured header.
   *
   * @param {ArrayBuffer} buf - the entire .res4 file as one buffer.
   * @returns {{
   *   no_samples: number,
   *   no_channels: number,
   *   sample_rate: number,
   *   epoch_time: number,
   *   no_trials: number,
   *   channels: Array<{
   *     name: string,
   *     sensor_type: number,
   *     proper_gain: number,
   *     q_gain: number,
   *     io_gain: number,
   *     io_offset: number,
   *     cal: number,
   *   }>
   * }}
   * @throws {Error} when buf is shorter than the fixed header, the
   *   magic doesn't match, or the declared channel count exceeds
   *   MAX_CHANNELS / leaves the buffer over-/under-flown.
   */
  api.parse = function (buf) {
    if (!buf || buf.byteLength < HEADER_FIXED) {
      throw new Error(`CTF .res4 too small: need >=${HEADER_FIXED} bytes, got ${buf ? buf.byteLength : 0}`);
    }
    const v = new DataView(buf);
    const bytes = new Uint8Array(buf);

    // Magic: "MEG41RS\0" or "MEG42RS\0". Some research datasets ship
    // 4.0 / 4.2 generators — accept both. Anything else is not CTF.
    const magic = ascii(bytes, 0, 8).replace(/\0.*$/, '');
    if (!/^MEG4[12]RS$/.test(magic)) {
      throw new Error(`CTF .res4: bad magic ${JSON.stringify(magic)} — expected MEG41RS or MEG42RS`);
    }

    const no_samples  = v.getInt16(1682, false);
    const no_channels = v.getInt16(1684, false);
    const sample_rate = v.getFloat32(1686, false);
    const epoch_time  = v.getFloat32(1690, false);
    const no_trials   = v.getInt16(1694, false);

    if (no_channels <= 0 || no_channels > MAX_CHANNELS) {
      throw new Error(`CTF .res4: no_channels ${no_channels} out of range (1..${MAX_CHANNELS})`);
    }
    if (no_samples <= 0 || no_samples > MAX_SAMPLES_PER_TRIAL) {
      throw new Error(`CTF .res4: no_samples ${no_samples} out of range (1..${MAX_SAMPLES_PER_TRIAL})`);
    }
    if (no_trials <= 0 || no_trials > MAX_TRIALS) {
      throw new Error(`CTF .res4: no_trials ${no_trials} out of range (1..${MAX_TRIALS})`);
    }
    if (!(sample_rate > 0) || !Number.isFinite(sample_rate)) {
      throw new Error(`CTF .res4: sample_rate ${sample_rate} invalid`);
    }

    const expectedSize = HEADER_FIXED + no_channels * (NAME_BYTES + SENSOR_BYTES);
    if (buf.byteLength < expectedSize) {
      throw new Error(`CTF .res4: ${buf.byteLength} bytes < expected ${expectedSize} for ${no_channels} channels`);
    }

    // Channel names
    const namesOff = HEADER_FIXED;
    const channels = new Array(no_channels);
    for (let c = 0; c < no_channels; c++) {
      const off = namesOff + c * NAME_BYTES;
      channels[c] = { name: ascii(bytes, off, NAME_BYTES) };
    }

    // sensor_res structs
    const sensorOff = namesOff + no_channels * NAME_BYTES;
    for (let c = 0; c < no_channels; c++) {
      const base = sensorOff + c * SENSOR_BYTES;
      const sensor_type = v.getInt16(base + 0, false);
      const proper_gain = v.getFloat64(base + 8, false);
      const q_gain      = v.getFloat64(base + 16, false);
      const io_gain     = v.getFloat64(base + 24, false);
      const io_offset   = v.getFloat64(base + 32, false);
      // Combined per-sample calibration. Guard against a zero or
      // non-finite gain product turning every sample into Inf/NaN —
      // fall back to 1.0 with a stable display value.
      const denom = proper_gain * q_gain * io_gain;
      const cal = (Number.isFinite(denom) && denom !== 0) ? (1 / denom) : 1;
      channels[c].sensor_type = sensor_type;
      channels[c].proper_gain = proper_gain;
      channels[c].q_gain = q_gain;
      channels[c].io_gain = io_gain;
      channels[c].io_offset = Number.isFinite(io_offset) ? io_offset : 0;
      channels[c].cal = cal;
    }

    return { no_samples, no_channels, sample_rate, epoch_time, no_trials, channels };
  };

  function ascii(bytes, offset, length) {
    let s = '';
    const end = Math.min(offset + length, bytes.length);
    for (let i = offset; i < end; i++) {
      const b = bytes[i];
      if (b === 0) break;
      // Reject non-printable so we never feed garbage into the UI.
      if (b < 0x20 || b > 0x7e) continue;
      s += String.fromCharCode(b);
    }
    return s;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.CTFRes4 = api;
})();
