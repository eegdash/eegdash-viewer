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
  // Strip the trailing _eeg.<ext> off the filename so we get the
  // BIDS entity prefix the sidecars share, e.g.
  //   sub-01_ses-01_task-rest_run-01_eeg.set
  //     → sub-01_ses-01_task-rest_run-01
  // Returns { dir, prefix, ext } where dir always ends with '/'.
  api.parseEegUrl = function (eegUrl) {
    const m = /^(.*\/)([^/]+?)_eeg\.([A-Za-z0-9+]+)$/.exec(eegUrl);
    if (!m) throw new Error(`URL is not a BIDS *_eeg.<ext> path: ${eegUrl}`);
    return { dir: m[1], prefix: m[2], ext: m[3].toLowerCase() };
  };

  // BIDS path convention on OpenNeuro:
  //   <bucket>/<dataset>/sub-<X>/[ses-<Y>/]<datatype>/<entities>_eeg.<ext>
  // Used by ?dataset=&sub=&ses=&task=&run=&ext= form so eegdash dataset
  // pages can deep-link without spelling out the full S3 URL.
  api.buildOpenNeuroEegUrl = function (params) {
    const ds   = required(params, 'dataset');
    const sub  = required(params, 'sub');
    const ses  = params.ses || null;
    const task = params.task || null;
    const run  = params.run || null;
    const ext  = (params.ext || 'set').toLowerCase();

    const bucket = 'https://s3.amazonaws.com/openneuro.org';
    const segs = [bucket, ds, `sub-${sub}`];
    if (ses) segs.push(`ses-${ses}`);
    segs.push('eeg');
    let entities = `sub-${sub}`;
    if (ses)  entities += `_ses-${ses}`;
    if (task) entities += `_task-${task}`;
    if (run)  entities += `_run-${run}`;
    return `${segs.join('/')}/${entities}_eeg.${ext}`;
  };

  function required(params, key) {
    const v = params[key];
    if (v == null || v === '') throw new Error(`missing required URL param: ${key}`);
    return String(v);
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

  // Walk up to 4 directory levels (run dir → ses → sub → root); at
  // each level try every entity variant + the bare suffix in parallel
  // and take the first non-null hit. Priority order is preserved:
  // fan-out is independent fetches, but the result-walk is ordered.
  async function fetchInheritedSidecar(dir, prefix, suffix) {
    const variants = entityVariants(prefix);
    const bare = suffix.startsWith('_') ? suffix.substring(1) : suffix;
    let here = dir;
    for (let level = 0; level < 4; level++) {
      const hit = await tryLevel(here, variants, suffix, bare);
      if (hit) return hit;
      const parent = here.replace(/[^/]+\/$/, '');
      if (!parent || parent === here) break;
      here = parent;
    }
    // Last resort: ask the eegdash backend for the dataset's known
    // sidecar inventory. Catches paths our entity-variant generator
    // didn't predict (acquisition-level files, dataset-specific naming).
    return eegdashFallback(dir, prefix, suffix, variants, bare);
  }

  async function tryLevel(dir, variants, suffix, bare) {
    const urls = variants.map(v => `${dir}${v}${suffix}`);
    urls.push(`${dir}${bare}`);
    const results = await Promise.all(urls.map(fetchTextOrNull));
    for (let i = 0; i < results.length; i++) {
      if (results[i] != null) return { text: results[i], url: urls[i] };
    }
    return null;
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
    const m = /^https?:\/\/s3\.amazonaws\.com\/openneuro\.org\/([^/]+)\//.exec(dir);
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
    const [eegJsonHit, channelsHit, eventsHit, electrodesHit, coordSysHit] =
      await Promise.all([
        fetchInheritedSidecar(dir, prefix, '_eeg.json'),
        fetchInheritedSidecar(dir, prefix, '_channels.tsv'),
        fetchInheritedSidecar(dir, prefix, '_events.tsv'),
        fetchInheritedSidecar(dir, prefix, '_electrodes.tsv'),
        fetchInheritedSidecar(dir, prefix, '_coordsystem.json'),
      ]);

    if (eegJsonHit == null) {
      // Soft-required: format-specific readers (BrainVision .vhdr,
      // EDF header, EEGLAB .set) carry SamplingFrequency and channel
      // counts inline, so the binary reader can fill these in. We
      // pass a stub through and let the reader override.
      console.warn(`No _eeg.json found via BIDS inheritance for ${eegUrl}; deferring to format header.`);
    }
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

    let channels = null;
    if (channelsHit != null) channels = api.parseChannelsTsv(channelsHit.text);

    const events = eventsHit != null ? api.parseEventsTsv(eventsHit.text) : [];

    let electrodes = null, coordsystem = null;
    if (electrodesHit != null && typeof BIDSLoader !== 'undefined') {
      try { electrodes = BIDSLoader.parseElectrodesTSV(electrodesHit.text); }
      catch (e) { console.warn(`electrodes.tsv unparseable, skipping: ${e.message}`); }
    }
    if (coordSysHit != null && typeof BIDSLoader !== 'undefined') {
      try { coordsystem = BIDSLoader.parseCoordsystem(coordSysHit.text); }
      catch (e) { console.warn(`coordsystem.json unparseable, skipping: ${e.message}`); }
    }

    return {
      eeg_url: eegUrl,
      ext,                           // 'set' | 'edf' | 'bdf' | 'vhdr'
      dir,
      prefix,
      eeg_json: eegJson,
      channels,
      events,
      electrodes,
      coordsystem,
      // Provenance: which level the inheritance walk found each
      // sidecar at, useful both for the user-facing status line and
      // for diagnosing "I expected this dataset's events to load".
      sidecar_sources: {
        eeg_json:    eegJsonHit?.url   ?? null,
        channels:    channelsHit?.url  ?? null,
        events:      eventsHit?.url    ?? null,
        electrodes:  electrodesHit?.url ?? null,
        coordsystem: coordSysHit?.url  ?? null,
      },
    };
  };

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
    if (p.has('eeg')) {
      return { kind: 'url', eeg_url: p.get('eeg') };
    }
    if (p.has('dataset')) {
      return {
        kind: 'bids-path',
        eeg_url: api.buildOpenNeuroEegUrl({
          dataset: p.get('dataset'),
          sub:     p.get('sub'),
          ses:     p.get('ses'),
          task:    p.get('task'),
          run:     p.get('run'),
          ext:     p.get('ext'),
        }),
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
