# Pose sidecar format (`eegdash-pose`)

Companion JSON file for BIDS electrophysiology recordings that carries
**precomputed skeletal joint positions** for the hand-pose panel
(`pose-panel.js`, Lane F10). The viewer intentionally contains *no*
kinematics: forward kinematics / skinning runs once upstream (e.g.
emg2pose's UmeTrack `HandModel` in Python), and this file stores only
the resulting geometry. Point the panel at it with `?pose=<url>`
(resolved against the page URL).

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

## v2: joint angles + skinned mesh (optional)

Add an `angles` block (and optionally a `mesh` block) to render the
full skinned hand. The viewer performs linear-blend skinning itself
(`x' = SUM_b w_b * R(axis_b, theta_b) * (x - rest_b) + rest_b`,
Rodrigues convention matching emg2pose's UmeTrack `_skin_points`), so
hosted deployments need zero Python:

```jsonc
{
  "...v1 fields as above...",
  // REQUIRED for mesh: raw per-frame joint angles (n_frames x n_joints)
  // in UmeTrack parameter space — positions alone cannot reconstruct
  // bone rotations.
  "angles": { "encoding": "base64-f32", "data": "<base64>" },
  "mesh": {
    "mode": "umetrack-lbs",
    // rest-pose vertex positions (n_verts x 3)
    "rest_vertices": { "encoding": "base64-f32", "data": "<base64>" },
    // triangle indices, n_triangles x 3 into the vertex array
    "triangles":     { "encoding": "base64-u32", "data": "<base64>" },
    // sparse skinning weights: three equal-length triplet arrays
    "weight_vertex": { "encoding": "base64-u32", "data": "<base64>" },
    "weight_bone":   { "encoding": "base64-u32", "data": "<base64>" },
    "weight_value":  { "encoding": "base64-f32", "data": "<base64>" },
    // per-joint rotation axis and rest anchor (n_joints x 3 each)
    "joint_axes":    { "encoding": "base64-f32", "data": "<base64>" },
    "joint_rest":    { "encoding": "base64-f32", "data": "<base64>" }
  }
}
```

Notes:

- NaN angles mark a frame invalid even without a `valid` mask; masked
  frames show the no-IK badge instead of garbage geometry.
- Press <kbd>m</kbd> to cycle auto -> skeleton -> mesh -> both.
- Weight triplets below ~1e-6 are dropped by the exporter to keep
  payloads small.

## Size budgeting

Skeleton-only payloads are tiny (~75 floats/frame ≈ 300 B): a 60 s stage
at 30 Hz ≈ **540 KB** before base64 (~720 KB encoded). Mesh playback is
~3k vertices/frame — export windowed meshes or serve them lazily rather
than embedding whole-session blobs.
