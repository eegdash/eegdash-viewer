/* ============================================================
   bids-recording.js — fetch BIDS sidecars for a single EEG run
   straight from a static URL (e.g. OpenNeuro S3) and produce a
   uniform metadata object the format-specific binary readers
   consume. No backend, no auth.

   Sidecars covered (BIDS appendix):
     <prefix>_eeg.json          recording metadata (SamplingFrequency, …)
     <prefix>_channels.tsv      per-channel name/type/units/status
     <prefix>_events.tsv        events, BIDS-canonical
     <prefix>_electrodes.tsv    3D positions (delegated to bids-loader.js)
     <prefix>_coordsystem.json  coordinate space (delegated)

   URL grammar (in resolveTargets):
     ?eeg=<https://…/<prefix>_eeg.<ext>>
       → derive every sidecar from the basename.
     ?dataset=ds00XXXX&sub=01&ses=01&task=rest&run=01&ext=set
       → assemble the OpenNeuro S3 URL from BIDS path conventions.
     ?demo=<fixture-id>
       → look up a small bundled fixture under test-data/.

   Inheritance principle (BIDS): JSON/TSV metadata may live at any
   directory level above the raw file, with deeper files overriding
   shallower ones, and entity prefixes may be progressively stripped.
   We walk the tree from deepest → root and take the first hit per
   sidecar. Bound the walk at 3 dir levels up (covers sub/ses/eeg →
   sub → root, the only legal BIDS depths) so a malformed URL can't
   wander into the bucket root. Documented gap: when the same sidecar
   exists at multiple levels we don't merge fields, we just take the
   deepest — full BIDS merge is out of scope for v1.
   ============================================================ */
(function () {
  'use strict';

  const api = {};

  // Sidecar fetching delegates to HttpRange so the inheritance walk
  // works uniformly over real HTTPS URLs (force-cache on immutable
  // OpenNeuro buckets) and drag-dropped local Blobs (registered with
  // a synthetic localdrop.invalid URL).
  const fetchTextOrNull = HttpRange.fetchTextOrNull;

  // ---- URL plumbing -------------------------------------------
  // Strip the trailing _{suffix}.<ext> off the filename so we get the
  // BIDS entity prefix the sidecars share, e.g.
  //   sub-01_ses-01_task-rest_run-01_eeg.set
  //     → sub-01_ses-01_task-rest_run-01
  // Supports _eeg, _ieeg, _emg, and other electrophysiology suffixes.
  // Returns { dir, prefix, ext, suffix } where dir always ends with '/'.
  api.parsePhysioUrl = function (physioUrl) {
    // Primary: BIDS canonical `<prefix>_{suffix}.<ext>` form.
    // Matches any suffix (eeg, ieeg, emg, meg, nirs, etc.)
    const m = /^(.*\/)([^/]+?)_(eeg|ieeg|emg|meg|nirs)\.([A-Za-z0-9+]+)$/.exec(physioUrl);
    if (m) return { dir: m[1], prefix: m[2], suffix: m[3], ext: m[4].toLowerCase() };
    // Fallback: a known format file that omits the BIDS suffix
    // (e.g. local test fixtures and demo files). Sidecar inheritance will
    // find nothing at these synthetic paths — the format reader extracts
    // everything it needs from the binary header.
    const KNOWN_EXT = /\.(edf|bdf|set|vhdr|fif|fiff|snirf)$/i;
    const m2 = /^(.*\/)([^/]+)$/.exec(physioUrl);
    if (m2 && KNOWN_EXT.test(m2[2])) {
      const dot = m2[2].lastIndexOf('.');
      return { dir: m2[1], prefix: m2[2].slice(0, dot), suffix: 'eeg', ext: m2[2].slice(dot + 1).toLowerCase() };
    }
    throw new Error(`URL is not a BIDS *_{suffix}.<ext> path: ${physioUrl}`);
  };

  // Backward compatibility: parseEegUrl now delegates to parsePhysioUrl
  api.parseEegUrl = function (eegUrl) {
    return api.parsePhysioUrl(eegUrl);
  };

  // Read once at module load — ?direct=1 is a startup flag, not a
  // hot-toggle. globalThis.location is undefined in worker / Node tests.
  const _DIRECT_S3 =
    typeof globalThis.location !== 'undefined' &&
    new URLSearchParams(globalThis.location.search).has('direct');

  // BIDS-relative path of a _{suffix}.<ext> recording. Same shape across
  // OpenNeuro (gets a bucket prefixed) and NEMAR (used as the unique
  // bidspath filter against the eegdash records API). Lifted out so
  // both call sites stay in lockstep when BIDS path conventions evolve.
  // Suffix defaults to 'eeg' but supports 'ieeg', 'emg', 'meg', 'nirs', etc.
  function buildBidsRelpath(params, suffix) {
    const ds   = required(params, 'dataset');
    const sub  = required(params, 'sub');
    const ses  = params.ses || null;
    const task = params.task || null;
    const run  = params.run || null;
    const ext  = (params.ext || 'set').toLowerCase();
    const suf  = (suffix || 'eeg').toLowerCase();
    // Map suffix to BIDS datatype directory
    const datatypeMap = {
      'eeg': 'eeg',
      'ieeg': 'ieeg',
      'emg': 'emg',
      'meg': 'meg',
      'nirs': 'nirs'
    };
    const datatype = datatypeMap[suf] || suf;
    const segs = [ds, `sub-${sub}`];
    if (ses) segs.push(`ses-${ses}`);
    segs.push(datatype);
    let entities = `sub-${sub}`;
    if (ses)  entities += `_ses-${ses}`;
    if (task) entities += `_task-${task}`;
    if (run)  entities += `_run-${run}`;
    return `${segs.join('/')}/${entities}_${suf}.${ext}`;
  }

  // BIDS path convention on OpenNeuro:
  //   <bucket>/<dataset>/sub-<X>/[ses-<Y>/]<datatype>/<entities>_{suffix}.<ext>
  // Used by ?dataset=&sub=&ses=&task=&run=&ext= form so eegdash dataset
  // pages can deep-link without spelling out the full S3 URL.
  // Supports ?suffix= parameter for ieeg, emg, meg, nirs (defaults to eeg).
  //
  // Default: route through cdn.eegdash.org — Cloudflare Worker proxy
  // that caches OpenNeuro S3 byte-ranges at the global edge.
  // Measured cold-cache vs raw S3 (see docs/streaming-and-cdn-study.md
  // and cdn-worker/): TTFB 41-61 ms vs 333-460 ms (~10× faster), total
  // 77-176 ms vs 946-2622 ms (~13× faster), throughput 6-14 MB/s vs
  // 0.4-1.1 MB/s (~10× higher) for the same byte ranges.
  //
  // Override with ?direct=1 to force raw S3 (debugging, or in case of
  // CDN outage / caching surprise).
  api.buildOpenNeuroEegUrl = function (params) {
    const bucket = _DIRECT_S3
      ? 'https://s3.amazonaws.com/openneuro.org'
      : 'https://cdn.eegdash.org';
    const suffix = params.suffix || 'eeg';
    return `${bucket}/${buildBidsRelpath(params, suffix)}`;
  };

  function required(params, key) {
    const v = params[key];
    if (v == null || v === '') throw new Error(`missing required URL param: ${key}`);
    return String(v);
  }

  // ---- NEMAR ---------------------------------------------------
  // NEMAR (nm-prefixed datasets) hosts data on a public S3 bucket
  // (nemar in us-east-2) but addresses files by SHA-256 git-annex
  // keys, not BIDS paths. The {bidsRelpath → SHA-key} map and the
  // text sidecars all live in the eegdash records API, so a single
  // /api/eegdash/records?filter=… call gives us:
  //   storage.annex_keys[bidsRelpath]   → SHA key (binary lookup)
  //   storage.sidecar_inline[bidsRelpath] → UTF-8 sidecar text
  // We synthesise the S3 URL ourselves rather than asking the API
  // for it (the API doesn't currently expose a download endpoint;
  // bucket rule verified empirically against the public bucket).

  // Six-digit suffix matches the bucket's id convention and the
  // cdn-worker's VALID_NEMAR regex — the two MUST stay in lockstep
  // (a 5- or 7-digit id would be silently 404'd by the worker).
  api.isNemarDatasetId = function (id) {
    return typeof id === 'string' && /^nm\d{6}$/.test(id);
  };

  // Buckets the viewer is willing to construct S3 URLs for. Only the
  // ones we've explicitly tested + (for `nemar`) proxied through the
  // CDN. A storage.base pointing anywhere else is a trust-boundary
  // red flag — refuse it loudly rather than synthesising surprise URLs.
  const _NEMAR_BUCKET_ALLOWLIST = new Set(['nemar', 'nmdatasets']);

  // SHA git-annex keys are restricted to [A-Za-z0-9._-]+ by the cdn-
  // worker's VALID_NEMAR regex. Any value outside this charset would
  // either path-traverse, query-inject, or fail the worker's guard —
  // reject up-front so the symptom is a clear error, not a 404.
  const _ANNEX_KEY_SHAPE = /^[A-Za-z0-9._-]+$/;

  // Outside-the-CDN escape hatch (?direct=1). NEMAR's S3 has no CORS
  // configured, so the direct path only works from non-browser
  // contexts (Node tests, integration runners).
  function s3UriToHttpsPrefix(s3Uri) {
    const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(s3Uri || '');
    if (!m) throw new Error(`expected s3://bucket/path URI, got: ${s3Uri}`);
    const bucket = m[1];
    const key = m[2];
    if (!_NEMAR_BUCKET_ALLOWLIST.has(bucket)) {
      throw new Error(`refusing to synthesise URL for unknown S3 bucket: ${bucket}`);
    }
    if (bucket === 'nemar' && !_DIRECT_S3) {
      return `https://cdn.eegdash.org/${key}`;
    }
    return `https://${bucket}.s3.amazonaws.com/${key}`;
  }

  const _NEMAR_FETCH_TIMEOUT_MS = 15000;

  // Single-shot loader for NEMAR recordings. Returns a metadata
  // bundle in the same shape as loadRecordingMetadata (so the rest
  // of the viewer is format-agnostic), with one NEMAR-specific
  // addition: meta.sibling_urls (filename → URL) so format readers
  // with split layouts (BrainVision .vhdr+.eeg) can resolve the
  // sibling without doing path arithmetic against a SHA-keyed URL.
  // postMessage-safe: only plain JSON, no functions or closures.
  api.loadNemarRecording = async function (params) {
    const bidspath = buildBidsRelpath(params);
    const filter = encodeURIComponent(JSON.stringify({ bidspath }));
    const url = `${EEGDASH_BASE}/api/eegdash/records?filter=${filter}&limit=1`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), _NEMAR_FETCH_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(url, { signal: ctrl.signal });
    } catch (e) {
      const reason = e.name === 'AbortError'
        ? `timed out after ${_NEMAR_FETCH_TIMEOUT_MS}ms`
        : e.message;
      throw new Error(`NEMAR records API unreachable for ${bidspath}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      throw new Error(`NEMAR records API ${resp.status} for ${bidspath}`);
    }
    const json = await resp.json();
    const rec = json.data && json.data[0];
    if (!rec) {
      throw new Error(
        `NEMAR record not found in eegdash for ${bidspath}. ` +
        `Check the dataset/sub/ses/task/run/ext URL params match an ingested recording.`
      );
    }
    const storage = rec.storage || {};
    const rawKey = storage.raw_key;
    const annexKeys = storage.annex_keys || {};
    const inline = storage.sidecar_inline || {};

    if (!rawKey) {
      throw new Error(`NEMAR record missing storage.raw_key for ${bidspath}`);
    }

    const httpsPrefix = s3UriToHttpsPrefix(storage.base);

    const shaForRaw = annexKeys[rawKey];
    if (!shaForRaw) {
      throw new Error(
        `NEMAR record for ${bidspath} has no annex_keys entry for the raw file. ` +
        `The eegdash ingestion may not yet expose this recording's SHA mapping.`
      );
    }
    if (!_ANNEX_KEY_SHAPE.test(shaForRaw)) {
      throw new Error(`NEMAR annex_keys[${rawKey}] has unexpected charset: ${shaForRaw}`);
    }
    const eegUrl = `${httpsPrefix}/objects/${shaForRaw}`;

    // Pre-resolve every sibling the API has a SHA key for, keyed by
    // *filename* (not BIDS relpath) — that's what format readers see
    // in their headers (BrainVision .vhdr's `DataFile` is a bare
    // filename). One recording = one directory, so filename keys are
    // unique within the map.
    const sibling_urls = {};
    for (const [siblingRelpath, sha] of Object.entries(annexKeys)) {
      if (!_ANNEX_KEY_SHAPE.test(sha)) {
        throw new Error(`NEMAR annex_keys[${siblingRelpath}] has unexpected charset: ${sha}`);
      }
      const siblingFilename = siblingRelpath.split('/').pop();
      sibling_urls[siblingFilename] = `${httpsPrefix}/objects/${sha}`;
    }

    const ext = rawKey.slice(rawKey.lastIndexOf('.') + 1).toLowerCase() || (params.ext || '').toLowerCase();
    const lastSlash = rawKey.lastIndexOf('/');
    const dir = lastSlash >= 0 ? rawKey.slice(0, lastSlash + 1) : '';
    const basename = lastSlash >= 0 ? rawKey.slice(lastSlash + 1) : rawKey;
    const prefixMatch = /^(.+?)_eeg\.[^.]+$/.exec(basename);
    const prefix = prefixMatch ? prefixMatch[1] : basename.replace(/\.[^.]+$/, '');

    // Inline sidecars come from a hash, not the network — wrap each
    // hit as { text, url } so assembleRecordingMetadata sees the same
    // shape as the OpenNeuro path. The `inline:` URL prefix is what
    // renderProvenance shows in the UI.
    const inlineHit = (suffix) => {
      const text = pickInlineSidecar(inline, dir, prefix, suffix);
      return text != null ? { text, url: `inline:${rawKey}` } : null;
    };
    const hits = {
      eeg_json:    inlineHit('_eeg.json'),
      channels:    inlineHit('_channels.tsv'),
      events:      inlineHit('_events.tsv'),
      electrodes:  inlineHit('_electrodes.tsv'),
      coordsystem: inlineHit('_coordsystem.json'),
    };

    const meta = assembleRecordingMetadata({ eeg_url: eegUrl, ext, dir, prefix, hits });
    meta.sibling_urls = sibling_urls;
    return meta;
  };

  // Lookup of an inline sidecar by walking the same BIDS-inheritance
  // shape `fetchInheritedSidecar` walks. The eegdash server already
  // collapses overrides per-recording, so in practice the deepest
  // (per-recording) key is what's present — this loop is what
  // tolerates the 5% of datasets where overrides live shallower.
  function pickInlineSidecar(inline, dir, prefix, suffix) {
    for (const { paths } of eachInheritanceLevel(dir, prefix, suffix)) {
      for (const p of paths) {
        if (inline[p] != null) return inline[p];
      }
    }
    return null;
  }

  // ---- BIDS inheritance walk ----------------------------------
  // Generate every prefix shape that could legitimately host metadata
  // for this recording under BIDS inheritance. Two chains:
  //   1. Progressively drop entities from the right (run → task → ses).
  //      e.g. sub-01_ses-1_task-rest_run-1 → sub-01_ses-1_task-rest →
  //           sub-01_ses-1 → sub-01.
  //   2. Drop the leading `sub-…` (which carries no underscore prefix
  //      so the right-side strip never reaches it), then progressively
  //      drop from the right. This is what makes us find `task-X_eeg.json`
  //      sitting at the dataset root — the BIDS-canonical place to put
  //      task-level metadata that applies to every subject. Without it we
  //      miss the most common inheritance shape on real OpenNeuro data
  //      (e.g. ds002336).
  // Most-specific first so the walk's first hit is the deepest match.
  function entityVariants(prefix) {
    const tokens = tokenizePrefix(prefix);
    const out = new Set();
    if (prefix) out.add(prefix);
    // Chain 1
    for (let i = tokens.length - 1; i > 0; i--) {
      out.add(tokens.slice(0, i).join('_'));
    }
    // Chain 2 (leading-sub stripped)
    if (tokens.length && tokens[0].startsWith('sub-')) {
      const noSub = tokens.slice(1);
      for (let i = noSub.length; i > 0; i--) {
        out.add(noSub.slice(0, i).join('_'));
      }
    }
    return [...out].sort((a, b) => b.split('_').length - a.split('_').length);
  }

  // Split `sub-01_ses-1_task-rest` into ['sub-01', 'ses-1', 'task-rest'].
  // Falls back to `_`-split for unusual prefixes that don't begin with
  // `sub-`; those are rare in BIDS but we don't want to drop them silently.
  function tokenizePrefix(prefix) {
    if (!prefix) return [];
    const tokens = [];
    let rest = prefix;
    const head = /^(sub-[^_]+)/.exec(rest);
    if (head) {
      tokens.push(head[0]);
      rest = rest.slice(head[0].length);
    }
    while (rest.length) {
      const m = /^_([a-z]+-[^_]+)/i.exec(rest);
      if (!m) break;
      tokens.push(m[1]);
      rest = rest.slice(m[0].length);
    }
    if (!tokens.length) return prefix.split('_').filter(Boolean);
    return tokens;
  }

  // Generates the BIDS-inheritance probe order — for each directory
  // level (run dir → ses → sub → root), the candidate paths in
  // priority order (most-specific entity-stripped variants first,
  // then the bare suffix). Shared by the network-fetching walker
  // (fetchInheritedSidecar) and the inline-map walker NEMAR uses
  // (pickInlineSidecar) so both honour the same shape.
  function* eachInheritanceLevel(dir, prefix, suffix) {
    const variants = entityVariants(prefix);
    const bare = suffix.startsWith('_') ? suffix.substring(1) : suffix;
    let here = dir;
    for (let level = 0; level < 4; level++) {
      const paths = variants.map(v => `${here}${v}${suffix}`);
      paths.push(`${here}${bare}`);
      yield { here, paths, variants, bare };
      const parent = here.replace(/[^/]+\/$/, '');
      if (!parent || parent === here) break;
      here = parent;
    }
  }

  // At each directory level, fan out independent network probes
  // across all candidate paths and take the first non-null hit
  // (priority order preserved by walking results in the same order).
  async function fetchInheritedSidecar(dir, prefix, suffix) {
    let lastVariants, lastBare;
    for (const { paths, variants, bare } of eachInheritanceLevel(dir, prefix, suffix)) {
      lastVariants = variants; lastBare = bare;
      const results = await Promise.all(paths.map(fetchTextOrNull));
      for (let i = 0; i < results.length; i++) {
        if (results[i] != null) return { text: results[i], url: paths[i] };
      }
    }
    // Last resort: ask the eegdash backend for the dataset's known
    // sidecar inventory. Catches paths our entity-variant generator
    // didn't predict (acquisition-level files, dataset-specific naming).
    return eegdashFallback(dir, prefix, suffix, lastVariants, lastBare);
  }

  // ---- eegdash fallback ---------------------------------------
  // The eegdash FastAPI service at data.eegdash.org indexes every
  // OpenNeuro EEG dataset, including a `storage.dep_keys` listing of
  // every dataset-root sidecar. When our inheritance walk turns up
  // nothing for a sidecar, we query that record once (cached) and
  // look for a key whose filename matches one of our prefix variants
  // + suffix. If found, fetch the sidecar from OpenNeuro at the path
  // the eegdash record points us to.
  const EEGDASH_BASE = 'https://data.eegdash.org';
  const _eegdashCache = new Map();             // datasetId → record | null

  function openNeuroDatasetId(dir) {
    // Match either the raw S3 bucket OR the CDN proxy in front of it
    // (cdn.eegdash.org is a transparent edge cache for the same paths).
    const m = /^https?:\/\/(?:s3\.amazonaws\.com\/openneuro\.org|cdn\.eegdash\.org)\/([^/]+)\//.exec(dir);
    return m ? m[1] : null;
  }

  // Cache the in-flight Promise, not just the resolved record, so the
  // five sidecars doing Promise.all of inheritance walks coalesce on
  // a single eegdash request instead of stampeding it five times.
  function eegdashDataset(datasetId) {
    if (_eegdashCache.has(datasetId)) return _eegdashCache.get(datasetId);
    const p = (async () => {
      try {
        const r = await fetch(`${EEGDASH_BASE}/api/eegdash/datasets/${datasetId}`);
        if (!r.ok) return null;
        const json = await r.json();
        return json && json.data ? json.data : null;
      } catch (e) {
        // Network failure / CORS / DNS — silently skip, the OpenNeuro
        // walk has already had its chance and the format readers can
        // still fall back to the binary header.
        return null;
      }
    })();
    _eegdashCache.set(datasetId, p);
    return p;
  }

  async function eegdashFallback(dir, prefix, suffix, variants, bare) {
    const datasetId = openNeuroDatasetId(dir);
    if (!datasetId) return null;
    const record = await eegdashDataset(datasetId);
    const depKeys = record && record.storage && record.storage.dep_keys;
    if (!Array.isArray(depKeys) || !depKeys.length) return null;
    // Most-specific first: same priority as the inheritance walk.
    const wanted = variants.map(v => `${v}${suffix}`).concat([bare]);
    for (const filename of wanted) {
      const key = depKeys.find(k => k === filename || k.endsWith(`/${filename}`));
      if (!key) continue;
      const url = `https://s3.amazonaws.com/openneuro.org/${datasetId}/${key}`;
      const text = await fetchTextOrNull(url);
      if (text != null) return { text, url };
    }
    return null;
  }

  // ---- _eeg.json ----------------------------------------------
  // Required field per BIDS: SamplingFrequency. Everything else is
  // recorded for display but not load-bearing. We also pass through
  // unknown keys so dataset-specific extensions stay visible.
  api.parseEegJson = function (obj) {
    if (!obj || typeof obj !== 'object') throw new Error('_eeg.json is not an object');
    const fs = obj.SamplingFrequency;
    if (!isFinite(fs) || fs <= 0) {
      throw new Error(`_eeg.json: SamplingFrequency must be a positive number (got ${fs})`);
    }
    return {
      sampling_frequency: fs,
      recording_duration: numericOrNull(obj.RecordingDuration),
      eeg_reference: obj.EEGReference || null,
      power_line_frequency: numericOrNull(obj.PowerLineFrequency),
      software_filters: obj.SoftwareFilters || null,
      manufacturer: obj.Manufacturer || null,
      raw: obj,
    };
  };

  function numericOrNull(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  // ---- _channels.tsv ------------------------------------------
  // Columns: name, type, units, status (status_description), low_cutoff,
  // high_cutoff, sampling_frequency are common. We tolerate column
  // reordering and extra columns (BIDS allows both).
  // The row order is the channel order in the binary file, which the
  // format readers MUST honour — never reorder during display.
  api.parseChannelsTsv = function (text) {
    const rows = parseTsv(text);
    if (rows.length < 2) throw new Error('_channels.tsv has no data rows');
    const header = rows[0].map(h => h.trim().toLowerCase());
    const idx = (k) => header.indexOf(k);
    const iName = idx('name'), iType = idx('type'), iUnits = idx('units');
    if (iName < 0) throw new Error('_channels.tsv missing required column: name');

    const iStatus = idx('status');
    const iLow  = idx('low_cutoff');
    const iHigh = idx('high_cutoff');
    const iFs   = idx('sampling_frequency');

    const channels = [];
    for (let i = 1; i < rows.length; i++) {
      const c = rows[i];
      const name = (c[iName] || '').trim();
      if (!name) continue;
      channels.push({
        index: channels.length,
        name,
        type:   iType   >= 0 ? bidsCell(c[iType])   : null,
        units:  iUnits  >= 0 ? bidsCell(c[iUnits])  : null,
        status: iStatus >= 0 ? (bidsCell(c[iStatus]) || 'good') : 'good',
        low_cutoff:  iLow  >= 0 ? parseFloatOrNull(c[iLow])  : null,
        high_cutoff: iHigh >= 0 ? parseFloatOrNull(c[iHigh]) : null,
        sampling_frequency: iFs >= 0 ? parseFloatOrNull(c[iFs]) : null,
      });
    }
    if (!channels.length) throw new Error('_channels.tsv produced zero channels');
    return channels;
  };

  // ---- _events.tsv --------------------------------------------
  // Required columns per BIDS: onset (s), duration (s). trial_type is
  // common and we promote it to the display label when present.
  api.parseEventsTsv = function (text) {
    const rows = parseTsv(text);
    if (rows.length < 2) return [];
    const header = rows[0].map(h => h.trim().toLowerCase());
    const idx = (k) => header.indexOf(k);
    const iOnset = idx('onset'), iDur = idx('duration');
    if (iOnset < 0) throw new Error('_events.tsv missing required column: onset');

    const iLabel = idx('trial_type') >= 0 ? idx('trial_type') : idx('value');
    const iSample = idx('sample');

    const events = [];
    for (let i = 1; i < rows.length; i++) {
      const c = rows[i];
      const onset = parseFloat(c[iOnset]);
      if (!isFinite(onset)) continue;
      events.push({
        onset,
        duration: iDur >= 0 ? (parseFloatOrNull(c[iDur]) || 0) : 0,
        label:    iLabel >= 0 ? bidsCell(c[iLabel]) : null,
        sample:   iSample >= 0 ? parseFloatOrNull(c[iSample]) : null,
      });
    }
    return events;
  };

  // ---- shared TSV plumbing ------------------------------------
  // BIDS specifies tab-separated, but real-world files (e.g. ds002336)
  // sometimes use multi-space alignment instead. Detect at file level:
  // if the header row has a tab, parse as TSV; otherwise fall back to
  // whitespace-splitting. Cells are also surface-trimmed and unquoted —
  // some sources wrap values like 'Fp1' in literal single quotes that
  // BIDS doesn't define but does see in the wild.
  function parseTsv(text) {
    const lines = text
      .split(/\r?\n/)
      .filter(l => l.length > 0 && !l.startsWith('#'));
    if (!lines.length) return [];
    const sep = lines[0].includes('\t') ? /\t/ : /\s+/;
    return lines.map(l => l.split(sep).map(stripQuotes));
  }

  function stripQuotes(s) {
    s = s.trim();
    if (s.length >= 2) {
      const q = s[0];
      if ((q === '"' || q === "'") && s[s.length - 1] === q) return s.slice(1, -1);
    }
    return s;
  }

  function bidsCell(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || s.toLowerCase() === 'n/a') return null;
    return s;
  }

  function parseFloatOrNull(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || s.toLowerCase() === 'n/a') return null;
    const n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  // ---- top-level loader ---------------------------------------
  // Fetches every BIDS sidecar that goes with a recording and returns
  // a single metadata bundle. Optional sidecars (electrodes, coordsys,
  // events) are absent → null fields, never an error. The required
  // sidecar is _eeg.json: without SamplingFrequency we can't render
  // a time axis at all, so we surface that as a hard failure.
  api.loadRecordingMetadata = async function (eegUrl) {
    const { dir, prefix, ext } = api.parseEegUrl(eegUrl);

    // Fetch in parallel — each call walks the inheritance tree
    // independently, so a missing run-level file falls through to the
    // dataset root (BIDS principle). Fetches are tiny; the CORS
    // round-trip dominates so parallel is the right call.
    const [eeg_json, channels, events, electrodes, coordsystem] =
      await Promise.all([
        fetchInheritedSidecar(dir, prefix, '_eeg.json'),
        fetchInheritedSidecar(dir, prefix, '_channels.tsv'),
        fetchInheritedSidecar(dir, prefix, '_events.tsv'),
        fetchInheritedSidecar(dir, prefix, '_electrodes.tsv'),
        fetchInheritedSidecar(dir, prefix, '_coordsystem.json'),
      ]);
    if (eeg_json == null) {
      // Soft-required: format-specific readers (BrainVision .vhdr,
      // EDF header, EEGLAB .set) carry SamplingFrequency and channel
      // counts inline, so the binary reader can fill these in. We
      // pass a stub through and let the reader override.
      console.warn(`No _eeg.json found via BIDS inheritance for ${eegUrl}; deferring to format header.`);
    }
    return assembleRecordingMetadata({
      eeg_url: eegUrl, ext, dir, prefix,
      hits: { eeg_json, channels, events, electrodes, coordsystem },
    });
  };

  // Parses the five canonical BIDS sidecars from already-fetched
  // {text, url} hits (any may be null) into the metadata bundle the
  // viewer + format readers consume. Shared between the OpenNeuro
  // network walker (loadRecordingMetadata) and the NEMAR inline-map
  // walker (loadNemarRecording) — the only thing that varies between
  // them is *how* hits get materialised, not how they're parsed.
  function assembleRecordingMetadata({ eeg_url, ext, dir, prefix, hits }) {
    const { eeg_json: eegJsonHit, channels: channelsHit, events: eventsHit,
            electrodes: electrodesHit, coordsystem: coordSysHit } = hits;

    let eegJson;
    if (eegJsonHit) {
      try {
        eegJson = api.parseEegJson(JSON.parse(eegJsonHit.text));
      } catch (e) {
        throw new Error(`Bad _eeg.json at ${eegJsonHit.url}: ${e.message}`);
      }
    } else {
      eegJson = { sampling_frequency: null, recording_duration: null, eeg_reference: null,
                  power_line_frequency: null, software_filters: null, manufacturer: null, raw: {} };
    }

    const channels = channelsHit ? api.parseChannelsTsv(channelsHit.text) : null;
    const events = eventsHit ? api.parseEventsTsv(eventsHit.text) : [];

    let electrodes = null, coordsystem = null;
    if (electrodesHit && typeof BIDSLoader !== 'undefined') {
      try { electrodes = BIDSLoader.parseElectrodesTSV(electrodesHit.text); }
      catch (e) { console.warn(`electrodes.tsv unparseable, skipping: ${e.message}`); }
    }
    if (coordSysHit && typeof BIDSLoader !== 'undefined') {
      try { coordsystem = BIDSLoader.parseCoordsystem(coordSysHit.text); }
      catch (e) { console.warn(`coordsystem.json unparseable, skipping: ${e.message}`); }
    }

    return {
      eeg_url, ext, dir, prefix,
      eeg_json: eegJson,
      channels, events, electrodes, coordsystem,
      // Provenance: which key the walker found each sidecar at —
      // a real https URL for OpenNeuro, an `inline:<rawKey>` tag for
      // NEMAR. renderProvenance treats both as opaque labels.
      sidecar_sources: {
        eeg_json:    eegJsonHit?.url   ?? null,
        channels:    channelsHit?.url  ?? null,
        events:      eventsHit?.url    ?? null,
        electrodes:  electrodesHit?.url ?? null,
        coordsystem: coordSysHit?.url  ?? null,
      },
    };
  }

  // ---- internal helpers exposed for unit testing --------------
  // Underscore-prefixed: stable contract for the test suite, no
  // implicit promise to keep them across releases. Production code
  // should consume the public surface (loadRecordingMetadata, …).
  api._entityVariants  = entityVariants;
  api._tokenizePrefix  = tokenizePrefix;
  api._parseTsv        = parseTsv;

  // ---- URL parameter resolver ---------------------------------
  // Walks the URL params on page load and returns a normalized
  // descriptor the bootstrap code feeds into loadRecordingMetadata.
  // Returns null when no params are present (cold viewer state).
  api.resolveTargets = function (urlSearchParams) {
    const p = urlSearchParams;
    // Support ?eeg=, ?ieeg=, ?emg= parameters for direct URL loading
    for (const suffix of ['eeg', 'ieeg', 'emg', 'meg', 'nirs']) {
      if (p.has(suffix)) {
        return { kind: 'url', eeg_url: p.get(suffix) };
      }
    }
    if (p.has('dataset')) {
      const ds = p.get('dataset');
      const params = {
        dataset: ds,
        sub:     p.get('sub'),
        ses:     p.get('ses'),
        task:    p.get('task'),
        run:     p.get('run'),
        ext:     p.get('ext'),
      };
      // Determine suffix (default to 'eeg', can be overridden with ?suffix=)
      const suffix = p.get('suffix') || 'eeg';
      params.suffix = suffix;
      // NEMAR (nm-prefixed) datasets resolve via the eegdash records
      // API instead of a direct bucket URL — git-annex SHA addressing.
      if (api.isNemarDatasetId(ds)) {
        return { kind: 'nemar', nemar_params: params };
      }
      return {
        kind: 'bids-path',
        eeg_url: api.buildOpenNeuroEegUrl(params),
      };
    }
    if (p.has('demo')) {
      return { kind: 'demo', demo_id: p.get('demo') };
    }
    return null;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.BIDSRecording = api;
})();
