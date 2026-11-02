import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type MapLayerMouseEvent } from "maplibre-gl";

import { stormReportAt, useNexradStore } from "../store/useNexradStore";
import { usePaneStore } from "../store/usePaneStore";
import { paneIdOf } from "../map/mapInstance";
import type { StormReport } from "../lib/nexrad";
import { useAppStore } from "../store/useAppStore";
import { mapInk } from "../map/mapInk";

/**
 * SCIT storm cells: their past track, their forecast track, and the mesocyclone
 * detections attached to them. Owned by nexradLayer's lifecycle the same way the
 * range ring is — these only mean anything next to the radar they came from.
 */

const SRC = "nexrad-storms-src";
export const TRACK_CONE = "nexrad-storm-cone";
export const TRACK_CONE_EDGE = "nexrad-storm-cone-edge";
export const TRACK_PAST = "nexrad-storm-past";
export const TRACK_FCST = "nexrad-storm-fcst";
export const TRACK_TICK = "nexrad-storm-tick";
export const CELL_DOT = "nexrad-storm-dot";
export const CELL_LABEL = "nexrad-storm-label";
// Bottom to top: the swath is the ground the storm covers, so everything that
// describes the storm itself is drawn over it. Ticks sit under the cell dot but
// over the track line.
export const STORM_LAYERS = [
  TRACK_CONE,
  TRACK_CONE_EDGE,
  TRACK_PAST,
  TRACK_FCST,
  TRACK_TICK,
  CELL_DOT,
  CELL_LABEL,
];

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const KM_PER_DEG_LAT = 111.32;
/** Half-length of a forecast tick, on the ground. Fixed in kilometres rather
 *  than pixels because a GeoJSON line has no screen-space length -- at chase
 *  zooms this reads like the crosshatch on a printed storm track. */
const TICK_HALF_KM = 3.5;

/** Half-width of the swath at the cell, and an hour out.
 *
 *  It starts at the tick width so the two agree where they meet, and opens up
 *  with lead time. That spread is the honest part: the SCIT vector is one
 *  extrapolation of the last few volumes, and an hour of it is a direction
 *  rather than a place. A parallel-sided corridor would claim a precision the
 *  forecast does not have. */
const CONE_START_HALF_KM = TICK_HALF_KM;
const CONE_END_HALF_KM = 11;

type Pt = [number, number];

/**
 * The segment across the track at `pt`, square to the direction of travel.
 *
 * Perpendicularity is computed in kilometres, not degrees: a degree of
 * longitude is shorter than a degree of latitude everywhere but the equator,
 * so rotating the raw lon/lat delta would lean every tick towards the pole --
 * and would skew the swath the same way, one edge riding wider than the other.
 */
function across(pt: Pt, prev: Pt | undefined, next: Pt | undefined, halfKm: number): Pt[] | null {
  const kmPerDegLon = KM_PER_DEG_LAT * Math.cos((pt[1] * Math.PI) / 180);
  if (!Number.isFinite(kmPerDegLon) || kmPerDegLon <= 0) return null;

  // Straddle the point where possible so a bend in the track splits the angle.
  const a = prev ?? pt;
  const b = next ?? pt;
  const dx = (b[0] - a[0]) * kmPerDegLon;
  const dy = (b[1] - a[1]) * KM_PER_DEG_LAT;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;

  const halfLon = ((-dy / len) * halfKm) / kmPerDegLon;
  const halfLat = ((dx / len) * halfKm) / KM_PER_DEG_LAT;
  return [
    [pt[0] - halfLon, pt[1] - halfLat],
    [pt[0] + halfLon, pt[1] + halfLat],
  ];
}

const tickAcross = (pt: Pt, prev: Pt | undefined, next: Pt | undefined) =>
  across(pt, prev, next, TICK_HALF_KM);

/**
 * The ground the cell is forecast to cross, as one polygon.
 *
 * Walk the forecast track, step out to both sides at each point, and close the
 * two edges into a ring. Because the offset follows the track's own heading,
 * the shape leans with the storm instead of sitting square to the map -- which
 * is the whole point: a storm running northeast should show a swath running
 * northeast, not a box that happens to contain it.
 */
function trackSwath(track: Pt[]): Pt[] | null {
  if (track.length < 2) return null;
  const last = track.length - 1;
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i <= last; i++) {
    const half = CONE_START_HALF_KM + (CONE_END_HALF_KM - CONE_START_HALF_KM) * (i / last);
    const seg = across(track[i], track[i - 1], track[i + 1], half);
    if (!seg) return null;
    left.push(seg[0]);
    right.push(seg[1]);
  }
  const ring = [...left, ...right.reverse()];
  ring.push(ring[0]);
  return ring;
}

interface PaneState {
  unsub: () => void;
  onClick: (e: MapLayerMouseEvent) => void;
  onEnter: () => void;
  onLeave: () => void;
  markers: maplibregl.Marker[];
}
const state = new WeakMap<MapLibreMap, PaneState>();

/** panes-layout: the frame time of a pane on its own scrubber, else null. */
function ownTimeOf(s: ReturnType<typeof useNexradStore.getState>, map: MapLibreMap): number | null {
  const id = paneIdOf(map);
  return (id && s.paneRadar[id]?.ownTime) || null;
}

/** The report this pane draws: none when its chip took the tracks off, its
 *  own frame's on its own scrubber, else the loop's. */
function reportFor(map: MapLibreMap): StormReport | null {
  const s = useNexradStore.getState();
  const id = paneIdOf(map);
  if (id && usePaneStore.getState().isHidden(id, "storms")) return null;
  const own = ownTimeOf(s, map);
  if (own == null || !s.site) return s.storms;
  const t = s.scans.length ? s.scans.reduce((b, f) => (Math.abs(f.time - own) < Math.abs(b.time - own) ? f : b)).time : own;
  return stormReportAt(s.site, t, () => pushStorms(map));
}

function buildFC(map: MapLibreMap): GeoJSON.FeatureCollection {
  const st0 = useNexradStore.getState();
  const report = reportFor(map);
  if (!st0.showTracks || !report) return EMPTY;
  const st = { ...st0, storms: report };
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
      const swath = trackSwath(c.forecast as Pt[]);
      if (swath) {
        features.push({
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [swath] },
          properties: { kind: "cone", id: c.id, selected: c.id === st.selectedCellId },
        });
      }
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: c.forecast },
        properties: { kind: "forecast", id: c.id },
      });
      // forecast[0] is the cell's current position, which already carries the
      // dot -- ticks mark the 15/30/45/60-minute positions after it.
      for (let i = 1; i < c.forecast.length; i++) {
        const seg = tickAcross(c.forecast[i], c.forecast[i - 1], c.forecast[i + 1]);
        if (!seg) continue;
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: seg },
          properties: { kind: "tick", id: c.id, minutes: i * 15 },
        });
      }
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

/**
 * TVS markers. DOM markers rather than GL symbols so the shape needs no sprite
 * sheet; there are only ever a handful on screen.
 *
 * Only tornado vortex signatures get a mark. A plain mesocyclone is common
 * enough in any organised storm that marking them all buries the one detection
 * that matters -- the cell's popup still reports it in words. The shape is the
 * inverted triangle every radar display uses for a TVS (a circle would mean
 * mesocyclone), so it reads without a legend.
 */
function syncMesos(map: MapLibreMap) {
  const st = state.get(map);
  if (!st) return;
  for (const m of st.markers) m.remove();
  st.markers = [];

  const s0 = useNexradStore.getState();
  const report = reportFor(map);
  if (!s0.showTracks || !report) return;
  const s = { ...s0, storms: report };

  for (const meso of s.storms.mesos) {
    if (!meso.tvs) continue;
    const el = document.createElement("div");
    el.className = "tvsmark";
    el.title = `TVS (NWS Level III) — tornado vortex signature${meso.stormId ? ` (cell ${meso.stormId})` : ""}`;
    // Drawn as a polygon rather than a border trick so the outline follows the
    // triangle instead of boxing it.
    el.innerHTML =
      '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
      '<polygon points="12,20.5 1.8,3.5 22.2,3.5" ' +
      'fill="currentColor" stroke="#0b0f15" stroke-width="1.6" stroke-linejoin="round"/>' +
      "</svg>" +
      // The NWS RPG's own TVS, badged so it is never taken for the app's
      // detections computed from the volume (radarDetectionsLayer).
      '<span class="tvsmark__src">NWS L3</span>';
    st.markers.push(
      new maplibregl.Marker({ element: el }).setLngLat([meso.lon, meso.lat]).addTo(map),
    );
  }
}

/**
 * What this module paints by the basemap's tone (mapInk): the cone's fill, the
 * cell dot and the cell labels. The track lines, the cone edge and the dot's
 * ring are the Settings styler's (settings/mapStyle.ts radarRules), which
 * turns their default white to dark ink over a light basemap -- written in
 * one place only, or the two would take turns.
 */
const TRACK_INK = {
  dark: { coneFill: "#e2ecf7", dot: "#05080d", text: "#ffffff", halo: "rgba(5,8,13,0.95)" },
  light: { coneFill: "#14263b", dot: "#ffffff", text: "#0d1218", halo: "rgba(255,255,255,0.92)" },
};

/** Paint the module's own track props for the basemap on screen. */
function paintStorms(map: MapLibreMap): void {
  const k = TRACK_INK[mapInk().tone];
  const paint: [string, string, unknown][] = [
    [TRACK_CONE, "fill-color", k.coneFill],
    [CELL_DOT, "circle-color", k.dot],
    [CELL_LABEL, "text-color", k.text],
    [CELL_LABEL, "text-halo-color", k.halo],
  ];
  for (const [id, prop, value] of paint) {
    if (map.getLayer(id)) map.setPaintProperty(id, prop, value);
  }
}

export function pushStorms(map: MapLibreMap): void {
  (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(buildFC(map));
  syncMesos(map);
}

export function addStorms(map: MapLibreMap): void {
  if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: EMPTY });

  if (!map.getLayer(TRACK_CONE)) {
    map.addLayer({
      id: TRACK_CONE,
      type: "fill",
      source: SRC,
      filter: ["==", ["get", "kind"], "cone"],
      paint: {
        // Barely there on purpose: this sits over reflectivity, and the colour
        // under it is what the swath is about.
        "fill-color": "#e2ecf7",
        "fill-opacity": ["case", ["get", "selected"], 0.14, 0.07],
      },
    });
  }
  if (!map.getLayer(TRACK_CONE_EDGE)) {
    map.addLayer({
      id: TRACK_CONE_EDGE,
      type: "line",
      source: SRC,
      filter: ["==", ["get", "kind"], "cone"],
      layout: { "line-join": "round" },
      paint: {
        "line-color": ["case", ["get", "selected"], "#facc15", "rgba(198,232,255,0.8)"],
        "line-width": ["case", ["get", "selected"], 1.4, 1],
      },
    });
  }
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
      },
    });
  }
  if (!map.getLayer(TRACK_TICK)) {
    map.addLayer({
      id: TRACK_TICK,
      type: "line",
      source: SRC,
      filter: ["==", ["get", "kind"], "tick"],
      layout: { "line-cap": "butt" },
      paint: {
        "line-color": "rgba(255,255,255,0.92)",
        // The hour mark is the one read at a glance, so it carries weight the
        // quarter-hour ticks don't.
        "line-width": ["case", [">=", ["get", "minutes"], 60], 2.2, 1.5],
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

  const unsubStorms = useNexradStore.subscribe((s, prev) => {
    if (
      s.storms !== prev.storms ||
      s.showTracks !== prev.showTracks ||
      s.selectedCellId !== prev.selectedCellId ||
      ownTimeOf(s, map) !== ownTimeOf(prev, map)
    ) {
      pushStorms(map);
    }
  });
  // The storm chip's x on this pane (panes-layout).
  const unsubHidden = usePaneStore.subscribe((s, p) => {
    const id = paneIdOf(map);
    if (id && s.hidden[id] !== p.hidden[id]) pushStorms(map);
  });
  // Another basemap, another surface under the tracks.
  const unsubBase = useAppStore.subscribe((s, prev) => {
    if (s.basemapId !== prev.basemapId) paintStorms(map);
  });
  const unsub = () => {
    unsubStorms();
    unsubBase();
    unsubHidden();
  };
  paintStorms(map);

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
