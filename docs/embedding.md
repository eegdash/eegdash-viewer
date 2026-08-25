# Embedding the viewer (`?embed=1`) and the host-page bridge

The deployed viewer (`https://eegdash.github.io/eegdash-viewer/`) can be
framed by any page. `?embed=1` switches to the compact layout: header
pills, a one-row toolbar (recording · window · gain · HP/LP/notch), the
traces canvas, and — when a pose sidecar is loaded — the hand panel
docked to the right of the canvas (`p` or the **hand** pill toggles it).

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
| host → viewer | `{ type: 'eegdash-viewer:open', files: File[], pose?: string \| null }` | `files` are structured-cloned; the first `*_{eeg,ieeg,emg,meg,nirs}.<ext>` is the recording, siblings (`.eeg/.vmrk`, `.fdt`, `_channels.tsv`, `_events.tsv`) are registered next to it. `pose` is any URL `fetch()` accepts, `data:` URLs included; omitting it hides a previously shown hand panel. |

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
    frame.contentWindow.postMessage({
      type: 'eegdash-viewer:open',
      files: [new File([buf], 'sub-01_task-x_emg.bdf')],
      pose: 'data:application/json;base64,…',   // or null
    }, 'https://eegdash.github.io');
  }
  addEventListener('message', e => {
    if (e.source === frame.contentWindow && e.data?.type === 'eegdash-viewer:ready') send();
  });
  frame.addEventListener('load', send);   // belt and braces
</script>
```

Size note: bytes inlined in a notebook output are saved with the
notebook. braindecode refuses recordings above `max_bytes` (256 MiB by
default); crop or downsample first for anything larger. The pose
sidecar with the skinned-hand model is ~15 KB/s of recording
(`scripts/export-pose-sidecar.py --start/--duration` exports a window).

Browser e2e for this path: `npx playwright test tests/e2e/host-bridge.spec.mjs`.
