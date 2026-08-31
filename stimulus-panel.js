/* ============================================================
   stimulus-panel.js — BIDS image stimulus dock synchronized to EEG time.
   ============================================================ */
'use strict';
(function () {
  let assets = Object.create(null);
  let generatedUrl = null;
  let activeSource = null;
  let windowEvent = null;
  let cursorActive = false;

  function isAsset(value) {
    return typeof value === 'string' || !!(value && typeof value.slice === 'function');
  }

  function panelParts() {
    const doc = globalThis.document;
    if (!doc) return null;
    let root = doc.getElementById('stimulus-panel');
    if (!root) {
      const stage = doc.getElementById('stage');
      if (!stage) return null;
      root = doc.createElement('aside');
      root.id = 'stimulus-panel';
      root.className = 'stimulus-panel';
      root.setAttribute('hidden', '');
      root.setAttribute('aria-label', 'Stimulus image');
      const image = doc.createElement('img');
      image.id = 'stimulus-image';
      image.className = 'stimulus-image';
      const caption = doc.createElement('div');
      caption.id = 'stimulus-caption';
      caption.className = 'stimulus-caption';
      root.append(image, caption);
      stage.append(root);
    }
    return {
      root,
      image: doc.getElementById('stimulus-image'),
      caption: doc.getElementById('stimulus-caption'),
    };
  }

  function revokeGeneratedUrl() {
    if (!generatedUrl) return;
    globalThis.URL?.revokeObjectURL?.(generatedUrl);
    generatedUrl = null;
  }

  function hide() {
    activeSource = null;
    revokeGeneratedUrl();
    const parts = panelParts();
    if (!parts) return;
    parts.image?.removeAttribute('src');
    if (parts.image) {
      parts.image.onerror = null;
      delete parts.image.dataset.stimulusId;
      parts.image.alt = '';
    }
    if (parts.caption) parts.caption.textContent = '';
    parts.root.setAttribute('hidden', '');
  }

  function nearestEvent(events, tSec) {
    if (!Array.isArray(events) || !Number.isFinite(tSec)) return null;
    let nearest = null;
    let distance = Infinity;
    for (const event of events) {
      const id = event?.stimulus_id;
      if (typeof id !== 'string' || !id || !Object.prototype.hasOwnProperty.call(assets, id)) continue;
      const onset = Number(event.onset);
      if (!Number.isFinite(onset)) continue;
      const nextDistance = Math.abs(onset - tSec);
      if (nextDistance < distance) {
        nearest = event;
        distance = nextDistance;
      }
    }
    return nearest;
  }

  function showEvent(event) {
    const id = event?.stimulus_id;
    const asset = id && assets[id];
    if (!asset) {
      hide();
      return;
    }
    const parts = panelParts();
    if (!parts?.image || !parts.caption) return;
    if (parts.image.dataset.stimulusId !== id) {
      revokeGeneratedUrl();
      activeSource = null;
      parts.image.onerror = null;
      let src;
      try {
        src = typeof asset === 'string'
          ? asset
          : globalThis.URL?.createObjectURL?.(asset);
      } catch (_) {
        hide();
        return;
      }
      if (!src) {
        hide();
        return;
      }
      if (typeof asset !== 'string') generatedUrl = src;
      activeSource = src;
      parts.image.onerror = () => {
        if (activeSource === src && parts.image.dataset.stimulusId === id) hide();
      };
      parts.image.src = src;
      parts.image.dataset.stimulusId = id;
      parts.image.alt = `Stimulus ${id}`;
    }
    parts.caption.textContent = `${event.label || 'stimulus'} · ${id} · ${event.onset.toFixed(3)} s`;
    parts.root.removeAttribute('hidden');
  }

  function setAssets(nextAssets) {
    assets = Object.create(null);
    windowEvent = null;
    cursorActive = false;
    if (nextAssets && typeof nextAssets === 'object' && !Array.isArray(nextAssets)) {
      for (const [id, asset] of Object.entries(nextAssets)) {
        const stimulusId = id.trim();
        if (stimulusId && isAsset(asset)) assets[stimulusId] = asset;
      }
    }
    hide();
    if (Object.keys(assets).length) panelParts();
  }

  function syncWindow(events, tSec) {
    windowEvent = nearestEvent(events, tSec);
    if (!cursorActive) showEvent(windowEvent);
  }

  function syncCursor(events, tSec) {
    cursorActive = true;
    showEvent(nearestEvent(events, tSec));
  }

  function clearCursor() {
    cursorActive = false;
    showEvent(windowEvent);
  }

  function clear() {
    assets = Object.create(null);
    windowEvent = null;
    cursorActive = false;
    hide();
  }

  const api = { setAssets, syncWindow, syncCursor, clearCursor, clear };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.StimulusPanel = api;
})();
