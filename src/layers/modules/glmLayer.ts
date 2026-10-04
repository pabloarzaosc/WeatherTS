import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";

import type { LayerModule } from "../types";
import { GLM_AGES } from "../../lib/glm";
import { useGlmStore } from "../../store/useGlmStore";

const SRC = "glm-src";
/** A soft halo under the flashes of the last minute: the ones happening now. */
const NOW = "glm-now";
const FLASHES = "glm-flashes";
const DEFAULT_OPACITY = 1;

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

interface PaneState {
  unsub: () => void;
  onMoveEnd: () => void;
}
const state = new WeakMap<MapLibreMap, PaneState>();
let opacity = DEFAULT_OPACITY;
/** Panes the layer is on: the live window refreshes while there is one. */
let attached = 0;

/** White for the last minute, through yellow and orange to crimson and a
 *  dark magenta for the oldest: the ramp lightning maps have long used, so the
 *  newest stand out over radar of any colour. */
const COLOR: ExpressionSpecification = (() => {
  const expr: unknown[] = ["step", ["get", "a"], GLM_AGES[0].color];
  for (let i = 1; i < GLM_AGES.length; i++) expr.push(GLM_AGES[i - 1].upTo, GLM_AGES[i].color);
  return expr as ExpressionSpecification;
})();

const RADIUS: ExpressionSpecification = [
  "interpolate", ["linear"], ["zoom"],
  3, ["case", ["<", ["get", "a"], 60], 2.4, 1.6],
  7, ["case", ["<", ["get", "a"], 60], 3.4, 2.4],
  11, ["case", ["<", ["get", "a"], 60], 5, 3.6],
];

function push(map: MapLibreMap) {
  const src = map.getSource(SRC) as GeoJSONSource | undefined;
  if (!src) return;
  const data = useGlmStore.getState().data;
  if (!data) {
    src.setData(EMPTY);
    return;
  }
  const v = data.values;
  const features: GeoJSON.Feature[] = new Array(data.count);
  for (let i = 0; i < data.count; i++) {
    const k = i * 4;
    features[i] = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [v[k], v[k + 1]] },
      properties: { a: v[k + 2] },
    };
  }
  // Oldest first, as the backend sends them: the newest are drawn last, on top.
  src.setData({ type: "FeatureCollection", features });
}

/** Lightning from the GOES Geostationary Lightning Mappers: every flash. */
export const glmLayer: LayerModule = {
  id: "glm",
  name: "Lightning (GLM)",
  description:
    "Every flash, in-cloud and cloud-to-ground, seen from orbit by the GOES-East and GOES-West lightning mappers. Coloured by age.",
  category: "weather",
  source: "NOAA GOES-19 / GOES-18 Geostationary Lightning Mapper",
  defaultVisible: false,
  defaultOpacity: DEFAULT_OPACITY,

  addTo(map) {
    if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: EMPTY });
    if (!map.getLayer(NOW)) {
      map.addLayer({
        id: NOW,
        type: "circle",
        source: SRC,
        filter: ["<", ["get", "a"], 60],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 6, 7, 9, 11, 13],
          "circle-color": "#ffffff",
          "circle-blur": 1,
          "circle-opacity": 0.35 * opacity,
        },
      });
    }
    if (!map.getLayer(FLASHES)) {
      map.addLayer({
        id: FLASHES,
        type: "circle",
        source: SRC,
        paint: {
          "circle-radius": RADIUS,
          "circle-color": COLOR,
          // A dark edge so the white and yellow ones read over a light basemap.
          "circle-stroke-color": "rgba(10,12,18,0.7)",
          "circle-stroke-width": 0.6,
          "circle-opacity": opacity,
          "circle-stroke-opacity": opacity,
        },
      });
    }

    // A pan or zoom needs the flashes of the new view.
    const onMoveEnd = () => useGlmStore.getState().reload();
    map.on("moveend", onMoveEnd);
    const unsub = useGlmStore.subscribe((s, prev) => {
      if (s.data !== prev.data) push(map);
    });
    state.set(map, { unsub, onMoveEnd });

    push(map);
    attached += 1;
    useGlmStore.getState().startPolling();
    // Fresh when the layer comes on (what is held may be from an hour ago);
    // a second pane must not restart the request the first is waiting on.
    if (attached === 1 || !useGlmStore.getState().data) useGlmStore.getState().reload();
  },

  removeFrom(map) {
    const st = state.get(map);
    if (st) {
      map.off("moveend", st.onMoveEnd);
      st.unsub();
      state.delete(map);
      attached = Math.max(0, attached - 1);
      if (attached === 0) useGlmStore.getState().stopPolling();
    }
    for (const id of [FLASHES, NOW]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },

  setOpacity(map, o) {
    opacity = o;
    if (map.getLayer(FLASHES)) {
      map.setPaintProperty(FLASHES, "circle-opacity", o);
      map.setPaintProperty(FLASHES, "circle-stroke-opacity", o);
    }
    if (map.getLayer(NOW)) map.setPaintProperty(NOW, "circle-opacity", 0.35 * o);
  },

  getLayerIds() {
    return [NOW, FLASHES];
  },

  // Over the radar scan and the alert outlines -- a flash is read against
  // both -- and below the tracked storm cells (20) and storm reports (30).
  topLayerIds() {
    return [NOW, FLASHES];
  },
  topPriority: 15,
};
