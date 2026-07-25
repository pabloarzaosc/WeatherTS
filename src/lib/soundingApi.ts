import { SOUNDING_API_BASE } from './apiConfig';
const API_BASE_STORAGE_KEY = "weatherts-sounding-api-base";

type JsonObject = Record<string, unknown>;

export type SoundingSource = "obs" | "bufkit" | "psu";

export interface SoundingStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  sources?: string[];
  wmo?: string;
}

export interface SoundingParams {
  sbCape?: number | null;
  sbCin?: number | null;
  sbLclM?: number | null;
  muCape?: number | null;
  muCin?: number | null;
  muLclM?: number | null;
  mlCape?: number | null;
  mlCin?: number | null;
  mlLclM?: number | null;
  dcape?: number | null;
  lr03?: number | null;
  lr36?: number | null;
  pwat?: number | null;
  frzLevel?: number | null;
  wbo?: number | null;
  stp?: number | null;
  stpEff?: number | null;
  scp?: number | null;
  ship?: number | null;
  dcp?: number | null;
  ecape?: number | null;
  cape3km?: number | null;
  cape6km?: number | null;
  dcin?: number | null;
  ncape?: number | null;
  rh01?: number | null;
  rh13?: number | null;
  rh36?: number | null;
  precipType?: string | null;
  wmsi?: number | null;
  mdpi?: number | null;
  maxGust?: number | null;
  fosbergFwi?: number | null;
  haines?: number | null;
  hdw?: number | null;
  hazards?: { type: string; level: string }[];
  tempAdvection?: { layer: string; type: string; turn: number }[];
  bwd500m?: number | null;
  bwd1km?: number | null;
  bwd3km?: number | null;
  bwd6km?: number | null;
  srh500m?: number | null;
  srh1km?: number | null;
  srh3km?: number | null;
  esrh?: number | null;
  ebwd?: number | null;
  eilBot?: number | null;
  eilTop?: number | null;
  brn?: number | null;
  convectiveMode?: string | null;
  criticalAngle?: number | null;
  ehi01?: number | null;
  ehi03?: number | null;
  vgp?: number | null;
  [key: string]: unknown;
}

export interface SoundingProfileLevel {
  p: number | null;
  h: number | null;
  t: number | null;
  td: number | null;
  wd: number | null;
  ws: number | null;
}

export interface SoundingMeta {
  station?: string | null;
  stationName?: string;
  source?: string;
  date?: string;
  levels?: number;
  sfcPressure?: number;
  topPressure?: number;
  sfcElevation?: number;
  vadRadar?: string | null;
  vadTime?: string | null;
}

export interface SoundingResult {
  image?: string;
  params: SoundingParams;
  profile?: SoundingProfileLevel[];
  sbParcel?: Array<number | null> | null;
  mlParcel?: Array<number | null> | null;
  meta: SoundingMeta;
  error?: string;
}

export interface RiskStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  stp: number;
  raw: number;
  cape: number;
  srh: number;
  bwd: number;
  scp: number;
  ship: number;
  dcp: number;
  bwdDir?: number;
}

export interface RiskScanResult {
  date: string;
  model?: string;
  fhour?: number;
  initTime?: string;
  stations: RiskStation[];
}

export interface TimeSeriesPoint {
  date: string;
  ts: string;
  params: SoundingParams;
}

export interface TimeSeriesResult {
  station: string;
  stationName: string;
  source: string;
  startDate: string;
  endDate: string;
  resolution: string;
  points: TimeSeriesPoint[];
}

export interface VwpResult {
  radar: string;
  hours: number;
  image?: string;
  meta?: JsonObject;
}

export interface EnsembleResult {
  station?: string;
  model?: string;
  image?: string;
  params?: SoundingParams;
  members?: unknown[];
  meta?: JsonObject;
}

export function defaultSoundingApiBaseUrl() {
  return import.meta.env.PROD ? SOUNDING_API_BASE : '/sounding-api';
}

export function getSoundingApiBaseUrl() {
  const stored = localStorage.getItem(API_BASE_STORAGE_KEY)?.trim();
  return stored || import.meta.env.VITE_SOUNDING_API_URL || defaultSoundingApiBaseUrl();
}

export function setSoundingApiBaseUrl(value: string) {
  const cleaned = value.trim().replace(/\/+$/, "");
  if (cleaned) localStorage.setItem(API_BASE_STORAGE_KEY, cleaned);
  else localStorage.removeItem(API_BASE_STORAGE_KEY);
}

function joinUrl(base: string, path: string) {
  if (!base) return path;
  return `${base.replace(/\/+$/, "")}${path}`;
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("Request timed out");
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

async function requestJson<T>(
  path: string,
  options: { method?: "GET" | "POST"; body?: JsonObject; timeoutMs?: number } = {},
) {
  const baseUrl = getSoundingApiBaseUrl();
  const method = options.method ?? "GET";

  const response = await fetchWithTimeout(
    joinUrl(baseUrl, path),
    {
      method,
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    },
    options.timeoutMs ?? 10000,
  );
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function query(params: Record<string, string | number | boolean | undefined | null>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const value = search.toString();
  return value ? `?${value}` : "";
}

export function fetchStations() {
  return requestJson<SoundingStation[]>("/api/stations", { timeoutMs: 20000 });
}

export function fetchSources() {
  return requestJson<JsonObject>("/api/sources", { timeoutMs: 20000 });
}

export function fetchSounding(params: JsonObject) {
  return requestJson<SoundingResult>("/api/sounding", {
    method: "POST",
    body: params,
    timeoutMs: 120000,
  });
}

export function fetchCustomSounding(params: { text: string; format?: string; theme?: string; colorblind?: boolean }) {
  return requestJson<SoundingResult>("/api/custom-sounding", {
    method: "POST",
    body: params as JsonObject,
    timeoutMs: 120000,
  });
}

export function fetchRiskScan(date?: string) {
  return requestJson<RiskScanResult>("/api/risk-scan", {
    method: "POST",
    body: date ? { date } : {},
    timeoutMs: 180000,
  });
}

export function fetchForecastRiskScan(params: { model: string; fhour: number }) {
  return requestJson<RiskScanResult>("/api/forecast-risk-scan", {
    method: "POST",
    body: params,
    timeoutMs: 240000,
  });
}

export function fetchTimeSeries(params: JsonObject) {
  return requestJson<TimeSeriesResult>("/api/time-series", {
    method: "POST",
    body: params,
    timeoutMs: 300000,
  });
}

export function fetchCompare(soundings: JsonObject[]) {
  return requestJson<{ soundings: SoundingResult[] }>("/api/compare", {
    method: "POST",
    body: { soundings },
    timeoutMs: 300000,
  });
}

export function fetchComposite(soundings: JsonObject[]) {
  return requestJson<{ image: string; meta?: JsonObject }>("/api/composite", {
    method: "POST",
    body: { soundings },
    timeoutMs: 300000,
  });
}

export function fetchMergeProfiles(params: { soundings: JsonObject[]; weight: number; theme?: string; colorblind?: boolean }) {
  return requestJson<SoundingResult>("/api/merge-profiles", {
    method: "POST",
    body: params as JsonObject,
    timeoutMs: 300000,
  });
}

export function fetchEnsemblePlume(params: JsonObject) {
  return requestJson<EnsembleResult>("/api/ensemble-plume", {
    method: "POST",
    body: params,
    timeoutMs: 300000,
  });
}

export function fetchForecastProfiles(params: JsonObject) {
  return requestJson<{ profiles: unknown[]; station?: string; model?: string }>("/api/forecast-profiles", {
    method: "POST",
    body: params,
    timeoutMs: 300000,
  });
}

export function fetchVwpDisplay(radar: string, hours = 12) {
  return requestJson<VwpResult>(`/api/vwp-display${query({ radar, hours })}`, { timeoutMs: 120000 });
}

export function fetchSpcDiscussion(day = 1) {
  return requestJson<{ day: number; text: string }>(`/api/spc-discussion${query({ day })}`, { timeoutMs: 20000 });
}

export function fetchSpcOutlookStations(day = 1, type = "cat", minRisk = "") {
  return requestJson<{ stations: Array<SoundingStation & { riskLabel?: string }>; count: number }>(
    `/api/spc-outlook-stations${query({ day, type, minRisk })}`,
    { timeoutMs: 25000 },
  );
}
