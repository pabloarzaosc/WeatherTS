import type { ExpressionSpecification, GeoJSONSource } from "maplibre-gl";

import type { LayerModule } from "../types";
import { fetchMslp } from "../../lib/modelFields";
import { useModelStore } from "../../store/useModelStore";
import { useMslpStore } from "../../store/useMslpStore";

const SRC = "mslp-src";
const LINE = "mslp-line";
const LABEL = "mslp-label";
const CENTRE = "mslp-centre";
const ALL = [LINE, LABEL, CENTRE];

const DEFAULT_OPACITY = 0.9;

// A forecaster reads the chart by the 1013-ish divider: lows cool, highs warm.
// Keeping the two families distinct is what makes the pattern legible at a
// glance without reading a single number.
const LOW = "#8ab4ff";
const HIGH = "#f0f3f8";
const H_COLOR = "#6ea8ff";
const L_COLOR = "#ff6b6b";

// Per-map, because split screen runs this module on several maps at once and
// module-level state would have each pane cancelling the others' requests.
interface PaneState {
  abort: AbortController | null;
  unsub: () => void;
  seq: number;
}
const state = new WeakMap<import("maplibre-gl").Map, PaneState>();

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const isLine: ExpressionSpecification = ["==", ["geometry-type"], "LineString"];

/** Standard isobars (every 20 hPa) carry the weight; the rest are hairlines. */
const lineWidth = (scale: number): ExpressionSpecification => [
  "interpolate",
  ["linear"],
  ["zoom"],
  1,
  ["*", scale, ["case", ["get", "major"], 1.3, 0.55]],
  6,
  ["*", scale, ["case", ["get", "major"], 2.1, 1.0]],
  10,
  ["*", scale, ["case", ["get", "major"], 2.8, 1.4]],
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
  const { interval, centres, smoothing } = useMslpStore.getState();
  useMslpStore.getState().setStatus({ busy: true, error: null });

  try {
    const field = await fetchMslp(
      { model: modelId, hour, interval, centres, smooth: smoothing },
      ctrl.signal,
    );
    // A slower earlier request must not overwrite a newer one that already landed.
    if (seq !== st.seq || !map.getSource(SRC)) return;
    src.setData(field.geojson);
    const feats = field.geojson.features;
    useMslpStore.getState().setStatus({
      busy: false,
      error: null,
      run: field.run,
      valid: field.valid,
      runIso: field.runIso,
      counts: {
        isobars: feats.filter((f) => f.geometry.type === "LineString").length,
        centres: feats.filter((f) => f.geometry.type === "Point").length,
      },
    });
  } catch (err) {
    if (ctrl.signal.aborted || seq !== st.seq) return;
    src.setData(EMPTY);
    useMslpStore.getState().setStatus({
      busy: false,
      error: err instanceof Error ? err.message : String(err),
      run: null,
      valid: null,
      runIso: null,
      counts: { isobars: 0, centres: 0 },
    });
  }
}

/** GFS/NAM/HRRR mean sea level pressure: isobars plus the H/L centres. */
export const mslpLayer: LayerModule = {
  id: "mslp",
  name: "Pressure (MSLP)",
  description: "Model mean sea level pressure — isobars and pressure centres.",
  category: "weather",
  source: "NOAA/NCEP via NOMADS",
  defaultVisible: false,
  defaultOpacity: DEFAULT_OPACITY,

  async addTo(map) {
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: "geojson", data: EMPTY });
    }
    const { labels, lineWidth: width, centres } = useMslpStore.getState();

    if (!map.getLayer(LINE)) {
      map.addLayer({
        id: LINE,
        type: "line",
        source: SRC,
        filter: isLine,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ["case", ["==", ["get", "band"], "low"], LOW, HIGH],
          "line-width": lineWidth(width),
          "line-opacity": DEFAULT_OPACITY,
        },
      });
    }
    if (!map.getLayer(LABEL)) {
      map.addLayer({
        id: LABEL,
        type: "symbol",
        source: SRC,
        filter: isLine,
        layout: {
          visibility: labels ? "visible" : "none",
          "symbol-placement": "line",
          "symbol-spacing": 320,
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
          "text-color": ["case", ["==", ["get", "band"], "low"], LOW, HIGH],
          // The halo is what lets a number sit *on* its own contour without the
          // line striking through it.
          "text-halo-color": "#0b0f14",
          "text-halo-width": 1.6,
          "text-opacity": DEFAULT_OPACITY,
        },
      });
    }
    if (!map.getLayer(CENTRE)) {
      map.addLayer({
        id: CENTRE,
        type: "symbol",
        source: SRC,
        filter: ["==", ["geometry-type"], "Point"],
        layout: {
          visibility: centres ? "visible" : "none",
          // The letter and its value are ONE symbol, stacked the way a surface
          // chart writes them. Two layers over the same point fought each other
          // in the collision index and the H/L glyph was the one that lost.
          "text-field": [
            "format",
            ["get", "kind"],
            { "font-scale": 1.6 },
            "\n",
            {},
            ["get", "label"],
            { "font-scale": 0.92 },
          ],
          "text-font": ["Noto Sans Bold"],
          "text-size": 11,
          "text-line-height": 1.05,
          "text-justify": "center",
          "text-allow-overlap": false,
          "text-padding": 3,
        },
        paint: {
          "text-color": ["case", ["==", ["get", "kind"], "H"], H_COLOR, L_COLOR],
          "text-halo-color": "#0b0f14",
          "text-halo-width": 2.2,
        },
      });
    }

    // Any of these changes what the backend should return, or how it is drawn.
    const unsubModel = useModelStore.subscribe(
      (s) => `${s.modelId}|${s.hour}`,
      () => void draw(map),
    );
    const unsubQuery = useMslpStore.subscribe(
      (s) => `${s.interval}|${s.centres}|${s.smoothing}`,
      () => void draw(map),
    );
    const unsubStyle = useMslpStore.subscribe(
      (s) => `${s.labels}|${s.lineWidth}`,
      (v) => {
        const [showLabels, width2] = v.split("|");
        if (map.getLayer(LABEL)) {
          map.setLayoutProperty(LABEL, "visibility", showLabels === "true" ? "visible" : "none");
        }
        if (map.getLayer(LINE)) map.setPaintProperty(LINE, "line-width", lineWidth(Number(width2)));
      },
    );
    const unsubCentres = useMslpStore.subscribe(
      (s) => s.centres,
      (on) => {
        if (map.getLayer(CENTRE)) map.setLayoutProperty(CENTRE, "visibility", on ? "visible" : "none");
      },
    );

    state.set(map, {
      abort: null,
      seq: 0,
      unsub: () => {
        unsubModel();
        unsubQuery();
        unsubStyle();
        unsubCentres();
      },
    });

    // The catalogue may not have loaded yet; the layer still needs a first draw.
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
    useMslpStore.getState().setStatus({ busy: false, error: null, run: null, valid: null });
  },

  setOpacity(map, opacity) {
    if (map.getLayer(LINE)) map.setPaintProperty(LINE, "line-opacity", opacity);
    if (map.getLayer(LABEL)) map.setPaintProperty(LABEL, "text-opacity", opacity);
    if (map.getLayer(CENTRE)) map.setPaintProperty(CENTRE, "text-opacity", opacity);
  },

  getLayerIds() {
    return ALL;
  },

  // Isobars are a reference frame you read *over* whatever product is beneath
  // them; buried under a radar mesh they are worth nothing.
  topLayerIds() {
    return ALL;
  },
};
