export interface OutlookLegendItem {
  label: string;
  color: string;
  section?: string;
}

export interface OutlookResponse {
  source: string;
  stale: boolean;
  error: string | null;
  valid: string | null;
  expire: string | null;
  /** When the product was issued (ISO), when the source says. */
  issued?: string | null;
  forecaster?: string | null;
  run?: string | null;
  /** What the source says when it draws no area ("Less Than 2% All Areas"). */
  note?: string | null;
  legend: OutlookLegendItem[];
  geojson: GeoJSON.FeatureCollection;
}

/**
 * Which issuance of an outlook to read: null for the newest, or an archived one
 * by the date it was issued (UTC, "YYYYMMDD") and the time its file is named
 * for ("HHMM", see SPC_ISSUANCES).
 */
export interface OutlookWhen {
  date: string;
  time: string | null;
}

export type SpcOutlookType = "categorical" | "tornado" | "wind" | "hail" | "probabilistic";
export type SpcDay = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type SpcFireType = "windrh" | "dryt";
export type CpcOutlookType = "hazards" | "temperature" | "precipitation";
export type CpcPeriod = "3-7" | "6-10" | "8-14" | "monthly" | "seasonal";
export type NadoCastHazard = "tornado" | "wind" | "hail" | "sig-tornado";

const NOAA_MAPS = "https://mapservices.weather.noaa.gov/vector/rest/services";
const NOAA_TROPICAL = "https://mapservices.weather.noaa.gov/tropical/rest/services";
const SPC = "https://www.spc.noaa.gov/products";
const WPC_ERO_SERVICE = `${NOAA_MAPS}/hazards/wpc_precip_hazards/MapServer`;
const CPC_HAZARDS_SERVICE = `${NOAA_MAPS}/hazards/cpc_weather_hazards/MapServer`;
const WSSI_SERVICE = `${NOAA_MAPS}/outlooks/wpc_wssi/MapServer`;
const DROUGHT_SERVICE = `${NOAA_MAPS}/outlooks/cpc_drought_outlk/MapServer`;
const NHC_TWO_SERVICE = `${NOAA_TROPICAL}/tropical/NHC_tropical_weather_summary/MapServer`;
// The SHARPpy backend contours NadoCast's GRIB2 into GeoJSON (see backend/nadocast_core.py).
import { BACKEND_BASE } from "./apiConfig";
const SOUNDING_BACKEND = BACKEND_BASE;

/**
 * The issuances of SPC's day 1-3 outlooks, by the time in their archive file
 * names -- the valid time the file is named for, not always the time it went
 * out: the 06Z day 1 outlook is "1200", valid from 12Z. All are filed under
 * the UTC date they were issued on (the 01Z update is the next date's "0100").
 * Read off the archive, 2026-09-24.
 */
export const SPC_ISSUANCES: Record<1 | 2 | 3, { time: string; label: string }[]> = {
  1: [
    { time: "0100", label: "01Z" },
    { time: "1200", label: "06Z" },
    { time: "1300", label: "13Z" },
    { time: "1630", label: "1630Z" },
    { time: "2000", label: "20Z" },
  ],
  2: [
    { time: "0600", label: "06Z" },
    { time: "1730", label: "1730Z" },
  ],
  3: [
    { time: "0730", label: "0730Z" },
    { time: "1930", label: "1930Z" },
  ],
};

function arcgisQueryUrl(service: string, layer: number): string {
  const params = new URLSearchParams({
    f: "geojson",
    where: "1=1",
    outFields: "*",
    returnGeometry: "true",
    outSR: "4326",
    geometryPrecision: "4",
    resultRecordCount: "2000",
  });
  return `${service}/${layer}/query?${params.toString()}`;
}

function li(label: string, color: string, section?: string): OutlookLegendItem {
  return { label, color, ...(section ? { section } : {}) };
}

function prop(props: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = props[key] ?? props[key.toUpperCase()] ?? props[key.toLowerCase()];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function str(props: Record<string, unknown>, ...keys: string[]): string | null {
  const value = prop(props, ...keys);
  return value === null ? null : String(value);
}

function num(props: Record<string, unknown>, ...keys: string[]): number {
  const value = prop(props, ...keys);
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : 0;
}

/** A feature that draws nothing: SPC's "No areas" placeholder carries an empty
 *  geometry collection, and a MapServer can return null geometry. */
function hasShape(f: GeoJSON.Feature): boolean {
  const g = f.geometry as GeoJSON.Geometry | null;
  if (!g) return false;
  if (g.type === "GeometryCollection") return g.geometries.length > 0;
  return "coordinates" in g && Array.isArray(g.coordinates) && g.coordinates.length > 0;
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/**
 * SPC's own fills, read from its archived outlooks (spring 2026). Each file
 * carries its colours, so these are only the legend -- and the fallback for a
 * level no file on hand has shown (60% tornado; wind's 75 and 90%, new in
 * March 2026), which follow the scale's order.
 */
export const SPC_CATEGORICAL: { label: string; name: string; color: string; rank: number }[] = [
  { label: "TSTM", name: "Thunderstorms", color: "#C1E9C1", rank: 1 },
  { label: "MRGL", name: "Marginal", color: "#66A366", rank: 2 },
  { label: "SLGT", name: "Slight", color: "#FFE066", rank: 3 },
  { label: "ENH", name: "Enhanced", color: "#FFA366", rank: 4 },
  { label: "MDT", name: "Moderate", color: "#E06666", rank: 5 },
  { label: "HIGH", name: "High", color: "#FF66FF", rank: 6 },
];
const TORNADO_FILLS: [number, string][] = [
  [2, "#79BA7A"], [5, "#BD998A"], [10, "#FFE481"], [15, "#FF8080"], [30, "#FF7FFF"], [45, "#C895F6"], [60, "#7F9BFF"],
];
const SEVERE_FILLS: [number, string][] = [
  [5, "#C5A392"], [15, "#FFEB7F"], [30, "#FF7F7F"], [45, "#FF7FFF"], [60, "#C895F6"], [75, "#7F9BFF"], [90, "#6BCBF0"],
];
const DAY48_FILLS: [number, string][] = [[15, "#FFEB7F"], [30, "#E6C280"]];

/**
 * Conditional intensity, drawn rather than described. SPC publishes it as its
 * own layer beside each probability, in black -- ink for a hatch on white
 * paper, invisible over a dark basemap. These greys replace it; the hatch is
 * what marks a CIG area, not the colour.
 */
export const CIG_COLORS: Record<string, string> = {
  CIG1: "#d1d5db",
  CIG2: "#9ca3af",
  CIG3: "#6b7280",
};

const FIRE_WINDRH: [string, string, string][] = [
  ["ELEV", "Elevated", "#FFBF80"],
  ["CRIT", "Critical", "#FF7F7F"],
  ["EXTM", "Extremely critical", "#FF7FFF"],
];
const FIRE_DRYT: [string, string, string][] = [
  ["IDRT", "Isolated dry thunderstorms", "#E6C280"],
  ["SDRT", "Scattered dry thunderstorms", "#C08040"],
];

const ERO: [number, string, string][] = [
  [1, "Marginal (5%+)", "#38a800"],
  [2, "Slight (15%+)", "#fffe00"],
  [3, "Moderate (40%+)", "#f50000"],
  [4, "High (70%+)", "#ff69c5"],
];

/** CPC's shading: each category darker the more likely it is, in the bands
 *  CPC draws (33-40, 40-50, ... 90-100%). */
function cpcShade(cat: string, prob: number, kind: "temp" | "precip"): string {
  const above = kind === "temp"
    ? ["#fdd0a2", "#fdae6b", "#fd8d3c", "#f16913", "#d94801", "#a63603", "#7f2704"]
    : ["#c7e9c0", "#a1d99b", "#74c476", "#41ab5d", "#238b45", "#006d2c", "#00441b"];
  const below = kind === "temp"
    ? ["#c6dbef", "#9ecae1", "#6baed6", "#4292c6", "#2171b5", "#08519c", "#08306b"]
    : ["#f6e8c3", "#dfc27d", "#bf812d", "#a6611a", "#8c510a", "#6b3d07", "#543005"];
  const band = Math.max(0, Math.min(6, prob < 40 ? 0 : Math.floor((prob - 30) / 10)));
  const c = cat.toLowerCase();
  if (c.startsWith("a")) return above[band];
  if (c.startsWith("b")) return below[band];
  if (c.startsWith("n")) return "#b8b8b8";
  return "rgba(0,0,0,0)"; // equal chances: no colour
}

const WSSI: [string, string, string][] = [
  ["WINTER WEATHER AREA", "Winter weather area", "#c6dbef"],
  ["MINOR", "Minor", "#6baed6"],
  ["MODERATE", "Moderate", "#2171b5"],
  ["MAJOR", "Major", "#6a3d9a"],
  ["EXTREME", "Extreme", "#e7298a"],
];

const DROUGHT: [string, string, string][] = [
  ["Persistence", "Drought persists", "#9b7b56"],
  ["Development", "Drought develops", "#ffde63"],
  ["Improvement", "Drought improves", "#dedcaf"],
  ["Removal", "Drought removal likely", "#b3e0a6"],
];

const TROPICAL: [string, string, string][] = [
  ["Low", "Low (< 40%)", "#ffff00"],
  ["Medium", "Medium (40-60%)", "#ffa500"],
  ["High", "High (> 60%)", "#ff0000"],
];

function scaleColor(scale: [number, string][], value: number): string {
  let color = scale[0][1];
  for (const [at, c] of scale) if (value >= at) color = c;
  return color;
}

// ---------------------------------------------------------------------------
// Features, normalised
// ---------------------------------------------------------------------------

/**
 * Every outlook polygon, whatever it came from, carries the same few
 * properties for the map, the legend and the point query:
 *   color     fill colour
 *   label     what to call it ("SLGT", "15%", "Critical")
 *   rank      how severe, for ordering -- higher on top, and "worst at a point"
 *   prob      probability in %, when it is one
 *   cig       conditional intensity (hatched), and cigPattern its hatch image
 */
function feature(f: GeoJSON.Feature, props: Record<string, unknown>): GeoJSON.Feature {
  return { type: "Feature", geometry: f.geometry, properties: props };
}

function spcFeature(f: GeoJSON.Feature, scale: [number, string][] | null): GeoJSON.Feature | null {
  if (!hasShape(f)) return null;
  const p = (f.properties ?? {}) as Record<string, unknown>;
  const code = str(p, "LABEL") ?? "";
  const dn = num(p, "DN");
  const official = str(p, "fill");
  if (/^CIG\d$/.test(code)) {
    return feature(f, {
      label: code, name: `conditional intensity group ${code.slice(3)}`, rank: 100 + Number(code.slice(3)),
      color: CIG_COLORS[code] ?? "#9ca3af", cig: true, cigPattern: `cig-hatch-${code.slice(3)}`,
    });
  }
  const cat = SPC_CATEGORICAL.find((c) => c.label === code);
  if (cat) {
    return feature(f, { label: code, name: `${cat.name} risk`, rank: cat.rank, color: official ?? cat.color, cig: false });
  }
  const prob = /^0?\.\d+$/.test(code) ? Math.round(Number.parseFloat(code) * 100) : dn;
  return feature(f, {
    label: `${prob}%`, name: "", rank: prob, prob,
    color: official ?? (scale ? scaleColor(scale, prob) : "#9ca3af"), cig: false,
  });
}

function fireFeature(f: GeoJSON.Feature, table: [string, string, string][]): GeoJSON.Feature | null {
  if (!hasShape(f)) return null;
  const p = (f.properties ?? {}) as Record<string, unknown>;
  const code = str(p, "LABEL") ?? "";
  const i = table.findIndex(([c]) => c === code);
  if (i < 0) return null;
  return feature(f, { label: table[i][1], name: str(p, "LABEL2") ?? table[i][1], rank: i + 1, color: str(p, "fill") ?? table[i][2], cig: false });
}

interface SpcMeta {
  valid: string | null;
  expire: string | null;
  issued: string | null;
  forecaster: string | null;
  note: string | null;
}

function spcMeta(data: GeoJSON.FeatureCollection): SpcMeta {
  const p = (data.features[0]?.properties ?? {}) as Record<string, unknown>;
  return {
    valid: str(p, "VALID_ISO"),
    expire: str(p, "EXPIRE_ISO"),
    issued: str(p, "ISSUE_ISO"),
    forecaster: str(p, "FORECASTER"),
    // SPC files a placeholder with no shape when it draws nothing, and says why.
    note: data.features.every((f) => !hasShape(f)) ? str(p, "LABEL") : null,
  };
}

// The same file is read by the map, the day strip and a point's breakdown
// within moments of each other: one request serves them for two minutes (an
// archived one does not change, so it is kept for the session).
const JSON_CACHE = new Map<string, { at: number; p: Promise<GeoJSON.FeatureCollection> }>();
const FRESH_MS = 120_000;

function getJson(url: string): Promise<GeoJSON.FeatureCollection> {
  const hit = JSON_CACHE.get(url);
  const archived = url.includes("/archive/");
  if (hit && (archived || Date.now() - hit.at < FRESH_MS)) return hit.p;
  const p = (async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(response.status === 404 ? "Not issued for that time" : `HTTP ${response.status}`);
    }
    return (await response.json()) as GeoJSON.FeatureCollection;
  })();
  JSON_CACHE.set(url, { at: Date.now(), p });
  p.catch(() => JSON_CACHE.delete(url));
  while (JSON_CACHE.size > 300) JSON_CACHE.delete(JSON_CACHE.keys().next().value as string);
  return p;
}

function collection(features: (GeoJSON.Feature | null)[]): GeoJSON.FeatureCollection {
  // Lowest first, so the worst area draws on top.
  const kept = features.filter((f): f is GeoJSON.Feature => f !== null);
  kept.sort((a, b) => Number(a.properties?.rank ?? 0) - Number(b.properties?.rank ?? 0));
  return { type: "FeatureCollection", features: kept };
}

// ---------------------------------------------------------------------------
// SPC convective outlooks, days 1-8 -- straight from SPC, newest or archived
// ---------------------------------------------------------------------------

const SPC_KIND: Record<Exclude<SpcOutlookType, "probabilistic">, { file: string; cig: string | null }> = {
  categorical: { file: "cat", cig: null },
  tornado: { file: "torn", cig: "cigtorn" },
  wind: { file: "wind", cig: "cigwind" },
  hail: { file: "hail", cig: "cighail" },
};

function spcUrl(day: SpcDay, file: string, when: OutlookWhen | null): string {
  if (day >= 4) {
    return when
      ? `${SPC}/exper/day4-8/archive/${when.date.slice(0, 4)}/day${day}prob_${when.date}.lyr.geojson`
      : `${SPC}/exper/day4-8/day${day}prob.lyr.geojson`;
  }
  return when && when.time
    ? `${SPC}/outlook/archive/${when.date.slice(0, 4)}/day${day}otlk_${when.date}_${when.time}_${file}.lyr.geojson`
    : `${SPC}/outlook/day${day}otlk_${file}.lyr.geojson`;
}

function spcLegend(type: SpcOutlookType, day: SpcDay): OutlookLegendItem[] {
  if (type === "categorical") return SPC_CATEGORICAL.map((c) => li(c.label, c.color, "Risk"));
  const cig = (groups: number) =>
    (["CIG1", "CIG2", "CIG3"] as const).slice(0, groups).map((g) => li(g, CIG_COLORS[g], "Conditional intensity"));
  if (type === "tornado") return [...TORNADO_FILLS.map(([p, c]) => li(`${p}%`, c, "Probability")), ...cig(3)];
  if (type === "wind") return [...SEVERE_FILLS.map(([p, c]) => li(`${p}%`, c, "Probability")), ...cig(3)];
  if (type === "hail") return [...SEVERE_FILLS.slice(0, 5).map(([p, c]) => li(`${p}%`, c, "Probability")), ...cig(2)];
  if (day >= 4) return DAY48_FILLS.map(([p, c]) => li(`${p}%`, c, "Any severe"));
  return [...SEVERE_FILLS.slice(0, 4).map(([p, c]) => li(`${p}%`, c, "Any severe")), ...cig(2)];
}

export async function spcOutlook(day: SpcDay, type: SpcOutlookType, when: OutlookWhen | null = null): Promise<OutlookResponse> {
  const legend = spcLegend(type, day);
  let main: string;
  let cig: string | null;
  let scale: [number, string][] | null;
  if (type === "probabilistic") {
    main = "prob";
    cig = day === 3 ? "cigprob" : null;
    scale = day >= 4 ? DAY48_FILLS : SEVERE_FILLS;
  } else {
    if (day > 3 || (day === 3 && type !== "categorical")) throw new Error(`No SPC ${type} outlook for day ${day}`);
    ({ file: main, cig } = SPC_KIND[type]);
    scale = type === "tornado" ? TORNADO_FILLS : type === "categorical" ? null : SEVERE_FILLS;
  }
  const data = await getJson(spcUrl(day, main, when));
  const features = data.features.map((f) => spcFeature(f, scale));
  // Conditional intensity is empty most days and is only its own file from
  // March 2026 -- an older archive has none -- so it never takes the outlook
  // down with it.
  if (cig) {
    try {
      const extra = await getJson(spcUrl(day, cig, when));
      features.push(...extra.features.map((f) => spcFeature(f, null)));
    } catch {
      /* the probabilities stand alone */
    }
  }
  const meta = spcMeta(data);
  return { source: "NOAA SPC", stale: false, error: null, ...meta, legend, geojson: collection(features) };
}

/**
 * Which archive issuance an SPC outlook is, from its own times: day 1 files are
 * named for their valid time (the 06Z outlook is "1200"), days 2 and 3 for the
 * time they were issued. Null when the times do not say.
 */
export function spcIssuanceOf(day: SpcDay, valid: string | null, issued: string | null): OutlookWhen | null {
  if (day >= 4) {
    if (!issued) return null;
    const t = new Date(issued);
    return { date: ymd(t), time: null };
  }
  const at = day === 1 ? valid : issued;
  if (!at) return null;
  const t = new Date(at);
  if (Number.isNaN(t.getTime())) return null;
  const minutes = t.getUTCHours() * 60 + t.getUTCMinutes();
  const list = SPC_ISSUANCES[day as 1 | 2 | 3];
  let best = list[0];
  for (const x of list) {
    const m = Number(x.time.slice(0, 2)) * 60 + Number(x.time.slice(2));
    const b = Number(best.time.slice(0, 2)) * 60 + Number(best.time.slice(2));
    if (Math.abs(m - minutes) < Math.abs(b - minutes)) best = x;
  }
  return { date: ymd(t), time: best.time };
}

function ymd(t: Date): string {
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** The issuance before this one: the one before it that day, or the last of
 *  the day before. Days 4-8 go out once a day. */
export function previousIssuance(day: SpcDay, when: OutlookWhen): OutlookWhen {
  const back = (date: string) => {
    const t = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)) - 86_400_000);
    return ymd(t);
  };
  if (day >= 4 || !when.time) return { date: back(when.date), time: null };
  const list = SPC_ISSUANCES[day as 1 | 2 | 3];
  const i = list.findIndex((x) => x.time === when.time);
  if (i > 0) return { date: when.date, time: list[i - 1].time };
  return { date: back(when.date), time: list[list.length - 1].time };
}

/** The outlook discussion for a day and issuance, as plain text. */
export async function spcDiscussion(day: SpcDay | "fire1" | "fire2" | "fire38", when: OutlookWhen | null): Promise<string> {
  let url: string;
  if (day === "fire1") url = `${SPC}/fire_wx/fwdy1.html`;
  else if (day === "fire2") url = `${SPC}/fire_wx/fwdy2.html`;
  else if (day === "fire38") url = `${SPC}/exper/fire_wx/`;
  else if (day >= 4) url = `${SPC}/exper/day4-8/`;
  else if (when && when.time) url = `${SPC}/outlook/archive/${when.date.slice(0, 4)}/day${day}otlk_${when.date}_${when.time}.html`;
  else url = `${SPC}/outlook/day${day}otlk.html`;
  // Once more on a dropped connection: SPC's server is slow to answer at times.
  const response = await fetch(url).catch(() => new Promise<Response>((r) => setTimeout(() => r(fetch(url)), 1500)));
  if (!response.ok) throw new Error(response.status === 404 ? "No discussion for that time" : `HTTP ${response.status}`);
  const html = await response.text();
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(html);
  if (!pre) throw new Error("No discussion in the page");
  const doc = new DOMParser().parseFromString(`<pre>${pre[1]}</pre>`, "text/html");
  // Without the transmission wrapper (ZCZC ... NNNN, the AWIPS and WMO ids).
  const lines = (doc.body.textContent ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => !/^\s*(ZCZC|NNNN|[A-Z0-9]{6,9}\s+ALL\s*$|[A-Z]{4}\d{2}\s+[A-Z]{4}\s+\d{6}\s*$)/.test(l));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** SPC's fire weather outlook, days 1 and 2 -- wind/RH or dry thunderstorms. */
export async function spcFire(day: 1 | 2, type: SpcFireType): Promise<OutlookResponse> {
  const table = type === "windrh" ? FIRE_WINDRH : FIRE_DRYT;
  const data = await getJson(`${SPC}/fire_wx/day${day}fw_${type}.lyr.geojson`);
  return {
    source: "NOAA SPC",
    stale: false,
    error: null,
    ...spcMeta(data),
    legend: table.map(([, name, color]) => li(name, color, type === "windrh" ? "Wind / RH" : "Dry thunderstorms")),
    geojson: collection(data.features.map((f) => fireFeature(f, table))),
  };
}

// ---------------------------------------------------------------------------
// WPC, CPC and NHC -- through NOAA's MapServer
// ---------------------------------------------------------------------------

/**
 * The services' times, as ISO -- each writes its own way: epoch milliseconds
 * (CPC), "2026-09-25 16:06:00" (WPC, UTC), "2026-09-25 1815Z" and
 * "18Z 09/25/26" (the WSSI). Anything else ("Sep 2026", "OND 2026") is a
 * period, not an instant, and is passed on as written.
 */
function msTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value !== "string" || !value) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):?(\d{2})(?::(\d{2}))?Z?$/.exec(value.trim());
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0))).toISOString();
  m = /^(\d{2})Z (\d{2})\/(\d{2})\/(\d{2})$/.exec(value.trim());
  if (m) return new Date(Date.UTC(2000 + +m[4], +m[2] - 1, +m[3], +m[1])).toISOString();
  if (/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value.trim())) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return value;
}

async function mapServer(
  service: string,
  layers: number[],
  shape: (f: GeoJSON.Feature, p: Record<string, unknown>) => GeoJSON.Feature | null,
  legend: OutlookLegendItem[],
  source: string,
  times: { valid: string[]; expire: string[]; issued: string[] },
): Promise<OutlookResponse> {
  const parts = await Promise.all(layers.map((layer) => getJson(arcgisQueryUrl(service, layer))));
  const all = parts.flatMap((p) => p.features);
  const first = (all[0]?.properties ?? {}) as Record<string, unknown>;
  const pick = (keys: string[]) => msTime(prop(first, ...keys));
  return {
    source,
    stale: false,
    error: null,
    valid: pick(times.valid),
    expire: pick(times.expire),
    issued: pick(times.issued),
    legend,
    geojson: collection(all.map((f) => (hasShape(f) ? shape(f, (f.properties ?? {}) as Record<string, unknown>) : null))),
  };
}

/** WPC's Excessive Rainfall Outlook, days 1-5. */
export function wpcEro(day: 1 | 2 | 3 | 4 | 5): Promise<OutlookResponse> {
  return mapServer(
    WPC_ERO_SERVICE,
    [day - 1],
    (f, p) => {
      const dn = num(p, "dn");
      const row = ERO.find(([d]) => d === dn);
      return row ? feature(f, { label: row[1].split(" ")[0], name: str(p, "outlook") ?? row[1], rank: dn, color: row[2], cig: false }) : null;
    },
    ERO.map(([, name, color]) => li(name, color, "Risk of rain exceeding flash flood guidance")),
    "NOAA WPC",
    { valid: ["start_time"], expire: ["end_time"], issued: ["issue_time"] },
  );
}

/** WPC's Winter Storm Severity Index, overall impact, days 1-3. */
export function wpcWssi(day: 1 | 2 | 3): Promise<OutlookResponse> {
  return mapServer(
    WSSI_SERVICE,
    [day],
    (f, p) => {
      const impact = (str(p, "impact") ?? "").toUpperCase();
      const i = WSSI.findIndex(([code]) => code === impact);
      return i < 0 ? null : feature(f, { label: WSSI[i][1], name: `${WSSI[i][1]} impacts`, rank: i + 1, color: WSSI[i][2], cig: false });
    },
    WSSI.map(([, name, color]) => li(name, color, "Expected impacts")),
    "NOAA WPC",
    { valid: ["start_time"], expire: ["end_time"], issued: ["issue_time"] },
  );
}

/** CPC outlooks: the 3-7 and 8-14 day hazards, and temperature / precipitation
 *  probabilities for 6-10 and 8-14 days, the next month and the next season. */
export function cpcOutlook(type: CpcOutlookType, period: CpcPeriod): Promise<OutlookResponse> {
  if (type === "hazards") {
    // Days 8-14 from CPC's own files: NOAA's MapServer keeps those layers but
    // has them empty since CPC went to probabilistic hazards (backend/cpc_hazards.py).
    if (period === "8-14") return cpcHazards814();
    return mapServer(
      CPC_HAZARDS_SERVICE,
      [1, 4, 7],
      (f, p) => {
        const day = (v: unknown) => (typeof v === "number" ? new Date(v).toISOString().slice(0, 10) : null);
        return hazardFeature(f, str(p, "label") ?? "Hazard", day(prop(p, "start_date")), day(prop(p, "end_date")));
      },
      HAZARD_LEGEND,
      "NOAA WPC / CPC",
      { valid: ["start_date", "valid_time"], expire: ["end_date"], issued: ["fcst_date", "issue_time"] },
    );
  }
  const kind = type === "temperature" ? "temp" : "precip";
  const service = period === "monthly"
    ? `${NOAA_MAPS}/outlooks/cpc_mthly_${kind}_outlk/MapServer`
    : period === "seasonal"
      ? `${NOAA_MAPS}/outlooks/cpc_sea_${kind}_outlk/MapServer`
      : `${NOAA_MAPS}/outlooks/cpc_${period === "6-10" ? "6_10" : "8_14"}_day_outlk/MapServer`;
  const layer = period === "6-10" || period === "8-14" ? (type === "temperature" ? 0 : 1) : 0;
  const words = type === "temperature" ? ["Above", "Below"] : ["Above", "Below"];
  return mapServer(
    service,
    [layer],
    (f, p) => {
      const cat = str(p, "cat") ?? "EC";
      const prob = num(p, "prob");
      if (/^ec$/i.test(cat)) return null; // equal chances: nothing drawn
      const name = `${prob.toFixed(0)}% ${cat.toLowerCase().startsWith("a") ? "above" : cat.toLowerCase().startsWith("b") ? "below" : "near"} normal`;
      return feature(f, { label: `${cat} ${prob.toFixed(0)}%`, name, rank: prob, prob, color: cpcShade(cat, prob, kind), cig: false });
    },
    words.flatMap((w) => [40, 50, 60, 70].map((p) => li(`${w} ${p}%`, cpcShade(w, p, kind), w === "Above" ? `Above normal` : `Below normal`))),
    "NOAA CPC",
    { valid: ["start_date", "valid_seas"], expire: ["end_date"], issued: ["fcst_date"] },
  );
}

const HAZARD_LEGEND: OutlookLegendItem[] = [
  li("Heat", "#ef4444"), li("Cold", "#3b82f6"), li("Heavy rain / flooding", "#22c55e"), li("Heavy snow", "#a5b4fc"),
  li("High wind / waves", "#8b5cf6"), li("Wildfire / drought", "#f97316"),
];

/** A hazard area, coloured by what it is and ranked by its risk level. */
function hazardFeature(f: GeoJSON.Feature, label: string, start: string | null, end: string | null): GeoJSON.Feature {
  const lower = label.toLowerCase();
  const color = lower.includes("heat") || lower.includes("above normal temp") ? "#ef4444"
    : lower.includes("cold") || lower.includes("below normal temp") || lower.includes("freez") ? "#3b82f6"
    : lower.includes("precip") || lower.includes("rain") || lower.includes("flood") ? "#22c55e"
    : lower.includes("snow") ? "#a5b4fc"
    : lower.includes("wind") || lower.includes("wave") ? "#8b5cf6"
    : lower.includes("fire") || lower.includes("drought") || lower.includes("soil") ? "#f97316"
    : "#9ca3af";
  const rank = lower.includes("high risk") ? 3 : lower.includes("moderate risk") ? 2 : 1;
  const day = (d: string | null) => (d ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) : "");
  const from = day(start);
  const to = day(end);
  const span = from && to && from !== to ? `${from} - ${to}` : from;
  return feature(f, { label, name: span, rank, color, cig: false });
}

async function cpcHazards814(): Promise<OutlookResponse> {
  const res = await fetch(`${SOUNDING_BACKEND}/api/outlooks/cpc-hazards`);
  if (!res.ok) throw new Error(`CPC hazards HTTP ${res.status}`);
  const data = (await res.json()) as GeoJSON.FeatureCollection & { issued?: string | null };
  const iso = (d: unknown) => (typeof d === "string" && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null);
  const features = data.features.map((f) => {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    return hazardFeature(f, String(p.label ?? "Hazard"), iso(p.start), iso(p.end));
  });
  const starts = data.features.map((f) => iso((f.properties as Record<string, unknown>)?.start)).filter(Boolean).sort();
  const ends = data.features.map((f) => iso((f.properties as Record<string, unknown>)?.end)).filter(Boolean).sort();
  return {
    source: "NOAA CPC",
    stale: false,
    error: null,
    issued: data.issued ?? null,
    valid: starts[0] ? `${starts[0]}T00:00:00Z` : null,
    expire: ends.length ? `${ends[ends.length - 1]}T00:00:00Z` : null,
    legend: HAZARD_LEGEND,
    geojson: collection(features),
  };
}

/** CPC's drought outlook, for the month or the season. */
export function cpcDrought(period: "monthly" | "seasonal"): Promise<OutlookResponse> {
  return mapServer(
    DROUGHT_SERVICE,
    [period === "monthly" ? 1 : 4],
    (f, p) => {
      const outlook = str(p, "outlook") ?? "";
      const i = DROUGHT.findIndex(([code]) => outlook.toLowerCase().startsWith(code.toLowerCase().slice(0, 5)));
      return i < 0 ? null : feature(f, { label: DROUGHT[i][1], name: `${DROUGHT[i][1]} (${str(p, "target") ?? ""})`, rank: i + 1, color: DROUGHT[i][2], cig: false });
    },
    DROUGHT.map(([, name, color]) => li(name, color, "Drought")),
    "NOAA CPC",
    { valid: ["target"], expire: [], issued: ["fcst_date"] },
  );
}

/** NHC's graphical tropical weather outlook: where a system may form in 7 days. */
export function nhcTropicalOutlook(): Promise<OutlookResponse> {
  return mapServer(
    NHC_TWO_SERVICE,
    [3],
    (f, p) => {
      const risk = str(p, "risk7day") ?? "Low";
      const i = TROPICAL.findIndex(([code]) => code === risk);
      const prob7 = str(p, "prob7day") ?? "";
      const prob2 = str(p, "prob2day") ?? "";
      return feature(f, {
        label: `${prob7} 7-day`, name: `${risk} chance of formation: ${prob2} in 2 days, ${prob7} in 7 days (${str(p, "basin") ?? ""})`,
        rank: Math.max(0, i) + 1, prob: Number.parseFloat(prob7) || 0, color: TROPICAL[Math.max(0, i)][2], cig: false,
      });
    },
    TROPICAL.map(([, name, color]) => li(name, color, "Chance of formation, 7 days")),
    "NOAA NHC",
    { valid: [], expire: [], issued: [] },
  );
}

/** NadoCast as a native vector outlook: the backend finds the latest GRIB2,
 *  contours it at the SPC probability thresholds, and returns GeoJSON polygons. */
export async function nadoCastVector(
  hazard: NadoCastHazard,
  model: "auto" | "2024" | "2022" = "auto",
): Promise<OutlookResponse> {
  const url = `${SOUNDING_BACKEND}/api/nadocast?hazard=${encodeURIComponent(hazard)}&model=${model}`;
  const res = await fetch(url);
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
  const data = (await res.json()) as {
    source?: string;
    stale?: boolean;
    error?: string | null;
    run?: string | null;
    valid?: string | null;
    expire?: string | null;
    legend?: OutlookLegendItem[];
    geojson?: GeoJSON.FeatureCollection;
  };
  const features = (data.geojson?.features ?? []).map((f) => {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    const prob = num(p, "dn", "prob");
    return feature(f, { ...p, label: `${prob}%`, name: `${prob}% probability`, rank: prob, prob, color: str(p, "color", "fill") ?? scaleColor(TORNADO_FILLS, prob), cig: false });
  });
  return {
    source: data.source ?? "NadoCast",
    stale: Boolean(data.stale),
    error: data.error ?? null,
    run: data.run ?? null,
    valid: data.valid ?? null,
    expire: data.expire ?? null,
    legend: data.legend ?? [],
    geojson: collection(features),
  };
}

// ---------------------------------------------------------------------------
// At a point
// ---------------------------------------------------------------------------

function ringContains(ring: GeoJSON.Position[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygonContains(rings: GeoJSON.Position[][], x: number, y: number): boolean {
  if (!rings.length || !ringContains(rings[0], x, y)) return false;
  for (let k = 1; k < rings.length; k++) if (ringContains(rings[k], x, y)) return false;
  return true;
}

export function geometryContains(g: GeoJSON.Geometry | null, lon: number, lat: number): boolean {
  if (!g) return false;
  if (g.type === "Polygon") return polygonContains(g.coordinates, lon, lat);
  if (g.type === "MultiPolygon") return g.coordinates.some((poly) => polygonContains(poly, lon, lat));
  if (g.type === "GeometryCollection") return g.geometries.some((x) => geometryContains(x, lon, lat));
  return false;
}

/** The areas of an outlook a point is in, worst first: the probability or
 *  category, and the conditional intensity on top of it if any. */
export function outlookAt(fc: GeoJSON.FeatureCollection | undefined, lon: number, lat: number): {
  top: Record<string, unknown> | null;
  cig: Record<string, unknown> | null;
} {
  let top: Record<string, unknown> | null = null;
  let cig: Record<string, unknown> | null = null;
  for (const f of fc?.features ?? []) {
    if (!geometryContains(f.geometry, lon, lat)) continue;
    const p = (f.properties ?? {}) as Record<string, unknown>;
    if (p.cig) {
      if (!cig || Number(p.rank) > Number(cig.rank)) cig = p;
    } else if (!top || Number(p.rank) > Number(top.rank)) {
      top = p;
    }
  }
  return { top, cig };
}
