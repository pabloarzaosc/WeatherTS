/**
 * The 3D view's selection on the map: a box, a traced area or "whole view",
 * kept as a ring of [lon, lat] corners. The volume is always asked for the
 * ring's bounding box; an area is then masked to its outline here, so what is
 * drawn is only what the ring holds.
 *
 * The box frame is the backend's (radar_volume3d.to_grid_km): azimuthal
 * equidistant km east and north of the box's centre.
 */
import { isTdwrId, useNexradStore } from "../../store/useNexradStore";
import { TDWR_VOLUME_NOTE } from "../nexrad";
import type { Volume3D } from "./volume";

export type LngLat = [number, number];
export type BBox = [number, number, number, number];
export type SelKind = "box" | "area" | "whole";

export interface Sel3D {
  kind: SelKind;
  ring: LngLat[];
}

const R_KM = 6371.0;
const D = Math.PI / 180;
/** What the backend takes (BOX_MAX_KM 420 in radar_volume3d; it says 400). */
export const MAX_BOX_KM = 400;
export const MIN_BOX_KM = 4;
/** Reflectivity reaches 460 km, every other moment 300 km (radar_volume3d). */
export function reachKm(fam: string): number {
  return fam === "B" ? 460 : 300;
}

export function kmBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * D;
  const p2 = lat2 * D;
  const a = Math.sin(((lat2 - lat1) * D) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((lon2 - lon1) * D) / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** km east and north of (clat, clon). */
export function toGridKm(clat: number, clon: number, lat: number, lon: number): [number, number] {
  const p1 = clat * D;
  const p2 = lat * D;
  const dl = (lon - clon) * D;
  const cosc = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
  const c = Math.acos(Math.max(-1, Math.min(1, cosc)));
  const az = Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
  const d = c * R_KM;
  return [d * Math.sin(az), d * Math.cos(az)];
}

/** The inverse: the [lon, lat] x km east and y km north of (clat, clon). */
export function fromGridKm(clat: number, clon: number, x: number, y: number): LngLat {
  const d = Math.hypot(x, y);
  if (d < 1e-9) return [clon, clat];
  const c = d / R_KM;
  const az = Math.atan2(x, y);
  const p1 = clat * D;
  const lat2 = Math.asin(Math.sin(p1) * Math.cos(c) + Math.cos(p1) * Math.sin(c) * Math.cos(az));
  const lon2 = clon * D + Math.atan2(Math.sin(az) * Math.sin(c) * Math.cos(p1), Math.cos(c) - Math.sin(p1) * Math.sin(lat2));
  return [(((lon2 / D + 540) % 360) - 180), lat2 / D];
}

export function ringBBox(ring: LngLat[]): BBox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lo, la] of ring) {
    if (lo < w) w = lo;
    if (lo > e) e = lo;
    if (la < s) s = la;
    if (la > n) n = la;
  }
  return [w, s, e, n];
}

export function boxRing([w, s, e, n]: BBox): LngLat[] {
  return [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
  ];
}

export function ringCenter(ring: LngLat[]): LngLat {
  const [w, s, e, n] = ringBBox(ring);
  return [(w + e) / 2, (s + n) / 2];
}

/** A square box `km` on a side around a point (a lon/lat rectangle on the map). */
export function squareAround(lon: number, lat: number, km: number): LngLat[] {
  const h = km / 2;
  const sw = fromGridKm(lat, lon, -h, -h);
  const ne = fromGridKm(lat, lon, h, h);
  return boxRing([sw[0], sw[1], ne[0], ne[1]]);
}

/** Width and height of the ring's bounding box, km (as the backend measures it). */
export function bboxKm([w, s, e, n]: BBox): { wide: number; hx: number; hy: number; clat: number; clon: number } {
  const clat = (s + n) / 2;
  const clon = (w + e) / 2;
  const hx = kmBetween(clat, w, clat, e) / 2;
  const hy = kmBetween(s, clon, n, clon) / 2;
  return { wide: 2 * Math.max(hx, hy), hx, hy, clat, clon };
}

/** Shrink a ring about its centre until its box is at most `maxKm` across. */
export function capRing(ring: LngLat[], maxKm: number): LngLat[] {
  let out = ring;
  for (let i = 0; i < 3; i++) {
    const { wide } = bboxKm(ringBBox(out));
    if (wide <= maxKm) break;
    const k = (maxKm * 0.995) / wide;
    const [cx, cy] = ringCenter(out);
    out = out.map(([lo, la]) => [cx + (lo - cx) * k, cy + (la - cy) * k] as LngLat);
  }
  return out;
}

export function translateRing(ring: LngLat[], to: LngLat): LngLat[] {
  const [cx, cy] = ringCenter(ring);
  return ring.map(([lo, la]) => [lo + to[0] - cx, la + to[1] - cy] as LngLat);
}

export interface SiteSpot {
  id: string;
  icao: string;
  lat: number;
  lon: number;
}

export function siteSpot(site: string | null): SiteSpot | null {
  if (!site) return null;
  const s = useNexradStore.getState().sites.find((x) => x.id === site || x.icao === site);
  return s ? { id: s.id, icao: s.icao, lat: s.lat, lon: s.lon } : null;
}

/** km from the radar to the nearest point of the box. */
export function nearestKm(spot: SiteSpot, bbox: BBox): number {
  const { hx, hy, clat, clon } = bboxKm(bbox);
  const [rx, ry] = toGridKm(clat, clon, spot.lat, spot.lon);
  return Math.hypot(rx - Math.min(Math.max(rx, -hx), hx), ry - Math.min(Math.max(ry, -hy), hy));
}

/** Why the 3D view cannot take this selection, or null when it can. The
 *  moments asked decide the reach: velocity and the rest stop at 300 km. */
export function checkSelection(site: string | null, ring: LngLat[], fams: string[]): string | null {
  if (isTdwrId(site)) return TDWR_VOLUME_NOTE;
  if (ring.length < 3) return "Draw a box or trace an area on the map.";
  const bbox = ringBBox(ring);
  const { wide, hx, hy } = bboxKm(bbox);
  if (wide > MAX_BOX_KM + 15) return `That is ${Math.round(wide)} km across; the 3D view takes up to ${MAX_BOX_KM} km.`;
  if (2 * Math.min(hx, hy) < MIN_BOX_KM) return `Too small: draw at least ${MIN_BOX_KM} km on a side.`;
  const spot = siteSpot(site);
  if (spot) {
    const reach = Math.min(...fams.map(reachKm));
    const near = nearestKm(spot, bbox);
    if (near > reach) {
      const what = reach === 460 ? "reflectivity" : fams.includes("G") ? "velocity" : "this product";
      return `Out of ${spot.icao}'s range: its nearest edge is ${Math.round(near)} km from the radar, and ${what} reaches ${reach} km.`;
    }
  }
  return null;
}

/** Even-odd point in polygon. */
function inside(x: number, y: number, poly: [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** The area's columns only: every voxel outside the outline reads "seen,
 *  no echo", and flashes outside it go. The volume's own arrays are left
 *  alone (the caller may hold them). */
export function maskVolume(v: Volume3D, ring: LngLat[]): Volume3D {
  const h = v.header;
  const poly = ring.map(([lo, la]) => toGridKm(h.centerLat, h.centerLon, la, lo));
  const flashes = v.flashes.filter((f) => inside(f.x, f.y, poly));
  if (!v.codes.length) return { ...v, flashes };
  const { nx, ny, nz } = h;
  const plane = nx * ny;
  const out: number[] = [];
  for (let j = 0; j < ny; j++) {
    const y = -h.halfYKm + ((j + 0.5) * 2 * h.halfYKm) / ny;
    for (let i = 0; i < nx; i++) {
      const x = -h.halfXKm + ((i + 0.5) * 2 * h.halfXKm) / nx;
      if (!inside(x, y, poly)) out.push(j * nx + i);
    }
  }
  if (!out.length) return { ...v, flashes };
  const codes = new Uint8Array(v.codes);
  for (let k = 0; k < nz; k++) {
    const base = k * plane;
    for (const idx of out) codes[base + idx] = 0;
  }
  return { ...v, codes, flashes };
}

/** Ramer-Douglas-Peucker on screen points, loosened until at most `max` corners. */
export function simplify(pts: [number, number][], max = 32): [number, number][] {
  if (pts.length <= 3) return pts;
  // A traced loop ends where it began, and a chord of zero length keeps
  // nothing: split it at the point farthest from the start, simplify both
  // halves, and join them.
  let far = 1;
  let fd = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const run = (eps: number) => {
    const a = rdp(pts.slice(0, far + 1), eps);
    const b = rdp(pts.slice(far), eps);
    const out = [...a, ...b.slice(1)];
    // The loop closes by itself: a last corner on top of the first goes.
    const l = out[out.length - 1];
    if (out.length > 3 && Math.hypot(l[0] - out[0][0], l[1] - out[0][1]) < 8) out.pop();
    return out;
  };
  let eps = 2;
  let out = run(eps);
  while (out.length > max && eps < 400) {
    eps *= 1.5;
    out = run(eps);
  }
  return out;
}

function rdp(seg: [number, number][], eps: number): [number, number][] {
  if (seg.length <= 2) return seg;
  const keep = new Uint8Array(seg.length);
  keep[0] = keep[seg.length - 1] = 1;
  const stack: [number, number][] = [[0, seg.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = seg[a];
    const [bx, by] = seg[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let best = -1;
    let far = 0;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - seg[i][1]) - (ax - seg[i][0]) * (by - ay)) / len;
      if (d > far) {
        far = d;
        best = i;
      }
    }
    if (best > 0 && far > eps) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return seg.filter((_, i) => keep[i]);
}

/** The radar frame on screen, as the 3D view asks for it: the newest live
 *  frame is "the newest whole volume", older frames their own time and key. */
export function currentFrame(): { at: number | null; key: string } {
  const s = useNexradStore.getState();
  const scans = s.scans;
  if (!scans.length) return { at: null, key: "" };
  const i = Math.min(s.index, scans.length - 1);
  const scan = scans[i];
  const live = s.archiveTime === null && s.archiveDate === null;
  if (live && i >= scans.length - 1) return { at: null, key: "" };
  return { at: scan?.time ?? null, key: scan?.key?.startsWith("L2") ? scan.key : "" };
}
