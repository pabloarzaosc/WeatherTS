import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";

import type { LayerModule } from "../types";
import { allMaps } from "../../map/mapInstance";
import { useDrawStore, type LngLat, type Shape } from "../../store/useDrawStore";

/**
 * What the user draws with the Draw tool, on every pane.
 *
 * Widths are screen pixels, so a stroke keeps its weight at any zoom while the
 * shape itself stays pinned to the ground it was drawn over. Circles and
 * rectangles are built as real polygons in latitude and longitude; an arrow's
 * head is an icon turned to the line's heading, so it grows with the stroke
 * rather than with the zoom.
 */

const SRC = "draw-src";
export const DRAW_FILL = "draw-fill";
export const DRAW_CASING = "draw-casing";
export const DRAW_LINE = "draw-line";
export const DRAW_LINE_DASHED = "draw-line-dashed";
export const DRAW_ARROW = "draw-arrow";
export const DRAW_TEXT = "draw-text";
export const DRAW_LAYERS = [DRAW_FILL, DRAW_CASING, DRAW_LINE, DRAW_LINE_DASHED, DRAW_ARROW, DRAW_TEXT];
const ARROW_IMAGE = "draw-arrowhead";
const FILL_OPACITY = 0.22;

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** The stroke being drawn right now, before it is committed to the store. */
let draft: Omit<Shape, "id"> | null = null;

const unsubs = new WeakMap<MapLibreMap, () => void>();

// ------------------------------------------------------------------ geometry

const R_EARTH_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

function distanceKm(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function destination(c: LngLat, km: number, bearingDeg: number): LngLat {
  const d = km / R_EARTH_KM;
  const b = rad(bearingDeg);
  const lat1 = rad(c[1]);
  const lng1 = rad(c[0]);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lng2 = lng1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [deg(lng2), deg(lat2)];
}

function circleRing(c: LngLat, edge: LngLat): LngLat[] {
  const km = distanceKm(c, edge);
  const ring: LngLat[] = [];
  for (let i = 0; i <= 72; i++) ring.push(destination(c, km, (i * 360) / 72));
  return ring;
}

function rectRing(a: LngLat, b: LngLat): LngLat[] {
  return [a, [b[0], a[1]], b, [a[0], b[1]], a];
}

/** Heading on the map, clockwise from north, as the arrow head must turn. */
function screenBearing(a: LngLat, b: LngLat): number {
  const my = (lat: number) => Math.log(Math.tan(Math.PI / 4 + rad(lat) / 2));
  const dx = rad(b[0] - a[0]);
  const dy = my(b[1]) - my(a[1]);
  return (deg(Math.atan2(dx, dy)) + 360) % 360;
}

function toFeatures(shape: Omit<Shape, "id"> & { id?: string }): GeoJSON.Feature[] {
  const props = {
    id: shape.id ?? "draft",
    kind: shape.kind,
    color: shape.color,
    width: shape.width,
    dashed: shape.dashed,
  };
  const pts = shape.points;
  if (shape.kind === "text") {
    if (!pts[0] || !shape.text) return [];
    return [
      {
        type: "Feature",
        properties: { ...props, text: shape.text, size: Math.round(12 + shape.width * 1.2) },
        geometry: { type: "Point", coordinates: pts[0] },
      },
    ];
  }
  if (pts.length < 2) return [];
  if (shape.kind === "circle" || shape.kind === "rect") {
    const ring = shape.kind === "circle" ? circleRing(pts[0], pts[1]) : rectRing(pts[0], pts[pts.length - 1]);
    const out: GeoJSON.Feature[] = [
      { type: "Feature", properties: props, geometry: { type: "LineString", coordinates: ring } },
    ];
    if (shape.fill) out.unshift({ type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [ring] } });
    return out;
  }
  const out: GeoJSON.Feature[] = [
    { type: "Feature", properties: props, geometry: { type: "LineString", coordinates: pts } },
  ];
  if (shape.kind === "arrow") {
    const end = pts[pts.length - 1];
    out.push({
      type: "Feature",
      properties: { ...props, rotate: screenBearing(pts[0], end), size: +((shape.width * 3 + 12) / 32).toFixed(3) },
      geometry: { type: "Point", coordinates: end },
    });
  }
  return out;
}

/**
 * The shapes under a point on screen, for the eraser.
 *
 * Worked out from the geometry rather than asked of the renderer: what the
 * renderer knows is the last frame it drew, and a shape drawn a moment ago may
 * not be in it yet.
 */
export function shapesAt(map: MapLibreMap, xy: [number, number], slopPx = 6): string[] {
  const hit: string[] = [];
  const near = (a: { x: number; y: number }, b: { x: number; y: number }, reach: number) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((xy[0] - a.x) * dx + (xy[1] - a.y) * dy) / len2)) : 0;
    return Math.hypot(xy[0] - (a.x + t * dx), xy[1] - (a.y + t * dy)) <= reach;
  };
  const inside = (ring: { x: number; y: number }[]) => {
    let odd = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a.y > xy[1] !== b.y > xy[1] && xy[0] < ((b.x - a.x) * (xy[1] - a.y)) / (b.y - a.y) + a.x) odd = !odd;
    }
    return odd;
  };
  for (const shape of useDrawStore.getState().shapes) {
    const reach = slopPx + shape.width / 2;
    const found = toFeatures(shape).some((f) => {
      const g = f.geometry;
      if (g.type === "Point") {
        const c = map.project(g.coordinates as LngLat);
        if (shape.kind === "text") {
          const size = 12 + shape.width * 1.2;
          const halfW = ((shape.text?.length ?? 1) * size * 0.3) + slopPx;
          return Math.abs(xy[0] - c.x) <= halfW && Math.abs(xy[1] - c.y) <= size / 2 + slopPx;
        }
        return Math.hypot(xy[0] - c.x, xy[1] - c.y) <= reach + 6;
      }
      if (g.type === "LineString") {
        const pts = (g.coordinates as LngLat[]).map((p) => map.project(p));
        if (pts.length === 1) return near(pts[0], pts[0], reach);
        for (let i = 1; i < pts.length; i++) if (near(pts[i - 1], pts[i], reach)) return true;
        return false;
      }
      if (g.type === "Polygon") return inside((g.coordinates[0] as LngLat[]).map((p) => map.project(p)));
      return false;
    });
    if (found) hit.push(shape.id);
  }
  return hit;
}

function collection(): GeoJSON.FeatureCollection {
  const shapes: (Omit<Shape, "id"> & { id?: string })[] = [...useDrawStore.getState().shapes];
  if (draft) shapes.push(draft);
  return { type: "FeatureCollection", features: shapes.flatMap(toFeatures) };
}

function push(map: MapLibreMap): void {
  (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(collection());
}

/** Show (or clear) the stroke in progress on every pane. */
export function setDrawDraft(shape: Omit<Shape, "id"> | null): void {
  draft = shape;
  for (const map of allMaps()) push(map);
}

/** A white triangle, drawn as a signed-distance image so it takes any colour. */
function ensureArrowImage(map: MapLibreMap): void {
  if (map.hasImage(ARROW_IMAGE)) return;
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(size / 2, 3);
  ctx.lineTo(size - 4, size - 4);
  ctx.lineTo(size / 2, size - 11);
  ctx.lineTo(4, size - 4);
  ctx.closePath();
  ctx.fill();
  map.addImage(ARROW_IMAGE, ctx.getImageData(0, 0, size, size), { sdf: true, pixelRatio: 1 });
}

const isLine = ["==", ["geometry-type"], "LineString"] as never;

export const drawLayer: LayerModule = {
  id: "drawings",
  name: "Drawings",
  description: "What you draw on the map with the Draw tool.",
  category: "reference",
  source: "Drawn by you",
  defaultVisible: true,
  defaultOpacity: 1,
  // Annotations sit on top of every product.
  topPriority: 100,

  addTo(map) {
    unsubs.get(map)?.();
    ensureArrowImage(map);
    if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: EMPTY });

    if (!map.getLayer(DRAW_FILL)) {
      map.addLayer({
        id: DRAW_FILL,
        type: "fill",
        source: SRC,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": ["get", "color"], "fill-opacity": FILL_OPACITY },
      });
    }
    // A dark edge under every stroke, so a red line still reads over red radar.
    if (!map.getLayer(DRAW_CASING)) {
      map.addLayer({
        id: DRAW_CASING,
        type: "line",
        source: SRC,
        filter: isLine,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "rgba(0,0,0,0.6)", "line-width": ["+", ["get", "width"], 3] },
      });
    }
    if (!map.getLayer(DRAW_LINE)) {
      map.addLayer({
        id: DRAW_LINE,
        type: "line",
        source: SRC,
        filter: ["all", isLine, ["!", ["get", "dashed"]]] as never,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": ["get", "width"] },
      });
    }
    // Dash patterns cannot follow the data, so dashed strokes are their own layer.
    if (!map.getLayer(DRAW_LINE_DASHED)) {
      map.addLayer({
        id: DRAW_LINE_DASHED,
        type: "line",
        source: SRC,
        filter: ["all", isLine, ["get", "dashed"]] as never,
        layout: { "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": ["get", "width"], "line-dasharray": [2, 1.6] },
      });
    }
    if (!map.getLayer(DRAW_ARROW)) {
      map.addLayer({
        id: DRAW_ARROW,
        type: "symbol",
        source: SRC,
        filter: ["all", ["==", ["geometry-type"], "Point"], ["==", ["get", "kind"], "arrow"]] as never,
        layout: {
          "icon-image": ARROW_IMAGE,
          "icon-size": ["get", "size"],
          "icon-rotate": ["get", "rotate"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-color": ["get", "color"], "icon-halo-color": "rgba(0,0,0,0.6)", "icon-halo-width": 1.5 },
      });
    }
    if (!map.getLayer(DRAW_TEXT)) {
      map.addLayer({
        id: DRAW_TEXT,
        type: "symbol",
        source: SRC,
        filter: ["==", ["get", "kind"], "text"],
        layout: {
          "text-field": ["get", "text"],
          "text-font": ["Noto Sans Bold"],
          "text-size": ["get", "size"],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: { "text-color": ["get", "color"], "text-halo-color": "rgba(0,0,0,0.75)", "text-halo-width": 1.6 },
      });
    }

    unsubs.set(map, useDrawStore.subscribe((s, prev) => {
      if (s.shapes !== prev.shapes) push(map);
    }));
    push(map);
  },

  removeFrom(map) {
    unsubs.get(map)?.();
    unsubs.delete(map);
    for (const id of [...DRAW_LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },

  setOpacity(map, opacity) {
    if (map.getLayer(DRAW_FILL)) map.setPaintProperty(DRAW_FILL, "fill-opacity", FILL_OPACITY * opacity);
    for (const id of [DRAW_CASING, DRAW_LINE, DRAW_LINE_DASHED]) {
      if (map.getLayer(id)) map.setPaintProperty(id, "line-opacity", opacity);
    }
    if (map.getLayer(DRAW_ARROW)) map.setPaintProperty(DRAW_ARROW, "icon-opacity", opacity);
    if (map.getLayer(DRAW_TEXT)) map.setPaintProperty(DRAW_TEXT, "text-opacity", opacity);
  },

  getLayerIds() {
    return DRAW_LAYERS;
  },

  topLayerIds() {
    return DRAW_LAYERS;
  },
};
