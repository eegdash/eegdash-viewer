# Sensor geometry

The second workspace button, **3D geometry**, shows sensor locations for EEG,
iEEG, MEG, fNIRS and EMG. Drag or use arrow keys to rotate, use the wheel or
+/− to zoom, and use Home to reset. Camera presets and the sensor selector
work with the keyboard. Rotation preserves scale. The readout retains the
original coordinates and units, even when display coordinates are transformed.
Switching views preserves the trace controls, channel settings and companion
hand/stimulus panels.

## Coordinate input, with or without a recording

Use **Open recording**, drag and drop, or **Add coordinates** to supply
`*_electrodes.tsv` (`*_optodes.tsv` for fNIRS) with matching
`*_coordsystem.json` files. A signal recording is optional. Multiple spaces
and EMG row-level `coordinate_system` values remain separate selectable groups.
TSVs need `name`, `x`, `y`, `z`; optional columns include `type`, `group`,
`hemisphere` and `coordinate_system`. MNE, FieldTrip and EEGLAB exports can be
converted to these columns without changing their original geometry.

The local, EEGDash and NEMAR inventory paths share entity, directory and
space matching. A different subject's JSON is not a fallback. Ambiguous
matches are reported. A direct remote recording URL can resolve conventional
BIDS inheritance; discovering additional space-qualified files requires an
inventory or explicit coordinate input.

Coordinate-only links use `?tsv=<URL>&coords=<URL>`; `electrodes` and `optodes`
are aliases for `tsv`. Both URLs must resolve to HTTP(S), and remote servers
must permit browser access. A bundled example contains 129 measured EEG
positions from the official BIDS examples:

```text
http://localhost:8011/?tsv=/tests/fixtures/geometry/sub-EP10_ses-01_space-CapTrak_electrodes.tsv&coords=/tests/fixtures/geometry/sub-EP10_ses-01_space-CapTrak_coordsystem.json
```

Without JSON, coordinates retain their supplied axes and unspecified units.
The coordinate controls allow explicit units and a known head frame; only
choose these when the export's origin and orientation are known. Invalid
replacement input reports its error and preserves the previous valid layout.
Coordinate files are limited to 10 MB each. Missing or invalid rows are
reported; 2D positions are never assigned a fabricated depth.

## Native positions and the reference head

- FIFF supplies `CH_INFO.loc[:3]`. A valid device-to-head transform from
  `MEAS_INFO` is applied to MEG display positions. Missing or invalid transforms
  preserve device coordinates and disable the anatomical overlay. Reference
  coils are identified separately and hidden by default; the **Reference
  coils** control restores them. They are physically outside the measurement
  helmet. All-zero native FIFF locations are treated as unavailable.
- SNIRF supplies `sourcePos3D` and `detectorPos3D`, with `LengthUnit` when
  present. Sources are circles and detectors are squares. 2D-only probe
  layouts require a separate 3D coordinate source.
- With no coordinate source, EEG can use exact channel-name matches from
  MNE's `standard_1020` montage. This is labeled as a template. It never fills
  missing participant positions or replaces malformed supplied coordinates.
  Other modalities have no inferred sensor locations.

The reference head is MNE's fsaverage scalp: 2,033 vertices and 4,062
triangles, transformed from MRI coordinates into MNE head coordinates. It is
approximate atlas anatomy, not the participant's head or a source localization
result. The head checkbox and opacity slider control its visibility. Sensor
positions are not snapped or rescaled to fit this atlas.

Regenerate the bundled 94-position montage and scalp using MNE-Python 1.11.0:

```sh
uv run scripts/export-sensor-montage.py
```

The export uses `make_standard_montage`, `compute_native_head_t`,
`read_bem_surfaces` and the bundled `fsaverage-trans.fif`. Python is only
needed to regenerate the static asset. The MNE license is in
[MNE-LICENSE.txt](MNE-LICENSE.txt).

## Frames and limits

CTF, 4DBti, KitYokogawa and EEGLAB use ALS axes. The display applies
`(x, y, z) → (-y, x, z)` to orient them in RAS. CapTrak, Neuromag and ITAB
use RAS axes. Metres and centimetres are scaled uniformly to millimetres for
display. EEG electrode sidecars accompanying MEG use the EEG coordinate
keys, independently of the MEG sensor keys in the same JSON.

Axes alone do not identify an anatomical origin. ACPC and ScanRAS retain
their RAS coordinates but have no reference head overlay. Unknown frames
retain X/Y/Z; unspecified units remain unspecified. EMG local and nested
frames retain their own units, including percent. Parent descriptions or
anchor coordinates alone do not supply a complete spatial registration, so
these frames are not merged or overlaid with a head.

This viewer supports sensor geometry for its five electrophysiology
modalities. It does not load MRI, CT or PET anatomy or perform anatomical
coregistration. Other raw readers use BIDS sidecars or the labeled EEG
template rather than extracting embedded sensor positions.

## Validation

The [BIDS input audit](audits/bids-geometry-sweep.md) records the complete
pinned official-example sweep, exclusions and browser coverage. The
[MNE numerical comparison](audits/mne-fiff-geometry-check.json) checks all
303 coils in the MEG fixture against MNE-Python.

References: [BIDS coordinate systems](https://bids-specification.readthedocs.io/en/stable/appendices/coordinate-systems.html),
[BIDS EMG](https://bids-specification.readthedocs.io/en/stable/modality-specific-files/electromyography.html),
[FieldTrip coordinate conventions](https://www.fieldtriptoolbox.org/faq/source/coordsys/),
[EEGLAB coordinates](https://eeglab.org/tutorials/ConceptsGuide/coordinateSystem.html),
[MNE coordinate transforms](https://mne.tools/stable/auto_tutorials/forward/20_source_alignment.html),
[SNIRF probe specification](https://github.com/fNIRS/snirf/blob/master/snirf_specification.md).
