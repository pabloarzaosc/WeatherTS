import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent } from "maplibre-gl";

import type { LayerModule } from "../types";
import { BACKEND_BASE } from "../../lib/apiConfig";
import { useMesoscaleStore, type MesoscaleMD } from "../../store/useMesoscaleStore";
import { useAlertStore } from "../../store/useAlertStore";
import { getSetting } from "../../settings/useSettingsStore";

const SRC = "spc-md";
const FILL = "spc-md-fill";
const LINE = "spc-md-line";
const LABEL = "spc-md-label";

/** Colour by what the discussion is actually about. Severe and flood are
 *  different jobs on a chase day, so they must not read as one product. */
const HAZARD_COLOR = [
  "match",
  ["get", "hazard"],
  "severe", "#ef4444",
  "flood", "#3b82f6",
  "#f5a524",
] as never;

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/**
 * The last collection fetched, so a re-added source starts populated.
 *
 * A style reload (a basemap or theme change) drops every source, and the layer
 * is then rebuilt empty; without this it stays blank until the next refresh,
 * up to two minutes of no discussions on a map that has them.
 */
let lastFc: GeoJSON.FeatureCollection = EMPTY;

/** MDs are issued continuously. Half the backend's cache window, so a newly
 *  issued one is at most one cache generation late rather than two -- the
 *  requests that land inside the window are answered from it and cost nothing. */
const REFRESH_MS = 60_000;
/** The live edge moves on its own, so the filter is re-evaluated on a tick --
 *  otherwise a lapsed discussion stays drawn until the next fetch. */
const EXPIRY_TICK_MS = 30_000;

const timers = new WeakMap<MapLibreMap, ReturnType<typeof setInterval>>();
const handlers = new WeakMap<MapLibreMap, (e: MapLayerMouseEvent) => void>();
const hovers = new WeakMap<MapLibreMap, { onEnter: () => void; onLeave: () => void }>();
const unsubs = new WeakMap<MapLibreMap, () => void>();

/**
 * Show the discussions in force at the instant on screen -- and only those.
 *
 * The backend serves the last day so that dragging the timeline back has
 * something to find, but a day is roughly thirty discussions and drawing them
 * together is meaningless: they are written one after another over the same
 * ground, so the map turns into a pile of outlines. At any real moment there
 * are one or two.
 *
 * Rides the SAME clock the alerts do: MapTimeline writes that filter for
 * whichever product is driving the axis, so scrubbing a radar loop moves the
 * discussions with it. A discussion whose valid window could not be parsed
 * stays visible -- hiding one because its time was unreadable would be worse
 * than showing it a little too long.
 */
function applyTimeFilter(map: MapLibreMap) {
  const t = useAlertStore.getState().timeFilter ?? Date.now() / 1000;
  const f = [
    "any",
    ["!", ["has", "validStartUnix"]],
    [
      "all",
      ["<=", ["coalesce", ["get", "validStartUnix"], 0], t],
      [">=", ["coalesce", ["get", "validEndUnix"], 0], t],
    ],
  ] as never;
  for (const id of [FILL, LINE, LABEL]) if (map.getLayer(id)) map.setFilter(id, f);
}

/** Rough centroid of a ring, so a card can anchor to the polygon. */
function centroid(ring: GeoJSON.Position[]): [number, number] {
  let x = 0;
  let y = 0;
  for (const [lon, lat] of ring) {
    x += lon;
    y += lat;
  }
  return [x / ring.length, y / ring.length];
}

async function load(map: MapLibreMap) {
  try {
    const r = await fetch(`${BACKEND_BASE}/api/spc/mesoscale`);
    if (!r.ok) return;
    const fc = (await r.json()) as GeoJSON.FeatureCollection;
    lastFc = fc;
    const src = map.getSource(SRC) as GeoJSONSource | undefined;
    if (src) src.setData(fc);
    // No source means the style was reloading when this landed. The next addTo
    // seeds from lastFc, so the response is not lost -- it used to be dropped
    // here while the store still filled, which read as "the map lost the MDs".

    // Mirror into the store so the card and the report read plain objects
    // rather than digging through GeoJSON on every render.
    useMesoscaleStore.getState().setMds(
      fc.features.map((f) => {
        const p = (f.properties ?? {}) as Record<string, unknown>;
        const ring =
          f.geometry?.type === "Polygon" ? (f.geometry.coordinates[0] as GeoJSON.Position[]) : [];
        const [lon, lat] = ring.length ? centroid(ring) : [0, 0];
        return { ...(p as unknown as MesoscaleMD), lon, lat };
      }),
    );
  } catch {
    // A missed refresh just leaves the previous discussions on screen.
  }
}

/**
 * SPC Mesoscale Discussions.
 *
 * The product a forecaster writes between the scheduled outlooks, about one
 * area, right now -- and the one that says whether a watch is coming. Drawn
 * above the outlooks it refines, because an MD is hours newer than the day
 * outlook underneath it.
 */
export const mesoscaleLayer: LayerModule = {
  id: "spc-md",
  name: "SPC Mesoscale Discussions",
  description:
    "Live SPC mesoscale discussions — the forecaster's read on one area now, including whether a watch is likely.",
  // Alerts, not Outlooks: an MD is a live "watching this area right now"
  // product on the same clock as a warning, not a planning horizon.
  category: "alerts",
  source: "NOAA/NWS Storm Prediction Center and Weather Prediction Center",
  // On by default: it is the product that says whether a watch is coming, and
  // it is only ever a couple of polygons, so it costs nothing to have on.
  defaultVisible: true,
  defaultOpacity: 0.9,

  addTo(map) {
    // Same reason as alertsLayer: a style reload re-runs addTo on a live map,
    // and the old subscription, tick and poll would otherwise be left running.
    // The timer especially: setting a new one overwrites the handle to the old,
    // which then fetches forever with nothing able to stop it.
    unsubs.get(map)?.();
    const stale = timers.get(map);
    if (stale) clearInterval(stale);

    if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: lastFc });

    if (!map.getLayer(FILL)) {
      map.addLayer({
        id: FILL,
        type: "fill",
        source: SRC,
        paint: { "fill-color": HAZARD_COLOR, "fill-opacity": 0.13 },
      });
    }
    if (!map.getLayer(LINE)) {
      map.addLayer({
        id: LINE,
        type: "line",
        source: SRC,
        layout: { "line-cap": "round", "line-join": "round" },
        // Heavy enough to read over a busy alert map, light enough not to
        // shout: this sits above the county warnings, not instead of them.
        paint: { "line-color": HAZARD_COLOR, "line-width": 2, "line-opacity": 0.85 },
      });
    }
    if (!map.getLayer(LABEL)) {
      map.addLayer({
        id: LABEL,
        type: "symbol",
        source: SRC,
        layout: {
          "text-field": ["concat", ["case", ["==", ["get", "kind"], "mpd"], "MPD ", "MD "], ["to-string", ["get", "number"]]],
          "text-font": ["Noto Sans Bold"],
          "text-size": 12,
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": HAZARD_COLOR,
          "text-halo-color": "rgba(5,8,13,0.95)",
          "text-halo-width": 1.8,
        },
      });
    }

    // Selecting, not navigating away: the card names the discussion and the
    // card itself opens the whole product, the same two steps a storm cell has.
    //
    // Bound to the border and the label, not the fill. A discussion's coverage
    // can span several counties, and MapLibre's per-layer click listeners each
    // hit-test independently -- there is no "topmost layer wins" arbitration
    // between them. With FILL as the target, clicking a storm cell or an LSR
    // marker anywhere inside that coverage also matched this layer's own click
    // listener and popped the discussion card on top of whatever was actually
    // clicked. The line and the label are the things a chaser means to click
    // on when they mean to click on the discussion itself.
    const onClick = (e: MapLayerMouseEvent) => {
      const id = e.features?.[0]?.properties?.id;
      if (typeof id !== "string") return;
      const st = useMesoscaleStore.getState();
      st.select(st.selectedId === id ? null : id);
    };
    map.on("click", [LINE, LABEL], onClick);
    const cursor = (v: string) => () => { map.getCanvas().style.cursor = v; };
    const onEnter = cursor("pointer"), onLeave = cursor("");
    map.on("mouseenter", [LINE, LABEL], onEnter);
    map.on("mouseleave", [LINE, LABEL], onLeave);
    hovers.set(map, { onEnter, onLeave });
    handlers.set(map, onClick);

    void load(map);
    applyTimeFilter(map);
    const unsubTime = useAlertStore.subscribe((s) => s.timeFilter, () => applyTimeFilter(map));
    const expiry = setInterval(() => applyTimeFilter(map), EXPIRY_TICK_MS);
    unsubs.set(map, () => {
      unsubTime();
      clearInterval(expiry);
    });
    timers.set(map, setInterval(() => void load(map), REFRESH_MS));
  },

  removeFrom(map) {
    const t = timers.get(map);
    if (t) clearInterval(t);
    timers.delete(map);
    unsubs.get(map)?.();
    unsubs.delete(map);
    const h = handlers.get(map);
    if (h) {
      map.off("click", [LINE, LABEL], h);
      handlers.delete(map);
    }
    const hv = hovers.get(map);
    if (hv) {
      map.off("mouseenter", [LINE, LABEL], hv.onEnter);
      map.off("mouseleave", [LINE, LABEL], hv.onLeave);
      hovers.delete(map);
    }
    for (const id of [LABEL, LINE, FILL]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },

  setOpacity(map, opacity) {
    // Scaled from the same bases the layer is built with, so the slider thins
    // the outline from what is on screen rather than from a stale figure.
    // The fill strength is md.fill in Settings (0.13).
    if (map.getLayer(FILL)) map.setPaintProperty(FILL, "fill-opacity", +(getSetting<number>("md.fill") * opacity).toFixed(4));
    if (map.getLayer(LINE)) map.setPaintProperty(LINE, "line-opacity", 0.85 * opacity);
    if (map.getLayer(LABEL)) map.setPaintProperty(LABEL, "text-opacity", opacity);
  },

  getLayerIds() {
    return [FILL, LINE, LABEL];
  },

  // The border and the number, not the fill: same trick alertsLayer uses for
  // its own outline. The scan mesh (nexradLayer's GL_LAYER) is registered
  // after this module and isn't itself lifted, so in the normal pass it lands
  // above whatever this module leaves in normal position -- meaning the fill
  // stays under radar, right where the gradient reads as a wash over the scan
  // rather than a wash the scan is drawn through. LINE and LABEL are lifted,
  // so the boundary and its number stay legible over the scan regardless.
  topLayerIds() {
    return [LINE, LABEL];
  },
  // Above alerts and isobars (0): a live discussion outranks a general warning
  // border. Below radar's site names and storm cells (20) and LSR (30): those
  // are specific, clickable things, and a watch-area outline should not bury
  // a point marker.
  topPriority: 10,
};
