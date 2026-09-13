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
import { vwpLayer } from "./modules/vwpLayer";
import { surfaceObsLayer } from "./modules/surfaceObsLayer";
import { obsLayer } from "./modules/obsLayer";
import { satelliteLayer } from "./modules/satelliteLayer";
import { mslpLayer } from "./modules/mslpLayer";
import { thicknessLayer } from "./modules/thicknessLayer";
import { nexradLayer } from "./modules/nexradLayer";
// import { mrmsLayer } from "./modules/mrmsLayer";
import { lsrLayer } from "./modules/lsrLayer";
// import { frontsLayer } from "./modules/frontsLayer";
import { acarsLayer } from "./modules/acarsLayer";
import { chasersLayer } from "./modules/chasersLayer";
import { homesLayer } from "./modules/homesLayer";
import { mesoscaleLayer } from "./modules/mesoscaleLayer";

// Satellite imagery is the bottom of the stack: an opaque picture of the whole
// planet that borders, fields and radar are all read over.
registerLayer(satelliteLayer);
registerLayer(boundariesLayer);
registerLayer(graticuleLayer);
registerLayer(terminatorLayer);
for (const layer of outlookLayers) registerLayer(layer);
registerLayer(alertsLayer);
// Above the outlooks it refines: an MD is hours newer than the day outlook.
registerLayer(mesoscaleLayer);
registerLayer(raobLayer);
registerLayer(vwpLayer);
// The analysed field is a backdrop: isobars, fronts and radar are all read
// over it, so it goes in under them.
registerLayer(obsLayer);
// Thickness under the isobars: the dashed field is the backdrop the solid
// black lines are read against, the way a printed chart layers them.
registerLayer(thicknessLayer);
registerLayer(mslpLayer);
registerLayer(surfaceObsLayer);
registerLayer(acarsLayer);
// Surface fronts are out of the catalogue for now, so nothing -- the Layers
// drawer, a saved workspace -- can switch them on. The module, its panel
// (panels/FrontsView.tsx) and the backend stay as they are; restoring this line
// and the import above brings the product back.
// registerLayer(frontsLayer);
// The national mosaic sits under the single-site radar: MRMS answers "where
// is this across three states", the site radar answers "what is it doing right
// here", and the second is the one you zoom in to read.
//
// Locked for now (the Catalog shows its tile with a padlock). Unregistered
// rather than hidden, so nothing -- the Layers drawer, a saved workspace, the
// catalog tabs -- can switch it on. The module, its picker and the backend
// stay as they are; restoring this line and the import above unlocks it.
// registerLayer(mrmsLayer);
registerLayer(nexradLayer);
// Ground truth sits on top of every product it might be checked against.
registerLayer(lsrLayer);
// Home pins first: they are the static backdrop to the live positions above.
registerLayer(homesLayer);
// People sit above everything: where someone actually is must never be buried.
registerLayer(chasersLayer);
