// Client for the surface-obs endpoint: the airports' METARs (Aviation Weather
// Center) and, beside them, the WMO synoptic stations, INMET's automatic
// network (with the user's token) and NOAA MADIS's mesonets and personal
// stations -- see backend/station_networks.py.

import { BACKEND_BASE } from './apiConfig';
const BASE = BACKEND_BASE;

/** Where a station's report comes from: an airport's METAR, a WMO synoptic
 *  report, INMET's automatic network, or a mesonet / personal station. Only a
 *  METAR has a flight category and a report text. */
export type StationKind = "metar" | "synop" | "inmet" | "mesonet";

export interface SurfaceObsProps {
  id: string | null;
  name: string | null;
  kind?: StationKind;
  /** The network: "METAR", "SYNOP", "INMET", or a MADIS provider (APRSWXNET...). */
  network?: string;
  /** Sea-level pressure, where the station gives or allows it (mb). */
  mslp?: number | null;
  /** Precipitation (mm) over `precipHours`: an airport's since its last
   *  hourly report, a mesonet's and INMET's in the last hour, a synoptic
   *  station's over the period its report gives (often 6 or 12 h). */
  precip?: number | null;
  precipHours?: number | null;
  /** An airport's P0000: some fell, too little to measure. */
  precipTrace?: boolean;
  /** A synoptic station's present weather as METAR letters (TSGR, +SHRA). */
  wxCode?: string | null;
  /** Max and min temperature (C): of the last 24 h, or of the hour for INMET. */
  tmax?: number | null;
  tmin?: number | null;
  /** SYNOP total cloud, eighths. */
  oktas?: number | null;
  elev?: number | null;
  temp: number | null; // C
  dewp: number | null; // C
  wdir: number | null; // deg
  wspd: number | null; // kt
  wgst: number | null; // kt
  altim: number | null; // mb
  visib: number | null; // sm
  cover: string | null;
  /** Reported layers, lowest first. The single `cover` is only the densest. */
  clouds: { cover: string; base: number | null }[] | null;
  /** Present weather as reported (rain, fog, thunder...), null when clear. */
  wx: string | null;
  /** The untouched METAR text everything else here was decoded from. */
  raw: string | null;
  rh: number | null;
  thetae: number | null;
  obsTime: number | null;
}

export type SurfaceObsFC = GeoJSON.FeatureCollection<GeoJSON.Point, SurfaceObsProps> & {
  /** A network still being read for the first time (or for a past instant). */
  pending?: boolean;
  /** The instant these are the reports of (unix s); null is now. */
  at?: number | null;
  /** Networks that keep nothing for `at`: shown as absent, not as today's. */
  unavailable?: string[];
};

export async function fetchSurfaceObs(
  bbox: [number, number, number, number], // lat0, lon0, lat1, lon1
  signal?: AbortSignal,
  opts: { cell?: number; networks?: string[]; at?: number | null } = {},
): Promise<SurfaceObsFC> {
  const s = bbox.map((n) => n.toFixed(2)).join(",");
  const q = new URLSearchParams({ bbox: s });
  // One station per cell of this size (degrees): the backend thins the
  // mesonets before sending -- 32,000 across the US.
  if (opts.cell && opts.cell > 0) q.set("cell", opts.cell.toFixed(4));
  if (opts.networks) q.set("networks", opts.networks.join(","));
  // The reports in force at a past instant, as the timeline shows one.
  if (opts.at != null) q.set("at", String(Math.round(opts.at)));
  const res = await fetch(`${BASE}/api/surface-obs?${q}`, { signal });
  if (!res.ok) throw new Error(`surface-obs ${res.status}`);
  return res.json();
}

export interface StationNetworksStatus {
  synop: { stations: number; updated: number | null };
  mesonet: { stations: number; updated: number | null };
  inmet: { configured: boolean; stations: number; hour: string | null; error: string | null };
}

export async function fetchStationNetworks(signal?: AbortSignal): Promise<StationNetworksStatus> {
  const res = await fetch(`${BASE}/api/stations/networks`, { signal });
  if (!res.ok) throw new Error(`networks ${res.status}`);
  return res.json();
}

/** Keep the user's INMET token on this machine (empty clears it). */
export async function saveInmetToken(token: string): Promise<StationNetworksStatus> {
  const res = await fetch(`${BASE}/api/stations/inmet-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(`inmet token ${res.status}`);
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
  /** Reported layers, lowest first. The single `cover` is only the densest. */
  clouds: { cover: string; base: number | null }[] | null;
  /** Present weather as reported (rain, fog, thunder...), null when clear. */
  wx: string | null;
  /** The untouched METAR text everything else here was decoded from. */
  raw: string | null;
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
