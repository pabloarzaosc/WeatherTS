import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { LayerModule } from "../types";
import { buildTerminator } from "../geo/terminator";

const SOURCE_ID = "terminator";
const FILL_LAYER = "terminator-fill";
const REFRESH_MS = 60_000;

// Module-scoped so the interface stays clean (no extra field on the literal).
// Per-map so one pane removing the layer can't stop another pane's clock.
const timers = new WeakMap<import("maplibre-gl").Map, ReturnType<typeof setInterval>>();

/** Optional day/night shading computed from the current sun position. */
export const terminatorLayer: LayerModule = {
  id: "terminator",
  name: "Day / Night Terminator",
  description: "Night-side shading from the current sun position.",
  category: "reference",
  source: "Computed client-side",
  defaultVisible: false,
  defaultOpacity: 0.45,

  addTo(map) {
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, { type: "geojson", data: buildTerminator() });
    }
    if (!map.getLayer(FILL_LAYER)) {
      map.addLayer({
        id: FILL_LAYER,
        type: "fill",
        source: SOURCE_ID,
        paint: { "fill-color": "#070d1f", "fill-opacity": 0.45 },
      });
    }
    // Keep the shadow honest over time — without any timeline UI.
    timers.set(map, setInterval(() => refresh(map), REFRESH_MS));
  },
  removeFrom(map) {
    const timer = timers.get(map);
    if (timer) {
      clearInterval(timer);
      timers.delete(map);
    }
    if (map.getLayer(FILL_LAYER)) map.removeLayer(FILL_LAYER);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  },
  setOpacity(map, opacity) {
    if (map.getLayer(FILL_LAYER)) map.setPaintProperty(FILL_LAYER, "fill-opacity", opacity);
  },
  getLayerIds() {
    return [FILL_LAYER];
  },
};

function refresh(map: MapLibreMap): void {
  const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData(buildTerminator());
}
