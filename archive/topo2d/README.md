# topo2d.js — archived 2026-05-21

This module implements an MNE/EEGLAB-style 2D EEG topographic map
renderer. It has full unit-test coverage (71.29% mutation score at
time of archive) and works as designed when instantiated.

It is archived rather than deleted because production `index.html`
never instantiated `EEGTopo2D` — the wiring is incomplete on the
viewer side (there's no overlay slot, no controller that calls
`Topo2D.init()`). Janitor finding F2 in the 2026-05-20 dead-code
audit flagged this.

## Restoring

If a future PR wires topo2d into the viewer UI:

1. `git mv archive/topo2d/topo2d.js ./topo2d.js`
2. `git mv archive/topo2d/unit-topo2d.test.mjs tests/unit-topo2d.test.mjs`
3. Add `<script src="topo2d.js?v=1"></script>` to `index.html` between
   `traces.js` and `viewer.js`.
4. Add the integration code in viewer.js — minimum: a metadata-overlay
   slot that calls `EEGTopo2D.init(containerEl)` and `setMontage()` /
   `setSelected()` on channel selection.
5. Re-add to `stryker.conf.json`'s mutate list and commandRunner.

The original tests still pass against the archived file:

```bash
node --test archive/topo2d/unit-topo2d.test.mjs
```
