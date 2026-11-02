/**
 * The 3D view's ground: a real map under the box -- the app's basemap or the
 * satellite imagery -- four times the box's width, rendered once by a hidden
 * MapLibre map and kept as a picture (Web Mercator, north up). The warnings
 * in force and the radar's spot are drawn over it in their own colours. The
 * shader maps each ground point (km east/north of the box centre) to the
 * picture through the same azimuthal projection as the voxels, so the radar's
 * echo sits on the right town.
 */
import maplibregl from "maplibre-gl";

import { buildBasemapStyle } from "../../map/basemaps";
import { eventColor, type AlertFeature } from "../nwsAlerts";
import { fromGridKm } from "./selection";

export type GroundMode = "satellite" | "map" | "plain";

export const GROUND_MODES: { id: GroundMode; label: string; hint: string }[] = [
  { id: "satellite", label: "Satellite", hint: "Satellite imagery under the box" },
  { id: "map", label: "Map", hint: "The map's own basemap under the box" },
  { id: "plain", label: "Plain", hint: "A plain ground with a grid" },
];

/** The ground reaches this many box widths across. */
export const GROUND_SPAN = 4;

export interface GroundBase {
  canvas: HTMLCanvasElement;
  west: number;
  east: number;
  south: number;
  north: number;
}

export interface GroundExtent {
  clat: number;
  clon: number;
  /** Half the ground's width, km. */
  halfKm: number;
}

export interface GroundAlert {
  rings: [number, number][][];
  color: string;
  tornado: boolean;
}

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/** The lon/lat rectangle the ground square covers. */
export function extentBounds(e: GroundExtent): [number, number, number, number] {
  let w = Infinity;
  let s = Infinity;
  let east = -Infinity;
  let n = -Infinity;
  const k = e.halfKm;
  for (let i = 0; i <= 8; i++) {
    const t = -k + (2 * k * i) / 8;
    for (const [x, y] of [[t, -k], [t, k], [-k, t], [k, t]] as [number, number][]) {
      const [lon, lat] = fromGridKm(e.clat, e.clon, x, y);
      w = Math.min(w, lon);
      east = Math.max(east, lon);
      s = Math.min(s, lat);
      n = Math.max(n, lat);
    }
  }
  return [w, Math.max(-84, s), east, Math.min(84, n)];
}

const bases = new Map<string, Promise<GroundBase>>();

/** The basemap (or the satellite imagery) over the ground square, size x
 *  size pixels; null when the map cannot draw (no WebGL, offline...). One
 *  picture per box and style is kept. */
export function groundBase(mode: Exclude<GroundMode, "plain">, basemapId: string, e: GroundExtent, size: number): Promise<GroundBase | null> {
  const styleId = mode === "satellite" ? "satellite" : basemapId;
  const b = extentBounds(e);
  const key = `${styleId}|${size}|${b.map((v) => v.toFixed(3)).join(",")}`;
  let p = bases.get(key);
  if (!p) {
    p = renderBase(styleId, b, size);
    bases.set(key, p);
    p.catch(() => bases.delete(key));
    while (bases.size > 3) bases.delete(bases.keys().next().value as string);
  }
  return p.catch(() => null);
}

async function renderBase(styleId: string, b: [number, number, number, number], size: number): Promise<GroundBase> {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `position:fixed;left:-${size + 4000}px;top:0;width:${size}px;height:${size}px;opacity:0;pointer-events:none;`;
  document.body.appendChild(host);
  let map: maplibregl.Map | null = null;
  try {
    map = new maplibregl.Map({
      container: host,
      style: buildBasemapStyle(styleId),
      bounds: [b[0], b[1], b[2], b[3]],
      fitBoundsOptions: { padding: 0 },
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      pixelRatio: 1,
      renderWorldCopies: false,
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
    });
    const m = map;
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 15000);
      m.once("idle", () => {
        window.clearTimeout(timer);
        resolve();
      });
      m.once("error", () => undefined);
    });
    const bb = m.getBounds();
    const out = document.createElement("canvas");
    out.width = size;
    out.height = size;
    const ctx = out.getContext("2d");
    if (!ctx) throw new Error("no 2D canvas");
    ctx.drawImage(m.getCanvas(), 0, 0, size, size);
    return { canvas: out, west: bb.getWest(), east: bb.getEast(), south: bb.getSouth(), north: bb.getNorth() };
  } finally {
    map?.remove();
    host.remove();
  }
}

/** Storm-based warnings (polygons) in force that reach the ground square. */
export function groundAlerts(features: AlertFeature[], base: GroundBase): GroundAlert[] {
  const out: GroundAlert[] = [];
  for (const f of features) {
    const g = f.geometry;
    if (!g || !/warning/i.test(f.alert.event)) continue;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    const rings: [number, number][][] = [];
    for (const poly of polys) {
      const ring = poly[0] as [number, number][] | undefined;
      if (!ring || ring.length < 3) continue;
      const hit = ring.some(([lon, lat]) => lon >= base.west && lon <= base.east && lat >= base.south && lat <= base.north);
      if (hit) rings.push(ring);
    }
    if (rings.length) out.push({ rings, color: eventColor(f.alert.event), tornado: /tornado/i.test(f.alert.event) });
  }
  // Tornado warnings on top.
  return out.sort((a, b) => Number(a.tornado) - Number(b.tornado));
}

/** The picture the shader gets: the base, the warnings and the radar's spot. */
export function composeGround(
  base: GroundBase,
  alerts: GroundAlert[],
  radar: { lon: number; lat: number; label: string } | null,
): HTMLCanvasElement {
  const W = base.canvas.width;
  const H = base.canvas.height;
  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const ctx = out.getContext("2d")!;
  ctx.drawImage(base.canvas, 0, 0);
  const y0 = mercY(base.north);
  const y1 = mercY(base.south);
  const px = (lon: number, lat: number): [number, number] => [
    ((lon - base.west) / (base.east - base.west)) * W,
    ((y0 - mercY(lat)) / (y0 - y1)) * H,
  ];
  const lw = Math.max(2, W / 640);
  for (const a of alerts) {
    ctx.beginPath();
    for (const ring of a.rings) {
      ring.forEach(([lon, lat], i) => {
        const [x, y] = px(lon, lat);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
    }
    ctx.globalAlpha = a.tornado ? 0.24 : 0.16;
    ctx.fillStyle = a.color;
    ctx.fill();
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = "#0b0d10";
    ctx.lineWidth = lw * 2.4;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = a.color;
    ctx.lineWidth = lw * 1.3;
    ctx.stroke();
  }
  if (radar) {
    const [x, y] = px(radar.lon, radar.lat);
    const r = lw * 2.2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#f4f1e8";
    ctx.fill();
    ctx.lineWidth = lw * 0.8;
    ctx.strokeStyle = "#0b0d10";
    ctx.stroke();
    ctx.font = `600 ${Math.round(lw * 6)}px system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.lineWidth = lw * 1.6;
    ctx.strokeText(radar.label, x + r * 1.8, y);
    ctx.fillText(radar.label, x + r * 1.8, y);
  }
  return out;
}

/** What the shader needs to find a ground point on the picture: the box
 *  centre (radians) and the picture's bounds (radians; Mercator y). */
export function groundGeo(e: GroundExtent, base: GroundBase): { center: [number, number]; merc: [number, number, number, number] } {
  const D = Math.PI / 180;
  return {
    center: [e.clat * D, e.clon * D],
    merc: [base.west * D, base.east * D, mercY(base.south), mercY(base.north)],
  };
}
