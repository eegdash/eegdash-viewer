#!/usr/bin/env node
/**
 * scripts/serve.mjs — tiny static file server with Range-request support.
 *
 * Playwright's webServer option needs an HTTP server that correctly handles
 * Range requests (RFC 7233) so the EDF/BDF range-fetch path works for local
 * test fixtures. Python's built-in http.server (≤ 3.12) returns 200 without
 * honouring the Range header, which breaks HttpRange.rangeFetchSingle's
 * expectedBytes validation.
 *
 * Usage:  node scripts/serve.mjs [port] [root]
 *   port  defaults to 8109
 *   root  defaults to cwd
 */

import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = parseInt(process.argv[2] ?? '8109', 10);
const ROOT = resolve(process.argv[3] ?? '.');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript',
  '.mjs':  'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.edf':  'application/octet-stream',
  '.bdf':  'application/octet-stream',
  '.set':  'application/octet-stream',
  '.fdt':  'application/octet-stream',
  '.vhdr': 'text/plain',
  '.eeg':  'application/octet-stream',
  '.vmrk': 'text/plain',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function mime(path) {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function parseRange(rangeHeader, totalSize) {
  if (!rangeHeader) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!m) return null;
  let start = m[1] ? parseInt(m[1], 10) : null;
  let end   = m[2] ? parseInt(m[2], 10) : null;
  if (start === null && end !== null) {
    // suffix range: bytes=-N → last N bytes
    start = Math.max(0, totalSize - end);
    end   = totalSize - 1;
  } else {
    start = start ?? 0;
    end   = end   ?? (totalSize - 1);
  }
  if (start > end || start < 0 || end >= totalSize) return null;
  return { start, end };
}

const server = createServer((req, res) => {
  // Only handle GET and HEAD.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  // Decode URL, strip query string, resolve to a file path.
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400); res.end(); return;
  }
  if (urlPath === '/' || urlPath.endsWith('/')) urlPath += 'index.html';

  const filePath = resolve(ROOT, '.' + urlPath);

  // Security: don't serve files outside ROOT.
  if (!filePath.startsWith(ROOT + '/') && filePath !== ROOT) {
    res.writeHead(403); res.end(); return;
  }

  if (!existsSync(filePath)) {
    res.writeHead(404); res.end('Not found'); return;
  }

  let stat;
  try { stat = statSync(filePath); } catch { res.writeHead(500); res.end(); return; }
  if (!stat.isFile()) { res.writeHead(404); res.end(); return; }

  const total = stat.size;
  const range = parseRange(req.headers['range'], total);

  const headers = {
    'Content-Type':   mime(filePath),
    'Accept-Ranges':  'bytes',
    'Last-Modified':  stat.mtime.toUTCString(),
    'Cache-Control':  'no-cache',
  };

  if (range) {
    const chunkSize = range.end - range.start + 1;
    res.writeHead(206, {
      ...headers,
      'Content-Range':  `bytes ${range.start}-${range.end}/${total}`,
      'Content-Length': String(chunkSize),
    });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': String(total) });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(filePath).pipe(res);
  }
});

server.listen(PORT, () => {
  process.stderr.write(`Static server listening on http://localhost:${PORT}/ (root: ${ROOT})\n`);
});
