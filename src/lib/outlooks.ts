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
  run?: string | null;
  legend: OutlookLegendItem[];
  geojson: GeoJSON.FeatureCollection;
}

export type SpcOutlookType = "categorical" | "tornado" | "wind" | "hail" | "probabilistic";
export type SpcDay = 1 | 2 | 3 | 4 | 5;
export type CpcOutlookType = "hazards" | "temperature" | "precipitation";
export type CpcPeriod = "3-7" | "6-10" | "8-14";
export type NadoCastHazard = "tornado" | "wind" | "hail" | "sig-tornado";

const NOAA_MAPS = "https://mapservices.weather.noaa.gov/vector/rest/services";
const SPC_SERVICE = `${NOAA_MAPS}/outlooks/SPC_wx_outlks/MapServer`;
const WPC_ERO_SERVICE = `${NOAA_MAPS}/hazards/wpc_precip_hazards/MapServer`;
const CPC_HAZARDS_SERVICE = `${NOAA_MAPS}/hazards/cpc_weather_hazards/MapServer`;
// The SHARPpy backend contours NadoCast's GRIB2 into GeoJSON (see backend/nadocast_core.py).
import { BACKEND_BASE } from './apiConfig';
const SOUNDING_BACKEND = BACKEND_BASE;

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

function firstString(props: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = props[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}

function firstNumber(props: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = props[key];
    if (typeof value === "number") return value;
  }
  return 0;
}

function li(label: string, color: string, section?: string): OutlookLegendItem {
  return { label, color, ...(section ? { section } : {}) };
}

function hashColor(value: string): string {
  const colors = ["#0ea5e9", "#14b8a6", "#84cc16", "#f97316", "#eab308", "#ef4444", "#8b5cf6", "#64748b"];
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}

function probColor(dn: number): string {
  if (dn <= 2) return "#79BA7A";
  if (dn <= 5) return "#BD998A";
  if (dn <= 10) return "#FFE481";
  if (dn <= 15) return "#E89B38";
  if (dn <= 30) return "#D15F5F";
  return "#C653C6";
}

/**
 * Conditional intensity, drawn rather than described.
 *
 * SPC publishes these as separate layers -- "Day 1 Tornado Conditional
 * Intensity" beside "Day 1 Probabilistic Tornado Outlook" -- and this file
 * only ever asked for the probabilistic half. The legend listed CIG anyway, so
 * every outlook advertised a thing it never drew.
 *
 * The service's own colours for them are black and near-black, which is a
 * sensible ink for a hatch printed on white paper and invisible over a dark
 * basemap. These greys replace them; the hatch pattern is what distinguishes a
 * CIG area from a probability area, not the fill.
 */
export const CIG_COLORS: Record<string, string> = {
  CIG1: "#d1d5db",
  CIG2: "#9ca3af",
  CIG3: "#6b7280",
};

/**
 * How many groups a product actually has, which is not the same everywhere:
 * the service declares three for tornado and wind, two for hail and for the
 * day 3 severe layer. Listing three on all of them advertised a CIG3 that does
 * not exist for half the outlooks.
 */
function cigLegend(groups: 2 | 3): OutlookLegendItem[] {
  return (["CIG1", "CIG2", "CIG3"] as const)
    .slice(0, groups)
    .map((g) => li(g, CIG_COLORS[g], "Conditional intensity"));
}

function spcColor(label: string, dn: number): string {
  const exact: Record<string, string> = {
    TSTM: "#C1E9C1",
    MRGL: "#66A366",
    SLGT: "#FFE066",
    ENH: "#FFA366",
    MDT: "#E06666",
    HIGH: "#FF66FF",
  };
  return exact[label] ?? probColor(dn);
}

function wpcColor(dn: number): string {
  return ({ 1: "#38a800", 2: "#fffe00", 3: "#f50000", 4: "#ff69c5" } as Record<number, string>)[dn] ?? "#9ca3af";
}

function cpcColor(kind: string, label: string): string {
  if (kind === "cpc_temp") {
    if (label.includes("Below")) return "#3b82f6";
    if (label.includes("Above")) return "#ef4444";
    return "#d1d5db";
  }
  if (kind === "cpc_precip") {
    if (label.includes("Below")) return "#a16207";
    if (label.includes("Above")) return "#22c55e";
    return "#d1d5db";
  }
  const lower = label.toLowerCase();
  if (lower.includes("heat") || lower.includes("cold") || lower.includes("temperature")) return "#ef4444";
  if (lower.includes("precip") || lower.includes("flood") || lower.includes("snow")) return "#22c55e";
  if (lower.includes("wild") || lower.includes("drought")) return "#f97316";
  if (lower.includes("wind") || lower.includes("wave")) return "#8b5cf6";
  return hashColor(label);
}

function normalizeGeojson(data: GeoJSON.FeatureCollection, kind: string): {
  geojson: GeoJSON.FeatureCollection;
  valid: string | null;
  expire: string | null;
} {
  let valid: string | null = null;
  let expire: string | null = null;
  const features = data.features.map((feature) => {
    const props = { ...(feature.properties ?? {}) } as Record<string, unknown>;
    const dn = firstNumber(props, ["dn", "prob"]);
    const label = firstString(props, ["label2", "outlook", "label", "cat", "prob"]) ?? "Outlook";
    // The short label is the group ("CIG1"); label2 is a sentence about it.
    // `dn` is NOT the group number on these -- a CIG1 polygon arrived with
    // dn 2 -- so the group has to come from the label.
    const cigGroup = firstString(props, ["label"]) ?? "";
    const isCig = /^CIG\d$/.test(cigGroup);
    const featureValid = firstString(props, ["valid", "valid_time", "start_time", "start_date"]);
    const featureExpire = firstString(props, ["expire", "end_time", "end_date"]);
    const color =
      kind === "spc"
        ? isCig
          ? (CIG_COLORS[cigGroup] ?? "#9ca3af")
          : typeof props.fill === "string"
            ? props.fill
            : spcColor(label, dn)
        : kind === "wpc"
          ? wpcColor(dn)
          : kind.startsWith("cpc_")
            ? cpcColor(kind, label)
            : hashColor(label);

    if (!valid) valid = featureValid;
    if (!expire) expire = featureExpire;
    return {
      ...feature,
      properties: {
        ...props,
        dn,
        label,
        color,
        // Read by the map module to decide between a wash and a hatch, and
        // which of the three hatches to use.
        cig: isCig,
        cigPattern: isCig ? `cig-hatch-${cigGroup.slice(3)}` : null,
        ...(featureValid ? { valid: featureValid } : {}),
        ...(featureExpire ? { expire: featureExpire } : {}),
      },
    };
  });
  return { geojson: { type: "FeatureCollection", features }, valid, expire };
}

function spcLegend(kind: SpcOutlookType, day: SpcDay): OutlookLegendItem[] {
  if (kind === "categorical") {
    return [
      li("TSTM", "#C1E9C1", "Risk"),
      li("MRGL", "#66A366", "Risk"),
      li("SLGT", "#FFE066", "Risk"),
      li("ENH", "#FFA366", "Risk"),
      li("MDT", "#E06666", "Risk"),
      li("HIGH", "#FF66FF", "Risk"),
    ];
  }
  if (kind === "tornado") {
    return [
      li("2%", "#79BA7A", "Probability"),
      li("5%", "#BD998A", "Probability"),
      li("10%", "#FFE481", "Probability"),
      li("15%", "#E89B38", "Probability"),
      li("30%", "#D15F5F", "Probability"),
      li("45%", "#C653C6", "Probability"),
      li("60%", "#912CEE", "Probability"),
      ...cigLegend(3),
    ];
  }
  if (kind === "wind" || kind === "hail") {
    return [
      li("5%", "#BD998A", "Probability"),
      li("15%", "#E89B38", "Probability"),
      li("30%", "#D15F5F", "Probability"),
      li("45%", "#C653C6", "Probability"),
      li("60%", "#912CEE", "Probability"),
      // Hail is the one probabilistic product with only two groups.
      ...cigLegend(kind === "hail" ? 2 : 3),
    ];
  }
  if (day >= 4) {
    // Days 4-8 are probability only -- the service publishes no conditional
    // intensity that far out, so promising one in the legend would be a lie.
    return [li("15%", "#E89B38", "Probability"), li("30%", "#D15F5F", "Probability")];
  }
  return [
    li("5%", "#BD998A", "Probability"),
    li("15%", "#E89B38", "Probability"),
    li("30%", "#D15F5F", "Probability"),
    ...cigLegend(2),
  ];
}

const wpcLegend = () => [li("Marginal", "#38a800"), li("Slight", "#fffe00"), li("Moderate", "#f50000"), li("High", "#ff69c5")];
const cpcTempLegend = () => [li("Below", "#3b82f6"), li("Normal", "#d1d5db"), li("Above", "#ef4444")];
const cpcPrecipLegend = () => [li("Below", "#a16207"), li("Normal", "#d1d5db"), li("Above", "#22c55e")];
const cpcHazardLegend = () => [
  li("Heat", "#ef4444"),
  li("Precip", "#22c55e"),
  li("Wildfire/Drought", "#f97316"),
  li("Wind/Waves", "#8b5cf6"),
];

async function fetchOutlook(url: string, source: string, kind: string, legend: OutlookLegendItem[]): Promise<OutlookResponse> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${source} HTTP ${response.status}`);
  const raw = (await response.json()) as GeoJSON.FeatureCollection;
  const normalized = normalizeGeojson(raw, kind);
  return {
    source,
    stale: false,
    error: null,
    valid: normalized.valid,
    expire: normalized.expire,
    legend,
    geojson: normalized.geojson,
  };
}

/**
 * The service layers an outlook is made of.
 *
 * `cig` is the conditional intensity layer that sits beside the probabilistic
 * one -- a separate layer in the MapServer, which is why fetching only `main`
 * left it permanently missing. Categorical outlooks have no CIG counterpart,
 * and neither do days 4 and beyond.
 */
function spcLayers(day: SpcDay, kind: SpcOutlookType): { main: number; cig: number | null } {
  if (day === 1) {
    const pair = { categorical: [1, null], tornado: [3, 2], hail: [5, 4], wind: [7, 6] }[
      kind as Exclude<SpcOutlookType, "probabilistic">
    ];
    if (pair) return { main: pair[0] as number, cig: pair[1] as number | null };
  }
  if (day === 2) {
    const pair = { categorical: [9, null], tornado: [11, 10], hail: [13, 12], wind: [15, 14] }[
      kind as Exclude<SpcOutlookType, "probabilistic">
    ];
    if (pair) return { main: pair[0] as number, cig: pair[1] as number | null };
  }
  if (day === 3 && kind === "categorical") return { main: 17, cig: null };
  if (day === 3 && kind === "probabilistic") return { main: 19, cig: 18 };
  if (day === 4 && kind === "probabilistic") return { main: 21, cig: null };
  if (day === 5 && kind === "probabilistic") return { main: 22, cig: null };
  throw new Error(`Unsupported SPC outlook: ${kind} Day ${day}`);
}

function cpcConfig(kind: CpcOutlookType, period: CpcPeriod): {
  service: string;
  layers: number[];
  sourceKind: string;
  legend: OutlookLegendItem[];
} {
  if (kind === "hazards") {
    if (period === "3-7") return { service: CPC_HAZARDS_SERVICE, layers: [1, 4, 7], sourceKind: "cpc_hazards", legend: cpcHazardLegend() };
    return { service: CPC_HAZARDS_SERVICE, layers: [3, 6, 8], sourceKind: "cpc_hazards", legend: cpcHazardLegend() };
  }
  if (kind === "temperature") {
    return {
      service: `${NOAA_MAPS}/outlooks/cpc_${period === "6-10" ? "6_10" : "8_14"}_day_outlk/MapServer`,
      layers: [0],
      sourceKind: "cpc_temp",
      legend: cpcTempLegend(),
    };
  }
  return {
    service: `${NOAA_MAPS}/outlooks/cpc_${period === "6-10" ? "6_10" : "8_14"}_day_outlk/MapServer`,
    layers: [1],
    sourceKind: "cpc_precip",
    legend: cpcPrecipLegend(),
  };
}

export async function spcOutlook(day: SpcDay, type: SpcOutlookType): Promise<OutlookResponse> {
  const { main, cig } = spcLayers(day, type);
  const legend = spcLegend(type, day);
  const outlook = await fetchOutlook(arcgisQueryUrl(SPC_SERVICE, main), "NOAA SPC", "spc", legend);
  if (cig === null) return outlook;

  // The conditional intensity layer is empty on most days -- it is only issued
  // when SPC expects significant severe -- so a failure here must not take the
  // outlook itself down. An outlook with no hatching is the normal case; an
  // outlook that failed to load because its optional half did is not.
  try {
    const extra = await fetchOutlook(arcgisQueryUrl(SPC_SERVICE, cig), "NOAA SPC", "spc", legend);
    outlook.geojson.features.push(...extra.geojson.features);
  } catch {
    /* keep the probabilities */
  }
  return outlook;
}

export function wpcEro(day: 1 | 2 | 3): Promise<OutlookResponse> {
  return fetchOutlook(arcgisQueryUrl(WPC_ERO_SERVICE, day - 1), "NOAA WPC", "wpc", wpcLegend());
}

export function cpcOutlook(type: CpcOutlookType, period: CpcPeriod): Promise<OutlookResponse> {
  const cfg = cpcConfig(type, period);
  return Promise.all(cfg.layers.map((layer) => fetchOutlook(arcgisQueryUrl(cfg.service, layer), "NOAA CPC", cfg.sourceKind, []))).then(
    (responses) => ({
      source: "NOAA CPC",
      stale: false,
      error: null,
      valid: responses.find((r) => r.valid)?.valid ?? null,
      expire: responses.find((r) => r.expire)?.expire ?? null,
      legend: cfg.legend,
      geojson: {
        type: "FeatureCollection",
        features: responses.flatMap((r) => r.geojson.features),
      },
    }),
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
  return {
    source: data.source ?? "NadoCast",
    stale: Boolean(data.stale),
    error: data.error ?? null,
    run: data.run ?? null,
    valid: data.valid ?? null,
    expire: data.expire ?? null,
    legend: data.legend ?? [],
    geojson: data.geojson ?? { type: "FeatureCollection", features: [] },
  };
}
