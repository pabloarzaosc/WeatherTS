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
  /** Publishes sea level pressure: can draw isobars. */
  mslp: boolean;
  /** Publishes 850 hPa temperature, humidity and wind: can find fronts. */
  fronts: boolean;
  /** Publishes the 500 and 1000 hPa heights: can draw thickness. */
  thickness: boolean;
  /** Where a regional model has data: the south-west corners of the 5-degree
   *  tiles its grid reaches. Null for a global model. */
  footprint: [number, number][] | null;
}

/** Order the picker lists categories in — forecaster convention, not alphabetical. */
export const CATEGORY_ORDER = ["Global", "Regional", "Mesoscale", "AI", "Ensemble", "Climate"];
const REGION_ORDER = ["USA", "European", "Canadian", "Asian"];

/** A region the order does not name goes last, not first. */
const regionRank = (r: string) => {
  const i = REGION_ORDER.indexOf(r);
  return i < 0 ? REGION_ORDER.length : i;
};

export const byRegion = (models: ModelInfo[]): [string, ModelInfo[]][] => {
  const map = new Map<string, ModelInfo[]>();
  for (const m of models) map.set(m.region, [...(map.get(m.region) ?? []), m]);
  return [...map.entries()].sort((a, b) => regionRank(a[0]) - regionRank(b[0]));
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

export async function fetchModels(signal?: AbortSignal): Promise<{ models: ModelInfo[]; default: string }> {
  const res = await fetch(`${BASE}/api/model-fields/models`, { signal });
  if (!res.ok) throw new Error(`models ${res.status}`);
  return res.json();
}

/** Nearest hour the model actually publishes; the axis is not uniform. */
export function snapHour(model: ModelInfo | null, hour: number): number {
  if (!model || model.hours.length === 0) return hour;
  return model.hours.reduce((best, h) => (Math.abs(h - hour) < Math.abs(best - hour) ? h : best), model.hours[0]);
}

