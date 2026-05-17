// Unit tests for the NEMAR recording loader in bids-recording.js.
//
// NEMAR datasets (nm/on/xx) are addressed through data.nemar.org's
// per-version manifest.json — a flat list of {path,size,checksum,url}
// covering every file in the dataset. The viewer fetches the manifest
// through the cdn-worker proxy (CORS bridge) and resolves both the
// raw binary URL and the sidecar URLs against the manifest's path
// index. Tests cover the happy path, 404 manifest, missing file,
// trust-boundary URL guards, the inline-git → raw.githubusercontent
// fast path, and BrainVision sibling synthesis.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BIDSRecording, BrainVisionReader } from './_bootstrap.mjs';

// ----- isNemarDatasetId -------------------------------------------

test('isNemarDatasetId: nm/on/xx + exactly 6 digits (lockstep with cdn-worker)', () => {
  // Native NEMAR
  assert.equal(BIDSRecording.isNemarDatasetId('nm000131'), true);
  assert.equal(BIDSRecording.isNemarDatasetId('nm000001'), true);
  // OpenNeuro mirrors (unblocked in nemar-cli #516, May 2026)
  assert.equal(BIDSRecording.isNemarDatasetId('on005262'), true);
  // Sandbox
  assert.equal(BIDSRecording.isNemarDatasetId('xx000001'), true);
  // Negative cases
  assert.equal(BIDSRecording.isNemarDatasetId('ds002893'), false);
  assert.equal(BIDSRecording.isNemarDatasetId('NM000131'), false);
  assert.equal(BIDSRecording.isNemarDatasetId('nm00013a'), false);
  // 5-digit and 7-digit must reject — would 404 against the cdn-worker.
  assert.equal(BIDSRecording.isNemarDatasetId('nm12345'), false);
  assert.equal(BIDSRecording.isNemarDatasetId('nm1234567'), false);
  assert.equal(BIDSRecording.isNemarDatasetId(''), false);
  assert.equal(BIDSRecording.isNemarDatasetId(null), false);
});

// ----- resolveTargets dispatches NEMAR ----------------------------

test('resolveTargets: nm-prefixed dataset → kind=nemar with params', () => {
  const t = BIDSRecording.resolveTargets(new URLSearchParams({
    dataset: 'nm000135', sub: '1', ses: '0train',
    task: 'imagery', run: '0', ext: 'bdf',
  }));
  assert.equal(t.kind, 'nemar');
  assert.equal(t.nemar_params.dataset, 'nm000135');
  assert.equal(t.nemar_params.ext, 'bdf');
});

test('resolveTargets: on-prefixed (OpenNeuro mirror) → kind=nemar too', () => {
  const t = BIDSRecording.resolveTargets(new URLSearchParams({
    dataset: 'on005262', sub: '01', task: 'rest', ext: 'edf',
  }));
  // on* datasets use the same data.nemar.org backing as nm* — same
  // loader, same URL grammar, same return shape. Only the id prefix
  // distinguishes the upstream sourcing pipeline.
  assert.equal(t.kind, 'nemar');
  assert.equal(t.nemar_params.dataset, 'on005262');
});

test('resolveTargets: ds-prefixed dataset → kind=bids-path (unchanged)', () => {
  const t = BIDSRecording.resolveTargets(new URLSearchParams({
    dataset: 'ds002893', sub: '001', task: 'AuditoryVisualShift', run: '01', ext: 'set',
  }));
  assert.equal(t.kind, 'bids-path');
  assert.ok(t.eeg_url.endsWith('/sub-001_task-AuditoryVisualShift_run-01_eeg.set'));
});

// ----- loadNemarRecording (with stubbed fetch) -------------------

// Build a data.nemar.org manifest shaped like the live API returns:
// a flat array of {path,size,checksum_algorithm,checksum,url}. The
// loader only consumes `path` (for lookup) and `url` (for fetching).
// We mix git-tree-backed sidecars (raw.githubusercontent.com) with
// annex-backed binaries (nemar.s3.*.amazonaws.com presigned) — both
// shapes appear in real manifests and have separate trust-boundary
// validations.
function bdfManifest(dsId = 'nm000135', dir = 'sub-1/ses-0train/eeg/', prefix = 'sub-1_ses-0train_task-imagery_run-0') {
  const annex = (relpath, sha, sizeBytes) =>
    `https://nemar.s3.us-east-2.amazonaws.com/${dsId}/objects/SHA256E-s${sizeBytes}--${sha}.${relpath.split('.').pop()}` +
    `?X-Amz-Expires=3600&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=stub`;
  const gitTree = (relpath) =>
    `https://raw.githubusercontent.com/nemarDatasets/${dsId}/v1.0.0/${relpath}`;
  return [
    {
      path: `${dir}${prefix}_eeg.bdf`,
      size: 5540660,
      checksum_algorithm: 'sha256',
      checksum: 'd0dd7b7972a5f510a4f2c8991433e308d4bf4bb6d3',
      url: annex(`${dir}${prefix}_eeg.bdf`, 'd0dd7b7972a5f510a4f2c8991433e308d4bf4bb6d3', 5540660),
    },
    // Sidecars at the deepest level — all served from git (small enough)
    {
      path: `${dir}${prefix}_eeg.json`,
      size: 240, checksum_algorithm: 'git', checksum: 'abc1',
      url: gitTree(`${dir}${prefix}_eeg.json`),
    },
    {
      path: `${dir}${prefix}_channels.tsv`,
      size: 180, checksum_algorithm: 'git', checksum: 'abc2',
      url: gitTree(`${dir}${prefix}_channels.tsv`),
    },
    {
      path: `${dir}${prefix}_events.tsv`,
      size: 90, checksum_algorithm: 'git', checksum: 'abc3',
      url: gitTree(`${dir}${prefix}_events.tsv`),
    },
    // dataset_description.json at the root — exercises the inheritance
    // walk's `bare suffix at root` rule, plus the #510 fix that ensures
    // small git-tree root files actually land in the manifest.
    {
      path: 'dataset_description.json',
      size: 460, checksum_algorithm: 'git', checksum: 'abc4',
      url: gitTree('dataset_description.json'),
    },
  ];
}

const SIDECAR_TEXTS = {
  '_eeg.json':     JSON.stringify({ SamplingFrequency: 512, RecordingDuration: 600 }),
  '_channels.tsv': 'name\ttype\tunits\nFp1\tEEG\tµV\nFp2\tEEG\tµV\n',
  '_events.tsv':   'onset\tduration\ttrial_type\n1.0\t0.5\tcue\n',
};

// Install a stub fetch on globalThis for the duration of a test, then
// restore the original in a try/finally so other tests aren't poisoned.
async function withStubFetch(stub, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

// Build a stub fetch that serves:
//  - the manifest URL with the given JSON
//  - any raw.githubusercontent.com sidecar URL with the text whose
//    suffix matches the URL path (lets us share one stub across cases)
//  - everything else → 404
function manifestStub(manifest, sidecarTexts = SIDECAR_TEXTS) {
  return async (url) => {
    const s = String(url);
    if (s.endsWith('/manifest.json')) {
      return { ok: true, status: 200, json: async () => manifest };
    }
    if (s.startsWith('https://raw.githubusercontent.com/')) {
      for (const [suffix, text] of Object.entries(sidecarTexts)) {
        if (s.endsWith(suffix)) {
          // HttpRange.fetchText reads response.text(); also needs `ok`.
          return { ok: true, status: 200, headers: new Headers(), text: async () => text };
        }
      }
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
}

test('loadNemarRecording: happy path returns full meta bundle', async () => {
  const seen = [];
  await withStubFetch(
    async (url, init) => {
      seen.push(String(url));
      return manifestStub(bdfManifest())(url, init);
    },
    async () => {
      const meta = await BIDSRecording.loadNemarRecording({
        dataset: 'nm000135', sub: '1', ses: '0train',
        task: 'imagery', run: '0', ext: 'bdf',
      });
      // Manifest fetched through the cdn-worker proxy (CORS bridge).
      assert.ok(seen[0].startsWith('https://cdn.eegdash.org/data/nm000135/latest/manifest.json'),
        `first fetch must be the cdn-proxied manifest, got ${seen[0]}`);
      // Annex-backed binary URL rewritten to the existing cdn /objects/
      // path — the presigned query string is dropped (the cdn-worker's
      // proxy is content-addressed → infinitely cacheable).
      assert.equal(
        meta.eeg_url,
        'https://cdn.eegdash.org/nm000135/objects/' +
        'SHA256E-s5540660--d0dd7b7972a5f510a4f2c8991433e308d4bf4bb6d3.bdf'
      );
      assert.equal(meta.ext, 'bdf');
      // Sidecar values came through the git-tree fast path.
      assert.equal(meta.eeg_json.sampling_frequency, 512);
      assert.equal(meta.eeg_json.recording_duration, 600);
      assert.equal(meta.channels.length, 2);
      assert.equal(meta.channels[0].name, 'Fp1');
      assert.equal(meta.events.length, 1);
      assert.equal(meta.events[0].label, 'cue');
      // sibling_urls: same-directory entries, keyed by filename. The
      // raw .bdf appears here too because it's a same-dir entry.
      assert.equal(typeof meta.sibling_urls, 'object');
      assert.equal(
        meta.sibling_urls['sub-1_ses-0train_task-imagery_run-0_eeg.bdf'],
        meta.eeg_url
      );
      // Git-tree sidecars surface their raw.githubusercontent.com URL
      // in provenance — clearer than the old opaque `inline:` tag.
      assert.ok(meta.sidecar_sources.eeg_json.startsWith('https://raw.githubusercontent.com/nemarDatasets/'),
        `expected raw.githubusercontent URL in provenance, got ${meta.sidecar_sources.eeg_json}`);
    }
  );
});

test('loadNemarRecording: 404 manifest → actionable "unpublished/private" error', async () => {
  await withStubFetch(
    async () => ({ ok: false, status: 404, text: async () => 'not found' }),
    async () => {
      await assert.rejects(
        () => BIDSRecording.loadNemarRecording({
          dataset: 'nm999999', sub: '1', task: 'x', ext: 'edf',
        }),
        /manifest 404 for nm999999.*unpublished, private, or has no minted version/
      );
    }
  );
});

test('loadNemarRecording: 5xx manifest surfaces HTTP status', async () => {
  await withStubFetch(
    async () => ({ ok: false, status: 503, text: async () => 'svc down' }),
    async () => {
      await assert.rejects(
        () => BIDSRecording.loadNemarRecording({
          dataset: 'nm000135', sub: '1', ses: '0train',
          task: 'imagery', run: '0', ext: 'bdf',
        }),
        /NEMAR manifest HTTP 503/
      );
    }
  );
});

test('loadNemarRecording: missing entry for the requested BIDS path → actionable error', async () => {
  const manifest = bdfManifest();
  // Drop the raw binary entry to simulate "URL params don't match a real recording".
  const filtered = manifest.filter(e => !e.path.endsWith('_eeg.bdf'));
  await withStubFetch(
    manifestStub(filtered),
    async () => {
      await assert.rejects(
        () => BIDSRecording.loadNemarRecording({
          dataset: 'nm000135', sub: '1', ses: '0train',
          task: 'imagery', run: '0', ext: 'bdf',
        }),
        /manifest has no entry for sub-1\/ses-0train\/eeg\/sub-1_ses-0train_task-imagery_run-0_eeg\.bdf/
      );
    }
  );
});

test('loadNemarRecording: rejects manifest url pointing at an unknown host (trust boundary)', async () => {
  const manifest = bdfManifest();
  manifest[0].url = 'https://attacker.example.com/whatever.bdf';
  await withStubFetch(
    manifestStub(manifest),
    async () => {
      await assert.rejects(
        () => BIDSRecording.loadNemarRecording({
          dataset: 'nm000135', sub: '1', ses: '0train',
          task: 'imagery', run: '0', ext: 'bdf',
        }),
        /url has unrecognised shape.*attacker\.example\.com/
      );
    }
  );
});

test('loadNemarRecording: rejects annex url whose dataset id does not match the request', async () => {
  const manifest = bdfManifest();
  // Right shape, wrong dataset id in the path — guards against a
  // compromised manifest that points the viewer at someone else's bucket.
  manifest[0].url = manifest[0].url.replace('/nm000135/', '/nm999999/');
  await withStubFetch(
    manifestStub(manifest),
    async () => {
      await assert.rejects(
        () => BIDSRecording.loadNemarRecording({
          dataset: 'nm000135', sub: '1', ses: '0train',
          task: 'imagery', run: '0', ext: 'bdf',
        }),
        /unrecognised shape/
      );
    }
  );
});

test('loadNemarRecording: on-prefixed dataset uses the same loader path', async () => {
  const manifest = bdfManifest('on005262', 'sub-01/eeg/', 'sub-01_task-rest');
  // Override sidecar text for a different prefix.
  const texts = {
    '_eeg.json':     JSON.stringify({ SamplingFrequency: 1000, RecordingDuration: 120 }),
    '_channels.tsv': 'name\ttype\nA1\tEEG\n',
    '_events.tsv':   'onset\tduration\n0\t0\n',
  };
  await withStubFetch(
    manifestStub(manifest, texts),
    async () => {
      const meta = await BIDSRecording.loadNemarRecording({
        dataset: 'on005262', sub: '01', task: 'rest', ext: 'bdf',
      });
      assert.ok(meta.eeg_url.startsWith('https://cdn.eegdash.org/on005262/objects/'));
      assert.equal(meta.eeg_json.sampling_frequency, 1000);
    }
  );
});

test('loadNemarRecording: BrainVision .vhdr exposes .eeg in sibling_urls', async () => {
  // .vhdr + .eeg are both annex-backed (large enough to clear the
  // git-tree threshold) and live in the same directory. The format
  // reader looks up the .eeg by bare filename.
  const dsId = 'nm000166';
  const dir = 'sub-021/ses-02/eeg/';
  const prefix = 'sub-021_ses-02_task-ssvepSA';
  const annex = (basename, sha, sizeBytes) =>
    `https://nemar.s3.us-east-2.amazonaws.com/${dsId}/objects/SHA256E-s${sizeBytes}--${sha}.${basename.split('.').pop()}` +
    `?X-Amz-Signature=stub`;
  const manifest = [
    {
      path: `${dir}${prefix}_eeg.vhdr`,
      size: 1804, checksum_algorithm: 'sha256',
      checksum: 'cd0a44fbaa04d7a4f2ebd85e103ebf7a53c38a120fa73',
      url: annex('eeg.vhdr', 'cd0a44fbaa04d7a4f2ebd85e103ebf7a53c38a120fa73', 1804),
    },
    {
      path: `${dir}${prefix}_eeg.eeg`,
      size: 2048000, checksum_algorithm: 'sha256',
      checksum: '14c9cde57ad4674a3f7f2c8a25b4ddd7077d68306c',
      url: annex('eeg.eeg', '14c9cde57ad4674a3f7f2c8a25b4ddd7077d68306c', 2048000),
    },
  ];
  await withStubFetch(
    manifestStub(manifest),
    async () => {
      const meta = await BIDSRecording.loadNemarRecording({
        dataset: dsId, sub: '021', ses: '02', task: 'ssvepSA', ext: 'vhdr',
      });
      // sibling_urls keyed by filename (what BrainVision's DataFile carries).
      const eegFilename = `${prefix}_eeg.eeg`;
      assert.equal(
        meta.sibling_urls[eegFilename],
        `https://cdn.eegdash.org/${dsId}/objects/SHA256E-s2048000--14c9cde57ad4674a3f7f2c8a25b4ddd7077d68306c.eeg`
      );
      assert.ok(meta.eeg_url.endsWith('.vhdr'));
      assert.ok(meta.eeg_url.startsWith(`https://cdn.eegdash.org/${dsId}/objects/`));
    }
  );
});

test('loadNemarRecording: rejects malformed version param (defense-in-depth)', async () => {
  // The cdn-worker's VALID_NEMAR_API regex enforces the shape too,
  // but we validate at the call site so ?direct=1 (which bypasses the
  // worker) still rejects path-traversal attempts cleanly.
  // Empty/undefined fall through to the 'latest' default — that's
  // intentional, not a validation failure. The cases below are values
  // a user could plausibly type into ?version=.
  for (const bad of ['..', '../v1.0.0', 'latest/../foo', 'v1.0', 'V1.0.0', '1.0.0']) {
    await assert.rejects(
      () => BIDSRecording.loadNemarRecording({
        dataset: 'nm000135', sub: '1', task: 'imagery', ext: 'bdf',
        version: bad,
      }),
      /version param.*invalid/,
      `expected "${bad}" to be rejected`
    );
  }
});

test('loadNemarRecording: accepts latest and vX.Y.Z version shapes', async () => {
  for (const good of ['latest', 'v1.0.0', 'v12.34.56']) {
    let seenUrl = null;
    await withStubFetch(
      async (url) => {
        seenUrl = String(url);
        // Short-circuit: return a 404 so the test doesn't depend on
        // matching manifest content. Reaching the fetch proves
        // validation passed.
        return { ok: false, status: 404, text: async () => 'nf' };
      },
      async () => {
        await assert.rejects(
          () => BIDSRecording.loadNemarRecording({
            dataset: 'nm000135', sub: '1', task: 'imagery', ext: 'bdf',
            version: good,
          }),
          /manifest 404/
        );
        assert.ok(seenUrl && seenUrl.includes(`/${good}/manifest.json`),
          `expected version "${good}" in URL, got ${seenUrl}`);
      }
    );
  }
});

test('loadNemarRecording: rejects manifest with Content-Length above 32MB cap', async () => {
  await withStubFetch(
    async () => ({
      ok: true, status: 200,
      headers: new Headers({ 'content-length': String(50 * 1024 * 1024) }),
      json: async () => [],
    }),
    async () => {
      await assert.rejects(
        () => BIDSRecording.loadNemarRecording({
          dataset: 'nm000135', sub: '1', task: 'imagery', ext: 'bdf',
        }),
        /refusing to parse.*likely corrupt/
      );
    }
  );
});

test('loadNemarRecording: surfaces JSON parse failure with actionable message', async () => {
  await withStubFetch(
    async () => ({
      ok: true, status: 200,
      headers: new Headers(),
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    }),
    async () => {
      await assert.rejects(
        () => BIDSRecording.loadNemarRecording({
          dataset: 'nm000135', sub: '1', task: 'imagery', ext: 'bdf',
        }),
        /not valid JSON.*Upstream may be misconfigured/
      );
    }
  );
});

test('loadNemarRecording: rejects git-tree URL pointing at a different dataset repo', async () => {
  // Manifest entry's URL is well-formed git-tree, but the GitHub repo
  // segment names a different dataset. Without the tightened dsId
  // check, a hostile manifest could siphon viewer fetches to a repo
  // the user didn't ask for.
  const manifest = bdfManifest();
  manifest[1].url = 'https://raw.githubusercontent.com/nemarDatasets/nm999999/v1.0.0/sub-1/ses-0train/eeg/sub-1_ses-0train_task-imagery_run-0_eeg.json';
  await withStubFetch(
    manifestStub(manifest),
    async () => {
      const meta = await BIDSRecording.loadNemarRecording({
        dataset: 'nm000135', sub: '1', ses: '0train',
        task: 'imagery', run: '0', ext: 'bdf',
      });
      // Sidecar load skipped (URL fails trust check) — eeg_json falls
      // back to the format-header default. No crash, no cross-dataset fetch.
      assert.equal(meta.eeg_json.sampling_frequency, null);
      assert.equal(meta.sidecar_sources.eeg_json, null);
    }
  );
});

test('loadNemarRecording: parent-dir sidecar found via BIDS inheritance walk', async () => {
  // The per-recording _eeg.json is missing — the inheritance walk must
  // climb one directory level and pick up the subject-level sidecar at
  // `sub-01/sub-01_task-rest_eeg.json`. (The walk does not reach the
  // dataset root for typical sub/datatype paths; that gap is consistent
  // with the OpenNeuro loader and covered by the eegdash fallback for
  // OpenNeuro datasets. NEMAR has no equivalent fallback.)
  const dsId = 'on005262';
  const recDir = 'sub-01/eeg/';
  const prefix = 'sub-01_task-rest';
  const annex = `https://nemar.s3.us-east-2.amazonaws.com/${dsId}/objects/SHA256E-s100--abc.edf?X-Amz-Signature=stub`;
  const manifest = [
    {
      path: `${recDir}${prefix}_eeg.edf`,
      size: 100, checksum_algorithm: 'sha256', checksum: 'abc', url: annex,
    },
    // No deepest-level _eeg.json — only a subject-level one one dir up.
    {
      path: `sub-01/${prefix}_eeg.json`,
      size: 120, checksum_algorithm: 'git', checksum: 'parenteeg',
      url: `https://raw.githubusercontent.com/nemarDatasets/${dsId}/v1.0.0/sub-01/${prefix}_eeg.json`,
    },
  ];
  const texts = {
    '_eeg.json': JSON.stringify({ SamplingFrequency: 250, RecordingDuration: 90 }),
  };
  await withStubFetch(
    manifestStub(manifest, texts),
    async () => {
      const meta = await BIDSRecording.loadNemarRecording({
        dataset: dsId, sub: '01', task: 'rest', ext: 'edf',
      });
      assert.equal(meta.eeg_json.sampling_frequency, 250);
      assert.ok(meta.sidecar_sources.eeg_json.endsWith(`/sub-01/${prefix}_eeg.json`),
        `expected parent-dir sidecar in provenance, got ${meta.sidecar_sources.eeg_json}`);
    }
  );
});
