import type { ExpressionSpecification, GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import type { LayerModule } from "../types";
import { useAlertStore } from "../../store/useAlertStore";
import { alertsToFeatureCollection } from "../../lib/nwsAlerts";
import { markerUnderPoint } from "../clickPriority";
import { getSetting, useSettingsStore } from "../../settings/useSettingsStore";

const SRC = "alerts-src";
const FILL = "alerts-fill";
const CASING = "alerts-casing";
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
 * What the map is allowed to draw: alerts in force at the timeline's time, in a
 * category the user hasn't switched off. Both halves live in one filter because
 * MapLibre keeps a single filter per layer -- pushing them separately meant
 * whichever ran last silently dropped the other.
 *
 * `timeFilter` null = now, i.e. everything fetched; scrubbing the radar loop
 * back before a warning was issued should hide it, so the map matches the scan
 * underneath it. The category flags come stamped on each feature by
 * alertsToFeatureCollection, so this needs no round trip through the store.
 */
function visibilityExpr(): ExpressionSpecification | null {
  const { timeFilter: t, categoryFilters: cat } = useAlertStore.getState();
  const clauses: ExpressionSpecification[] = [];
  if (t !== null) {
    clauses.push(["<=", ["coalesce", ["get", "startUnix"], 0], t]);
    clauses.push([">=", ["coalesce", ["get", "endUnix"], 0], t]);
  }
  // An alert can sit in more than one bucket (a Tornado Warning is tornado AND
  // severe), so any unchecked bucket it belongs to hides it -- same rule the
  // side list uses in selectVisibleAlerts.
  if (!cat.tornado) clauses.push(["!", ["coalesce", ["get", "catTornado"], false]]);
  if (!cat.special) clauses.push(["!", ["coalesce", ["get", "catSpecial"], false]]);
  if (!cat.severe) clauses.push(["!", ["coalesce", ["get", "catSevere"], false]]);
  return clauses.length > 0 ? (["all", ...clauses] as ExpressionSpecification) : null;
}

/**
 * Tiers drawn as colour only.
 *
 * A watch and an advisory both cover wide areas for hours around something
 * that has not happened yet. An outline gives that a hard, warning-shaped edge
 * and the map fills with boundaries that mean much less than they look like
 * they mean, so the line work is kept for the alerts that really do have one.
 */
const NO_LINE_KINDS = ["watch", "advisory"];
const kindOf: ExpressionSpecification = ["coalesce", ["get", "kind"], "other"];

/** True for a tier that gets an outline. */
const HAS_OUTLINE: ExpressionSpecification = ["match", kindOf, NO_LINE_KINDS, false, true];
/** True for a tier drawn as colour only. */
const NO_OUTLINE: ExpressionSpecification = ["match", kindOf, NO_LINE_KINDS, true, false];

function pushFilter(map: import("maplibre-gl").Map) {
  const expr = visibilityExpr();
  if (map.getLayer(FILL)) map.setFilter(FILL, expr);
  // Settings can outline every tier; by default the colour-only tiers get none.
  const tiers = getSetting<boolean>("alerts.outlineWatches") ? null : HAS_OUTLINE;
  const lineFilter = expr && tiers ? (["all", expr, tiers] as ExpressionSpecification) : (expr ?? tiers);
  // The casing is half of the same stroke, so it lives by the same rule -- one
  // left showing under a hidden outline would just be a black border.
  for (const id of [CASING, OUTLINE]) {
    if (!map.getLayer(id)) continue;
    map.setFilter(id, lineFilter);
  }
}

const priority: ExpressionSpecification = ["coalesce", ["get", "priority"], 0];
const sortKey: ExpressionSpecification = ["to-number", ["get", "priority"], 0];

// One weight for every alert on the map, whatever it is.
//
// Fill and line used to ramp with alertPriority(), so two Severe Thunderstorm
// Warnings could draw at visibly different strengths depending on the hail size
// and wind quoted in them. Nothing here ever read the expiry time, but on
// screen the complaint is the same either way: an alert that is in force is in
// force, and a polygon that looks half-lit reads as one that is half-over.
// Colour already says which product it is; opacity now only says "here".
const ALERT_FILL = 0.1;
// Bright enough to read over reflectivity, which is the background this line
// actually has to survive. Dimming it was what kept it from shouting before,
// but that only worked over a pale basemap -- over a red core the line simply
// vanished. The casing below does that job properly, so the line itself can go
// back to being a line.
const ALERT_LINE = 0.85;

// A dark stroke under the coloured one.
//
// Radar is the worst possible background for a thin coloured line: somewhere on
// any storm there is a pixel of the same hue and brightness as the warning
// colour, and right there the border disappears. A casing gives every edge its
// own contrast instead of borrowing it from whatever happens to be underneath
// -- the same trick a road gets on a printed map.
const CASING_COLOR = "rgba(6,10,16,0.75)";
const CASING_EXTRA_PX = 1.6;

// The one exception, and it is about tier rather than strength: the tiers above
// draw no outline at all, so their fill has to carry the whole shape alone.
const NO_LINE_FILL = 0.14;

const fillOpacity = (opacity: number): ExpressionSpecification => [
  "case",
  NO_OUTLINE,
  NO_LINE_FILL * opacity,
  ALERT_FILL * opacity,
];

const lineOpacity = (opacity: number): number => ALERT_LINE * opacity;

// Thinner across the board, keeping the same ranking. A warning polygon is
// often only a few counties wide on screen; at the old top of 2.35 px the
// border was eating the shape it was supposed to outline.
const lineWidth: ExpressionSpecification = [
  "interpolate",
  ["linear"],
  priority,
  0,
  0.5,
  350,
  0.65,
  650,
  0.85,
  900,
  1.1,
  1200,
  1.4,
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
    // A style reload (basemap or theme) wipes the layers and the manager calls
    // addTo again for the same, still-live map. Without dropping the previous
    // listeners first they stack up, one more copy per switch.
    state.get(map)?.unsubTime();

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
    // Severe thunderstorm and tornado warnings carry a touch more weight than
    // the rest. They are the two a chaser is scanning for, and on a busy map
    // the difference between "a warning" and "the warning" should be visible
    // before the label is read.
    const convectiveWidthMult: ExpressionSpecification = [
      "case",
      ["coalesce", ["get", "convective"], false],
      1.3,
      1,
    ];
    // multiplier increases outline weight for emergencies / PDS
    const specialWidthMult: ExpressionSpecification = [
      "case",
      ["get", "isEmergency"],
      1.8,
      ["get", "isPDS"],
      1.3,
      1,
    ];
    const strokeWidth: ExpressionSpecification = [
      "*",
      specialWidthMult,
      convectiveWidthMult,
      lineWidth,
    ];

    // Added before the outline, so it is drawn under it.
    if (!map.getLayer(CASING)) {
      map.addLayer({
        id: CASING,
        type: "line",
        source: SRC,
        layout: { "line-sort-key": sortKey },
        paint: {
          "line-color": CASING_COLOR,
          "line-width": ["+", strokeWidth, CASING_EXTRA_PX] as never,
          "line-opacity": lineOpacity(DEFAULT_ALERT_OPACITY),
        },
      });
    }
    if (!map.getLayer(OUTLINE)) {
      map.addLayer({
        id: OUTLINE,
        type: "line",
        source: SRC,
        layout: { "line-sort-key": sortKey },
        paint: {
          "line-color": ["case", ["get", "isEmergency"], "#ff1d48", ["get", "color"]],
          "line-width": strokeWidth as never,
          "line-opacity": lineOpacity(DEFAULT_ALERT_OPACITY),
        },
      });
    }

    const source = map.getSource(SRC) as GeoJSONSource | undefined;
    source?.setData(alertsToFeatureCollection(useAlertStore.getState().features));

    const unsubTimeOnly = useAlertStore.subscribe(
      (s) => s.timeFilter,
      () => pushFilter(map),
    );
    const unsubCategory = useAlertStore.subscribe(
      (s) => s.categoryFilters,
      () => pushFilter(map),
    );
    const unsubOutlines = useSettingsStore.subscribe(
      (s) => s.values["alerts.outlineWatches"],
      () => pushFilter(map),
    );
    const unsubTime = () => {
      unsubTimeOnly();
      unsubCategory();
      unsubOutlines();
    };
    pushFilter(map);

    const onClick = (e: MapLayerMouseEvent) => {
      // A sounding dot drawn on top of this polygon is what the user aimed at;
      // opening the alert as well turns one click into two unrelated panels.
      if (markerUnderPoint(map, e.point)) return;
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
    if (map.getLayer(CASING)) map.removeLayer(CASING);
    if (map.getLayer(FILL)) map.removeLayer(FILL);
    if (map.getSource(SRC)) map.removeSource(SRC);
    const s = useAlertStore.getState();
    s.setActive(false);
    s.select(null);
  },

  setOpacity(map, opacity) {
    if (map.getLayer(FILL)) map.setPaintProperty(FILL, "fill-opacity", fillOpacity(opacity));
    if (map.getLayer(CASING)) map.setPaintProperty(CASING, "line-opacity", lineOpacity(opacity));
    if (map.getLayer(OUTLINE)) map.setPaintProperty(OUTLINE, "line-opacity", lineOpacity(opacity));
  },

  getLayerIds() {
    return [FILL, CASING, OUTLINE];
  },

  // The polygon border has to stay readable over whatever product is drawn on
  // top of the fill -- radar, in particular, should cover the shading but never
  // hide where the warning actually is.
  topLayerIds() {
    // The outline only, deliberately. Listing FILL here as well would lift the
    // shading above the radar mesh too, and the scan is the thing you want to
    // read -- so the fill stays where the normal order puts it (under radar,
    // which is registered later) while the border still marks the warning.
    // Casing first: it has to stay directly under the line it belongs to.
    return [CASING, OUTLINE];
  },
};
