/* ============================================================
   fiff.js — minimal MEG FIFF reader for eegdash-viewer
   ============================================================
   Reads Neuromag/Elekta MEG FIFF files (.fif) and extracts
   channel metadata and raw signal data for visualization.

   FIFF format quick reference (everything BIG-ENDIAN):

   - The file is a stream of tags starting at offset 0. Each tag
     has a 16-byte header (kind, type, size, next — all int32 BE)
     followed by `size` bytes of typed data.
   - The very first tag MUST be FIFF_FILE_ID (kind=100, type=31,
     size=20, next=0). We use this as the validity check instead
     of an ASCII magic string (real FIFF files have NO ASCII magic).
   - Hierarchical blocks are bracketed by FIFF_BLOCK_START (kind=104)
     and FIFF_BLOCK_END (kind=105); each has a single int32 in its
     data field holding the block id. Blocks may nest.
   - A `next` value of -1 marks end-of-stream (or jump-to-directory
     in fully-indexed files — we treat both as "stop").

   References:
   - MNE-Python  mne/_fiff/tag.py        (_read_tag_header, read_tag)
   - MNE-Python  mne/_fiff/constants.py  (FIFF.*, FIFFB_*, FIFFT_*)
   ============================================================ */

(function () {
  'use strict';

  const api = {};

  // FIFF block, tag, and type constants. Names mirror MNE-Python's
  // FIFF namespace so cross-referencing the spec is easy.
  const FIFF = {
    // Structural tag kinds — these are NOT block ids; they appear in
    // tag.kind directly anywhere in the stream.
    TAG_FILE_ID: 100,
    TAG_DIR_POINTER: 101,
    TAG_DIR: 102,
    TAG_FREE_LIST: 106,
    TAG_FREE_BLOCK: 107,
    TAG_NOP: 108,
    BLOCK_START: 104,
    BLOCK_END: 105,

    // Block ids (data field of BLOCK_START/BLOCK_END)
    BLOCK_MEAS: 100,
    BLOCK_MEAS_INFO: 101,
    BLOCK_RAW_DATA: 102,
    BLOCK_PROCESSING_HISTORY: 900,
    BLOCK_EVENTS: 115,
    BLOCK_PROJ: 313,
    BLOCK_PROJ_ITEM: 314,

    // Common payload tag kinds (inside meas_info / raw_data)
    TAG_NCHAN: 200,
    TAG_SFREQ: 201,
    TAG_DATA_PACK: 202,
    TAG_CH_INFO: 203,
    TAG_MEAS_DATE: 204,
    TAG_DATA_BUFFER: 300,
    TAG_DATA_SKIP: 301,
    TAG_EPOCH: 304,

    // Data types (FIFFT_*)
    TYPE_VOID: 0,
    TYPE_BYTE: 1,
    TYPE_INT16: 2,
    TYPE_INT32: 3,
    TYPE_FLOAT: 4,
    TYPE_DOUBLE: 5,
    TYPE_JULIAN: 6,
    TYPE_UINT16: 7,
    TYPE_UINT32: 8,
    TYPE_UINT64: 9,
    TYPE_STRING: 10,
    TYPE_INT64: 11,
  };

  // Safety bounds for defensive parsing of untrusted bytes.
  const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10 MB cap on a single tag's data
  const MAX_TAGS = 1 << 20;                  // hard ceiling on tag-stream walk

  // ---- public API ----------------------------------------------------------

  /**
   * Parse a FIFF (Neuromag/Elekta MEG) file's tag stream into a meas object.
   * @param {ArrayBuffer} buf - The full file as an ArrayBuffer (FIFF doesn't
   *   support random access without the directory; pass the whole file).
   * @returns {{
   *   blocks: number[],
   *   chs: Array<{ name: string, kind: number, scanno: number, range: number, cal: number }>,
   *   has_projections: boolean,
   *   meas_date: number | null,
   *   nchan: number,
   *   raw: { buffers: Array<Int16Array|Int32Array|Float32Array>, nsamp: number } | null,
   *   sfreq: number
   * }}
   * @throws {Error} if the file is shorter than 16 bytes or the first tag
   *   is not FIFF_FILE_ID (kind=100, big-endian).
   */
  api.read = function (buf) {
    if (!buf || buf.byteLength < 16) {
      throw new Error('FIFF file too small');
    }
    const view = new DataView(buf);

    // First tag MUST be FIFF_FILE_ID. This is the canonical FIFF
    // validity check — there is no ASCII magic at offset 0.
    const firstKind = view.getInt32(0, false);
    if (firstKind !== FIFF.TAG_FILE_ID) {
      throw new Error(
        `Not a valid FIFF file: expected first tag kind=${FIFF.TAG_FILE_ID} ` +
        `(FIFF_FILE_ID), got ${firstKind}`
      );
    }

    // Tag-stream walk. We maintain a block-id stack so each non-structural
    // tag can be associated with the innermost enclosing block.
    const meas = {
      blocks: [],     // every block id we entered (in order)
      nchan: 0,
      sfreq: null,
      meas_date: null,
      chs: [],
      raw: null,
      has_projections: false,
    };
    const blockStack = [];
    let inMeasInfo = false;
    let inRawData = false;
    let rawBuffers = null;

    let pos = 0;
    let tagsSeen = 0;

    while (pos + 16 <= view.byteLength) {
      if (++tagsSeen > MAX_TAGS) break;

      const tag = readTag(view, pos);
      if (!tag) break;

      // Reject obviously corrupt size before we trust it for skipping.
      if (tag.size < 0 || tag.size > MAX_BUFFER_SIZE) break;
      const dataPos = pos + 16;
      if (dataPos + tag.size > view.byteLength) break;

      if (tag.kind === FIFF.BLOCK_START) {
        // Data is a single int32 block id (size should be 4).
        const blockId = tag.size >= 4 ? view.getInt32(dataPos, false) : -1;
        blockStack.push(blockId);
        meas.blocks.push(blockId);
        if (blockId === FIFF.BLOCK_MEAS_INFO) inMeasInfo = true;
        else if (blockId === FIFF.BLOCK_RAW_DATA) {
          inRawData = true;
          rawBuffers = { buffers: [], nsamp: 0 };
        }
        else if (blockId === FIFF.BLOCK_PROJ) meas.has_projections = true;
      } else if (tag.kind === FIFF.BLOCK_END) {
        const blockId = tag.size >= 4 ? view.getInt32(dataPos, false) : -1;
        blockStack.pop();
        if (blockId === FIFF.BLOCK_MEAS_INFO) inMeasInfo = false;
        else if (blockId === FIFF.BLOCK_RAW_DATA) {
          inRawData = false;
          // Finalise raw data only if we collected anything sensible.
          if (rawBuffers && rawBuffers.buffers.length > 0) {
            meas.raw = rawBuffers;
          }
          rawBuffers = null;
        }
      } else {
        // Non-structural tag: dispatch based on the innermost block.
        if (inMeasInfo) {
          switch (tag.kind) {
            case FIFF.TAG_NCHAN:
              meas.nchan = readTagInt32(view, dataPos, tag);
              break;
            case FIFF.TAG_SFREQ:
              meas.sfreq = readTagFloat32(view, dataPos, tag);
              break;
            case FIFF.TAG_MEAS_DATE:
              meas.meas_date = readTagInt32(view, dataPos, tag);
              break;
            case FIFF.TAG_CH_INFO: {
              const ch = parseChannelInfo(view, dataPos, tag.size);
              if (ch) meas.chs.push(ch);
              break;
            }
          }
        } else if (inRawData && tag.kind === FIFF.TAG_DATA_BUFFER) {
          const buf2 = extractDataBuffer(view, dataPos, tag, meas.nchan);
          if (buf2.data) {
            rawBuffers.buffers.push(buf2.data);
            rawBuffers.nsamp += buf2.nsamp;
          }
        }
      }

      // Advance. The `next` field is normally 0 (sequential) or -1
      // (end / directory-jump). We treat any non-zero/non-positive
      // value the same way: walk sequentially. If it's -1 we stop —
      // for our use-cases (meas_info + raw_data + simple block files)
      // we never need to follow the directory backwards.
      pos = dataPos + tag.size;
      if (tag.next === -1) break;
    }

    return meas;
  };

  // ---- helpers -------------------------------------------------------------

  function readTag(view, pos) {
    if (pos + 16 > view.byteLength) return null;
    // All FIFF integers are big-endian on disk.
    return {
      kind: view.getInt32(pos, false),
      type: view.getInt32(pos + 4, false),
      size: view.getInt32(pos + 8, false),
      next: view.getInt32(pos + 12, false),
    };
  }

  function readTagInt32(view, dataPos, tag) {
    if (tag.size < 4) return null;
    return view.getInt32(dataPos, false);
  }

  function readTagFloat32(view, dataPos, tag) {
    if (tag.size < 4) return null;
    const v = view.getFloat32(dataPos, false);
    return Number.isFinite(v) ? v : null;
  }

  function parseChannelInfo(view, offset, size) {
    // ch_info structure (96 bytes in real FIFF, MNE/Neuromag layout).
    // Verified against MNE-Python's _fiff/meas_info.py _read_ch_info_member.
    //
    //   bytes 0..3   : scanno    (int32 BE)
    //   bytes 4..7   : logno     (int32 BE)
    //   bytes 8..11  : kind      (int32 BE)
    //   bytes 12..15 : range     (float32 BE)
    //   bytes 16..19 : cal       (float32 BE)
    //   bytes 20..23 : coil_type (int32 BE)
    //   bytes 24..71 : loc[12]   (float32[12] BE — 48 bytes)
    //   bytes 72..75 : unit      (int32 BE)
    //   bytes 76..79 : unit_mul  (int32 BE)
    //   bytes 80..95 : ch_name   (null-padded 16-byte string)
    //
    // The reader here only needs a stable subset (name + kind + cal +
    // range) for traces.js. If size < 96 we cannot trust the layout —
    // skip the channel.
    if (offset < 0 || size < 96 || offset + 96 > view.byteLength) return null;

    const kind = view.getInt32(offset + 8, false);
    const range = view.getFloat32(offset + 12, false);
    const cal = view.getFloat32(offset + 16, false);

    const nameBytes = new Uint8Array(view.buffer, offset + 80, 16);
    const nameEnd = nameBytes.indexOf(0);
    const nameLen = nameEnd === -1 ? 16 : nameEnd;
    let name = '';
    try {
      name = new TextDecoder('utf-8', { fatal: true })
        .decode(nameBytes.slice(0, nameLen));
    } catch {
      return null; // malformed channel name → drop
    }

    return {
      name,
      kind,
      cal: Number.isFinite(cal) ? cal : 1.0,
      range: Number.isFinite(range) ? range : 1.0,
    };
  }

  function extractDataBuffer(view, offset, tag, nchan) {
    const byteSize = tag.size;
    if (offset < 0 || byteSize <= 0 || byteSize > MAX_BUFFER_SIZE) {
      return { data: null, nsamp: 0 };
    }
    if (offset + byteSize > view.byteLength) {
      return { data: null, nsamp: 0 };
    }
    if (!Number.isInteger(nchan) || nchan <= 0) {
      return { data: null, nsamp: 0 };
    }

    // FIFF is big-endian on disk, but typed-array views (Int16Array,
    // Float32Array, …) use the host endianness. Since virtually every
    // platform we ship to is little-endian, a zero-copy typed-array
    // would silently byte-swap the samples. We materialise a converted
    // copy via DataView reads to keep the data correct.
    const bytesPerSample = (
      tag.type === FIFF.TYPE_INT16 ? 2 :
      tag.type === FIFF.TYPE_INT32 ? 4 :
      tag.type === FIFF.TYPE_FLOAT ? 4 :
      0
    );
    if (bytesPerSample === 0) return { data: null, nsamp: 0 };

    const elemCount = Math.floor(byteSize / bytesPerSample);
    const nsamp = Math.floor(elemCount / nchan);
    if (elemCount === 0) return { data: null, nsamp: 0 };

    let converted;
    if (tag.type === FIFF.TYPE_INT16) {
      converted = new Int16Array(elemCount);
      for (let i = 0; i < elemCount; i++) converted[i] = view.getInt16(offset + i * 2, false);
    } else if (tag.type === FIFF.TYPE_INT32) {
      converted = new Int32Array(elemCount);
      for (let i = 0; i < elemCount; i++) converted[i] = view.getInt32(offset + i * 4, false);
    } else {
      converted = new Float32Array(elemCount);
      for (let i = 0; i < elemCount; i++) converted[i] = view.getFloat32(offset + i * 4, false);
    }
    return { data: converted, nsamp };
  }

  // ─── Reader interface (matches edf.js / brainvision.js / eeglab.js) ────
  // viewer.js and worker.js both call `READERS[ext].open(meta)` then
  // expect `reader.n_channels`, `reader.sampling_frequency`,
  // `reader.duration_s`, `reader.n_samples`, `reader.channel_labels`,
  // and `reader.readWindow(start, n)`. FIFF traditionally loads the whole
  // file because random access requires the tag directory at the end.
  // This implementation fetches the file once, parses it via `api.read`,
  // and serves windows from the buffered raw data.

  api.open = async function (meta) {
    // The eeg_url is the file URL; HttpRange.fetchBuffer fetches the
    // full body. We don't try to range-fetch FIFF — the standard
    // implementation must walk the tag directory at the end of the
    // file, which a range request would miss without two round-trips.
    const url = meta.eeg_url || meta.url;
    if (!url) throw new Error('fiff.open: meta.eeg_url is required');
    const buf = await globalThis.HttpRange.fetchBuffer(url);
    const meas = api.read(buf);

    const channelLabels = Array.isArray(meas.chs) && meas.chs.length > 0
      ? meas.chs.map((c, i) => (c && c.name) || `Ch${i + 1}`)
      : Array.from({ length: meas.nchan || 0 }, (_, i) => `Ch${i + 1}`);

    const sfreq = meas.sfreq || 0;
    const nchan = meas.nchan || 0;
    // The parser collected FIFFB_DATA_BUFFER tags into meas.raw.buffers
    // (interleaved samples: samples[t*nchan + c] gives channel c at
    // time t within that buffer). De-interleave + apply per-channel
    // cal*range calibration to produce a channel-major Float32Array
    // array — the shape readWindow() expects. Files that are pure
    // metadata (events, projections, annotations) have no raw — open()
    // still returns a reader so the viewer can render the metadata
    // pane, but readWindow throws.
    function assembleChannels(measObj) {
      if (!measObj.raw || !Array.isArray(measObj.raw.buffers) || !measObj.raw.buffers.length) {
        return null;
      }
      const nch = measObj.nchan;
      const total = measObj.raw.nsamp || 0;
      if (nch <= 0 || total <= 0) return null;
      const cals = [];
      for (let c = 0; c < nch; c++) {
        const ch = (measObj.chs && measObj.chs[c]) || null;
        const cal = ch && Number.isFinite(ch.cal) ? ch.cal : 1;
        const range = ch && Number.isFinite(ch.range) ? ch.range : 1;
        cals.push(cal * range);
      }
      const out = new Array(nch);
      for (let c = 0; c < nch; c++) out[c] = new Float32Array(total);
      let writeIdx = 0;
      for (const buf of measObj.raw.buffers) {
        const samples = buf && typeof buf.length === 'number' ? buf : (buf && buf.data) || null;
        if (!samples || typeof samples.length !== 'number') continue;
        const samplesInBuf = Math.floor(samples.length / nch);
        for (let t = 0; t < samplesInBuf; t++) {
          const dst = writeIdx + t;
          if (dst >= total) break;
          const baseSrc = t * nch;
          for (let c = 0; c < nch; c++) {
            out[c][dst] = samples[baseSrc + c] * cals[c];
          }
        }
        writeIdx += samplesInBuf;
        if (writeIdx >= total) break;
      }
      return out;
    }

    const rawChannels = assembleChannels(meas);
    const nsamp = rawChannels && rawChannels[0] ? rawChannels[0].length : 0;
    const duration_s = sfreq > 0 ? nsamp / sfreq : 0;

    return {
      n_channels:         nchan,
      sampling_frequency: sfreq,
      duration_s,
      channel_labels:     channelLabels,
      bytes_per_sample:   4,  // float32
      n_samples:          nsamp,
      recording_start_iso: null,   // TODO: derive from meas.meas_date if present
      annotation_events:  null,    // TODO: parse FIFFB_EVENTS block

      async readWindow(start, n) {
        if (!rawChannels) {
          throw new Error('fiff: this file has no FIFFB_RAW_DATA block (events/projections/annotations only)');
        }
        const end = Math.min(start + n, nsamp);
        const slice = [];
        for (let c = 0; c < nchan; c++) {
          slice.push(rawChannels[c].subarray(start, end));
        }
        return slice;
      },
    };
  };

  // Expose reader — matches the dual-target pattern used by every other
  // formats/*.js so the module loads cleanly under both browser globals
  // and Node (where `window` is undefined and createRequire reads
  // module.exports). Without this, Node-side property/unit tests cannot
  // require this file directly.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.FiffReader = api;
})();
