import maplibregl, { type GeoJSONSource, type MapLayerMouseEvent } from "maplibre-gl";

import type { LayerModule } from "../types";
import { fetchAcarsProfiles, type AcarsAirport } from "../../lib/soundingViewer";
import { useSoundingViewerStore, ACARS_WINDOW_H } from "../../store/useSoundingViewerStore";

const SRC = "acars-src";
const DOTS = "acars-dots";
const LABEL = "acars-label";
const DEFAULT_OPACITY = 0.95;
const REFRESH_MS = 5 * 60 * 1000; // MADIS publishes hourly; this is well ahead of it

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

interface PaneState {
  onClick: (e: MapLayerMouseEvent) => void;
  onEnter: (e: MapLayerMouseEvent) => void;
  onLeave: () => void;
  popup: maplibregl.Popup;
  timer: number | null;
  controller: AbortController | null;
}
const state = new WeakMap<import("maplibre-gl").Map, PaneState>();

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function ageMin(unix: number): number {
  return Math.max(0, Math.round((Date.now() / 1000 - unix) / 60));
}

function toFC(airports: AcarsAirport[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: airports.map((a) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [a.lon, a.lat] },
      properties: {
        airport: a.airport,
        count: a.count,
        latestUnix: a.latestUnix,
        ageMin: ageMin(a.latestUnix),
        nLevels: a.nLevels,
        topPressure: Math.round(a.topPressure),
        ascending: a.ascending,
        lat: a.lat,
        lon: a.lon,
      },
    })),
  };
}

// Age-graded like the lightning layer: a two-hour-old ascent is still useful but
// must not read as current.
const dotColor = (o: number) =>
  [
    "interpolate",
    ["linear"],
    ["get", "ageMin"],
    0, ["rgba", 120, 220, 170, o],
    60, ["rgba", 240, 200, 90, o],
    180, ["rgba", 180, 150, 200, Math.max(0, o - 0.25)],
  ] as const;

/** Airports with a recent aircraft (ACARS/AMDAR) ascent or descent. */
export const acarsLayer: LayerModule = {
  id: "acars",
  name: "Aircraft Soundings (ACARS)",
  description:
    "Airports with a recent aircraft ascent or descent profile. Click one for its sounding.",
  category: "weather",
  source: "NOAA MADIS aircraft (ACARS/AMDAR) profiles",
  defaultVisible: false,
  defaultOpacity: DEFAULT_OPACITY,

  addTo(map) {
    if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: EMPTY });
    if (!map.getLayer(DOTS)) {
      map.addLayer({
        id: DOTS,
        type: "circle",
        source: SRC,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 3, 5, 5.5, 9, 8],
          "circle-color": dotColor(DEFAULT_OPACITY) as never,
          "circle-stroke-color": "rgba(255,255,255,0.85)",
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 2, 0.5, 6, 1.2],
        },
      });
    }
    if (!map.getLayer(LABEL)) {
      map.addLayer({
        id: LABEL,
        type: "symbol",
        source: SRC,
        minzoom: 4,
        layout: {
          "text-field": ["get", "airport"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 10,
          "text-offset": [0, 1.1],
          "text-anchor": "top",
          "text-optional": true,
        },
        paint: {
          "text-color": "#dfe9f5",
          "text-halo-color": "rgba(8,12,18,0.9)",
          "text-halo-width": 1.2,
        },
      });
    }

    const load = () => {
      const st = state.get(map);
      st?.controller?.abort();
      const controller = new AbortController();
      if (st) st.controller = controller;
      fetchAcarsProfiles(ACARS_WINDOW_H, controller.signal)
        .then((res) => {
          if (controller.signal.aborted) return;
          (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(toFC(res.airports));
        })
        .catch(() => {
          /* the layer simply shows nothing if MADIS is unreachable */
        });
    };

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
      className: "raobpop",
    });

    const onEnter = (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      const p = f.properties || {};
      const [lon, lat] = f.geometry.coordinates as [number, number];
      const n = Number(p.count || 1);
      popup
        .setLngLat([lon, lat])
        .setHTML(
          `<div class="raobtip"><b>${esc(String(p.airport))}</b>` +
            `<span>${n} profile${n === 1 ? "" : "s"} · newest ${p.ageMin} min ago</span>` +
            `<span>${p.nLevels} levels, tops near ${p.topPressure} hPa</span></div>`,
        )
        .addTo(map);
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
      popup.remove();
    };
    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties || {};
      const geom = f.geometry;
      const [lon, lat] =
        geom.type === "Point" ? (geom.coordinates as [number, number]) : [e.lngLat.lng, e.lngLat.lat];
      useSoundingViewerStore.getState().openAcars({ airport: String(p.airport), lat, lon });
    };

    map.on("click", DOTS, onClick);
    map.on("mouseenter", DOTS, onEnter);
    map.on("mouseleave", DOTS, onLeave);

    const timer = window.setInterval(load, REFRESH_MS);
    state.set(map, { onClick, onEnter, onLeave, popup, timer, controller: null });
    load();
  },

  removeFrom(map) {
    const st = state.get(map);
    if (st) {
      map.off("click", DOTS, st.onClick);
      map.off("mouseenter", DOTS, st.onEnter);
      map.off("mouseleave", DOTS, st.onLeave);
      st.popup.remove();
      if (st.timer !== null) window.clearInterval(st.timer);
      st.controller?.abort();
      state.delete(map);
    }
    for (const id of [LABEL, DOTS]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },

  setOpacity(map, opacity) {
    if (map.getLayer(DOTS)) map.setPaintProperty(DOTS, "circle-color", dotColor(opacity) as never);
    if (map.getLayer(LABEL)) map.setPaintProperty(LABEL, "text-opacity", opacity);
  },

  getLayerIds() {
    return [DOTS, LABEL];
  },
};
