/** Sweep the pinned official BIDS examples through the production coordinate loader.
 * Run: node scripts/audit-sensor-inputs.mjs [cache-directory]
 * Cached inputs make repeat runs independent of the network.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
require('../bids-loader.js');
require('../formats/_buffers.js');
require('../formats/_http_range.js');
const BIDSRecording = require('../bids-recording.js');
require('../sensor-montage.js');
const { buildGroups } = require('../sensor-geometry.js');
const revision = 'ca54a02e55548090fced87f38a28bae13a1f692d';
const cache = process.argv[2] || path.join(os.tmpdir(), 'eegdash-bids-geometry', revision);
await fs.mkdir(cache, { recursive: true });
async function cached(name, url) {
  const target = path.join(cache, name);
  try { return await fs.readFile(target, 'utf8'); } catch {}
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  const text = await response.text();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text);
  return text;
}
const tree = JSON.parse(await cached('tree.json', `https://api.github.com/repos/bids-standard/bids-examples/git/trees/${revision}?recursive=1`));
const files = tree.tree.filter(f => /_(electrodes\.tsv|optodes\.tsv|coordsystem\.json)$/.test(f.path));
const entries = [], failures = [];
for (let i = 0; i < files.length; i += 8) {
  await Promise.all(files.slice(i, i + 8).map(async ({ path: name }) => {
    try {
      const content = await cached(name, `https://raw.githubusercontent.com/bids-standard/bids-examples/${revision}/${name}`);
      entries.push({ name, size: Buffer.byteLength(content), text: async () => content });
    } catch (error) { failures.push({ name, error: error.message }); }
  }));
  console.log(`Read ${Math.min(i + 8, files.length)}/${files.length} coordinate files`);
}
const results = [];
for (const table of entries.filter(e => e.name.endsWith('.tsv')).sort((a, b) => a.name.localeCompare(b.name))) {
  const suffix = /\/(eeg|ieeg|meg|emg|nirs)\//.exec(table.name)?.[1] || 'eeg';
  const bundle = await BIDSRecording.loadCoordinateSets([table, ...entries.filter(e => e.name.endsWith('.json'))], { suffix });
  const groups = buildGroups({ suffix, ...bundle });
  for (const group of groups) {
    assert.equal(group.template, false, 'supplied coordinates must never become a template');
    assert.ok(group.points.every(p => p.display.every(Number.isFinite)));
    const scale = ({ m: 1000, cm: 10, mm: 1 })[group.units] || 1;
    const als = ['CTF', 'EEGLAB', 'EEGLAB-HJ', '4DBti', 'KitYokogawa'].includes(group.displaySpace);
    for (const p of group.points) {
      const expected = (als ? [-p.y, p.x, p.z] : [p.x, p.y, p.z]).map(v => v * scale);
      assert.deepEqual(p.display, expected, 'axis/unit conversion must preserve the source geometry');
    }
  }
  results.push({ file: table.name, modality: suffix,
    status: groups.length ? 'renderable' : 'no-valid-3d-positions',
    positions: groups.reduce((n, g) => n + g.points.length, 0),
    frames: groups.map(g => ({ name: g.space, axes: g.displaySpace, units: g.units, count: g.points.length })),
    issues: bundle.coordinate_errors });
}
const report = { revision, source: `https://github.com/bids-standard/bids-examples/tree/${revision}`,
  coordinateFiles: entries.length, downloadFailures: failures, tables: results.length,
  datasets: new Set(results.map(r => r.file.split('/')[0])).size,
  renderable: results.filter(r => r.status === 'renderable').length,
  noValid3D: results.filter(r => r.status !== 'renderable').length, results };
await fs.mkdir('docs/audits', { recursive: true });
await fs.writeFile('docs/audits/bids-geometry-sweep.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
if (failures.length) process.exitCode = 1;
