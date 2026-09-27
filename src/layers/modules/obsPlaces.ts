import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap, MapSourceDataEvent } from "maplibre-gl";

import { fetchObsPoints, isTrackSource } from "../../lib/observations";
import { loadPlaces, type Place } from "../../lib/stormImpacts";
import { VECTOR_SOURCE } from "../../map/basemaps";
import { holdBasemapLabels } from "../../map/basemapLabels";
import { useAppStore } from "../../store/useAppStore";
import { useObsStore } from "../../store/useObsStore";

/**
 * Place names drawn over the analysis, each with the analysed value under it.
 *
 * States, and places outside the US, come from the basemap's own vector tiles.
 * US cities and towns come from the bundled GeoNames list the storm impacts use:
 * the tiles only carry the largest cities until well past chase zoom, so at a
 * county-level view they labelled four places across Oklahoma. From the list a
 * zoom brings in towns down to a population that fits the scale, and label
 * collision keeps the biggest where they crowd. The values come from the server
 * in one request for every place on screen, sampled from the hour being shown.
 *
 * The basemap's copies are hidden while this is on: the same name twice, once
 * faint under the image and once over it, reads as a rendering fault.
 */

export const PLACES_SRC = "obs-places-src";
export const PLACE_LABEL = "obs-place-label";
export const COUNTRY_LABEL = "obs-country-label";
export const PLACE_LAYER_IDS = [COUNTRY_LABEL, PLACE_LABEL];

const SETTLE_MS = 260;
const MAX_PLACES = 450;

/**
 * Station plots and aircraft reports are drawn whatever is under them -- a plot
 * must not lose half of itself to a collision -- so MapLibre never enters them
 * in its collision index and a name landing on one is written straight across
 * it: "WASHINGTON 66°" with a METAR plot through it (Pablo, 2026-09-20). The
 * names are the ones that give way: a name landing this close to a plotted
 * station is lifted above it. Half a plot's width and height plus half the
 * label's, and a state's name is wider and two lines tall.
 */
const PLOT_LAYERS = ["surfobs-sky", "acars-dots"];
const PLOT_CLEAR = { x: 50, y: 30 };
const STATE_CLEAR = { x: 70, y: 40 };
/** How far a name is lifted to clear the plot it landed on, in pixels. */
const PLOT_LIFT = 44;

/** Where the plotted stations are on screen right now. */
function plottedPoints(map: MapLibreMap): { x: number; y: number }[] {
  const layers = PLOT_LAYERS.filter(
    (id) => map.getLayer(id) && (map.getLayoutProperty(id, "visibility") ?? "visible") === "visible",
  );
  if (!layers.length) return [];
  const out: { x: number; y: number }[] = [];
  try {
    for (const f of map.queryRenderedFeatures({ layers })) {
      if (f.geometry?.type !== "Point") continue;
      const at = map.project(f.geometry.coordinates as [number, number]);
      out.push({ x: at.x, y: at.y });
    }
  } catch {
    return [];
  }
  return out;
}

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** Smallest US town labelled at each zoom (floor of the zoom). */
function populationFloor(zoom: number): number {
  if (zoom < 4) return 1_000_000;
  if (zoom < 5) return 250_000;
  if (zoom < 6) return 60_000;
  if (zoom < 7) return 15_000;
  if (zoom < 8) return 4_000;
  if (zoom < 9) return 1_000;
  return 100;
}

let usPlaces: Place[] | null = null;
/** Every US place name and where it is, whatever its size: a tile's copy of a
 *  US town is left out even at a zoom where the list itself leaves it out. */
let usIndex: Map<string, [number, number][]> | null = null;

/** Which kinds of place are labelled from which zoom, and how much each one
 *  outranks the others when labels collide (lower wins). */
const CLASSES: Record<string, { from: number; until: number; base: number }> = {
  state: { from: 3, until: 7.5, base: 0 },
  city: { from: 4.5, until: 24, base: 10 },
  town: { from: 6, until: 24, base: 40 },
  village: { from: 8.5, until: 24, base: 70 },
};

interface Controller {
  refresh: () => void;
  /** Ask for the values now, without the settle timer (an export, frame by frame). */
  now: () => void;
  /** Whether the values on the map are the frame `want`'s ("source|field|key"),
   *  or there are none to show for it. */
  readyFor: (want: string) => boolean;
  /** The values of these frames of the product on screen, asked for ahead --
   *  for the names on screen now -- so showing each of them needs no request. */
  prefetch: (keys: string[], stop: () => boolean) => Promise<void>;
  applyVisibility: () => void;
  detach: () => void;
}

const controllers = new WeakMap<MapLibreMap, Controller>();

/** Values asked for ahead of their frame, by what refreshNow would ask. */
const ahead = new Map<string, (string | null)[]>();
const AHEAD_MAX = 400;

function nameOf(props: Record<string, unknown>): string {
  const n = props["name:latin"] ?? props.name_en ?? props.name;
  return typeof n === "string" ? n : "";
}

const labelText: ExpressionSpecification = [
  "case",
  ["==", ["get", "value"], ""],
  ["format", ["get", "name"], {}],
  [
    "format",
    ["get", "name"],
    {},
    "\n",
    {},
    ["get", "value"],
    { "text-font": ["literal", ["Noto Sans Bold"]], "font-scale": 1.22 },
  ],
];

export function attachPlaces(map: MapLibreMap): Controller {
  controllers.get(map)?.detach();

  if (!map.getSource(PLACES_SRC)) map.addSource(PLACES_SRC, { type: "geojson", data: EMPTY });
  const hasVector = Boolean(map.getSource(VECTOR_SOURCE));

  // Country names keep the basemap's look and need no value; they are copied
  // above the field only so the image does not bury them.
  if (hasVector && !map.getLayer(COUNTRY_LABEL)) {
    map.addLayer({
      id: COUNTRY_LABEL,
      type: "symbol",
      source: VECTOR_SOURCE,
      "source-layer": "place",
      filter: ["==", ["get", "class"], "country"],
      layout: {
        "text-field": ["coalesce", ["get", "name:latin"], ["get", "name_en"], ["get", "name"]] as never,
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 2, 13, 5, 17],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.08,
      },
      paint: {
        "text-color": "#f2f6f7",
        "text-halo-color": "rgba(8, 12, 16, 0.9)",
        "text-halo-width": 1.6,
      },
    });
  }
  if (!map.getLayer(PLACE_LABEL)) {
    map.addLayer({
      id: PLACE_LABEL,
      type: "symbol",
      source: PLACES_SRC,
      layout: {
        "text-field": labelText as never,
        "text-font": ["Noto Sans Regular"],
        "text-size": ["match", ["get", "cls"], "state", 11.5, "city", 11.5, 10.5],
        "text-letter-spacing": ["match", ["get", "cls"], "state", 0.1, 0],
        "text-line-height": 1.15,
        "text-anchor": "center",
        "text-justify": "center",
        "text-padding": 4,
        "text-allow-overlap": false,
        "symbol-sort-key": ["get", "pri"],
      },
      paint: {
        "text-color": "#f4f8fa",
        // Dark halo, not a box: the field under the label stays visible around
        // it, and the text still reads over red and over pale green alike.
        "text-halo-color": "rgba(8, 12, 16, 0.92)",
        "text-halo-width": 1.7,
      },
    });
  }

  let timer: number | null = null;
  let seq = 0;
  let lastAsked = "";
  /** The frame whose values are on the map now. */
  let paintedFor = "";

  const hideBasemap = (hide: boolean) => holdBasemapLabels(map, "observations", hide);

  const applyVisibility = () => {
    const on = useObsStore.getState().showPlaces;
    for (const id of PLACE_LAYER_IDS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    }
    hideBasemap(on);
    if (on) schedule();
  };

  const gather = (): { name: string; cls: string; pri: number; lon: number; lat: number }[] => {
    const zoom = map.getZoom();
    const bounds = map.getBounds();
    const west = bounds.getWest();
    const east = bounds.getEast();
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const seen = new Set<string>();
    const out: { name: string; cls: string; pri: number; lon: number; lat: number }[] = [];
    if (usPlaces) {
      const floor = populationFloor(zoom);
      for (const pl of usPlaces) {
        if (pl.population < floor) continue;
        if (pl.lon < west || pl.lon > east || pl.lat < south || pl.lat > north) continue;
        out.push({
          name: pl.name,
          cls: pl.population >= 50_000 ? "city" : "town",
          // Bigger places win collisions: a million people keys 20, a hundred 60.
          pri: 10 + Math.max(0, 70 - Math.log10(Math.max(pl.population, 1)) * 10),
          lon: pl.lon,
          lat: pl.lat,
        });
      }
    }
    const coveredByList = (name: string, lon: number, lat: number) =>
      (usIndex?.get(name) ?? []).some(([x, y]) => Math.abs(x - lon) < 0.3 && Math.abs(y - lat) < 0.3);

    let features: GeoJSON.Feature[] = [];
    try {
      if (map.getSource(VECTOR_SOURCE)) {
        features = map.querySourceFeatures(VECTOR_SOURCE, { sourceLayer: "place" }) as unknown as GeoJSON.Feature[];
      }
    } catch {
      features = [];
    }
    for (const f of features) {
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const cls = String(props.class ?? "");
      const rule = CLASSES[cls];
      if (!rule || zoom < rule.from || zoom >= rule.until) continue;
      if (f.geometry?.type !== "Point") continue;
      const [lon, lat] = f.geometry.coordinates as [number, number];
      if (lon < west || lon > east || lat < south || lat > north) continue;
      const name = nameOf(props);
      if (!name) continue;
      if (cls !== "state" && coveredByList(name, lon, lat)) continue;
      // The same place arrives once per tile it sits near.
      const k = `${cls}|${name}|${lon.toFixed(2)}|${lat.toFixed(2)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const rank = Number(props.rank ?? 10);
      out.push({
        name: cls === "state" ? name.toUpperCase() : name,
        cls,
        pri: rule.base + (Number.isFinite(rank) ? Math.min(rank, 25) : 10),
        lon,
        lat,
      });
    }
    out.sort((a, b) => a.pri - b.pri);
    // A name over a station plot is lifted clear of it -- a city sits on its
    // own airport, so dropping it would take the name off the map altogether.
    // Somewhere else to stand is better than nowhere.
    const plots = plottedPoints(map);
    if (plots.length) {
      const clashes = (x: number, y: number, room: { x: number; y: number }) =>
        plots.some((s) => Math.abs(s.x - x) < room.x && Math.abs(s.y - y) < room.y);
      const clear: typeof out = [];
      for (const pl of out) {
        const room = pl.cls === "state" ? STATE_CLEAR : PLOT_CLEAR;
        const at = map.project([pl.lon, pl.lat]);
        if (!clashes(at.x, at.y, room)) {
          clear.push(pl);
          continue;
        }
        const lift = room.y + PLOT_LIFT - PLOT_CLEAR.y;
        if (!clashes(at.x, at.y - lift, room)) {
          const lifted = map.unproject([at.x, at.y - lift]);
          clear.push({ ...pl, lat: lifted.lat, lon: lifted.lng });
        }
      }
      return clear.slice(0, MAX_PLACES);
    }
    return out.slice(0, MAX_PLACES);
  };

  const refreshNow = async () => {
    const src = map.getSource(PLACES_SRC) as GeoJSONSource | undefined;
    if (!src) return;
    const st = useObsStore.getState();
    if (!st.showPlaces) return;
    const frame = st.frames[st.index];
    const places = gather();
    const forFrame = `${st.source}|${st.field}|${frame?.key ?? ""}`;
    const asked = `${forFrame}|${places.map((p) => `${p.name}${p.lon.toFixed(2)}`).join(",")}`;
    if (asked === lastAsked) {
      paintedFor = forFrame;
      return;
    }
    const mine = ++seq;

    const paint = (values: (string | null)[]) => {
      src.setData({
        type: "FeatureCollection",
        features: places.map((p, i) => ({
          type: "Feature",
          properties: { name: p.name, cls: p.cls, pri: p.pri, value: values[i] ?? "" },
          geometry: { type: "Point", coordinates: [p.lon, p.lat] },
        })),
      });
    };

    if (!frame || places.length === 0 || isTrackSource(st.catalog, st.source)) {
      paint([]);
      lastAsked = asked;
      paintedFor = forFrame;
      return;
    }
    const early = ahead.get(asked);
    if (early) {
      ahead.delete(asked);
      paint(early);
      lastAsked = asked;
      paintedFor = forFrame;
      return;
    }
    try {
      const out = await fetchObsPoints({
        source: st.source,
        field: st.field,
        key: frame.key,
        points: places.map((p) => [p.lat, p.lon] as [number, number]),
      });
      if (mine !== seq || !map.getSource(PLACES_SRC)) return;
      paint(out.values);
      // Pending: names now, values once the hour is on the map (the layer calls
      // refresh again after each draw).
      lastAsked = out.pending ? "" : asked;
      if (!out.pending) paintedFor = forFrame;
    } catch {
      if (mine === seq) {
        paint([]);
        paintedFor = forFrame; // nothing more is coming for this frame
      }
    }
  };

  function schedule() {
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      void refreshNow();
    }, SETTLE_MS);
  }

  // Tiles arriving is when their places become readable; moving is when the
  // set on screen changes.
  // The station plots arrive after the names are first worked out, and the
  // names have to know where they are to keep clear of them (see gather).
  const PLOT_SOURCES = ["surfobs-src", "acars-src"];
  const onData = (e: MapSourceDataEvent) => {
    if (!e.isSourceLoaded) return;
    if (e.sourceId === VECTOR_SOURCE) schedule();
    else if (PLOT_SOURCES.includes(e.sourceId)) controller.refresh();
  };
  map.on("moveend", schedule);
  // Turning the station plots on or off changes which names have room.
  const offPlots = useAppStore.subscribe((now, before) => {
    const changed = ["surfobs", "acars"].some((id) => now.layers[id]?.visible !== before.layers[id]?.visible);
    if (changed) controller.refresh();
  });
  map.on("sourcedata", onData);
  if (!usPlaces) {
    void loadPlaces()
      .then((list) => {
        const index = new Map<string, [number, number][]>();
        for (const pl of list) {
          const at = index.get(pl.name) ?? [];
          at.push([pl.lon, pl.lat]);
          index.set(pl.name, at);
        }
        usIndex = index;
        usPlaces = list;
        lastAsked = "";
        schedule();
      })
      .catch(() => {
        // Without the list the tiles' own cities still label the map.
      });
  }

  applyVisibility();

  const controller: Controller = {
    refresh: () => {
      lastAsked = "";
      schedule();
    },
    now: () => {
      if (timer != null) window.clearTimeout(timer);
      timer = null;
      void refreshNow();
    },
    readyFor: (want) => !useObsStore.getState().showPlaces || paintedFor === want,
    prefetch: async (keys, stop) => {
      const st = useObsStore.getState();
      if (!st.showPlaces || isTrackSource(st.catalog, st.source)) return;
      const places = gather();
      if (places.length === 0) return;
      const names = places.map((p) => `${p.name}${p.lon.toFixed(2)}`).join(",");
      const points = places.map((p) => [p.lat, p.lon] as [number, number]);
      let next = 0;
      const worker = async () => {
        while (!stop() && next < keys.length) {
          const key = keys[next++];
          const asked = `${st.source}|${st.field}|${key}|${names}`;
          if (ahead.has(asked)) continue;
          try {
            const out = await fetchObsPoints({ source: st.source, field: st.field, key, points });
            if (out.pending) continue;
            ahead.set(asked, out.values);
            while (ahead.size > AHEAD_MAX) ahead.delete(ahead.keys().next().value as string);
          } catch {
            /* asked for when its frame comes up instead */
          }
        }
      };
      await Promise.all([worker(), worker()]);
    },
    applyVisibility,
    detach: () => {
      seq += 1;
      if (timer != null) window.clearTimeout(timer);
      map.off("moveend", schedule);
      map.off("sourcedata", onData);
      offPlots();
      for (const id of PLACE_LAYER_IDS) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(PLACES_SRC)) map.removeSource(PLACES_SRC);
      hideBasemap(false);
      controllers.delete(map);
    },
  };
  controllers.set(map, controller);
  return controller;
}

export function placesFor(map: MapLibreMap): Controller | undefined {
  return controllers.get(map);
}
