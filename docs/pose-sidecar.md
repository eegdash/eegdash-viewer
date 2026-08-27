# Pose sidecar format (`eegdash-pose`)

Companion JSON file for BIDS electrophysiology recordings that drives
the hand-pose panel (`pose-panel.js`, Lane F10): per-frame **landmark
positions** (the skeleton) and, since v2, per-frame **joint angles plus
the UmeTrack hand model** so the viewer skins the full hand itself
(`pose-kinematics.js` ports UmeTrack's forward kinematics + linear-blend
skinning to JS). For emg2pose BDF conversions use the bundled exporter:
`python scripts/export-pose-sidecar.py <recording_emg.bdf>` (auto-detects
`recording-<side>` mirroring; needs only `mne` and `numpy`). Point the panel at it with `?pose=<url>`
(resolved against the page URL). In an iframe host, pass it as the `pose`
field of the postMessage bridge instead (see [embedding.md](embedding.md)).

## File naming convention

Next to the recording it belongs to:

```
sub-01_task-emg2pose_emg.vhdr
sub-01_task-emg2pose_desc-pose.json      ← this sidecar
```

## v1 skeleton

```jsonc
{
  "format": "eegdash-pose",
  "version": 1,
  "fs": 30.0,                  // pose frame rate, Hz (> 0)
  "n_frames": 1800,
  "n_joints": 25,
  // flat joint pairs [i0,j0, i1,j1, ...]; nested [[i,j],...] accepted
  "bones": [0,1, 1,2, ...],
  // optional, length must equal n_joints
  "names": ["wrist", "thumb_cmc", "..."],
  // optional; defaults to n_frames / fs
  "duration_s": 60.0,
  "positions": {
    "encoding": "base64-f32",  // little-endian float32, base64 transport
    // frame-major: index = (frame * n_joints + joint) * 3 + axis
    "data": "<base64>"
  },
  // optional per-frame validity mask (base64 u8, length n_frames);
  // 0 marks IK-failure frames — the panel shows a badge instead of garbage
  "valid": "<base64>"
}
```

Notes:

- Coordinates are in the source model's units (UmeTrack: mm) in the
  model's native frame; the panel auto-fits and orbits freely. Mirror
  left/right hands upstream (emg2pose's `mirror_profile`) before export.
- `NaN` coordinates are treated like an invalid frame even without a mask.
- Files may be served from any static origin; same-origin serving (the
  braindecode notebook helper) avoids CORS entirely.

## v2: joint angles + skinned hand mesh (optional)

Add an `angles` block and a `mesh` block and the viewer renders the full
skinned hand: it runs UmeTrack forward kinematics (5 fingers × 4 joints
→ 17 skinning frames: root, wrist, then proximal/intermediate/distal per
finger; each joint rotates by `angles[q]` about `joint_axes[q]` anchored
at `joint_rest[q]`, exactly `_hand_skinning_transform` in
emg2pose/UmeTrack/lib/common/hand_skinning.py) and linear-blend
skinning per frame in JS — no Python, no torch at view time. The
bundled exporter writes all of this from a BDF: `python
scripts/export-pose-sidecar.py <recording_emg.bdf>` (needs only `mne`
and `numpy`; `--check` cross-validates against emg2pose's torch FK when
that package is importable, agreement ≈ 6e-5).

For a model prediction, save the 20 output angles in radians as a numeric
NumPy `(20, frames)` array, then produce the same sidecar without re-reading
a BDF:

```bash
python scripts/export-pose-sidecar.py \
  --angles-npy candidate_angles.npy --side left --fs 50 \
  --out candidate_desc-pose.json
```

The side is explicit in this form because a tensor has no BIDS filename from
which to infer left/right mirroring. This sidecar can be rendered with
`scripts/render-hand-png.mjs` or opened by the viewer like any BIDS sidecar.

```jsonc
{
  "...v1 fields as above...",
  "n_angles": 20,                // joint-angle count per frame (UmeTrack DOF)
  "angles": { "encoding": "base64-f32", "data": "<n_frames × n_angles>" },
  "camera": { "yaw": -0.4, "pitch": -1.0 },   // optional default view (radians)
  "start_s": 0.0,                // optional: frames cover [start_s, start_s + duration_s] of the recording
  "root": 5,                     // optional: joint drawn as the anchor (UmeTrack: landmark 5 = wrist)
  "mesh": {
    "mode": "umetrack-fk",
    "mirror_x": true,            // left hand: negate x after skinning
    "joint_axes":    { "encoding": "base64-f32", "data": "<20 × 3, unit vectors>" },
    "joint_rest":    { "encoding": "base64-f32", "data": "<20 × 3 anchors>" },
    "rest_vertices": { "encoding": "base64-f32", "data": "<n_verts × 3>" },
    "triangles":     { "encoding": "base64-u32", "data": "<n_tris × 3>" },
    // sparse skinning weights over the 17 frames: three equal-length arrays
    "weight_vertex": { "encoding": "base64-u32", "data": "…" },
    "weight_bone":   { "encoding": "base64-u32", "data": "…" },
    "weight_value":  { "encoding": "base64-f32", "data": "…" },
    // optional: landmark skinning so the skeleton can be re-derived from
    // angles (tests use it as an oracle against `positions`)
    "rest_landmarks":         { "encoding": "base64-f32", "data": "<n_joints × 3>" },
    "landmark_weight_vertex": { "encoding": "base64-u32", "data": "…" },
    "landmark_weight_bone":   { "encoding": "base64-u32", "data": "…" },
    "landmark_weight_value":  { "encoding": "base64-f32", "data": "…" }
  }
}
```

Notes:

- The hand model (rest vertices, triangles, weights, axes) is ~65 KB
  once; per-frame cost is 20 floats. A 44 s recording at 30 Hz with
  landmarks + angles + model is ~630 KB.
- NaN angles mark a frame invalid even without a `valid` mask; masked
  frames show the no-IK badge instead of garbage geometry.
- Press <kbd>m</kbd> to cycle auto → skeleton → mesh → both. `auto`
  shows the mesh when the block is present.
- Weight triplets below 1e-6 are dropped by the exporter.
- `camera` is applied on load and by double-click reset; without it the
  panel falls back to yaw −0.5, pitch 0.25.

## Size budgeting

Skeleton-only payloads are tiny (~75 floats/frame ≈ 300 B): a 60 s stage
at 30 Hz ≈ **540 KB** before base64 (~720 KB encoded). The mesh block
adds a fixed ~65 KB (the hand model) — vertices are never stored per
frame, the viewer skins them. Use `--start/--duration` to export a
window when a whole session is too large to embed.
