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
  // 256 KiB threshold + 256 KiB tile size + 6 parallel fetches.
  // Empirical: live-probing OpenNeuro S3 (us-east-1, raw bucket,
  // HTTP/1.1 only — no HTTP/2 multiplexing) showed 8 × 128 KB
  // parallel range fetches complete in 770 ms total vs 2557 ms for
  // a single 1 MB fetch — 3.3× faster. The original 4 MiB threshold
  // was right for the 38 MB benchmark it was tuned against (where
  // tiling won 4-5×) but wrong for the typical sub-MB pan, where
  // the per-TCP bandwidth cap (~0.4 MB/s) makes a single fetch the
  // slow path even though the bytes are few.
  //
  // 6 parallel matches the browser's HTTP/1.1 connection-per-host
  // cap (Chrome/Firefox default). Going higher is wasted: the 7th+
  // fetch queues until a slot opens. See docs/streaming-and-cdn-study.md.
  const TILE_THRESHOLD_BYTES = 256 * 1024;
  const TILE_TARGET_BYTES    = 256 * 1024;
  const TILE_MAX_PARALLEL    = 6;

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

  // ---- Streaming fetch ----------------------------------------
  // Returns an AsyncIterable<{ offset, bytes: Uint8Array }> where
  // `offset` is 0-based within the requested range [byteStart, byteEnd].
  // Falls back to a single rangeFetch (yielding one chunk) for:
  //   - local blobs (synchronous slice, no streaming gain)
  //   - tiny ranges below STREAM_THRESHOLD (chunking overhead not worth it)
  // opts.signal aborts mid-stream cleanly.
  // Throws if total received bytes != requested length.
  const STREAM_THRESHOLD = 64 * 1024;  // 64 KiB — chunking tiny ranges is wasteful

  async function* rangeFetchStreaming(url, byteStart, byteEndInclusive, opts) {
    const total = byteEndInclusive - byteStart + 1;
    if (total <= 0) return;

    // For local blobs or small ranges, fall back to a single arraybuffer
    // chunk — no streaming benefit for tiny or synchronous sources.
    if (isLocal(url) || total < STREAM_THRESHOLD) {
      const buf = await rangeFetch(url, byteStart, byteEndInclusive, total, opts);
      yield { offset: 0, bytes: new Uint8Array(buf) };
      return;
    }

    const signal = opts && opts.signal;
    const r = await fetch(url, {
      headers: { Range: `bytes=${byteStart}-${byteEndInclusive}` },
      signal,
    });
    if (r.status !== 206 && r.status !== 200) {
      throw new Error(`Range fetch (streaming) failed: HTTP ${r.status} for ${url}`);
    }

    const reader = r.body.getReader();
    let offset = 0;
    try {
      while (true) {
        // Check abort signal before each read
        if (signal && signal.aborted) {
          reader.cancel();
          throw new DOMException('aborted', 'AbortError');
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          yield { offset, bytes: value };
          offset += value.byteLength;
        }
      }
    } catch (e) {
      reader.cancel();
      throw e;
    }

    if (offset !== total) {
      throw new Error(
        `Streaming range fetch received ${offset}B, expected ${total}B ` +
        `(server may have ignored Range header or truncated response).`
      );
    }
  }

  /**
   * Fetch the entire body of `url` as an ArrayBuffer. Used by readers
   * that need the whole file in memory (FIFF, CTF .res4 + .meg4).
   * Includes a 1 GB cap to surface the bandwidth/memory ceiling
   * before the browser OOMs. Range: 0-N-1 is used (not a plain GET)
   * so this routes through the same cache as range fetches.
   *
   * @param {string} url
   * @param {object} [opts]
   * @param {number} [opts.maxBytes=1073741824] - hard cap, default 1 GiB
   * @returns {Promise<ArrayBuffer>}
   * @throws if Content-Length / probeLength exceeds maxBytes, or the
   *         response is non-2xx
   */
  async function fetchBuffer(url, opts = {}) {
    const maxBytes = opts.maxBytes ?? 1073741824;  // 1 GiB
    // Probe size first so we can fail-fast with a clear message.
    const size = await probeLength(url);
    if (size > maxBytes) {
      throw new Error(
        `fetchBuffer: ${url} is ${(size / 1024 / 1024).toFixed(0)} MB ` +
        `(exceeds ${(maxBytes / 1024 / 1024).toFixed(0)} MB cap); ` +
        `use range-based readWindow instead.`,
      );
    }
    // Range request for the whole body — routes through CDN range cache.
    return rangeFetch(url, 0, size - 1);
  }

  const api = {
    probeLength, rangeFetch, rangeFetchStreaming, fetchBuffer,
    fetchText, fetchTextOrNull,
    registerLocal, clearLocal,
    _STREAM_THRESHOLD: STREAM_THRESHOLD,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.HttpRange = api;
})();
