// Client for the surface-obs (METAR) endpoint. Proxied through the sounding
// backend (:8787) which fetches the Aviation Weather Center API.

import { BACKEND_BASE } from './apiConfig';
const BASE = BACKEND_BASE;

export interface SurfaceObsProps {
  id: string | null;
  name: string | null;
  temp: number | null; // C
  dewp: number | null; // C
  wdir: number | null; // deg
  wspd: number | null; // kt
  wgst: number | null; // kt
  altim: number | null; // mb
  visib: number | null; // sm
  cover: string | null;
  rh: number | null;
  thetae: number | null;
  obsTime: number | null;
}

export type SurfaceObsFC = GeoJSON.FeatureCollection<GeoJSON.Point, SurfaceObsProps>;

export async function fetchSurfaceObs(
  bbox: [number, number, number, number], // lat0, lon0, lat1, lon1
  signal?: AbortSignal,
): Promise<SurfaceObsFC> {
  const s = bbox.map((n) => n.toFixed(2)).join(",");
  const res = await fetch(`${BASE}/api/surface-obs?bbox=${s}`, { signal });
  if (!res.ok) throw new Error(`surface-obs ${res.status}`);
  return res.json();
}

export interface SurfaceObsHistory {
  lat: number;
  lon: number;
  id: string | null;
  name: string | null;
  obsTime: string | number | null;
  temp: number | null;
  dewp: number | null;
  wdir: number | null;
  wspd: number | null;
  wgst: number | null;
  altim: number | null;
  visib: number | null;
  cover: string | null;
  rh: number | null;
}

export async function fetchSurfaceHistory(station: string, hours = 24): Promise<SurfaceObsHistory[]> {
  const res = await fetch(
    `${BASE}/api/surface-obs/history?station=${encodeURIComponent(station)}&hours=${hours}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`surface-history ${res.status}`);
  return (await res.json()).observations;
}
