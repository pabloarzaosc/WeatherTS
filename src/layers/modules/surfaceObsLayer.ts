import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type MapLayerMouseEvent } from "maplibre-gl";
import type { LayerModule } from "../types";
import {
  fetchSurfaceHistory,
  fetchSurfaceObs,
  type SurfaceObsFC,
  type SurfaceObsProps,
} from "../../lib/surfaceObs";
import { barbKey, registerStationIcons } from "../../lib/stationPlot";
import {
  useSurfaceObsStore,
  AGE_UNLIMITED,
  type SurfaceDisplayMode,
} from "../../store/useSurfaceObsStore";

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
const TEXT_LAYERS = [L_TEMP, L_DEWP, L_PRES, L_ID, L_SINGLE, L_GUST, L_VIS];

// Per-map: each pane fetches for its own viewport, so the in-flight request,
// the debounce timer and the cached features all belong to one map. Sharing
// them meant a second pane aborting the first pane's fetch.
interface PaneState {
  raw: GeoJSON.Feature<GeoJSON.Point, SurfaceObsProps>[];
  controller: AbortController | null;
  fetchTimer: number | null;
  styleTimer: number | null;
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

// One display feature = raw obs + precomputed plot strings/icon ids.
function buildDisplay(f: GeoJSON.Feature<GeoJSON.Point, SurfaceObsProps>) {
  const p = f.properties;
  const cover = p.cover && COVER_KEYS.has(p.cover) ? p.cover : "MISSING";
  const hasBarb = p.wspd != null && p.wspd >= 3 && p.wdir != null;
  return {
    type: "Feature" as const,
    geometry: f.geometry,
    properties: {
      idTxt: p.id ?? "",
      nameTxt: p.name ?? "",
      tF: rnd(cToF(p.temp)),
      tC: rnd(p.temp),
      tdF: rnd(cToF(p.dewp)),
      tdC: rnd(p.dewp),
      presMb: p.altim != null ? pad3(Math.round(p.altim * 10)) : "",
      presInHg: inHgTxt(p.altim),
      wspdKt: rnd(p.wspd),
      wspdMph: rnd(ktToMph(p.wspd)),
      wspdMs: one(ktToMs(p.wspd)),
      wgstKt: p.wgst != null ? `G${Math.round(p.wgst)}` : "",
      wgstMph: p.wgst != null ? `G${Math.round(ktToMph(p.wgst)!)}` : "",
      wgstMs: p.wgst != null ? `G${one(ktToMs(p.wgst))}` : "",
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
  const { spacing, maxAgeMin } = useSurfaceObsStore.getState();
  // Age is filtered before declutter, not after: a stale station must not win a
  // declutter cell and so suppress a fresh neighbour that would have been kept.
  const now = Date.now();
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

function scheduleFetch(map: MapLibreMap) {
  const st = state.get(map);
  if (!st) return;
  if (st.fetchTimer) window.clearTimeout(st.fetchTimer);
  st.fetchTimer = window.setTimeout(() => void doFetch(map), 350);
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
    const fc: SurfaceObsFC = await fetchSurfaceObs([lat0, lon0, lat1, lon1], st.controller.signal);
    st.raw = fc.features;
    scheduleRender(map, true);
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

  // Which precomputed property each unit choice maps to. buildDisplay writes
  // every variant, so switching units is a text-field swap, not a re-fetch.
  const s = useSurfaceObsStore.getState();
  const tempProp = s.tempUnits === "F" ? "tF" : "tC";
  const dewpProp = s.tempUnits === "F" ? "tdF" : "tdC";
  const wspdProp = s.windUnits === "kt" ? "wspdKt" : s.windUnits === "mph" ? "wspdMph" : "wspdMs";
  const wgstProp = s.windUnits === "kt" ? "wgstKt" : s.windUnits === "mph" ? "wgstMph" : "wgstMs";
  const presProp = s.presUnits === "mb" ? "presMb" : "presInHg";
  const visProp = s.visUnits === "mi" ? "visMi" : "visKm";

  // single-variable field + colour
  const single: Record<Exclude<SurfaceDisplayMode, "station" | "id">, { prop: string; color: string }> = {
    temp: { prop: tempProp, color: "#ff6b5e" },
    dewp: { prop: dewpProp, color: "#4ade80" },
    wspd: { prop: wspdProp, color: "#e8edf4" },
    wgst: { prop: wgstProp, color: "#f6b93b" },
    altim: { prop: presProp, color: "#9fb4d6" },
    visib: { prop: visProp, color: "#e8edf4" },
    rh: { prop: "rhTxt", color: "#4ade80" },
    thetae: { prop: "thetaeTxt", color: "#c58af9" },
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

  // Fade ageing observations so a reading taken minutes ago is visually
  // distinct from one that has been sitting for an hour. The ramp starts
  // halfway to the age limit and bottoms out at it; with no limit set, an
  // arbitrary two-hour reference keeps the cue meaningful.
  const ref = s.maxAgeMin > AGE_UNLIMITED ? s.maxAgeMin : 120;
  const fade = s.fadeStale
    ? (["interpolate", ["linear"], ["coalesce", ["get", "ageMin"], 0], ref * 0.5, 1, ref, 0.38] as never)
    : (1 as never);
  for (const id of TEXT_LAYERS) if (map.getLayer(id)) map.setPaintProperty(id, "text-opacity", fade);
  for (const id of [L_BARB, L_SKY, L_CALM]) {
    if (map.getLayer(id)) map.setPaintProperty(id, "icon-opacity", fade);
  }

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
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": color,
      "text-halo-color": "rgba(8,11,15,0.95)",
      "text-halo-width": 1.5,
    },
  };
}

/** Surface observations rendered as classic METAR station plots (real AWC data). */
export const surfaceObsLayer: LayerModule = {
  id: "surfobs",
  name: "Surface Obs",
  description: "Global METAR station plots (Aviation Weather Center).",
  category: "weather",
  source: "Aviation Weather Center — METAR",
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
    if (!map.getLayer(L_TEMP)) map.addLayer(textLayer(L_TEMP, "tF", "#ff6b5e", "right", [-1.3, -0.9]) as never);
    if (!map.getLayer(L_DEWP)) map.addLayer(textLayer(L_DEWP, "tdF", "#4ade80", "right", [-1.3, 0.9]) as never);
    if (!map.getLayer(L_PRES)) map.addLayer(textLayer(L_PRES, "presMb", "#9fb4d6", "left", [1.3, -0.9]) as never);
    if (!map.getLayer(L_ID)) map.addLayer(textLayer(L_ID, "idTxt", "#8ea0b6", "top", [0, 1.2], 9) as never);
    if (!map.getLayer(L_SINGLE)) map.addLayer(textLayer(L_SINGLE, "tF", "#e8edf4", "center", [0, 0], 13) as never);
    if (!map.getLayer(L_GUST)) map.addLayer(textLayer(L_GUST, "wgstKt", "#f6b93b", "left", [1.3, 0], 9) as never);
    if (!map.getLayer(L_VIS)) map.addLayer(textLayer(L_VIS, "visMi", "#c7d2e4", "bottom", [0, -1.5], 9) as never);
    if (!map.getLayer(L_CALM)) {
      map.addLayer({
        id: L_CALM,
        type: "circle",
        source: SRC,
        filter: ["<", ["coalesce", ["get", "wspd"], 0], 3],
        paint: {
          "circle-radius": 5,
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": "#e8edf4",
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
    let openStation: {
      station: string;
      history: Array<Record<string, any>>;
      lat: number;
      lon: number;
      hours: number;
      metric: string;
    } | null = null;

    const escHtml = (value: unknown) =>
      String(value ?? "—").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    const parseObsDate = (value: unknown): Date | null => {
      if (value == null || value === "") return null;
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        const ms = numeric > 10_000_000_000 ? numeric : numeric * 1000;
        const date = new Date(ms);
        if (!Number.isNaN(date.getTime())) return date;
      }
      const date = new Date(String(value));
      return Number.isNaN(date.getTime()) ? null : date;
    };
    const formatObsDate = (value: unknown) => {
      const date = parseObsDate(value);
      return date
        ? date.toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
        : "Latest observation";
    };
    type Metric = { key: string; label: string; unit: string; color: string };
    const METRICS: Metric[] = [
      { key: "temp", label: "Temperature", unit: "\u00b0C", color: "#ff6b5e" },
      { key: "dewp", label: "Dew point", unit: "\u00b0C", color: "#4ade80" },
      { key: "rh", label: "Humidity", unit: "%", color: "#38bdf8" },
      { key: "wspd", label: "Wind", unit: "kt", color: "#e8edf4" },
      { key: "altim", label: "Pressure", unit: "mb", color: "#9fb4d6" },
      { key: "visib", label: "Visibility", unit: "mi", color: "#c7d2e4" },
    ];

    const num = (v: unknown): number | null => {
      const n = Number(v);
      return v == null || v === "" || !Number.isFinite(n) ? null : n;
    };

    const COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    const compass = (deg: number | null) => (deg == null ? "" : COMPASS[Math.round(deg / 22.5) % 16]);

    const SKY_WORDS: Record<string, string> = {
      SKC: "Clear", CLR: "Clear", FEW: "Few", SCT: "Scattered", BKN: "Broken", OVC: "Overcast",
    };

    const hhmm = (unix: unknown) => {
      const d = parseObsDate(unix);
      return d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    };

    /**
     * The selected metric over the loaded window, with axes. Inline SVG because
     * the popup is raw HTML handed to MapLibre -- there is no React in here, and
     * a chart library would be a lot of weight for one line and four labels.
     */
    const chart = (history: Array<Record<string, any>>, metric: Metric): string => {
      const pts = history
        .map((h, i) => ({ i, v: num(h[metric.key]) }))
        .filter((o) => o.v != null) as { i: number; v: number }[];
      if (pts.length < 2) {
        return `<div class="sfc-chart__empty">Not enough history for ${escHtml(metric.label.toLowerCase())}</div>`;
      }
      const W = 300, H = 112, L = 36, R = 6, T = 8, B = 18;
      const n = history.length - 1 || 1;
      let lo = Math.min(...pts.map((o) => o.v));
      let hi = Math.max(...pts.map((o) => o.v));
      if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
      // Round the axis outwards so the labels read as numbers a person would
      // pick, not 23.87.
      const step = Math.pow(10, Math.floor(Math.log10(hi - lo))) / 2;
      lo = Math.floor(lo / step) * step;
      hi = Math.ceil(hi / step) * step;
      const X = (i: number) => L + (i / n) * (W - L - R);
      const Y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
      const d = pts.map((o, k) => `${k ? "L" : "M"}${X(o.i).toFixed(1)},${Y(o.v).toFixed(1)}`).join("");
      const last = pts[pts.length - 1];
      const area = `${d}L${X(last.i).toFixed(1)},${(H - B).toFixed(1)}L${X(pts[0].i).toFixed(1)},${(H - B).toFixed(1)}Z`;
      const dec = step < 1 ? 1 : 0;
      const grid = [hi, (hi + lo) / 2, lo].map((v) => `
        <line x1="${L}" y1="${Y(v).toFixed(1)}" x2="${W - R}" y2="${Y(v).toFixed(1)}" class="sfc-chart__grid"/>
        <text x="${L - 5}" y="${(Y(v) + 3).toFixed(1)}" class="sfc-chart__ylab">${v.toFixed(dec)}</text>`).join("");
      const marks = [0, Math.floor(n / 2), n];
      const xlabs = marks.map((i, k) => `
        <text x="${X(i).toFixed(1)}" y="${H - 5}" class="sfc-chart__xlab" text-anchor="${k === 0 ? "start" : k === 2 ? "end" : "middle"}">${escHtml(hhmm(history[i]?.obsTime))}</text>`).join("");
      return `<svg class="sfc-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escHtml(metric.label)} history">
        ${grid}${xlabs}
        <path d="${area}" fill="${metric.color}" opacity="0.10"/>
        <path d="${d}" fill="none" stroke="${metric.color}" stroke-width="1.6"/>
      </svg>`;
    };

    const RANGES = [6, 12, 24];

    const render = () => {
      const st = openStation;
      if (!st) return;
      const p = st.history[st.history.length - 1] ?? {};
      const metric = METRICS.find((mm) => mm.key === st.metric) ?? METRICS[0];
      const wdir = num(p.wdir);

      const cards = METRICS.map((mm) => {
        const v = num(p[mm.key]);
        const extra =
          mm.key === "wspd" && wdir != null ? `<i>${escHtml(compass(wdir))} ${wdir}\u00b0</i>` :
          mm.key === "altim" && v != null ? `<i>${(v * 0.0295299830714).toFixed(2)} inHg</i>` : "";
        return `<button type="button" class="sfc-card${mm.key === metric.key ? " is-on" : ""}" data-metric="${mm.key}">
          <span>${escHtml(mm.label)}</span>
          <b>${v == null ? "\u2014" : `${v}${mm.unit === "%" ? "" : " "}${mm.unit}`}</b>
          ${extra}
        </button>`;
      }).join("");

      const clouds: Array<{ cover: string; base: number | null }> = Array.isArray(p.clouds)
        ? p.clouds
        : (() => { try { return JSON.parse(String(p.clouds ?? "[]")); } catch { return []; } })();
      const sky = clouds.length
        ? clouds.map((c) => `<div class="sfc-sky__row"><span>${escHtml(SKY_WORDS[c.cover] ?? c.cover)}</span><b>${c.base == null ? "\u2014" : `${Math.round(c.base).toLocaleString()} ft`}</b></div>`).join("")
        : `<div class="sfc-sky__row"><span>${escHtml(SKY_WORDS[String(p.cover)] ?? "No layers reported")}</span><b></b></div>`;

      popup.setHTML(`
        <div class="surfaceobs-card">
          <div class="surfaceobs-card__head">
            <div><b>${escHtml(p.id || p.idTxt || "METAR station")}</b><span>${escHtml(p.name || p.nameTxt || "Surface observation")}</span></div>
          </div>
          <div class="surfaceobs-card__status">Observed ${escHtml(formatObsDate(p.obsTime))}</div>
          ${p.wx ? `<div class="sfc-wx">${escHtml(p.wx)}</div>` : ""}

          <div class="sfc-cards">${cards}</div>

          <div class="sfc-sec">
            <span>History</span>
            <div class="sfc-ranges">${RANGES.map((h) => `<button type="button" class="sfc-range${h === st.hours ? " is-on" : ""}" data-hours="${h}">${h}h</button>`).join("")}</div>
          </div>
          <div class="sfc-chart__wrap">
            <div class="sfc-chart__title">${escHtml(metric.label)} (${escHtml(metric.unit)})</div>
            ${chart(st.history, metric)}
          </div>

          <div class="sfc-sec"><span>Sky</span></div>
          <div class="sfc-sky">${sky}</div>

          ${p.raw ? `<div class="sfc-sec"><span>Raw METAR</span><button type="button" class="sfc-copy" data-copy="1">Copy</button></div>
          <pre class="sfc-raw">${escHtml(p.raw)}</pre>` : ""}

          <div class="surfaceobs-card__foot">${st.lat.toFixed(3)}\u00b0, ${st.lon.toFixed(3)}\u00b0</div>
        </div>
      `).addTo(map);

      const el = popup.getElement();
      el?.querySelectorAll<HTMLElement>("[data-metric]").forEach((b) =>
        b.addEventListener("click", () => {
          if (openStation) { openStation.metric = b.dataset.metric!; render(); }
        }),
      );
      el?.querySelectorAll<HTMLElement>("[data-hours]").forEach((b) =>
        b.addEventListener("click", () => {
          const h = Number(b.dataset.hours);
          if (!openStation || openStation.hours === h) return;
          openStation.hours = h;
          render();
          void loadHistory(openStation.station, h);
        }),
      );
      el?.querySelector<HTMLElement>("[data-copy]")?.addEventListener("click", (ev) => {
        const btn = ev.currentTarget as HTMLElement;
        void navigator.clipboard
          ?.writeText(String(p.raw ?? ""))
          .then(() => {
            btn.textContent = "Copied";
            window.setTimeout(() => { btn.textContent = "Copy"; }, 1400);
          })
          .catch(() => { btn.textContent = "Copy failed"; });
      });
    };

    const loadHistory = async (station: string, hours: number) => {
      if (!station) return;
      try {
        const rows = await fetchSurfaceHistory(station, hours);
        if (!rows.length || !openStation || openStation.station !== station) return;
        const records = rows.map((r) => ({ ...r })) as Array<Record<string, any>>;
        records.sort((a, b) => toMillis(Number(a.obsTime)) - toMillis(Number(b.obsTime)));
        openStation.history = records;
        render();
      } catch {
        /* The clicked observation stays useful when history is unavailable. */
      }
    };

    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      const p = f.properties ?? {};
      const [lon, lat] = f.geometry.coordinates as [number, number];
      popup.setLngLat([lon, lat]);
      const station = String(p.idTxt || "");
      const current = { ...p, id: p.idTxt, name: p.nameTxt, lat, lon };
      // Keep whichever range and metric were last chosen: someone comparing
      // stations should not have to set them again at every click.
      openStation = {
        station,
        history: [current],
        lat,
        lon,
        hours: openStation?.hours ?? 24,
        metric: openStation?.metric ?? "temp",
      };
      render();
      void loadHistory(station, openStation.hours);
    };
    for (const id of [L_SKY, L_BARB, L_TEMP, L_DEWP, L_PRES, L_ID, L_SINGLE, L_GUST, L_VIS, L_CALM]) {
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
    });
    state.set(map, {
      raw: [],
      controller: null,
      fetchTimer: null,
      styleTimer: null,
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
      if (st.styleTimer) window.cancelAnimationFrame(st.styleTimer);
      st.controller?.abort();
      map.off("moveend", st.onMove);
      st.unsub();
      for (const id of [L_SKY, L_BARB, L_TEMP, L_DEWP, L_PRES, L_ID, L_SINGLE, L_GUST, L_VIS, L_CALM]) {
        map.off("click", id, st.onClick);
      }
      st.popup.remove();
      state.delete(map);
    }
    if (activeFetches === 0) setLayerStatus({ busy: false });
    for (const id of [L_CALM, L_VIS, L_GUST, L_SINGLE, L_ID, L_PRES, L_DEWP, L_TEMP, L_BARB, L_SKY]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(SRC)) map.removeSource(SRC);
  },

  setOpacity() {
    /* station plots are text/icons; opacity is not exposed */
  },

  getLayerIds() {
    return [L_CALM, L_SKY, L_BARB, L_TEMP, L_DEWP, L_PRES, L_ID, L_SINGLE, L_GUST, L_VIS];
  },
};
