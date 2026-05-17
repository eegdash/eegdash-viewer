// Cross-format integration: breadth across OpenNeuro recordings,
// boundary cases, AbortController, concurrent loads, eegdash
// inheritance + dep_keys fallback, plus stress (rapid abort,
// large window, many small windows).
//
// Network-bound — first run ~60-90s on cold cache.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';
import { BIDSRecording, EEGLABReader, EDFReader, BrainVisionReader } from './_bootstrap.mjs';

const READERS = {
  set:  EEGLABReader,
  edf:  EDFReader,
  bdf:  EDFReader,
  vhdr: BrainVisionReader,
};

// Mix of split (.set+.fdt) and inline-data (.set only) EEGLAB
// recordings — the reader auto-detects which path to take.
const MATRIX = [
  { fmt: 'set',  ds: 'ds002893', sub: '001',   task: 'AuditoryVisualShift', run: '01', expect: { fs: 250, n_channels: 36 } },
  { fmt: 'set',  ds: 'ds003478', sub: '001',   task: 'Rest',                run: '01', expect: { fs: 500, n_channels: 66 } },
  { fmt: 'set',  ds: 'ds003490', sub: '001',   ses: '01', task: 'Rest',                expect: { fs: 500, n_channels: 67 } },
  { fmt: 'edf',  ds: 'ds002034', sub: '01',    ses: '01', task: 'offline',  run: '01', expect: { fs: 512 } },
  // BioSemi 24-bit BDF — exercises the int24 sign-extension path that
  // single-format smokes don't reach. Ses-01 sub-003 is the smallest
  // BDF on ds001787 (~59 MB) so the integration stays bounded.
  { fmt: 'bdf',  ds: 'ds001787', sub: '003',   ses: '01', task: 'meditation' },
  { fmt: 'vhdr', ds: 'ds002336', sub: 'xp101', task: 'motorloc',                       expect: { fs: 5000, n_channels: 64 } },
  { fmt: 'vhdr', ds: 'ds002336', sub: 'xp101', task: 'eegfmriNF',                      expect: { fs: 5000, n_channels: 64 } },
];

function urlOf(spec) {
  return BIDSRecording.buildOpenNeuroEegUrl({
    dataset: spec.ds, sub: spec.sub, ses: spec.ses,
    task: spec.task, run: spec.run, ext: spec.fmt,
  });
}

async function loadOne(spec) {
  const url = urlOf(spec);
  const meta = await BIDSRecording.loadRecordingMetadata(url);
  return { url, meta, reader: await READERS[meta.ext].open(meta) };
}

const isAllFinite = (a) => {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
};

// ----- 1. breadth + boundary -------------------------------

for (const spec of MATRIX) {
  const tag = `${spec.ds}/${spec.task}${spec.run ? '/' + spec.run : ''}`;
  test(`breadth: ${tag}`, async (t) => {
    const { reader } = await loadOne(spec);
    const ex = spec.expect || {};
    if (ex.fs)         assert.equal(reader.sampling_frequency, ex.fs);
    if (ex.n_channels) assert.equal(reader.n_channels, ex.n_channels);

    const N = 100;
    const head = await reader.readWindow(0, N);
    await t.test('head shape',         () => assert.equal(head[0].length, N));
    await t.test('head finite',        () => assert.ok(head.every(isAllFinite)));

    const mid = await reader.readWindow(Math.floor(reader.n_samples / 2), N);
    await t.test('mid shape',          () => assert.equal(mid[0].length, N));
    await t.test('mid != head',        () => assert.ok(head.some((h, c) => h.some((v, s) => v !== mid[c][s]))));

    const tail = await reader.readWindow(Math.max(0, reader.n_samples - N), N);
    await t.test('tail shape',         () => assert.equal(tail[0].length, N));

    const past = await reader.readWindow(reader.n_samples + 1000, N);
    await t.test('past-EOF: 0-length', () => assert.ok(past.every(ch => ch.length === 0)));

    const zero = await reader.readWindow(0, 0);
    await t.test('zero-length: 0-length', () => assert.ok(zero.every(ch => ch.length === 0)));

    const neg = await reader.readWindow(-50, N);
    await t.test('negative-start: no throw', () => assert.equal(neg.length, reader.n_channels));
  });
}

// ----- 2. AbortController ----------------------------------

test('AbortController: rapid pan correctness', async (t) => {
  const { reader } = await loadOne(MATRIX[0]);
  const ctrl1 = new AbortController();
  const p1 = reader.readWindow(0, 1000, { signal: ctrl1.signal });
  ctrl1.abort();
  await t.test('aborted promise rejects with AbortError',
    async () => assert.rejects(p1, (e) => e.name === 'AbortError'));
  const ctrl2 = new AbortController();
  const win = await reader.readWindow(2000, 1000, { signal: ctrl2.signal });
  await t.test('subsequent read still resolves',
    () => assert.equal(win[0].length, 1000));
});

// ----- 3. concurrent loads ---------------------------------

test('concurrent loads do not cross-contaminate', async () => {
  const subset = MATRIX.slice(0, 4);
  const t0 = performance.now();
  const results = await Promise.allSettled(subset.map(loadOne));
  const t = performance.now() - t0;
  const ok = results.filter(r => r.status === 'fulfilled');
  const failed = results
    .map((r, i) => r.status === 'rejected' ? `${subset[i].ds}/${subset[i].task}: ${r.reason.message}` : null)
    .filter(Boolean);
  assert.equal(ok.length, subset.length,
    failed.length ? `parallel load failures: ${failed.join('; ')}` : 'all parallel loads succeed');
  const seen = new Set(ok.map(r => r.value.reader.url));
  assert.equal(seen.size, ok.length, 'distinct readers');
  console.log(`        ${ok.length} parallel loads · ${t.toFixed(0)}ms wall`);
});

// ----- 4. eegdash inheritance / fallback -------------------

test('ds002336 inheritance walk resolves dataset-root sidecars', async () => {
  const meta = await BIDSRecording.loadRecordingMetadata(urlOf({
    fmt: 'vhdr', ds: 'ds002336', sub: 'xp101', task: 'eegfmriNF',
  }));
  assert.equal(meta.eeg_json.sampling_frequency, 5000);
  assert.equal(meta.channels?.length, 64);
  assert.ok(meta.events.length > 0);
  assert.ok(meta.sidecar_sources.eeg_json?.endsWith('task-eegfmriNF_eeg.json'));
  assert.ok(meta.sidecar_sources.channels?.endsWith('task-eegfmriNF_channels.tsv'));
});

// ----- 5. stress -------------------------------------------

test('stress: 20 reads with 19 aborted mid-flight', async () => {
  const { reader } = await loadOne(MATRIX[0]);
  const N = 20;
  const win = Math.floor(reader.sampling_frequency * 5);
  const ctrls = [], promises = [];
  for (let i = 0; i < N; i++) {
    const c = new AbortController();
    ctrls.push(c);
    promises.push(reader.readWindow(
      Math.floor(Math.random() * (reader.n_samples - win)), win, { signal: c.signal }));
  }
  for (let i = 0; i < N - 1; i++) ctrls[i].abort();
  const results = await Promise.allSettled(promises);
  const aborted = results.slice(0, N - 1).filter(r =>
    r.status === 'rejected' && r.reason?.name === 'AbortError');
  assert.equal(aborted.length, N - 1, 'all 19 aborted reads reject AbortError');
  assert.equal(results[N - 1].status, 'fulfilled', 'surviving read resolved');
  assert.equal(results[N - 1].value[0].length, win, 'surviving read full window');
});

test('stress: 60s window from a 5kHz BV recording (~38 MB)', async () => {
  const spec = MATRIX.find(s => s.fmt === 'vhdr');
  const { reader } = await loadOne(spec);
  const win = Math.min(reader.n_samples, Math.floor(reader.sampling_frequency * 60));
  const t0 = performance.now();
  const out = await reader.readWindow(Math.floor(reader.n_samples / 4), win);
  const t = performance.now() - t0;
  const bytes = win * reader.n_channels * reader.bytes_per_sample;
  assert.equal(out[0].length, win);
  assert.ok(out.every(isAllFinite));
  console.log(`        ${(bytes / 1e6).toFixed(1)} MB · ${t.toFixed(0)}ms · ${(bytes / t / 1e3).toFixed(1)} MB/s`);
});

test('stress: 30 sequential disjoint reads', async () => {
  const { reader } = await loadOne(MATRIX[0]);
  const N = 30;
  const win = Math.floor(reader.sampling_frequency * 0.5);
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const out = await reader.readWindow(
      Math.floor(Math.random() * (reader.n_samples - win)), win);
    assert.equal(out[0].length, win);
  }
  const t = performance.now() - t0;
  console.log(`        ${N} reads · ${t.toFixed(0)}ms (${(t / N).toFixed(0)}ms/read)`);
});

// ----- 6. NEMAR ---------------------------------------------------
// Manifest-driven resolution: the loader fetches
//   data.nemar.org/<id>/latest/manifest.json
// (through the cdn-worker /data/ proxy because data.nemar.org omits
// Access-Control-Allow-Origin), then walks the flat file list to
// resolve the raw binary + sidecars by BIDS path. Bytes still come
// from the existing /<id>/objects/<sha> cdn-worker path.
//
// Coverage:
//   - nm000148 (BDF, 32 ch, motor imagery, 512 Hz)  — biggest BDF
//   - nm000121 (.set, 14 ch, ssvep, 128 Hz)         — inline-data .set
//     (data lives inside the MAT file; no .fdt sibling needed)
// .vhdr coverage is blocked by an S3 ACL gap on the only NEMAR
// BrainVision dataset (nm000166); .edf coverage by the same on
// nm000181. Live tests require the cdn-worker's /data/ proxy route
// to be deployed — if these regress with "manifest 404" or CORS,
// check `wrangler tail` on the eegdash-cdn worker first.
const NEMAR_MATRIX = [
  { fmt: 'bdf', ds: 'nm000148', sub: '11', ses: '0',      task: 'imagery', run: '1' },
  { fmt: 'set', ds: 'nm000121', sub: '6',  ses: '0',      task: 'ssvep',   run: '6' },
];

async function loadOneNemar(spec) {
  const meta = await BIDSRecording.loadNemarRecording({
    dataset: spec.ds, sub: spec.sub, ses: spec.ses,
    task: spec.task, run: spec.run, ext: spec.fmt,
  });
  return { meta, reader: await READERS[meta.ext].open(meta) };
}

for (const spec of NEMAR_MATRIX) {
  const tag = `${spec.ds}/${spec.task}${spec.run ? '/' + spec.run : ''}`;
  test(`nemar: ${tag}`, async (t) => {
    const { meta, reader } = await loadOneNemar(spec);
    // Binary URL is the SHA-keyed git-annex form, routed through the
    // cdn.eegdash.org Cloudflare Worker (NEMAR's own S3 lacks CORS).
    // The "objects/" segment is the give-away — git-annex's content-
    // addressed object store layout. The presigned query string that
    // data.nemar.org's manifest returns is stripped during URL rewrite
    // since the cdn proxy is anonymous + content-addressed.
    assert.match(meta.eeg_url, /^https:\/\/cdn\.eegdash\.org\/[^/]+\/objects\/(SHA256E|MD5E)-/);
    assert.ok(meta.eeg_json.sampling_frequency > 0,
      `sidecar SamplingFrequency missing for ${tag}`);
    assert.ok(reader.n_channels > 0, `reader exposed n_channels for ${tag}`);
    assert.ok(reader.duration_s > 0, `reader exposed duration_s for ${tag}`);

    const N = 100;
    const head = await reader.readWindow(0, N);
    await t.test('head shape',  () => assert.equal(head[0].length, N));
    await t.test('head finite', () => assert.ok(head.every(isAllFinite)));

    const mid = await reader.readWindow(Math.floor(reader.n_samples / 2), N);
    await t.test('mid != head',
      () => assert.ok(head.some((h, c) => h.some((v, s) => v !== mid[c][s]))));

    const past = await reader.readWindow(reader.n_samples + 1000, N);
    await t.test('past-EOF: 0-length',
      () => assert.ok(past.every(ch => ch.length === 0)));
  });
}
