/**
 * Layer registration — the SINGLE place to wire up map layers.
 *
 * ┌─ To add a new layer in a future phase ──────────────────────────────────┐
 * │ 1. Create src/layers/modules/<yourLayer>.ts exporting a `LayerModule`.   │
 * │ 2. Import it and call registerLayer() below.                             │
 * │                                                                          │
 * │ That's it. The Zustand store (initLayers), the layer panel (built from   │
 * │ the registry) and the map manager all pick it up automatically — no UI   │
 * │ or store file needs to change.                                           │
 * │                                                                          │
 * │ Example (Phase 2 radar):                                                 │
 * │   import { radarLayer } from "./modules/radar";                          │
 * │   registerLayer(radarLayer);                                             │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
import { registerLayer } from "./registry";
import { boundariesLayer } from "./modules/boundaries";
import { graticuleLayer } from "./modules/graticule";
import { terminatorLayer } from "./modules/terminator";
import { alertsLayer } from "./modules/alertsLayer";
import { outlookLayers } from "./modules/outlooksLayer";
import { raobLayer } from "./modules/raobLayer";
import { surfaceObsLayer } from "./modules/surfaceObsLayer";
import { nexradLayer } from "./modules/nexradLayer";

registerLayer(boundariesLayer);
registerLayer(graticuleLayer);
registerLayer(terminatorLayer);
for (const layer of outlookLayers) registerLayer(layer);
registerLayer(alertsLayer);
registerLayer(raobLayer);
registerLayer(surfaceObsLayer);
registerLayer(nexradLayer);
