// SidecarChecks (formats/_sidecar.js) — sidecar-vs-binary cross-check
// helpers used by every reader. Validation logic lives in one place;
// these tests pin down its behavioural contract so a future reader
// can rely on it without re-reading the implementation.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { SidecarChecks, HttpRange } from './_bootstrap.mjs';

// Capture console.warn for assertion. node:test doesn't have a
// built-in spy, so we swap and restore.
function captureWarn(fn) {
  const original = console.warn;
  const messages = [];
  console.warn = (msg) => messages.push(msg);
  try { return fn(messages); }
  finally { console.warn = original; }
}

// ----- crossCheckChannelOrder -------------------------------

test('crossCheckChannelOrder: warns on length mismatch', () => {
  captureWarn((msgs) => {
    SidecarChecks.crossCheckChannelOrder(['Fp1', 'Fp2'], [{name: 'Fp1'}], 'EDF');
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /channels\.tsv has 1 rows but EDF has 2/);
  });
});

test('crossCheckChannelOrder: warns per row on name divergence', () => {
  captureWarn((msgs) => {
    SidecarChecks.crossCheckChannelOrder(
      ['Fp1', 'Cz'], [{name: 'Fp1'}, {name: 'C3'}], 'BrainVision');
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /channels\.tsv\[1\]="C3" ≠ BrainVision label "Cz"/);
  });
});

test('crossCheckChannelOrder: ignores case-only differences', () => {
  // Real-world headers like to lowercase channel names. Our reader
  // should warn on real divergence, not on cosmetic case mismatch.
  captureWarn((msgs) => {
    SidecarChecks.crossCheckChannelOrder(
      ['fp1', 'CZ'], [{name: 'Fp1'}, {name: 'Cz'}], 'EDF');
    assert.equal(msgs.length, 0);
  });
});

test('crossCheckChannelOrder: no-op when bidsChannels is null', () => {
  captureWarn((msgs) => {
    SidecarChecks.crossCheckChannelOrder(['Fp1'], null, 'EDF');
    assert.equal(msgs.length, 0);
  });
});

// ----- warnFsMismatch ---------------------------------------

test('warnFsMismatch: silent when sidecar fs is null', () => {
  captureWarn((msgs) => {
    SidecarChecks.warnFsMismatch(null, 500, 'EDF');
    assert.equal(msgs.length, 0);
  });
});

test('warnFsMismatch: silent when fs values agree within 1e-3', () => {
  captureWarn((msgs) => {
    SidecarChecks.warnFsMismatch(500.0001, 500, 'EDF');
    assert.equal(msgs.length, 0);
  });
});

test('warnFsMismatch: warns when fs values diverge', () => {
  captureWarn((msgs) => {
    SidecarChecks.warnFsMismatch(250, 500, 'EDF');
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /EDF fs \(500 Hz\) disagrees with sidecar \(250 Hz\)/);
  });
});

// ----- probeAndValidate ------------------------------------

test('probeAndValidate: returns total bytes when divisible', async () => {
  HttpRange.clearLocal();
  // Register a 1024-byte blob so probeLength returns 1024.
  const url = HttpRange.registerLocal('sample.fdt', new Blob([new Uint8Array(1024)]));
  const total = await SidecarChecks.probeAndValidate(url, 256, 'EEGLAB .fdt');
  assert.equal(total, 1024);
});

test('probeAndValidate: throws when total is not a multiple of recordBytes', async () => {
  HttpRange.clearLocal();
  const url = HttpRange.registerLocal('sample.fdt', new Blob([new Uint8Array(1023)]));
  await assert.rejects(
    () => SidecarChecks.probeAndValidate(url, 256, 'EEGLAB .fdt'),
    /not a multiple of 256B/);
});

test('probeAndValidate: throws on zero record size', async () => {
  await assert.rejects(
    () => SidecarChecks.probeAndValidate('any', 0, 'BV'),
    /zero-byte record/);
});
