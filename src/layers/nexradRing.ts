import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";

import { paneIdOf } from "../map/mapInstance";
import { useNexradStore } from "../store/useNexradStore";

// The radar's range ring: one circle at the edge of the current product's
// coverage. Owned by nexradLayer's lifecycle.

const SRC = "nexrad-ring-src";
export const RING_LINE = "nexrad-ring-line";

const KM_PER_DEG_LAT = 111.32;
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

// Per-map, so several panes can each own a ring without unsubscribing
// each other. See nexradLayer for why module-level state breaks under panes.
const unsubs = new WeakMap<MapLibreMap, () => void>();

/** A closed circle of `radiusKm` around a point, as a line ring. */
function ring(lon: number, lat: number, radiusKm: number): GeoJSON.Feature {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const dLon = radiusKm / (KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  const coords: [number, number][] = [];
  for (let i = 0; i <= 128; i++) {
    const a = (i / 128) * 2 * Math.PI;
    coords.push([lon + dLon * Math.sin(a), lat + dLat * Math.cos(a)]);
  }
  return { type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} };
}

export function pushRing(map: MapLibreMap): void {
  const src = map.getSource(SRC) as GeoJSONSource | undefined;
  if (!src) return;
  const st = useNexradStore.getState();
  // THIS pane's scan, not the store's top-level one: panes show different
  // products, and the products have different ranges (reflectivity 460 km,
  // dual-pol ~300), so a shared ring would be wrong in most panes.
  const paneId = paneIdOf(map);
  const scan = (paneId && st.paneRadar[paneId]?.scan) || null;
  const showRing = st.showRing;
  // The radius is the *loaded product's* range, not a fixed number: reflectivity
  // reaches 460 km while the dual-pol moments stop around 300.
  if (!showRing || !scan) {
    src.setData(EMPTY);
    return;
  }
  const { siteLon, siteLat, maxRangeKm } = scan.meta;
  src.setData({ type: "FeatureCollection", features: [ring(siteLon, siteLat, maxRangeKm)] });
}

export function addRing(map: MapLibreMap): void {
  if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: EMPTY });
  if (!map.getLayer(RING_LINE)) {
    map.addLayer({
      id: RING_LINE,
      type: "line",
      source: SRC,
      layout: { "line-cap": "round" },
      paint: {
        "line-color": "#8ea0b6",
        "line-width": 1.3,
        "line-opacity": 0.55,
        "line-dasharray": [3, 3],
      },
    });
  }
  unsubs.set(map, useNexradStore.subscribe((s, prev) => {
    const id = paneIdOf(map);
    const rev = id ? s.paneRadar[id]?.meshRev : undefined;
    const prevRev = id ? prev.paneRadar[id]?.meshRev : undefined;
    if (rev !== prevRev || s.showRing !== prev.showRing) pushRing(map);
  }));
  pushRing(map);
}

export function removeRing(map: MapLibreMap): void {
  unsubs.get(map)?.();
  unsubs.delete(map);
  if (map.getLayer(RING_LINE)) map.removeLayer(RING_LINE);
  if (map.getSource(SRC)) map.removeSource(SRC);
}
