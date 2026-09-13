// Client for the surface analysis (backend /api/fronts): fronts, troughs and
// pressure centres as a series of timeline frames -- past analyses plus progs.
//
// Two sources, because only one region of the world publishes its fronts as
// data. WPC's Coded Surface Bulletin is a forecaster's hand analysis of North
// America and its oceans. Everywhere else the fronts are found automatically
// in a model -- any with 850 hPa fields, the user's pick -- the way research
// climatologies of fronts are built.

import { BACKEND_BASE } from "./apiConfig";

const BASE = BACKEND_BASE;

export type FrontKind = "cold" | "warm" | "stationary" | "occluded" | "trough";

/** Where a frame's features came from. "gfs" is the automatic source; it keeps
 *  its first name, the only model it once used, for the regions and storage
 *  that already refer to it. */
export type FrontSource = "wpc" | "gfs";

export interface FrontLineProps {
  kind: FrontKind;
  label: string;
  strength: string;
  points: number;
}

export interface CentreProps {
  kind: "high" | "low";
  symbol: "H" | "L";
  pressure: number;
  label: string;
}

/** Stamped on a feature when the regions are composed, so a click knows which
 *  analysis it came from even when that is not the timeline's own frame. */
export interface FeatureOrigin {
  source?: FrontSource;
  chart?: string;
  validUnix?: number | null;
  /** The model the automatic fronts were found in, as a label. */
  model?: string;
}

export type FrontFeature = GeoJSON.Feature<GeoJSON.Geometry, (FrontLineProps | CentreProps) & FeatureOrigin>;

export interface FrontFrame {
  id: string;
  /** "analysis" for an observed chart, "forecast" for a prog. */
  kind: "analysis" | "forecast";
  label: string;
  valid: string | null;
  validUnix: number | null;
  issuedUnix: number | null;
  counts: Record<string, number>;
  features: FrontFeature[];
}

export interface FrontsResponse {
  frames: FrontFrame[];
  meta: {
    count: number;
    analyses: number;
    forecasts: number;
    errors: string[];
    source: string;
    /** Automatic fronts only: which model, by id and label. */
    model?: string;
    modelLabel?: string;
  };
}

/** [west, south, east, north] in degrees, west < east. */
export type Box = [number, number, number, number];

export interface FrontRegion {
  id: string;
  label: string;
  /** Where its fronts can come from, the default first. Only North America has
   *  a forecaster's analysis; any region can have fronts found in a model. */
  sources: FrontSource[];
  /** Tiles that do not overlap and together cover the globe, so turning on
   *  every region is the whole world with nothing drawn twice. A region that
   *  crosses the antimeridian is two boxes. */
  boxes: Box[];
}

export const FRONT_REGIONS: FrontRegion[] = [
  // WPC's analysis reaches from the dateline across the Atlantic to about 25W,
  // so the tile is drawn round what WPC actually covers rather than round the
  // continent's coastline -- nothing a forecaster drew is cut off.
  { id: "north-america", label: "North America", sources: ["wpc", "gfs"], boxes: [[-180, 0, -20, 90]] },
  { id: "europe", label: "Europe", sources: ["gfs"], boxes: [[-20, 0, 45, 90]] },
  { id: "asia", label: "Asia", sources: ["gfs"], boxes: [[45, 0, 180, 90]] },
  { id: "south-america", label: "South America", sources: ["gfs"], boxes: [[-120, -90, -20, 0]] },
  { id: "africa", label: "Southern Africa", sources: ["gfs"], boxes: [[-20, -90, 60, 0]] },
  {
    id: "oceania",
    label: "Australia & NZ",
    sources: ["gfs"],
    boxes: [
      [60, -90, 180, 0],
      [-180, -90, -120, 0],
    ],
  },
];

export const DEFAULT_FRONT_REGIONS = ["north-america"];

/** The model the automatic fronts use until the user picks another: the grid
 *  the detector was calibrated on. */
export const DEFAULT_FRONTS_MODEL = "gfs-0p50";

/** Tile size of a model footprint (backend/model_footprints.py). */
const FOOTPRINT_TILE = 5;

/** The share of a model's domain, by area, that lies inside a region. The
 *  region edges fall on whole tiles, so each tile is in one region or none. */
export function shareInside(footprint: [number, number][], region: FrontRegion): number {
  let total = 0;
  let inside = 0;
  for (const [lon, lat] of footprint) {
    const cLon = lon + FOOTPRINT_TILE / 2;
    const cLat = lat + FOOTPRINT_TILE / 2;
    const area = Math.cos((cLat * Math.PI) / 180);
    total += area;
    if (region.boxes.some((b) => cLon >= b[0] && cLon < b[2] && cLat >= b[1] && cLat < b[3])) inside += area;
  }
  return total > 0 ? inside / total : 0;
}

/**
 * Whether a model is offered for a region: a global one (no footprint) always,
 * a regional one when at least a third of its domain lies there. Merely
 * touching is not enough. Measured shares that must stay out: ICON-EU's strip
 * east of 45E is 22% of it, and CAPS's grid over the pole puts 26% of the
 * Canadian Arctic model in "Asia".
 */
export function modelServesRegion(footprint: [number, number][] | null, region: FrontRegion): boolean {
  return footprint == null || shareInside(footprint, region) >= 1 / 3;
}

export const SOURCE_LABELS: Record<FrontSource, string> = {
  wpc: "WPC forecasters' analysis",
  gfs: "found automatically in a model",
};

/** Analysis colours, the same ones a paper surface chart uses. */
export const FRONT_COLORS: Record<FrontKind, string> = {
  cold: "#3b82f6",
  warm: "#ef4444",
  stationary: "#8b5cf6",
  occluded: "#a855f7",
  trough: "#f59e0b",
};

export const FRONT_LABELS: Record<FrontKind, string> = {
  cold: "Cold front",
  warm: "Warm front",
  stationary: "Stationary front",
  occluded: "Occluded front",
  trough: "Trough",
};

export const FRONT_KINDS = Object.keys(FRONT_LABELS) as FrontKind[];

/** What each line on a surface chart actually tells you. */
export const FRONT_DESCRIPTIONS: Record<FrontKind, string> = {
  cold: "Leading edge of advancing colder air. Sharp wind shift, pressure rise behind it, and the narrow line of storms ahead of or along it.",
  warm: "Leading edge of advancing warmer air. Gentler slope, so a broad shield of cloud and steady rain well ahead of the surface position.",
  stationary:
    "A front that has stopped moving. Weather trains along it repeatedly, which is why flash flooding so often sets up on one.",
  occluded:
    "A cold front has caught the warm front and lifted the warm air clear of the ground — the mature, usually weakening stage of a low.",
  trough:
    "An elongated axis of low pressure with no air-mass contrast. Still a focus for convergence and showers.",
};

export async function fetchFronts(
  history = 4,
  source: FrontSource = "wpc",
  signal?: AbortSignal,
  model?: string,
): Promise<FrontsResponse> {
  const q = new URLSearchParams({ history: String(history), source });
  if (source !== "wpc" && model) q.set("model", model);
  const res = await fetch(`${BASE}/api/fronts?${q}`, { signal });
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

/* ----------------------------------------------------------------- clipping */

/** Liang-Barsky: the part of one segment inside a box, or null. */
function clipSegment(x0: number, y0: number, x1: number, y1: number, b: Box) {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - b[0], b[2] - x0, y0 - b[1], b[3] - y0];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return { t0, t1, a: [x0 + t0 * dx, y0 + t0 * dy], b: [x0 + t1 * dx, y0 + t1 * dy] };
}

/** The pieces of a polyline inside a box. The box is tried shifted a world to
 *  either side as well: WPC keeps a Pacific front's longitudes continuous past
 *  -180, and those vertices still belong to the tile they sit in. */
function clipLine(coords: number[][], box: Box): number[][][] {
  const out: number[][][] = [];
  for (const shift of [0, -360, 360]) {
    const b: Box = [box[0] + shift, box[1], box[2] + shift, box[3]];
    let run: number[][] | null = null;
    for (let i = 0; i < coords.length - 1; i++) {
      const [x0, y0] = coords[i];
      const [x1, y1] = coords[i + 1];
      const c = clipSegment(x0, y0, x1, y1, b);
      if (!c) {
        if (run && run.length >= 2) out.push(run);
        run = null;
        continue;
      }
      if (run && c.t0 === 0) {
        run.push(c.b);
      } else {
        if (run && run.length >= 2) out.push(run);
        run = [c.a, c.b];
      }
      // Leaving the box mid-segment ends this piece.
      if (c.t1 < 1) {
        if (run.length >= 2) out.push(run);
        run = null;
      }
    }
    if (run && run.length >= 2) out.push(run);
  }
  return out;
}

const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

function pointIn(lon: number, lat: number, box: Box): boolean {
  const x = wrapLon(lon);
  // Half-open on the east and north edges, so a centre sitting exactly on a
  // shared border is drawn by one tile, not by both.
  const east = box[2] >= 180 ? x <= box[2] : x < box[2];
  const north = box[3] >= 90 ? lat <= box[3] : lat < box[3];
  return x >= box[0] && east && lat >= box[1] && north;
}

/** Just the part of each feature that lies inside any of `boxes`. */
export function clipFeatures(features: FrontFeature[], boxes: Box[]): FrontFeature[] {
  const out: FrontFeature[] = [];
  for (const f of features) {
    const g = f.geometry;
    if (g.type === "Point") {
      const [lon, lat] = g.coordinates;
      if (boxes.some((b) => pointIn(lon, lat, b))) out.push(f);
    } else if (g.type === "LineString") {
      for (const box of boxes) {
        for (const piece of clipLine(g.coordinates, box)) {
          out.push({ ...f, geometry: { type: "LineString", coordinates: piece } });
        }
      }
    }
  }
  return out;
}
