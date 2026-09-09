// bids-loader.js was copied verbatim from the sister electrode-explorer
// project, where its tests live. Here we add direct unit tests for the
// parsing surface this viewer actually uses (electrodes.tsv +
// coordsystem.json) so a regression in the shared file shows up in
// our suite, not only in the cross-project one.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import './_bootstrap.mjs';   // side-effect: registers globalThis.BIDSLoader

const BIDSLoader = globalThis.BIDSLoader;

// ----- parseElectrodesTSV ----------------------------------

test('parseElectrodesTSV: standard 4-column file', () => {
  const tsv = 'name\tx\ty\tz\nFp1\t-0.029\t0.083\t-0.012\nCz\t0.0\t0.0\t0.087\nT7\t-0.082\t0.0\t-0.012\nT8\t0.082\t0.0\t-0.012\n';
  const rows = BIDSLoader.parseElectrodesTSV(tsv);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].name, 'Fp1');
  assert.equal(rows[0].z, -0.012);
});

test('parseElectrodesTSV: rejects file with header only (no data rows)', () => {
  assert.throws(() => BIDSLoader.parseElectrodesTSV('name\tx\ty\tz\n'),
    /no rows/);
});

test('parseElectrodesTSV: accepts small layouts without requiring a sphere fit', () => {
  const tsv = 'name\tx\ty\tz\nFp1\t-0.029\t0.083\t-0.012\nCz\t0\t0\t0.087\n';
  assert.equal(BIDSLoader.parseElectrodesTSV(tsv).length, 2);
});

test('parseElectrodesTSV: rejects missing required column', () => {
  assert.throws(() => BIDSLoader.parseElectrodesTSV('name\tx\ty\nFp1\t0\t0\n'),
    /missing one of: name, x, y, z/);
});

test('parseElectrodesTSV: skips rows with n/a coordinates', () => {
  const tsv =
    'name\tx\ty\tz\n' +
    'Fp1\t-0.029\t0.083\t-0.012\n' +
    'BAD\tn/a\tn/a\tn/a\n' +
    'Cz\t0.0\t0.0\t0.087\n' +
    'T7\t-0.082\t0.0\t-0.012\n' +
    'T8\t0.082\t0.0\t-0.012\n';
  const rows = BIDSLoader.parseElectrodesTSV(tsv);
  assert.equal(rows.length, 4);
  assert.ok(!rows.some(r => r.name === 'BAD'));
});

test('parseElectrodesTSV: preserves optional BIDS columns', () => {
  const tsv = 'name\tx\ty\tz\themisphere\tgroup\nFp1\t0\t0\t0\tL\tA\nFp2\t0\t0\t0\tR\tA\nFp3\t0\t0\t0\tL\tB\nFp4\t0\t0\t0\tR\tB\n';
  const rows = BIDSLoader.parseElectrodesTSV(tsv);
  assert.equal(rows[0].hemisphere, 'L');
  assert.equal(rows[0].group, 'A');
});

// ----- parseCoordsystem ------------------------------------

test('parseCoordsystem: parses EEG-prefixed keys', () => {
  const json = '{"EEGCoordinateSystem":"CapTrak","EEGCoordinateUnits":"mm"}';
  const cs = BIDSLoader.parseCoordsystem(json);
  assert.equal(cs.space, 'CapTrak');
  assert.equal(cs.units, 'mm');
});

test('parseCoordsystem: accepts the iEEG prefix variant', () => {
  const json = '{"iEEGCoordinateSystem":"ACPC","iEEGCoordinateUnits":"mm"}';
  const cs = BIDSLoader.parseCoordsystem(json);
  assert.equal(cs.space, 'ACPC');
});

test('parseCoordsystem: preserves unspecified units rather than inventing metres', () => {
  const cs = BIDSLoader.parseCoordsystem('{}');
  assert.equal(cs.space, 'Other');
  assert.equal(cs.units, 'n/a');
});

test('parseCoordsystem: pulls AnatomicalLandmarkCoordinates through', () => {
  const json = JSON.stringify({
    EEGCoordinateSystem: 'CapTrak',
    EEGCoordinateUnits: 'mm',
    AnatomicalLandmarkCoordinates: { Nz: [0, 100, 0], LPA: [-80, 0, 0], RPA: [80, 0, 0] },
  });
  const cs = BIDSLoader.parseCoordsystem(json);
  assert.deepEqual(cs.landmarks.Nz, [0, 100, 0]);
});
