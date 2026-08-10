// Client for the WPC surface analysis (backend /api/fronts): fronts, troughs
// and pressure centres decoded from the Coded Surface Bulletin, as a series of
// timeline frames — past analyses plus the 12 h and 24 h progs.

import { BACKEND_BASE } from "./apiConfig";

const BASE = BACKEND_BASE;

export type FrontKind = "cold" | "warm" | "stationary" | "occluded" | "trough";

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

export type FrontFeature = GeoJSON.Feature<GeoJSON.Geometry, FrontLineProps | CentreProps>;

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
  };
}

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
  signal?: AbortSignal,
): Promise<FrontsResponse> {
  const res = await fetch(`${BASE}/api/fronts?history=${history}`, { signal });
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
