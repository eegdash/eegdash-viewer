# Embedding the viewer (`?embed=1`) and the host-page bridge

The deployed viewer (`https://eegdash.github.io/eegdash-viewer/`) can be
framed by any page. `?embed=1` switches to the compact layout: header
pills, a one-row toolbar (recording · window · gain · HP/LP/notch), the
traces canvas, and — when a pose sidecar is loaded — the hand panel
docked to the right of the canvas (`p` or the **hand** pill toggles it). When
the host also supplies BIDS image assets, an event-aligned stimulus dock sits
beside the same traces.

## Two ways to hand the viewer a recording

1. **URL** — `?emg=<https url>` (or `?eeg=`, `?ieeg=`, `?meg=`, `?nirs=`) plus
   optional `&pose=<url>`. The viewer fetches windows with HTTP Range
   requests, so the host must allow CORS + Range (OpenNeuro/S3 do).
2. **postMessage bridge** — the host page pushes in-memory files. No
   server, no CORS, no Range: this is how
   `braindecode.datasets.BIDSDataset.plot()` shows a recording inside a
   Jupyter cell.

## Bridge protocol

| direction | message | notes |
|---|---|---|
| viewer → `window.parent` | `{ type: 'eegdash-viewer:ready' }` | posted once `Viewer.boot()` ran (target origin `*`); while framed and idle the stage reads "Waiting for the host page to send a recording" |
| host → viewer | `{ type: 'eegdash-viewer:open', files: File[], pose?: Blob \| string \| null, stimuli?: Record<string, Blob \| string> }` | `files` are structured-cloned; the first `*_{eeg,ieeg,emg,meg,nirs}.<ext>` is the recording, siblings (`.eeg/.vmrk`, `.fdt`, `_channels.tsv`, `_events.tsv`) are registered next to it. `pose` is a `Blob`/`File` holding the sidecar JSON, or any URL `fetch()` accepts (`data:` included); omitting it hides a previously shown hand panel. `stimuli` maps numeric BIDS image IDs to image Blobs or URLs; it remains outside `files`, so image bytes never enter the EEG worker. |

The bridge takes exactly the drag-and-drop path (`HttpRange.registerLocal`
→ `load()`), so every format the viewer reads from a drop works here.
Any origin may post: the payload only selects what to render, and the
viewer holds no credentials.

```html
<iframe id="v" src="https://eegdash.github.io/eegdash-viewer/index.html?embed=1"
        style="width:100%;height:520px;border:0"></iframe>
<script>
  const frame = document.getElementById('v');
  let sent = false;
  async function send() {
    if (sent) return; sent = true;
    const buf = await (await fetch('data:application/octet-stream;base64,…')).arrayBuffer();
    const imageBytes = await (await fetch('data:image/jpeg;base64,…')).arrayBuffer();
    frame.contentWindow.postMessage({
      type: 'eegdash-viewer:open',
      files: [new File([buf], 'sub-01_task-x_emg.bdf')],
      pose: 'data:application/json;base64,…',   // or null
      stimuli: { '16595': new Blob([imageBytes], { type: 'image/jpeg' }) },
    }, 'https://eegdash.github.io');
  }
  addEventListener('message', e => {
    if (e.source === frame.contentWindow && e.data?.type === 'eegdash-viewer:ready') send();
  });
  frame.addEventListener('load', send);   // belt and braces
</script>
```

Trust note: notebook outputs carry a script, so Jupyter renders them
when the cell was run in the session or the notebook is trusted
(`jupyter trust notebook.ipynb`); an untrusted saved notebook shows an
empty cell until then.

Size note: bytes inlined in a notebook output are saved with the
notebook. braindecode refuses recordings above `max_bytes` (256 MiB by
default); crop or downsample first for anything larger. The pose
sidecar with the skinned-hand model is ~15 KB/s of recording
(`scripts/export-pose-sidecar.py --start/--duration` exports a window).

Browser e2e for this path: `npx playwright test tests/e2e/host-bridge.spec.mjs`.

## Reusable pose-image renderer

`pose-panel.js` also exposes a small browser API for experiment artifacts. It
does not mount the viewer UI or fetch data: pass a complete `eegdash-pose`
object and it returns a standalone PNG data URL.

```js
const image = globalThis.PosePanel.renderPNG(sidecar, {
  time: 12.5,                 // recording time; defaults to sidecar midpoint
  width: 720,
  height: 720,
  scale: 2,                   // final image is 1440 × 1440 px
  mode: 'auto',               // auto | skeleton | mesh | both
  camera: { yaw: -0.4, pitch: -1.0, zoom: 1 },
});
```

The sidecar owns all geometry. In particular, the renderer does not bundle a
hand model, choose a participant, or invent a pose; a skeleton-only sidecar
works just as well as a sidecar with a compatible mesh block.

For a reproducible headless artifact (for example, one logged by MLflow), use
the same public API through the included CLI:

```bash
node scripts/render-hand-png.mjs \
  --sidecar artifacts/candidate-pose.json \
  --output artifacts/candidate-pose.png \
  --time 12.5 --width 720 --height 720 --scale 2 --mode auto
```

The CLI uses Playwright's Chromium. Provision it with `npx playwright install
chromium`, or pass a managed browser explicitly with `--executable-path`.
