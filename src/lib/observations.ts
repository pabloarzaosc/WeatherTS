// Client for the analysis products (backend /api/obs): RTMA and the HRRR/RAP
// analysis hours, drawn as a Mercator-warped image with contours and wind barbs
// over it, and scrubbed on the app's one timeline. See backend/observations.py
// for what each source carries and how the derived parameters are worked out.

import { BACKEND_BASE as BASE } from "./apiConfig";

/** One thing that can be drawn: a shaded variable, maybe with lines and barbs. */
export interface ObsProduct {
  id: string;
  label: string;
  /** Top level of the picker: Surface, Upper-Air, Severe Weather. */
  group: string;
  /** Second level where a group has one: Wind, Vorticity, Instability. */
  sub: string | null;
  unit: string;
  note: string;
  lines: boolean;
  barbs: boolean;
  /** The sources that can draw it, in catalogue order. */
  sources: string[];
}

export interface ObsSource {
  id: string;
  label: string;
  org: string;
  coverage: string;
  note: string;
  /** Product ids this source can draw. */
  products: string[];
}

export interface ObsCatalog {
  sources: ObsSource[];
  products: ObsProduct[];
  defaultSource: string;
  defaultField: string;
}

/** One analysis hour the server still holds. */
export interface ObsFrame {
  key: string;
  unix: number;
  label: string;
}

export interface ObsBar {
  unit: string;
  min: number;
  max: number;
  colors: string[];
  ticks: number[];
  /** Words in place of numbers, for a categorical scale (precipitation type). */
  labels?: { v: number; t: string }[] | null;
}

export interface ObsRender {
  /** Base64 PNG, already in the projection the map draws in. */
  image: string;
  /** The four corners to place it at, clockwise from the top left. */
  coordinates: [number, number][];
  meta: {
    source: string;
    sourceLabel: string;
    field: string;
    fieldLabel: string;
    unit: string;
    key: string;
    unix: number;
    valid: string;
    width: number;
    height: number;
    bar: ObsBar;
  };
}

async function detail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.detail === "string") return body.detail;
  } catch {
    /* fall through to the status code */
  }
  return `HTTP ${res.status}`;
}

export async function fetchObsCatalog(signal?: AbortSignal): Promise<ObsCatalog> {
  const res = await fetch(`${BASE}/api/obs/catalog`, { signal });
  if (!res.ok) throw new Error(await detail(res));
  return res.json();
}

/** The picture size asked for: about what a whole-country view can show. */
export const OBS_WIDTH = 1200;

/** Passing the field lets the server start on its newest hour before the layer
 *  is even switched on. */
export async function fetchObsFrames(source: string, signal?: AbortSignal, field?: string): Promise<ObsFrame[]> {
  const q = new URLSearchParams({ source });
  if (field) q.set("field", field);
  const res = await fetch(`${BASE}/api/obs/frames?${q}`, { signal });
  if (!res.ok) throw new Error(await detail(res));
  return (await res.json()).frames as ObsFrame[];
}

/** Wind barbs as parallel arrays: position, speed (kt, in fives), the direction
 *  the wind blows FROM, and the coarsest lattice the barb belongs to (0 = every
 *  4 degrees .. 3 = every half degree) so the map can thin them by zoom. */
export interface ObsBarbs {
  lon: number[];
  lat: number[];
  s: number[];
  d: number[];
  r: number[];
}

/** Labelled contours, wind barbs, and the outline of the analysed area. */
export interface ObsVectors {
  source: string;
  field: string;
  key: string;
  unit: string;
  /** Spacing of the lines, in `linesUnit`; null when the product draws none. */
  interval: number | null;
  linesUnit: string;
  valid: string;
  contours: GeoJSON.FeatureCollection;
  edge: GeoJSON.FeatureCollection;
  barbs: ObsBarbs | null;
}

/** The analysed value at one point. */
export interface ObsValue {
  source: string;
  field: string;
  key: string;
  unit: string;
  label: string;
  /** Null outside the analysed area. */
  value: number | null;
  /** The value with its unit, rounded the way the product is read: "2.4", "91 °F". */
  text: string | null;
  /** The wind and the contoured variable at the same point: "SW 35 kt · 582 dam". */
  extra: string | null;
  /** The product is not readable yet (its hour is still downloading). */
  pending?: boolean;
  lat: number;
  lon: number;
}

export async function fetchObsVectors(
  opts: { source: string; field: string; key: string },
  signal?: AbortSignal,
): Promise<ObsVectors> {
  const q = new URLSearchParams({ source: opts.source, field: opts.field, key: opts.key });
  const res = await fetch(`${BASE}/api/obs/vectors?${q}`, { signal });
  if (!res.ok) throw new Error(await detail(res));
  return res.json();
}

export async function fetchObsValue(
  opts: { source: string; field: string; key: string; lat: number; lon: number },
  signal?: AbortSignal,
): Promise<ObsValue> {
  const q = new URLSearchParams({
    source: opts.source,
    field: opts.field,
    key: opts.key,
    lat: String(opts.lat),
    lon: String(opts.lon),
  });
  const res = await fetch(`${BASE}/api/obs/value?${q}`, { signal });
  if (!res.ok) throw new Error(await detail(res));
  return res.json();
}

/** Placement and legend for one hour; the picture itself is obsImageUrl. */
export async function fetchObsMeta(
  opts: { source: string; field: string; key: string; width?: number },
  signal?: AbortSignal,
): Promise<Pick<ObsRender, "coordinates" | "meta">> {
  const q = new URLSearchParams({
    source: opts.source,
    field: opts.field,
    key: opts.key,
    width: String(opts.width ?? OBS_WIDTH),
  });
  const res = await fetch(`${BASE}/api/obs/meta?${q}`, { signal });
  if (!res.ok) throw new Error(await detail(res));
  return res.json();
}

/** The part of one hour inside a box, for a zoomed-in view: sharp where the
 *  whole-domain picture is about 6 km a pixel. */
export function obsViewUrl(opts: {
  source: string;
  field: string;
  key: string;
  west: number;
  south: number;
  east: number;
  north: number;
  width: number;
  height: number;
}): string {
  const q = new URLSearchParams({
    source: opts.source,
    field: opts.field,
    key: opts.key,
    west: opts.west.toFixed(3),
    south: opts.south.toFixed(3),
    east: opts.east.toFixed(3),
    north: opts.north.toFixed(3),
    width: String(Math.round(opts.width)),
    height: String(Math.round(opts.height)),
  });
  return `${BASE}/api/obs/view?${q}`;
}

/** A plain PNG URL: fetched and decoded by the map itself, and cacheable. */
export function obsImageUrl(opts: { source: string; field: string; key: string; width?: number }): string {
  const q = new URLSearchParams({
    source: opts.source,
    field: opts.field,
    key: opts.key,
    width: String(opts.width ?? OBS_WIDTH),
  });
  return `${BASE}/api/obs/image?${q}`;
}

export async function fetchObsRender(
  opts: { source: string; field: string; key: string; width?: number },
  signal?: AbortSignal,
): Promise<ObsRender> {
  const q = new URLSearchParams({
    source: opts.source,
    field: opts.field,
    key: opts.key,
    width: String(opts.width ?? 1600),
  });
  const res = await fetch(`${BASE}/api/obs/render?${q}`, { signal });
  if (!res.ok) throw new Error(await detail(res));
  return res.json();
}
