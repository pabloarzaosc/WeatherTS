import type { ExpressionSpecification, GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import type { LayerModule } from "../types";
import { useAlertStore } from "../../store/useAlertStore";
import { alertsToFeatureCollection } from "../../lib/nwsAlerts";

const SRC = "alerts-src";
const FILL = "alerts-fill";
const OUTLINE = "alerts-outline";
const DEFAULT_ALERT_OPACITY = 0.86;

/** Source id the AlertController feeds with fetched alert polygons. */
export const ALERT_SOURCE = SRC;

// Per-map: split-screen adds this module to several maps, and module-level
// handlers would have each pane detaching the previous pane's listeners.
interface PaneState {
  onClick: (e: MapLayerMouseEvent) => void;
  onEnter: () => void;
  onLeave: () => void;
  unsubTime: () => void;
}
const state = new WeakMap<import("maplibre-gl").Map, PaneState>();

/**
 * Show only alerts in force at `t` (unix seconds); null = now, i.e. everything
 * we fetched. Scrubbing the radar timeline back before a warning was issued
 * should hide it, so the map matches the scan underneath it.
 */
function timeFilterExpr(t: number | null): ExpressionSpecification | null {
  if (t === null) return null;
  return [
    "all",
    ["<=", ["coalesce", ["get", "startUnix"], 0], t],
    [">=", ["coalesce", ["get", "endUnix"], 0], t],
  ];
}

function pushTimeFilter(map: import("maplibre-gl").Map) {
  const expr = timeFilterExpr(useAlertStore.getState().timeFilter);
  for (const id of [FILL, OUTLINE]) {
    if (map.getLayer(id)) map.setFilter(id, expr);
  }
}

const priority: ExpressionSpecification = ["coalesce", ["get", "priority"], 0];
const sortKey: ExpressionSpecification = ["to-number", ["get", "priority"], 0];

const fillOpacity = (opacity: number): ExpressionSpecification => [
  "interpolate",
  ["linear"],
  priority,
  0,
  0.025 * opacity,
  350,
  0.04 * opacity,
  650,
  0.065 * opacity,
  900,
  0.09 * opacity,
  1200,
  0.12 * opacity,
];

const lineOpacity = (opacity: number): ExpressionSpecification => [
  "interpolate",
  ["linear"],
  priority,
  0,
  0.28 * opacity,
  350,
  0.42 * opacity,
  650,
  0.58 * opacity,
  900,
  0.76 * opacity,
  1200,
  0.9 * opacity,
];

const lineWidth: ExpressionSpecification = [
  "interpolate",
  ["linear"],
  priority,
  0,
  0.65,
  350,
  0.9,
  650,
  1.25,
  900,
  1.75,
  1200,
  2.35,
];

/** NWS active alerts as colored polygons; click one to open its detail panel.
 *  The polygon data is fed by AlertController; this module owns the map plumbing. */
export const alertsLayer: LayerModule = {
  id: "nws-alerts",
  name: "Weather Alerts (NWS)",
  description: "Active US NWS warnings & advisories. Click a polygon for full detail.",
  category: "alerts",
  source: "api.weather.gov - public domain",
  defaultVisible: true,
  defaultOpacity: DEFAULT_ALERT_OPACITY,

  addTo(map) {
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    }
    if (!map.getLayer(FILL)) {
      map.addLayer({
        id: FILL,
        type: "fill",
        source: SRC,
        layout: { "fill-sort-key": sortKey },
        paint: { "fill-color": ["get", "color"], "fill-opacity": fillOpacity(DEFAULT_ALERT_OPACITY) },
      });
    }
    if (!map.getLayer(OUTLINE)) {
      map.addLayer({
        id: OUTLINE,
        type: "line",
        source: SRC,
        layout: { "line-sort-key": sortKey },
        paint: { "line-color": ["get", "color"], "line-width": lineWidth, "line-opacity": lineOpacity(DEFAULT_ALERT_OPACITY) },
      });
    }

    const source = map.getSource(SRC) as GeoJSONSource | undefined;
    source?.setData(alertsToFeatureCollection(useAlertStore.getState().features));

    const unsubTime = useAlertStore.subscribe(
      (s) => s.timeFilter,
      () => pushTimeFilter(map),
    );
    pushTimeFilter(map);

    const onClick = (e: MapLayerMouseEvent) => {
      const rendered = map.queryRenderedFeatures(e.point, { layers: [FILL] });
      const ids = Array.from(
        new Set(
          rendered
            .map((feature) => feature.properties?.id)
            .filter((id): id is string | number => id != null)
            .map(String),
        ),
      );
      if (ids.length > 0) useAlertStore.getState().selectMany(ids);
    };
    const onEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
    };
    map.on("click", FILL, onClick);
    map.on("mouseenter", FILL, onEnter);
    map.on("mouseleave", FILL, onLeave);
    state.set(map, { onClick, onEnter, onLeave, unsubTime });

    // signal the controller to start fetching
    useAlertStore.getState().setActive(true);
  },

  removeFrom(map) {
    const st = state.get(map);
    if (st) {
      map.off("click", FILL, st.onClick);
      map.off("mouseenter", FILL, st.onEnter);
      map.off("mouseleave", FILL, st.onLeave);
      st.unsubTime();
      state.delete(map);
    }
    if (map.getLayer(OUTLINE)) map.removeLayer(OUTLINE);
    if (map.getLayer(FILL)) map.removeLayer(FILL);
    if (map.getSource(SRC)) map.removeSource(SRC);
    const s = useAlertStore.getState();
    s.setActive(false);
    s.select(null);
  },

  setOpacity(map, opacity) {
    if (map.getLayer(FILL)) map.setPaintProperty(FILL, "fill-opacity", fillOpacity(opacity));
    if (map.getLayer(OUTLINE)) map.setPaintProperty(OUTLINE, "line-opacity", lineOpacity(opacity));
  },

  getLayerIds() {
    return [FILL, OUTLINE];
  },

  // The polygon border has to stay readable over whatever product is drawn on
  // top of the fill -- radar, in particular, should cover the shading but never
  // hide where the warning actually is.
  topLayerIds() {
    // Both, not just the outline. The manager lifts exactly what is listed
    // here, so naming only OUTLINE left FILL wherever it happened to sit --
    // which, once the radar module added its mesh, was underneath it: turning
    // on a radar site made the shaded alert areas vanish and left bare outlines.
    // FILL first so OUTLINE is moved last and stays on top of it.
    return [FILL, OUTLINE];
  },
};
