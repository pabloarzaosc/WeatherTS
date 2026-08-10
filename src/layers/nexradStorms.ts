import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type MapLayerMouseEvent } from "maplibre-gl";

import { useAppStore } from "../store/useAppStore";
import { useNexradStore } from "../store/useNexradStore";

/**
 * SCIT storm cells: their past track, their forecast track, and the mesocyclone
 * detections attached to them. Owned by nexradLayer's lifecycle the same way the
 * range ring is — these only mean anything next to the radar they came from.
 */

const SRC = "nexrad-storms-src";
export const TRACK_PAST = "nexrad-storm-past";
export const TRACK_FCST = "nexrad-storm-fcst";
export const CELL_DOT = "nexrad-storm-dot";
export const CELL_LABEL = "nexrad-storm-label";
export const STORM_LAYERS = [TRACK_PAST, TRACK_FCST, CELL_DOT, CELL_LABEL];

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

interface PaneState {
  unsub: () => void;
  onClick: (e: MapLayerMouseEvent) => void;
  onEnter: () => void;
  onLeave: () => void;
  markers: maplibregl.Marker[];
}
const state = new WeakMap<MapLibreMap, PaneState>();

function buildFC(): GeoJSON.FeatureCollection {
  const st = useNexradStore.getState();
  if (!st.showTracks || !st.storms) return EMPTY;
  const features: GeoJSON.Feature[] = [];
  for (const c of st.storms.cells) {
    if (c.past.length >= 2) {
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: c.past },
        properties: { kind: "past", id: c.id },
      });
    }
    if (c.forecast.length >= 2) {
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: c.forecast },
        properties: { kind: "forecast", id: c.id },
      });
    }
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
      properties: {
        kind: "cell",
        id: c.id,
        selected: c.id === st.selectedCellId,
        speedMph: c.speedMph ?? 0,
        heading: c.headingCompass ?? "",
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Mesocyclones are DOM markers, not GL symbols: the icon has to spin, and a GL
 *  symbol cannot animate continuously without driving a rAF loop. There are
 *  never many of them, so the DOM cost is negligible. */
function syncMesos(map: MapLibreMap) {
  const st = state.get(map);
  if (!st) return;
  for (const m of st.markers) m.remove();
  st.markers = [];

  const s = useNexradStore.getState();
  if (!s.showTracks || !s.storms) return;
  const reduceMotion = useAppStore.getState().reduceMotion;

  for (const meso of s.storms.mesos) {
    const el = document.createElement("div");
    el.className = `mesomark${meso.tvs ? " is-tvs" : ""}${reduceMotion ? " is-still" : ""}`;
    el.title = meso.tvs
      ? `TVS — tornado vortex signature${meso.stormId ? ` (cell ${meso.stormId})` : ""}`
      : `Mesocyclone${meso.stormId ? ` (cell ${meso.stormId})` : ""}`;
    el.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
      '<path fill="currentColor" d="M12 11.2a2 2 0 1 0 0 1.6a2 2 0 0 0 0-1.6Z"/>' +
      '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
      'd="M12 10.2C12 6 15.5 3.4 19 4.6c2.6.9 2.4 4.4-.4 4.9-2 .4-4.2.3-6.6.7"/>' +
      '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
      'd="M12 13.8c0 4.2-3.5 6.8-7 5.6-2.6-.9-2.4-4.4.4-4.9 2-.4 4.2-.3 6.6-.7"/>' +
      "</svg>";
    st.markers.push(
      new maplibregl.Marker({ element: el }).setLngLat([meso.lon, meso.lat]).addTo(map),
    );
  }
}

export function pushStorms(map: MapLibreMap): void {
  (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(buildFC());
  syncMesos(map);
}

export function addStorms(map: MapLibreMap): void {
  if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: EMPTY });

  if (!map.getLayer(TRACK_PAST)) {
    map.addLayer({
      id: TRACK_PAST,
      type: "line",
      source: SRC,
      filter: ["==", ["get", "kind"], "past"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "rgba(226,236,247,0.45)",
        "line-width": 1.2,
      },
    });
  }
  if (!map.getLayer(TRACK_FCST)) {
    map.addLayer({
      id: TRACK_FCST,
      type: "line",
      source: SRC,
      filter: ["==", ["get", "kind"], "forecast"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "rgba(255,255,255,0.92)",
        "line-width": 1.6,
        "line-dasharray": [2, 2],
      },
    });
  }
  if (!map.getLayer(CELL_DOT)) {
    map.addLayer({
      id: CELL_DOT,
      type: "circle",
      source: SRC,
      filter: ["==", ["get", "kind"], "cell"],
      paint: {
        // The classic SCIT marker: a black dot with a white ring, which reads
        // over every reflectivity palette.
        "circle-radius": ["case", ["get", "selected"], 7, 5],
        "circle-color": "#05080d",
        "circle-stroke-color": ["case", ["get", "selected"], "#facc15", "#ffffff"],
        "circle-stroke-width": 1.8,
      },
    });
  }
  if (!map.getLayer(CELL_LABEL)) {
    map.addLayer({
      id: CELL_LABEL,
      type: "symbol",
      source: SRC,
      filter: ["==", ["get", "kind"], "cell"],
      layout: {
        "text-field": ["get", "id"],
        "text-font": ["Noto Sans Bold"],
        "text-size": 11,
        "text-offset": [0.9, -0.9],
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "rgba(5,8,13,0.95)",
        "text-halo-width": 1.4,
      },
    });
  }

  const onClick = (e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    const id = f?.properties?.id;
    if (!id) return;
    const cur = useNexradStore.getState().selectedCellId;
    useNexradStore.getState().selectCell(cur === String(id) ? null : String(id));
  };
  const onEnter = () => {
    map.getCanvas().style.cursor = "pointer";
  };
  const onLeave = () => {
    map.getCanvas().style.cursor = "";
  };
  map.on("click", CELL_DOT, onClick);
  map.on("mouseenter", CELL_DOT, onEnter);
  map.on("mouseleave", CELL_DOT, onLeave);

  const unsub = useNexradStore.subscribe((s, prev) => {
    if (
      s.storms !== prev.storms ||
      s.showTracks !== prev.showTracks ||
      s.selectedCellId !== prev.selectedCellId
    ) {
      pushStorms(map);
    }
  });

  state.set(map, { unsub, onClick, onEnter, onLeave, markers: [] });
  pushStorms(map);
}

export function removeStorms(map: MapLibreMap): void {
  const st = state.get(map);
  if (st) {
    map.off("click", CELL_DOT, st.onClick);
    map.off("mouseenter", CELL_DOT, st.onEnter);
    map.off("mouseleave", CELL_DOT, st.onLeave);
    st.unsub();
    for (const m of st.markers) m.remove();
    state.delete(map);
  }
  for (const id of STORM_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(SRC)) map.removeSource(SRC);
}
