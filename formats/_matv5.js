/* ============================================================
   formats/_matv5.js — minimal MATLAB v5 / v6 .mat reader.
   Built for one job: extract the top-level numeric matrices an
   inline-data EEGLAB .set carries (`data`, `srate`, `nbchan`,
   `pnts`, optionally wrapped in a struct named `EEG`). Anything
   beyond that — sparse, cell arrays, complex, sub-systems, MAT
   v7.3 (HDF5) — is out of scope and intentionally rejected.

   Spec: https://www.mathworks.com/help/pdf_doc/pdf_doc/matfile_format.pdf

   File layout:
     [128-byte header]
       bytes 0..115: text description (ignored)
       bytes 116..123: subsystem offset (ignored — we don't follow it)
       bytes 124..125: version uint16 (must be 0x0100 for v5)
       bytes 126..127: endian uint16 (0x4D49 = 'IM' = little, 0x4949 = big)
     [data elements, each]:
       small format: u16 nbytes (>0) | u16 type | payload (≤ 4 bytes)
       long  format: u32 type        | u32 nbytes | payload, padded to 8 bytes

   Element types we care about:
     1 INT8 / 2 UINT8 / 3 INT16 / 4 UINT16 /
     5 INT32 / 6 UINT32 / 7 SINGLE / 9 DOUBLE
     14 MATRIX     — the only top-level wrapper for named variables
     15 COMPRESSED — zlib-deflated payload that decompresses to one MATRIX

   miMATRIX payload (sub-elements, in order):
     1. Array Flags  (UINT32 pair: low byte of first u32 = mxClass)
     2. Dimensions   (INT32 array, ndims entries)
     3. Array Name   (INT8 array, padded — the variable name)
     4. Real Data    (numeric type matching mxClass; column-major)
     [5. Imaginary Data — if complex flag set; rejected]

   For mxStruct (class 2), sub-elements 4..N are:
     4. Field Name Length (INT32, 1 entry — max field name length)
     5. Field Names       (INT8, nfields × maxLen, ASCII padded)
     6..6+nfields-1.      Each field as a nested miMATRIX, in order.

   Returned variable shape (one entry per top-level / struct field):
     { class, dims, data, name }
       class — 'int8'|'uint8'|'int16'|'uint16'|'int32'|'uint32'|
               'single'|'double'|'char'|'struct'
       dims  — number[]
       data  — TypedArray (numeric), string (char), or Map<string, Var> (struct)
   ============================================================ */
(function () {
  'use strict';

  const api = {};

  // miType → bytes per scalar. 0 = variable / complex (we skip).
  const TYPE_BYTES = {
    1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 4, 9: 8, 12: 8, 13: 8,
    14: 0, 15: 0, 16: 1, 17: 2, 18: 4,
  };
  const TYPE_NAME = {
    1: 'int8', 2: 'uint8', 3: 'int16', 4: 'uint16', 5: 'int32', 6: 'uint32',
    7: 'single', 9: 'double', 12: 'int64', 13: 'uint64',
    14: 'matrix', 15: 'compressed', 16: 'utf8', 17: 'utf16', 18: 'utf32',
  };

  // mxClass → preferred TypedArray ctor + miType.
  const CLASS_INFO = {
    6:  { name: 'double', ctor: Float64Array, miType: 9  },
    7:  { name: 'single', ctor: Float32Array, miType: 7  },
    8:  { name: 'int8',   ctor: Int8Array,    miType: 1  },
    9:  { name: 'uint8',  ctor: Uint8Array,   miType: 2  },
    10: { name: 'int16',  ctor: Int16Array,   miType: 3  },
    11: { name: 'uint16', ctor: Uint16Array,  miType: 4  },
    12: { name: 'int32',  ctor: Int32Array,   miType: 5  },
    13: { name: 'uint32', ctor: Uint32Array,  miType: 6  },
  };

  // Chops a flat ArrayBuffer (or Uint8Array view) into MAT v5 elements,
  // honouring the small/long element format and 8-byte padding.
  // Returns an iterator of { miType, payload: Uint8Array, payloadOffset }.
  function* iterElements(view, baseOffset, endOffset) {
    let off = baseOffset;
    while (off + 8 <= endOffset) {
      const tag = view.getUint32(off, true);
      const smallNbytes = (tag >>> 16) & 0xffff;
      const smallType = tag & 0xffff;
      let miType, nbytes, payloadStart;
      if (smallNbytes !== 0 && smallNbytes <= 4) {
        miType = smallType;
        nbytes = smallNbytes;
        payloadStart = off + 4;
      } else {
        miType = tag;
        nbytes = view.getUint32(off + 4, true);
        payloadStart = off + 8;
      }
      if (payloadStart + nbytes > endOffset) {
        throw new Error(`MAT element overruns container at ${off}: claims ${nbytes}B, only ${endOffset - payloadStart}B left`);
      }
      yield {
        miType,
        payloadOffset: payloadStart,
        // Slice via subarray so the payload aliases the same backing
        // buffer — no copy, fast for big numeric blocks.
        payload: new Uint8Array(view.buffer, view.byteOffset + payloadStart, nbytes),
      };
      // 8-byte alignment except for small-format elements (tag-included
      // length is already 8 bytes, no extra padding needed there).
      const consumed = (payloadStart - off) + nbytes;
      const padded = payloadStart === off + 4 ? 8 : 8 * Math.ceil(nbytes / 8);
      off = (payloadStart === off + 4)
        ? off + padded
        : payloadStart + padded;
    }
  }

  // Coerces a numeric payload of `miType` into an instance of the
  // class's preferred typed array. The on-disk type may differ from
  // the array's declared class (e.g. an int32 dims array stored as
  // miINT32 is fine, but EEGLAB sometimes saves an mxDOUBLE with a
  // miSINGLE payload to halve file size — we honour the on-disk type).
  function payloadAsTypedArray(elem) {
    const { miType, payload } = elem;
    const elemBytes = TYPE_BYTES[miType];
    if (!elemBytes) {
      throw new Error(`unsupported numeric miType ${miType} (${TYPE_NAME[miType] || '?'})`);
    }
    const length = payload.length / elemBytes;
    if (!Number.isInteger(length)) {
      throw new Error(`numeric payload length ${payload.length} not a multiple of ${elemBytes}B (miType ${miType})`);
    }
    // ArrayBuffer.isView rejects unaligned subarrays for Float64Array
    // construction — copy if the source isn't aligned to elemBytes.
    const aligned = (payload.byteOffset % elemBytes) === 0;
    if (aligned) {
      return makeTyped(miType, payload.buffer, payload.byteOffset, length);
    }
    const copy = new Uint8Array(payload.length);
    copy.set(payload);
    return makeTyped(miType, copy.buffer, 0, length);
  }

  function makeTyped(miType, buf, off, length) {
    switch (miType) {
      case 1:  return new Int8Array   (buf, off, length);
      case 2:  return new Uint8Array  (buf, off, length);
      case 3:  return new Int16Array  (buf, off, length);
      case 4:  return new Uint16Array (buf, off, length);
      case 5:  return new Int32Array  (buf, off, length);
      case 6:  return new Uint32Array (buf, off, length);
      case 7:  return new Float32Array(buf, off, length);
      case 9:  return new Float64Array(buf, off, length);
      case 16: return new Uint8Array  (buf, off, length);
      default: throw new Error(`makeTyped: unsupported miType ${miType}`);
    }
  }

  // Pulls the array-flags subelement (miUINT32, 8 bytes payload) and
  // decodes the mxClass + flag bits. Layout per spec:
  //   flags[0]: 16 reserved | 8 class | 8 (complex|global|logical|undef)
  //   flags[1]: nzmax (sparse only)
  function readArrayFlags(elem) {
    if (elem.miType !== 6) {
      throw new Error(`expected array flags (miUINT32), got miType ${elem.miType}`);
    }
    const v = new DataView(elem.payload.buffer, elem.payload.byteOffset, elem.payload.length);
    const word0 = v.getUint32(0, true);
    const mxClass = word0 & 0xff;
    const flags = (word0 >>> 8) & 0xff;
    return {
      mxClass,
      complex: !!(flags & 0x08),
      global:  !!(flags & 0x04),
      logical: !!(flags & 0x02),
    };
  }

  function readDims(elem) {
    if (elem.miType !== 5) {
      throw new Error(`expected dimensions (miINT32), got miType ${elem.miType}`);
    }
    return Array.from(payloadAsTypedArray(elem));
  }

  function readArrayName(elem) {
    // INT8 name, occasionally stored as small-format (≤4 chars).
    if (elem.miType !== 1 && elem.miType !== 2) {
      throw new Error(`expected array name (miINT8/UINT8), got miType ${elem.miType}`);
    }
    return new TextDecoder('ascii').decode(elem.payload).replace(/\0+$/, '');
  }

  // Decompresses a miCOMPRESSED element synchronously via Pako if
  // available, otherwise asynchronously via DecompressionStream.
  // Returns a Promise<Uint8Array>. Most modern EEGLAB exports are
  // uncompressed — this path only fires for older / explicit-deflate
  // saves, and we accept the async cost when it does.
  async function inflateZlib(payload) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('miCOMPRESSED found but DecompressionStream is unavailable in this runtime');
    }
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    writer.write(payload);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  // Parses a single miMATRIX payload (already extracted from its tag).
  // Returns { name, class, dims, data, complex }.
  // Asynchronous because we may hit nested miCOMPRESSED elements.
  async function parseMatrix(payload) {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.length);
    const subs = [];
    for (const elem of iterElements(view, 0, payload.length)) subs.push(elem);
    if (subs.length < 3) {
      throw new Error(`miMATRIX with too few sub-elements: ${subs.length}`);
    }
    const flags = readArrayFlags(subs[0]);
    const dims  = readDims(subs[1]);
    const name  = readArrayName(subs[2]);

    if (flags.complex) {
      throw new Error(`complex matrix '${name}' not supported`);
    }

    const info = CLASS_INFO[flags.mxClass];
    const isStruct = flags.mxClass === 2;
    const isChar   = flags.mxClass === 4;
    const isCell   = flags.mxClass === 1;
    const isSparse = flags.mxClass === 5;
    const isObject = flags.mxClass === 3;

    if (isCell || isSparse || isObject) {
      // Returned with data:null so the caller can skip it gracefully
      // — we don't need cells / sparse / objects for inline EEGLAB.
      return { name, class: isCell ? 'cell' : isSparse ? 'sparse' : 'object', dims, data: null };
    }

    if (isChar) {
      const text = new TextDecoder('ascii').decode(subs[3].payload).replace(/\0+$/, '');
      return { name, class: 'char', dims, data: text };
    }

    if (isStruct) {
      // sub[3] = field name length (INT32, scalar)
      // sub[4] = field names (INT8, nfields × fieldNameLen)
      // sub[5..] = each field as a nested miMATRIX
      const fieldNameLen = readDims(subs[3])[0];
      const namesBlob = new TextDecoder('ascii').decode(subs[4].payload);
      const nfields = subs[4].payload.length / fieldNameLen;
      const fieldNames = [];
      for (let i = 0; i < nfields; i++) {
        fieldNames.push(namesBlob.slice(i * fieldNameLen, (i + 1) * fieldNameLen).replace(/\0+$/, ''));
      }
      // For struct arrays of size > 1 we'd see (nfields × prod(dims))
      // miMATRIX subs; we collapse to the first element only — EEGLAB
      // top-level structs are scalar (1×1) anyway.
      const fields = new Map();
      for (let i = 0; i < nfields; i++) {
        const subMatrix = subs[5 + i];
        if (!subMatrix) {
          throw new Error(`struct '${name}': missing subelement for field ${fieldNames[i]}`);
        }
        // Each field is itself a nested matrix.
        if (subMatrix.miType !== 14) {
          throw new Error(`struct '${name}.${fieldNames[i]}': expected miMATRIX, got miType ${subMatrix.miType}`);
        }
        fields.set(fieldNames[i], await parseMatrix(subMatrix.payload));
      }
      return { name, class: 'struct', dims, data: fields };
    }

    if (!info) {
      throw new Error(`'${name}' has unsupported mxClass ${flags.mxClass}`);
    }

    const realData = subs[3];
    const typed = payloadAsTypedArray(realData);
    const expectedLen = dims.reduce((a, b) => a * b, 1);
    if (typed.length !== expectedLen) {
      throw new Error(`'${name}' data length ${typed.length} != prod(dims) ${expectedLen}`);
    }
    return { name, class: info.name, dims, data: typed };
  }

  // Top-level entry point. Accepts an ArrayBuffer or Uint8Array,
  // returns a Promise<Map<string, Var>> of named variables.
  api.parse = async function (buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (u8.length < 128) {
      throw new Error(`MAT file too short for header: ${u8.length}B`);
    }
    const header = new DataView(u8.buffer, u8.byteOffset, 128);
    // Endian indicator: 0x4D49 ('IM' bytes 'M','I' → little-endian on disk).
    const endian = header.getUint16(126, true);
    if (endian !== 0x4d49) {
      throw new Error(`MAT file is not little-endian (endian indicator = 0x${endian.toString(16)})`);
    }
    const version = header.getUint16(124, true);
    if (version !== 0x0100) {
      throw new Error(`unsupported MAT version 0x${version.toString(16)} (only v5/v6 = 0x0100 supported, not v7.3 HDF5)`);
    }

    const view = new DataView(u8.buffer, u8.byteOffset, u8.length);
    const vars = new Map();
    for (const elem of iterElements(view, 128, u8.length)) {
      let payload = elem.payload;
      let miType = elem.miType;
      if (miType === 15) {  // miCOMPRESSED
        payload = await inflateZlib(payload);
        // After inflation, the inner data is a single tagged element
        // (typically a miMATRIX). Re-walk so the inner type is honoured.
        const innerView = new DataView(payload.buffer, payload.byteOffset, payload.length);
        const inner = iterElements(innerView, 0, payload.length).next().value;
        if (!inner) continue;
        miType = inner.miType;
        payload = inner.payload;
      }
      if (miType !== 14) continue;  // skip non-matrix top-level elements
      const v = await parseMatrix(payload);
      if (v.name) vars.set(v.name, v);
    }
    return vars;
  };

  // Unwraps an EEGLAB inline-data .set into the fields the reader
  // needs. EEGLAB writes either a single struct named "EEG" or one
  // top-level variable per field — handle both.
  // Returns { data, srate, nbchan, pnts, trials } where data is a
  // typed array in column-major (channels, samples [, trials]) layout.
  // Throws if any required field is missing or the wrong shape.
  api.extractEegInline = function (vars) {
    // Helper: pick a field by name, falling back to EEG.<name> when
    // the file uses the wrapped layout.
    const eegStruct = vars.get('EEG');
    function field(name) {
      if (vars.has(name)) return vars.get(name);
      if (eegStruct && eegStruct.class === 'struct' && eegStruct.data.has(name)) {
        return eegStruct.data.get(name);
      }
      return null;
    }
    function scalar(name) {
      const v = field(name);
      if (!v || !v.data || !v.data.length) return null;
      return Number(v.data[0]);
    }

    const data = field('data');
    if (!data) {
      throw new Error('EEG inline-data .set missing `data` (or EEG.data) variable');
    }
    if (data.class !== 'single' && data.class !== 'double' && data.class !== 'int16' && data.class !== 'int32') {
      throw new Error(`EEG.data has unsupported numeric class '${data.class}' (need single/double/int16/int32)`);
    }
    if (data.dims.length < 2 || data.dims.length > 3) {
      throw new Error(`EEG.data must be 2D or 3D, got dims=[${data.dims.join(',')}]`);
    }
    const nbchan = scalar('nbchan') ?? data.dims[0];
    const pnts   = scalar('pnts')   ?? data.dims[1];
    const trials = scalar('trials') ?? (data.dims[2] || 1);
    const srate  = scalar('srate');
    if (!srate || !isFinite(srate) || srate <= 0) {
      throw new Error(`EEG.srate missing or invalid (got ${srate})`);
    }
    if (data.dims[0] !== nbchan) {
      throw new Error(`EEG.data dims[0]=${data.dims[0]} disagrees with nbchan=${nbchan}`);
    }
    return { data: data.data, srate, nbchan, pnts, trials, dataClass: data.class };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.MatV5 = api;
})();
