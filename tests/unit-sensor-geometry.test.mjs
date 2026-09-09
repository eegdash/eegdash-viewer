import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import './_bootstrap.mjs';
const require = createRequire(import.meta.url);
require('../sensor-montage.js');
const { buildGroups, displayPoint } = require('../sensor-geometry.js');
const point = { name: 'Cz', x: 1, y: 2, z: 3 };

test('all five modalities retain real positions; sources take precedence over templates', () => {
  for (const suffix of ['eeg', 'ieeg', 'meg', 'nirs', 'emg']) {
    const meta = { suffix, [suffix === 'nirs' ? 'optodes' : 'electrodes']: [point],
      coordsystem: { space: 'CTF', units: 'cm' } };
    const groups = buildGroups(meta, { channel_labels: ['Cz', 'Fz'] });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].points.length, 1);
    assert.equal(groups[0].template, false);
    assert.deepEqual(groups[0].points[0].display, [-20, 10, 30]);
    assert.equal(groups[0].points[0].x, 1, 'readout retains original coordinates');
  }
});

test('MNE template is EEG-only, exact-label matched, and excludes auxiliary channels', () => {
  const reader = { channel_labels: ['Cz', 'Fp1', 'ECG', 'unknown'] };
  const [group] = buildGroups({ suffix: 'eeg', channels: [{ name: 'Fp1', type: 'EOG' }] }, reader);
  assert.equal(group.template, true);
  assert.deepEqual(group.points.map(p => p.name), ['Cz']);
  assert.ok(group.points[0].z > 0.1 && group.points[0].z < 0.16);
  for (const suffix of ['ieeg', 'meg', 'nirs', 'emg']) assert.deepEqual(buildGroups({ suffix }, reader), []);
});

test('known frames normalize axes and units; unknown axes and units remain unchanged', () => {
  for (const space of ['EEGLAB', 'EEGLAB-HJ', 'CTF', '4DBti', 'KitYokogawa']) {
    assert.deepEqual(displayPoint(point, space, 'mm'), [-2, 1, 3]);
  }
  assert.deepEqual(displayPoint(point, 'CapTrak', 'm'), [1000, 2000, 3000]);
  assert.deepEqual(displayPoint(point, 'Other', 'n/a'), [1, 2, 3]);
  const cs = BIDSLoader.parseCoordsystem({ EEGCoordinateUnits: 'mm', MEGCoordinateUnits: 'm', MEGCoordinateSystem: 'CTF' }, 'meg');
  assert.equal(cs.units, 'm');
  assert.equal(cs.space, 'CTF');
});

test('independent EMG frames and FIFF device/head frames are never superimposed', () => {
  const groups = buildGroups({ suffix: 'emg', electrodes: [
    { ...point, coordinate_system: 'forearm' }, { ...point, coordinate_system: 'upperarm' },
  ], coordsystem: { space: 'forearm', units: 'cm' } });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].units, 'cm');
  assert.equal(groups[1].units, 'n/a');
  const native = [{ source: 'FIFF', space: 'FIFF device', units: 'm', points: [{ ...point, type: 'MEG' }] }];
  assert.equal(buildGroups({ suffix: 'meg', electrodes: [point] }, { sensor_geometry: native }).length, 2);
});

test('missing or malformed positions cannot silently become zero or a template', () => {
  assert.throws(() => BIDSLoader.parseElectrodesTSV('name\tx\ty\tz\nA\t\t0\t0\nB\t1mm\t2\t3'), /No sensors/);
  assert.equal(BIDSLoader.parseElectrodesTSV('name\tx\ty\tz\nA\t0\t0\t0')[0].x, 0);
  assert.deepEqual(buildGroups({ suffix: 'eeg', electrodes: [{ ...point, z: NaN }] }, { channel_labels: ['Cz'] }), []);
});

test('fNIRS optodes resolve through the shared metadata assembler', () => {
  const meta = BIDSRecording._assembleRecordingMetadata({ suffix: 'nirs', hits: {
    optodes: { text: 'name\tx\ty\tz\ttype\nS1\t1\t2\t3\tsource\nD1\t4\t5\t6\tdetector', url: 'optodes.tsv' },
    coordsystem: { text: '{"NIRSCoordinateSystem":"CapTrak","NIRSCoordinateUnits":"mm"}', url: 'coordsystem.json' },
  } });
  assert.equal(meta.optodes.length, 2);
  assert.equal(meta.sidecar_sources.optodes, 'optodes.tsv');
  assert.equal(buildGroups(meta)[0].points[1].type, 'detector');
});

test('MEG electrode sidecars use EEG coordinates and report partial missing rows on every loading path', async () => {
  const table = 'name\tx\ty\tz\nCz\t0\t0\t0.1\nMissing\tn/a\tn/a\tn/a';
  const json = JSON.stringify({ EEGCoordinateSystem: 'CapTrak', EEGCoordinateUnits: 'm',
    MEGCoordinateSystem: 'CTF', MEGCoordinateUnits: 'cm' });
  const remote = BIDSRecording._assembleRecordingMetadata({ suffix: 'meg', hits: {
    electrodes: { text: table, url: 'sub-01_electrodes.tsv' },
    coordsystem: { text: json, url: 'sub-01_coordsystem.json' },
  } });
  const indexed = { suffix: 'meg', ...await BIDSRecording.loadCoordinateSets([
    new File([table], 'sub-01_electrodes.tsv'), new File([json], 'sub-01_coordsystem.json'),
  ], { suffix: 'meg' }) };
  for (const meta of [remote, indexed]) {
    const [group] = buildGroups(meta);
    assert.equal(group.displaySpace, 'CapTrak');
    assert.equal(group.points[0].type, 'EEG');
    assert.deepEqual(group.points[0].display, [0, 0, 100]);
    assert.match(meta.coordinate_errors.join(' '), /1 row\(s\) skipped/);
  }
});

test('FIFF preserves device positions, applies the MNE head transform, and identifies reference coils', async () => {
  const bytes = fs.readFileSync('tests/fixtures/meg/test_ctf_comp_raw.fif');
  const url = HttpRange.registerLocal('sub-01_meg.fif', new Blob([bytes]));
  const reader = await FiffReader.open({ eeg_url: url });
  const [group] = buildGroups({ suffix: 'meg' }, reader);
  assert.equal(group.points.filter(p => p.type === 'MEGREF').length, 29);
  assert.equal(group.points.filter(p => p.type === 'MEG').length, 274);
  assert.equal(group.displaySpace, 'MNE head');
  const p = group.points.find(p => p.name === 'MLC11-2908');
  assert.ok(p, 'measurement sensor present');
  assert.ok(Math.abs(p.display[2] - p.z * 1000) > 40, 'device origin is not the head origin');
  // Independently computed with MNE-Python 1.11.0 apply_trans(dev_head_t, loc[:3]).
  [-18.9968039534, 75.1921495343, 133.4340256201].forEach((v, i) => assert.ok(Math.abs(p.display[i] - v) < 1e-6));
});

test('invalid BIDS coordinate sidecars do not silently fall back to template electrodes', () => {
  const meta = BIDSRecording._assembleRecordingMetadata({ suffix: 'eeg', hits: {
    electrodes: { text: 'name\tx\ty\tz\nCz\tn/a\tn/a\tn/a', url: 'sub-01_electrodes.tsv' },
  } });
  assert.deepEqual(buildGroups(meta, { channel_labels: ['Cz'] }), []);
  assert.ok(meta.coordinate_errors.length);
});

const coordinateFile = (name, text) => new File([text], name);
const coordinateTable = 'name\tx\ty\tz\nCz\t0\t0\t10';

test('coordinate inventory keeps spaces paired and excludes other subjects and acquisitions', async () => {
  const result = await BIDSRecording.loadCoordinateSets([
    coordinateFile('sub-02_space-CapTrak_coordsystem.json', '{"EEGCoordinateSystem":"CapTrak","EEGCoordinateUnits":"m"}'),
    coordinateFile('sub-01_space-CapTrak_electrodes.tsv', coordinateTable),
    coordinateFile('sub-01_space-CapTrak_coordsystem.json', '{"EEGCoordinateSystem":"CapTrak","EEGCoordinateUnits":"cm"}'),
    coordinateFile('sub-01_space-ACPC_electrodes.tsv', coordinateTable),
    coordinateFile('sub-01_space-ACPC_coordsystem.json', '{"iEEGCoordinateSystem":"ACPC","iEEGCoordinateUnits":"mm"}'),
    coordinateFile('sub-02_space-CapTrak_electrodes.tsv', coordinateTable),
    coordinateFile('sub-01_acq-other_electrodes.tsv', coordinateTable),
  ], { prefix: 'sub-01_task-rest', suffix: 'eeg' });
  assert.equal(result.coordinate_sets.length, 2);
  assert.deepEqual(result.coordinate_sets.map(s => s.coordsystem.units), ['cm', 'mm']);
  assert.equal(result.coordinate_errors.length, 0);
});

test('EMG row frames use their own JSON units, including percent and nested frame descriptions', async () => {
  const result = await BIDSRecording.loadCoordinateSets([
    coordinateFile('sub-01_electrodes.tsv', 'name\tx\ty\tz\tcoordinate_system\nE1\t25\t40\t0\tForearm\nE2\t1\t2\t0\tGrid'),
    coordinateFile('sub-01_space-Forearm_coordsystem.json', '{"EMGCoordinateSystem":"Other","EMGCoordinateUnits":"percent"}'),
    coordinateFile('sub-01_space-Grid_coordsystem.json', '{"EMGCoordinateSystem":"Other","EMGCoordinateUnits":"mm","ParentCoordinateSystem":"Forearm"}'),
  ], { suffix: 'emg' });
  const groups = buildGroups({ suffix: 'emg', ...result });
  assert.deepEqual(groups.map(g => [g.space, g.units, g.points[0].display]), [
    ['Forearm', 'percent', [25, 40, 0]], ['Grid', 'mm', [1, 2, 0]],
  ]);
});

test('coordinate parsing reports skipped rows and rejects ambiguous names and invalid JSON shapes', () => {
  const warnings = [];
  assert.equal(BIDSLoader.parseElectrodesTSV(coordinateTable + '\nX\tn/a\tn/a\tn/a', warnings).length, 1);
  assert.equal(warnings.length, 1);
  assert.throws(() => BIDSLoader.parseElectrodesTSV(coordinateTable + '\nCz\t1\t1\t1'), /Duplicate/);
  for (const value of ['null', '[]', '42']) assert.throws(() => BIDSLoader.parseCoordsystem(value), /object/);
});

test('FIFF ignores a singular transform rather than collapsing sensors to the head origin', async () => {
  const bytes = Buffer.from(fs.readFileSync('tests/fixtures/meg/test_ctf_comp_raw.fif'));
  for (let pos = 0; pos + 16 <= bytes.length;) {
    const kind = bytes.readInt32BE(pos), size = bytes.readInt32BE(pos + 8);
    if (kind === 222 && bytes.readInt32BE(pos + 16) === 1 && bytes.readInt32BE(pos + 20) === 4) {
      bytes.fill(0, pos + 24, pos + 24 + 48);
    }
    pos += 16 + size;
  }
  const url = HttpRange.registerLocal('singular_meg.fif', new Blob([bytes]));
  const reader = await FiffReader.open({ eeg_url: url });
  const [group] = buildGroups({ suffix: 'meg' }, reader);
  assert.equal(group.displaySpace, 'FIFF device');
  assert.ok(group.points.some(p => p.display.some(v => v !== 0)));
});
