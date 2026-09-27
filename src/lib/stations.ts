// The ASOS/AWOS station directory and one station's history, from the backend's
// IEM proxy. The directory is fetched once per session: 2,600-odd rows is small
// enough to keep in memory and search locally, which is what makes typing in the
// station search feel instant.

import { BACKEND_BASE } from "./apiConfig";

const BASE = BACKEND_BASE;

export interface StationInfo {
  /** The id IEM knows the site by: "OKC" in the lower 48, "PANC" elsewhere. */
  id: string;
  /** The ICAO the METAR is filed under, which is what people type. */
  icao: string;
  name: string;
  state: string;
  county: string;
  wfo: string;
  lat: number;
  lon: number;
  elev: number | null;
  network: string;
  tz: string;
}

export interface StationObs {
  /** Seconds since the epoch, UTC. */
  valid: number;
  tmpf: number | null;
  dwpf: number | null;
  relh: number | null;
  feel: number | null;
  drct: number | null;
  sknt: number | null;
  gust: number | null;
  vsby: number | null;
  alti: number | null;
  mslp: number | null;
  /** Precipitation in the hour ending at this report, inches. */
  p01i: number | null;
  skies: { cover: string; base: number | null }[];
  wx: string | null;
  raw: string | null;
  ceiling: number | null;
  cover: string | null;
  cat: "VFR" | "MVFR" | "IFR" | "LIFR" | null;
  /** Filled in by the station page: sea-level pressure where the station sends
   *  it, the altimeter setting where it does not (many AWOS sites never do). */
  presMb?: number | null;
  /** From stations that are not airports (SYNOP, INMET, mesonets): rain in mm
   *  over `precipHours`, the max/min (C) over `extremesHours` (24 when absent),
   *  SYNOP's total cloud in eighths and lowest base (m), and its message. */
  precipMm?: number | null;
  precipHours?: number | null;
  tmaxC?: number | null;
  tminC?: number | null;
  extremesHours?: number | null;
  oktas?: number | null;
  cloudBaseM?: number | null;
  synop?: string | null;
}

export interface StationSeries {
  station: string;
  hours: number;
  source: string;
  updated: number;
  observations: StationObs[];
}

/** A US id gains the K it files METARs under; PANC and TJSJ already have theirs. */
function icaoOf(id: string, state: string): string {
  if (id.length !== 3) return id;
  if (state === "AK") return `P${id}`;
  if (state === "HI") return `P${id}`;
  if (state === "PR" || state === "VI") return `T${id}`;
  return `K${id}`;
}

let directoryPromise: Promise<StationInfo[]> | null = null;

export function fetchStationDirectory(force = false): Promise<StationInfo[]> {
  if (!force && directoryPromise) return directoryPromise;
  const promise = (async () => {
    const res = await fetch(`${BASE}/api/stations/directory${force ? "?refresh=true" : ""}`);
    if (!res.ok) throw new Error(`stations ${res.status}`);
    const body = (await res.json()) as { cols: string[]; rows: unknown[][] };
    const at = (name: string) => body.cols.indexOf(name);
    const [ci, cn, cs, cc, cw, cla, clo, ce, cnet, ctz] = [
      "id", "name", "state", "county", "wfo", "lat", "lon", "elev", "network", "tz",
    ].map(at);
    return body.rows.map((r): StationInfo => {
      const id = String(r[ci] ?? "");
      const state = String(r[cs] ?? "");
      return {
        id,
        icao: icaoOf(id, state),
        name: String(r[cn] ?? ""),
        state,
        county: String(r[cc] ?? ""),
        wfo: String(r[cw] ?? ""),
        lat: Number(r[cla]),
        lon: Number(r[clo]),
        elev: r[ce] == null ? null : Number(r[ce]),
        network: String(r[cnet] ?? ""),
        tz: String(r[ctz] ?? ""),
      };
    });
  })();
  directoryPromise = promise;
  promise.catch(() => {
    // A failed load must not be remembered, or the panel never recovers.
    if (directoryPromise === promise) directoryPromise = null;
  });
  return promise;
}

export async function fetchStationSeries(
  station: string,
  hours: number,
  network = "",
  signal?: AbortSignal,
): Promise<StationSeries> {
  // BACKEND_BASE is a Vite proxy path in dev, so the query is built by hand --
  // URL() has nothing to resolve a relative base against.
  const query = new URLSearchParams({ station, hours: String(hours) });
  if (network) query.set("network", network);
  const res = await fetch(`${BASE}/api/stations/series?${query}`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`station series ${res.status}`);
  return res.json();
}

/** Find a directory entry from whatever id the map or the user gave us. */
export function lookupStation(list: StationInfo[], id: string | null | undefined): StationInfo | null {
  if (!id) return null;
  const want = id.trim().toUpperCase();
  if (!want) return null;
  let bare = want;
  if (want.length === 4 && /^[KPT]/.test(want)) bare = want.slice(1);
  for (const s of list) {
    if (s.id === want || s.icao === want || s.id === bare) return s;
  }
  return null;
}

/** Great-circle distance in statute miles -- for "nearest station" ordering. */
export function distanceMi(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 7917.51 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Rank stations against a typed query. An exact id wins, then a prefix, then
 * anything the name, county or state contains -- so "okc" lands Oklahoma City
 * first and "tulsa county" still finds Tulsa.
 */
export function searchStations(list: StationInfo[], query: string, limit = 40): StationInfo[] {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const scored: { s: StationInfo; score: number }[] = [];
  for (const s of list) {
    const hay = `${s.id} ${s.icao} ${s.name} ${s.county} ${s.state}`.toUpperCase();
    if (!words.every((w) => hay.includes(w))) continue;
    let score = 40;
    if (s.id === q || s.icao === q) score = 0;
    else if (s.id.startsWith(q) || s.icao.startsWith(q)) score = 5;
    else if (s.name.toUpperCase().startsWith(q)) score = 10;
    else if (s.name.toUpperCase().includes(q)) score = 20;
    else if (`${s.county} ${s.state}`.toUpperCase().includes(q)) score = 30;
    scored.push({ s, score });
  }
  scored.sort((a, b) => a.score - b.score || a.s.name.localeCompare(b.s.name));
  return scored.slice(0, limit).map((o) => o.s);
}
