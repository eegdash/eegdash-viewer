#!/usr/bin/env node
/**
 * scripts/probe-ctf-name-offset.mjs
 *
 * Empirical probe to determine the channel-name table offset in real
 * CTF .res4 files. Downloads ds002001 + ds002908 sub-001 .res4 files
 * over HTTP Range from the production CDN, parses the fixed header
 * with the production reader, then prints a hex dump of the 64 bytes
 * around the expected channel-name table start (HEADER_FIXED = 1844)
 * AND a search for the first printable channel-name-looking ASCII
 * string in the byte range 1500..3000.
 *
 * Run:  node scripts/probe-ctf-name-offset.mjs
 *
 * Expected output (for both files):
 *   - parsed no_channels matches MNE-Python report (337-338)
 *   - sample_rate matches (2400 Hz)
 *   - first channel name string starts at some offset X
 *   - if X === 1844, HEADER_FIXED is correct
 *   - if X !== 1844, print the delta and the magic so we know which
 *     generator version needs the override
 */

const URLS = [
  'https://cdn.eegdash.org/ds002001/sub-0001/ses-20140502/meg/' +
    'sub-0001_ses-20140502_task-rivalry_run-02_meg.ds/' +
    'sub-0001_ses-20140502_task-rivalry_run-02_meg.res4',
  'https://cdn.eegdash.org/ds002908/sub-01/ses-1/meg/' +
    'sub-01_ses-1_task-mouse_meg.ds/sub-01_ses-1_task-mouse_meg.res4',
];

async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
  return await r.arrayBuffer();
}

function ascii(u8, off, len) {
  let s = '';
  for (let i = off; i < off + len && i < u8.length; i++) {
    const b = u8[i];
    if (b === 0) break;
    s += (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '·';
  }
  return s;
}

function hex64(u8, off) {
  const lines = [];
  for (let row = 0; row < 4; row++) {
    const base = off + row * 16;
    const hex = Array.from(u8.subarray(base, base + 16))
      .map(b => b.toString(16).padStart(2, '0')).join(' ');
    const asc = ascii(u8, base, 16).replace(/\0/g, '·');
    lines.push(`  ${base.toString().padStart(5)}: ${hex}  |${asc}|`);
  }
  return lines.join('\n');
}

// Heuristic: a CTF channel name looks like "MLT11-1609", "MEG0113",
// "EEG001", "STIM001" — uppercase ASCII letters + digits + dash, length
// 4..31, followed by at least one null byte (because the field is
// 32 bytes null-padded). Walk byte by byte and report the FIRST offset
// in the range [1500, 3000] whose 32-byte window matches this shape.
function firstChannelName(u8) {
  for (let off = 1500; off + 32 <= u8.length && off < 3000; off++) {
    const s = ascii(u8, off, 32);
    if (/^[A-Z][A-Z0-9\-]{3,30}$/.test(s)) {
      // Check the byte right after the name is NUL (real names are
      // null-padded inside 32 bytes; a false positive that runs into
      // arbitrary binary will not have a NUL right after).
      const afterIdx = off + s.length;
      if (u8[afterIdx] === 0) return { off, name: s };
    }
  }
  return null;
}

(async () => {
  for (const url of URLS) {
    console.log('\n===', url.split('/').pop(), '===');
    const ab = await fetchBuf(url);
    const u8 = new Uint8Array(ab);
    console.log(`file size: ${u8.length} bytes`);
    console.log(`magic: ${ascii(u8, 0, 8)}`);
    const dv = new DataView(ab);
    console.log(`no_samples  @1288: ${dv.getInt32(1288, false)}`);
    console.log(`no_channels @1292: ${dv.getInt16(1292, false)}`);
    console.log(`sample_rate @1296: ${dv.getFloat64(1296, false)}`);
    console.log('bytes 1828..1891 (expected HEADER_FIXED boundary at 1844):');
    console.log(hex64(u8, 1828));
    const hit = firstChannelName(u8);
    if (hit) {
      console.log(`first channel-name-looking string: "${hit.name}" @ offset ${hit.off}`);
      console.log(`delta from HEADER_FIXED=1844: ${hit.off - 1844}`);
    } else {
      console.log('no channel-name-looking string found in [1500, 3000]');
    }
  }
})();
