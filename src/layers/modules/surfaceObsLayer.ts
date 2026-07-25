import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type MapLayerMouseEvent } from "maplibre-gl";
import type { LayerModule } from "../types";
import {
  fetchSurfaceHistory,
  fetchSurfaceObs,
  type SurfaceObsFC,
  type SurfaceObsProps,
  type SurfaceObsHistory,
} from "../../lib/surfaceObs";
import { barbKey, registerStationIcons } from "../../lib/stationPlot";
import { useSurfaceObsStore, type SurfaceDisplayMode } from "../../store/useSurfaceObsStore";

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
  onMove: () => void;
  unsub: () => void;
  popup: maplibregl.Popup;
  onClick: (e: MapLayerMouseEvent) => void;
}
const state = new WeakMap<import("maplibre-gl").Map, PaneState>();

const COVER_KEYS = new Set(["SKC", "CLR", "FEW", "SCT", "BKN", "OVC"]);
const pad3 = (n: number) => String(((n % 1000) + 1000) % 1000).padStart(3, "0");
const rnd = (v: number | null) => (v == null ? "" : String(Math.round(v)));
const cToF = (c: number | null) => (c == null ? null : (c * 9) / 5 + 32);

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
      presTxt: p.altim != null ? pad3(Math.round(p.altim * 10)) : "",
      wspdTxt: rnd(p.wspd),
      wgstTxt: p.wgst != null ? `G${Math.round(p.wgst)}` : "",
      visTxt: p.visib != null ? String(p.visib) : "",
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
function declutter(map: MapLibreMap, spacing: number) {
  const grid = new Map<string, { x: number; y: number }[]>();
  const kept: GeoJSON.Feature<GeoJSON.Point, SurfaceObsProps>[] = [];
  const cell = Math.max(8, spacing);
  for (const f of state.get(map)?.raw ?? []) {
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
  const { spacing } = useSurfaceObsStore.getState();
  const kept = declutter(map, spacing);
  const fc = { type: "FeatureCollection" as const, features: kept.map(buildDisplay) };
  (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(fc as unknown as GeoJSON.FeatureCollection);
}

function scheduleFetch(map: MapLibreMap) {
  const st = state.get(map);
  if (!st) return;
  if (st.fetchTimer) window.clearTimeout(st.fetchTimer);
  st.fetchTimer = window.setTimeout(() => void doFetch(map), 350);
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
  try {
    const fc: SurfaceObsFC = await fetchSurfaceObs([lat0, lon0, lat1, lon1], st.controller.signal);
    st.raw = fc.features;
    rebuild(map);
  } catch {
    /* transient network / aborted -> keep the current plot */
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

  // single-variable field + colour
  const single: Record<Exclude<SurfaceDisplayMode, "station" | "id">, { prop: string; color: string }> = {
    temp: { prop: useSurfaceObsStore.getState().units === "F" ? "tF" : "tC", color: "#ff6b5e" },
    dewp: { prop: useSurfaceObsStore.getState().units === "F" ? "tdF" : "tdC", color: "#4ade80" },
    wspd: { prop: "wspdTxt", color: "#e8edf4" },
    wgst: { prop: "wgstTxt", color: "#f6b93b" },
    altim: { prop: "presTxt", color: "#9fb4d6" },
    visib: { prop: "visTxt", color: "#e8edf4" },
    rh: { prop: "rhTxt", color: "#4ade80" },
    thetae: { prop: "thetaeTxt", color: "#c58af9" },
  };
  if (!station && displayMode !== "id" && map.getLayer(L_SINGLE)) {
    const cfg = single[displayMode];
    map.setLayoutProperty(L_SINGLE, "text-field", ["get", cfg.prop]);
    map.setPaintProperty(L_SINGLE, "text-color", cfg.color);
  }

  // temp/dewp respect the unit setting
  const units = useSurfaceObsStore.getState().units;
  if (map.getLayer(L_TEMP)) map.setLayoutProperty(L_TEMP, "text-field", ["get", units === "F" ? "tF" : "tC"]);
  if (map.getLayer(L_DEWP)) map.setLayoutProperty(L_DEWP, "text-field", ["get", units === "F" ? "tdF" : "tdC"]);

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
    if (!map.getLayer(L_PRES)) map.addLayer(textLayer(L_PRES, "presTxt", "#9fb4d6", "left", [1.3, -0.9]) as never);
    if (!map.getLayer(L_ID)) map.addLayer(textLayer(L_ID, "idTxt", "#8ea0b6", "top", [0, 1.2], 9) as never);
    if (!map.getLayer(L_SINGLE)) map.addLayer(textLayer(L_SINGLE, "tF", "#e8edf4", "center", [0, 0], 13) as never);
    if (!map.getLayer(L_GUST)) map.addLayer(textLayer(L_GUST, "wgstTxt", "#f6b93b", "left", [1.3, 0], 9) as never);
    if (!map.getLayer(L_VIS)) map.addLayer(textLayer(L_VIS, "visTxt", "#c7d2e4", "bottom", [0, -1.5], 9) as never);
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
    const escHtml = (value: unknown) =>
      String(value ?? "—").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    const fmt = (value: unknown, suffix = "") => value == null || value === "" ? "—" : `${escHtml(value)}${suffix}`;
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
    const renderObservation = (
      p: Record<string, any>,
      lat: number,
      lon: number,
      history: Array<Record<string, any>>,
      selected: number,
    ) => {
      const timeLabel = formatObsDate(p.obsTime);
      const max = Math.max(history.length - 1, 0);
      popup.setHTML(`
        <div class="surfaceobs-card">
          <div class="surfaceobs-card__head">
            <div><b>${escHtml(p.id || p.idTxt || p.name || p.nameTxt || "METAR station")}</b><span>${escHtml(p.name || p.nameTxt || "Surface observation")}</span></div>
            <small>${escHtml(timeLabel)}</small>
          </div>
          <div class="surfaceobs-card__status">LIVE METAR OBSERVATION</div>
          <div class="surfaceobs-card__grid">
            <div><span>TEMP</span><b>${fmt(p.temp, " °C")}</b></div>
            <div><span>DEWPOINT</span><b>${fmt(p.dewp, " °C")}</b></div>
            <div><span>HUMIDITY</span><b>${fmt(p.rh, " %")}</b></div>
            <div><span>PRESSURE</span><b>${fmt(p.altim, " mb")}</b></div>
            <div><span>WIND</span><b>${p.wspd == null ? "—" : `${escHtml(p.wdir ?? "VRB")}° @ ${escHtml(p.wspd)} kt`}</b></div>
            <div><span>GUST</span><b>${fmt(p.wgst, " kt")}</b></div>
            <div><span>VISIBILITY</span><b>${fmt(p.visib, " mi")}</b></div>
            <div><span>SKY</span><b>${fmt(p.cover)}</b></div>
          </div>
          <div class="surfaceobs-card__timeline">
            <div><span>OBSERVATION TIMELINE</span><b>${history.length ? `${selected + 1} / ${history.length}` : "current"}</b></div>
            <input id="surfaceobs-time" type="range" min="0" max="${max}" value="${selected}" ${max === 0 ? "disabled" : ""} />
            <div class="surfaceobs-card__timeline-labels"><span>older</span><span>newer</span></div>
          </div>
          <div class="surfaceobs-card__foot">${lat.toFixed(3)}°, ${lon.toFixed(3)}°</div>
        </div>
      `).addTo(map);
      const slider = popup.getElement()?.querySelector<HTMLInputElement>("#surfaceobs-time");
      slider?.addEventListener("input", () => {
        const index = Number(slider.value);
        const next = history[index];
        if (next) renderObservation(next, Number(next.lat), Number(next.lon), history, index);
      });
    };
    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      const p = f.properties ?? {};
      const [lon, lat] = f.geometry.coordinates as [number, number];
      popup.setLngLat([lon, lat]);
      const station = String(p.idTxt || "");
      const current = { ...p, id: p.idTxt, name: p.nameTxt, lat, lon };
      renderObservation(current, lat, lon, [current], 0);
      if (station) {
        void fetchSurfaceHistory(station, 24).then((history: SurfaceObsHistory[]) => {
          const records = history.map((item) => ({ ...item }));
          if (records.length) {
            const selected = records.findIndex((item) => String(item.obsTime) === String(p.obsTime));
            renderObservation(records[Math.max(selected, 0)], lat, lon, records, Math.max(selected, 0));
          }
        }).catch(() => {
          /* Current observation remains useful when history is unavailable. */
        });
      }
    };
    for (const id of [L_SKY, L_BARB, L_TEMP, L_DEWP, L_PRES, L_ID, L_SINGLE, L_GUST, L_VIS, L_CALM]) {
      map.on("click", id, onClick);
    }

    const onMove = () => {
      rebuild(map); // instant re-declutter for the new view
      scheduleFetch(map); // then refresh the obs for the new bbox
    };
    map.on("moveend", onMove);
    const unsub = useSurfaceObsStore.subscribe((s, prev) => {
      if (s.spacing !== prev.spacing) rebuild(map);
      applyStyle(map);
    });
    state.set(map, { raw: [], controller: null, fetchTimer: null, onMove, unsub, popup, onClick });

    applyStyle(map);
    void doFetch(map);
  },

  removeFrom(map) {
    const st = state.get(map);
    if (st) {
      if (st.fetchTimer) window.clearTimeout(st.fetchTimer);
      st.controller?.abort();
      map.off("moveend", st.onMove);
      st.unsub();
      for (const id of [L_SKY, L_BARB, L_TEMP, L_DEWP, L_PRES, L_ID, L_SINGLE, L_GUST, L_VIS, L_CALM]) {
        map.off("click", id, st.onClick);
      }
      st.popup.remove();
      state.delete(map);
    }
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
