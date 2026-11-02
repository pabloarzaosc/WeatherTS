import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";

import type { LayerModule } from "../types";
import { paneIdOf, setActivePane } from "../../map/mapInstance";
import {
  drawnMesos,
  tvsOf,
  useDetectionsStore,
  vrotTone,
  type DetSelection,
} from "../../store/useDetectionsStore";
import { useNexradStore } from "../../store/useNexradStore";

/**
 * The radar's own storm detections (useDetectionsStore): mesocyclones and
 * weaker circulations as circles, tornado vortex signatures as inverted
 * triangles, debris signatures as diamonds, and a tail behind each tracked
 * mesocyclone. Coloured by rotational velocity: orange from 30 kt, red from 50,
 * magenta from 65, purple from 80.
 *
 * The markers are DOM elements (a handful per volume, each with a label and a
 * click) and the tails a GeoJSON line under them. Colours are theme tokens in
 * detections.css; the tails read the same tokens, again on a theme change.
 */

const SRC = "radar-det-src";
const TAIL_CASE = "radar-det-tail-case";
const TAIL = "radar-det-tail";
const TAIL_DOT = "radar-det-tail-dot";
const IDS = [TAIL_CASE, TAIL, TAIL_DOT];
const DEFAULT_OPACITY = 1;
/** Under this zoom the labels go: at state scale they cover the storms. */
const LABEL_ZOOM = 6.5;

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

interface PaneState {
  markers: maplibregl.Marker[];
  unsub: () => void;
  unsubTheme: () => void;
  onZoom: () => void;
  onZoomDone: () => void;
}
const state = new WeakMap<MapLibreMap, PaneState>();
let opacity = DEFAULT_OPACITY;

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#ffffff";
}

const km = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));
const apartKm = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.hypot((a.lat - b.lat) * 111.2, (a.lon - b.lon) * 111.2 * Math.cos((a.lat * Math.PI) / 180));

function svgCircle(filled: boolean): string {
  return (
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
    (filled
      ? '<circle class="cas" cx="12" cy="12" r="8.2"/><circle class="fg" cx="12" cy="12" r="8.2"/>'
      : '<circle class="cas ring" cx="12" cy="12" r="7.6"/><circle class="fg ring" cx="12" cy="12" r="7.6"/>') +
    "</svg>"
  );
}

function svgTriangle(filled: boolean): string {
  const pts = "12,21 2.6,4.6 21.4,4.6";
  return (
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
    `<polygon class="cas${filled ? "" : " ring"}" points="${pts}"/>` +
    `<polygon class="fg${filled ? "" : " ring"}" points="${pts}"/>` +
    "</svg>"
  );
}

function svgDiamond(): string {
  const pts = "12,2.5 21.5,12 12,21.5 2.5,12";
  return (
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
    `<polygon class="cas" points="${pts}"/><polygon class="fg" points="${pts}"/>` +
    '<circle class="dot" cx="12" cy="12" r="2.6"/>' +
    "</svg>"
  );
}

function sameSel(a: DetSelection | null, b: DetSelection): boolean {
  if (!a || a.type !== b.type) return false;
  if (a.type === "meso" && b.type === "meso") return a.trackId === b.trackId;
  if (a.type === "tvs" && b.type === "tvs") return a.rank === b.rank;
  if (a.type === "tds" && b.type === "tds") return a.index === b.index;
  return false;
}

function marker(
  map: MapLibreMap,
  lngLat: [number, number],
  cls: string,
  html: string,
  label: string | null,
  title: string,
  sel: DetSelection,
  prio = 0,
): maplibregl.Marker {
  const el = document.createElement("div");
  // Stacking and label precedence: TVS 4, mesocyclone 3, circulation 2,
  // debris 1 (plus strength within a kind, as a fraction).
  el.dataset.prio = String(prio);
  el.style.zIndex = String(Math.floor(prio));
  const st = useDetectionsStore.getState();
  el.className = `detmk ${cls}${st.stale ? " is-stale" : ""}${sameSel(st.selected, sel) ? " is-sel" : ""}`;
  el.title = title;
  el.innerHTML = html;
  el.style.opacity = String(opacity);
  if (label) {
    const span = document.createElement("span");
    span.className = "detmk__lbl";
    span.textContent = label;
    el.appendChild(span);
  }
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    // The card anchors to the focused pane: a click on another pane's marker
    // focuses that pane first.
    const pane = paneIdOf(map);
    if (pane) setActivePane(pane);
    const cur = useDetectionsStore.getState().selected;
    useDetectionsStore.getState().select(sameSel(cur, sel) ? null : sel);
  });
  return new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
}

function buildTails(): GeoJSON.FeatureCollection {
  const d = useDetectionsStore.getState().data;
  if (!d) return EMPTY;
  const features: GeoJSON.Feature[] = [];
  for (const m of drawnMesos(d)) {
    if (!m.track?.length) continue;
    const coords = [...m.track.map((p) => [p.lon, p.lat]), [m.lon, m.lat]];
    const color = token(`--det-${vrotTone(m.maxVrotKt)}`);
    features.push({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: { color } });
    for (const p of m.track) {
      features.push({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { color } });
    }
  }
  return { type: "FeatureCollection", features };
}

function paintTails(map: MapLibreMap) {
  if (map.getLayer(TAIL_CASE)) map.setPaintProperty(TAIL_CASE, "line-color", token("--det-casing"));
  if (map.getLayer(TAIL_DOT)) map.setPaintProperty(TAIL_DOT, "circle-stroke-color", token("--det-casing"));
}

/** The radar a pane shows when it is not the loop's (Add radar), else null. */
function paneSite(map: MapLibreMap): string | null {
  const id = paneIdOf(map);
  return (id && useNexradStore.getState().paneRadar[id]?.site) || null;
}

function sync(map: MapLibreMap) {
  const ps = state.get(map);
  if (!ps) return;
  for (const m of ps.markers) m.remove();
  ps.markers = [];
  const d = useDetectionsStore.getState().data;
  // A pane on an added radar (archive-l2) shows that radar: the loop radar's
  // detections do not belong on it.
  const foreign = !!d && paneSite(map) !== null && paneSite(map) !== d.siteId;
  (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(foreign ? EMPTY : buildTails());
  if (!d || foreign) return;
  // Debris first, then rotation, then TVS on top: the triangle is the one that
  // must never be hidden.
  const mesos = drawnMesos(d);
  d.tds.forEach((t, index) => {
    // Debris sits on the rotation: the meso's label already runs to the right,
    // so the debris label drops under the diamond instead of under that label.
    const besideMeso = mesos.some((m) => apartKm(t, m) <= 4);
    ps.markers.push(
      marker(
        map,
        [t.lon, t.lat],
        `detmk--tds${besideMeso ? " lbl-under" : ""}`,
        svgDiamond(),
        `TDS ${Math.round(t.maxDbz)} dBZ · CC ${t.minCc.toFixed(2)}`,
        "Tornado debris signature",
        { type: "tds", index },
        1,
      ),
    );
  });
  const tvs = tvsOf(d);
  for (const m of mesos) {
    const meso = m.kind === "meso";
    const near = tvs.find((c) => apartKm(c, m) <= 4);
    ps.markers.push(
      marker(
        map,
        [m.lon, m.lat],
        `detmk--meso tone-${vrotTone(m.maxVrotKt)}${meso ? " is-filled" : ""}${near ? " has-tvs" : ""}`,
        svgCircle(meso),
        `${meso ? "MESO" : "ROT"} ${km(m.baseKm)}-${km(m.topKm)} km${near ? ` · ${near.tvs}` : ""}`,
        `${meso ? "Mesocyclone" : "Circulation"} · ${Math.round(m.maxVrotKt)} kt`,
        { type: "meso", trackId: m.trackId },
        (meso ? 3 : 2) + Math.min(0.99, m.maxVrotKt / 200),
      ),
    );
  }
  for (const c of tvs) {
    const full = c.tvs === "TVS";
    ps.markers.push(
      marker(
        map,
        [c.lon, c.lat],
        `detmk--tvs tone-${vrotTone(c.vrotKt)}${full ? " is-filled" : ""}`,
        svgTriangle(full),
        null,
        `${full ? "TVS" : "Elevated TVS"} · ${Math.round(c.dvKt)} kt across`,
        { type: "tvs", rank: c.rank },
        4,
      ),
    );
  }
  declutter(map);
}

const overlaps = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Labels that would cover a stronger detection's label hide, strongest first;
 * a circulation's label also gives way to a mesocyclone's or TVS's marker
 * (Moore 2013 at z9.6-10.2: "ROT 1.1-2.1 km" sat on the main MESO label).
 * Measured on screen, so it is redone after every zoom.
 */
function declutter(map: MapLibreMap) {
  const ps = state.get(map);
  if (!ps) return;
  const els = ps.markers.map((m) => m.getElement()).sort((a, b) => Number(b.dataset.prio) - Number(a.dataset.prio));
  const kept: DOMRect[] = [];
  const strongIcons: DOMRect[] = [];
  for (const el of els) {
    const prio = Number(el.dataset.prio);
    const icon = el.querySelector("svg");
    const lbl = el.querySelector<HTMLElement>(".detmk__lbl");
    if (lbl) {
      lbl.style.visibility = "";
      const r = lbl.getBoundingClientRect();
      const hit =
        r.width > 0 &&
        (kept.some((k) => overlaps(k, r)) || (prio >= 2 && prio < 3 && strongIcons.some((k) => overlaps(k, r))));
      if (hit) lbl.style.visibility = "hidden";
      else if (r.width > 0) kept.push(r);
    }
    if (icon && prio >= 3) strongIcons.push(icon.getBoundingClientRect());
  }
}

function zoomClass(map: MapLibreMap) {
  map.getContainer().classList.toggle("det-lo", map.getZoom() < LABEL_ZOOM);
}

// Labels are re-sorted once a zoom settles (not on every animation frame).
const declutterSoon = new WeakMap<MapLibreMap, number>();
function onZoomEnd(map: MapLibreMap) {
  const prev = declutterSoon.get(map);
  if (prev) cancelAnimationFrame(prev);
  declutterSoon.set(map, requestAnimationFrame(() => declutter(map)));
}

export const radarDetectionsLayer: LayerModule = {
  id: "radar-detections",
  name: "Storm detections (radar)",
  description:
    "Mesocyclones, tornado vortex signatures and debris signatures computed from the radar's own Level II volume, following the scan on screen. Circles: mesocyclones (filled) and weaker circulations (hollow). Triangles: TVS (filled) and elevated TVS (hollow). Diamonds: debris. Orange from 30 kt, red 50, magenta 65, purple 80.",
  category: "weather",
  source: "Computed by WeatherTS from NEXRAD Level II base data",
  defaultVisible: false,
  defaultOpacity: DEFAULT_OPACITY,

  addTo(map) {
    if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: EMPTY });
    if (!map.getLayer(TAIL_CASE)) {
      map.addLayer({
        id: TAIL_CASE,
        type: "line",
        source: SRC,
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": token("--det-casing"), "line-width": 4.2, "line-opacity": 0.75 * opacity },
      });
    }
    if (!map.getLayer(TAIL)) {
      map.addLayer({
        id: TAIL,
        type: "line",
        source: SRC,
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 2, "line-opacity": opacity },
      });
    }
    if (!map.getLayer(TAIL_DOT)) {
      map.addLayer({
        id: TAIL_DOT,
        type: "circle",
        source: SRC,
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 3,
          "circle-color": ["get", "color"],
          "circle-stroke-color": token("--det-casing"),
          "circle-stroke-width": 1.2,
          "circle-opacity": opacity,
          "circle-stroke-opacity": opacity,
        },
      });
    }
    const onZoom = () => zoomClass(map);
    const onZoomDone = () => onZoomEnd(map);
    map.on("zoom", onZoom);
    map.on("zoomend", onZoomDone);
    map.on("resize", onZoomDone);
    zoomClass(map);
    const unsubDet = useDetectionsStore.subscribe((s, p) => {
      if (s.data !== p.data || s.stale !== p.stale || s.selected !== p.selected) sync(map);
    });
    // A pane switched to (or back from) an added radar.
    let shownSite = paneSite(map);
    const unsubPane = useNexradStore.subscribe(() => {
      const now = paneSite(map);
      if (now === shownSite) return;
      shownSite = now;
      sync(map);
    });
    const unsub = () => {
      unsubDet();
      unsubPane();
    };
    // The tokens change with the theme; the DOM markers follow by CSS, the
    // GL tails need their colours read again.
    const themeObs = new MutationObserver(() => {
      paintTails(map);
      sync(map);
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const unsubTheme = () => themeObs.disconnect();
    state.set(map, { markers: [], unsub, unsubTheme, onZoom, onZoomDone });
    useDetectionsStore.getState().attach();
    sync(map);
  },

  removeFrom(map, styleSwap) {
    const ps = state.get(map);
    if (ps) {
      for (const m of ps.markers) m.remove();
      ps.unsub();
      ps.unsubTheme();
      map.off("zoom", ps.onZoom);
      map.off("zoomend", ps.onZoomDone);
      map.off("resize", ps.onZoomDone);
      map.getContainer().classList.remove("det-lo");
      state.delete(map);
      useDetectionsStore.getState().detach(styleSwap);
    }
    for (const id of [...IDS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },

  setOpacity(map, o) {
    opacity = o;
    if (map.getLayer(TAIL_CASE)) map.setPaintProperty(TAIL_CASE, "line-opacity", 0.75 * o);
    if (map.getLayer(TAIL)) map.setPaintProperty(TAIL, "line-opacity", o);
    if (map.getLayer(TAIL_DOT)) {
      map.setPaintProperty(TAIL_DOT, "circle-opacity", o);
      map.setPaintProperty(TAIL_DOT, "circle-stroke-opacity", o);
    }
    for (const m of state.get(map)?.markers ?? []) m.getElement().style.opacity = String(o);
  },

  getLayerIds() {
    return IDS;
  },

  // Over the radar and the alert outlines, like the storm cells' tracks.
  topLayerIds() {
    return IDS;
  },
  topPriority: 18,
};
