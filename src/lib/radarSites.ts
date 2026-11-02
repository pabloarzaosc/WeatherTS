// Radar sites (radar-sites): the live standing of every NEXRAD, and what the
// site list, the search and the radar's own panel say about a radar.
//
// The standing comes from the backend (backend/radar_status.py), which reads
// the NWS radar feed once a minute: when each radar's Level II data last came
// in and how late it arrives, the RDA's alarms, the office's outage notice.

import { BACKEND_BASE } from "./apiConfig";
import type { NexradSite } from "./nexrad";
import { isBrazilSite } from "./brazilRadar";

const BASE = BACKEND_BASE;

/** ok blue, late orange, stale yellow, down red, unknown gray. */
export type SiteClass = "ok" | "late" | "stale" | "down" | "unknown";

export interface SiteStatusRow {
  icao: string;
  name?: string | null;
  /** Unix of the newest Level II the NWS received. */
  l2: number | null;
  /** Seconds since the newest data, at the feed's `at`. */
  age: number | null;
  /** Seconds the data arrives behind the radar. */
  lat: number | null;
  vcp: string | null;
  /** "No Alarms", "Tower/Utilities|Transmitter", ... */
  alarm: string | null;
  /** RDA state: "Operate", "Start-Up", "Standby". */
  rda: string | null;
  /** "RDA - On-line", "RDA - Inoperable", ... */
  op: string | null;
  mode: string | null;
  st: SiteClass;
  /** Newest Level III N0B, when the feed called the radar quiet and the bucket was asked. */
  l3?: number;
  /** "level3": classed by the Level III bucket, newer than the feed. */
  via?: string;
}

export interface SiteStatusFeed {
  at: number | null;
  now: number;
  error: string | null;
  sites: Record<string, SiteStatusRow>;
}

export interface SiteAlarm {
  message: string;
  status: string;
  at: number;
}

export interface SiteNotice {
  text: string;
  at: number | null;
  office: string | null;
  name: string | null;
  count: number;
}

export interface SiteDetail extends Partial<SiteStatusRow> {
  id: string;
  icao: string;
  checked: number;
  alarms?: SiteAlarm[];
  notice?: SiteNotice | null;
  level2?: { lastChunkUnix: number | null; volumeUnix: number | null; vol: number | null; complete: boolean; stale: boolean } | null;
  level3?: number | null;
  errors?: Record<string, string>;
}

export async function fetchSiteStatus(signal?: AbortSignal): Promise<SiteStatusFeed> {
  const r = await fetch(`${BASE}/api/nexrad/site-status`, { cache: "no-store", signal });
  if (!r.ok) throw new Error(`site status ${r.status}`);
  return r.json();
}

export async function fetchSiteDetail(site: string, signal?: AbortSignal): Promise<SiteDetail> {
  const r = await fetch(`${BASE}/api/nexrad/site-status/detail?site=${encodeURIComponent(site)}`, { cache: "no-store", signal });
  if (!r.ok) throw new Error(`site detail ${r.status}`);
  return r.json();
}

export async function fetchSiteScans(ids: string[], signal?: AbortSignal): Promise<Record<string, number | null>> {
  const r = await fetch(`${BASE}/api/nexrad/site-scans?ids=${encodeURIComponent(ids.join(","))}`, { cache: "no-store", signal });
  if (!r.ok) throw new Error(`site scans ${r.status}`);
  return (await r.json()).scans ?? {};
}

export const CLASS_LABEL: Record<SiteClass, string> = {
  ok: "Live",
  late: "Arriving late",
  stale: "No new data",
  down: "Down",
  unknown: "Status unknown",
};

/** "45 s", "12 min", "6 h 20 min", "3 d 4 h". */
export function fmtAge(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** One line on a radar's standing, e.g. "Live · newest data 40 s ago". */
export function classLine(row: SiteStatusRow | null | undefined, ageNow: number | null): string {
  if (!row) return "Status unknown · the NWS radar feed has no record of it";
  switch (row.st) {
    case "ok":
      return `Live · newest data ${fmtAge(ageNow)} ago`;
    case "late":
      return `Arriving late · data ${fmtAge(row.lat)} behind the radar`;
    case "stale":
      return `No new data for ${fmtAge(ageNow)}`;
    case "down":
      return `Down · no data for ${fmtAge(ageNow)}`;
    default:
      return "Status unknown";
  }
}

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const h =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "427 km" or "265 mi", as Settings > Radar > Readout distances has it. */
export function fmtKm(km: number, unit: string | null | undefined): string {
  if (unit === "km") return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
  const mi = km * 0.621371;
  return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
}

/* --------------------------------------------------------------- the site -- */

// The NEXRAD network is run by three agencies. The radars on Air Force and
// Army bases are the Department of Defense's, the twelve in Alaska, Hawaii
// and Puerto Rico the FAA's, the rest the National Weather Service's.
const AIR_FORCE = new Set(["BBX", "DFX", "DOX", "DYX", "EVX", "EYX", "FDX", "GUA", "GWX", "HDX", "JGX", "KJK", "MBX", "MXX", "ODN", "VAX", "VBX", "VNX"]);
const ARMY = new Set(["EOX", "GRK", "HPX", "POE", "KSG"]);
const FAA = new Set(["ABC", "ACG", "AEC", "AHG", "AIH", "AKC", "APD", "HKI", "HKM", "HMO", "HWA", "JUA"]);

type SiteLike = Pick<NexradSite, "id" | "icao" | "name" | "country"> & Partial<NexradSite> & { operator?: string; band?: string | null };

export function operatorOf(site: SiteLike): string {
  if (isBrazilSite(site.id)) return site.operator || "—";
  if (site.type === "TDWR") return "Federal Aviation Administration";
  if (AIR_FORCE.has(site.id)) return "US Air Force";
  if (ARMY.has(site.id)) return "US Army";
  if (FAA.has(site.id)) return "Federal Aviation Administration";
  return "National Weather Service";
}

/** The kind of radar, for the list's Type column. */
export function typeOf(site: SiteLike): string {
  if (isBrazilSite(site.id)) return site.band ? `${site.band}-band` : "Weather radar";
  if (site.type === "TDWR") return "TDWR";
  return "WSR-88D";
}

/** The place without the operator a Brazilian name carries ("Pico do Couto · DECEA"). */
export function placeOf(site: SiteLike): string {
  return String(site.name || site.icao).split(" · ")[0];
}

/** One line on what an airport radar is, for the radar's own panel. */
export const TDWR_NOTE =
  "FAA airport radar (TDWR): close to the airport and sharper there, but shorter range than a NEXRAD: about 90 km for reflectivity and velocity, 417 km for long-range reflectivity. C-band, no dual-pol; heavy rain weakens its beam and velocity folds often.";

export function isUS(site: SiteLike): boolean {
  return site.country === "US";
}

const COUNTRY: Record<string, string> = { US: "United States", BR: "Brazil", KR: "South Korea", JP: "Japan" };
export function countryName(code: string | null | undefined): string {
  return (code && COUNTRY[code]) || code || "—";
}

export const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  PR: "Puerto Rico", GU: "Guam", VI: "U.S. Virgin Islands",
};

/** A volume coverage pattern in words, and about how long one volume takes. */
const VCP_INFO: Record<string, { label: string; minutes: number }> = {
  "12": { label: "Severe weather · fast, dense low tilts", minutes: 4.5 },
  "212": { label: "Precipitation and severe weather · fast", minutes: 4.5 },
  "112": { label: "Precipitation · wide-range velocity", minutes: 5.5 },
  "121": { label: "Precipitation · velocity dealiasing", minutes: 5.5 },
  "215": { label: "Precipitation · general", minutes: 6 },
  "35": { label: "Clear air", minutes: 7 },
  "31": { label: "Clear air · long pulse", minutes: 10 },
  "32": { label: "Clear air · short pulse", minutes: 10 },
  "11": { label: "Precipitation (legacy)", minutes: 5 },
  "21": { label: "Precipitation (legacy)", minutes: 6 },
  // TDWR (airport radars)
  "80": { label: "Hazardous · lowest tilt every minute", minutes: 6 },
  "90": { label: "Monitor · a volume every six minutes", minutes: 6 },
};
export function vcpInfo(vcp: string | number | null | undefined): { label: string; minutes: number | null } | null {
  if (vcp == null || vcp === "") return null;
  const k = String(vcp);
  return VCP_INFO[k] ?? { label: "Scan strategy", minutes: null };
}

/** The app's id for "KTLX" / "TLX" / "tlx" / "PABC", or null. */
export function resolveSiteId(raw: string | null | undefined, sites: NexradSite[]): string | null {
  const v = String(raw ?? "").trim().toUpperCase();
  if (!v) return null;
  const hit = sites.find((s) => s.id === v || s.icao === v) ?? (v.length === 3 ? sites.find((s) => s.icao.slice(1) === v) : undefined);
  return hit?.id ?? null;
}

/* ------------------------------------------------------------- the search -- */

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();

/**
 * Radars for a search box query: an id with or without its first letter
 * ("tlx" and "ktlx" both find KTLX), a place name, a state's code or name.
 * Best match first.
 */
export function searchRadars(sites: NexradSite[], query: string, limit = 6): NexradSite[] {
  const q = fold(query.trim());
  if (q.length < 2) return [];
  const scored: { s: NexradSite; score: number }[] = [];
  for (const s of sites) {
    const icao = s.icao.toUpperCase();
    const id = s.id.toUpperCase();
    const name = fold(placeOf(s));
    const st = (s.state || "").toUpperCase();
    const stName = st ? fold(US_STATES[st] ?? "") : "";
    let score = 0;
    if (icao === q || id === q || (q.length === 3 && icao.slice(1) === q)) score = 100;
    else if (q.length >= 2 && (icao.startsWith(q) || id.startsWith(q))) score = 75;
    else if (name === q) score = 70;
    else if (name.startsWith(q)) score = 60;
    else if (q.length >= 3 && name.split(/[\s/,.-]+/).some((w) => w.startsWith(q))) score = 50;
    else if (q.length === 2 && st === q) score = 45;
    else if (q.length >= 3 && stName && stName.startsWith(q)) score = 42;
    else if (q.length >= 4 && name.includes(q)) score = 35;
    if (score) scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score || a.s.icao.localeCompare(b.s.icao));
  return scored.slice(0, limit).map((x) => x.s);
}
