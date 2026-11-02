import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type MapLayerMouseEvent } from "maplibre-gl";
import type { LayerModule } from "../types";
import {
  fetchSurfaceObs,
  type SurfaceObsFC,
  type SurfaceObsProps,
} from "../../lib/surfaceObs";
import { barbKey, registerStationIcons } from "../../lib/stationPlot";
import { compassPoint, relativeTime } from "../../lib/metar";
import { useAppStore } from "../../store/useAppStore";
import { useNexradStore } from "../../store/useNexradStore";
import { useStationStore } from "../../store/useStationStore";
import {
  useSurfaceObsStore,
  AGE_UNLIMITED,
  type SurfaceDisplayMode,
} from "../../store/useSurfaceObsStore";
import { mapInk } from "../../map/mapInk";

/** Plain station-plot text: pale on a dark basemap, ink on a light one. */
const neutral = () => (mapInk().tone === "light" ? mapInk().text : "#e8edf4");
/**
 * Each element's colour, and the deeper shade it takes on a light basemap: the
 * pale greens and blues made for a black map vanish on white paper, where a
 * chart prints temperature red, dewpoint green and pressure blue in full ink.
 */
const PLOT: Record<string, [dark: string, light: string]> = {
  temp: ["#ff6b5e", "#c81e1e"],
  dewp: ["#4ade80", "#0f7a2e"],
  pres: ["#9fb4d6", "#1d4f91"],
  id: ["#8ea0b6", "#4a5563"],
  gust: ["#f6b93b", "#b86e00"],
  vis: ["#c7d2e4", "#3a4452"],
  thetae: ["#c58af9", "#6d2fb8"],
  wx: ["#f08bd6", "#a1237f"],
  rain: ["#6fb6ff", "#0d5bb5"],
};
const plot = (k: keyof typeof PLOT) => PLOT[k][mapInk().tone === "light" ? 1 : 0];

const SRC = "surfobs-src";
const L_SKY = "surfobs-sky";
const L_BARB = "surfobs-barb";
const L_TEMP = "surfobs-temp";
const L_DEWP = "surfobs-dewp";
const L_PRES = "surfobs-pres";
const L_ID = "surfobs-id";
const L_SINGLE = "surfobs-single";
const L_GUST = "surfobs-gust";
const L_VIS = "surfobs-vis";
const L_CALM = "surfobs-calm";
const L_WX = "surfobs-wx";
const L_RAIN = "surfobs-rain";
const TEXT_LAYERS = [L_TEMP, L_DEWP, L_PRES, L_ID, L_SINGLE, L_GUST, L_VIS, L_WX, L_RAIN];
// Every layer this module owns, bottom -> top. Doubles as the z-order list.
const ALL_LAYERS = [L_CALM, L_SKY, L_BARB, L_TEMP, L_DEWP, L_PRES, L_ID, L_SINGLE, L_GUST, L_VIS, L_WX, L_RAIN];

// Per-map: each pane fetches for its own viewport, so the in-flight request,
// the debounce timer and the cached features all belong to one map. Sharing
// them meant a second pane aborting the first pane's fetch.
interface PaneState {
  raw: GeoJSON.Feature<GeoJSON.Point, SurfaceObsProps>[];
  controller: AbortController | null;
  fetchTimer: number | null;
  styleTimer: number | null;
  /** Observations only arrived when the map moved, so a map left alone went
   *  stale without saying so. METAR lands on its own cadence, specials in
   *  between, so the view is refreshed on a timer too. */
  refreshTimer: number | null;
  needsRebuild: boolean;
  onMove: () => void;
  unsub: () => void;
  popup: maplibregl.Popup;
  onClick: (e: MapLayerMouseEvent) => void;
}
const state = new WeakMap<import("maplibre-gl").Map, PaneState>();
let activeFetches = 0;

const COVER_KEYS = new Set(["SKC", "CLR", "FEW", "SCT", "BKN", "OVC"]);
const pad3 = (n: number) => String(((n % 1000) + 1000) % 1000).padStart(3, "0");
const rnd = (v: number | null) => (v == null ? "" : String(Math.round(v)));
const cToF = (c: number | null) => (c == null ? null : (c * 9) / 5 + 32);
const ktToMph = (kt: number | null) => (kt == null ? null : kt * 1.15078);
const ktToMs = (kt: number | null) => (kt == null ? null : kt * 0.514444);
const mbToInHg = (mb: number | null) => (mb == null ? null : mb * 0.0295299830714);
const miToKm = (mi: number | null) => (mi == null ? null : mi * 1.609344);
/** Station-plot convention: pressure is the last three digits of the tenths of
 *  a millibar. inHg has no such shorthand, so show it plainly to two decimals. */
const inHgTxt = (mb: number | null) => {
  const v = mbToInHg(mb);
  return v == null ? "" : v.toFixed(2);
};
const one = (v: number | null) => (v == null ? "" : String(Math.round(v * 10) / 10));

/**
 * The last hour's rain as a plot prints it -- only an hour's amount (a
 * synoptic station's 6 or 12 hours goes to its card, not the plot), and only
 * where some fell: "0" at every dry station would bury the rest. `zero` keeps
 * the zeros, for the single-value "Rain" view.
 */
function rainTxt(p: SurfaceObsProps, unit: "mm" | "in", zero: boolean): string {
  if (p.precipHours !== 1 || p.precip == null) return "";
  if (p.precipTrace) return "T";
  if (p.precip <= 0) return zero ? "0" : "";
  return unit === "mm" ? p.precip.toFixed(1) : (p.precip / 25.4).toFixed(2);
}

/** Present weather in METAR letters, its first group ("+TSRA", "-RA"): the
 *  obscuration after it (BR, HZ) is what the visibility already says. */
function wxTxt(p: SurfaceObsProps): string {
  const code = p.kind === "synop" ? p.wxCode : p.kind === "metar" || p.kind == null ? p.wx : null;
  return code ? code.split(/\s+/)[0] : "";
}

// One display feature = raw obs + precomputed plot strings/icon ids.
function buildDisplay(f: GeoJSON.Feature<GeoJSON.Point, SurfaceObsProps>) {
  const p = f.properties;
  const kind = p.kind ?? "metar";
  const cover = p.cover && COVER_KEYS.has(p.cover) ? p.cover : kind === "metar" ? "MISSING" : "DOT";
  const hasBarb = p.wspd != null && p.wspd >= 3 && p.wdir != null;
  // A gust worth a label, the way a METAR only carries one: 10 kt or more and
  // 5 kt over the mean. Mesonets and personal stations send their peak every
  // report, so "G1", "G3" crowded every plot.
  const gust = p.wgst != null && p.wgst >= Math.max(10, (p.wspd ?? 0) + 5) ? p.wgst : null;
  return {
    type: "Feature" as const,
    geometry: f.geometry,
    properties: {
      idTxt: p.id ?? "",
      nameTxt: p.name ?? "",
      kind,
      network: p.network ?? "METAR",
      mslp: p.mslp ?? null,
      precip: p.precip ?? null,
      precipHours: p.precipHours ?? null,
      precipTrace: p.precipTrace ?? false,
      wxCode: p.wxCode ?? null,
      wxTxt: wxTxt(p),
      rainMm: rainTxt(p, "mm", false),
      rainIn: rainTxt(p, "in", false),
      rainMm0: rainTxt(p, "mm", true),
      rainIn0: rainTxt(p, "in", true),
      tmax: p.tmax ?? null,
      tmin: p.tmin ?? null,
      oktas: p.oktas ?? null,
      elev: p.elev ?? null,
      tF: rnd(cToF(p.temp)),
      tC: rnd(p.temp),
      tdF: rnd(cToF(p.dewp)),
      tdC: rnd(p.dewp),
      presMb: p.altim != null ? pad3(Math.round(p.altim * 10)) : "",
      presInHg: inHgTxt(p.altim),
      wspdKt: rnd(p.wspd),
      wspdMph: rnd(ktToMph(p.wspd)),
      wspdMs: one(ktToMs(p.wspd)),
      wgstKt: gust != null ? `G${Math.round(gust)}` : "",
      wgstMph: gust != null ? `G${Math.round(ktToMph(gust)!)}` : "",
      wgstMs: gust != null ? `G${one(ktToMs(gust))}` : "",
      visMi: p.visib != null ? String(p.visib) : "",
      visKm: one(miToKm(p.visib)),
      rhTxt: rnd(p.rh),
      thetaeTxt: rnd(p.thetae),
      hasBarb,
      barb: `sfc-barb-${barbKey(p.wspd)}`,
      sky: `sfc-sky-${cover}`,
      temp: p.temp,
      dewp: p.dewp,
      wspd: p.wspd,
      wdir: p.wdir,
      wgst: p.wgst,
      altim: p.altim,
      visib: p.visib,
      cover,
      // Carried so the station panel has a full report the moment it opens,
      // before its history request lands. MapLibre serialises the array to a
      // string in feature properties; parseClouds takes either form.
      clouds: JSON.stringify(p.clouds ?? []),
      wx: p.wx ?? null,
      raw: p.raw ?? null,
      rh: p.rh,
      obsTime: p.obsTime,
    },
  };
}

// Grid-based declutter: keep stations at least `spacing` px apart. O(n).
function declutter(
  map: MapLibreMap,
  spacing: number,
  keep?: ((f: GeoJSON.Feature<GeoJSON.Point, SurfaceObsProps>) => boolean) | null,
) {
  const grid = new Map<string, { x: number; y: number }[]>();
  const kept: GeoJSON.Feature<GeoJSON.Point, SurfaceObsProps>[] = [];
  const cell = Math.max(8, spacing);
  for (const f of state.get(map)?.raw ?? []) {
    if (keep && !keep(f)) continue;
    const [lng, lat] = f.geometry.coordinates;
    const pt = map.project([lng, lat]);
    const gx = Math.floor(pt.x / cell);
    const gy = Math.floor(pt.y / cell);
    let ok = true;
    outer: for (let dx = -1; dx <= 1 && ok; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${gx + dx},${gy + dy}`);
        if (!bucket) continue;
        for (const q of bucket) {
          if ((q.x - pt.x) ** 2 + (q.y - pt.y) ** 2 < spacing * spacing) {
            ok = false;
            break outer;
          }
        }
      }
    }
    if (!ok) continue;
    const key = `${gx},${gy}`;
    (grid.get(key) ?? grid.set(key, []).get(key)!).push({ x: pt.x, y: pt.y });
    kept.push(f);
  }
  return kept;
}

function rebuild(map: MapLibreMap) {
  const { spacing, maxAgeMin, atUnix } = useSurfaceObsStore.getState();
  // Age is filtered before declutter, not after: a stale station must not win a
  // declutter cell and so suppress a fresh neighbour that would have been kept.
  // Measured from the instant on screen: at a past frame the reports are hours
  // old by the clock and just minutes old for the frame.
  const now = atUnix != null ? atUnix * 1000 : Date.now();
  const cutoff = maxAgeMin > AGE_UNLIMITED ? now - maxAgeMin * 60_000 : null;
  const fresh =
    cutoff == null
      ? null
      : (f: GeoJSON.Feature<GeoJSON.Point, SurfaceObsProps>) => {
          const t = f.properties.obsTime;
          // Keep observations with no timestamp: dropping them would silently
          // hide stations rather than describe them as old.
          return t == null || toMillis(t) >= cutoff;
        };
  const kept = declutter(map, spacing, fresh);
  const fc = {
    type: "FeatureCollection" as const,
    features: kept.map((f) => withAge(buildDisplay(f), now)),
  };
  (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(fc as unknown as GeoJSON.FeatureCollection);
}

function setLayerStatus(next: { busy?: boolean; error?: string | null; lastUpdatedAt?: number | null }) {
  useSurfaceObsStore.getState().setLayerStatus(next);
}

function onFetchStart() {
  activeFetches += 1;
  setLayerStatus({ busy: true, error: null });
}

function onFetchDone(next: { error?: string | null; lastUpdatedAt?: number | null } = {}) {
  activeFetches = Math.max(0, activeFetches - 1);
  setLayerStatus({
    busy: activeFetches > 0,
    error: Object.prototype.hasOwnProperty.call(next, "error") ? (next.error ?? null) : undefined,
    lastUpdatedAt: next.lastUpdatedAt,
  });
}

/** obsTime arrives as epoch seconds from the AWC feed; tolerate milliseconds. */
function toMillis(t: number): number {
  return t > 1e11 ? t : t * 1000;
}

/** Tags each display feature with its age so the layer can fade older ones. */
function withAge<T extends { properties: Record<string, unknown> }>(f: T, now: number): T {
  const t = f.properties.obsTime as number | null | undefined;
  const ageMin = t == null ? 0 : Math.max(0, (now - toMillis(t)) / 60_000);
  f.properties.ageMin = ageMin;
  return f;
}

/** How often a still map re-reads its observations. */
const REFRESH_MS = 5 * 60_000;

function scheduleFetch(map: MapLibreMap, delayMs = 350) {
  const st = state.get(map);
  if (!st) return;
  if (st.fetchTimer) window.clearTimeout(st.fetchTimer);
  st.fetchTimer = window.setTimeout(() => void doFetch(map), delayMs);
}

function scheduleRender(map: MapLibreMap, rebuildNeeded: boolean) {
  const st = state.get(map);
  if (!st) return;
  st.needsRebuild = st.needsRebuild || rebuildNeeded;
  if (st.styleTimer) return;
  st.styleTimer = window.requestAnimationFrame(() => {
    const live = state.get(map);
    if (!live) return;
    live.styleTimer = null;
    if (live.needsRebuild) {
      live.needsRebuild = false;
      rebuild(map);
    }
    applyStyle(map);
  });
}

async function doFetch(map: MapLibreMap) {
  const b = map.getBounds();
  const lat0 = Math.max(-90, b.getSouth());
  const lat1 = Math.min(90, b.getNorth());
  const lon0 = Math.max(-180, b.getWest());
  const lon1 = Math.min(180, b.getEast());
  const st = state.get(map);
  if (!st) return;
  st.controller?.abort();
  st.controller = new AbortController();
  onFetchStart();
  try {
    const { spacing, networks } = useSurfaceObsStore.getState();
    const on = (Object.keys(networks) as (keyof typeof networks)[]).filter((k) => networks[k]);
    // Half the declutter spacing, in degrees: the backend sends the best
    // station of each such cell, and the declutter still has a choice.
    const degPerPx = (lon1 - lon0) / Math.max(1, map.getCanvas().clientWidth);
    const cell = Math.max(0.005, spacing * degPerPx * 0.5);
    const at = useSurfaceObsStore.getState().atUnix;
    const fc: SurfaceObsFC = await fetchSurfaceObs([lat0, lon0, lat1, lon1], st.controller.signal, {
      cell,
      networks: on,
      at,
    });
    // An answer for an instant the timeline has already left is dropped.
    if (useSurfaceObsStore.getState().atUnix !== at) {
      onFetchDone();
      return;
    }
    st.raw = fc.features;
    useSurfaceObsStore.getState().setUnavailable(fc.unavailable ?? []);
    scheduleRender(map, true);
    // The synoptic and mesonet feeds are read in the background the first
    // time; until they are in, the airports come alone and the map asks again.
    if ((fc as SurfaceObsFC & { pending?: boolean }).pending) scheduleFetch(map, 8000);
    onFetchDone({ error: null, lastUpdatedAt: Date.now() });
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      onFetchDone();
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    onFetchDone({ error: msg });
  }
}

// Push the current display-mode + element toggles + size onto the layers.
function applyStyle(map: MapLibreMap) {
  const { displayMode, elements, size } = useSurfaceObsStore.getState();
  const station = displayMode === "station";
  const on = (v: boolean) => (v ? "visible" : "none");
  const setVis = (id: string, v: boolean) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on(v));
  };

  setVis(L_SKY, station && elements.sky);
  setVis(L_BARB, elements.wind); // barbs show in every mode (like a real plot)
  setVis(L_TEMP, station && elements.temp);
  setVis(L_DEWP, station && elements.dewp);
  setVis(L_PRES, station && elements.pressure);
  setVis(L_ID, (station && elements.stationName) || displayMode === "id");
  setVis(L_SINGLE, !station && displayMode !== "id");
  setVis(L_GUST, station && elements.gust);
  setVis(L_VIS, station && elements.visibility);
  setVis(L_CALM, station && elements.calm);
  setVis(L_WX, station && elements.weather);
  setVis(L_RAIN, station && elements.rain);

  // Which precomputed property each unit choice maps to. buildDisplay writes
  // every variant, so switching units is a text-field swap, not a re-fetch.
  const s = useSurfaceObsStore.getState();
  const tempProp = s.tempUnits === "F" ? "tF" : "tC";
  const dewpProp = s.tempUnits === "F" ? "tdF" : "tdC";
  const wspdProp = s.windUnits === "kt" ? "wspdKt" : s.windUnits === "mph" ? "wspdMph" : "wspdMs";
  const wgstProp = s.windUnits === "kt" ? "wgstKt" : s.windUnits === "mph" ? "wgstMph" : "wgstMs";
  const presProp = s.presUnits === "mb" ? "presMb" : "presInHg";
  const visProp = s.visUnits === "mi" ? "visMi" : "visKm";
  // Rain in the depth that goes with the temperature, as on the station page.
  const rainProp = s.tempUnits === "C" ? "rainMm" : "rainIn";

  // single-variable field + colour
  const single: Record<Exclude<SurfaceDisplayMode, "station" | "id">, { prop: string; color: string }> = {
    temp: { prop: tempProp, color: plot("temp") },
    dewp: { prop: dewpProp, color: plot("dewp") },
    wspd: { prop: wspdProp, color: neutral() },
    wgst: { prop: wgstProp, color: plot("gust") },
    altim: { prop: presProp, color: plot("pres") },
    visib: { prop: visProp, color: neutral() },
    rh: { prop: "rhTxt", color: plot("dewp") },
    thetae: { prop: "thetaeTxt", color: plot("thetae") },
    precip: { prop: `${rainProp}0`, color: plot("rain") },
  };
  if (!station && displayMode !== "id" && map.getLayer(L_SINGLE)) {
    const cfg = single[displayMode];
    map.setLayoutProperty(L_SINGLE, "text-field", ["get", cfg.prop]);
    map.setPaintProperty(L_SINGLE, "text-color", cfg.color);
  }

  // station-plot fields follow the same unit choices
  if (map.getLayer(L_TEMP)) map.setLayoutProperty(L_TEMP, "text-field", ["get", tempProp]);
  if (map.getLayer(L_DEWP)) map.setLayoutProperty(L_DEWP, "text-field", ["get", dewpProp]);
  if (map.getLayer(L_PRES)) map.setLayoutProperty(L_PRES, "text-field", ["get", presProp]);
  if (map.getLayer(L_VIS)) map.setLayoutProperty(L_VIS, "text-field", ["get", visProp]);
  if (map.getLayer(L_GUST)) map.setLayoutProperty(L_GUST, "text-field", ["get", wgstProp]);
  if (map.getLayer(L_RAIN)) map.setLayoutProperty(L_RAIN, "text-field", ["get", rainProp]);

  // Fade ageing observations so a reading taken minutes ago is visually
  // distinct from one that has been sitting for an hour. The ramp starts
  // halfway to the age limit and bottoms out at it; with no limit set, an
  // arbitrary two-hour reference keeps the cue meaningful.
  const ref = s.maxAgeMin > AGE_UNLIMITED ? s.maxAgeMin : 120;
  const fade = s.fadeStale
    ? (["interpolate", ["linear"], ["coalesce", ["get", "ageMin"], 0], ref * 0.5, 1, ref, 0.38] as never)
    : (1 as never);
  for (const id of TEXT_LAYERS) if (map.getLayer(id)) map.setPaintProperty(id, "text-opacity", fade);
  // Barb and sky are symbols; calm is a CIRCLE, and asking MapLibre for a
  // symbol's icon-opacity on a circle layer throws inside getPaintProperty --
  // it was firing on every restyle of this layer.
  for (const id of [L_BARB, L_SKY]) {
    if (map.getLayer(id)) map.setPaintProperty(id, "icon-opacity", fade);
  }
  if (map.getLayer(L_CALM)) map.setPaintProperty(L_CALM, "circle-opacity", fade);

  // size scaling
  const ts = 11 * size;
  for (const id of TEXT_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, "text-size", id === L_SINGLE ? 13 * size : ts);
  if (map.getLayer(L_BARB)) map.setLayoutProperty(L_BARB, "icon-size", size);
  if (map.getLayer(L_SKY)) map.setLayoutProperty(L_SKY, "icon-size", size);
}

function textLayer(
  id: string,
  field: string,
  color: string,
  anchor: string,
  offset: [number, number],
  size = 11,
) {
  return {
    id,
    type: "symbol" as const,
    source: SRC,
    layout: {
      "text-field": ["get", field] as unknown,
      "text-font": ["Noto Sans Bold"],
      "text-size": size,
      "text-anchor": anchor,
      "text-offset": offset,
      // A plot must not lose half of itself to a collision. MapLibre keeps a
      // symbol allowed to overlap out of its collision index altogether, so
      // nothing else can see it: the names keep clear of the plots themselves
      // (obsPlaces.gather).
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": color,
      "text-halo-color": mapInk().halo,
      "text-halo-width": 1.5,
    },
  };
}

/** Surface observations rendered as classic METAR station plots (real AWC data). */
export const surfaceObsLayer: LayerModule = {
  id: "surfobs",
  name: "Surface Obs",
  description: "Station plots: airports (METAR), WMO synoptic stations, INMET (with a token) and the mesonets and personal stations NOAA MADIS gathers.",
  category: "weather",
  source: "Aviation Weather Center (METAR), OGIMET (SYNOP), NOAA MADIS, INMET",
  defaultVisible: false,
  defaultOpacity: 1,

  addTo(map) {
    registerStationIcons(map);
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    }

    if (!map.getLayer(L_SKY)) {
      map.addLayer({
        id: L_SKY,
        type: "symbol",
        source: SRC,
        layout: {
          "icon-image": ["get", "sky"],
          "icon-size": 1,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
    }
    if (!map.getLayer(L_BARB)) {
      map.addLayer({
        id: L_BARB,
        type: "symbol",
        source: SRC,
        filter: ["==", ["get", "hasBarb"], true],
        layout: {
          "icon-image": ["get", "barb"],
          "icon-size": 1,
          "icon-rotate": ["get", "wdir"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-anchor": "center",
        },
      });
    }
    if (!map.getLayer(L_TEMP)) map.addLayer(textLayer(L_TEMP, "tF", plot("temp"), "right", [-1.3, -0.9]) as never);
    if (!map.getLayer(L_DEWP)) map.addLayer(textLayer(L_DEWP, "tdF", plot("dewp"), "right", [-1.3, 0.9]) as never);
    if (!map.getLayer(L_PRES)) map.addLayer(textLayer(L_PRES, "presMb", plot("pres"), "left", [1.3, -0.9]) as never);
    if (!map.getLayer(L_ID)) map.addLayer(textLayer(L_ID, "idTxt", plot("id"), "top", [0, 1.2], 9) as never);
    if (!map.getLayer(L_SINGLE)) map.addLayer(textLayer(L_SINGLE, "tF", neutral(), "center", [0, 0], 13) as never);
    if (!map.getLayer(L_GUST)) map.addLayer(textLayer(L_GUST, "wgstKt", plot("gust"), "left", [1.3, 0], 9) as never);
    if (!map.getLayer(L_VIS)) map.addLayer(textLayer(L_VIS, "visMi", plot("vis"), "bottom", [0, -1.5], 9) as never);
    // Where a plot puts them: present weather left of the circle, between the
    // temperature and the dewpoint; the hour's rain at the lower right.
    if (!map.getLayer(L_WX)) map.addLayer(textLayer(L_WX, "wxTxt", plot("wx"), "right", [-1.3, 0], 9) as never);
    if (!map.getLayer(L_RAIN)) map.addLayer(textLayer(L_RAIN, "rainIn", plot("rain"), "left", [1.3, 0.9], 9) as never);
    if (!map.getLayer(L_CALM)) {
      map.addLayer({
        id: L_CALM,
        type: "circle",
        source: SRC,
        filter: ["<", ["coalesce", ["get", "wspd"], 0], 3],
        paint: {
          "circle-radius": 5,
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": neutral(),
          "circle-stroke-width": 1.2,
        },
      });
    }

    const popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: true,
      offset: 12,
      className: "surfaceobspop",
    });
    // The station whose popup is open, kept so the main timeline can redraw it
    // without the user clicking again. Deliberately not cleared on the popup's
    // "close" event: setHTML(...).addTo() removes and re-adds, which fires close
    // on every redraw and would wipe this the first time it ran. popup.isOpen()
    // is asked at use instead.
    let openStation: { props: Record<string, any>; lat: number; lon: number } | null = null;

    /** What the card calls the station: its network for anything but an airport. */
    const kindLabel = (p: Record<string, any>) =>
      p.kind === "synop" ? "SYNOP" : p.kind === "inmet" ? "INMET" : p.kind === "mesonet" ? String(p.network || "Mesonet") : "METAR";
    const escHtml = (value: unknown) =>
      String(value ?? "—").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    const num = (v: unknown): number | null => {
      const n = Number(v);
      return v == null || v === "" || !Number.isFinite(n) ? null : n;
    };

    /**
     * The compact card the map shows on click: the four readings someone is
     * usually after, the nearest radars, and a way into the full report. Kept
     * small on purpose -- charts and the raw text live in the station panel,
     * which has room for them.
     */
    const render = () => {
      const st = openStation;
      if (!st) return;
      const p = st.props;
      const temp = num(p.temp);
      const dewp = num(p.dewp);
      const wspd = num(p.wspd);
      const wdir = num(p.wdir);
      const altim = num(p.altim);
      const sites = nearestRadars([st.lon, st.lat]);
      const precip = num(p.precip);
      const hoursOf = num(p.precipHours);
      const rainLabel =
        p.kind === "synop"
          ? `Rain, last ${hoursOf ?? "?"} h`
          : p.kind == null || p.kind === "metar"
            ? "Rain, this hour"
            : "Rain, last hour";
      const rainValue =
        precip == null
          ? null
          : p.precipTrace === true || p.precipTrace === "true"
            ? "Trace"
            : precip <= 0
              ? "None"
              : `${precip.toFixed(1)} mm`;
      const weather = (p.kind == null || p.kind === "metar" ? p.wx : p.kind === "synop" ? p.wx : null) as string | null;
      const obsMs = num(p.obsTime);
      const clock = obsMs == null ? "" : `${new Date((obsMs > 1e11 ? obsMs : obsMs * 1000)).toISOString().slice(11, 16)}Z`;

      const row = (label: string, value: string) =>
        `<div class="sfc-mini__row"><span>${escHtml(label)}</span><b>${value}</b></div>`;

      popup.setHTML(`
        <div class="sfc-mini">
          <button type="button" class="sfc-mini__open" data-open="1">
            <div class="sfc-mini__head">
              <b>${escHtml(kindLabel(p))} ${escHtml(p.idTxt || p.id || "station")}</b>
              <span>${escHtml(clock)} · ${escHtml(relativeTime(num(p.obsTime)))}</span>
            </div>
            ${p.kind && p.kind !== "metar" && (p.nameTxt || p.name) ? `<div class="sfc-mini__name">${escHtml(p.nameTxt || p.name)}</div>` : ""}
            <div class="sfc-mini__rows">
              ${row("Temperature", temp == null ? "\u2014" : `${temp} \u00b0C`)}
              ${row("Dewpoint", dewp == null ? "\u2014" : `${dewp} \u00b0C`)}
              ${row("Wind", wspd == null ? "\u2014" : `${compassPoint(wdir)} ${wspd} kt`)}
              ${row("Pressure", altim == null ? "\u2014" : `${Math.round(altim)} hPa`)}
              ${weather ? row("Weather", escHtml(weather)) : ""}
              ${rainValue != null ? row(rainLabel, rainValue) : ""}
            </div>
            <span class="sfc-mini__more">Full report</span>
          </button>
          ${sites.length ? `<div class="sfc-mini__radars">${sites
            .map((r) => `<button type="button" class="sfc-mini__radar" data-site="${escHtml(r.id)}">${escHtml(r.icao)}</button>`)
            .join("")}</div>` : ""}
        </div>
      `).addTo(map);

      const el = popup.getElement();
      el?.querySelector<HTMLElement>("[data-open]")?.addEventListener("click", () => {
        if (!openStation) return;
        useStationStore.getState().open({
          id: String(openStation.props.idTxt || openStation.props.id || ""),
          name: (openStation.props.nameTxt as string) || (openStation.props.name as string) || null,
          lat: openStation.lat,
          lon: openStation.lon,
          current: openStation.props,
        });
        popup.remove();
      });
      el?.querySelectorAll<HTMLElement>("[data-site]").forEach((b) =>
        b.addEventListener("click", () => {
          const id = b.dataset.site!;
          useAppStore.getState().setLayerVisible("nexrad", true);
          useNexradStore.getState().selectSite(id);
        }),
      );
    };

    /** The two closest online sites, so the radar under a station is one click
     *  away. The catalog loads lazily, so this is empty until it arrives. */
    const nearestRadars = (at: [number, number]) => {
      const { sites } = useNexradStore.getState();
      return sites
        .filter((r) => r.online !== false && r.type !== "TDWR" && Number.isFinite(r.lat) && Number.isFinite(r.lon))
        .map((r) => ({ ...r, d: (r.lat - at[1]) ** 2 + ((r.lon - at[0]) * Math.cos((at[1] * Math.PI) / 180)) ** 2 }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 2);
    };

    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      const p = f.properties ?? {};
      const [lon, lat] = f.geometry.coordinates as [number, number];
      popup.setLngLat([lon, lat]);
      openStation = { props: { ...p, id: p.idTxt, name: p.nameTxt }, lat, lon };
      // The catalog is loaded lazily by the radar panel; pull it in so the
      // nearest-radar chips work even if radar was never opened.
      void useNexradStore.getState().loadCatalog().then(render);
      render();
    };
    for (const id of [L_SKY, L_BARB, L_TEMP, L_DEWP, L_PRES, L_ID, L_SINGLE, L_GUST, L_VIS, L_CALM, L_WX, L_RAIN]) {
      map.on("click", id, onClick);
    }

    const onMove = () => {
      scheduleRender(map, true); // instant re-declutter for the new view
      scheduleFetch(map); // then refresh the obs for the new bbox
    };
    map.on("moveend", onMove);
    const unsub = useSurfaceObsStore.subscribe((s, prev) => {
      // Spacing and the age limit both decide which features exist, so they
      // need the source rebuilt; everything else is a paint/layout swap.
      const needsRebuild = s.spacing !== prev.spacing || s.maxAgeMin !== prev.maxAgeMin;
      scheduleRender(map, needsRebuild);
      // Which networks, and how finely the backend thins them, change what
      // is asked for -- and so does the instant the timeline is on.
      if (s.networks !== prev.networks || s.spacing !== prev.spacing) scheduleFetch(map);
      if (s.atUnix !== prev.atUnix) scheduleFetch(map, 120);
    });
    const refreshTimer = window.setInterval(() => void doFetch(map), REFRESH_MS);
    state.set(map, {
      raw: [],
      controller: null,
      fetchTimer: null,
      styleTimer: null,
      refreshTimer,
      needsRebuild: false,
      onMove,
      unsub,
      popup,
      onClick,
    });

    scheduleRender(map, false);
    void doFetch(map);
  },

  removeFrom(map) {
    const st = state.get(map);
    if (st) {
      if (st.fetchTimer) window.clearTimeout(st.fetchTimer);
      if (st.refreshTimer) window.clearInterval(st.refreshTimer);
      if (st.styleTimer) window.cancelAnimationFrame(st.styleTimer);
      st.controller?.abort();
      map.off("moveend", st.onMove);
      st.unsub();
      for (const id of [L_SKY, L_BARB, L_TEMP, L_DEWP, L_PRES, L_ID, L_SINGLE, L_GUST, L_VIS, L_CALM, L_WX, L_RAIN]) {
        map.off("click", id, st.onClick);
      }
      st.popup.remove();
      state.delete(map);
    }
    if (activeFetches === 0) setLayerStatus({ busy: false });
    for (const id of [L_RAIN, L_WX, L_CALM, L_VIS, L_GUST, L_SINGLE, L_ID, L_PRES, L_DEWP, L_TEMP, L_BARB, L_SKY]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(SRC)) map.removeSource(SRC);
  },

  setOpacity() {
    /* station plots are text/icons; opacity is not exposed */
  },

  getLayerIds() {
    return ALL_LAYERS;
  },

  // Station plots are dense little text blocks: an alert polygon or a radar
  // scan drawn over them makes them unreadable, and unlike a fill there is no
  // opacity to trade away. So the whole module rides on top of both.
  topLayerIds() {
    return ALL_LAYERS;
  },
};
