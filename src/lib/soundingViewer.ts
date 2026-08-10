// Client for the SHARPpy sounding backend (see /backend). The Vite dev server
// proxies /sounding-backend/* to the Python service on :8787.

import { BACKEND_BASE } from './apiConfig';
const BASE = BACKEND_BASE;

export interface SoundingLevel {
  p: number; // pressure (hPa)
  h: number; // geopotential height MSL (m)
  t: number; // temperature (C)
  td: number; // dewpoint (C)
  wd: number; // wind direction (deg)
  ws: number; // wind speed (kt)
}

export type ParamValue = number | Array<number | null> | null;

/** [south, west, north, east] — the rectangle dragged on the map. */
export type AreaBox = [number, number, number, number];

export interface AreaMeta {
  bbox: AreaBox;
  widthKm: number;
  heightKm: number;
  side: number;
  requested: number;
  used: number;
  points: [number, number][]; // lon/lat of every sampled grid point
}

export interface SoundingMeta {
  lat: number;
  lon: number;
  model: string;
  requestedModel?: string;
  modelLabel: string;
  requestedModelLabel?: string;
  modelGroup?: string;
  openMeteoModel?: string;
  fallbackReason?: string | null;
  hour: number;
  requestedHour?: number;
  forecastMaxHour?: number;
  validHours?: number[];
  elevation: number;
  validUnix: number | null;
  times: number[]; // unix seconds for each forecast step
  nTimes: number;
  source: string;
  /** Present only on an area-averaged sounding. */
  area?: AreaMeta;
  /** Present only on an aircraft (ACARS) sounding. */
  station?: string;
  stationName?: string;
  ascending?: boolean;
}

export interface SoundingData {
  meta: SoundingMeta;
  levels: SoundingLevel[];
  parcelTrace: Array<number | null> | null;
  effBotP: number | null;
  effTopP: number | null;
  params: Record<string, ParamValue>;
  image?: string | null;
  imageRenderer?: string;
  imageError?: string | null;
}

export interface ModelInfo {
  id: string;
  label: string;
  group: string;
}

export async function fetchViewerModels(): Promise<{ models: ModelInfo[]; default: string }> {
  const res = await fetch(`${BASE}/api/models`);
  if (!res.ok) throw new Error(`models ${res.status}`);
  return res.json();
}

export async function fetchViewerSounding(
  lat: number,
  lon: number,
  model: string,
  hour: number,
  signal?: AbortSignal,
): Promise<SoundingData> {
  const url = `${BASE}/api/sounding?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&model=${encodeURIComponent(
    model,
  )}&hour=${hour}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json();
}

export interface RaobStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  wmo?: string; // WMO number for the global (Wyoming) source
}

// Observed radiosonde sounding for a station at a synoptic-time index. Returns
// the SAME SoundingData shape as the model path (the viewer treats it the same).
export async function fetchRaobSounding(
  station: RaobStation,
  hour: number,
  signal?: AbortSignal,
): Promise<SoundingData> {
  const url =
    `${BASE}/api/raob?station=${encodeURIComponent(station.id)}` +
    `&name=${encodeURIComponent(station.name)}` +
    (station.wmo ? `&wmo=${encodeURIComponent(station.wmo)}` : "") +
    `&lat=${station.lat.toFixed(4)}&lon=${station.lon.toFixed(4)}&hour=${hour}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json();
}

/** Shared error unwrapping: the backend puts its reason in `detail`. */
async function readOr(res: Response): Promise<SoundingData> {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json();
}

/**
 * A sounding averaged over the rectangle drawn on the map rather than taken at
 * one grid cell. Same response shape as the point sounding, so the viewer and
 * the timeline are unchanged.
 */
export async function fetchAreaSounding(
  box: AreaBox,
  model: string,
  hour: number,
  side: number,
  signal?: AbortSignal,
): Promise<SoundingData> {
  const bbox = box.map((v) => v.toFixed(4)).join(",");
  const url =
    `${BASE}/api/sounding/area?bbox=${bbox}` +
    `&model=${encodeURIComponent(model)}&hour=${hour}&side=${side}`;
  return readOr(await fetch(url, { signal }));
}

export interface AcarsAirport {
  airport: string;
  lat: number;
  lon: number;
  elevation: number;
  latestUnix: number;
  count: number;
  ascending: boolean;
  nLevels: number;
  topPressure: number;
}

export interface AcarsProfileList {
  airports: AcarsAirport[];
  profiles: Array<Omit<AcarsAirport, "latestUnix" | "count"> & { unix: number }>;
  meta: { hours: number; count: number; airportCount: number; errors: string[]; source: string };
}

export async function fetchAcarsProfiles(
  hours = 8,
  signal?: AbortSignal,
): Promise<AcarsProfileList> {
  const res = await fetch(`${BASE}/api/acars/profiles?hours=${hours}`, { signal });
  if (!res.ok) throw new Error(`acars ${res.status}`);
  return res.json();
}

/** One aircraft ascent/descent profile, rendered like any other sounding. */
export async function fetchAcarsSounding(
  airport: string,
  unix: number | null,
  hours: number,
  signal?: AbortSignal,
): Promise<SoundingData> {
  const url =
    `${BASE}/api/acars/sounding?airport=${encodeURIComponent(airport)}&hours=${hours}` +
    (unix != null ? `&unix=${Math.round(unix)}` : "");
  return readOr(await fetch(url, { signal }));
}

export function num(v: ParamValue | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
