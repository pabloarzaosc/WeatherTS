import maplibregl, { type GeoJSONSource, type MapLayerMouseEvent } from "maplibre-gl";

import type { LayerModule } from "../types";
import { fetchAcarsProfiles, type AcarsAirport } from "../../lib/soundingViewer";
import { useSoundingViewerStore } from "../../store/useSoundingViewerStore";
import { useAcarsStore } from "../../store/useAcarsStore";
import { registerMarkerLayers, unregisterMarkerLayers } from "../clickPriority";

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
  unsub: () => void;
  /** The airports in the last response, kept so a filter change can recount
   *  what is on screen without waiting for the next fetch. */
  airports: AcarsAirport[];
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

/**
 * What the map draws, from the panel's settings.
 *
 * Filtered on the map rather than at fetch time so moving a slider is instant
 * and does not spend a request: the feed is hourly, and re-asking MADIS to
 * answer "hide the thin ones" would be the same data with fewer rows.
 */
function visibilityFilter(): unknown[] | null {
  const { maxAgeMin, minLevels } = useAcarsStore.getState();
  const clauses: unknown[] = [];
  if (maxAgeMin !== null) clauses.push(["<=", ["get", "ageMin"], maxAgeMin]);
  if (minLevels > 0) clauses.push([">=", ["get", "nLevels"], minLevels]);
  return clauses.length ? ["all", ...clauses] : null;
}

function applySettings(map: import("maplibre-gl").Map) {
  const { showLabels } = useAcarsStore.getState();
  const f = visibilityFilter() as never;
  for (const id of [DOTS, LABEL]) if (map.getLayer(id)) map.setFilter(id, f);
  if (map.getLayer(LABEL)) {
    map.setLayoutProperty(LABEL, "visibility", showLabels ? "visible" : "none");
  }
  // Count against the same rules the map uses, so "12 of 40" is never a
  // different answer from what is drawn.
  const st = state.get(map);
  const { maxAgeMin, minLevels } = useAcarsStore.getState();
  const list = st?.airports ?? [];
  const shown = list.filter(
    (a) => (maxAgeMin === null || ageMin(a.latestUnix) <= maxAgeMin) && a.nLevels >= minLevels,
  ).length;
  useAcarsStore.getState().setStatus({ total: list.length, shown });
}

// Age-graded: a two-hour-old ascent is still useful but
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
  name: "ACARS Aircraft Soundings",
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
      useAcarsStore.getState().setStatus({ busy: true, error: null });
      fetchAcarsProfiles(useAcarsStore.getState().windowH, controller.signal)
        .then((res) => {
          if (controller.signal.aborted) return;
          const cur = state.get(map);
          if (cur) cur.airports = res.airports;
          (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(toFC(res.airports));
          useAcarsStore.getState().setStatus({
            busy: false,
            error: null,
            lastUpdatedAt: Date.now(),
          });
          applySettings(map);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          // Named rather than swallowed: an empty aircraft layer and an
          // unreachable MADIS look identical on the map, and only one of them
          // is worth waiting out.
          useAcarsStore.getState().setStatus({
            busy: false,
            error: err instanceof Error ? err.message : "MADIS unreachable",
          });
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

    registerMarkerLayers([DOTS]);
    map.on("click", DOTS, onClick);
    map.on("mouseenter", DOTS, onEnter);
    map.on("mouseleave", DOTS, onLeave);

    const timer = window.setInterval(load, REFRESH_MS);
    // A window change needs the feed again; the rest are map-side filters, so
    // they must NOT trigger a fetch.
    const unsubWindow = useAcarsStore.subscribe((st) => st.windowH, () => load());
    const unsubView = useAcarsStore.subscribe(
      (st) => `${st.maxAgeMin}|${st.minLevels}|${st.showLabels}`,
      () => applySettings(map),
    );
    state.set(map, {
      onClick,
      onEnter,
      onLeave,
      popup,
      timer,
      controller: null,
      airports: [],
      unsub: () => {
        unsubWindow();
        unsubView();
      },
    });
    applySettings(map);
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
      st.unsub();
      state.delete(map);
    }
    unregisterMarkerLayers([DOTS]);
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

  // Small point markers you click to open a sounding: they must not end up
  // under a radar sweep or an alert fill, the way a tracked storm cell must
  // not. Above LSR too, because the aircraft dots are the smaller target of
  // the two and they rarely land on the same spot.
  topLayerIds() {
    return [DOTS, LABEL];
  },
  topPriority: 40,
};
