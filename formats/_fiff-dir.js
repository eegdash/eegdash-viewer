/* ============================================================
   formats/_fiff-dir.js — FIFF tag-directory walker.

   FIFF files conventionally include a "directory" tag near
   end-of-file: a single FIFF_DIR (kind=102) tag whose payload
   is an array of (kind, type, size, position) entries, one per
   non-directory tag in the file. The directory's absolute byte
   offset is stored in the FIFF_DIR_POINTER (kind=101) tag at
   offset 0x24 (right after the 36-byte FIFF_FILE_ID header).

   This module pulls just the directory out of an already-fetched
   tail-of-file DataView and indexes block ranges. It NEVER reads
   beyond the bytes given to it — callers range-fetch the right
   slices first. All FIFF integers are big-endian.

   References:
   - MNE-Python  mne/_fiff/open.py::_get_next_fname_and_pos
   - MNE-Python  mne/_fiff/meas_info.py::_read_dir
   ============================================================ */
(function () {
  'use strict';

  const api = {};

  // Same constants as formats/fiff.js — duplicated here so this
  // module is parseable in isolation (Stryker mutates it without
  // the parent loaded).
  const FIFF_FILE_ID     = 100;
  const FIFF_DIR_POINTER = 101;
  const FIFF_DIR         = 102;
  const FIFF_BLOCK_START = 104;
  const FIFF_BLOCK_END   = 105;
  const FIFFB_MEAS_INFO  = 101;
  const FIFFB_RAW_DATA   = 102;
  const FIFF_DATA_BUFFER = 300;

  // Validate the first tag is FIFF_FILE_ID. Then read the second
  // tag (16-byte header at offset 0x24 (= 36)) — it should be
  // FIFF_DIR_POINTER. If its 4-byte int32 BE payload is -1, the
  // file has no directory; otherwise that's the absolute byte
  // offset of the FIFF_DIR tag.
  //
  // `view` must cover at least bytes [0..55]. Throws if FILE_ID is
  // missing or unreadable.
  api.readDirPointer = function (view) {
    if (view.byteLength < 56) {
      throw new Error(`fiff-dir: view too short (${view.byteLength}B) to read FILE_ID + DIR_POINTER`);
    }
    const fileIdKind = view.getInt32(0, false);
    if (fileIdKind !== FIFF_FILE_ID) {
      throw new Error(
        `fiff-dir: first tag kind=${fileIdKind} is not FIFF_FILE_ID (${FIFF_FILE_ID})`,
      );
    }
    // FIFF_FILE_ID has size=20 — header (16) + payload (20) = 36 bytes,
    // so the next tag's header starts at offset 0x24.
    const fileIdSize = view.getInt32(8, false);
    const nextTagOff = 16 + fileIdSize;
    if (nextTagOff + 16 > view.byteLength) {
      throw new Error(`fiff-dir: file too short for DIR_POINTER at ${nextTagOff}`);
    }
    const dirPointerKind = view.getInt32(nextTagOff, false);
    if (dirPointerKind !== FIFF_DIR_POINTER) {
      // Not every file has a DIR_POINTER as the second tag — older
      // streaming writers omit it. Surface "no directory" rather than
      // throw; the caller falls back to full-file walk.
      return { hasDirectory: false, dirOffset: -1, reason: 'no DIR_POINTER tag' };
    }
    const dirPointerPayloadOff = nextTagOff + 16;
    if (dirPointerPayloadOff + 4 > view.byteLength) {
      throw new Error(`fiff-dir: DIR_POINTER payload truncated at ${dirPointerPayloadOff}`);
    }
    const dirOffset = view.getInt32(dirPointerPayloadOff, false);
    if (dirOffset === -1) {
      return { hasDirectory: false, dirOffset: -1, reason: 'DIR_POINTER payload = -1' };
    }
    if (dirOffset < 0) {
      return { hasDirectory: false, dirOffset, reason: 'negative DIR_POINTER offset' };
    }
    return { hasDirectory: true, dirOffset };
  };

  // Given a DataView whose backing buffer covers the tail of the
  // file (including the FIFF_DIR tag), parse the directory tag at
  // `absDirOffset` (absolute file offset). The view's byteOffset
  // must satisfy: view.byteOffset <= absDirOffset; we compute the
  // local offset = absDirOffset - view.byteOffset and read from
  // there. Returns `{ entries: [{kind, type, size, position}] }`.
  api.parseDirectory = function (view, absDirOffset) {
    const viewBase = view.byteOffset || 0;
    const localOff = absDirOffset - viewBase;
    if (localOff < 0 || localOff + 16 > view.byteLength) {
      throw new Error(
        `fiff-dir: dir at abs ${absDirOffset} not inside view ` +
        `(viewBase=${viewBase}, viewLen=${view.byteLength})`,
      );
    }
    // Read directory entries by indexing directly into the input view
    // at local offsets. We avoid `new DataView(view.buffer, ...)` because
    // `view.buffer` may be a tail-only ArrayBuffer (the caller's view
    // may be a Proxy with synthetic byteOffset). All reads use the
    // local offset relative to `view.byteOffset === viewBase`.
    const kind = view.getInt32(localOff + 0, false);
    if (kind !== FIFF_DIR) {
      throw new Error(`fiff-dir: tag at ${absDirOffset} kind=${kind}, expected FIFF_DIR (${FIFF_DIR})`);
    }
    const size = view.getInt32(localOff + 8, false);
    if (size < 0 || size % 16 !== 0) {
      throw new Error(`fiff-dir: bad directory size=${size} (must be multiple of 16)`);
    }
    const nEntries = size / 16;
    if (localOff + 16 + size > view.byteLength) {
      throw new Error(
        `fiff-dir: directory body (${size}B) overflows view tail ` +
        `(have ${view.byteLength - localOff - 16}B from dir header)`,
      );
    }
    const entries = new Array(nEntries);
    for (let i = 0; i < nEntries; i++) {
      const eOff = localOff + 16 + i * 16;
      entries[i] = {
        kind:     view.getInt32(eOff + 0,  false),
        type:     view.getInt32(eOff + 4,  false),
        size:     view.getInt32(eOff + 8,  false),
        position: view.getInt32(eOff + 12, false),
      };
    }
    return { entries };
  };

  // Walk directory entries in document order, tracking BLOCK_START /
  // BLOCK_END payloads to map block-id → [startTagOffset, endTagOffset].
  // For RAW_DATA we additionally enumerate the FIFF_DATA_BUFFER tags
  // inside the block — that's the buffer index readWindow needs.
  //
  // `readBlockId` is a function (entryPosition) -> blockIdInt or null.
  // For tail-of-file views the legacy form passes the DataView itself —
  // we accept either a DataView or a function for backward compat.
  //
  // When the BLOCK_START payload (4 bytes at position+16) is not
  // available, we cannot identify which block this is. The plan
  // assumes the caller has range-fetched these 4-byte spans first.
  api.indexBlocks = function (viewOrReader, entries) {
    let readBlockId;
    if (typeof viewOrReader === 'function') {
      readBlockId = viewOrReader;
    } else {
      const view = viewOrReader;
      const viewBase = view.byteOffset || 0;
      const viewEnd  = viewBase + view.byteLength;
      readBlockId = function (entryPosition) {
        const payloadAbs = entryPosition + 16;
        if (payloadAbs < viewBase || payloadAbs + 4 > viewEnd) return null;
        return view.getInt32(payloadAbs - viewBase, false);
      };
    }

    // Walk the stream of START/END/DATA_BUFFER entries.
    const stack = [];  // active block ids
    const blocks = {};   // result: { meas_info, raw_data } when found
    let currentRaw = null;

    for (const e of entries) {
      if (e.kind === FIFF_BLOCK_START) {
        const id = readBlockId(e.position);
        stack.push({ id, startTagOffset: e.position });
        if (id === FIFFB_RAW_DATA) {
          currentRaw = { startTagOffset: e.position, endTagOffset: -1, buffers: [] };
        }
      } else if (e.kind === FIFF_BLOCK_END) {
        const top = stack.pop();
        if (!top) continue;
        const id = top.id;  // pair by stack — robust if END payload is outside view
        if (id === FIFFB_MEAS_INFO) {
          blocks.meas_info = { startTagOffset: top.startTagOffset, endTagOffset: e.position };
        } else if (id === FIFFB_RAW_DATA && currentRaw) {
          currentRaw.endTagOffset = e.position;
          blocks.raw_data = currentRaw;
          currentRaw = null;
        }
      } else if (e.kind === FIFF_DATA_BUFFER && currentRaw) {
        currentRaw.buffers.push({
          headerOffset:  e.position,
          payloadOffset: e.position + 16,
          payloadSize:   e.size,
          miType:        e.type,  // 2=int16, 3=int32, 4=float32 per FIFF spec
        });
      }
    }
    return blocks;
  };

  /**
   * Build the directory by sequentially walking tag HEADERS only.
   * Each tag header is 16 bytes (kind/type/size/next, all int32 BE).
   * For BLOCK_START / BLOCK_END tags we also need 4 bytes of payload
   * to read the block id, so we always grab 20 bytes per probe.
   *
   * Range-fetches the file in CHUNK-byte slices and parses headers
   * out of each slice. When a tag's `next` field is non-zero (or 0
   * meaning "sequential"), we jump pos = pos + 16 + size — which can
   * skip multi-MB payloads in a single arithmetic step. So total
   * fetches scale with N_TAGS, not file size.
   *
   * Used when FIFF_DIR_POINTER payload is -1 (the file declares
   * "no directory") OR when DIR_POINTER is missing entirely.
   *
   * Returns the same shape as buildDirectoryFromTail: an array of
   * { kind, type, size, position } entries.
   *
   * @param {string} url
   * @param {number} totalBytes
   * @param {(start: number, end: number) => Promise<ArrayBuffer>} fetchRange
   * @param {object} [opts]
   * @param {number} [opts.chunk] - chunk size for range fetches (default 2 MB)
   * @returns {Promise<{entries: Array<{kind:number,type:number,size:number,position:number}>, blockIds: Map<number, number>}>}
   */
  api.buildDirectoryByHeaderWalk = async function (url, totalBytes, fetchRange, opts) {
    const CHUNK = (opts && opts.chunk) || 2 * 1024 * 1024;
    const HEADER_PEEK = 20;  // 16-byte tag header + 4-byte block id payload
    const entries = [];
    // For BLOCK_START / BLOCK_END entries we capture the 4-byte
    // payload (block id) inline since we already paid the fetch cost
    // for the surrounding 20 bytes. Map: tag-position → block id.
    const blockIds = new Map();
    let pos = 0;
    let bufStart = 0;
    let bufEnd = 0;
    let buf = null;
    while (pos + 16 <= totalBytes) {
      // Refill if we don't have at least HEADER_PEEK bytes ahead of pos.
      if (pos < bufStart || pos + HEADER_PEEK > bufEnd) {
        const fetchEnd = Math.min(pos + CHUNK, totalBytes) - 1;
        buf = await fetchRange(pos, fetchEnd);
        bufStart = pos;
        bufEnd = pos + buf.byteLength;
      }
      const offsetInBuf = pos - bufStart;
      if (offsetInBuf + 16 > buf.byteLength) break;  // not enough bytes for a header
      const dv = new DataView(buf, offsetInBuf, Math.min(HEADER_PEEK, buf.byteLength - offsetInBuf));
      const kind = dv.getInt32(0, false);
      const type = dv.getInt32(4, false);
      const size = dv.getInt32(8, false);
      const next = dv.getInt32(12, false);
      if (size < 0) {
        throw new Error(`fiff dir walk: bad tag size ${size} at offset ${pos}`);
      }
      entries.push({ kind, type, size, position: pos });
      // If BLOCK_START/BLOCK_END and 4-byte payload is in-buffer, cache it.
      if ((kind === FIFF_BLOCK_START || kind === FIFF_BLOCK_END) && size >= 4
          && offsetInBuf + 20 <= buf.byteLength) {
        blockIds.set(pos, dv.getInt32(16, false));
      }
      if (next === -1) break;  // explicit end-of-stream sentinel
      pos = next > 0 ? next : pos + 16 + size;
      if (pos < 0 || pos > totalBytes) break;
    }
    return { entries, blockIds };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.FiffDir = api;
})();
