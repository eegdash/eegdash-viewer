#!/usr/bin/env node
// make-demo-pose.mjs — generate a synthetic hand-skeleton pose sidecar
// for manual testing of the F10 panel without any emg2pose data.
//
//   node scripts/make-demo-pose.mjs [out.json] [seconds]
//
// The "hand" is a wrist plus 5 fingers × 3 segments; each finger waves
// with a phase-offset sine so panning the traces visibly articulates it.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'test-data', 'pose-demo.json');
const seconds = Number(process.argv[3] || 10);

const FS = 30;
const nFrames = Math.round(seconds * FS);

// Skeleton layout: joint 0 = wrist; each finger f has joints 3-chain.
const names = ['wrist'];
const bones = [];
const FINGERS = 5, SEGS = 3;
for (let f = 0; f < FINGERS; f++) {
  let prev = 0;
  for (let s = 0; s < SEGS; s++) {
    const idx = names.length;
    names.push(`f${f}_s${s}`);
    bones.push(prev, idx);
    prev = idx;
  }
}
const nJoints = names.length;

const positions = new Float32Array(nFrames * nJoints * 3);
for (let t = 0; t < nFrames; t++) {
  const time = t / FS;
  const put = (j, x, y, z) => positions.set([x, y, z], (t * nJoints + j) * 3);
  put(0, 0, -20, 0);
  for (let f = 0; f < FINGERS; f++) {
    const spread = (f - 2) * 18;                       // fan across x
    const curl = Math.sin(time * Math.PI + f * 1.1);   // per-finger wave
    let px = spread, py = -20, pz = 0;
    for (let s = 0; s < SEGS; s++) {
      const segLen = 16 - s * 3;
      const ang = -Math.PI / 2 + curl * 0.9 * (s + 1) / SEGS + spread * 0.006;
      px += Math.cos(ang) * segLen * Math.sign(spread || 1) * 0.4;
      py += Math.sin(ang) * segLen;
      pz += Math.sin(time * 2 * Math.PI + f) * 2;
      put(1 + f * SEGS + s, px, py, pz);
    }
  }
}

const sidecar = {
  format: 'eegdash-pose',
  version: 1,
  fs: FS,
  n_frames: nFrames,
  n_joints: nJoints,
  bones,
  names,
  duration_s: seconds,
  positions: { encoding: 'base64-f32', data: Buffer.from(positions.buffer).toString('base64') },
};

writeFileSync(out, JSON.stringify(sidecar));
console.log(`wrote ${out} (${nFrames} frames @ ${FS} Hz, ${nJoints} joints)`);
