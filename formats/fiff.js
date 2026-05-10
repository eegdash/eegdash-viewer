/* ============================================================
   fiff.js — minimal MEG FIFF reader for eegdash-viewer
   ============================================================
   Reads Neuromag/Elekta MEG FIFF files (.fif) and extracts
   channel metadata and raw signal data for visualization.

   FIFF Format Reference:
   - Blocks: meas (100), meas_info (101), raw_data (102)
   - Tags are hierarchical with kind (upper 16 bits) and type (lower 16 bits)
   ============================================================ */

(function () {
  'use strict';

  const api = {};

  // FIFF block and tag constants
  const FIFF = {
    // Blocks
    BLOCK_MEAS: 100,
    BLOCK_MEAS_INFO: 101,
    BLOCK_RAW_DATA: 102,
    BLOCK_EVENTS: 115,

    // Tags (upper 16 bits = block kind)
    TAG_EPOCH: 304,
    TAG_NCHAN: 200,
    TAG_SFREQ: 201,
    TAG_MEAS_DATE: 204,
    TAG_CH_INFO: 203,
    TAG_DATA_BUFFER: 300,
    TAG_DATA_SKIP: 301,
    TAG_CH_POS: 255,
    TAG_CH_KIND: 252,
    TAG_CH_CAL: 254,
    TAG_CH_NAME: 256,
    TAG_CH_UNIT: 259,
    TAG_DEVICE_INFO: 124,

    // Data types
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

  // ---- FIFF file reading ----
  const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10 MB safety limit
  api.read = function (buf) {
    if (buf.byteLength < 12) {
      throw new Error('FIFF file too small');
    }

    const view = new DataView(buf);
    let pos = 0;

    // Check magic bytes
    const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
    if (magic !== 'FIFF') {
      throw new Error('Not a valid FIFF file');
    }
    pos = 4;

    // Skip endian marker and node ID (8 bytes)
    pos += 8;

    // Read directory: array of tag records (16 bytes each)
    const dir = [];
    while (pos + 16 <= view.byteLength) {
      const tag = readTag(view, pos);
      if (!tag) break;
      dir.push(tag);
      pos += 16;
    }

    // Extract measurement info and data from directory
    const meas = {};

    // Find and parse meas_info block
    const measInfoIdx = findBlockStart(dir, FIFF.BLOCK_MEAS_INFO);
    if (measInfoIdx >= 0) {
      Object.assign(meas, parseMeasInfo(view, dir, measInfoIdx));
    }

    // Find and parse raw_data block
    const rawDataIdx = findBlockStart(dir, FIFF.BLOCK_RAW_DATA);
    if (rawDataIdx >= 0) {
      meas.raw = parseRawData(view, dir, rawDataIdx, meas.sfreq, meas.nchan);
    }

    return meas;
  };

  function readTag(view, pos) {
    if (pos + 16 > view.byteLength) return null;

    // Tag structure: kind (4), type (4), size (4), next (4)
    const kind = view.getInt32(pos, true); // little-endian
    const type = view.getInt32(pos + 4, true);
    const size = view.getInt32(pos + 8, true);
    const next = view.getInt32(pos + 12, true);

    return { kind, type, size, next };
  }

  function findBlockStart(dir, blockKind) {
    for (let i = 0; i < dir.length; i++) {
      if ((dir[i].kind >> 16) === blockKind) {
        return i;
      }
    }
    return -1;
  }

  function parseMeasInfo(view, dir, startIdx) {
    const meas = {};

    for (let i = startIdx; i < dir.length; i++) {
      const tag = dir[i];
      const blockKind = tag.kind >> 16;
      const tagKind = tag.kind & 0xFFFF;

      // End of meas_info block
      if (blockKind !== FIFF.BLOCK_MEAS_INFO && blockKind > 0) break;

      switch (tagKind) {
        case FIFF.TAG_NCHAN:
          meas.nchan = getTagValue(view, tag);
          break;
        case FIFF.TAG_SFREQ:
          meas.sfreq = getTagValue(view, tag);
          break;
        case FIFF.TAG_MEAS_DATE:
          meas.meas_date = getTagValue(view, tag);
          break;
        case FIFF.TAG_CH_INFO:
          if (!meas.chs) meas.chs = [];
          const ch = parseChannelInfo(view, tag);
          if (ch) meas.chs.push(ch);
          break;
      }
    }

    return meas;
  }

  function parseChannelInfo(view, tag) {
    // ch_info structure: name (16 bytes), kind, cal, range
    const offset = tag.next;
    if (offset < 0 || offset + 80 > view.byteLength) return null;

    // Extract name (null-terminated string, max 16 bytes)
    const nameBytes = new Uint8Array(view.buffer, offset, 16);
    const nameEnd = nameBytes.indexOf(0);

    // Handle missing null terminator
    const nameLen = nameEnd === -1 ? 16 : nameEnd;
    let name = '';
    try {
      name = new TextDecoder('utf-8', {fatal: true})
        .decode(nameBytes.slice(0, nameLen));
    } catch {
      return null; // Skip malformed channel name
    }

    // Kind at offset 16 (int32)
    const kind = view.getInt32(offset + 16, true);
    const cal = view.getFloat32(offset + 20, true);
    const range = view.getFloat32(offset + 24, true);

    return {
      name,
      kind,
      cal: Number.isFinite(cal) ? cal : 1.0,
      range: Number.isFinite(range) ? range : 1.0,
    };
  }

  function parseRawData(view, dir, startIdx, sfreq, nchan) {
    const data = {
      buffers: [],
      nsamp: 0,
    };

    // Validate critical metadata
    if (!Number.isFinite(sfreq) || sfreq <= 0 || !Number.isInteger(nchan) || nchan <= 0) {
      return data;
    }

    for (let i = startIdx; i < dir.length; i++) {
      const tag = dir[i];
      const blockKind = tag.kind >> 16;

      // End of raw_data block
      if (blockKind !== FIFF.BLOCK_RAW_DATA && blockKind > 0) break;

      const tagKind = tag.kind & 0xFFFF;
      if (tagKind === FIFF.TAG_DATA_BUFFER && tag.next >= 0) {
        const buffer = extractDataBuffer(view, tag, nchan);
        if (buffer.data) {
          data.buffers.push(buffer.data);
          data.nsamp += buffer.nsamp;
        }
      }
    }

    return data;
  }

  function extractDataBuffer(view, tag, nchan) {
    const dataType = tag.type;
    const offset = tag.next;
    const byteSize = tag.size;

    // Validate offset and size
    if (offset < 0 || byteSize <= 0 || byteSize > MAX_BUFFER_SIZE) {
      return { data: null, nsamp: 0 };
    }

    const endOffset = offset + byteSize;
    if (endOffset < 0 || endOffset > view.byteLength) {
      return { data: null, nsamp: 0 };
    }

    const data = new Uint8Array(view.buffer, offset, byteSize);
    let nsamp = 0;
    let converted = null;

    // Convert based on data type with alignment checks
    switch (dataType) {
      case FIFF.TYPE_INT16: {
        const alignment = 2;
        if (data.byteOffset % alignment !== 0) {
          return { data: null, nsamp: 0 };
        }
        const elemCount = Math.floor(data.byteLength / alignment);
        converted = new Int16Array(data.buffer, data.byteOffset, elemCount);
        nsamp = Math.floor(elemCount / nchan);
        break;
      }
      case FIFF.TYPE_INT32: {
        const alignment = 4;
        if (data.byteOffset % alignment !== 0) {
          return { data: null, nsamp: 0 };
        }
        const elemCount = Math.floor(data.byteLength / alignment);
        converted = new Int32Array(data.buffer, data.byteOffset, elemCount);
        nsamp = Math.floor(elemCount / nchan);
        break;
      }
      case FIFF.TYPE_FLOAT: {
        const alignment = 4;
        if (data.byteOffset % alignment !== 0) {
          return { data: null, nsamp: 0 };
        }
        const elemCount = Math.floor(data.byteLength / alignment);
        converted = new Float32Array(data.buffer, data.byteOffset, elemCount);
        nsamp = Math.floor(elemCount / nchan);
        break;
      }
    }

    return { data: converted, nsamp };
  }

  function getTagValue(view, tag) {
    const offset = tag.next;
    if (offset < 0) return null;

    switch (tag.type) {
      case FIFF.TYPE_INT32:
        return view.getInt32(offset, true);
      case FIFF.TYPE_FLOAT:
        return view.getFloat32(offset, true);
      case FIFF.TYPE_DOUBLE:
        return view.getFloat64(offset, true);
      case FIFF.TYPE_STRING: {
        try {
          const len = Math.min(tag.size, 256);
          return new TextDecoder('utf-8', {fatal: true})
            .decode(new Uint8Array(view.buffer, offset, len))
            .split('\0')[0];
        } catch {
          return null;
        }
      }
      default:
        return null;
    }
  }

  // Expose reader
  window.FiffReader = api;
})();
