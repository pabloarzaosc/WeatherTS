// Client for the aviation products (backend /api/aviation, see backend/aviation.py)
// and the arithmetic a pilot does with them: wind components on each runway,
// pressure and density altitude, the sun's times, and the colours and words
// every aviation layer shares.

import { BACKEND_BASE as BASE } from "./apiConfig";
import type { FlightCategory } from "./metar";

async function get<T>(path: string, params: Record<string, string | number> = {}, signal?: AbortSignal): Promise<T> {
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${BASE}/api/aviation/${path}${q.size ? `?${q}` : ""}`, { signal });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      /* the status says enough */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export type AvnCollection = GeoJSON.FeatureCollection & { at?: number; heights?: number[]; valid?: string; use?: string };

export const fetchAvn = (path: string, params?: Record<string, string | number>, signal?: AbortSignal) =>
  get<AvnCollection>(path, params, signal);

// ---------------------------------------------------------------------------
// One airport
// ---------------------------------------------------------------------------
export interface CloudLayerAvn {
  cover: string;
  base: number | null;
  type?: string | null;
}

export interface AvnMetar {
  t: number;
  type: string | null;
  temp: number | null;
  dewp: number | null;
  wdir: number | string | null;
  wspd: number | null;
  wgst: number | null;
  vis: number | null;
  visRaw: string | number | null;
  altim: number | null;
  slp: number | null;
  clouds: CloudLayerAvn[];
  ceil: number | null;
  cat: FlightCategory | null;
  wx: string | null;
  precip: number | null;
  pcp3: number | null;
  pcp6: number | null;
  maxT: number | null;
  minT: number | null;
  presTend: number | null;
  pcp24?: number | null;
  snow?: number | null;
  vv?: number | null;
  maxT24?: number | null;
  minT24?: number | null;
  raw: string | null;
}

export interface TafState {
  from: number;
  to: number;
  wdir: number | string | null;
  wspd: number | null;
  wgst: number | null;
  vis: number | null;
  visRaw: string | number | null;
  wx: string | null;
  clouds: CloudLayerAvn[];
  vv: number | null;
  ceil: number | null;
  shear: { hgt: number | null; dir: number | null; spd: number | null } | null;
  /** QNH the TAF forecasts (hPa): military and some foreign TAFs give one. */
  altim?: number | null;
  /** Icing (6-group) and turbulence (5-group) layers. */
  icgTurb?: { kind: "ice" | "turb"; intensity: number | string | null; lo: number | null; hi: number | null }[];
  cat: FlightCategory | null;
}

export interface TafTemporary extends TafState {
  kind: string;
}

export interface TafPeriod extends TafState {
  bec: number | null;
  change: string | null;
  prob: number | null;
  notDecoded?: string | null;
}

export interface AvnTaf {
  id: string;
  issue: number | null;
  from: number | null;
  to: number | null;
  raw: string | null;
  remarks: string | null;
  /** TX/TN: the forecast maximum and minimum temperatures, with their times. */
  temps?: { t: number; temp: number | null; kind: "MAX" | "MIN" | null }[];
  periods: TafPeriod[];
  segments: TafState[];
  temporary: TafTemporary[];
}

export interface RunwayEnd {
  name: string;
  mag: number;
  true: number;
  /** The threshold, where OurAirports has it placed. */
  lat?: number | null;
  lon?: number | null;
  elevFt?: number | null;
  displacedFt?: number | null;
}

export interface Runway {
  id: string;
  ends: RunwayEnd[];
  length: number | null;
  width: number | null;
  surface: string | null;
  alignment: number | null;
  lighted?: boolean;
  closed?: boolean;
}

export interface AirportInfo {
  icao: string;
  ident?: string;
  iata: string | null;
  faa?: string | null;
  local?: string | null;
  name: string;
  awcName?: string | null;
  type?: string | null;
  typeWord?: string | null;
  lat: number;
  lon: number;
  elevFt: number | null;
  state: string | null;
  country: string | null;
  countryName?: string | null;
  region?: string | null;
  municipality?: string | null;
  scheduled?: boolean;
  wiki?: string | null;
  home?: string | null;
  magdec: string | null;
  /** East positive, degrees. */
  declination?: number | null;
  declinationSource?: "AWC" | "navaid" | null;
  tower?: boolean;
  passengers?: number | null;
  runways: Runway[];
  freqs: { type?: string; name: string; mhz: string }[];
}

export interface Navaid {
  ident: string;
  name: string;
  type: string;
  freq: string | null;
  dme: string | null;
  nm: number;
  brgTrue: number;
  brgMag: number | null;
  elevFt: number | null;
  power: string | null;
  usage: string | null;
}

export interface NearbyAirport {
  icao: string;
  name: string | null;
  nm: number;
  brg: number;
  cat: FlightCategory | null;
  ceil: number | null;
  vis: number | null;
  wdir: number | string | null;
  wspd: number | null;
  wgst: number | null;
  wx: string | null;
  temp: number | null;
  obs: number | null;
  raw: string | null;
}

export interface Fir {
  id: string;
  name: string;
  oceanic: boolean;
  region?: string | null;
}

/** One level of the model profile over the airport, one value per hour. */
export interface ProfileLevel {
  p: number;
  ft: (number | null)[];
  t: (number | null)[];
  rh: (number | null)[];
  spd: (number | null)[];
  dir: (number | null)[];
  cc: (number | null)[];
}

export interface ProfileLayer {
  base: number;
  top: number;
  risk: number;
  shear?: number;
  ri?: number | null;
}

export interface AloftProfile {
  model: "gfs" | "ecmwf" | "icon";
  modelLabel: string;
  lat: number;
  lon: number;
  gridElevFt: number;
  groundFt: number;
  times: number[];
  levels: ProfileLevel[];
  surface: Record<string, (number | null)[]>;
  turbulence: ProfileLayer[][];
  icing: ProfileLayer[][];
  tropopause: (number | null)[];
  freezing: (number | null)[];
  fb: { lead: number; t: number; levels: Record<string, AloftLevel> }[];
  heights: number[];
}

export interface PirepProps {
  type: string;
  urgent: boolean;
  t: number | null;
  alt: number | null;
  ac: string | null;
  kind: "turb" | "ice" | "other";
  turb: number;
  ice: number;
  level: number;
  turbs: { int: string; type: string; base: number | null; top: number | null; freq: string }[];
  ices: { int: string; type: string; base: number | null; top: number | null }[];
  skies: { cover: string; base: number | null; top: number | null }[];
  wx: string | null;
  vis: number | null;
  temp: number | null;
  wdir: number | null;
  wspd: number | null;
  raw: string;
  nm?: number;
}

export interface AloftLevel {
  dir: number | null;
  spd: number;
  temp: number | null;
  lv: boolean;
}

export interface AloftStation {
  id: string;
  name: string | null;
  nm: number;
  levels: Record<string, AloftLevel>;
  valid?: string;
  use?: string;
}

export interface Advisory {
  kind: "sigmet" | "gairmet" | "cwa" | "tfr";
  hazard?: string;
  [k: string]: unknown;
}

export interface AirportData {
  info: AirportInfo;
  metars: AvnMetar[];
  taf: AvnTaf | null;
  pireps: PirepProps[];
  advisories: Advisory[];
  aloft: Record<string, AloftStation>;
  profile: AloftProfile | null;
  fir: Fir | null;
  navaids: Navaid[];
  nearby: NearbyAirport[];
  hours: number;
  errors?: Record<string, string>;
}

export type ProfileModel = "gfs" | "ecmwf" | "icon";

export const fetchAirport = (icao: string, hours: number, model: ProfileModel = "gfs", signal?: AbortSignal) =>
  get<AirportData>("airport", { icao, hours, model }, signal);

export interface AirportHit {
  icao: string;
  iata: string | null;
  faa: string | null;
  name: string | null;
  municipality?: string | null;
  state: string | null;
  country: string | null;
  type?: string | null;
  lat: number | null;
  lon: number | null;
  cat: FlightCategory | null;
  reporting?: boolean;
}

export async function searchAirports(q: string, signal?: AbortSignal): Promise<AirportHit[]> {
  return (await get<{ airports: AirportHit[] }>("search", { q }, signal)).airports;
}

// ---------------------------------------------------------------------------
// Colours and words
// ---------------------------------------------------------------------------
/** SIGMET, AIRMET and CWA hazards: one colour per kind of trouble. */
export const HAZARD_COLOR: Record<string, string> = {
  CONVECTIVE: "#ef4444",
  TS: "#ef4444",
  TURB: "#f59e0b",
  "TURB-HI": "#d97706",
  "TURB-LO": "#fbbf24",
  ICE: "#38bdf8",
  ICING: "#38bdf8",
  IFR: "#a78bfa",
  MT_OBSC: "#f472b6",
  "MTN OBSCN": "#f472b6",
  LLWS: "#fb7185",
  SFC_WND: "#22d3ee",
  FZLVL: "#60a5fa",
  M_FZLVL: "#93c5fd",
  VA: "#a8a29e",
  TC: "#e879f9",
  DS: "#d6b26e",
  SS: "#d6b26e",
  RDOACT: "#facc15",
  "RDOACT CLD": "#facc15",
  MTW: "#f97316",
};
export const HAZARD_FALLBACK = "#94a3b8";

export const HAZARD_LABEL: Record<string, string> = {
  CONVECTIVE: "Convective",
  TS: "Thunderstorms",
  TURB: "Turbulence",
  "TURB-HI": "Turbulence (high)",
  "TURB-LO": "Turbulence (low)",
  ICE: "Icing",
  IFR: "IFR",
  MT_OBSC: "Mountain obscuration",
  "MTN OBSCN": "Mountain obscuration",
  LLWS: "Low-level wind shear",
  SFC_WND: "Strong surface wind",
  FZLVL: "Freezing level",
  M_FZLVL: "Multiple freezing levels",
  VA: "Volcanic ash",
  TC: "Tropical cyclone",
  DS: "Duststorm",
  SS: "Sandstorm",
  RDOACT: "Radioactive cloud",
  "RDOACT CLD": "Radioactive cloud",
  MTW: "Mountain waves",
};

export const hazardLabel = (h: string | null | undefined) => (h ? HAZARD_LABEL[h] ?? h : "Hazard");

/** PIREP intensity: none, light, moderate, severe, extreme. */
export const INTENSITY_COLOR = ["#94a3b8", "#facc15", "#f59e0b", "#ef4444", "#a855f7"];
export const INTENSITY_LABEL = ["None", "Light", "Moderate", "Severe", "Extreme"];

/** MapLibre colour for a hazard property, with the fallback for the rest. */
export function hazardColorExpr(prop = "hazard"): unknown {
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(HAZARD_COLOR)) pairs.push(k, v);
  return ["match", ["get", prop], ...pairs, HAZARD_FALLBACK];
}

// ---------------------------------------------------------------------------
// A pilot's arithmetic
// ---------------------------------------------------------------------------
const RAD = Math.PI / 180;

/** Headwind (+) / tailwind (-) and crosswind (+ from the right) on a runway. */
export function windComponents(windFrom: number, speed: number, runwayTrue: number): { head: number; cross: number } {
  const a = (windFrom - runwayTrue) * RAD;
  return { head: speed * Math.cos(a), cross: speed * Math.sin(a) };
}

/** The runway end facing most into the wind. */
export function bestEnd(runways: Runway[], windFrom: number | null, speed: number | null): RunwayEnd | null {
  if (windFrom == null || speed == null || !runways.length) return null;
  let best: RunwayEnd | null = null;
  let most = -Infinity;
  for (const r of runways) {
    for (const e of r.ends) {
      const { head } = windComponents(windFrom, speed, e.true);
      if (head > most) {
        most = head;
        best = e;
      }
    }
  }
  return best;
}

/** Pressure altitude (ft) from field elevation (ft) and QNH (hPa). */
export function pressureAltitude(elevFt: number, qnhHpa: number): number {
  return elevFt + 145366.45 * (1 - Math.pow(qnhHpa / 1013.25, 0.190284));
}

/** Density altitude (ft): the pressure altitude, plus 120 ft for every degree
 *  the air is warmer than the standard atmosphere there (the E6B rule). */
export function densityAltitude(elevFt: number, qnhHpa: number, tempC: number): number {
  const pa = pressureAltitude(elevFt, qnhHpa);
  const isa = 15 - 1.98 * (pa / 1000);
  return pa + 118.8 * (tempC - isa);
}

export const hpaToInHg = (hpa: number) => hpa / 33.8639;

/** Whether an airport reports in American units (inHg, statute miles): the
 *  US, its territories, and the few others that follow its METAR practice. */
export const usesInHg = (icao: string, raw?: string | null): boolean => {
  if (raw && / A\d{4}( |$)/.test(raw)) return true;
  if (raw && / Q\d{4}( |$)/.test(raw)) return false;
  return /^(K|P[AFHGJKMOPW]|TJ|TI)/.test(icao);
};

export function relHumidity(tempC: number, dewC: number): number {
  const es = (t: number) => 6.112 * Math.exp((17.67 * t) / (t + 243.5));
  return Math.max(0, Math.min(100, (100 * es(dewC)) / es(tempC)));
}

/**
 * Sunrise, sunset and civil twilight for a day at a place (NOAA's solar
 * equations): unix seconds, or null where the sun does not rise or set.
 */
export function sunTimes(lat: number, lon: number, day: Date): Record<"dawn" | "rise" | "set" | "dusk", number | null> {
  const start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) / 1000;
  const jd = start / 86400 + 2440587.5;
  const n = jd - 2451545.0 + 0.0008;
  const jStar = n - lon / 360;
  const m = (357.5291 + 0.98560028 * jStar) % 360;
  const c = 1.9148 * Math.sin(m * RAD) + 0.02 * Math.sin(2 * m * RAD) + 0.0003 * Math.sin(3 * m * RAD);
  const lambda = (m + c + 180 + 102.9372) % 360;
  const transit = 2451545.0 + jStar + 0.0053 * Math.sin(m * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
  const dec = Math.asin(Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD));
  const at = (alt: number) => {
    const cosH =
      (Math.sin(alt * RAD) - Math.sin(lat * RAD) * Math.sin(dec)) / (Math.cos(lat * RAD) * Math.cos(dec));
    if (cosH < -1 || cosH > 1) return null;
    const h = Math.acos(cosH) / RAD;
    return [transit - h / 360, transit + h / 360].map((j) => Math.round((j - 2440587.5) * 86400));
  };
  const sun = at(-0.833);
  const civil = at(-6);
  return { dawn: civil?.[0] ?? null, rise: sun?.[0] ?? null, set: sun?.[1] ?? null, dusk: civil?.[1] ?? null };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
export function fmtVis(sm: number | null | undefined, raw?: string | number | null): string {
  if (sm == null) return "—";
  if (typeof raw === "string" && raw.endsWith("+")) return `${raw.replace("+", "")}+ SM`;
  if (sm >= 10) return "10+ SM";
  if (sm < 1) {
    const q = Math.round(sm * 16) / 16;
    const frac: Record<number, string> = { 0.0625: "1/16", 0.125: "1/8", 0.25: "1/4", 0.375: "3/8", 0.5: "1/2", 0.625: "5/8", 0.75: "3/4", 0.875: "7/8" };
    return `${frac[q] ?? q.toFixed(2)} SM`;
  }
  return `${Number.isInteger(sm) ? sm : sm.toFixed(1)} SM`;
}

/** Visibility as a metric METAR gives it: metres, or kilometres from 5 km. */
export function fmtVisMetric(sm: number | null | undefined, raw?: string | number | null): string {
  if (sm == null) return "—";
  if (typeof raw === "string" && raw.endsWith("+") && sm >= 6) return "10+ km";
  const m = sm * 1609.344;
  if (m >= 9999) return "10+ km";
  if (m >= 5000) return `${Math.round(m / 1000)} km`;
  return `${Math.round(m / 50) * 50} m`;
}

export function fmtFt(ft: number | null | undefined): string {
  return ft == null ? "—" : `${Math.round(ft).toLocaleString("en-US")} ft`;
}

export function fmtWind(dir: number | string | null | undefined, spd: number | null | undefined, gst?: number | null): string {
  if (spd == null) return "—";
  if (spd === 0) return "Calm";
  const d = dir === "VRB" || dir == null ? "VRB" : `${String(Math.round(Number(dir))).padStart(3, "0")}°`;
  return `${d} ${Math.round(spd)} kt${gst ? ` G${Math.round(gst)}` : ""}`;
}

export const zClock = (unix: number) => `${new Date(unix * 1000).toISOString().slice(11, 16)}Z`;
export const zDayClock = (unix: number) => {
  const d = new Date(unix * 1000);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${d.toISOString().slice(11, 16)}Z`;
};

/** A level for people: "FL350" up high, "8,000 ft" lower down, "SFC". */
export function fmtLevel(v: unknown): string {
  if (v == null || v === "") return "—";
  const s = String(v).toUpperCase();
  if (s === "SFC" || s === "FZL") return s;
  const n = Number(v);
  if (!Number.isFinite(n)) return s;
  // The G-AIRMET's own levels are hundreds of feet ("180" is FL180).
  const ft = n < 1000 ? n * 100 : n;
  return ft >= 18000 ? `FL${Math.round(ft / 100)}` : `${Math.round(ft).toLocaleString("en-US")} ft`;
}
