// Client for the Local Storm Report feed (backend /api/lsr, sourced from the
// Iowa Environmental Mesonet's aggregation of every WFO's LSR product).

import { BACKEND_BASE } from "./apiConfig";

const BASE = BACKEND_BASE;

export type LsrCategory =
  | "tornado"
  | "funnel"
  | "tstorm"
  | "hail"
  | "wind"
  | "flood"
  | "rain"
  | "snow"
  | "ice"
  | "tropical"
  | "fire"
  | "other";

export interface LsrProps {
  code: string;
  cat: LsrCategory;
  rank: number;
  /** What the office wrote, e.g. "Tstm Wnd Gst". */
  label: string;
  /** Our canonical name for the code, e.g. "Thunderstorm wind gust". */
  typeName: string;
  /** Plain-English meaning of this report type. */
  desc: string;
  /** "Measured" / "Estimated" / "Unknown", from the magnitude qualifier. */
  qualifierText: string;
  /** When the office transmitted the product (often after the event). */
  issuedUnix: number | null;
  mag: string;
  magf: number | null;
  unit: string;
  city: string;
  county: string;
  state: string;
  wfo: string;
  source: string;
  remark: string;
  unix: number;
  valid: string;
}

export interface LsrCollection {
  type: "FeatureCollection";
  features: GeoJSON.Feature<GeoJSON.Point, LsrProps>[];
  meta: {
    start: string;
    end: string;
    startUnix: number;
    endUnix: number;
    hours: number;
    count: number;
    source: string;
  };
}

/** Display colour per category. Kept here so the layer and the panel legend
 *  can never drift apart. */
export const LSR_COLORS: Record<LsrCategory, string> = {
  tornado: "#ff3b3b",
  funnel: "#ff9d3d",
  tstorm: "#f5d33d",
  hail: "#c77dff",
  wind: "#c9a227",
  flood: "#3ddc97",
  rain: "#3fa64b",
  snow: "#7fd3ff",
  ice: "#e07be0",
  tropical: "#ff7a29",
  fire: "#ff5722",
  other: "#a9b6c6",
};

export const LSR_LABELS: Record<LsrCategory, string> = {
  tornado: "Tornado / waterspout",
  funnel: "Funnel / wall cloud",
  tstorm: "Thunderstorm wind",
  hail: "Hail",
  wind: "Wind (non-storm)",
  flood: "Flood",
  rain: "Rain",
  snow: "Snow",
  ice: "Ice / cold",
  tropical: "Tropical",
  fire: "Fire / smoke",
  other: "Other",
};

/** The same, short enough for a two-column filter chip. */
export const LSR_SHORT: Record<LsrCategory, string> = {
  tornado: "Tornado",
  funnel: "Funnel / wall cld",
  tstorm: "T-storm wind",
  hail: "Hail",
  wind: "Non-storm wind",
  flood: "Flood",
  rain: "Rain",
  snow: "Snow",
  ice: "Ice / cold",
  tropical: "Tropical",
  fire: "Fire / smoke",
  other: "Other",
};

/** One entry of the backend's full type table (GET /api/lsr/types). */
export interface LsrTypeInfo {
  code: string;
  label: string;
  cat: LsrCategory;
  rank: number;
  desc: string;
}

export async function fetchLsrTypes(
  signal?: AbortSignal,
): Promise<{ categories: Array<{ id: LsrCategory; label: string }>; types: LsrTypeInfo[] }> {
  const res = await fetch(`${BASE}/api/lsr/types`, { signal });
  if (!res.ok) throw new Error(`lsr types ${res.status}`);
  return res.json();
}

/**
 * Marker SHAPE per category, the way a storm-report legend codes them: shape
 * carries the family, colour carries the category inside it. Twelve categories
 * over six shapes, so a diamond is always frozen-or-solid precipitation and a
 * triangle is always wind.
 *
 * The paths are written once, in a 24x24 box, and used by BOTH renderers: the
 * map builds them into a canvas icon with `new Path2D(d)`, and the panel drops
 * the same `d` into an <svg>. One definition, so the legend cannot drift from
 * what is actually drawn on the map.
 */
export type LsrShape = "circle" | "diamond" | "square" | "triangleUp" | "triangleDown" | "pin";

export const LSR_SHAPE_PATHS: Record<LsrShape, string> = {
  circle: "M12 3.2a8.8 8.8 0 1 0 0 17.6a8.8 8.8 0 1 0 0-17.6Z",
  diamond: "M12 2.4L21.6 12L12 21.6L2.4 12Z",
  square: "M4.2 4.2h15.6v15.6H4.2Z",
  triangleUp: "M12 3L21.4 20H2.6Z",
  triangleDown: "M12 21L2.6 4h18.8Z",
  pin: "M12 2.2c-3.8 0-6.9 3.1-6.9 6.9 0 5.1 6.9 12.7 6.9 12.7s6.9-7.6 6.9-12.7c0-3.8-3.1-6.9-6.9-6.9Z",
};

export const LSR_SHAPES: Record<LsrCategory, LsrShape> = {
  tornado: "triangleDown",
  funnel: "triangleDown",
  tstorm: "square",
  hail: "diamond",
  wind: "triangleUp",
  flood: "circle",
  rain: "circle",
  snow: "diamond",
  ice: "square",
  tropical: "diamond",
  fire: "pin",
  other: "pin",
};

export const LSR_CATEGORIES = Object.keys(LSR_LABELS) as LsrCategory[];

export async function fetchLsr(
  hours: number,
  endUnix: number | null,
  signal?: AbortSignal,
  /** Unix seconds: the window starts here instead of `hours` before the end. */
  startUnix: number | null = null,
): Promise<LsrCollection> {
  const url =
    `${BASE}/api/lsr?hours=${hours}` +
    (endUnix != null ? `&end=${Math.round(endUnix)}` : "") +
    (startUnix != null ? `&start=${Math.round(startUnix)}` : "");
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

/** "2 NE South China, Kennebec ME" — the way an LSR names its own location. */
export function lsrPlace(p: LsrProps): string {
  const bits = [p.city, [p.county, p.state].filter(Boolean).join(" ")].filter(Boolean);
  return bits.join(", ");
}

export type LsrFeature = GeoJSON.Feature<GeoJSON.Point, LsrProps>;

/** A report's identity across refreshes: the feed carries no id of its own, and
 *  the same report comes back in every window that still covers it. */
export function lsrKey(f: LsrFeature): string {
  const [lon, lat] = f.geometry.coordinates;
  return `${f.properties.unix}|${f.properties.code}|${lon}|${lat}`;
}

/** A gust in mph, whichever unit the office filed it in. */
export function lsrMph(p: LsrProps): number | null {
  if (p.magf == null) return null;
  const u = p.unit.toUpperCase();
  if (u.startsWith("KT") || u.startsWith("KNOT")) return p.magf * 1.15078;
  if (u === "MPH") return p.magf;
  return null;
}

/** A tornado's EF rating, when the office has given one ("EFU" has not). */
export function lsrEf(p: LsrProps): number | null {
  const m = /EF\s*([0-5])/i.exec(p.mag);
  return m ? Number(m[1]) : null;
}

/**
 * Where a report sits against SPC's criteria: 0 below severe, 1 severe
 * (a tornado, hail of 1" or more, a thunderstorm gust of 58 mph or more, or
 * thunderstorm wind damage), 2 significant severe (EF2 or stronger, hail of
 * 2" or more, a gust of 75 mph -- 65 kt -- or more).
 */
export type LsrSeverity = 0 | 1 | 2;

export function lsrSeverity(p: LsrProps): LsrSeverity {
  switch (p.code) {
    case "T": {
      const ef = lsrEf(p);
      return ef != null && ef >= 2 ? 2 : 1;
    }
    case "H":
    case "h":
      if (p.magf == null) return 0;
      return p.magf >= 2 ? 2 : p.magf >= 1 ? 1 : 0;
    case "G":
    case "M": {
      const mph = lsrMph(p);
      if (mph == null) return 0;
      return mph >= 75 ? 2 : mph >= 58 ? 1 : 0;
    }
    case "D":
    case "B": {
      const mph = lsrMph(p);
      return mph != null && mph >= 75 ? 2 : 1;
    }
    default:
      return 0;
  }
}

export const LSR_SEVERITY_LABELS: Record<LsrSeverity, string> = {
  0: "",
  1: "Severe",
  2: "Significant severe",
};

/** For "strongest first": severity, then how serious the type is, then size. */
export function lsrStrength(p: LsrProps): number {
  return lsrSeverity(p) * 1e6 + p.rank * 1e3 + Math.min(999, lsrMph(p) ?? (p.magf ?? 0) * 10);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-09-23 22:36Z". */
export function lsrUtc(unix: number | null): string {
  if (!unix) return "--";
  const d = new Date(unix * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

/** "22:36Z". */
export function lsrHm(unix: number): string {
  const d = new Date(unix * 1000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

/** One report as a line of text, the way a chaser pastes it into a chat. */
export function lsrText(f: LsrFeature): string {
  const p = f.properties;
  const [lon, lat] = f.geometry.coordinates;
  const what = `${p.typeName || p.label}${p.mag ? ` ${p.mag}` : ""}${p.qualifierText ? ` (${p.qualifierText.toLowerCase()})` : ""}`;
  const who = [p.source, p.wfo ? `NWS ${p.wfo}` : ""].filter(Boolean).join(", ");
  const line = [what, lsrPlace(p), lsrUtc(p.unix), `${lat.toFixed(3)}, ${lon.toFixed(3)}`, who]
    .filter(Boolean)
    .join(" · ");
  return p.remark ? `${line}\n${p.remark}` : line;
}

function csvCell(v: string | number | null): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The reports as CSV, one row each, in the order given. */
export function lsrCsv(features: LsrFeature[]): string {
  const head = [
    "time_utc", "type", "code", "magnitude", "value", "unit", "qualifier", "severity",
    "city", "county", "state", "lat", "lon", "wfo", "source", "remark",
  ];
  const rows = features.map((f) => {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    return [
      p.valid, p.typeName || p.label, p.code, p.mag, p.magf, p.unit, p.qualifierText,
      LSR_SEVERITY_LABELS[lsrSeverity(p)], p.city, p.county, p.state, lat, lon, p.wfo,
      p.source, p.remark,
    ].map(csvCell).join(",");
  });
  return [head.join(","), ...rows].join("\r\n") + "\r\n";
}

/** The reports as a GeoJSON file of their own. */
export function lsrGeoJson(features: LsrFeature[], meta: Record<string, unknown>): string {
  return JSON.stringify({ type: "FeatureCollection", features, meta });
}

/** Great-circle distance, km. */
export function distanceKm(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}
