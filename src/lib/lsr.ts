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
): Promise<LsrCollection> {
  const url =
    `${BASE}/api/lsr?hours=${hours}` + (endUnix != null ? `&end=${Math.round(endUnix)}` : "");
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
