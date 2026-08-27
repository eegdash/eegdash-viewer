// unit-render-pipeline-final-chunk.test.mjs — the streaming consumer must
// treat the final chunk as a complete window, not as one more increment.
//
// worker.js sends incremental WINDOW_CHUNK messages with partial: true and
// then a closing chunk with partial: false whose payload is the COMPLETE
// assembled window ("Send final chunk (assembled full window, no filter)").
// render-pipeline.js appended every chunk, so the closing one pushed
// totalSamples past windowSamples, tripped the overflow guard, and `break`
// skipped the `if (!partial)` block that caches ctx.lastChannels.
//
// Consequences, both observed live against a 36-channel remote recording:
//   - updateCursor() bails on `!lastChannels`, so the cursor readout never
//     appeared on any recording that streamed (e2e F01).
//   - With lastChannels null the render fast path is unavailable, so a
//     time-mode toggle needed a full worker round-trip and missed its
//     redraw window (e2e F06).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pipelineSrc = readFileSync(resolve(here, '../viewer/render-pipeline.js'), 'utf8');
const workerSrc   = readFileSync(resolve(here, '../worker.js'), 'utf8');

// Models the assembly loop's contract: partial chunks append, the final
// chunk replaces. Returns null when the loop bailed without caching.
function assemble(chunks, windowSamples) {
  let assembled = null, totalSamples = 0, cached = null;
  for (const { partial, channels } of chunks) {
    if (!assembled) {
      assembled = channels.map(() => new Float32Array(windowSamples));
      totalSamples = 0;
    }
    const chunkLen = channels[0].length;
    if (!partial) {
      for (let c = 0; c < assembled.length; c++) {
        assembled[c].set(channels[c].subarray(0, windowSamples), 0);
      }
      totalSamples = Math.min(chunkLen, windowSamples);
    } else {
      if (totalSamples + chunkLen > windowSamples) break;
      for (let c = 0; c < assembled.length; c++) assembled[c].set(channels[c], totalSamples);
      totalSamples += chunkLen;
    }
    if (!partial) cached = assembled.map(ch => ch.subarray(0, totalSamples));
  }
  return cached;
}

const ramp = (from, n) => new Float32Array(Array.from({ length: n }, (_, i) => from + i));

test('a final chunk carrying the whole window still caches lastChannels', () => {
  const W = 100;
  // Four increments of 25 that fill the window, then the closing chunk that
  // repeats all 100 samples — exactly what worker.js emits.
  const chunks = [
    { partial: true,  channels: [ramp(0, 25)] },
    { partial: true,  channels: [ramp(25, 25)] },
    { partial: true,  channels: [ramp(50, 25)] },
    { partial: true,  channels: [ramp(75, 25)] },
    { partial: false, channels: [ramp(0, 100)] },
  ];
  const cached = assemble(chunks, W);
  assert.ok(cached, 'lastChannels must be cached — appending the final chunk used to break the loop');
  assert.equal(cached[0].length, W);
  assert.equal(cached[0][0], 0);
  assert.equal(cached[0][W - 1], 99);
});

test('a stream that is only a single final chunk caches the window', () => {
  const cached = assemble([{ partial: false, channels: [ramp(0, 100)] }], 100);
  assert.ok(cached);
  assert.equal(cached[0].length, 100);
});

test('partial chunks still assemble in order', () => {
  const cached = assemble([
    { partial: true,  channels: [ramp(0, 40)] },
    { partial: true,  channels: [ramp(40, 40)] },
    { partial: false, channels: [ramp(0, 80)] },
  ], 80);
  assert.ok(cached);
  assert.deepEqual(Array.from(cached[0].slice(0, 5)), [0, 1, 2, 3, 4]);
  assert.equal(cached[0][79], 79);
});

test('an oversized partial chunk is still rejected', () => {
  // The overflow guard must survive for genuine partial chunks — that is
  // what protects the buffer during rapid abort+restart.
  const cached = assemble([
    { partial: true, channels: [ramp(0, 60)] },
    { partial: true, channels: [ramp(60, 60)] },   // 120 > 100 → break
  ], 100);
  assert.equal(cached, null, 'no final chunk arrived, so nothing should be cached');
});

// ── Contract guards on the real sources ──────────────────────────────────

test('worker.js still sends the full window as its final chunk', () => {
  assert.ok(
    /Send final chunk \(assembled full window/.test(workerSrc),
    'worker.js changed its final-chunk contract — render-pipeline.js assumes a complete window',
  );
});

test('render-pipeline.js branches on partial before the overflow guard', () => {
  assert.ok(
    !/const chunkLen = chunkChannels\[0\]\.length;\s*\n\s*\/\/ Guard against buffer overflow[^\n]*\n\s*if \(totalSamples \+ chunkLen > windowSamples\) break;/.test(pipelineSrc),
    'the overflow guard must not run unconditionally — it swallows the final chunk',
  );
  assert.ok(
    /if \(!partial\) \{[\s\S]{0,400}?totalSamples = Math\.min\(chunkLen, windowSamples\);/.test(pipelineSrc),
    'expected the final chunk to replace the buffer rather than append to it',
  );
});
