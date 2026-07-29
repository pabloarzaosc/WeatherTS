// Client for the model-fields endpoints. The Python backend (:8787) slices one
// variable out of a NOMADS GRIB2 file, contours it, and hands back vectors --
// see backend/model_fields.py for which models are wired.

import { BACKEND_BASE as BASE } from "./apiConfig";

/** One entry in the sidebar's model picker. */
export interface ModelInfo {
  id: string;
  label: string;
  org: string;
  coverage: string;
  /** Picker's top level: Global | Regional | Mesoscale | AI | Ensemble. */
  category: string;
  /** Picker's second level: USA | European | Canadian. */
  region: string;
  maxHour: number;
  cycles: number[];
  /** Forecast hours this model actually publishes. */
  hours: number[];
  global: boolean;
}

/** Order the picker lists categories in — forecaster convention, not alphabetical. */
export const CATEGORY_ORDER = ["Global", "Regional", "Mesoscale", "AI", "Ensemble"];
const REGION_ORDER = ["USA", "European", "Canadian"];

export const byRegion = (models: ModelInfo[]): [string, ModelInfo[]][] => {
  const map = new Map<string, ModelInfo[]>();
  for (const m of models) map.set(m.region, [...(map.get(m.region) ?? []), m]);
  return [...map.entries()].sort(
    (a, b) => REGION_ORDER.indexOf(a[0]) - REGION_ORDER.indexOf(b[0]),
  );
};

/**
 * The most recent nominal run for a model, as the "12z" badge in the picker.
 * Nominal, not verified: probing every model's latest cycle would mean a dozen
 * network round trips just to open a menu.
 */
export function latestCycle(model: ModelInfo, now = new Date()): number {
  const h = now.getUTCHours();
  const past = model.cycles.filter((c) => c <= h);
  return past.length > 0 ? Math.max(...past) : Math.max(...model.cycles);
}

export interface IsobarProps {
  hPa: number;
  label: string;
  band: "low" | "high";
  major: boolean;
}

export interface CentreProps {
  kind: "H" | "L";
  hPa: number;
  label: string;
}

export interface MslpField {
  source: string;
  model: string;
  modelLabel: string;
  coverage: string;
  variable: string;
  units: string;
  /** Model run, preformatted for display ("Wed 2026-07-29 12Z"). */
  run: string;
  runIso: string;
  /** What this frame is valid for, preformatted. */
  valid: string;
  validIso: string;
  hour: number;
  interval: number;
  geojson: GeoJSON.FeatureCollection;
}

export async function fetchModels(signal?: AbortSignal): Promise<{ models: ModelInfo[]; default: string }> {
  const res = await fetch(`${BASE}/api/model-fields/models`, { signal });
  if (!res.ok) throw new Error(`models ${res.status}`);
  return res.json();
}

/** Reads the backend's error detail, which says *why* a run is unavailable. */
async function detail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.detail === "string") return body.detail;
  } catch {
    /* fall through to the status code */
  }
  return `HTTP ${res.status}`;
}

export async function fetchMslp(
  opts: { model: string; hour: number; interval: number; centres: boolean; smooth: number },
  signal?: AbortSignal,
): Promise<MslpField> {
  const q = new URLSearchParams({
    model: opts.model,
    hour: String(opts.hour),
    interval: String(opts.interval),
    centres: String(opts.centres),
    smooth: String(opts.smooth),
  });
  const res = await fetch(`${BASE}/api/model-fields/mslp?${q}`, { signal });
  if (!res.ok) throw new Error(await detail(res));
  return res.json();
}

/** Nearest hour the model actually publishes; the axis is not uniform. */
export function snapHour(model: ModelInfo | null, hour: number): number {
  if (!model || model.hours.length === 0) return hour;
  return model.hours.reduce((best, h) => (Math.abs(h - hour) < Math.abs(best - hour) ? h : best), model.hours[0]);
}
