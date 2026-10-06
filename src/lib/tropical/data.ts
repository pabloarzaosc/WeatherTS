/**
 * Tropical cyclones: everything the Tropical screen and its map layers read.
 *
 * Two kinds of source. What sends CORS headers is read here in the browser:
 * NHC's GIS MapServer (cones, tracks, watches, wind fields, arrival times,
 * wind speed probabilities), the NWS text products (advisories, discussions,
 * outlooks), STAR's satellite loops and GIBS's sea surface temperature. What
 * does not -- NHC's and UCAR's ATCF decks, HURDAT2, the recon archive, CPC's
 * indices -- goes through the backend (backend/tropical.py).
 */
import { BACKEND_BASE } from "../apiConfig";
import { swpcGet as getCached } from "../space/swpc";

const backend = (path: string) => new URL(`${BACKEND_BASE}${path}`, window.location.href).href;

// ---------------------------------------------------------------- categories

export type Cat = "TD" | "TS" | "C1" | "C2" | "C3" | "C4" | "C5";

/** Saffir-Simpson, by the one-minute maximum wind in knots. */
export function catOf(vmax: number | null | undefined): Cat {
  const v = vmax ?? 0;
  return v >= 137 ? "C5" : v >= 113 ? "C4" : v >= 96 ? "C3" : v >= 83 ? "C2" : v >= 64 ? "C1" : v >= 34 ? "TS" : "TD";
}

/** The classic track-map colours for each category. */
export const CAT_COLORS: Record<Cat, string> = {
  TD: "#5ebaff",
  TS: "#00faf4",
  C1: "#ffffcc",
  C2: "#ffe775",
  C3: "#ffc140",
  C4: "#ff8f20",
  C5: "#ff6060",
};
export const CAT_NAMES: Record<Cat, string> = {
  TD: "Tropical depression",
  TS: "Tropical storm",
  C1: "Category 1",
  C2: "Category 2",
  C3: "Category 3",
  C4: "Category 4",
  C5: "Category 5",
};
export const CAT_SHORT: Record<Cat, string> = { TD: "TD", TS: "TS", C1: "Cat 1", C2: "Cat 2", C3: "Cat 3", C4: "Cat 4", C5: "Cat 5" };

/** What the ATCF type code says a system is, in words. */
export function typeName(type: string, vmax: number | null, basin: string): string {
  const t = (type || "").toUpperCase();
  const strong = (vmax ?? 0) >= 64;
  if (t === "EX") return "Post-tropical";
  if (t === "LO" || t === "WV" || t === "DB") return "Disturbance";
  if (t === "SD") return "Subtropical depression";
  if (t === "SS") return "Subtropical storm";
  if (t === "ST" || (basin === "wp" && (vmax ?? 0) >= 130)) return "Super typhoon";
  if (strong) return basin === "wp" ? "Typhoon" : basin === "io" || basin === "sh" ? "Cyclone" : "Hurricane";
  if ((vmax ?? 0) >= 34) return "Tropical storm";
  return "Tropical depression";
}

export const BASINS: { id: string; label: string; short: string }[] = [
  { id: "al", label: "Atlantic", short: "ATL" },
  { id: "ep", label: "East Pacific", short: "EPAC" },
  { id: "cp", label: "Central Pacific", short: "CPAC" },
  { id: "wp", label: "West Pacific", short: "WPAC" },
  { id: "io", label: "North Indian", short: "NIO" },
  { id: "sh", label: "Southern Hemisphere", short: "SH" },
];
export const basinLabel = (b: string) => BASINS.find((x) => x.id === b)?.label ?? b.toUpperCase();

// ---------------------------------------------------------------- active storms

export interface ActiveStorm {
  id: string;
  basin: string;
  number: number;
  year: number;
  code: string;
  name: string;
  invest: boolean;
  agency: "NHC" | "CPHC" | "JTWC";
  lat: number;
  lon: number;
  vmax: number | null;
  mslp: number | null;
  type: string;
  cat: Cat;
  t: number;
  dir: number | null;
  speed: number | null;
  ace: number;
  first: number;
  trail: [number, number][];
  nhc?: {
    bin: string;
    classification: string;
    intensity: number | null;
    pressure: number | null;
    movementDir: number | null;
    movementSpeed: number | null;
    lastUpdate: string;
    advisory: string;
    graphics: string;
  };
}

export async function loadStorms(): Promise<{ updated: number; storms: ActiveStorm[] }> {
  return getCached(backend("/api/tropical/storms"), 120);
}

export interface TrackPoint {
  t: number;
  lat: number;
  lon: number;
  vmax: number | null;
  mslp: number | null;
  type: string;
  cat: Cat;
  radii: Partial<Record<"34" | "50" | "64", [number, number, number, number]>>;
  rmw: number | null;
  roci: number | null;
  poci: number | null;
  dir: number | null;
  speed: number | null;
}

export interface Track {
  id: string;
  name: string;
  points: TrackPoint[];
  ace: number;
  /** The app's basin, the season's year and the agencies' number (12L, 19W). */
  basin: string;
  year: number;
  code: string;
  source: "ATCF" | "HURDAT2" | "IBTrACS";
}

export async function loadTrack(id: string): Promise<Track> {
  return getCached(backend(`/api/tropical/track?id=${id}`), 300);
}

/** A storm the backend can read a track for: a deck id (al122005) or an
 *  IBTrACS one (2005236N23285), which reaches any storm since 1842. */
export const STORM_ID = /^([a-z]{2}\d{6}|\d{7}[NS]\d{5})$/;
export const isIbtracsId = (id: string) => /^\d{7}[NS]\d{5}$/.test(id);

export interface ModelPoint {
  tau: number;
  t: number;
  lat: number | null;
  lon: number | null;
  vmax: number | null;
  mslp: number | null;
}
export interface Model {
  tech: string;
  colour: string;
  official: boolean;
  track: boolean;
  intensity: boolean;
  points: ModelPoint[];
}
export interface Guidance {
  id: string;
  cycle: number | null;
  cycles: string[];
  models: Model[];
}

export async function loadGuidance(id: string, cycle?: string, all = false): Promise<Guidance> {
  const q = `id=${id}${cycle ? `&cycle=${cycle}` : ""}${all ? "&which=all" : ""}`;
  return getCached(backend(`/api/tropical/guidance?${q}`), 600);
}

/** What the guidance codes are, for the legend. */
export const TECH_NAMES: Record<string, string> = {
  OFCL: "NHC official forecast",
  JTWC: "JTWC official forecast",
  TVCN: "Track consensus",
  CONW: "Track consensus",
  HCCA: "HFIP corrected consensus",
  IVCN: "Intensity consensus",
  ICNW: "Intensity consensus",
  AVNI: "GFS",
  EMXI: "ECMWF",
  EGRI: "UKMET",
  UKMI: "UKMET",
  UKM: "UKMET",
  CMCI: "Canadian",
  CMC: "Canadian",
  NVGI: "Navy NAVGEM",
  JGSI: "Japan GSM",
  HWFI: "HWRF",
  HMNI: "HMON",
  HFAI: "HAFS-A",
  HFBI: "HAFS-B",
  CTCI: "COAMPS-TC",
  AEMI: "GFS ensemble mean",
  AEMN: "GFS ensemble mean",
  AC00: "GFS ensemble control",
  CEMN: "Canadian ensemble mean",
  EEMN: "ECMWF ensemble mean",
  SHIP: "SHIPS",
  DSHP: "SHIPS with land decay",
  LGEM: "LGEM",
  RIPA: "Rapid intensification aid",
  CHIP: "CHIPS",
};

// ---------------------------------------------------------------- NHC GIS (MapServer)

export const NHC_MAPSERVER = "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer";
export const NHC_SURGE = "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_PeakStormSurge/MapServer";

/** The service's layers by name ("EP3 Forecast Cone" -> 190): read once, so
 *  a change to the service's numbering cannot break the map. */
export async function nhcLayers(): Promise<Map<string, number>> {
  const j = await getCached<{ layers: { id: number; name: string }[] }>(`${NHC_MAPSERVER}?f=json`, 3600);
  return new Map(j.layers.map((l) => [l.name, l.id]));
}

export async function nhcGeo(layer: number, base = NHC_MAPSERVER): Promise<GeoJSON.FeatureCollection> {
  return getCached(`${base}/${layer}/query?where=1%3D1&outFields=*&f=geojson`, 300);
}

/** The layers that draw one storm, by the NHC bin it is advised under (AT1, EP3 ...). */
export const BIN_LAYERS = {
  points: "Forecast Points",
  track: "Forecast Track",
  cone: "Forecast Cone",
  ww: "Watch-Warning",
  pastPoints: "Past Points",
  pastTrack: "Past Track",
  swath: "Past Cumulative Wind Swath",
  radii: "Forecast Wind Radii",
  field: "Advisory Wind Field",
  earliest: "Earliest Reasonable Arrival Time",
  likely: "Most Likely Arrival Time",
} as const;
export type BinLayer = keyof typeof BIN_LAYERS;

export async function nhcBinGeo(bin: string, which: BinLayer): Promise<GeoJSON.FeatureCollection | null> {
  const layers = await nhcLayers();
  const id = layers.get(`${bin} ${BIN_LAYERS[which]}`);
  return id == null ? null : nhcGeo(id);
}

export async function nhcWindProb(kt: 34 | 50 | 64): Promise<GeoJSON.FeatureCollection | null> {
  const layers = await nhcLayers();
  const id = layers.get(`Probabilistic Winds ${kt} kts`);
  return id == null ? null : nhcGeo(id);
}

/** NHC's storm graphics: the cone, the wind field, arrival times... by the
 *  bin's two-letter basin and number (EP18 for ep182026). */
export function nhcGraphics(id: string): { id: string; label: string; url: string }[] {
  const bb = `${id.slice(0, 2).toUpperCase()}${id.slice(2, 4)}`;
  const g = `https://www.nhc.noaa.gov/storm_graphics/${bb}/${id.toUpperCase()}`;
  return [
    { id: "cone", label: "5-day cone", url: `${g}_5day_cone.png` },
    { id: "cone3", label: "3-day cone", url: `${g}_3day_cone.png` },
    { id: "wind", label: "Current wind field", url: `${g}_current_wind.png` },
    { id: "history", label: "Wind field history", url: `${g}_wind_history.png` },
    { id: "arrival", label: "Earliest arrival of TS winds", url: `${g}_earliest_reasonable_toa_34.png` },
    { id: "likely", label: "Most likely arrival of TS winds", url: `${g}_most_likely_toa_34.png` },
    { id: "key", label: "Key messages", url: `${g}_key_messages.png` },
  ];
}

/** The wind speed probability graphics, every 12 hours to 5 days: a loop. */
export function nhcWindProbFrames(id: string, kt: 34 | 50 | 64): { url: string; t: null; label: string }[] {
  const bb = `${id.slice(0, 2).toUpperCase()}${id.slice(2, 4)}`;
  const g = `https://www.nhc.noaa.gov/storm_graphics/${bb}/${id.toUpperCase()}`;
  return Array.from({ length: 11 }, (_, i) => {
    const h = String(i * 12).padStart(3, "0");
    return { url: `${g}_wind_probs_${kt}_F${h}.png`, t: null, label: `To ${i * 12} h` };
  });
}

/** NHC's graphical outlook: the disturbances it is watching, with their chances. */
const NHC_TWO = "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer";

export interface FormationArea {
  basin: string;
  prob2: number;
  prob7: number;
  risk7: string;
  lat: number;
  lon: number;
}

export async function loadFormation(): Promise<FormationArea[]> {
  const j = await getCached<GeoJSON.FeatureCollection>(`${NHC_TWO}/2/query?where=1%3D1&outFields=*&f=geojson`, 600);
  return j.features.flatMap((f) => {
    if (f.geometry?.type !== "Point") return [];
    const p = f.properties ?? {};
    const [lon, lat] = f.geometry.coordinates;
    return [{ basin: String(p.basin ?? ""), prob2: parseFloat(p.prob2day) || 0, prob7: parseFloat(p.prob7day) || 0, risk7: String(p.risk7day ?? "Low"), lat, lon }];
  });
}

// ---------------------------------------------------------------- NWS text products

export interface NwsProductRef {
  id: string;
  issuanceTime: string;
  productCode: string;
  issuingOffice: string;
}

export async function nwsProducts(type: string, location?: string): Promise<NwsProductRef[]> {
  const url = `https://api.weather.gov/products/types/${type}${location ? `/locations/${location}` : ""}`;
  const j = await getCached<{ "@graph": NwsProductRef[] }>(url, 180);
  return j["@graph"] ?? [];
}

export async function nwsProductText(id: string): Promise<{ text: string; issued: string }> {
  const j = await getCached<{ productText: string; issuanceTime: string }>(`https://api.weather.gov/products/${id}`, 3600);
  return { text: j.productText, issued: j.issuanceTime };
}

/** The newest product of a type from one issuer (TCP from EP3, TWO from AT). */
export async function latestProduct(type: string, location: string): Promise<{ text: string; issued: string } | null> {
  const list = await nwsProducts(type, location);
  return list.length ? nwsProductText(list[0].id) : null;
}

// ---------------------------------------------------------------- seasons and climatology

export type SeasonPoint = [number, number, number, number | null, number | null, string];
export interface SeasonStorm {
  id: string;
  name: string;
  start: number;
  end: number;
  peak: number;
  minp: number | null;
  cat: Cat;
  ace: number;
  landfalls: number;
  points?: SeasonPoint[];
}
export interface Season {
  basin: string;
  year: number;
  storms: SeasonStorm[];
  daily: [string, number][];
  ace: number;
  named: number;
  hurricanes: number;
  majors: number;
  live: boolean;
  /** Where its tracks came from: the decks, HURDAT2 or IBTrACS. */
  source?: string;
}

export async function loadSeason(basin: string, year: number, invests = false): Promise<Season> {
  const live = year >= new Date().getUTCFullYear();
  return getCached(backend(`/api/tropical/season?basin=${basin}&year=${year}${invests ? "&invests=true" : ""}`), live ? 600 : 86400);
}

export interface BasinClimo {
  south: boolean;
  first: number;
  last: number;
  years: Record<string, { ace: number; named: number; hurr: number; major: number; daily: [number, number][] }>;
  /** sid, name, season, start ms, end ms, peak kt, min mb, ACE */
  storms: [string, string, number, number, number, number, number | null, number][];
}
export interface Climo {
  source: string;
  built: string;
  basins: Record<string, BasinClimo>;
}

/** The record from IBTrACS, built once a year into the app (scripts/build-tropical-climo.py). */
export async function loadClimo(): Promise<Climo> {
  return getCached(new URL("data/tropical-climo.json", document.baseURI).href, 86400);
}

export interface Records {
  basin: string;
  strongest: SeasonStorm[];
  deepest: SeasonStorm[];
  ace: SeasonStorm[];
  formations: number[];
  years: number[];
}
export async function loadRecords(basin: "al" | "ep"): Promise<Records> {
  return getCached(backend(`/api/tropical/records?basin=${basin}`), 86400);
}

export async function loadHurdat(basin: "al" | "ep", from: number, to: number, min = 0): Promise<{ storms: (SeasonStorm & { points: [number, number, number, number | null][] })[] }> {
  return getCached(backend(`/api/tropical/hurdat?basin=${basin}&from=${from}&to=${to}&min=${min}`), 86400);
}

export async function loadDensity(basin: "al" | "ep", from: number, to: number): Promise<{ cell: number; storms: number; cells: [number, number, number][] }> {
  return getCached(backend(`/api/tropical/density?basin=${basin}&from=${from}&to=${to}`), 86400);
}

// ---------------------------------------------------------------- recon

export interface ReconObs {
  t: number;
  lat: number;
  lon: number;
  ps: number | null;
  gph: number | null;
  xsp: number | null;
  temp: number | null;
  dew: number | null;
  wdir: number | null;
  wspd: number | null;
  peak: number | null;
  sfmr: number | null;
  rain: number | null;
  flag: string;
}
export interface ReconMission {
  id: string;
  aircraft: string;
  mission: string;
  storm: string;
  training: boolean;
  start: number;
  end: number;
  maxFl: number | null;
  maxSfmr: number | null;
  minXsp: number | null;
  obs: ReconObs[];
}

export async function loadRecon(basin: string, opts: { hours?: number; start?: string; end?: string }): Promise<{ missions: ReconMission[] }> {
  const q = opts.start && opts.end ? `start=${opts.start}&end=${opts.end}` : `hours=${opts.hours ?? 24}`;
  return getCached(backend(`/api/tropical/recon?basin=${basin}&${q}`), opts.start ? 3600 : 120);
}

export async function loadReconYears(): Promise<number[]> {
  return getCached(backend("/api/tropical/recon/years"), 86400);
}

/** Who flies: the aircraft codes in the HDOB header. */
export function aircraftName(code: string): string {
  if (code.startsWith("NOAA2")) return "NOAA P-3 Kermit (N42RF)";
  if (code.startsWith("NOAA3")) return "NOAA P-3 Miss Piggy (N43RF)";
  if (code.startsWith("NOAA9")) return "NOAA G-IV Gonzo (N49RF)";
  if (code.startsWith("NOAA")) return `NOAA ${code.slice(4)}`;
  if (code.startsWith("AF")) return `Air Force WC-130J ${code.slice(2)}`;
  return code;
}

// ---------------------------------------------------------------- ENSO and the ocean

export interface Enso {
  /** "YYYY-MM" (centre month of the 3-month season), Nino 3.4 SST, ONI */
  oni: [string, number, number][];
  /** week, anomaly in Nino 1+2, 3, 3.4, 4 */
  weekly: [string, number, number, number, number][];
  mei: [string, number][];
  tna: [string, number][];
  /** "YYYY-MM", Nino 3.4 anomaly from HadISST, 1870 on */
  nino34long?: [string, number][];
  /** "YYYY-MM", the Atlantic Multidecadal Oscillation, 1856 to 2023 */
  amo?: [string, number][];
}
export async function loadEnso(): Promise<Enso> {
  return getCached(backend("/api/tropical/enso"), 21600);
}

export interface Mjo {
  source: string;
  /** date, RMM1, RMM2, amplitude, phase 1-8 */
  days: [string, number, number, number, number][];
}

/** The MJO day by day since 1991 (PSL's real-time OLR index on RMM's axes). */
export async function loadMjo(): Promise<Mjo> {
  return getCached(backend("/api/tropical/mjo"), 21600);
}

/** Where the MJO's convection is in each phase. */
export const MJO_PHASES = [
  "",
  "Western Hemisphere and Africa",
  "Indian Ocean",
  "Indian Ocean",
  "Maritime Continent",
  "Maritime Continent",
  "Western Pacific",
  "Western Pacific",
  "Western Hemisphere and Africa",
];

/** The first day GIBS has the MUR analysis for. */
export const SST_FIRST_DAY = "2002-06-01";

/** The newest day GIBS is sure to have: it arrives a day or two late. */
export const sstLatestDay = () => new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

/** GIBS's daily GHRSST MUR analysis, as map tiles, for a day (the newest by default). */
export function gibsSstTiles(product: "sst" | "anomaly", day?: string | null): string {
  const d = day || sstLatestDay();
  const layer = product === "sst" ? "GHRSST_L4_MUR_Sea_Surface_Temperature" : "GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies";
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${d}/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png`;
}

// ---------------------------------------------------------------- satellite (STAR)

export interface Frame {
  url: string;
  t: number | null;
}

const STAR = "https://cdn.star.nesdis.noaa.gov";

/** 20262791030 -> the time: year, day of the year, hour, minute. */
function starTime(stamp: string): number | null {
  const m = /^(\d{4})(\d{3})(\d{2})(\d{2})/.exec(stamp);
  if (!m) return null;
  return Date.UTC(+m[1], 0, 1, +m[3], +m[4]) + (+m[2] - 1) * 86_400_000;
}

async function starFrames(dir: string, suffix: string, count: number): Promise<Frame[]> {
  const html = await getCached<string>(`${dir}/`, 300, "text");
  const names = [...html.matchAll(/href="(\d{11}_[^"]+?)"/g)].map((m) => m[1]).filter((n) => n.endsWith(suffix));
  return [...new Set(names)]
    .sort()
    .slice(-count)
    .map((n) => ({ url: `${dir}/${n}`, t: starTime(n) }));
}

/** STAR keeps floaters only over the NHC and CPHC basins (GOES East and West). */
export const hasFloater = (id: string) => /^(al|ep|cp)/.test(id);

/** A storm's floater: STAR follows every active storm with a 1000 km box. */
export function floaterFrames(id: string, band: string, count = 400): Promise<Frame[]> {
  return starFrames(`${STAR}/FLOATER/data/${id.toUpperCase()}/${band}`, "-1000x1000.jpg", count);
}

export const SAT_SECTORS: { id: string; sat: string; label: string; size: string }[] = [
  { id: "taw", sat: "GOES19", label: "Tropical Atlantic", size: "1800x1080" },
  { id: "car", sat: "GOES19", label: "Caribbean", size: "1000x1000" },
  { id: "ga", sat: "GOES19", label: "Gulf of America", size: "1000x1000" },
  { id: "pr", sat: "GOES19", label: "Puerto Rico", size: "1200x1200" },
  { id: "eus", sat: "GOES19", label: "Eastern US", size: "1000x1000" },
  { id: "eep", sat: "GOES19", label: "East Pacific (GOES-19)", size: "1800x1080" },
  { id: "tpw", sat: "GOES18", label: "Tropical Pacific", size: "1800x1080" },
  { id: "hi", sat: "GOES18", label: "Hawaii", size: "1200x1200" },
  { id: "tsp", sat: "GOES18", label: "Tropical South Pacific", size: "1800x1080" },
];

export const SAT_BANDS: { id: string; label: string }[] = [
  { id: "GEOCOLOR", label: "GeoColor" },
  { id: "13", label: "Clean IR (13)" },
  { id: "09", label: "Mid water vapor (09)" },
  { id: "08", label: "Upper water vapor (08)" },
  { id: "02", label: "Red visible (02)" },
  { id: "AirMass", label: "Air mass" },
  { id: "Sandwich", label: "Sandwich" },
  { id: "Dust", label: "Dust (SAL)" },
];

export async function sectorFrames(sector: string, sat: string, band: string, size: string, count = 400): Promise<Frame[]> {
  return starFrames(`${STAR}/${sat}/ABI/SECTOR/${sector}/${band}`, `-${size}.jpg`, count);
}

// ---------------------------------------------------------------- picture products

export interface Picture {
  id: string;
  label: string;
  url: string;
  about?: string;
  href?: string;
}

const CPC = "https://www.cpc.ncep.noaa.gov";
const CRW = "https://coralreefwatch.noaa.gov/data_current/5km/v3.1_op/daily/png";

export const ENSO_PICTURES: Picture[] = [
  { id: "sstweek", label: "Weekly SST anomalies", url: `${CPC}/products/analysis_monitoring/enso_update/sstweek_c.gif`, about: "CPC's weekly global SST anomaly." },
  { id: "fig1", label: "SST departures", url: `${CPC}/products/analysis_monitoring/enso_advisory/figure01.gif` },
  { id: "fig2", label: "Nino region time series", url: `${CPC}/products/analysis_monitoring/enso_advisory/figure02.gif` },
  { id: "fig3", label: "Subsurface heat content", url: `${CPC}/products/analysis_monitoring/enso_advisory/figure03.gif` },
  { id: "fig4", label: "Equatorial subsurface", url: `${CPC}/products/analysis_monitoring/enso_advisory/figure04.gif` },
  { id: "fig5", label: "Outgoing longwave radiation", url: `${CPC}/products/analysis_monitoring/enso_advisory/figure05.gif` },
  { id: "fig6", label: "Low-level winds", url: `${CPC}/products/analysis_monitoring/enso_advisory/figure06.gif` },
  { id: "fig7", label: "Model forecasts", url: `${CPC}/products/analysis_monitoring/enso_advisory/figure07.gif` },
  { id: "cfs34m", label: "CFSv2 Nino 3.4, monthly", url: `${CPC}/products/CFSv2/imagesInd3/nino34Mon.gif`, about: "NCEP CFSv2 forecast plume for Nino 3.4." },
  { id: "cfs34s", label: "CFSv2 Nino 3.4, seasonal", url: `${CPC}/products/CFSv2/imagesInd3/nino34Sea.gif` },
  { id: "cfs3", label: "CFSv2 Nino 3", url: `${CPC}/products/CFSv2/imagesInd3/nino3Mon.gif` },
  { id: "cfs4", label: "CFSv2 Nino 4", url: `${CPC}/products/CFSv2/imagesInd3/nino4Mon.gif` },
  { id: "cfs12", label: "CFSv2 Nino 1+2", url: `${CPC}/products/CFSv2/imagesInd3/nino12Mon.gif` },
  { id: "xzt", label: "Equatorial temperature with depth", url: `${CPC}/products/analysis_monitoring/ocean/weeklyenso_clim_81-10/wkteq_xz.gif`, about: "Temperature anomaly down to 450 m along the equator: Kelvin waves show here first." },
  { id: "heat", label: "Upper-ocean heat, past year", url: `${CPC}/products/analysis_monitoring/enso_update/heat-last-year.gif` },
  { id: "sstanim", label: "Tropical Pacific SST, animated", url: `${CPC}/products/analysis_monitoring/enso_update/sstanim.gif` },
  { id: "mjo-gefs", label: "MJO forecast, GEFS", url: `${CPC}/products/precip/mjo/img/GEFS_BC.png`, about: "The MJO's phase and amplitude (RMM) forecast by the bias-corrected GEFS." },
  { id: "mjo-ngfs", label: "MJO forecast, GFS", url: `${CPC}/products/precip/mjo/img/NGFS.png` },
  { id: "olr", label: "OLR anomaly, last 180 days", url: `${CPC}/products/intraseasonal/olr_hov_last180days_2.gif`, about: "Time-longitude band of convection: the MJO travels east through it." },
  { id: "vpot", label: "200 hPa velocity potential", url: `${CPC}/products/intraseasonal/tlon_vpot_web_2.gif` },
  { id: "gth", label: "Global tropics hazards", url: `${CPC}/products/precip/CWlink/ghazards/images/gth_full_update.png`, about: "CPC's weeks 2 and 3 outlook of tropical cyclone formation and rain." },
];

export const OCEAN_PICTURES: Picture[] = [
  { id: "crw-sst", label: "CoralTemp SST", url: `${CRW}/coraltemp_v3.1_global_current.png`, about: "NOAA Coral Reef Watch 5 km daily SST." },
  { id: "crw-ssta", label: "SST anomaly", url: `${CRW}/ct5km_ssta_v3.1_global_current.png` },
  { id: "crw-hs", label: "Coral bleaching HotSpot", url: `${CRW}/ct5km_hs_v3.1_global_current.png` },
  { id: "crw-dhw", label: "Degree heating weeks", url: `${CRW}/ct5km_dhw_v3.1_global_current.png`, about: "Accumulated heat stress: over 4 bleaching is likely, over 8 widespread." },
  { id: "crw-baa", label: "Bleaching alert (7-day max)", url: `${CRW}/ct5km_baa5-max-7d_v3.1_global_current.png` },
];

/** NHC's 7-day graphical outlook, per basin. */
export const TWO_PICTURES: Picture[] = [
  { id: "atl", label: "Atlantic", url: "https://www.nhc.noaa.gov/xgtwo/two_atl_7d0.png", href: "https://www.nhc.noaa.gov/gtwo.php?basin=atlc&fdays=7" },
  { id: "pac", label: "East Pacific", url: "https://www.nhc.noaa.gov/xgtwo/two_pac_7d0.png", href: "https://www.nhc.noaa.gov/gtwo.php?basin=epac&fdays=7" },
  { id: "cpac", label: "Central Pacific", url: "https://www.nhc.noaa.gov/xgtwo/two_cpac_7d0.png", href: "https://www.nhc.noaa.gov/gtwo.php?basin=cpac&fdays=7" },
];

export async function jtwcOutlook(which: "abpw" | "abio"): Promise<string> {
  return getCached(`https://www.metoc.navy.mil/jtwc/products/${which}web.txt`, 600, "text");
}
