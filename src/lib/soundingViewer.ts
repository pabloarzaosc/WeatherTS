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

export function num(v: ParamValue | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
