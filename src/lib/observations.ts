// Client for the analysis products (backend /api/obs): RTMA and the HRRR/RAP
// analysis hours, drawn as a Mercator-warped image with wind barbs
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
  /** A model's forecast run rather than an analysis: its frames are forecast hours. */
  forecast: boolean;
  /** Which shelf of the model menu it sits on. */
  group: string;
  /** Draws tracks (the ATCF guidance), not a shaded variable. */
  tracks?: boolean;
  /** Minutes between its frames: 2 for the radar mosaic, 60 for an hourly analysis. */
  cadence?: number;
  /** A forecast model's analysis twin: where its products go back in time,
   *  every hour of the last week (the panel's Replay). */
  replay?: string;
  /** The mesoanalysis archive: the first and newest hour it opens on (unix s).
   *  Its frames are the day around a picked moment, not the latest hours. */
  archive?: { from: number; to: number };
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
  /** Forecast hour and run ("2026092118"), on a forecast source's frames. */
  fh?: number;
  run?: string;
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
export const OBS_WIDTH = 1600;

/** Bumped when the server draws pictures differently (colours, smoothing), so
 *  a picture the browser kept for an hour is not shown in place of the new one. */
const DRAWN = "6";

/** How many picture pixels to spend per CSS pixel: the screen's own density,
 *  times a half more, so the map scales the picture down (crisp) rather than
 *  up (soft). */
export function obsDensity(): number {
  return Math.min(3, Math.max(1, window.devicePixelRatio || 1) * 1.5);
}

/** Passing the field lets the server start on its newest hour before the layer
 *  is even switched on. `run` picks one run of a forecast model; without it,
 *  the newest. `at` is the archive's picked moment: its day comes back. */
export async function fetchObsFrames(
  source: string,
  signal?: AbortSignal,
  field?: string,
  hours?: number,
  run?: string,
  at?: number,
): Promise<ObsFrame[]> {
  const q = new URLSearchParams({ source });
  if (field) q.set("field", field);
  if (hours) q.set("hours", String(hours));
  if (run) q.set("run", run);
  if (at) q.set("at", String(Math.floor(at)));
  const res = await fetch(`${BASE}/api/obs/frames?${q}`, { signal });
  if (!res.ok) throw new Error(await detail(res));
  return (await res.json()).frames as ObsFrame[];
}

/** A forecast frame's hour as the model viewer writes it: "F004", or "F01:15"
 *  on a sub-hourly model -- the first word of the label the backend made. */
export function fhText(frame: ObsFrame): string {
  const head = frame.label.split(" ")[0];
  return head.startsWith("F") ? head : `F${String(frame.fh ?? 0).padStart(3, "0")}`;
}

/** How the Models panel shows a product: one map, or a grid of the same valid
 *  time from several runs of the model, or from every model that has it. */
export type ObsView = "single" | "runs" | "models";

/** One window of the Compare models grid: any model, any product. */
export interface ObsWindow {
  source: string;
  field: string;
  /** A run kept from a Compare runs grid; the newest that reaches the time when absent. */
  run?: string;
}

/** One map of a compare grid. */
export interface ObsCompareCell {
  source: string;
  key: string;
  run: string;
  title: string;
  sub: string;
  /** The hour it shows, when that is not quite the timeline's (a custom window). */
  unix?: number;
}

/** Every model with the product at one valid time: "All models" in Compare models. */
export async function fetchObsCompare(
  source: string,
  field: string,
  unix: number,
  mode: "models",
  signal?: AbortSignal,
): Promise<ObsCompareCell[]> {
  const q = new URLSearchParams({ source, field, unix: String(unix), mode });
  const res = await fetch(`${BASE}/api/obs/compare?${q}`, { signal });
  if (!res.ok) throw new Error(await detail(res));
  return (await res.json()).cells as ObsCompareCell[];
}

/** One run Compare runs can show, and every hour of it that is out. */
export interface ObsStripRun {
  run: string;
  /** "22 Sep 06Z". */
  title: string;
  frames: ObsFrame[];
}

/** The runs Compare runs picks from, oldest first, each with its hours: which of
 *  them reach the moment on the timeline is worked out here, for any moment. A
 *  storm model's are the runs made for the storm in `run`. `partial`: the runs
 *  still coming out are not in it yet -- ask again in a moment. */
export async function fetchObsStrip(
  source: string,
  signal?: AbortSignal,
  run?: string,
): Promise<{ runs: ObsStripRun[]; partial: boolean }> {
  const q = new URLSearchParams({ source });
  if (run) q.set("run", run);
  const res = await fetch(`${BASE}/api/obs/strip?${q}`, { signal });
  if (!res.ok) throw new Error(await detail(res));
  const body = await res.json();
  return { runs: body.runs as ObsStripRun[], partial: !!body.partial };
}

/** One compare window at the timeline's valid time: that model's hour, or its
 *  nearest within three; null when it has nothing that close. */
export async function fetchObsWindow(
  win: ObsWindow,
  unix: number,
  signal?: AbortSignal,
): Promise<ObsCompareCell | null> {
  const q = new URLSearchParams({ source: win.source, field: win.field, unix: String(unix) });
  if (win.run) q.set("run", win.run);
  const res = await fetch(`${BASE}/api/obs/window?${q}`, { signal });
  if (!res.ok) throw new Error(await detail(res));
  return (await res.json()).cell as ObsCompareCell | null;
}

/** A product's colour scale, without drawing anything. */
export async function fetchObsBar(field: string, signal?: AbortSignal): Promise<ObsBar> {
  const res = await fetch(`${BASE}/api/obs/bar?${new URLSearchParams({ field })}`, { signal });
  if (!res.ok) throw new Error(await detail(res));
  return res.json();
}

/** The part of one hour inside a box, as a PNG of exactly that many pixels. */
export async function fetchObsView(
  cell: { source: string; key: string },
  field: string,
  box: { west: number; south: number; east: number; north: number },
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<Blob> {
  const q = new URLSearchParams({
    source: cell.source,
    field,
    key: cell.key,
    west: box.west.toFixed(4),
    south: box.south.toFixed(4),
    east: box.east.toFixed(4),
    north: box.north.toFixed(4),
    // The server draws 64 to 3072 pixels a side; a narrow grid cell asks for less.
    width: String(Math.min(3072, Math.max(64, Math.round(width)))),
    height: String(Math.min(3072, Math.max(64, Math.round(height)))),
    r: DRAWN,
  });
  const res = await fetch(`${BASE}/api/obs/view?${q}`, { signal });
  if (!res.ok) throw new Error(await detail(res));
  return res.blob();
}

/** An ATCF source's tracks for one storm and cycle. */
export interface ObsTracks {
  run: string;
  storm: string;
  cycle: string;
  lines: GeoJSON.FeatureCollection;
  points: GeoJSON.FeatureCollection;
  best: GeoJSON.FeatureCollection;
  legend: { tech: string; colour: string }[];
  intensity: boolean;
  bar: ObsBar | null;
}

export async function fetchObsTracks(
  opts: { source: string; field: string; key: string },
  signal?: AbortSignal,
): Promise<ObsTracks> {
  const res = await fetch(`${BASE}/api/obs/tracks?${new URLSearchParams(opts)}`, { signal });
  if (!res.ok) throw new Error(await detail(res));
  return res.json();
}

/** Whether a source draws tracks rather than a shaded field. */
export function isTrackSource(catalog: ObsCatalog | null, source: string): boolean {
  return !!catalog?.sources.find((s) => s.id === source)?.tracks;
}

/** A forecast model's run that can be opened ("2026092118"). */
export interface ObsRun {
  run: string;
  unix: number;
  /** A tropical model's run: the storm and cycle, "17E POLO · Tue 22 Sep 12Z". */
  label?: string;
  /** How far the run goes, in hours: a short cycle stops early. */
  hours?: number;
}

export async function fetchObsRuns(source: string, signal?: AbortSignal): Promise<ObsRun[]> {
  const res = await fetch(`${BASE}/api/obs/runs?${new URLSearchParams({ source })}`, { signal });
  if (!res.ok) throw new Error(await detail(res));
  return (await res.json()).runs as ObsRun[];
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

/** Wind barbs and the outline of the analysed area. */
export interface ObsVectors {
  source: string;
  field: string;
  key: string;
  unit: string;
  valid: string;
  /** Isobars and the H/L centres, on the products that carry MSLP. */
  isobars: GeoJSON.FeatureCollection;
  centres: GeoJSON.FeatureCollection;
  edge: GeoJSON.FeatureCollection;
  /** Where another variable crosses a level (UH > 75 on reflectivity). */
  outline?: GeoJSON.FeatureCollection;
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
    r: DRAWN,
  });
  return `${BASE}/api/obs/view?${q}`;
}

/** Ask the backend to start making a loop of frames, in the order given --
 *  with `view`, each frame's sharp picture of that box as well (the very one
 *  obsViewUrl asks for with the same box, so the ask finds it made). */
export async function prefetchObsLoop(
  source: string,
  field: string,
  keys: string[],
  view?: { west: number; south: number; east: number; north: number; width: number; height: number } | null,
): Promise<void> {
  const box = view
    ? {
        west: Number(view.west.toFixed(3)),
        south: Number(view.south.toFixed(3)),
        east: Number(view.east.toFixed(3)),
        north: Number(view.north.toFixed(3)),
        width: Math.round(view.width),
        height: Math.round(view.height),
      }
    : undefined;
  await fetch(`${BASE}/api/obs/prefetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, field, keys, view: box }),
  });
}

/** Skip the frames of the loop still waiting to be made. */
export async function cancelObsLoop(): Promise<void> {
  await fetch(`${BASE}/api/obs/cancel`, { method: "POST" });
}

/** Which frames of a loop the backend has finished, and which it could not make. */
export async function fetchObsLoopStatus(
  source: string,
  field: string,
  keys: string[],
): Promise<{ ready: string[]; failed: string[] }> {
  const res = await fetch(`${BASE}/api/obs/loop-status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, field, keys }),
  });
  if (!res.ok) throw new Error(await detail(res));
  return res.json();
}

export interface ObsPoints {
  key: string;
  field: string;
  /** The product is not readable yet; values are all null until it is. */
  pending: boolean;
  /** One per point asked for: "91°", "63%", "2500", or null outside the data. */
  values: (string | null)[];
}

export async function fetchObsPoints(
  opts: { source: string; field: string; key: string; points: [number, number][] },
  signal?: AbortSignal,
): Promise<ObsPoints> {
  const res = await fetch(`${BASE}/api/obs/points`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
    signal,
  });
  if (!res.ok) throw new Error(await detail(res));
  return res.json();
}

/** A plain PNG URL: fetched and decoded by the map itself, and cacheable. */
export function obsImageUrl(opts: { source: string; field: string; key: string; width?: number }): string {
  const q = new URLSearchParams({
    source: opts.source,
    field: opts.field,
    key: opts.key,
    width: String(opts.width ?? OBS_WIDTH),
    r: DRAWN,
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
