import type { ExpressionSpecification, GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import type { LayerModule } from "../types";
import { useAlertStore } from "../../store/useAlertStore";
import { markerUnderPoint } from "../clickPriority";
import { getSetting, useSettingsStore } from "../../settings/useSettingsStore";
import { alertFilters, alertMapData, alertMotionData } from "../../lib/alertStyle";
import { flashingIds, onFlashChange } from "../../lib/alertFlash";
import { allMaps, paneIdOf, setActivePane } from "../../map/mapInstance";
import { useAlertListStore } from "../../store/useAlertListStore";

const SRC = "alerts-src";
const FILL = "alerts-fill";
const CASING = "alerts-casing";
const OUTLINE = "alerts-outline";
const WATCH_CASING = "alerts-watch-casing";
const WATCH_LINE = "alerts-watch-line";
const ADVISORY_CASING = "alerts-advisory-casing";
const ADVISORY_LINE = "alerts-advisory-line";
const FLASH_FILL = "alerts-flash-fill";
const FLASH_LINE = "alerts-flash-line";
const FLASH_CASING = "alerts-flash-casing";
const MOTION_SRC = "alerts-motion-src";
const MOTION_CASING = "alerts-motion-casing";
const MOTION_LINE = "alerts-motion-line";
const MOTION_LABEL = "alerts-motion-label";
const DEFAULT_ALERT_OPACITY = 0.86;

/** Source id the AlertController feeds with fetched alert polygons. */
export const ALERT_SOURCE = SRC;
/** Source id of the storm motion arrows (alertStyle.alertMotionData). */
export const ALERT_MOTION_SOURCE = MOTION_SRC;

// Per-map: split-screen adds this module to several maps, and module-level
// handlers would have each pane detaching the previous pane's listeners.
interface PaneState {
  onClick: (e: MapLayerMouseEvent) => void;
  onEnter: () => void;
  onLeave: () => void;
  unsubTime: () => void;
  activeTimer: number;
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
  // Settings' filters: types switched off, states, offices, only active. The
  // list applies the same test (alertStyle.passesAlertFilters).
  const f = alertFilters();
  if (f.hidden.length) clauses.push(["!", ["in", ["coalesce", ["get", "evKey"], ""], ["literal", f.hidden]]]);
  if (f.onlyActive) clauses.push(["<=", ["coalesce", ["get", "onsetUnix"], 0], t ?? Math.round(Date.now() / 1000)]);
  if (f.states.length) {
    clauses.push(["any", ...f.states.map((st) => ["in", `|${st}|`, ["coalesce", ["get", "states"], ""]])] as ExpressionSpecification);
  }
  if (f.wfos.length) clauses.push(["in", ["coalesce", ["get", "wfo"], ""], ["literal", f.wfos]]);
  // The alert list's eyes: whole groups, single types, single alerts.
  const lv = useAlertListStore.getState();
  if (lv.hiddenGroups.length) clauses.push(["!", ["in", ["coalesce", ["get", "grp"], ""], ["literal", lv.hiddenGroups]]]);
  if (lv.hiddenTypes.length) clauses.push(["!", ["in", ["coalesce", ["get", "evKey"], ""], ["literal", lv.hiddenTypes]]]);
  if (lv.hiddenIds.length) clauses.push(["!", ["in", ["to-string", ["get", "id"]], ["literal", lv.hiddenIds]]]);
  return clauses.length > 0 ? (["all", ...clauses] as ExpressionSpecification) : null;
}

const withExpr = (expr: ExpressionSpecification | null, more: ExpressionSpecification): ExpressionSpecification =>
  expr ? (["all", expr, more] as ExpressionSpecification) : more;

/** The flashing alerts, under the same filter as the rest. */
function flashFilter(expr: ExpressionSpecification | null): ExpressionSpecification {
  return withExpr(expr, ["in", ["get", "id"], ["literal", flashingIds()]]);
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
/** True for a watch. */
const IS_WATCH: ExpressionSpecification = ["==", kindOf, "watch"];
/** True for an advisory. */
const IS_ADVISORY: ExpressionSpecification = ["==", kindOf, "advisory"];

/**
 * Watches and advisories get a line of their own, above everything like the
 * warnings' outline. Colour alone was their whole shape, and that colour sat
 * under the Models field and the radar with the rest of the fills: with a model
 * on the map, a Tornado Watch or a Wind Advisory was not there at all. Neither
 * reads as a warning's hard edge: a watch is dashed, an advisory dotted -- the
 * weaker the tier, the lighter the line.
 */
const WATCH_DASH = [4, 2.6];
/** Round-capped dashes this short are dots. */
const ADVISORY_DASH = [0.1, 2.4];

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
  // With every tier outlined in Settings, watches and advisories already have a line.
  const outlined = getSetting<boolean>("alerts.outlineWatches");
  const tier = (is: ExpressionSpecification) => (expr ? (["all", expr, is] as ExpressionSpecification) : is);
  for (const [ids, is] of [
    [[WATCH_CASING, WATCH_LINE], IS_WATCH],
    [[ADVISORY_CASING, ADVISORY_LINE], IS_ADVISORY],
  ] as const) {
    for (const id of ids) {
      if (!map.getLayer(id)) continue;
      map.setFilter(id, tier(is));
      map.setLayoutProperty(id, "visibility", outlined ? "none" : "visible");
    }
  }
  for (const id of [FLASH_FILL, FLASH_CASING, FLASH_LINE]) if (map.getLayer(id)) map.setFilter(id, flashFilter(expr));
  const arrows = getSetting<boolean>("alerts.motionArrows") ? "visible" : "none";
  for (const id of [MOTION_CASING, MOTION_LINE, MOTION_LABEL]) {
    if (!map.getLayer(id)) continue;
    map.setFilter(id, withExpr(expr, ["==", ["get", "part"], id === MOTION_LABEL ? "label" : "arrow"]));
    map.setLayoutProperty(id, "visibility", arrows);
  }
}

/**
 * The flash: the flashing alerts' outline and fill pulse, on every pane, while
 * any flash runs. One clock for all maps; only paint values change between
 * ticks (no data, no re-tiling).
 */
let flashClock: number | null = null;
function flashTick(): void {
  const phase = (Date.now() % 900) / 900;
  const pulse = 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI);
  for (const map of allMaps()) {
    const line = +(0.15 + 0.85 * pulse).toFixed(2);
    if (map.getLayer(FLASH_LINE)) map.setPaintProperty(FLASH_LINE, "line-opacity", line);
    if (map.getLayer(FLASH_CASING)) map.setPaintProperty(FLASH_CASING, "line-opacity", +(line * 0.7).toFixed(2));
    if (map.getLayer(FLASH_FILL)) map.setPaintProperty(FLASH_FILL, "fill-opacity", +(0.32 * pulse).toFixed(2));
  }
}
onFlashChange(() => {
  const any = flashingIds().length > 0;
  for (const map of allMaps()) if (map.getLayer(FLASH_LINE)) pushFilter(map);
  if (any && flashClock === null) flashClock = window.setInterval(flashTick, 60);
  if (!any && flashClock !== null) {
    window.clearInterval(flashClock);
    flashClock = null;
  }
});

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
// The fill strength itself is alerts.warningFill in Settings (0.1).
//
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
// draw no outline at all, so their fill has to carry the whole shape alone
// (alerts.areaFill, 0.14) -- unless Settings outlines them too.
//
// Written here and only here. The Settings styler used to write its own
// version of this over the top, the manager wrote this one back on the next
// reconcile, and the two traded places every frame; being data-driven, each
// write also re-tiled every alert polygon.
const fillOpacity = (opacity: number): ExpressionSpecification | number => {
  const warning = +(getSetting<number>("alerts.warningFill") * opacity).toFixed(4);
  // Each type's own fill strength (its Settings page, 1x by default).
  const mul: ExpressionSpecification = ["coalesce", ["get", "fillMul"], 1];
  if (getSetting<boolean>("alerts.outlineWatches")) return ["*", mul, warning];
  return ["*", mul, ["case", NO_OUTLINE, +(getSetting<number>("alerts.areaFill") * opacity).toFixed(4), warning]];
};

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
          // The tier's colour when it has one (baked as "color" by alertStyle).
          "line-color": ["get", "color"],
          "line-width": strokeWidth as never,
          "line-opacity": lineOpacity(DEFAULT_ALERT_OPACITY),
        },
      });
    }

    // Advisories: a thin dark line under coloured dots.
    if (!map.getLayer(ADVISORY_CASING)) {
      map.addLayer({
        id: ADVISORY_CASING,
        type: "line",
        source: SRC,
        layout: { "line-sort-key": sortKey, "line-join": "round" },
        paint: {
          "line-color": CASING_COLOR,
          "line-width": 1.1,
          "line-opacity": lineOpacity(DEFAULT_ALERT_OPACITY),
        },
      });
    }
    if (!map.getLayer(ADVISORY_LINE)) {
      map.addLayer({
        id: ADVISORY_LINE,
        type: "line",
        source: SRC,
        layout: { "line-sort-key": sortKey, "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": 2.2,
          "line-dasharray": ADVISORY_DASH,
          "line-opacity": lineOpacity(DEFAULT_ALERT_OPACITY),
        },
      });
    }
    if (!map.getLayer(WATCH_CASING)) {
      map.addLayer({
        id: WATCH_CASING,
        type: "line",
        source: SRC,
        layout: { "line-sort-key": sortKey, "line-join": "round" },
        paint: {
          "line-color": CASING_COLOR,
          "line-width": 1.5 + CASING_EXTRA_PX,
          "line-opacity": lineOpacity(DEFAULT_ALERT_OPACITY),
        },
      });
    }
    if (!map.getLayer(WATCH_LINE)) {
      map.addLayer({
        id: WATCH_LINE,
        type: "line",
        source: SRC,
        layout: { "line-sort-key": sortKey, "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": 1.5,
          "line-dasharray": WATCH_DASH,
          "line-opacity": lineOpacity(DEFAULT_ALERT_OPACITY),
        },
      });
    }

    // Flashing alerts: a pulsing fill and a wide line in the type's flash colour.
    if (!map.getLayer(FLASH_FILL)) {
      map.addLayer({
        id: FLASH_FILL,
        type: "fill",
        source: SRC,
        filter: ["in", ["get", "id"], ["literal", []]],
        paint: { "fill-color": ["coalesce", ["get", "flashColor"], "#ffffff"], "fill-opacity": 0 },
      });
    }
    // A dark band under the flash line, so a white flash reads on a light map too.
    if (!map.getLayer(FLASH_CASING)) {
      map.addLayer({
        id: FLASH_CASING,
        type: "line",
        source: SRC,
        filter: ["in", ["get", "id"], ["literal", []]],
        layout: { "line-join": "round" },
        paint: { "line-color": CASING_COLOR, "line-width": ["+", 5, ["*", 2, strokeWidth]] as never, "line-opacity": 0 },
      });
    }
    if (!map.getLayer(FLASH_LINE)) {
      map.addLayer({
        id: FLASH_LINE,
        type: "line",
        source: SRC,
        filter: ["in", ["get", "id"], ["literal", []]],
        layout: { "line-join": "round" },
        paint: {
          "line-color": ["coalesce", ["get", "flashColor"], "#ffffff"],
          "line-width": ["+", 2.5, ["*", 2, strokeWidth]] as never,
          "line-opacity": 0,
          "line-blur": 0.6,
        },
      });
    }

    // Storm motion arrows (storm-based warnings), above the outlines.
    if (!map.getSource(MOTION_SRC)) {
      map.addSource(MOTION_SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    }
    if (!map.getLayer(MOTION_CASING)) {
      map.addLayer({
        id: MOTION_CASING,
        type: "line",
        source: MOTION_SRC,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": CASING_COLOR, "line-width": 4.2, "line-opacity": lineOpacity(DEFAULT_ALERT_OPACITY) },
      });
    }
    if (!map.getLayer(MOTION_LINE)) {
      map.addLayer({
        id: MOTION_LINE,
        type: "line",
        source: MOTION_SRC,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 2, "line-opacity": lineOpacity(DEFAULT_ALERT_OPACITY) },
      });
    }
    if (!map.getLayer(MOTION_LABEL)) {
      map.addLayer({
        id: MOTION_LABEL,
        type: "symbol",
        source: MOTION_SRC,
        minzoom: 6,
        layout: {
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 11,
          "text-allow-overlap": false,
          "text-padding": 2,
        },
        paint: { "text-color": ["get", "color"], "text-halo-color": "rgba(6,10,16,0.9)", "text-halo-width": 1.4 },
      });
    }

    const features = useAlertStore.getState().features;
    (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(alertMapData(features));
    (map.getSource(MOTION_SRC) as GeoJSONSource | undefined)?.setData(alertMotionData(features));

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
    // The filters Settings holds: motion arrows, only active, states, offices,
    // and every type's switch -- one signature, so other edits do not refilter.
    const filterSig = (v: Record<string, unknown>) =>
      Object.keys(v)
        .filter((k) => /^alerts\.(motionArrows|onlyActive|states|wfos)$|^alerts\.type\..*\.on$/.test(k))
        .sort()
        .map((k) => `${k}=${String(v[k])}`)
        .join(";");
    const unsubFilters = useSettingsStore.subscribe((s) => filterSig(s.values), () => pushFilter(map));
    const unsubEyes = useAlertListStore.subscribe(
      (s) => [s.hiddenGroups, s.hiddenTypes, s.hiddenIds] as const,
      () => pushFilter(map),
      { equalityFn: (a, b) => a.every((v, i) => v === b[i]) },
    );
    const unsubTime = () => {
      unsubEyes();
      unsubTimeOnly();
      unsubCategory();
      unsubOutlines();
      unsubFilters();
    };
    pushFilter(map);
    // "Only active" compares onset with now while the timeline is live.
    const activeTimer = window.setInterval(() => {
      if (getSetting<boolean>("alerts.onlyActive") && useAlertStore.getState().timeFilter === null) pushFilter(map);
    }, 60_000);

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
      // Every alert under the click, in a card at the point (AlertPointCard);
      // a row of it opens the full text in the rail.
      if (ids.length > 0) {
        const pane = paneIdOf(map);
        if (pane) setActivePane(pane);
        useAlertListStore.getState().openPoint({ lon: e.lngLat.lng, lat: e.lngLat.lat, ids });
      }
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
    state.set(map, { onClick, onEnter, onLeave, unsubTime, activeTimer });

    // signal the controller to start fetching
    useAlertStore.getState().setActive(true);
  },

  removeFrom(map, styleSwap) {
    const st = state.get(map);
    if (st) {
      map.off("click", FILL, st.onClick);
      map.off("mouseenter", FILL, st.onEnter);
      map.off("mouseleave", FILL, st.onLeave);
      st.unsubTime();
      window.clearInterval(st.activeTimer);
      state.delete(map);
    }
    for (const id of [MOTION_LABEL, MOTION_LINE, MOTION_CASING, FLASH_LINE, FLASH_CASING, FLASH_FILL]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(MOTION_SRC)) map.removeSource(MOTION_SRC);
    for (const id of [WATCH_LINE, WATCH_CASING, ADVISORY_LINE, ADVISORY_CASING]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getLayer(OUTLINE)) map.removeLayer(OUTLINE);
    if (map.getLayer(CASING)) map.removeLayer(CASING);
    if (map.getLayer(FILL)) map.removeLayer(FILL);
    if (map.getSource(SRC)) map.removeSource(SRC);
    // Closing one split-screen pane (panes-layout) must not stop the alerts
    // the other panes still draw: inactive only when no map has them left.
    if (styleSwap || allMaps().some((m) => m !== map && m.getSource(SRC))) return;
    const s = useAlertStore.getState();
    s.setActive(false);
    s.select(null);
  },

  setOpacity(map, opacity) {
    if (map.getLayer(FILL)) map.setPaintProperty(FILL, "fill-opacity", fillOpacity(opacity));
    if (map.getLayer(CASING)) map.setPaintProperty(CASING, "line-opacity", lineOpacity(opacity));
    if (map.getLayer(OUTLINE)) map.setPaintProperty(OUTLINE, "line-opacity", lineOpacity(opacity));
    for (const id of [ADVISORY_CASING, ADVISORY_LINE, WATCH_CASING, WATCH_LINE, MOTION_CASING, MOTION_LINE]) {
      if (map.getLayer(id)) map.setPaintProperty(id, "line-opacity", lineOpacity(opacity));
    }
  },

  getLayerIds() {
    return [FILL, FLASH_FILL, ADVISORY_CASING, ADVISORY_LINE, WATCH_CASING, WATCH_LINE, CASING, OUTLINE, FLASH_CASING, FLASH_LINE, MOTION_CASING, MOTION_LINE, MOTION_LABEL];
  },

  // The polygon border has to stay readable over whatever product is drawn on
  // top of the fill -- radar, in particular, should cover the shading but never
  // hide where the warning actually is.
  topLayerIds() {
    // The outline only, deliberately. Listing FILL here as well would lift the
    // shading above the radar mesh too, and the scan is the thing you want to
    // read -- so the fill stays where the normal order puts it (under radar,
    // which is registered later) while the border still marks the warning.
    // Casing first: it has to stay directly under the line it belongs to. The
    // tiers stack by weight -- advisory dots, then watch dashes, then warnings:
    // a warning inside a watch is the edge that matters.
    // The flash and the motion arrows ride on top of the outlines.
    return [ADVISORY_CASING, ADVISORY_LINE, WATCH_CASING, WATCH_LINE, CASING, OUTLINE, FLASH_CASING, FLASH_LINE, MOTION_CASING, MOTION_LINE, MOTION_LABEL];
  },
};
