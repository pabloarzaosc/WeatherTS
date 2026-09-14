// Client for the satellite catalogue (backend /api/sat). The backend only says
// which satellites and times exist; the map fetches the tiles straight from
// NASA GIBS, NOAA nowCOAST and EUMETSAT EUMETView. See backend/satellite.py.

import { BACKEND_BASE as BASE } from "./apiConfig";

export interface SatSatellite {
  id: string;
  label: string;
  /** "GOES-19 ABI · 10 min". */
  detail: string;
  /** Picker heading: Americas, Europe & Africa, Polar orbit. */
  region: string;
  /** Where to fly to see the whole of what it covers. */
  view: { center: [number, number]; zoom: number };
}

export interface SatProduct {
  id: string;
  sat: string;
  label: string;
  /** Picker sub-heading: Visible, Infrared, Water Vapor, RGB... */
  kind: string;
  note: string;
  provider: string;
  /** Tile URL with `{time}` still to fill; MapLibre fills the rest. */
  tiles: string;
  tileSize: number;
  maxzoom: number;
  /** One picture a day (polar orbiters) rather than a loop of minutes. */
  daily: boolean;
  attribution: string;
}

export interface SatCatalog {
  satellites: SatSatellite[];
  products: SatProduct[];
  defaultProduct: string;
}

export interface SatFrame {
  /** The time exactly as the tile URL wants it. */
  time: string;
  unix: number;
  label: string;
}

export interface SatFrames {
  product: string;
  frames: SatFrame[];
  latest: number | null;
  /** The loop asked for was empty, so these are the last frames there are. */
  stale: boolean;
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

export async function fetchSatFrames(product: string, hours: number, signal?: AbortSignal): Promise<SatFrames> {
  const q = new URLSearchParams({ product, hours: String(hours) });
  const res = await fetch(`${BASE}/api/sat/frames?${q}`, { signal });
  if (!res.ok) throw new Error(await detail(res));
  return res.json();
}

/** The tile template for one frame. */
export function satTiles(product: SatProduct, frame: SatFrame): string {
  return product.tiles.replace("{time}", frame.time);
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

/** One frame for a box, served by the backend from its loop cache. A 204 from
 *  it means the provider lists the time but has not published the picture. */
export function satImageUrl(product: string, time: string, box: SatBox): string {
  const q = new URLSearchParams({
    product,
    time,
    west: box.west.toFixed(4),
    south: box.south.toFixed(4),
    east: box.east.toFixed(4),
    north: box.north.toFixed(4),
    width: String(box.width),
    height: String(box.height),
  });
  return `${BASE}/api/sat/image?${q}`;
}

/** Ask the backend to start fetching a whole loop, in the order given. */
/** Drop the frames still queued for the loop being loaded. */
export async function cancelSatLoop(): Promise<void> {
  await fetch(`${BASE}/api/sat/cancel`, { method: "POST" });
}

export async function prefetchSatLoop(product: string, times: string[], box: SatBox): Promise<void> {
  await fetch(`${BASE}/api/sat/prefetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ product, times, ...box }),
  });
}
