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

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.FiffDir = api;
})();
