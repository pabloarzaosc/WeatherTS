import maplibregl from "maplibre-gl";
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent } from "maplibre-gl";

import type { LayerModule } from "../types";
import { registerMarkerLayers, unregisterMarkerLayers } from "../clickPriority";
import { RIVER_COLORS, gaugeId, gaugeName, riverRank, statusLabel, type RiverGauge, type RiverStatus } from "../../lib/rivers";
import { gaugeShown, useRiverStore } from "../../store/useRiverStore";

const SRC = "rivers-src";
/** A ring in the forecast's colour around a gauge forecast to get worse. */
const RISING = "rivers-rising";
const DOTS = "rivers-dots";
const DEFAULT_OPACITY = 1;

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

interface PaneState {
  unsub: () => void;
  onClick: (e: MapLayerMouseEvent) => void;
  onMove: (e: MapLayerMouseEvent) => void;
  onLeave: () => void;
  popup: maplibregl.Popup;
}
const state = new WeakMap<MapLibreMap, PaneState>();
let opacity = DEFAULT_OPACITY;
let attached = 0;

const COLOR = (key: string): ExpressionSpecification => {
  const expr: unknown[] = ["match", ["get", key]];
  for (const [k, c] of Object.entries(RIVER_COLORS)) expr.push(k, c);
  expr.push(RIVER_COLORS.not_defined);
  return expr as ExpressionSpecification;
};

function push(map: MapLibreMap) {
  const src = map.getSource(SRC) as GeoJSONSource | undefined;
  if (!src) return;
  const { all, filter, networks } = useRiverStore.getState();
  const features: GeoJSON.Feature[] = [];
  all.forEach((g, i) => {
    if (!gaugeShown(g, filter, networks)) return;
    const r = riverRank(g.status);
    const fr = riverRank(g.fstatus);
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [g.lon, g.lat] },
      // ANA's stations, with no levels to colour them by, go under the rest.
      properties: { i, s: g.status, r: g.net === "ana" ? -1 : r, fs: g.fstatus ?? "", rising: fr > r },
    });
  });
  src.setData({ type: "FeatureCollection", features });
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

function fmt(v: number | null, units: string): string {
  return v == null ? "–" : `${v.toFixed(Math.abs(v) >= 100 || units === "cm" ? 0 : 1)} ${units}`;
}

function tipHtml(g: RiverGauge): string {
  const color = g.status === "action" ? "#c9a400" : (RIVER_COLORS[g.status] ?? RIVER_COLORS.not_defined);
  const where = `${esc(gaugeName(g))}${g.state ? `, ${esc(g.state)}` : ""}`;
  if (g.net === "ana") {
    return (
      `<div class="lsrtip">` +
      `<b style="color:${RIVER_COLORS.not_defined}">ANA telemetry · ${esc(gaugeId(g.lid))}</b>` +
      `<span>${where}</span>` +
      `<span class="lsrtip__time">${esc(g.wfo || "")} · click for level, flow and rain</span>` +
      `</div>`
    );
  }
  if (g.net === "sgb") {
    const next =
      g.action != null || g.flood != null || g.moderate != null
        ? `Attention ${esc(fmt(g.action, "cm"))} · Alert ${esc(fmt(g.flood, "cm"))} · Flood ${esc(fmt(g.moderate, "cm"))}`
        : "";
    return (
      `<div class="lsrtip">` +
      `<b style="color:${color}">${esc(statusLabel(g.status, "sgb"))}</b>` +
      `<span>${where}</span>` +
      (g.stage != null ? `<span class="lsrtip__time">${esc(fmt(g.stage, "cm"))}</span>` : "") +
      (next ? `<span class="lsrtip__time">${next}</span>` : "") +
      `<span class="lsrtip__time">SGB alert system · ${esc(g.wfo)}</span>` +
      `</div>`
    );
  }
  const fc =
    g.fstatus && g.fstage != null
      ? `<span>Forecast crest ${esc(fmt(g.fstage, g.units))} · ${esc(statusLabel(g.fstatus as RiverStatus, "nws"))}</span>`
      : "";
  return (
    `<div class="lsrtip">` +
    `<b style="color:${color}">${esc(statusLabel(g.status, "nws"))}</b>` +
    `<span>${where}</span>` +
    `<span class="lsrtip__time">${esc(fmt(g.stage, g.units))}${g.flood != null ? ` · flood stage ${esc(fmt(g.flood, g.units))}` : ""}</span>` +
    fc +
    `</div>`
  );
}

/** NWS river gauges, coloured by flood category; click one for its hydrograph. */
export const riversLayer: LayerModule = {
  id: "rivers",
  name: "River gauges",
  description:
    "NWS river gauges (US) and SGB's alert stations (Brazil), coloured by the flood level they are in now, and ANA's telemetry stations; a ring marks a gauge forecast to reach a worse level. Click a gauge for its hydrograph.",
  category: "weather",
  source: "NWS National Water Prediction Service; SGB SACE; ANA Hidro-Telemetria",
  defaultVisible: false,
  defaultOpacity: DEFAULT_OPACITY,

  addTo(map) {
    if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: EMPTY });
    if (!map.getLayer(RISING)) {
      map.addLayer({
        id: RISING,
        type: "circle",
        source: SRC,
        filter: ["==", ["get", "rising"], true],
        layout: { "circle-sort-key": ["get", "r"] },
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 5.5, 7, 8, 11, 11],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": COLOR("fs"),
          "circle-stroke-width": 2,
          "circle-stroke-opacity": opacity,
        },
      });
    }
    if (!map.getLayer(DOTS)) {
      map.addLayer({
        id: DOTS,
        type: "circle",
        source: SRC,
        // The worst on top: a flooding gauge must never hide under a quiet one.
        layout: { "circle-sort-key": ["get", "r"] },
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            3, ["case", [">", ["get", "r"], 0], 3.6, ["<", ["get", "r"], 0], 1.4, 2],
            7, ["case", [">", ["get", "r"], 0], 5.5, ["<", ["get", "r"], 0], 2.6, 3.4],
            11, ["case", [">", ["get", "r"], 0], 7.5, ["<", ["get", "r"], 0], 4.5, 5.5],
          ],
          "circle-color": COLOR("s"),
          "circle-stroke-color": "rgba(10,12,18,0.75)",
          "circle-stroke-width": 0.8,
          "circle-opacity": opacity,
          "circle-stroke-opacity": opacity,
        },
      });
    }

    const gaugeAt = (e: MapLayerMouseEvent): RiverGauge | null => {
      const f = e.features?.[0];
      const i = Number(f?.properties?.i);
      return Number.isInteger(i) ? (useRiverStore.getState().all[i] ?? null) : null;
    };
    const onClick = (e: MapLayerMouseEvent) => {
      const g = gaugeAt(e);
      if (g) useRiverStore.getState().select(g.lid);
    };
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: "raobpop" });
    let tipFor = "";
    const onMove = (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const g = gaugeAt(e);
      if (!g || (g.lid === tipFor && popup.isOpen())) return;
      tipFor = g.lid;
      popup.setLngLat([g.lon, g.lat]).setHTML(tipHtml(g)).addTo(map);
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
      tipFor = "";
      popup.remove();
    };
    map.on("click", DOTS, onClick);
    map.on("mousemove", DOTS, onMove);
    map.on("mouseleave", DOTS, onLeave);
    // A gauge is a small deliberate target: it wins a click over the warning
    // polygon it sits in.
    registerMarkerLayers([DOTS]);

    const unsub = useRiverStore.subscribe((s, prev) => {
      if (s.all !== prev.all || s.filter !== prev.filter || s.networks !== prev.networks) push(map);
    });
    state.set(map, { unsub, onClick, onMove, onLeave, popup });
    push(map);
    attached += 1;
    useRiverStore.getState().startPolling();
    if (attached === 1 || !useRiverStore.getState().all.length) void useRiverStore.getState().load();
  },

  removeFrom(map) {
    const st = state.get(map);
    if (st) {
      map.off("click", DOTS, st.onClick);
      map.off("mousemove", DOTS, st.onMove);
      map.off("mouseleave", DOTS, st.onLeave);
      st.popup.remove();
      st.unsub();
      state.delete(map);
      attached = Math.max(0, attached - 1);
      if (attached === 0) useRiverStore.getState().stopPolling();
    }
    unregisterMarkerLayers([DOTS]);
    for (const id of [DOTS, RISING]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },

  setOpacity(map, o) {
    opacity = o;
    if (map.getLayer(DOTS)) {
      map.setPaintProperty(DOTS, "circle-opacity", o);
      map.setPaintProperty(DOTS, "circle-stroke-opacity", o);
    }
    if (map.getLayer(RISING)) map.setPaintProperty(RISING, "circle-stroke-opacity", o);
  },

  getLayerIds() {
    return [RISING, DOTS];
  },

  // Over the radar and the warning fills, below storm cells and reports.
  topLayerIds() {
    return [RISING, DOTS];
  },
  topPriority: 14,
};
