import maplibregl from "maplibre-gl";
import type {
  ExpressionSpecification,
  GeoJSONSource,
  Map as MapLibreMap,
  MapLayerMouseEvent,
} from "maplibre-gl";

import type { LayerModule } from "../types";
import { registerMarkerLayers, unregisterMarkerLayers } from "../clickPriority";
import {
  LSR_CATEGORIES,
  LSR_COLORS,
  LSR_SHAPES,
  LSR_SHAPE_PATHS,
  lsrHm,
  lsrKey,
  lsrPlace,
  lsrSeverity,
  type LsrProps,
} from "../../lib/lsr";
import { isNewLsr, lsrWindow, selectVisibleLsr, useLsrStore } from "../../store/useLsrStore";
import { mapInk } from "../../map/mapInk";

const SRC = "lsr-src";
const HL_SRC = "lsr-hl-src";
const ICONS = "lsr-icons";
const LABELS = "lsr-labels";
/** A ring under each report that came in while the feed was being watched. */
const NEW_RING = "lsr-new";
/** A ring under the report the card is open on, or the list row under the pointer. */
const HL_RING = "lsr-hl";
const DEFAULT_OPACITY = 1;
/** How faint the oldest report of the window gets with "fade older" on. */
const FADE_TO = 0.3;

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
/** Panes the layer is on: the feed polls while there is at least one. */
let attached = 0;

// ---------------------------------------------------------------------------
// Icons. Shape carries the category family, colour the category within it, the
// way a storm-report legend codes them. The path comes from LSR_SHAPE_PATHS so
// the map and the panel legend are drawn from one definition — Path2D takes the
// same `d` string an <svg> does.
// ---------------------------------------------------------------------------
const ICON_PREFIX = "lsr-";
const R = 3; // supersample: these are small on screen and get scaled up on zoom
const BOX = 24; // the shape paths are authored in a 24x24 box
const SIZE = BOX * R;

function registerIcons(map: MapLibreMap) {
  for (const cat of LSR_CATEGORIES) {
    const id = `${ICON_PREFIX}${cat}`;
    if (map.hasImage(id)) continue;
    const cv = document.createElement("canvas");
    cv.width = SIZE;
    cv.height = SIZE;
    const ctx = cv.getContext("2d");
    if (!ctx) continue;
    ctx.scale(R, R);

    const path = new Path2D(LSR_SHAPE_PATHS[LSR_SHAPES[cat]]);
    // Dark halo first, so a light marker still reads over a light basemap.
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(6,10,16,0.95)";
    ctx.lineWidth = 3;
    ctx.stroke(path);
    ctx.fillStyle = LSR_COLORS[cat];
    ctx.fill(path);
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 0.9;
    ctx.stroke(path);

    map.addImage(id, ctx.getImageData(0, 0, SIZE, SIZE), { pixelRatio: R });
  }
}

/** The theme's accent, for the rings: they are app chrome, not data colours. */
function accent(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  return v || "#6c9dff";
}

function iconOpacity(): number | ExpressionSpecification {
  if (!useLsrStore.getState().fadeOld) return opacity;
  return ["*", opacity, ["-", 1, ["*", 1 - FADE_TO, ["get", "age"]]]];
}

function push(map: MapLibreMap) {
  const src = map.getSource(SRC) as GeoJSONSource | undefined;
  if (!src) return;
  const s = useLsrStore.getState();
  const all = s.data?.features ?? [];
  const shown = new Set(selectVisibleLsr(s));
  const { start, end } = s.data
    ? { start: s.data.meta.startUnix, end: s.data.meta.endUnix }
    : lsrWindow(s.span, s.endUnix);
  const span = Math.max(1, end - start);
  // Carry each report's index INTO `data.features`, not into the filtered list,
  // so a click can find the original by position instead of by matching
  // coordinates. Coordinate matching looked fine and was not: MapLibre returns
  // a queried feature wrapped into the world copy on screen, so once the map is
  // panned across the antimeridian the longitude differs by 360 and the lookup
  // silently found nothing -- which is a click that does nothing at all.
  const features: GeoJSON.Feature[] = [];
  all.forEach((f, i) => {
    if (!shown.has(f)) return;
    const key = lsrKey(f);
    features.push({
      ...f,
      properties: {
        ...f.properties,
        idx: i,
        // symbol-sort-key wants "smaller draws first"; rank is severity, so flip
        // it -- a tornado report must survive a collision with a rain total.
        sort: 1000 - f.properties.rank - lsrSeverity(f.properties) * 100,
        // 0 at the window's end, 1 at its start: how far faded it is.
        age: Math.min(1, Math.max(0, (end - f.properties.unix) / span)),
        fresh: isNewLsr(s.arrived, key),
      },
    });
  });
  src.setData({ type: "FeatureCollection", features } as GeoJSON.FeatureCollection);
}

/** The ring under the report being looked at: the open card's, else the row
 *  under the pointer in the list. */
function pushHighlight(map: MapLibreMap) {
  const src = map.getSource(HL_SRC) as GeoJSONSource | undefined;
  if (!src) return;
  const s = useLsrStore.getState();
  const feats: GeoJSON.Feature[] = [];
  if (s.selected) feats.push({ ...s.selected, properties: { kind: "selected" } });
  if (s.hovered && (!s.selected || lsrKey(s.selected) !== s.hovered)) {
    const f = s.data?.features.find((x) => lsrKey(x) === s.hovered);
    if (f) feats.push({ ...f, properties: { kind: "hover" } });
  }
  src.setData({ type: "FeatureCollection", features: feats });
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

function ago(unix: number): string {
  const m = (Date.now() / 1000 - unix) / 60;
  if (m < 60) return `${Math.max(0, Math.round(m))} min ago`;
  if (m < 36 * 60) return `${(m / 60).toFixed(m < 600 ? 1 : 0)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

/** The hover preview: enough to know whether the report is worth a click. */
function tipHtml(p: LsrProps): string {
  const color = LSR_COLORS[p.cat] ?? LSR_COLORS.other;
  const sev = lsrSeverity(p);
  return (
    `<div class="lsrtip">` +
    `<b style="color:${color}">${esc(p.typeName || p.label)}${p.mag ? ` <em>${esc(p.mag)}</em>` : ""}</b>` +
    (sev ? `<i class="lsrtip__sev lsrtip__sev--${sev}">${sev === 2 ? "SIG" : "SEVERE"}</i>` : "") +
    `<span>${esc(lsrPlace(p))}</span>` +
    `<span class="lsrtip__time">${lsrHm(p.unix)} · ${ago(p.unix)}</span>` +
    `</div>`
  );
}

/** NWS Local Storm Reports: what people on the ground actually observed. */
export const lsrLayer: LayerModule = {
  id: "lsr",
  name: "Local Storm Reports",
  description:
    "Tornado, hail, wind, flood and other reports filed by NWS offices. Click one for the full report.",
  category: "weather",
  source: "NWS Local Storm Reports via Iowa Environmental Mesonet",
  defaultVisible: false,
  defaultOpacity: DEFAULT_OPACITY,

  addTo(map) {
    registerIcons(map);
    if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: EMPTY });
    if (!map.getSource(HL_SRC)) map.addSource(HL_SRC, { type: "geojson", data: EMPTY });
    const ring = accent();

    if (!map.getLayer(NEW_RING)) {
      map.addLayer({
        id: NEW_RING,
        type: "circle",
        source: SRC,
        filter: ["==", ["get", "fresh"], true],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 8, 6, 10, 10, 13],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": ring,
          "circle-stroke-width": 1.6,
          "circle-stroke-opacity": opacity,
        },
      });
    }
    if (!map.getLayer(HL_RING)) {
      map.addLayer({
        id: HL_RING,
        type: "circle",
        source: HL_SRC,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 11, 6, 13, 10, 16],
          "circle-color": ring,
          "circle-opacity": ["match", ["get", "kind"], "selected", 0.16, 0],
          "circle-stroke-color": ring,
          "circle-stroke-width": ["match", ["get", "kind"], "selected", 2.4, 1.6],
        },
      });
    }
    if (!map.getLayer(ICONS)) {
      map.addLayer({
        id: ICONS,
        type: "symbol",
        source: SRC,
        layout: {
          "icon-image": ["concat", ICON_PREFIX, ["get", "cat"]],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.55, 6, 0.7, 10, 0.9],
          // EVERY report is drawn. Decluttering hid reports at low zoom, and a
          // symbol MapLibre skipped is not hit-testable either — so the ones
          // that disappeared could not be clicked at all.
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "symbol-sort-key": ["get", "sort"],
        },
        paint: { "icon-opacity": iconOpacity() },
      });
    }
    if (!map.getLayer(LABELS)) {
      map.addLayer({
        id: LABELS,
        type: "symbol",
        source: SRC,
        minzoom: 5,
        layout: {
          "text-field": ["get", "mag"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 11,
          "text-offset": [0, 1.05],
          "text-anchor": "top",
          "text-optional": true,
          "text-allow-overlap": false,
          "symbol-sort-key": ["get", "sort"],
        },
        paint: {
          "text-color": mapInk().text,
          "text-halo-color": mapInk().halo,
          "text-halo-width": 1.3,
          "text-opacity": opacity,
        },
      });
    }

    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const store = useLsrStore.getState();
      const idx = Number(f.properties?.idx);
      const byIndex = Number.isInteger(idx) ? store.data?.features[idx] : undefined;
      if (byIndex) {
        store.select(byIndex);
        return;
      }
      // Fall back to the rendered feature itself rather than selecting nothing:
      // every field the card shows is already in its properties, and a click
      // that opens nothing is indistinguishable from a broken layer.
      if (f.geometry.type !== "Point") return;
      store.select({
        type: "Feature",
        geometry: { type: "Point", coordinates: f.geometry.coordinates as [number, number] },
        properties: f.properties as unknown as LsrProps,
      });
    };

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
      className: "raobpop",
    });
    let tipFor = -1;
    const onMove = (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      const idx = Number(f.properties?.idx);
      if (idx === tipFor && popup.isOpen()) return;
      const report = useLsrStore.getState().data?.features[idx];
      if (!report) return;
      tipFor = idx;
      popup
        .setLngLat(f.geometry.coordinates as [number, number])
        .setHTML(tipHtml(report.properties))
        .addTo(map);
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
      tipFor = -1;
      popup.remove();
    };
    // Bind BOTH layers: the magnitude label reads as part of the marker, so a
    // click on "58 mph" must open the same report as a click on the diamond.
    for (const id of [ICONS, LABELS]) {
      map.on("click", id, onClick);
      map.on("mousemove", id, onMove);
      map.on("mouseleave", id, onLeave);
    }
    // A report is a small deliberate target: it wins a click over the alert or
    // outlook polygon it sits in.
    registerMarkerLayers([ICONS, LABELS]);

    const unsub = useLsrStore.subscribe((s, prev) => {
      if (s.data !== prev.data || s.cats !== prev.cats || s.minSeverity !== prev.minSeverity ||
          s.arrived !== prev.arrived) {
        push(map);
      }
      if (s.fadeOld !== prev.fadeOld && map.getLayer(ICONS)) {
        map.setPaintProperty(ICONS, "icon-opacity", iconOpacity());
      }
      if (s.selected !== prev.selected || s.hovered !== prev.hovered || s.data !== prev.data) {
        pushHighlight(map);
      }
      if (s.showLabels !== prev.showLabels && map.getLayer(LABELS)) {
        map.setLayoutProperty(LABELS, "visibility", s.showLabels ? "visible" : "none");
      }
    });
    state.set(map, { unsub, onClick, onMove, onLeave, popup });

    if (map.getLayer(LABELS)) {
      map.setLayoutProperty(
        LABELS,
        "visibility",
        useLsrStore.getState().showLabels ? "visible" : "none",
      );
    }
    push(map);
    pushHighlight(map);
    attached += 1;
    useLsrStore.getState().startPolling();
    // Only fetch if nothing is loaded yet: a second pane must not restart the
    // request the first one is already waiting on.
    if (!useLsrStore.getState().data) void useLsrStore.getState().load();
  },

  removeFrom(map) {
    const st = state.get(map);
    if (st) {
      for (const id of [ICONS, LABELS]) {
        map.off("click", id, st.onClick);
        map.off("mousemove", id, st.onMove);
        map.off("mouseleave", id, st.onLeave);
      }
      st.popup.remove();
      st.unsub();
      state.delete(map);
      attached = Math.max(0, attached - 1);
      if (attached === 0) useLsrStore.getState().stopPolling();
    }
    unregisterMarkerLayers([ICONS, LABELS]);
    for (const id of [LABELS, ICONS, HL_RING, NEW_RING]) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of [SRC, HL_SRC]) if (map.getSource(id)) map.removeSource(id);
    useLsrStore.getState().select(null);
  },

  setOpacity(map, o) {
    opacity = o;
    if (map.getLayer(ICONS)) map.setPaintProperty(ICONS, "icon-opacity", iconOpacity());
    if (map.getLayer(LABELS)) map.setPaintProperty(LABELS, "text-opacity", o);
    if (map.getLayer(NEW_RING)) map.setPaintProperty(NEW_RING, "circle-stroke-opacity", o);
  },

  getLayerIds() {
    return [NEW_RING, HL_RING, ICONS, LABELS];
  },

  topLayerIds() {
    // Reports are the ground truth over whatever product is being examined;
    // they must never be buried under radar or an alert fill.
    return [NEW_RING, HL_RING, ICONS, LABELS];
  },
  // Above radar (20) and the mesoscale discussion outline (10): a filed report
  // is what actually happened, which outranks a tracked cell or a forecaster's
  // watch area.
  topPriority: 30,
};
