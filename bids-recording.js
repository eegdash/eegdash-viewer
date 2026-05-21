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
  //
  // BIDS entity order (per the BIDS spec, MUST appear in this order in
  // the filename): sub, ses, task, acq, ce, rec, dir, run, mod, echo,
  // flip, inv, mt, part, proc, hemi, space, split, recording, chunk.
  // We thread sub/ses/task/acq/run because those are the entities the
  // viewer's URL grammar accepts. acq is critical for iEEG datasets
  // like ds003688 (clinical vs research electrode banks) and for MEG
  // datasets that distinguish noise/empty-room vs subject recordings.
  function buildBidsRelpath(params, suffix) {
    const ds   = required(params, 'dataset');
    const sub  = required(params, 'sub');
    const ses  = params.ses || null;
    const task = params.task || null;
    const acq  = params.acq || null;
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
    if (acq)  entities += `_acq-${acq}`;
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
  // NEMAR datasets (nm/on/xx prefixes) are addressed by data.nemar.org,
  // the public BIDS-shaped HTTPS API the nemar-cli backend exposes for
  // every *published* dataset. One fetch of the per-version
  //   /<id>/<version>/manifest.json
  // gives us every file in the dataset as
  //   { path, size, checksum, checksum_algorithm, url }
  // — a flat enumeration covering both git-annex bytes (large EDF/BDF/
  // .set/.vhdr+.eeg/...) and inline-git sidecars (small JSON/TSV).
  //
  // Two URL shapes appear in the manifest:
  //   - git-tree:  https://raw.githubusercontent.com/nemarDatasets/<id>/<tag>/<bidsPath>
  //                Has CORS — fetched as-is.
  //   - annex S3:  https://nemar.s3.<region>.amazonaws.com/<id>/objects/<sha>?<presign>
  //                No CORS on bare S3 → routed through the cdn-worker's
  //                existing /<id>/objects/<sha> proxy. That URL is
  //                content-addressed so it's infinitely cacheable; we
  //                drop the per-request presigned query string entirely.
  //
  // The data.nemar.org route itself also lacks Access-Control-Allow-
  // Origin (verified May 2026), so manifest.json is also fetched
  // through the cdn-worker (/data/<id>/<ver>/manifest.json proxy).
  //
  // Pre-data.nemar.org we used the eegdash records API + git-annex SHA
  // lookups; that path required eegdash to have ingested every record
  // and never worked for on*/xx* mirrors. The manifest-driven path
  // unifies the three dataset families.

  // Lockstep with cdn-worker's VALID_NEMAR (objects/) and
  // VALID_NEMAR_API (/data/) regexes — a 5- or 7-digit id, or any
  // prefix outside {nm,on,xx}, would 404 against the worker.
  //   nm = native NEMAR ingest
  //   on = OpenNeuro mirror (added in nemar-cli sprint #514 May 2026
  //        once #516 unblocked their D1 metadata + LLM enrichment)
  //   xx = sandbox (used by the nemar-cli test suite)
  api.isNemarDatasetId = function (id) {
    return typeof id === 'string' && /^(?:nm|on|xx)\d{6}$/.test(id);
  };

  const _NEMAR_FETCH_TIMEOUT_MS = 15000;
  // Reject manifests larger than this — typical real manifests are
  // ~100KB-2MB; anything orders of magnitude bigger is corrupt or
  // hostile and would OOM the browser tab if parsed.
  const _NEMAR_MANIFEST_MAX_BYTES = 32 * 1024 * 1024;
  // Hosts the viewer is willing to fetch NEMAR bytes from. Centralised
  // so a host change is a single-line edit and the worker / loader
  // can't drift out of lockstep.
  const _CDN_BASE = 'https://cdn.eegdash.org';
  const _NEMAR_DATA_BASE = 'https://data.nemar.org';
  const _NEMAR_GITHUB_ORG = 'nemarDatasets';
  // Versions accepted by data.nemar.org: 'latest' or 'vMAJOR.MINOR.PATCH'.
  // Lockstep with the cdn-worker's VALID_NEMAR_API version segment so
  // a value rejected here would also be rejected at the proxy.
  const _NEMAR_VERSION_SHAPE = /^(?:latest|v\d+\.\d+\.\d+)$/;

  // Manifest-listed `url` values must match one of these two shapes
  // AND name the requested dataset — anything else is a trust-boundary
  // failure (the manifest is server-provided; we refuse to fetch from
  // arbitrary hosts OR from a different dataset's storage). Both
  // regexes capture the dsId so the caller can cross-check.
  //   git-tree: $1 = repo-name (== dsId for native NEMAR repos)
  //   annex S3: $1 = bucket-key dataset id, $2 = SHA-key
  const _GIT_TREE_URL = /^https:\/\/raw\.githubusercontent\.com\/nemarDatasets\/([^/]+)\/[^/]+\//;
  const _ANNEX_S3_URL = /^https:\/\/nemar\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com\/([^/]+)\/objects\/([A-Za-z0-9._-]+)(?:\?|$)/;

  // Transform a manifest entry's `url` into one the viewer can fetch
  // cross-origin. Returns null when the URL fails the trust-boundary
  // check (caller surfaces a clear error with context).
  function transformManifestUrl(entryUrl, dsId) {
    if (typeof entryUrl !== 'string' || !entryUrl) return null;
    const git = _GIT_TREE_URL.exec(entryUrl);
    if (git && git[1] === dsId) return entryUrl;
    const annex = _ANNEX_S3_URL.exec(entryUrl);
    if (annex && annex[1] === dsId) {
      // ?direct=1 keeps the presigned URL intact for Node tests, where
      // CORS doesn't apply and we want to bypass the cdn-worker entirely.
      if (_DIRECT_S3) return entryUrl;
      return `${_CDN_BASE}/${dsId}/objects/${annex[2]}`;
    }
    return null;
  }

  function nemarManifestUrl(dsId, version) {
    const ver = version || 'latest';
    if (!_NEMAR_VERSION_SHAPE.test(ver)) {
      throw new Error(
        `NEMAR version param "${ver}" is invalid — expected "latest" or "vMAJOR.MINOR.PATCH".`
      );
    }
    if (_DIRECT_S3) return `${_NEMAR_DATA_BASE}/${dsId}/${ver}/manifest.json`;
    return `${_CDN_BASE}/data/${dsId}/${ver}/manifest.json`;
  }

  // Single-shot loader for NEMAR recordings. Returns a metadata
  // bundle in the same shape as loadRecordingMetadata (so the rest
  // of the viewer is format-agnostic), with one NEMAR-specific
  // addition: meta.sibling_urls (filename → URL) so format readers
  // with split layouts (BrainVision .vhdr+.eeg, EEGLAB .set+.fdt)
  // can resolve the sibling without doing path arithmetic against
  // a SHA-keyed URL.
  // postMessage-safe: only plain JSON, no functions or closures.
  api.loadNemarRecording = async function (params) {
    const ds = required(params, 'dataset');
    if (!api.isNemarDatasetId(ds)) {
      throw new Error(`not a NEMAR-style dataset id: ${ds}`);
    }
    const bidspath = buildBidsRelpath(params);
    // Manifest paths are dataset-relative — strip the leading <id>/.
    const innerPath = bidspath.startsWith(`${ds}/`)
      ? bidspath.slice(ds.length + 1)
      : bidspath;

    const manifest = await fetchNemarManifest(ds, params.version);

    const lastSlash = innerPath.lastIndexOf('/');
    const dir = lastSlash >= 0 ? innerPath.slice(0, lastSlash + 1) : '';
    const basename = lastSlash >= 0 ? innerPath.slice(lastSlash + 1) : innerPath;
    const prefixMatch = /^(.+?)_(?:eeg|ieeg|emg|meg|nirs)\.[^.]+$/.exec(basename);
    const prefix = prefixMatch ? prefixMatch[1] : basename.replace(/\.[^.]+$/, '');
    const ext = (basename.slice(basename.lastIndexOf('.') + 1) ||
                 params.ext || 'set').toLowerCase();

    // Single pass over the manifest: build the path index AND collect
    // same-directory siblings. sibling_urls feeds BrainVision .vhdr
    // (which references .eeg by bare filename) and EEGLAB .set+.fdt;
    // restricting to the recording's exact dir prevents cross-subject
    // basename collisions that wider scopes would cause.
    const byPath = new Map();
    const sibling_urls = {};
    for (const e of manifest) {
      if (!e || typeof e.path !== 'string') continue;
      byPath.set(e.path, e);
      if (!e.path.startsWith(dir)) continue;
      const rest = e.path.slice(dir.length);
      if (!rest || rest.includes('/')) continue;
      const u = transformManifestUrl(e.url, ds);
      if (u) sibling_urls[rest] = u;
    }

    const rawEntry = byPath.get(innerPath);
    if (!rawEntry) {
      throw new Error(
        `NEMAR manifest has no entry for ${innerPath}. ` +
        `Check dataset/sub/ses/task/run/ext URL params match a published recording, ` +
        `or pin a specific version with ?version=vX.Y.Z.`
      );
    }
    const eegUrl = transformManifestUrl(rawEntry.url, ds);
    if (!eegUrl) {
      throw new Error(`NEMAR manifest url has unrecognised shape: ${rawEntry.url}`);
    }

    // Sidecars: BIDS-inheritance walk against the manifest (deepest →
    // root, entity-stripped variants), then a network fetch of the
    // first hit's text. The provenance label in sidecar_sources keeps
    // the per-entry URL so renderProvenance shows where the value
    // came from (raw.githubusercontent.com for git-tree, cdn.eegdash
    // .org for annex). assembleRecordingMetadata is shared with the
    // OpenNeuro path so the bundle's downstream shape stays uniform.
    const sidecarPlan = [
      ['eeg_json',    '_eeg.json'],
      ['channels',    '_channels.tsv'],
      ['events',      '_events.tsv'],
      ['electrodes',  '_electrodes.tsv'],
      ['coordsystem', '_coordsystem.json'],
    ];
    const results = await Promise.all(sidecarPlan.map(
      ([, suffix]) => fetchManifestSidecar(byPath, dir, prefix, suffix, ds)
    ));
    const hits = Object.fromEntries(sidecarPlan.map(([k], i) => [k, results[i]]));

    const meta = assembleRecordingMetadata({ eeg_url: eegUrl, ext, dir, prefix, hits });
    meta.sibling_urls = sibling_urls;
    return meta;
  };

  async function fetchNemarManifest(ds, version) {
    const url = nemarManifestUrl(ds, version);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), _NEMAR_FETCH_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetchWithRetry(url, { signal: ctrl.signal });
    } catch (e) {
      const reason = e.name === 'AbortError'
        ? `timed out after ${_NEMAR_FETCH_TIMEOUT_MS}ms`
        : e.message;
      throw new Error(`NEMAR manifest unreachable for ${ds}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
    if (resp.status === 404) {
      throw new Error(
        `NEMAR manifest 404 for ${ds}: dataset is unpublished, private, ` +
        `or has no minted version yet.`
      );
    }
    if (!resp.ok) {
      throw new Error(`NEMAR manifest HTTP ${resp.status} for ${ds}`);
    }
    // Guard against runaway manifest bodies (corrupt/hostile) — the
    // browser would otherwise OOM on resp.json(). Real manifests cap
    // out in single-digit MB even for 500+ recording datasets.
    const lenHeader = resp.headers && resp.headers.get && resp.headers.get('content-length');
    const declaredLen = lenHeader ? Number(lenHeader) : NaN;
    if (Number.isFinite(declaredLen) && declaredLen > _NEMAR_MANIFEST_MAX_BYTES) {
      throw new Error(
        `NEMAR manifest for ${ds} is ${declaredLen} bytes — refusing to parse ` +
        `(cap is ${_NEMAR_MANIFEST_MAX_BYTES} bytes; likely corrupt upstream).`
      );
    }
    let manifest;
    try {
      manifest = await resp.json();
    } catch (e) {
      throw new Error(
        `NEMAR manifest for ${ds} is not valid JSON (${e.message}). ` +
        `Upstream may be misconfigured.`
      );
    }
    if (!Array.isArray(manifest)) {
      throw new Error(`NEMAR manifest for ${ds} is not a JSON array`);
    }
    return manifest;
  }

  // Walk the BIDS inheritance shape against the manifest (no extra
  // network probes — the manifest is the authoritative file index for
  // the version), then fetch the matching entry's text once. Returns
  // null when nothing matches OR when the matching entry's text fetch
  // fails — assembleRecordingMetadata tolerates nulls (warns + falls
  // back to format-header values).
  async function fetchManifestSidecar(byPath, dir, prefix, suffix, ds) {
    for (const { paths } of eachInheritanceLevel(dir, prefix, suffix)) {
      for (const p of paths) {
        const entry = byPath.get(p);
        if (!entry) continue;
        const u = transformManifestUrl(entry.url, ds);
        if (!u) continue;
        try {
          const text = await HttpRange.fetchText(u);
          return { text, url: u };
        } catch (e) {
          console.warn(`NEMAR sidecar fetch failed for ${ds}/${p}: ${e.message}`);
          return null;
        }
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
        const r = await fetchWithRetry(`${EEGDASH_BASE}/api/eegdash/datasets/${datasetId}`);
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
  // Allowed URL protocols for query-param-supplied recording URLs. The
  // viewer accepts https only by default — data:/blob:/file:/javascript:
  // are rejected to prevent (a) cross-origin SSRF-from-victim where a
  // malicious link causes the browser to fetch an attacker URL with
  // the viewer's referer/cookies, and (b) data:/blob: payloads that
  // could bypass the format-reader's bounds checks. http: is permitted
  // for localhost / dev. (SAST scanner finding P2, 2026-05-21.)
  function isAllowedProtocol(urlString) {
    if (typeof urlString !== 'string' || !urlString) return false;
    // Same-origin relative URLs (start with /) are always safe — they
    // resolve against the viewer's own origin, so there's no
    // SSRF-from-victim or data:/blob: attack surface. Used by local
    // test fixtures like `?eeg=/test-data/*.edf` and by future
    // pre-bundled demo recordings.
    if (urlString.startsWith('/') && !urlString.startsWith('//')) return true;
    try {
      const u = new URL(urlString);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  }

  // Network resilience: NEMAR's data.nemar.org occasionally returns 404
  // 'Version not published' on the latest manifest; OpenNeuro S3 returns
  // 503 under load. Wrap fetch() with bounded exponential backoff —
  // 3 retries (200, 400, 800 ms) on transient 5xx and on network errors.
  // 4xx (other than 429) is treated as terminal — the URL is wrong, no
  // point retrying.
  async function fetchWithRetry(url, opts) {
    const TRANSIENT = new Set([429, 502, 503, 504]);
    const delays = [200, 400, 800];
    let lastErr;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const res = await fetch(url, opts);
        if (res.ok) return res;
        if (TRANSIENT.has(res.status) && attempt < delays.length) {
          await new Promise(r => setTimeout(r, delays[attempt]));
          continue;
        }
        // 4xx terminal — return the response so caller can decide
        // (parsePhysioUrl or the sidecar walk often expects 404).
        return res;
      } catch (e) {
        lastErr = e;
        if (attempt < delays.length) {
          await new Promise(r => setTimeout(r, delays[attempt]));
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new Error('fetchWithRetry: unreachable');
  }
  api._fetchWithRetry = fetchWithRetry;  // exposed for tests

  api.resolveTargets = function (urlSearchParams) {
    const p = urlSearchParams;
    // Support ?eeg=, ?ieeg=, ?emg= parameters for direct URL loading
    for (const suffix of ['eeg', 'ieeg', 'emg', 'meg', 'nirs']) {
      if (p.has(suffix)) {
        const url = p.get(suffix);
        if (!isAllowedProtocol(url)) {
          throw new Error(`Invalid URL protocol in ?${suffix}=; only http(s) allowed.`);
        }
        return { kind: 'url', eeg_url: url };
      }
    }
    if (p.has('dataset')) {
      const ds = p.get('dataset');
      const params = {
        dataset: ds,
        sub:     p.get('sub'),
        ses:     p.get('ses'),
        task:    p.get('task'),
        // acq is the BIDS "acquisition" entity. Critical for iEEG
        // (clinical vs research electrode banks) and MEG (subject vs
        // empty-room). Threaded through buildBidsRelpath so the
        // filename gets the `_acq-<X>_` segment in the BIDS-required
        // position between _task- and _run-.
        acq:     p.get('acq'),
        run:     p.get('run'),
        ext:     p.get('ext'),
        // NEMAR only: pin a specific manifest version. The loader
        // defaults to 'latest' when undefined and validates the
        // shape (latest|vN.N.N) before constructing the manifest URL.
        version: p.get('version') || undefined,
      };
      // Determine suffix (default to 'eeg', can be overridden with ?suffix=)
      // For iEEG datasets the user must currently pass ?suffix=ieeg
      // explicitly. A future iteration could auto-fall-back to ieeg on
      // 404 of the eeg path; for now the explicit param keeps the URL
      // unambiguous.
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
