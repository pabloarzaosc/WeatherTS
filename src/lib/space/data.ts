/**
 * Readers for every SWPC product the Space Weather dashboard shows: each turns
 * one or two SWPC files into plain series (ms time, value) or small records.
 * The file formats were checked against the live service in October 2026.
 */
import { BACKEND_BASE } from "../apiConfig";
import { swpcGet, swpcUrl, tagMs } from "./swpc";

/** A time series: ms since epoch, value (NaN where missing). */
export interface Series {
  t: Float64Array;
  v: Float64Array;
}

const H = 3_600_000;
const DAY = 24 * H;

function series(rows: { t: number; v: number | null | undefined }[]): Series {
  rows.sort((a, b) => a.t - b.t);
  const t = new Float64Array(rows.length);
  const v = new Float64Array(rows.length);
  rows.forEach((r, i) => {
    t[i] = r.t;
    v[i] = r.v == null || !Number.isFinite(r.v) ? NaN : r.v;
  });
  return { t, v };
}

function pick<T>(rows: T[], tOf: (r: T) => number, vOf: (r: T) => number | null | undefined): Series {
  return series(rows.map((r) => ({ t: tOf(r), v: vOf(r) })));
}

/** The time window a range id covers, ending now. */
export type RangeId = "2h" | "6h" | "1d" | "3d" | "7d";
export const RANGES: { id: RangeId; label: string; ms: number }[] = [
  { id: "2h", label: "2H", ms: 2 * H },
  { id: "6h", label: "6H", ms: 6 * H },
  { id: "1d", label: "1D", ms: DAY },
  { id: "3d", label: "3D", ms: 3 * DAY },
  { id: "7d", label: "7D", ms: 7 * DAY },
];
export const rangeMs = (r: RangeId) => RANGES.find((x) => x.id === r)!.ms;

/** GOES files come in 6-hour, 1-day, 3-day and 7-day lengths: the shortest that covers the range. */
function goesSpan(r: RangeId): string {
  return r === "2h" || r === "6h" ? "6-hour" : r === "1d" ? "1-day" : r === "3d" ? "3-day" : "7-day";
}

// ---------------------------------------------------------------- NOAA scales

export interface ScaleNow {
  R: number;
  S: number;
  G: number;
}
export interface ScaleDay {
  date: string;
  rMinor: number | null;
  rMajor: number | null;
  sProb: number | null;
  G: number;
}
export interface Scales {
  issued: number;
  now: ScaleNow;
  /** The highest level reached in the last 24 hours. */
  past24: ScaleNow;
  days: ScaleDay[];
}

type RawScale = {
  DateStamp: string;
  TimeStamp: string;
  R: { Scale: string | null; MinorProb: string | null; MajorProb: string | null };
  S: { Scale: string | null; Prob: string | null };
  G: { Scale: string | null };
};

const num = (s: string | null | undefined) => (s == null || s === "" ? null : Number(s));

export async function loadScales(): Promise<Scales> {
  const j = await swpcGet<Record<string, RawScale>>("/products/noaa-scales.json");
  const lvl = (r: RawScale): ScaleNow => ({ R: num(r.R.Scale) ?? 0, S: num(r.S.Scale) ?? 0, G: num(r.G.Scale) ?? 0 });
  return {
    issued: tagMs(`${j["0"].DateStamp}T${j["0"].TimeStamp}`),
    now: lvl(j["0"]),
    past24: lvl(j["-1"]),
    days: ["1", "2", "3"].map((k) => ({
      date: j[k].DateStamp,
      rMinor: num(j[k].R.MinorProb),
      rMajor: num(j[k].R.MajorProb),
      sProb: num(j[k].S.Prob),
      G: num(j[k].G.Scale) ?? 0,
    })),
  };
}

// ---------------------------------------------------------------- Kp, Dst

export interface KpBar {
  t: number;
  kp: number;
  kind: "observed" | "estimated" | "predicted";
}

/** Three-hour planetary Kp: the last week observed and estimated, and SWPC's forecast for the next three days. */
export async function loadKp3h(): Promise<KpBar[]> {
  const j = await swpcGet<{ time_tag: string; kp: number; observed: KpBar["kind"] }[]>(
    "/products/noaa-planetary-k-index-forecast.json",
    300,
  );
  return j.map((r) => ({ t: tagMs(r.time_tag), kp: Number(r.kp), kind: r.observed }));
}

/** Kp estimated every minute from the ground magnetometers. */
export async function loadKp1m(): Promise<Series> {
  const j = await swpcGet<{ time_tag: string; estimated_kp: number }[]>("/json/planetary_k_index_1m.json");
  return pick(j, (r) => tagMs(r.time_tag), (r) => r.estimated_kp);
}

/** Boulder's own K index, every minute. */
export async function loadBoulderK(): Promise<Series> {
  const j = await swpcGet<{ time_tag: string; k_index: number }[]>("/json/boulder_k_index_1m.json");
  return pick(j, (r) => tagMs(r.time_tag), (r) => r.k_index);
}

/** Kyoto's real-time Dst, hourly over the last week. */
export async function loadDst(): Promise<Series> {
  const j = await swpcGet<{ time_tag: string; dst: number }[]>("/products/kyoto-dst.json", 300);
  return pick(j, (r) => tagMs(r.time_tag), (r) => r.dst);
}

/** The Geospace model's Dst and Kp, a minute apart, over the last week. */
export async function loadGeospace(): Promise<{ dst: Series; kp: Series }> {
  const [d, k] = await Promise.all([
    swpcGet<{ time_tag: string; dst: number }[]>("/json/geospace/geospace_dst_7_day.json", 300),
    swpcGet<{ model_prediction_time: string; k: number }[]>("/json/geospace/geospce_pred_est_kp_7_day.json", 300).catch(
      () => [] as { model_prediction_time: string; k: number }[],
    ),
  ]);
  return {
    dst: pick(d, (r) => tagMs(r.time_tag), (r) => r.dst),
    kp: pick(k, (r) => tagMs(r.model_prediction_time), (r) => r.k),
  };
}

// ---------------------------------------------------------------- solar wind

export interface SolarWind {
  bt: Series;
  bx: Series;
  by: Series;
  bz: Series;
  phi: Series;
  speed: Series;
  density: Series;
  temp: Series;
  /** Which spacecraft the readings came from, newest last. */
  source: string;
  /** When the plasma measured at the latest time reaches Earth, if known. */
  arrival: number | null;
  /** True when the series are on the time they reach Earth, not the time they were measured. */
  propagated: boolean;
}

type RtswMag = { time_tag: string; active: boolean; source: string; bt: number; bx_gsm: number; by_gsm: number; bz_gsm: number; phi_gsm: number };
type RtswWind = { time_tag: string; active: boolean; source: string; proton_speed: number; proton_density: number; proton_temperature: number };

/**
 * The solar wind at L1. The real-time file carries every spacecraft at once
 * (DSCOVR, ACE, IMAP); the one SWPC flags active is the one it uses, so only
 * those rows are kept. It covers one day; past that the week-long propagated
 * file stands in, which is the same measurements carried on to Earth.
 */
export async function loadSolarWind(range: RangeId, atEarth = false): Promise<SolarWind> {
  if (!atEarth && (range === "2h" || range === "6h" || range === "1d")) {
    const [mag, wind] = await Promise.all([
      swpcGet<RtswMag[]>("/json/rtsw/rtsw_mag_1m.json"),
      swpcGet<RtswWind[]>("/json/rtsw/rtsw_wind_1m.json"),
    ]);
    const m = mag.filter((r) => r.active);
    const w = wind.filter((r) => r.active);
    const t = (r: { time_tag: string }) => tagMs(r.time_tag);
    const src = m.length ? m.reduce((a, b) => (t(a) > t(b) ? a : b)).source : "";
    const prop = await loadPropagatedLead().catch(() => null);
    return {
      bt: pick(m, t, (r) => r.bt),
      bx: pick(m, t, (r) => r.bx_gsm),
      by: pick(m, t, (r) => r.by_gsm),
      bz: pick(m, t, (r) => r.bz_gsm),
      phi: pick(m, t, (r) => r.phi_gsm),
      speed: pick(w, t, (r) => r.proton_speed),
      density: pick(w, t, (r) => r.proton_density),
      temp: pick(w, t, (r) => r.proton_temperature),
      source: spacecraftName(src),
      arrival: prop,
      propagated: false,
    };
  }
  const rows = await swpcGet<(string | number | null)[][]>("/products/geospace/propagated-solar-wind.json");
  const body = rows.slice(1);
  const ti = atEarth ? 11 : 0;
  const t = (r: (string | number | null)[]) => tagMs(r[ti] as string);
  const col = (i: number) => (r: (string | number | null)[]) => (r[i] == null ? null : Number(r[i]));
  const bx = pick(body, t, col(4));
  const by = pick(body, t, col(5));
  const phi = new Float64Array(bx.v.length);
  for (let i = 0; i < phi.length; i++) {
    const a = (Math.atan2(by.v[i], bx.v[i]) * 180) / Math.PI;
    phi[i] = a < 0 ? a + 360 : a;
  }
  const last = body[body.length - 1];
  return {
    bt: pick(body, t, col(7)),
    bx,
    by,
    bz: pick(body, t, col(6)),
    phi: { t: bx.t, v: phi },
    speed: pick(body, t, col(1)),
    density: pick(body, t, col(2)),
    temp: pick(body, t, col(3)),
    source: "DSCOVR / ACE, propagated",
    arrival: last ? tagMs(last[11] as string) : null,
    propagated: atEarth,
  };
}

/** When the latest plasma at L1 reaches Earth, from the propagated file. */
async function loadPropagatedLead(): Promise<number | null> {
  const rows = await swpcGet<(string | number | null)[][]>("/products/geospace/propagated-solar-wind.json");
  const last = rows[rows.length - 1];
  return last ? tagMs(last[11] as string) : null;
}

function spacecraftName(s: string): string {
  if (s === "SOLAR1") return "DSCOVR";
  return s || "L1";
}

/** ACE's hourly solar wind over the last month, for the long view. */
export async function loadAceMonth(): Promise<{ speed: Series; density: Series; temp: Series; bt: Series; bz: Series }> {
  const [sw, mag] = await Promise.all([
    swpcGet<{ time_tag: string; dsflag: number; dens: number; speed: number; temperature: number }[]>("/json/ace/swepam/ace_swepam_1h.json", 600),
    swpcGet<{ time_tag: string; dsflag: number; bt: number; gsm_bz: number }[]>("/json/ace/mag/ace_mag_1h.json", 600),
  ]);
  const ok = <T extends { dsflag: number }>(r: T[]) => r.filter((x) => x.dsflag === 0);
  const t = (r: { time_tag: string }) => tagMs(r.time_tag);
  const s = ok(sw);
  const m = ok(mag);
  return {
    speed: pick(s, t, (r) => (r.speed > 0 ? r.speed : null)),
    density: pick(s, t, (r) => (r.dens > 0 ? r.dens : null)),
    temp: pick(s, t, (r) => (r.temperature > 0 ? r.temperature : null)),
    bt: pick(m, t, (r) => (r.bt > -999 ? r.bt : null)),
    bz: pick(m, t, (r) => (r.gsm_bz > -999 ? r.gsm_bz : null)),
  };
}

// ---------------------------------------------------------------- GOES

export type Sat = "primary" | "secondary";

export async function loadXrays(range: RangeId, sat: Sat = "primary"): Promise<{ short: Series; long: Series; satellite: number | null }> {
  const j = await swpcGet<{ time_tag: string; satellite: number; flux: number; energy: string }[]>(
    `/json/goes/${sat}/xrays-${goesSpan(range)}.json`,
  );
  const t = (r: { time_tag: string }) => tagMs(r.time_tag);
  const pos = (r: { flux: number }) => (r.flux > 0 ? r.flux : null);
  return {
    short: pick(j.filter((r) => r.energy === "0.05-0.4nm"), t, pos),
    long: pick(j.filter((r) => r.energy === "0.1-0.8nm"), t, pos),
    satellite: j.length ? j[j.length - 1].satellite : null,
  };
}

export interface Flare {
  begin: number;
  max: number;
  end: number | null;
  cls: string;
  peak: number;
  satellite: number;
}

export async function loadFlares(): Promise<Flare[]> {
  const j = await swpcGet<
    { begin_time: string | null; max_time: string | null; end_time: string | null; max_class: string | null; begin_class: string | null; max_xrlong: number; satellite: number }[]
  >("/json/goes/primary/xray-flares-7-day.json");
  // A flare still rising has no peak or end yet: it stands at its start.
  return j
    .filter((r) => r.begin_time)
    .map((r) => ({
      begin: tagMs(r.begin_time!),
      max: r.max_time ? tagMs(r.max_time) : tagMs(r.begin_time!),
      end: r.end_time && r.end_time !== "Unk" ? tagMs(r.end_time) : null,
      cls: r.max_class ?? r.begin_class ?? "?",
      peak: r.max_xrlong,
      satellite: r.satellite,
    }))
    .sort((a, b) => b.begin - a.begin);
}

/** "M2.3" for a long-channel flux in W/m². */
export function flareClass(flux: number | null | undefined): string {
  if (flux == null || !(flux > 0)) return "--";
  const classes: [string, number][] = [
    ["X", 1e-4],
    ["M", 1e-5],
    ["C", 1e-6],
    ["B", 1e-7],
    ["A", 1e-8],
  ];
  for (const [c, base] of classes) if (flux >= base) return `${c}${(flux / base).toFixed(1)}`;
  return `A${(flux / 1e-8).toFixed(1)}`;
}

/** Integral or differential protons by energy channel. */
export async function loadProtons(range: RangeId, kind: "integral" | "differential" = "integral", sat: Sat = "primary"): Promise<Map<string, Series>> {
  const j = await swpcGet<{ time_tag: string; flux: number; energy: string; channel?: string }[]>(
    `/json/goes/${sat}/${kind}-protons-${goesSpan(range)}.json`,
  );
  return byKey(j, (r) => (kind === "differential" ? `${r.channel} ${r.energy}` : r.energy));
}

export async function loadElectrons(range: RangeId, sat: Sat = "primary"): Promise<Map<string, Series>> {
  const j = await swpcGet<{ time_tag: string; flux: number; energy: string }[]>(
    `/json/goes/${sat}/integral-electrons-${goesSpan(range)}.json`,
  );
  return byKey(j, (r) => r.energy);
}

function byKey<T extends { time_tag: string; flux: number }>(rows: T[], key: (r: T) => string): Map<string, Series> {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(r);
  }
  const out = new Map<string, Series>();
  for (const [k, g] of groups) out.set(k, pick(g, (r) => tagMs(r.time_tag), (r) => (r.flux > 0 ? r.flux : null)));
  return out;
}

/** GOES magnetometer: Hp (parallel to the spin axis), He, Hn and the total, nT. */
export async function loadMagnetometer(range: RangeId, sat: Sat = "primary"): Promise<{ hp: Series; he: Series; hn: Series; total: Series; satellite: number | null }> {
  const j = await swpcGet<{ time_tag: string; satellite: number; He: number; Hp: number; Hn: number; total: number; arcjet_flag: boolean }[]>(
    `/json/goes/${sat}/magnetometers-${goesSpan(range)}.json`,
  );
  const t = (r: { time_tag: string }) => tagMs(r.time_tag);
  return {
    hp: pick(j, t, (r) => r.Hp),
    he: pick(j, t, (r) => r.He),
    hn: pick(j, t, (r) => r.Hn),
    total: pick(j, t, (r) => r.total),
    satellite: j.length ? j[j.length - 1].satellite : null,
  };
}

/** ACE EPAM: low-energy electrons and protons, the first sign of an incoming shock. */
export async function loadEpam(): Promise<Map<string, Series>> {
  const j = await swpcGet<Record<string, number | string | null>[]>("/json/ace/epam/ace_epam_5m.json");
  const chans: [string, string][] = [
    ["de1", "e 38-53 keV"],
    ["de4", "e 175-315 keV"],
    ["p1", "p 47-68 keV"],
    ["p3", "p 115-195 keV"],
    ["p5", "p 310-580 keV"],
    ["p7", "p 795-1193 keV"],
    ["p8", "p 1060-1900 keV"],
  ];
  const out = new Map<string, Series>();
  for (const [k, label] of chans) {
    out.set(
      label,
      pick(j, (r) => tagMs(r.time_tag as string), (r) => {
        const v = r[k] as number | null;
        return v != null && v > 0 && (r[`dsflag_${k}`] ?? 0) === 0 ? v : null;
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------- the Sun

export interface Region {
  region: number;
  location: string;
  lat: number;
  lon: number;
  carrington: number | null;
  area: number;
  spots: number;
  spotClass: string;
  magClass: string;
  extent: number | null;
  c: number | null;
  m: number | null;
  x: number | null;
  proton: number | null;
  /** Flares the region made on the day: C, M and X. */
  events: [number, number, number];
  firstSeen: number | null;
  date: string;
}

export async function loadRegions(): Promise<Region[]> {
  const j = await swpcGet<Record<string, unknown>[]>("/json/solar_regions.json", 600);
  if (!j.length) return [];
  const last = j.map((r) => r.observed_date as string).sort().pop()!;
  const n = (v: unknown) => (v == null ? null : Number(v));
  return j
    .filter((r) => r.observed_date === last && r.region != null)
    .map((r) => ({
      region: Number(r.region),
      location: String(r.location ?? ""),
      lat: Number(r.latitude ?? 0),
      lon: Number(r.longitude ?? 0),
      carrington: n(r.carrington_longitude),
      area: Number(r.area ?? 0),
      spots: Number(r.number_spots ?? 0),
      spotClass: String(r.spot_class ?? ""),
      magClass: String(r.mag_class ?? ""),
      extent: n(r.extent),
      c: n(r.c_flare_probability),
      m: n(r.m_flare_probability),
      x: n(r.x_flare_probability),
      proton: n(r.proton_probability),
      events: [Number(r.c_xray_events ?? 0), Number(r.m_xray_events ?? 0), Number(r.x_xray_events ?? 0)] as [number, number, number],
      firstSeen: r.first_date ? tagMs(String(r.first_date)) : null,
      date: last,
    }))
    .sort((a, b) => b.region - a.region);
}

export interface FlareOdds {
  date: string;
  c: [number, number, number];
  m: [number, number, number];
  x: [number, number, number];
  proton: [number, number, number];
  pca: string;
}

/** SWPC's whole-disk odds of C, M and X flares and of a proton event, for the next three days. */
export async function loadFlareOdds(): Promise<FlareOdds | null> {
  const j = await swpcGet<Record<string, number | string>[]>("/json/solar_probabilities.json", 600);
  if (!j.length) return null;
  const r = [...j].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  const tri = (k: string): [number, number, number] => [1, 2, 3].map((d) => Number(r[`${k}_${d}_day`] ?? 0)) as [number, number, number];
  return { date: String(r.date).slice(0, 10), c: tri("c_class"), m: tri("m_class"), x: tri("x_class"), proton: tri("10mev_protons"), pca: String(r.polar_cap_absorption ?? "") };
}

/** F10.7 cm radio flux: the latest reading and the 90-day mean. */
export async function loadF107(): Promise<{ latest: number | null; mean90: number | null; series: Series }> {
  const j = await swpcGet<{ time_tag: string; flux: number; ninety_day_mean: number | null; reporting_schedule: string }[]>("/json/f107_cm_flux.json", 1800);
  const noon = j.filter((r) => r.reporting_schedule === "Noon");
  const latest = noon[0] ?? j[0];
  return {
    latest: latest ? latest.flux : null,
    mean90: noon.find((r) => r.ninety_day_mean != null)?.ninety_day_mean ?? null,
    series: pick(noon, (r) => tagMs(r.time_tag), (r) => r.flux),
  };
}

export interface CycleData {
  observed: { t: number; ssn: number; smoothed: number | null; f107: number | null; f107s: number | null }[];
  predicted: { t: number; ssn: number; lo: number; hi: number; f107: number; f107lo: number; f107hi: number }[];
}

export async function loadSolarCycle(): Promise<CycleData> {
  const [o, p] = await Promise.all([
    swpcGet<Record<string, number | string>[]>("/json/solar-cycle/observed-solar-cycle-indices.json", 3600),
    swpcGet<Record<string, number | string>[]>("/json/solar-cycle/predicted-solar-cycle.json", 3600),
  ]);
  const month = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, 15);
  const pos = (v: unknown) => (v == null || Number(v) < 0 ? null : Number(v));
  return {
    observed: o.map((r) => ({
      t: month(String(r["time-tag"])),
      ssn: Number(r.ssn),
      smoothed: pos(r.smoothed_ssn),
      f107: pos(r["f10.7"]),
      f107s: pos(r["smoothed_f10.7"]),
    })),
    predicted: p.map((r) => ({
      t: month(String(r["time-tag"])),
      ssn: Number(r.predicted_ssn),
      lo: Number(r.low_ssn),
      hi: Number(r.high_ssn),
      f107: Number(r["predicted_f10.7"]),
      f107lo: Number(r["low_f10.7"]),
      f107hi: Number(r["high_f10.7"]),
    })),
  };
}

// ---------------------------------------------------------------- WSA-Enlil

export interface Enlil {
  density: Series;
  speed: Series;
  temp: Series;
  br: Series;
  polarity: Series;
  /** Where the model has a CME cloud at Earth. */
  cloud: [number, number][];
}

export async function loadEnlil(): Promise<Enlil> {
  const j = await swpcGet<Record<string, number | string | null>[]>("/json/enlil_time_series.json", 1800);
  const t = (r: Record<string, unknown>) => tagMs(r.time_tag as string);
  const cloud: [number, number][] = [];
  const sorted = [...j].sort((a, b) => t(a) - t(b));
  let open: number | null = null;
  for (const r of sorted) {
    const on = r.cloud != null && Number(r.cloud) > 0;
    if (on && open == null) open = t(r);
    if (!on && open != null) {
      cloud.push([open, t(r)]);
      open = null;
    }
  }
  if (open != null) cloud.push([open, t(sorted[sorted.length - 1])]);
  return {
    density: pick(j, t, (r) => r.earth_particles_per_cm3 as number),
    speed: pick(j, t, (r) => r.v_r as number),
    temp: pick(j, t, (r) => r.temperature as number),
    br: pick(j, t, (r) => r.b_r as number),
    polarity: pick(j, t, (r) => r.polarity as number),
    cloud,
  };
}

// ---------------------------------------------------------------- alerts and texts

export interface SwxAlert {
  id: string;
  issued: number;
  code: string;
  serial: string;
  title: string;
  kind: "warning" | "alert" | "watch" | "summary" | "other";
  text: string;
}

const KIND: Record<string, SwxAlert["kind"]> = { W: "warning", A: "alert", S: "summary" };

export async function loadAlerts(): Promise<SwxAlert[]> {
  const j = await swpcGet<{ product_id: string; issue_datetime: string; message: string }[]>("/products/alerts.json");
  return j
    .map((r) => {
      const text = r.message.replace(/\r/g, "").trim();
      const code = /Message Code:\s*(\S+)/.exec(text)?.[1] ?? r.product_id;
      const serial = /Serial Number:\s*(\S+)/.exec(text)?.[1] ?? "";
      const lines = text.split("\n").map((l) => l.trim());
      const iIssue = lines.findIndex((l) => l.startsWith("Issue Time"));
      const title = lines.slice(iIssue + 1).find((l) => l.length > 0) ?? code;
      const k = code.startsWith("WATA") ? "watch" : KIND[code.charAt(0)] ?? (code.startsWith("SUM") ? "summary" : "other");
      return {
        id: `${code}-${serial}-${r.issue_datetime}`,
        issued: tagMs(r.issue_datetime.replace(" ", "T").slice(0, 19)),
        code,
        serial,
        title: title.replace(/^(ALERT|WARNING|WATCH|SUMMARY|EXTENDED WARNING|CANCEL WARNING|CANCEL WATCH):\s*/i, (m) => m.toUpperCase()),
        kind: /WATCH/i.test(title) ? "watch" : k,
        text,
      };
    })
    .sort((a, b) => b.issued - a.issued);
}

export interface TextProduct {
  id: string;
  label: string;
  path: string;
  about: string;
}

export const TEXT_PRODUCTS: TextProduct[] = [
  { id: "3day", label: "3-Day Forecast", path: "/text/3-day-forecast.txt", about: "Kp by 3-hour block, radio blackout and radiation storm odds for the next three days." },
  { id: "discussion", label: "Forecast Discussion", path: "/text/discussion.txt", about: "The forecaster's reasoning behind the outlook." },
  { id: "advisory", label: "Advisory Outlook", path: "/text/advisory-outlook.txt", about: "Weekly outlook of space weather that may affect operations." },
  { id: "27day", label: "27-Day Outlook", path: "/text/27-day-outlook.txt", about: "F10.7, Ap and Kp for the next solar rotation." },
  { id: "weekly", label: "Weekly Highlights", path: "/text/weekly.txt", about: "Highlights of the past week and the forecast for the next four." },
  { id: "srs", label: "Solar Region Summary", path: "/text/srs.txt", about: "Every numbered sunspot region and its class, issued daily." },
  { id: "events", label: "Event Reports", path: "/text/solar-geophysical-event-reports.txt", about: "Every flare, radio burst and event logged today." },
  { id: "indices", label: "Current Indices", path: "/text/current-space-weather-indices.txt", about: "Today's indices in one sheet." },
  { id: "dgd", label: "Daily Geomagnetic", path: "/text/daily-geomagnetic-indices.txt", about: "A and K indices from Fredericksburg, College and the planetary network, 30 days." },
  { id: "dsd", label: "Daily Solar", path: "/text/daily-solar-indices.txt", about: "Radio flux, sunspot number and area, background X-ray and flare counts, 30 days." },
  { id: "sgas", label: "Geophysical Activity", path: "/text/sgas.txt", about: "Solar and geophysical activity summary." },
  { id: "wwv", label: "WWV Broadcast", path: "/text/wwv.txt", about: "The geophysical alert read on WWV every hour." },
  { id: "geoalert", label: "Geoalert", path: "/text/geoalert.txt", about: "The daily coded geophysical alert." },
  { id: "geomag3", label: "3-Day Geomagnetic", path: "/text/3-day-geomag-forecast.txt", about: "Ap and the odds of active, minor and severe storm levels, by latitude." },
  { id: "predict3", label: "3-Day Predictions", path: "/text/3-day-solar-geomag-predictions.txt", about: "Solar and geomagnetic predictions, the numbers behind the 3-day forecast." },
];

export async function loadText(path: string): Promise<string> {
  return swpcGet<string>(path, 300, "text");
}

// ---------------------------------------------------------------- aurora

export interface Ovation {
  observed: number;
  forecast: number;
  /** Probability 0-100, [lat + 90][lon], lat -90..90, lon 0..359. */
  grid: Uint8Array;
}

export async function loadOvation(): Promise<Ovation> {
  const j = await swpcGet<{ "Observation Time": string; "Forecast Time": string; coordinates: [number, number, number][] }>(
    "/json/ovation_aurora_latest.json",
  );
  const grid = new Uint8Array(181 * 360);
  for (const [lon, lat, a] of j.coordinates) {
    const li = Math.round(lat) + 90;
    const lo = ((Math.round(lon) % 360) + 360) % 360;
    if (li >= 0 && li <= 180) grid[li * 360 + lo] = a;
  }
  return { observed: tagMs(j["Observation Time"]), forecast: tagMs(j["Forecast Time"]), grid };
}

export function ovationAt(o: Ovation, lat: number, lon: number): number {
  const li = Math.round(lat) + 90;
  const lo = ((Math.round(lon) % 360) + 360) % 360;
  return li < 0 || li > 180 ? 0 : o.grid[li * 360 + lo];
}

/** Hemispheric power, GW, north and south, every five minutes today (and the forecast half hour). */
export async function loadHemiPower(): Promise<{ north: Series; south: Series }> {
  const txt = await swpcGet<string>("/text/aurora-nowcast-hemi-power.txt", 120, "text");
  const n: { t: number; v: number }[] = [];
  const s: { t: number; v: number }[] = [];
  for (const line of txt.split("\n")) {
    const m = /^(\d{4}-\d\d-\d\d)_(\d\d:\d\d)\s+(\d{4}-\d\d-\d\d)_(\d\d:\d\d)\s+(-?\d+)\s+(-?\d+)/.exec(line.trim());
    if (!m) continue;
    const t = tagMs(`${m[3]}T${m[4]}:00`);
    n.push({ t, v: Number(m[5]) });
    s.push({ t, v: Number(m[6]) });
  }
  return { north: series(n), south: series(s) };
}

// ---------------------------------------------------------------- ionosphere

export interface Drap {
  valid: number;
  lats: number[];
  lons: number[];
  /** Highest frequency (MHz) absorbed by 1 dB, [row][col]. */
  rows: number[][];
  xray: string;
  proton: string;
  recovery: string;
}

export async function loadDrap(): Promise<Drap> {
  const txt = await swpcGet<string>("/text/drap_global_frequencies.txt", 60, "text");
  const lines = txt.split("\n");
  const msg = (k: string) => lines.find((l) => l.includes(k))?.split(":").slice(1).join(":").trim() ?? "";
  const valid = /Valid At\s*:\s*(\d{4}-\d\d-\d\d \d\d:\d\d)/.exec(txt)?.[1];
  let lons: number[] = [];
  const lats: number[] = [];
  const rows: number[][] = [];
  for (const l of lines) {
    if (l.startsWith("#") || !l.trim() || l.startsWith("---")) continue;
    if (!l.includes("|")) {
      const nums = l.trim().split(/\s+/).map(Number);
      if (nums.length > 10 && nums.every(Number.isFinite)) lons = nums;
      continue;
    }
    const [a, b] = l.split("|");
    lats.push(Number(a));
    rows.push(b.trim().split(/\s+/).map(Number));
  }
  return {
    valid: valid ? tagMs(`${valid.replace(" ", "T")}:00`) : Date.now(),
    lats,
    lons,
    rows,
    xray: msg("X-RAY Message"),
    proton: msg("Proton Message"),
    recovery: msg("Recovery Time"),
  };
}

export interface PointField {
  valid: number;
  /** [lon, lat, value] */
  points: [number, number, number][];
  /** Grid spacing, degrees. */
  dLon: number;
  dLat: number;
}

/** GloTEC: total electron content or its anomaly, on a 5 x 2.5 degree grid, every 10 minutes. */
export async function loadGlotec(field: "tec" | "anomaly"): Promise<PointField> {
  const list = await swpcGet<{ url: string; time_tag: string }[]>("/products/glotec/geojson_2d_urt.json");
  const last = list[list.length - 1];
  const gj = await swpcGet<{ features: { geometry: { coordinates: [number, number] }; properties: Record<string, number> }[] }>(
    swpcUrl(last.url),
    600,
  );
  return {
    valid: tagMs(last.time_tag),
    points: gj.features.map((f) => [f.geometry.coordinates[0], f.geometry.coordinates[1], f.properties[field]]),
    dLon: 5,
    dLat: 2.5,
  };
}

/** The geoelectric field over the US and Canada, mV/km, every minute. */
export async function loadEfield(): Promise<PointField> {
  const list = await swpcGet<{ url: string }[]>("/json/lists/rgeojson/rgeojson_US-Canada-1D.json");
  const last = list[list.length - 1];
  const gj = await swpcGet<{ features: { geometry: { coordinates: [number, number] }; properties: { Ex: number; Ey: number } }[] }>(
    swpcUrl(last.url),
    600,
  );
  const m = /(\d{8}T\d{6})/.exec(last.url)?.[1];
  const valid = m ? Date.UTC(+m.slice(0, 4), +m.slice(4, 6) - 1, +m.slice(6, 8), +m.slice(9, 11), +m.slice(11, 13), +m.slice(13, 15)) : Date.now();
  return {
    valid,
    points: gj.features.map((f) => [f.geometry.coordinates[0], f.geometry.coordinates[1], Math.hypot(f.properties.Ex, f.properties.Ey)]),
    dLon: 0.5,
    dLat: 0.5,
  };
}

// ---------------------------------------------------------------- image loops

export interface Frame {
  url: string;
  t: number | null;
}

/** A frame list from /products/animations; times from the list, or failing that the file name. */
export async function loadFrames(path: string): Promise<Frame[]> {
  const j = await swpcGet<{ url: string; time_tag?: string }[]>(path, 120);
  return j.map((f) => ({ url: swpcUrl(f.url), t: f.time_tag ? tagMs(f.time_tag) : timeFromName(f.url) }));
}

/** 20261004T220000, 20261004_2212, 2026-10-04_2205, 20261005135900: the first time stamp in a file name. */
export function timeFromName(url: string): number | null {
  const name = url.split("/").pop() ?? url;
  let m = /(\d{4})-?(\d\d)-?(\d\d)[T_]?(\d\d):?(\d\d)/.exec(name);
  if (!m) m = /(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)\d\d/.exec(name);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return Number.isFinite(t) ? t : null;
}

// ---------------------------------------------------------------- SDO

/** SDO's newest picture of each channel, through the backend (see backend/space_sdo.py:
 *  SDO's own "latest" files stopped updating, and its directories send no CORS headers). */
/** The backend's base is a path in development (the Vite proxy): made whole here, so the
 *  shared reader does not take it for a path on SWPC. */
const backend = (path: string) => new URL(`${BACKEND_BASE}${path}`, window.location.href).href;

export async function loadSdoLatest(size: 512 | 1024 | 2048 | 4096): Promise<Record<string, Frame>> {
  const j = await swpcGet<{ channels: Record<string, { url: string; t: number }> }>(backend(`/api/space/sdo?size=${size}`), 300);
  const out: Record<string, Frame> = {};
  for (const [k, v] of Object.entries(j.channels)) out[k] = { url: v.url, t: v.t };
  return out;
}

export async function loadSdoFrames(ch: string, size = 1024, hours = 24): Promise<Frame[]> {
  const j = await swpcGet<{ frames: { url: string; t: number }[] }>(backend(`/api/space/sdo/frames?ch=${ch}&size=${size}&hours=${hours}`), 300);
  return j.frames.map((f) => ({ url: f.url, t: f.t }));
}

// ---------------------------------------------------------------- outlooks

export interface OutlookDay {
  t: number;
  f107: number;
  ap: number;
  kp: number;
}

/** SWPC's 27-day outlook: radio flux, Ap and the largest Kp for each day of the next solar rotation. */
export async function load27Day(): Promise<OutlookDay[]> {
  const txt = await swpcGet<string>("/text/27-day-outlook.txt", 3600, "text");
  const out: OutlookDay[] = [];
  for (const line of txt.split("\n")) {
    const m = /^(\d{4}) (\w{3}) (\d\d)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(line.trim());
    if (!m) continue;
    const t = Date.parse(`${m[3]} ${m[2]} ${m[1]} 00:00:00 UTC`);
    if (Number.isFinite(t)) out.push({ t, f107: +m[4], ap: +m[5], kp: +m[6] });
  }
  return out;
}

/** The 45-day forecast of Ap and F10.7. */
export async function load45Day(): Promise<{ ap: Series; f107: Series }> {
  const j = await swpcGet<{ data: { time: string; metric: string; value: number }[] }>("/json/45-day-forecast.json", 3600);
  const of = (k: string) => pick(j.data.filter((r) => r.metric === k), (r) => tagMs(r.time), (r) => r.value);
  return { ap: of("ap"), f107: of("f107") };
}

/** ICAO space weather advisories for aviation (HF, GNSS, radiation), when any are in effect. */
export async function loadIcao(): Promise<Record<string, unknown>[]> {
  return swpcGet<Record<string, unknown>[]>("/json/icao-space-weather-advisories.json", 300);
}
