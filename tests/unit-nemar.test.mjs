// Unit tests for the NEMAR recording loader in bids-recording.js.
// NEMAR records are addressed by SHA git-annex keys, not BIDS paths,
// and need a single eegdash records API call to materialise a viewer-
// ready metadata bundle. Tests cover the happy path, missing record,
// missing annex key, the inline-sidecar inheritance walk, and the
// .vhdr→.eeg sibling URL synthesis BrainVision relies on.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BIDSRecording, BrainVisionReader } from './_bootstrap.mjs';

// ----- isNemarDatasetId -------------------------------------------

test('isNemarDatasetId: matches exactly nm + 6 digits (matches the cdn-worker regex)', () => {
  assert.equal(BIDSRecording.isNemarDatasetId('nm000131'), true);
  assert.equal(BIDSRecording.isNemarDatasetId('nm000001'), true);
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

test('resolveTargets: ds-prefixed dataset → kind=bids-path (unchanged)', () => {
  const t = BIDSRecording.resolveTargets(new URLSearchParams({
    dataset: 'ds002893', sub: '001', task: 'AuditoryVisualShift', run: '01', ext: 'set',
  }));
  assert.equal(t.kind, 'bids-path');
  assert.ok(t.eeg_url.endsWith('/sub-001_task-AuditoryVisualShift_run-01_eeg.set'));
});

// ----- loadNemarRecording (with stubbed fetch) -------------------

// Build a minimal records-API response shaped like data.eegdash.org
// returns. The resolver only reads `data[0].storage.{base,raw_key,
// annex_keys,sidecar_inline}`, so we keep the rest of the document
// minimal (real responses carry many more keys we ignore).
function bdfRecordResponse() {
  return {
    success: true,
    data: [{
      dataset: 'nm000135',
      bidspath: 'nm000135/sub-1/ses-0train/eeg/sub-1_ses-0train_task-imagery_run-0_eeg.bdf',
      storage: {
        backend: 'nemar',
        base: 's3://nemar/nm000135',
        raw_key: 'sub-1/ses-0train/eeg/sub-1_ses-0train_task-imagery_run-0_eeg.bdf',
        dep_keys: [
          'sub-1/ses-0train/eeg/sub-1_ses-0train_task-imagery_run-0_channels.tsv',
          'sub-1/ses-0train/eeg/sub-1_ses-0train_task-imagery_run-0_events.tsv',
          'sub-1/ses-0train/eeg/sub-1_ses-0train_task-imagery_run-0_eeg.json',
        ],
        annex_keys: {
          'sub-1/ses-0train/eeg/sub-1_ses-0train_task-imagery_run-0_eeg.bdf':
            'SHA256E-s5540660--d0dd7b7972a5f510a4f2c8991433e308d4bf4bb6d3.bdf',
        },
        sidecar_inline: {
          'sub-1/ses-0train/eeg/sub-1_ses-0train_task-imagery_run-0_eeg.json':
            JSON.stringify({ SamplingFrequency: 512, RecordingDuration: 600 }),
          'sub-1/ses-0train/eeg/sub-1_ses-0train_task-imagery_run-0_channels.tsv':
            'name\ttype\tunits\nFp1\tEEG\tµV\nFp2\tEEG\tµV\n',
          'sub-1/ses-0train/eeg/sub-1_ses-0train_task-imagery_run-0_events.tsv':
            'onset\tduration\ttrial_type\n1.0\t0.5\tcue\n',
        },
      },
    }],
  };
}

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

test('loadNemarRecording: happy path returns full meta bundle', async () => {
  let calledUrl = null;
  await withStubFetch(
    async (url) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => bdfRecordResponse() };
    },
    async () => {
      const meta = await BIDSRecording.loadNemarRecording({
        dataset: 'nm000135', sub: '1', ses: '0train',
        task: 'imagery', run: '0', ext: 'bdf',
      });
      // URL was constructed against the records endpoint with the
      // bidspath filter — that uniqueness guarantee is what lets us
      // call &limit=1 without a tiebreaker.
      assert.ok(calledUrl.includes('/api/eegdash/records?filter='));
      assert.ok(decodeURIComponent(calledUrl).includes('"bidspath":"nm000135/sub-1/'));
      // SHA-keyed URL routed through cdn.eegdash.org (the worker
      // proxies to nemar.s3.amazonaws.com and adds the CORS layer
      // that NEMAR's S3 lacks).
      assert.equal(
        meta.eeg_url,
        'https://cdn.eegdash.org/nm000135/objects/' +
        'SHA256E-s5540660--d0dd7b7972a5f510a4f2c8991433e308d4bf4bb6d3.bdf'
      );
      assert.equal(meta.ext, 'bdf');
      assert.equal(meta.eeg_json.sampling_frequency, 512);
      assert.equal(meta.eeg_json.recording_duration, 600);
      assert.equal(meta.channels.length, 2);
      assert.equal(meta.channels[0].name, 'Fp1');
      assert.equal(meta.events.length, 1);
      assert.equal(meta.events[0].label, 'cue');
      // sibling_urls keyed by *filename* so format readers can do a
      // direct lookup against the value the .vhdr / .set header carries.
      assert.equal(typeof meta.sibling_urls, 'object');
      assert.equal(
        meta.sibling_urls['sub-1_ses-0train_task-imagery_run-0_eeg.bdf'],
        meta.eeg_url
      );
      // sidecar_sources prefixed with 'inline:' to differentiate from
      // OpenNeuro's https URLs (renderProvenance treats both uniformly
      // as opaque source labels).
      assert.ok(meta.sidecar_sources.eeg_json.startsWith('inline:'));
    }
  );
});

test('loadNemarRecording: empty data array → actionable error', async () => {
  await withStubFetch(
    async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) }),
    async () => {
      await assert.rejects(
        () => BIDSRecording.loadNemarRecording({
          dataset: 'nm999999', sub: '1', task: 'x', ext: 'edf',
        }),
        /NEMAR record not found.*nm999999/
      );
    }
  );
});

test('loadNemarRecording: missing annex_keys[raw_key] → actionable error', async () => {
  const resp = bdfRecordResponse();
  resp.data[0].storage.annex_keys = {};
  await withStubFetch(
    async () => ({ ok: true, status: 200, json: async () => resp }),
    async () => {
      await assert.rejects(
        () => BIDSRecording.loadNemarRecording({
          dataset: 'nm000135', sub: '1', ses: '0train',
          task: 'imagery', run: '0', ext: 'bdf',
        }),
        /no annex_keys entry/
      );
    }
  );
});

test('loadNemarRecording: API HTTP error surfaces status code', async () => {
  await withStubFetch(
    async () => ({ ok: false, status: 503, json: async () => ({}) }),
    async () => {
      await assert.rejects(
        () => BIDSRecording.loadNemarRecording({
          dataset: 'nm000135', sub: '1', ses: '0train',
          task: 'imagery', run: '0', ext: 'bdf',
        }),
        /NEMAR records API 503/
      );
    }
  );
});

test('loadNemarRecording: rejects unknown S3 bucket in storage.base', async () => {
  const resp = bdfRecordResponse();
  resp.data[0].storage.base = 's3://attacker.com/whatever';
  await withStubFetch(
    async () => ({ ok: true, status: 200, json: async () => resp }),
    async () => {
      await assert.rejects(
        () => BIDSRecording.loadNemarRecording({
          dataset: 'nm000135', sub: '1', ses: '0train',
          task: 'imagery', run: '0', ext: 'bdf',
        }),
        /unknown S3 bucket: attacker\.com/
      );
    }
  );
});

test('loadNemarRecording: rejects annex_keys value with unexpected charset', async () => {
  const resp = bdfRecordResponse();
  resp.data[0].storage.annex_keys[resp.data[0].storage.raw_key] = 'SHA256E-s1--abc/../escape';
  await withStubFetch(
    async () => ({ ok: true, status: 200, json: async () => resp }),
    async () => {
      await assert.rejects(
        () => BIDSRecording.loadNemarRecording({
          dataset: 'nm000135', sub: '1', ses: '0train',
          task: 'imagery', run: '0', ext: 'bdf',
        }),
        /unexpected charset/
      );
    }
  );
});

test('loadNemarRecording: BrainVision .vhdr exposes .eeg in sibling_urls', async () => {
  const resp = {
    success: true,
    data: [{
      dataset: 'nm000166',
      bidspath: 'nm000166/sub-021/ses-02/eeg/sub-021_ses-02_task-ssvepSA_eeg.vhdr',
      storage: {
        backend: 'nemar',
        base: 's3://nemar/nm000166',
        raw_key: 'sub-021/ses-02/eeg/sub-021_ses-02_task-ssvepSA_eeg.vhdr',
        dep_keys: [
          'sub-021/ses-02/eeg/sub-021_ses-02_task-ssvepSA_eeg.eeg',
          'sub-021/ses-02/eeg/sub-021_ses-02_task-ssvepSA_eeg.vmrk',
        ],
        annex_keys: {
          'sub-021/ses-02/eeg/sub-021_ses-02_task-ssvepSA_eeg.vhdr':
            'SHA256E-s1804--cd0a44fbaa04d7a4f2ebd85e103ebf7a53c38a120fa73.vhdr',
          'sub-021/ses-02/eeg/sub-021_ses-02_task-ssvepSA_eeg.eeg':
            'SHA256E-s2048000--14c9cde57ad4674a3f7f2c8a25b4ddd7077d68306c.eeg',
        },
        sidecar_inline: {},
      },
    }],
  };
  await withStubFetch(
    async () => ({ ok: true, status: 200, json: async () => resp }),
    async () => {
      const meta = await BIDSRecording.loadNemarRecording({
        dataset: 'nm000166', sub: '021', ses: '02', task: 'ssvepSA', ext: 'vhdr',
      });
      // sibling_urls keyed by filename (what the .vhdr's `DataFile`
      // field carries) — BrainVision reader does a direct lookup.
      const eegFilename = 'sub-021_ses-02_task-ssvepSA_eeg.eeg';
      assert.equal(
        meta.sibling_urls[eegFilename],
        'https://cdn.eegdash.org/nm000166/objects/' +
        'SHA256E-s2048000--14c9cde57ad4674a3f7f2c8a25b4ddd7077d68306c.eeg'
      );
      // The .vhdr URL itself is meta.eeg_url, also routed via CDN.
      assert.ok(meta.eeg_url.endsWith('.vhdr'));
      assert.ok(meta.eeg_url.startsWith('https://cdn.eegdash.org/nm000166/objects/'));
    }
  );
});
