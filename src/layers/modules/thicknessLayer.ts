import type { ExpressionSpecification, GeoJSONSource } from "maplibre-gl";

import type { LayerModule } from "../types";
import { fetchThickness } from "../../lib/modelFields";
import { useModelStore } from "../../store/useModelStore";
import { useThicknessStore } from "../../store/useThicknessStore";

const SRC = "thickness-src";
const LINE = "thickness-line";
const LABEL = "thickness-label";
const ALL = [LINE, LABEL];

const DEFAULT_OPACITY = 0.85;

// A thickness chart is read by its two families: the layer below 540 dam is
// cold enough for snow, above it is not. Dashed, so the isobars stay the solid
// lines of the chart and these read as the second field over them.
const COLD = "#7cb3ff";
const WARM = "#ff8f8f";

const byBand: ExpressionSpecification = ["case", ["==", ["get", "band"], "low"], COLD, WARM];

// Per-map: split screen runs this module on several maps at once.
interface PaneState {
  abort: AbortController | null;
  unsub: () => void;
  seq: number;
}
const state = new WeakMap<import("maplibre-gl").Map, PaneState>();

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** The 540 dam line carries the weight; the rest are hairlines. */
const lineWidth = (scale: number): ExpressionSpecification => [
  "interpolate",
  ["linear"],
  ["zoom"],
  1,
  ["*", scale, ["case", ["get", "key"], 1.4, 0.5]],
  6,
  ["*", scale, ["case", ["get", "key"], 2.2, 0.9]],
  10,
  ["*", scale, ["case", ["get", "key"], 2.9, 1.2]],
];

async function draw(map: import("maplibre-gl").Map): Promise<void> {
  const st = state.get(map);
  if (!st) return;
  const src = map.getSource(SRC) as GeoJSONSource | undefined;
  if (!src) return;

  st.abort?.abort();
  const ctrl = new AbortController();
  st.abort = ctrl;
  const seq = ++st.seq;

  const { modelId, hour } = useModelStore.getState();
  const { interval } = useThicknessStore.getState();
  useThicknessStore.getState().setStatus({ busy: true, error: null });

  try {
    const field = await fetchThickness({ model: modelId, hour, interval }, ctrl.signal);
    if (seq !== st.seq || !map.getSource(SRC)) return;
    src.setData(field.geojson);
    useThicknessStore.getState().setStatus({
      busy: false,
      error: null,
      run: field.run,
      valid: field.valid,
      counts: { lines: field.geojson.features.length },
    });
  } catch (err) {
    if (ctrl.signal.aborted || seq !== st.seq) return;
    src.setData(EMPTY);
    useThicknessStore.getState().setStatus({
      busy: false,
      error: err instanceof Error ? err.message : String(err),
      run: null,
      valid: null,
      counts: { lines: 0 },
    });
  }
}

/** 1000-500 hPa thickness: the dashed red and blue lines of a surface chart. */
export const thicknessLayer: LayerModule = {
  id: "thickness",
  name: "Thickness (1000-500 hPa)",
  description: "How deep the lower half of the atmosphere is — its mean temperature. Below 540 dam, precipitation usually falls as snow.",
  category: "weather",
  source: "Model 500 and 1000 hPa heights",
  defaultVisible: false,
  defaultOpacity: DEFAULT_OPACITY,

  async addTo(map) {
    if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: EMPTY });
    const { labels, lineWidth: width } = useThicknessStore.getState();

    if (!map.getLayer(LINE)) {
      map.addLayer({
        id: LINE,
        type: "line",
        source: SRC,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": byBand,
          "line-width": lineWidth(width),
          "line-opacity": DEFAULT_OPACITY,
          // Dashes in line-width units, so they stay in proportion when the
          // 540 line is drawn heavier than its neighbours.
          "line-dasharray": [3, 2],
        },
      });
    }
    if (!map.getLayer(LABEL)) {
      map.addLayer({
        id: LABEL,
        type: "symbol",
        source: SRC,
        layout: {
          visibility: labels ? "visible" : "none",
          "symbol-placement": "line",
          "symbol-spacing": 340,
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 10,
          "text-letter-spacing": 0.04,
          "text-rotation-alignment": "map",
          "text-pitch-alignment": "viewport",
          "text-allow-overlap": false,
          "text-padding": 4,
        },
        paint: {
          "text-color": byBand,
          "text-halo-color": "#0b0f14",
          "text-halo-width": 1.6,
          "text-opacity": DEFAULT_OPACITY,
        },
      });
    }

    const unsubModel = useModelStore.subscribe(
      (s) => `${s.modelId}|${s.hour}`,
      () => void draw(map),
    );
    const unsubQuery = useThicknessStore.subscribe(
      (s) => s.interval,
      () => void draw(map),
    );
    const unsubStyle = useThicknessStore.subscribe(
      (s) => `${s.labels}|${s.lineWidth}`,
      (v) => {
        const [showLabels, width2] = v.split("|");
        if (map.getLayer(LABEL)) {
          map.setLayoutProperty(LABEL, "visibility", showLabels === "true" ? "visible" : "none");
        }
        if (map.getLayer(LINE)) map.setPaintProperty(LINE, "line-width", lineWidth(Number(width2)));
      },
    );

    state.set(map, {
      abort: null,
      seq: 0,
      unsub: () => {
        unsubModel();
        unsubQuery();
        unsubStyle();
      },
    });

    void useModelStore.getState().load();
    await draw(map);
  },

  removeFrom(map) {
    const st = state.get(map);
    if (st) {
      st.abort?.abort();
      st.unsub();
      state.delete(map);
    }
    for (const id of ALL) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SRC)) map.removeSource(SRC);
    useThicknessStore.getState().setStatus({ busy: false, error: null, run: null, valid: null });
  },

  setOpacity(map, opacity) {
    if (map.getLayer(LINE)) map.setPaintProperty(LINE, "line-opacity", opacity);
    if (map.getLayer(LABEL)) map.setPaintProperty(LABEL, "text-opacity", opacity);
  },

  getLayerIds() {
    return ALL;
  },
};
