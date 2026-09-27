// Client for the satellite catalogue and pictures (backend /api/sat, see
// backend/satellite.py). The backend reads each product from wherever it is
// cheapest -- NOAA's GOES and Himawari files on AWS, RAMMB/CIRA SLIDER, EUMETSAT
// EUMETView, NASA GIBS -- and answers every frame as a Web Mercator picture of
// the box asked for, so the map lays it straight over its own tiles.

import { BACKEND_BASE as BASE } from "./apiConfig";

export interface SatLegend {
  units: string;
  /** Colour ramp: [value, "#rrggbb"], low to high. */
  stops?: [number, string][];
  /** Categories: [label, "#rrggbb"]. */
  categories?: [string, string][];
  log?: boolean;
}

export interface SatProduct {
  id: string;
  label: string;
  /** VISIBLE, NEAR_IR, IR, RGB_DAY, RGB_ALL, RGB_NIGHT, RGB_SPECIALTY, L2_*... */
  group: string;
  note: string;
  source: string;
  legend: SatLegend | null;
}

export interface SatRegion {
  id: string;
  label: string;
  /** sector (the imager's own scan), region (a part of the full disk), disk, global. */
  kind: string;
  /** Seconds between scans. */
  cadence: number;
  note: string;
  /** [west, south, east, north]; null for the boxes that move (GOES mesoscale, Himawari target). */
  bounds: [number, number, number, number] | null;
  products: SatProduct[];
}

export interface SatSatellite {
  id: string;
  label: string;
  /** USA, JPSS, Asia Pacific, Europe & Africa, Metop. */
  group: string;
  /** "GOES-19 · 75.2°W". */
  detail: string;
  note: string;
  regions: SatRegion[];
}

export interface SatCatalog {
  groups: { label: string; satellites: string[] }[];
  productGroups: { id: string; label: string }[];
  satellites: SatSatellite[];
  default: { sat: string; region: string; product: string };
}

export interface SatFrame {
  /** ISO time, exactly as the picture URL wants it. */
  time: string;
  unix: number;
}

export interface SatFrames {
  frames: SatFrame[];
  /** Where the region is now ([west, south, east, north]); the moving boxes too. */
  bounds: [number, number, number, number] | null;
}

async function detail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.detail === "string") return body.detail;
  } catch {
    /* fall through to the status code */
  }
  return `HTTP ${res.status}`;
}

export async function fetchSatCatalog(signal?: AbortSignal): Promise<SatCatalog> {
  const res = await fetch(`${BASE}/api/sat/catalog`, { signal });
  if (!res.ok) throw new Error(await detail(res));
  return res.json();
}

export async function fetchSatFrames(
  sat: string,
  region: string,
  product: string,
  count: number,
  signal?: AbortSignal,
): Promise<SatFrames> {
  const q = new URLSearchParams({ sat, region, product, count: String(count) });
  const res = await fetch(`${BASE}/api/sat/frames?${q}`, { signal });
  if (!res.ok) throw new Error(await detail(res));
  return res.json();
}

/** A box on the map and the picture size to draw it at. */
export interface SatBox {
  west: number;
  south: number;
  east: number;
  north: number;
  width: number;
  height: number;
}

export interface SatSelection {
  sat: string;
  region: string;
  product: string;
}

/** One frame for a box. A 204 means the source lists the time but has no picture. */
/**
 * "coarse" asks for a quick picture from one tile level down -- a quarter of
 * the bytes on sources that top out near 14 Mbit/s here -- which the sharp one
 * then replaces. The answer's X-Sat-Detail says which of the two came (the
 * sharp one, when it was made already or nothing quicker exists).
 */
export type SatDetail = "coarse" | "full";

export function satImageUrl(sel: SatSelection, time: string, box: SatBox, detail: SatDetail = "full"): string {
  const q = new URLSearchParams({
    sat: sel.sat,
    region: sel.region,
    product: sel.product,
    time,
    west: box.west.toFixed(4),
    south: box.south.toFixed(4),
    east: box.east.toFixed(4),
    north: box.north.toFixed(4),
    width: String(box.width),
    height: String(box.height),
  });
  if (detail === "coarse") q.set("detail", "coarse");
  return `${BASE}/api/sat/image?${q}`;
}

/** Drop the frames still queued for the loop being loaded. */
export async function cancelSatLoop(): Promise<void> {
  await fetch(`${BASE}/api/sat/cancel`, { method: "POST" });
}

/** Ask the backend to start making a whole loop, in the order given: every
 *  frame's quick picture first, then the sharp ones. */
export async function prefetchSatLoop(sel: SatSelection, times: string[], box: SatBox): Promise<void> {
  await fetch(`${BASE}/api/sat/prefetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...sel, times, ...box }),
  });
}
