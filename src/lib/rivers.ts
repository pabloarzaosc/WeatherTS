/**
 * River gauges and hydrographs: the backend's /api/rivers -- the NWS National
 * Water Prediction Service for the US (backend/rivers.py), and for Brazil
 * SGB's alert stations and ANA's telemetry (backend/brazil_rivers.py).
 */
import { BACKEND_BASE } from "./apiConfig";

/** Who runs a gauge: the NWS (US), SGB's alert systems (Brazil, with alert
 *  levels) or ANA's telemetry (Brazil, level, flow and rain, no levels). */
export type RiverNet = "nws" | "sgb" | "ana";

/** The NWS flood categories, and the states a gauge can be in instead. */
export type RiverStatus =
  | "major"
  | "moderate"
  | "minor"
  | "action"
  | "no_flooding"
  | "low_threshold"
  | "not_defined"
  | "obs_not_current"
  | "out_of_service";

/** The NWS's own colours for each, as on its gauge maps and hydrographs. */
export const RIVER_COLORS: Record<RiverStatus, string> = {
  major: "#cc33ff",
  moderate: "#ff2222",
  minor: "#ff9900",
  action: "#ffee00",
  no_flooding: "#1ec94c",
  low_threshold: "#a0743a",
  not_defined: "#72afe9",
  obs_not_current: "#9aa0a6",
  out_of_service: "#5f6368",
};

export const RIVER_LABELS: Record<RiverStatus, string> = {
  major: "Major flood",
  moderate: "Moderate flood",
  minor: "Minor flood",
  action: "Action stage",
  no_flooding: "No flooding",
  low_threshold: "Low water",
  not_defined: "No flood levels set",
  obs_not_current: "Reading out of date",
  out_of_service: "Out of service",
};

/** SGB's levels in English (cota de atenção, de alerta, de inundação), drawn
 *  in the same colours as the NWS's: attention in the action yellow, alert in
 *  the minor orange, flood in red. */
const SGB_LABELS: Partial<Record<RiverStatus, string>> = {
  major: "Severe flood",
  moderate: "Flood",
  minor: "Alert",
  action: "Attention",
  no_flooding: "Normal",
  obs_not_current: "No recent data",
};

/** A status in the words of the gauge's own network. */
export function statusLabel(s: RiverStatus, net: RiverNet | undefined): string {
  if (net === "sgb") return SGB_LABELS[s] ?? RIVER_LABELS[s];
  if (net === "ana") return "ANA telemetry";
  return RIVER_LABELS[s];
}

/** The level lines' names, per network. */
export function levelLabel(key: "action" | "minor" | "moderate" | "major", net: RiverNet | undefined): string {
  if (net === "sgb" || net === "ana") {
    return { action: "Attention", minor: "Alert", moderate: "Flood", major: "Severe" }[key];
  }
  return { action: "Action", minor: "Minor", moderate: "Moderate", major: "Major" }[key];
}

/** How bad, for sorting and comparing: 4 major .. 1 action, 0 for the rest. */
export function riverRank(s: string | null | undefined): number {
  return s === "major" ? 4 : s === "moderate" ? 3 : s === "minor" ? 2 : s === "action" ? 1 : 0;
}

export interface RiverGauge {
  lid: string;
  /** Absent on the NWS list, which is all "nws". */
  net?: RiverNet;
  river: string;
  place: string;
  state: string;
  wfo: string;
  lat: number;
  lon: number;
  status: RiverStatus;
  stage: number | null;
  units: string;
  obsTime: string | null;
  action: number | null;
  flood: number | null;
  moderate: number | null;
  major: number | null;
  /** The forecast period's highest category and stage, where there is a forecast. */
  fstatus: RiverStatus | null;
  fstage: number | null;
  fTime: string | null;
}

export interface RiverGauges {
  gauges: RiverGauge[];
  updated: number;
  count: number;
  /** The Brazilian list's counts and the source that failed, if one did. */
  sgb?: number;
  ana?: number;
  errors?: string[];
}

/** [unix s, stage, flow] */
export type HydroPoint = [number, number | null, number | null];

type Levels = { action: number | null; minor: number | null; moderate: number | null; major: number | null };

export interface Hydrograph {
  lid: string;
  net?: RiverNet;
  name: string;
  usgsId: string | null;
  state: string | null;
  wfo: string | null;
  rfc: string | null;
  lat: number;
  lon: number;
  units: string;
  flowUnits: string;
  stages: Levels;
  flows?: Levels;
  observed: HydroPoint[];
  observedMeta: { primaryName?: string; primaryUnits?: string; secondaryName?: string; secondaryUnits?: string; issued?: string };
  forecast: HydroPoint[];
  forecastMeta: { issued?: string };
  crests: { time: string; stage: number; preliminary: string | null }[];
  record: { time: string; stage: number } | null;
  impacts: { stage: number; statement: string }[];
  status: { observed: string | null; forecast: string | null };
  /** [unix s (end of the hour), mm] -- Brazil's stations. */
  rain?: [number, number][];
  county?: string | null;
  upstream?: string | null;
  downstream?: string | null;
  notes?: string[];
  /** The RFC's chance of each flood category over the next three months. */
  outlook?: { interval: string; issued: string | null; minor: number | null; moderate: number | null; major: number | null } | null;
  /** The NWS's ensemble (HEFS) and exceedance charts for the gauge. */
  images?: { shortrange: string | null; weekly: string | null; season: string | null };
  // Brazil
  code?: string;
  basin?: string | null;
  town?: string | null;
  operator?: string | null;
  origin?: string | null;
  situation?: string | null;
  levelSource?: "sgb" | "ana";
  links?: { sace?: string; hidroweb?: string };
  warnings?: string[];
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* not JSON */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export function fetchRiverGauges(signal?: AbortSignal): Promise<RiverGauges> {
  return getJson(`${BACKEND_BASE}/api/rivers/gauges`, signal);
}

export function fetchBrazilStations(signal?: AbortSignal): Promise<RiverGauges> {
  return getJson(`${BACKEND_BASE}/api/rivers/brazil`, signal);
}

export function fetchHydrograph(lid: string, signal?: AbortSignal): Promise<Hydrograph> {
  return getJson(`${BACKEND_BASE}/api/rivers/hydrograph?lid=${encodeURIComponent(lid)}`, signal);
}

/** A gauge on the river's chain, upstream first. */
export interface ChainNode {
  lid: string;
  river: string;
  place: string;
  status: RiverStatus;
  stage: number | null;
  units: string;
  fstatus: RiverStatus | null;
  self: boolean;
}

/** What the hydrograph screen shows around a gauge, asked for after it. */
export interface RiverContext {
  lid: string;
  chain: ChainNode[];
  /** USGS daily statistics of the flow, "MM-DD" -> [min, p10, p25, p50, p75, p90, max]. */
  normals: { days: Record<string, (number | null)[]>; years: [number, number]; units: string; site: string } | null;
  /** [unix s at the end of the hour, mm], the last 31 days and the next 7. */
  rain: { hourly: [number, number][]; source: string } | null;
  errors: string[];
}

export function fetchRiverContext(lid: string, signal?: AbortSignal): Promise<RiverContext> {
  return getJson(`${BACKEND_BASE}/api/rivers/context?lid=${encodeURIComponent(lid)}`, signal);
}

/** "Wapsipinicon River near DeWitt" from a gauge's river and place; a
 *  Brazilian one reads "Rio Taquari at Muçum" (the river keeps its own name). */
export function gaugeName(g: Pick<RiverGauge, "river" | "place" | "lid" | "net">): string {
  const br = g.net === "sgb" || g.net === "ana";
  if (g.river && g.place) {
    if (br) return g.place.toLowerCase().includes(g.river.toLowerCase()) ? g.place : `${g.river} at ${g.place}`;
    return `${g.river} ${/^(at|near|above|below|in|on)\b/i.test(g.place) ? "" : "at "}${g.place}`;
  }
  return g.river || g.place || g.lid;
}

/** The id to show: "DEWI4", or a Brazilian station's code without "BR:". */
export function gaugeId(lid: string): string {
  return lid.startsWith("BR:") ? lid.slice(3) : lid;
}

/** The National Water Model rasters on the flood panel: NOAA's
 *  maps.water.noaa.gov map services, drawn as tiles of their export images. */
export interface NwmProduct {
  id: string;
  label: string;
  /** "nwm/ana_high_flow_magnitude" */
  service: string;
  layer: number;
  hint: string;
  /** The service only draws it this far in (inundation: street scale). */
  minzoom?: number;
}

export const NWM_BASE = "https://maps.water.noaa.gov/server/rest/services";

export const NWM_PRODUCTS: NwmProduct[] = [
  {
    id: "flow-now",
    label: "High flow now",
    service: "nwm/ana_high_flow_magnitude",
    layer: 0,
    hint: "Streams the National Water Model has above their high water mark now, by how rare the flow is (its annual chance).",
  },
  {
    id: "flow-18h",
    label: "High flow, next 18 h",
    service: "nwm/srf_18hr_max_high_flow_magnitude",
    layer: 0,
    hint: "The highest flow the short-range model forecasts in the next 18 hours, by how rare it is.",
  },
  {
    id: "flow-5d",
    label: "High flow, next 5 days",
    service: "nwm/mrf_gfs_10day_max_high_flow_magnitude",
    layer: 1,
    hint: "The highest flow the medium-range model (GFS) forecasts over 5 days, by how rare it is.",
  },
  {
    id: "rapid-18h",
    label: "Rapid onset flooding, 18 h",
    service: "nwm/srf_18hr_rapid_onset_flooding",
    layer: 0,
    hint: "Small streams forecast to rise fast into flood in the next 18 hours, by how soon.",
  },
  {
    id: "prob-5d",
    label: "Chance of high water, 5 days",
    service: "nwm/mrf_gfs_5day_max_high_water_probability",
    layer: 0,
    hint: "The chance, from the model's ensemble, that a stream goes above its high water mark in the next 5 days.",
  },
  {
    id: "inundation-now",
    label: "Inundation extent now",
    service: "nwm/ana_inundation_extent",
    layer: 0,
    hint: "The land the model's flows put under water now (experimental). NOAA draws it only zoomed in to a town.",
    minzoom: 10,
  },
];

export interface NwmLegendItem {
  label: string;
  /** data: URL of the service's own swatch. */
  image: string;
}

const legends = new Map<string, Promise<NwmLegendItem[]>>();

/** A product's legend as the service draws it: its own swatches, not a guess
 *  at its colours. */
export function fetchNwmLegend(p: NwmProduct): Promise<NwmLegendItem[]> {
  const key = `${p.service}:${p.layer}`;
  let hit = legends.get(key);
  if (!hit) {
    hit = getJson<{ layers?: { layerId: number; legend?: { label?: string; imageData?: string; contentType?: string }[] }[] }>(
      `${NWM_BASE}/${p.service}/MapServer/legend?f=json`,
    ).then((d) =>
      (d.layers?.find((l) => l.layerId === p.layer)?.legend ?? [])
        .filter((x) => x.imageData && (x.label ?? "").trim() && !/insufficient/i.test(x.label ?? ""))
        .map((x) => ({ label: (x.label ?? "").trim(), image: `data:${x.contentType ?? "image/png"};base64,${x.imageData}` })),
    );
    hit.catch(() => legends.delete(key));
    legends.set(key, hit);
  }
  return hit;
}
