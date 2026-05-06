/* ============================================================
   formats/_http_range.js — HTTP Range helpers + local-Blob
   registry shared by every format reader.

   Drag-dropped files register against synthetic
   `https://localdrop.invalid/<filename>` URLs (.invalid is
   reserved by RFC 2606) so the existing URL math — parseEegUrl,
   `new URL(rel, base)` for sibling derivation, the inheritance
   walk — works unchanged for both real OpenNeuro URLs and
   in-memory drops.
   ============================================================ */
(function () {
  'use strict';

  const LOCAL_PREFIX = 'https://localdrop.invalid/';
  const _localBlobs = new Map();

  function isLocal(url) { return typeof url === 'string' && url.startsWith(LOCAL_PREFIX); }

  function registerLocal(filename, blob) {
    const url = `${LOCAL_PREFIX}${encodeURIComponent(filename)}`;
    _localBlobs.set(url, blob);
    return url;
  }

  function clearLocal() { _localBlobs.clear(); }

  // HEAD first; some S3 access policies block HEAD outright, so
  // fall back to a zero-byte GET with Range and parse the
  // Content-Range total. Local blobs short-circuit to `.size`.
  async function probeLength(url) {
    if (isLocal(url)) {
      const blob = _localBlobs.get(url);
      if (!blob) throw new Error(`Local drop missing: ${url}`);
      return blob.size;
    }
    let r = await fetch(url, { method: 'HEAD' });
    if (r.ok && r.headers.get('content-length')) {
      return Number(r.headers.get('content-length'));
    }
    r = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    if (r.status !== 206) {
      throw new Error(`Cannot determine length: HTTP ${r.status} for ${url}`);
    }
    const cr = r.headers.get('content-range');
    const m = cr && /\/(\d+)$/.exec(cr);
    if (!m) throw new Error(`Server returned no Content-Range total for ${url}`);
    return Number(m[1]);
  }

  // Inclusive range. `expectedBytes`, when given, also throws if the
  // body length differs (typical sign of a CDN that ignored Range and
  // served the full file). `signal` cancels in-flight HTTP fetches —
  // when the user pans rapidly, the page aborts the prior request so
  // we don't waste bandwidth on results that will be discarded. The
  // local-blob path checks `signal.aborted` once before slicing so a
  // late synchronous read still bails after the URL was unregistered.
  // OpenNeuro S3 is per-connection bandwidth-throttled (~0.7 MB/s on a
  // single fetch), but HTTP/2 multiplexes parallel requests on the
  // same TCP connection so concurrent range fetches reach ~3-4 MB/s
  // total. Tiling above the threshold therefore gives a 4-5× wall-time
  // speedup on the same total bytes — see scripts/bench-fetch.mjs.
  //
  // 4 MiB threshold landed empirically — see scripts/bench-fetch.mjs.
  // Lowering it for the 5 kHz × 64 ch × 10 s case (6.4 MB pans) was
  // tested via perf-trace.mjs and produced no clean wall-time win:
  // single-fetch and tiled were within network noise on real S3,
  // because the bottleneck for those recordings is per-pan latency
  // (mostly bytes-on-the-wire), not parallelism. The fix for that
  // is the read-ahead cache in viewer.js, not a tighter threshold.
  const TILE_THRESHOLD_BYTES = 4 * 1024 * 1024;
  const TILE_TARGET_BYTES    = 2 * 1024 * 1024;
  const TILE_MAX_PARALLEL    = 8;

  async function rangeFetch(url, byteStart, byteEndInclusive, expectedBytes, opts) {
    // Zero-length / inverted ranges short-circuit without hitting the
    // network (or the local registry) — every reader has a code path
    // where nSamplesWindow=0 makes the math collapse, and we'd rather
    // return an empty ArrayBuffer than send `Range: bytes=0--1`.
    if (byteEndInclusive < byteStart || expectedBytes === 0) {
      return new ArrayBuffer(0);
    }
    if (isLocal(url)) {
      return rangeFetchLocal(url, byteStart, byteEndInclusive, expectedBytes, opts);
    }
    const total = byteEndInclusive - byteStart + 1;
    if (total >= TILE_THRESHOLD_BYTES) {
      return rangeFetchTiled(url, byteStart, byteEndInclusive, total, opts);
    }
    return rangeFetchSingle(url, byteStart, byteEndInclusive, expectedBytes, opts);
  }

  async function rangeFetchLocal(url, byteStart, byteEndInclusive, expectedBytes, opts) {
    const signal = opts && opts.signal;
    if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
    const blob = _localBlobs.get(url);
    if (!blob) throw new Error(`Local drop missing: ${url}`);
    const buf = await blob.slice(byteStart, byteEndInclusive + 1).arrayBuffer();
    if (expectedBytes != null && buf.byteLength !== expectedBytes) {
      throw new Error(`Local slice returned ${buf.byteLength}B, expected ${expectedBytes}B.`);
    }
    return buf;
  }

  async function rangeFetchSingle(url, byteStart, byteEndInclusive, expectedBytes, opts) {
    const signal = opts && opts.signal;
    const r = await fetch(url, {
      headers: { Range: `bytes=${byteStart}-${byteEndInclusive}` },
      signal,
    });
    if (r.status !== 206 && r.status !== 200) {
      throw new Error(`Range fetch failed: HTTP ${r.status} for ${url}`);
    }
    const buf = await r.arrayBuffer();
    if (expectedBytes != null && buf.byteLength !== expectedBytes) {
      throw new Error(
        `Range fetch returned ${buf.byteLength}B, expected ${expectedBytes}B ` +
        `(server may have ignored Range header).`
      );
    }
    return buf;
  }

  // Split a big range into ≤ TILE_MAX_PARALLEL pieces and pull them all
  // at once. Same `signal` propagates so a pan-mid-flight aborts every
  // tile in flight; one rejection rejects the whole `Promise.all`.
  async function rangeFetchTiled(url, byteStart, byteEndInclusive, total, opts) {
    const nTiles = Math.min(TILE_MAX_PARALLEL, Math.ceil(total / TILE_TARGET_BYTES));
    const tileSize = Math.ceil(total / nTiles);
    const ranges = [];
    for (let i = 0; i < nTiles; i++) {
      const a = byteStart + i * tileSize;
      const b = Math.min(a + tileSize - 1, byteEndInclusive);
      ranges.push([a, b]);
    }
    const buffers = await Promise.all(
      ranges.map(([a, b]) => rangeFetchSingle(url, a, b, b - a + 1, opts))
    );
    const out = new Uint8Array(total);
    let off = 0;
    for (const buf of buffers) {
      out.set(new Uint8Array(buf), off);
      off += buf.byteLength;
    }
    return out.buffer;
  }

  // Single text-fetch entry point. With `allowMissing` the helper is
  // 404-tolerant — sidecars are often optional and we want a `null`
  // back so the inheritance walk can fall through, not an exception.
  // Without it, anything other than 2xx throws (used for the .vhdr,
  // which is required by definition).
  async function fetchText(url, { allowMissing = false } = {}) {
    if (isLocal(url)) {
      const blob = _localBlobs.get(url);
      if (blob) return blob.text();
      if (allowMissing) return null;
      throw new Error(`Local drop missing: ${url}`);
    }
    // force-cache: OpenNeuro / static BIDS buckets serve immutable
    // content, so the browser cache is a free win across pans.
    const r = await fetch(url, { cache: 'force-cache' });
    if (allowMissing && r.status === 404) return null;
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} fetching ${url}`);
    return r.text();
  }
  const fetchTextOrNull = (url) => fetchText(url, { allowMissing: true });

  const api = {
    probeLength, rangeFetch, fetchText, fetchTextOrNull,
    registerLocal, clearLocal,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.HttpRange = api;
})();
