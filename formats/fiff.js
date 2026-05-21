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

  // Internal constant: how many bytes from end-of-file to range-fetch
  // for the directory probe. 256 KB is well above the largest FIFF
  // directories we've observed (10-50 KB for 1-2h recordings) yet
  // small enough to load on a slow link in < 1 s.
  const FIFF_DIR_TAIL_BYTES = 256 * 1024;

  // Decode the bytes of one FIFF_DATA_BUFFER tag's payload into a
  // typed array matching the on-disk miType. This duplicates the
  // logic in extractDataBuffer (which works from a DataView over the
  // full file) for the range-based path where each call sees only
  // ONE payload's bytes.
  function decodeRawBufferBytes(payloadBuf, miType, expectedElemCount) {
    const elemBytes = (miType === FIFF.TYPE_INT16 ? 2 : 4);
    const elemCount = Math.floor(payloadBuf.byteLength / elemBytes);
    const n = Math.min(elemCount, expectedElemCount);
    const view = new DataView(payloadBuf);
    if (miType === FIFF.TYPE_INT16) {
      const out = new Int16Array(n);
      for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, false);
      return out;
    }
    if (miType === FIFF.TYPE_INT32) {
      const out = new Int32Array(n);
      for (let i = 0; i < n; i++) out[i] = view.getInt32(i * 4, false);
      return out;
    }
    // type=4 float32 (most common) or anything else → treat as float32
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = view.getFloat32(i * 4, false);
    return out;
  }

  api.open = async function (meta) {
    const url = meta.eeg_url || meta.url;
    if (!url) throw new Error('fiff.open: meta.eeg_url is required');

    // Probe total file length so we can compute the tail-range to fetch.
    const totalBytes = await globalThis.HttpRange.probeLength(url);
    if (totalBytes < 36) {
      throw new Error(`fiff: file too small (${totalBytes}B) — need at least 36B for header`);
    }

    // Range-fetch the tail to find FIFF_DIR (the directory is the last
    // tag in well-formed files; tail=256KB covers typical 10-50KB dirs
    // plus the FIFF_FILE_ID + FIFF_DIR_POINTER preamble overlap, which
    // we re-fetch separately because for huge files the head won't be
    // in the tail slice).
    const tailStart = Math.max(0, totalBytes - FIFF_DIR_TAIL_BYTES);
    const tailBuf   = await globalThis.HttpRange.rangeFetch(
      url, tailStart, totalBytes - 1, totalBytes - tailStart,
    );
    // Build a "shifted" view object FiffDir can use. FiffDir expects
    // view.byteOffset to be the absolute file offset of the view's
    // first byte. ArrayBuffer-backed DataView always has byteOffset=0,
    // so we use a Proxy that overrides byteOffset while delegating
    // every other property (getInt32 etc.) to the underlying DataView.
    const tailDV = new DataView(tailBuf);
    const shiftedView = new Proxy(tailDV, {
      get(target, prop) {
        if (prop === 'byteOffset') return tailStart;
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });

    // Range-fetch the header bytes (first 64 B) so we can read
    // FIFF_FILE_ID + FIFF_DIR_POINTER. For files smaller than the tail
    // size this is already inside tailBuf; for huge files it's not.
    let headBuf;
    if (tailStart === 0) {
      headBuf = tailBuf;
    } else {
      headBuf = await globalThis.HttpRange.rangeFetch(url, 0, 63, 64);
    }
    const headView = new DataView(headBuf, 0, headBuf.byteLength);

    const dirInfo = globalThis.FiffDir.readDirPointer(headView);

    if (!dirInfo.hasDirectory) {
      // No directory → fall back to the legacy whole-file path.
      // Cap at 200 MB so we don't OOM the page; raise/lower if needed.
      const FALLBACK_CAP = 200 * 1024 * 1024;
      if (totalBytes > FALLBACK_CAP) {
        throw new Error(
          `fiff: file is ${(totalBytes / 1024 / 1024).toFixed(0)} MB and has no ` +
          `tag directory — cannot stream. Re-export with a modern FIFF writer.`,
        );
      }
      const wholeBuf = await globalThis.HttpRange.fetchBuffer(url);
      const meas    = api.read(wholeBuf);
      // Plan E calibration-detection check: preserve the early-exit for
      // metadata-only files (events/projections/calibration only).
      if (meas.nchan === 0 && meas.raw === null) {
        throw new Error(
          'FIFF: this file is a calibration/empty-block file — no raw signal to display. ' +
          '(MEAS_INFO has no channels and no FIFFB_RAW_DATA block was found.)'
        );
      }
      return buildReaderFromMeas(meas);
    }

    // Parse directory entries → block ranges.
    const dir    = globalThis.FiffDir.parseDirectory(shiftedView, dirInfo.dirOffset);
    // To identify block IDs we need the 4-byte payload at each
    // BLOCK_START tag's position+16. For huge files those positions
    // are far from the tail; pre-fetch them in a small batch so
    // indexBlocks can resolve each START's id.
    const blockIdCache = new Map();
    const startEntries = dir.entries.filter(e => e.kind === 104 /*BLOCK_START*/);
    for (const e of startEntries) {
      const payloadAbs = e.position + 16;
      // Check if the payload is already inside our tail or head buf.
      if (payloadAbs >= tailStart && payloadAbs + 4 <= totalBytes) {
        blockIdCache.set(e.position, tailDV.getInt32(payloadAbs - tailStart, false));
      } else if (payloadAbs + 4 <= 64 && headBuf) {
        blockIdCache.set(e.position, headView.getInt32(payloadAbs, false));
      } else {
        // Fetch the 4-byte payload directly. These are rare (1-4 per
        // file typically), so we don't worry about coalescing.
        const idBuf = await globalThis.HttpRange.rangeFetch(url, payloadAbs, payloadAbs + 3, 4);
        const idDV  = new DataView(idBuf);
        blockIdCache.set(e.position, idDV.getInt32(0, false));
      }
    }
    const readBlockId = (entryPosition) => {
      const v = blockIdCache.get(entryPosition);
      return v === undefined ? null : v;
    };
    const blocks = globalThis.FiffDir.indexBlocks(readBlockId, dir.entries);
    if (!blocks.meas_info) {
      throw new Error('fiff: directory has no FIFFB_MEAS_INFO block — cannot open');
    }

    // Range-fetch the MEAS_INFO bytes: [meas_info.startTagOffset,
    // meas_info.endTagOffset + 19]. End offset is the BLOCK_END tag's
    // header offset; we need 16B (header) + 4B (payload) = 20B more.
    const measStart = blocks.meas_info.startTagOffset;
    const measEnd   = blocks.meas_info.endTagOffset + 19;
    const measLen   = measEnd - measStart + 1;
    const measBuf   = await globalThis.HttpRange.rangeFetch(url, measStart, measEnd, measLen);
    // Parse via the existing api.read but prepend a FIFF_FILE_ID so
    // the validity check passes — easier than parameterising api.read.
    const wrappedBuf = wrapMeasInfo(measBuf);
    const meas       = api.read(wrappedBuf);

    // Calibration / events-only FIFF: no channels in MEAS_INFO and
    // no raw data block — surface the same clean error the legacy
    // path produced (Plan E's calibration check).
    if (meas.nchan === 0 && meas.raw === null && !blocks.raw_data) {
      throw new Error(
        'FIFF: this file is a calibration/empty-block file — no raw signal to display. ' +
        '(MEAS_INFO has no channels and no FIFFB_RAW_DATA block was found.)'
      );
    }

    // If no raw_data block, return a meta-only reader (readWindow throws).
    if (!blocks.raw_data || blocks.raw_data.buffers.length === 0) {
      return buildReaderFromMeas(meas);
    }

    // Build per-buffer sample index: bytesPerSample × nchan determines
    // samples-per-buffer. Cumulative samples give us a binary-search
    // index for readWindow.
    const nchan = meas.nchan;
    const bufIndex = [];
    let cumulative = 0;
    for (const b of blocks.raw_data.buffers) {
      const bytesPerSample = (b.miType === FIFF.TYPE_INT16 ? 2 : 4);
      const elemCount = Math.floor(b.payloadSize / bytesPerSample);
      const samplesInBuf = nchan > 0 ? Math.floor(elemCount / nchan) : 0;
      bufIndex.push({
        payloadOffset: b.payloadOffset,
        payloadSize:   b.payloadSize,
        miType:        b.miType,
        bytesPerSample,
        samplesInBuf,
        cumStart:      cumulative,
      });
      cumulative += samplesInBuf;
    }
    const totalSamples = cumulative;

    return buildRangeReader({ meta, url, meas, bufIndex, totalSamples });
  };

  // Wrap a meas_info byte range in a FIFF_FILE_ID prefix so it passes
  // api.read's validity check.
  function wrapMeasInfo(measBuf) {
    const prefix = new ArrayBuffer(36);  // FILE_ID header (16) + payload (20)
    const dv = new DataView(prefix);
    dv.setInt32(0,  FIFF.TAG_FILE_ID, false);  // 100
    dv.setInt32(4,  31,  false);
    dv.setInt32(8,  20,  false);  // size=20
    dv.setInt32(12, 0,   false);
    const out = new Uint8Array(prefix.byteLength + measBuf.byteLength);
    out.set(new Uint8Array(prefix), 0);
    out.set(new Uint8Array(measBuf), prefix.byteLength);
    return out.buffer;
  }

  // Used by both the directory and no-directory paths to assemble the
  // reader object from a fully-walked meas. When meas.raw is null we
  // still return a reader (readWindow throws); when it is present we
  // serve windows from the in-memory channel arrays — same as the
  // pre-refactor behaviour.
  function buildReaderFromMeas(meas) {
    const channelLabels = Array.isArray(meas.chs) && meas.chs.length > 0
      ? meas.chs.map((c, i) => (c && c.name) || `Ch${i + 1}`)
      : Array.from({ length: meas.nchan || 0 }, (_, i) => `Ch${i + 1}`);

    let rawChannels = null;
    if (meas.raw && Array.isArray(meas.raw.buffers) && meas.raw.buffers.length > 0) {
      rawChannels = assembleFromMeas(meas);
    }
    const nsamp     = rawChannels && rawChannels[0] ? rawChannels[0].length : 0;
    const sfreq     = meas.sfreq || 0;
    const duration  = sfreq > 0 ? nsamp / sfreq : 0;
    const nchan     = meas.nchan || 0;
    return {
      n_channels:         nchan,
      sampling_frequency: sfreq,
      duration_s:         duration,
      channel_labels:     channelLabels,
      bytes_per_sample:   4,
      n_samples:          nsamp,
      recording_start_iso: null,
      annotation_events:   null,
      streaming:          false,
      async readWindow(start, n) {
        if (!rawChannels) {
          throw new Error('fiff: this file has no FIFFB_RAW_DATA block (events/projections/annotations only)');
        }
        const end = Math.min(start + n, nsamp);
        const slice = [];
        for (let c = 0; c < nchan; c++) slice.push(rawChannels[c].subarray(start, end));
        return slice;
      },
    };
  }

  // De-interleave + calibrate, identical math to the pre-refactor
  // assembleChannels (kept available as a helper for the no-directory
  // fallback path).
  function assembleFromMeas(measObj) {
    const nch  = measObj.nchan;
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
        for (let c = 0; c < nch; c++) out[c][dst] = samples[baseSrc + c] * cals[c];
      }
      writeIdx += samplesInBuf;
      if (writeIdx >= total) break;
    }
    return out;
  }

  // Range-based reader: opens with no raw data in memory; readWindow
  // range-fetches the bytes for the requested window from the
  // pre-built buffer index. See Task 3 for the readWindow body.
  function buildRangeReader(ctx) {
    const { meta, url, meas, bufIndex, totalSamples } = ctx;
    const nchan = meas.nchan;
    const sfreq = meas.sfreq;
    const duration = sfreq > 0 ? totalSamples / sfreq : 0;
    const channelLabels = (meas.chs || []).map((c, i) => (c && c.name) || `Ch${i + 1}`);
    while (channelLabels.length < nchan) channelLabels.push(`Ch${channelLabels.length + 1}`);

    // Per-channel calibration coefficient.
    const cals = [];
    for (let c = 0; c < nchan; c++) {
      const ch = meas.chs && meas.chs[c];
      const cal = ch && Number.isFinite(ch.cal) ? ch.cal : 1;
      const range = ch && Number.isFinite(ch.range) ? ch.range : 1;
      cals.push(cal * range);
    }

    return {
      n_channels:         nchan,
      sampling_frequency: sfreq,
      duration_s:         duration,
      channel_labels:     channelLabels,
      bytes_per_sample:   4,
      n_samples:          totalSamples,
      recording_start_iso: null,
      annotation_events:   null,
      streaming:          true,
      // Implemented in Task 3.
      readWindow: async (start, n, opts) =>
        readWindowRange(url, nchan, cals, bufIndex, totalSamples, start, n, opts),
      // Implemented in Task 4.
      readWindowStreaming: (start, n, opts) =>
        readWindowRangeStreaming(url, nchan, cals, bufIndex, totalSamples, start, n, opts),
    };
  }

  // Binary-search the buffer index for the first buffer covering
  // `targetSample`. bufIndex is ordered by ascending cumStart so a
  // standard lower_bound on cumStart + samplesInBuf works.
  function findBufferForSample(bufIndex, targetSample) {
    let lo = 0, hi = bufIndex.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const b = bufIndex[mid];
      const bufEnd = b.cumStart + b.samplesInBuf;
      if (targetSample < b.cumStart) hi = mid - 1;
      else if (targetSample >= bufEnd) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  async function readWindowRange(url, nchan, cals, bufIndex, totalSamples, startReq, nReq, opts) {
    const start = Math.max(0, startReq);
    if (start >= totalSamples || nReq <= 0) {
      const out = new Array(nchan);
      for (let c = 0; c < nchan; c++) out[c] = new Float32Array(0);
      return out;
    }
    const end = Math.min(start + nReq, totalSamples);
    const nWin = end - start;
    const firstBufIdx = findBufferForSample(bufIndex, start);
    if (firstBufIdx === -1) throw new Error(`fiff: no buffer covers sample ${start}`);

    // Output allocation — one Float32Array per channel.
    const out = new Array(nchan);
    for (let c = 0; c < nchan; c++) out[c] = new Float32Array(nWin);

    // Walk buffers in order, range-fetching each that overlaps the window.
    // For v1 we fetch the entire buffer's payload (typical buffer is
    // ~64 KB, well under the 256 KB tile threshold so it's a single
    // single-tile fetch).
    let writeOff = 0;
    for (let i = firstBufIdx; i < bufIndex.length && writeOff < nWin; i++) {
      const b = bufIndex[i];
      const bufStartSample = b.cumStart;
      const bufEndSample   = b.cumStart + b.samplesInBuf;
      const sliceStart = Math.max(start, bufStartSample) - bufStartSample;  // local sample index
      const sliceEnd   = Math.min(end,   bufEndSample)   - bufStartSample;
      const nLocal = sliceEnd - sliceStart;
      if (nLocal <= 0) continue;

      // Range-fetch the whole buffer payload (v1; could narrow to
      // [sliceStart*nchan*bps, sliceEnd*nchan*bps] for huge buffers
      // but that's an optimisation for later).
      const payloadStart = b.payloadOffset;
      const payloadEnd   = b.payloadOffset + b.payloadSize - 1;
      const fetched = await globalThis.HttpRange.rangeFetch(
        url, payloadStart, payloadEnd, b.payloadSize, opts,
      );
      const expectedElemCount = b.samplesInBuf * nchan;
      const decoded = decodeRawBufferBytes(fetched, b.miType, expectedElemCount);
      // De-interleave + calibrate the slice we want.
      for (let t = 0; t < nLocal; t++) {
        const src = (sliceStart + t) * nchan;
        const dst = writeOff + t;
        for (let c = 0; c < nchan; c++) {
          out[c][dst] = decoded[src + c] * cals[c];
        }
      }
      writeOff += nLocal;
    }
    return out;
  }

  // Streaming variant: yields one chunk per data buffer that overlaps
  // the window. Each chunk has shape { firstSampleIdx, lastSampleIdx,
  // channels } where channels is an Array<Float32Array> of length
  // nchan, one entry per channel, each of length nLocal.
  async function* readWindowRangeStreaming(url, nchan, cals, bufIndex, totalSamples, startReq, nReq, opts) {
    const start = Math.max(0, startReq);
    if (start >= totalSamples || nReq <= 0) return;
    const end = Math.min(start + nReq, totalSamples);
    const firstBufIdx = findBufferForSample(bufIndex, start);
    if (firstBufIdx === -1) return;

    for (let i = firstBufIdx; i < bufIndex.length; i++) {
      const b = bufIndex[i];
      const bufStartSample = b.cumStart;
      const bufEndSample   = b.cumStart + b.samplesInBuf;
      if (bufStartSample >= end) break;
      const sliceStart = Math.max(start, bufStartSample) - bufStartSample;
      const sliceEnd   = Math.min(end,   bufEndSample)   - bufStartSample;
      const nLocal = sliceEnd - sliceStart;
      if (nLocal <= 0) continue;

      const fetched = await globalThis.HttpRange.rangeFetch(
        url, b.payloadOffset, b.payloadOffset + b.payloadSize - 1, b.payloadSize, opts,
      );
      const decoded = decodeRawBufferBytes(fetched, b.miType, b.samplesInBuf * nchan);
      const channels = new Array(nchan);
      for (let c = 0; c < nchan; c++) channels[c] = new Float32Array(nLocal);
      for (let t = 0; t < nLocal; t++) {
        const src = (sliceStart + t) * nchan;
        for (let c = 0; c < nchan; c++) channels[c][t] = decoded[src + c] * cals[c];
      }
      const firstSampleIdx = bufStartSample + sliceStart;
      const lastSampleIdx  = firstSampleIdx + nLocal - 1;
      yield { firstSampleIdx, lastSampleIdx, channels };
    }
  }

  // Expose reader — matches the dual-target pattern used by every other
  // formats/*.js so the module loads cleanly under both browser globals
  // and Node (where `window` is undefined and createRequire reads
  // module.exports). Without this, Node-side property/unit tests cannot
  // require this file directly.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.FiffReader = api;
})();
