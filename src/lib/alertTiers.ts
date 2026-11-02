/**
 * Alert intensity tiers, hazard groups and the small facts read out of an NWS
 * alert (storm motion, states, forecast office, VTEC).
 *
 * Pure and with no runtime imports, so scripts/test-alert-tiers.mjs runs it
 * under plain node (type stripping) -- keep it that way: a value import here
 * breaks the test.
 *
 * A tier comes from the impact tags the NWS puts in a warning's parameters
 * (tornadoDetection, tornadoDamageThreat, thunderstormDamageThreat,
 * flashFloodDetection, flashFloodDamageThreat, snowSquallDetection,
 * snowSquallImpact). Where a tag is missing -- older products, statements,
 * watches -- the text's own wording (TORNADO EMERGENCY, PARTICULARLY DANGEROUS
 * SITUATION ...) stands in for it. The highest tier an alert reaches wins.
 */

import type { NwsAlert } from "./nwsAlerts";

/* ------------------------------------------------------------- sounds --- */

export type AlertSoundId = "none" | "double" | "triple" | "alarm" | "siren1" | "siren2" | "broadcast" | "chime";

export const ALERT_SOUNDS: { id: AlertSoundId; label: string }[] = [
  { id: "none", label: "No sound" },
  { id: "double", label: "Double beep" },
  { id: "triple", label: "Fast triple beep" },
  { id: "alarm", label: "Descending alarm" },
  { id: "siren1", label: "Wail siren" },
  { id: "siren2", label: "Yelp siren" },
  { id: "broadcast", label: "Broadcast tone" },
  { id: "chime", label: "Soft chime" },
];

/* ------------------------------------------------------ hazard groups --- */

export type HazardGroup = "severe" | "winter" | "hydro" | "wind" | "fire" | "tropical" | "marine" | "other";

export const HAZARD_GROUPS: { id: HazardGroup; label: string }[] = [
  { id: "severe", label: "Severe" },
  { id: "winter", label: "Winter" },
  { id: "hydro", label: "Hydro" },
  { id: "wind", label: "Wind / Air" },
  { id: "fire", label: "Fire / Heat" },
  { id: "tropical", label: "Tropical" },
  { id: "marine", label: "Marine" },
  { id: "other", label: "Other" },
];

/** First match wins, so the compound names come before the words they contain
 *  ("hurricane force wind" is marine, not tropical; "freezing spray" marine,
 *  not winter; "extreme wind" severe, not wind). */
const HAZARD_RULES: [RegExp, HazardGroup][] = [
  [/hurricane force wind|freezing spray|special marine|marine|small craft|gale|hazardous seas|surf|rip current|beach hazard|brisk wind|low water|tsunami|^storm (warning|watch)/i, "marine"],
  [/storm surge|hurricane|tropical|typhoon/i, "tropical"],
  [/tornado|severe thunderstorm|severe weather statement|extreme wind|special weather statement/i, "severe"],
  [/flood|hydrologic/i, "hydro"],
  [/freezing fog|dense fog|dense smoke|dust|air quality|air stagnation|ashfall|wind/i, "wind"],
  [/fire|red flag|heat/i, "fire"],
  [/winter|blizzard|ice storm|snow|freeze|frost|cold|wind chill|avalanche/i, "winter"],
];

export function hazardOf(event: string): HazardGroup {
  for (const [re, g] of HAZARD_RULES) if (re.test(event)) return g;
  return "other";
}

/** Every NWS event name (api.weather.gov/alerts/types, 2026-10), less "Test". */
export const NWS_EVENTS: string[] = [
  "911 Telephone Outage", "Administrative Message", "Air Quality Alert", "Air Stagnation Advisory", "Ashfall Advisory",
  "Ashfall Warning", "Avalanche Advisory", "Avalanche Warning", "Avalanche Watch", "Beach Hazards Statement",
  "Blizzard Warning", "Blowing Dust Advisory", "Blowing Dust Warning", "Blue Alert", "Brisk Wind Advisory",
  "Child Abduction Emergency", "Civil Danger Warning", "Civil Emergency Message", "Coastal Flood Advisory",
  "Coastal Flood Statement", "Coastal Flood Warning", "Coastal Flood Watch", "Cold Weather Advisory",
  "Dense Fog Advisory", "Dense Smoke Advisory", "Dust Advisory", "Dust Storm Warning", "Earthquake Warning",
  "Evacuation Immediate", "Extreme Heat Warning", "Extreme Heat Watch", "Extreme Cold Warning", "Extreme Cold Watch",
  "Extreme Fire Danger", "Extreme Wind Warning", "Fire Warning", "Fire Weather Watch", "Flash Flood Statement",
  "Flash Flood Warning", "Flash Flood Watch", "Flood Advisory", "Flood Statement", "Flood Warning", "Flood Watch",
  "Freeze Warning", "Freeze Watch", "Freezing Fog Advisory", "Freezing Spray Advisory", "Frost Advisory",
  "Gale Warning", "Gale Watch", "Hazardous Materials Warning", "Hazardous Seas Warning", "Hazardous Seas Watch",
  "Hazardous Weather Outlook", "Heat Advisory", "Heavy Freezing Spray Warning", "Heavy Freezing Spray Watch",
  "High Surf Advisory", "High Surf Warning", "High Wind Warning", "High Wind Watch", "Hurricane Force Wind Warning",
  "Hurricane Force Wind Watch", "Hurricane Warning", "Hurricane Watch", "Hydrologic Outlook", "Ice Storm Warning",
  "Lake Effect Snow Warning", "Lake Wind Advisory", "Lakeshore Flood Advisory", "Lakeshore Flood Statement",
  "Lakeshore Flood Warning", "Lakeshore Flood Watch", "Law Enforcement Warning", "Local Area Emergency",
  "Low Water Advisory", "Marine Weather Statement", "Nuclear Power Plant Warning", "Radiological Hazard Warning",
  "Red Flag Warning", "Rip Current Statement", "Severe Thunderstorm Warning", "Severe Thunderstorm Watch",
  "Severe Weather Statement", "Shelter In Place Warning", "Short Term Forecast", "Small Craft Advisory",
  "Snow Squall Warning", "Special Marine Warning", "Special Weather Statement", "Storm Surge Warning",
  "Storm Surge Watch", "Storm Warning", "Storm Watch", "Tornado Warning", "Tornado Watch",
  "Tropical Cyclone Local Statement", "Tropical Storm Warning", "Tropical Storm Watch", "Tsunami Advisory",
  "Tsunami Warning", "Tsunami Watch", "Typhoon Warning", "Typhoon Watch", "Volcano Warning", "Wind Advisory",
  "Winter Storm Warning", "Winter Storm Watch", "Winter Weather Advisory",
];

/** "Tornado Warning" -> "tornado-warning": the key part of a type's settings. */
export function eventSlug(event: string): string {
  return event.trim().toLowerCase().replace(/\s+/g, "-");
}

/** The sound a type plays by default: the warnings a chaser listens for, and
 *  the two convective watches. Everything else starts silent. */
const DEFAULT_TYPE_SOUNDS: Record<string, AlertSoundId> = {
  "tornado warning": "triple",
  "severe thunderstorm warning": "double",
  "flash flood warning": "double",
  "snow squall warning": "double",
  "extreme wind warning": "siren2",
  "tornado watch": "broadcast",
  "severe thunderstorm watch": "broadcast",
};

export function defaultTypeSound(event: string): AlertSoundId {
  return DEFAULT_TYPE_SOUNDS[event.trim().toLowerCase()] ?? "none";
}

/* --------------------------------------------------------------- tiers --- */

export type TierFamily = "tor" | "svr" | "ffw" | "sqw" | "watch" | "pds";

export interface TierDef {
  id: string;
  family: TierFamily;
  /** The tier's own name, shown on its chip. */
  label: string;
  /** What it is a tier of, for the settings page. */
  of: string;
  /** Higher is more urgent; also orders a batch's sound. */
  rank: number;
  color: string;
  sound: AlertSoundId;
  /** What makes it, for the settings page. */
  hint: string;
}

export const ALERT_TIERS: TierDef[] = [
  { id: "tor-observed", family: "tor", of: "Tornado Warning", label: "Observed", rank: 90, color: "#ff4f9a", sound: "triple",
    hint: "A tornado seen or confirmed (tornadoDetection OBSERVED)." },
  { id: "tor-pds", family: "tor", of: "Tornado Warning", label: "PDS", rank: 95, color: "#d400ff", sound: "siren1",
    hint: "Particularly dangerous situation (tornadoDamageThreat CONSIDERABLE)." },
  { id: "tor-emergency", family: "tor", of: "Tornado Warning", label: "Emergency", rank: 100, color: "#7b2cff", sound: "alarm",
    hint: "Tornado emergency (tornadoDamageThreat CATASTROPHIC)." },
  { id: "svr-considerable", family: "svr", of: "Severe Thunderstorm Warning", label: "Considerable", rank: 70, color: "#ffd000", sound: "double",
    hint: "thunderstormDamageThreat CONSIDERABLE: 70+ mph wind or 1.75\"+ hail." },
  { id: "svr-destructive", family: "svr", of: "Severe Thunderstorm Warning", label: "Destructive", rank: 85, color: "#ff5a00", sound: "triple",
    hint: "thunderstormDamageThreat DESTRUCTIVE: 80+ mph wind or 2.75\"+ hail." },
  { id: "svr-eds", family: "svr", of: "Severe Thunderstorm Warning", label: "Extremely dangerous", rank: 88, color: "#c4ff00", sound: "siren2",
    hint: "Destructive with 100+ mph wind, or \"extremely dangerous situation\" in the text." },
  { id: "ffw-observed", family: "ffw", of: "Flash Flood Warning", label: "Observed", rank: 66, color: "#5cff8a", sound: "double",
    hint: "Flash flooding seen or reported (flashFloodDetection OBSERVED)." },
  { id: "ffw-considerable", family: "ffw", of: "Flash Flood Warning", label: "Considerable", rank: 75, color: "#00d6b4", sound: "triple",
    hint: "flashFloodDamageThreat CONSIDERABLE." },
  { id: "ffw-emergency", family: "ffw", of: "Flash Flood Warning", label: "Emergency", rank: 92, color: "#e6ff00", sound: "alarm",
    hint: "Flash flood emergency (flashFloodDamageThreat CATASTROPHIC)." },
  { id: "sqw-observed", family: "sqw", of: "Snow Squall Warning", label: "Observed", rank: 64, color: "#e0b3ff", sound: "double",
    hint: "snowSquallDetection OBSERVED." },
  { id: "sqw-significant", family: "sqw", of: "Snow Squall Warning", label: "Significant", rank: 68, color: "#9b5cff", sound: "triple",
    hint: "snowSquallImpact SIGNIFICANT." },
  { id: "sqw-pds", family: "sqw", of: "Snow Squall Warning", label: "PDS", rank: 82, color: "#ff7ad9", sound: "siren1",
    hint: "\"Particularly dangerous situation\" in the text." },
  { id: "watch-pds", family: "watch", of: "Watches", label: "PDS", rank: 72, color: "#ff8a00", sound: "broadcast",
    hint: "A watch the text calls a particularly dangerous situation." },
  { id: "pds", family: "pds", of: "Other warnings", label: "PDS", rank: 60, color: "#ff4fd8", sound: "triple",
    hint: "Flood, marine, wind, dust, fire and tropical products that call it a particularly dangerous situation." },
];

export const TIER_BY_ID = new Map(ALERT_TIERS.map((t) => [t.id, t]));

/** The fields alertTier reads, so tests can pass a plain object. */
export type TierInput = Pick<NwsAlert, "event" | "headline" | "description" | "parameters">;

const first = (a: TierInput, key: string): string | undefined => {
  const v = a.parameters?.[key];
  return Array.isArray(v) && v.length > 0 ? String(v[0]).trim().toUpperCase() : undefined;
};

/** Miles per hour in a maxWindGust value ("70 MPH", "Up to 50 MPH", "60 KTS"). */
function gustMph(a: TierInput): number {
  const raw = first(a, "maxWindGust");
  if (!raw) return 0;
  const m = raw.match(/(\d+(?:\.\d+)?)\s*(MPH|KTS?|KNOTS?)?/);
  if (!m) return 0;
  const n = Number(m[1]);
  return /KT|KNOT/.test(m[2] ?? "") ? n * 1.15078 : n;
}

const PDS_RE = /PARTICULARLY\s+DANGEROUS\s+SITUATION/;

/**
 * The tier an alert reaches, or null for a plain one. Tags decide when they
 * are there; the wording only stands in for a tag that is missing, so a
 * statement that merely mentions an earlier emergency does not become one.
 */
export function alertTier(a: TierInput): TierDef | null {
  const event = (a.event || "").toLowerCase();
  const text = `${a.event ?? ""} ${a.headline ?? ""} ${first(a, "NWSheadline") ?? ""} ${a.description ?? ""}`
    .toUpperCase()
    .replace(/\s+/g, " ");
  const tier = (id: string) => TIER_BY_ID.get(id) ?? null;

  if (/tornado (warning|emergency)/.test(event) || (event === "severe weather statement" && first(a, "tornadoDetection"))) {
    const damage = first(a, "tornadoDamageThreat");
    const detection = first(a, "tornadoDetection");
    if (damage === "CATASTROPHIC" || (!damage && /TORNADO EMERGENCY/.test(text))) return tier("tor-emergency");
    if (damage === "CONSIDERABLE" || (!damage && PDS_RE.test(text))) return tier("tor-pds");
    if (detection === "OBSERVED" || (!detection && /TORNADO\.{3}OBSERVED|CONFIRMED TORNADO/.test(text))) return tier("tor-observed");
    return null;
  }
  if (event.includes("severe thunderstorm warning")) {
    const damage = first(a, "thunderstormDamageThreat");
    if (/EXTREMELY DANGEROUS SITUATION/.test(text) || (damage === "DESTRUCTIVE" && gustMph(a) >= 100)) return tier("svr-eds");
    if (damage === "DESTRUCTIVE" || (!damage && /DAMAGE THREAT\.{3}DESTRUCTIVE/.test(text))) return tier("svr-destructive");
    if (damage === "CONSIDERABLE" || (!damage && /DAMAGE THREAT\.{3}CONSIDERABLE/.test(text))) return tier("svr-considerable");
    return null;
  }
  if (event.includes("flash flood warning") || event.includes("flash flood statement") || event.includes("flash flood emergency")) {
    const damage = first(a, "flashFloodDamageThreat");
    const detection = first(a, "flashFloodDetection");
    if (damage === "CATASTROPHIC" || (!damage && /FLASH FLOOD EMERGENCY/.test(text))) return tier("ffw-emergency");
    if (damage === "CONSIDERABLE" || (!damage && /FLASH FLOOD DAMAGE THREAT\.{3}CONSIDERABLE/.test(text))) return tier("ffw-considerable");
    if (detection === "OBSERVED" || (!detection && /FLASH FLOODING\.{3}OBSERVED/.test(text))) return tier("ffw-observed");
    return null;
  }
  if (event.includes("snow squall warning")) {
    const impact = first(a, "snowSquallImpact");
    const detection = first(a, "snowSquallDetection");
    if (PDS_RE.test(text)) return tier("sqw-pds");
    if (impact === "SIGNIFICANT" || (!impact && /SNOW SQUALL IMPACT\.{3}SIGNIFICANT/.test(text))) return tier("sqw-significant");
    if (detection === "OBSERVED" || (!detection && /SNOW SQUALL\.{3}OBSERVED/.test(text))) return tier("sqw-observed");
    return null;
  }
  if (event.includes("watch")) return PDS_RE.test(text) ? tier("watch-pds") : null;
  if (/warning|emergency/.test(event) && PDS_RE.test(text)) return tier("pds");
  return null;
}

/** How urgent an alert is when no tier lifts it: the base of a batch's order. */
const BASE_URGENCY: [RegExp, number][] = [
  [/tornado warning/i, 80],
  [/extreme wind warning/i, 84],
  [/severe thunderstorm warning/i, 60],
  [/flash flood warning/i, 58],
  [/snow squall warning/i, 56],
  [/tornado watch/i, 50],
  [/severe thunderstorm watch/i, 45],
  [/warning|emergency/i, 30],
  [/watch/i, 20],
  [/advisory/i, 10],
];

/** Urgency on one scale for the tiered and the plain: the most urgent of a
 *  batch is the one that sounds. */
export function alertUrgency(a: TierInput): number {
  const t = alertTier(a);
  if (t) return t.rank;
  for (const [re, n] of BASE_URGENCY) if (re.test(a.event || "")) return n;
  return 5;
}

/* -------------------------------------------------------- storm motion --- */

export interface StormMotion {
  /** Unix seconds of the position. */
  time: number | null;
  /** Where it moves from, degrees (the NWS figure). */
  fromDeg: number;
  /** Where it heads, degrees. */
  towardDeg: number;
  kt: number;
  /** Positions as [lon, lat]: one for a cell, several along a line. */
  points: [number, number][];
}

/**
 * eventMotionDescription, e.g.
 * "2026-10-25T04:48:00-00:00...storm...228DEG...30KT...31.71,-105.37"
 * (a line of storms lists several positions, space separated). The degrees
 * are where the storm comes FROM, as in the text's TIME...MOT...LOC line.
 */
export function parseStormMotion(raw: string | undefined | null): StormMotion | null {
  if (!raw) return null;
  const m = raw.match(/^(.*?)\.\.\.[a-z ]+\.\.\.(\d{1,3})DEG\.\.\.(\d{1,3})KT\.\.\.(.*)$/i);
  if (!m) return null;
  const fromDeg = Number(m[2]) % 360;
  const kt = Number(m[3]);
  if (!Number.isFinite(fromDeg) || !Number.isFinite(kt)) return null;
  const points: [number, number][] = [];
  for (const pair of m[4].trim().split(/\s+/)) {
    const [lat, lon] = pair.split(",").map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) points.push([lon, lat]);
  }
  const t = Date.parse(m[1]);
  return { time: Number.isNaN(t) ? null : Math.round(t / 1000), fromDeg, towardDeg: (fromDeg + 180) % 360, kt, points };
}

const COMPASS = ["North", "Northeast", "East", "Southeast", "South", "Southwest", "West", "Northwest"];

export function compassName(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** "Southeast (130°) at 6 kt": where it heads, and how fast. */
export function motionText(m: StormMotion): string {
  if (m.kt === 0) return "Stationary";
  return `${compassName(m.towardDeg)} (${Math.round(m.towardDeg)}°) at ${Math.round(m.kt)} kt`;
}

/** The point `km` along heading `deg` from [lon, lat], on a sphere. */
export function destination(p: [number, number], deg: number, km: number): [number, number] {
  const R = 6371;
  const d = km / R;
  const th = (deg * Math.PI) / 180;
  const la1 = (p[1] * Math.PI) / 180;
  const lo1 = (p[0] * Math.PI) / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(th));
  const lo2 = lo1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [(((lo2 * 180) / Math.PI + 540) % 360) - 180, (la2 * 180) / Math.PI];
}

/* ------------------------------------------------- states, office, VTEC --- */

const STATES = new Set(
  ("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA " +
    "RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP").split(" "),
);

/** The states an alert covers: from its zone ids (OKC109, TXZ025), else from
 *  the area text ("Tulsa, OK; Creek, OK" or "Dyer [TN]"). Marine zones
 *  (GMZ, PZZ ...) are no state. */
export function alertStates(a: Pick<NwsAlert, "affectedZones" | "areaDesc">): string[] {
  const out = new Set<string>();
  for (const url of a.affectedZones ?? []) {
    const id = url.slice(url.lastIndexOf("/") + 1).toUpperCase();
    const st = id.slice(0, 2);
    if (/^[A-Z]{2}[CZ]\d{3}$/.test(id) && STATES.has(st)) out.add(st);
  }
  if (out.size === 0) {
    for (const m of (a.areaDesc ?? "").matchAll(/(?:,\s*|\[)([A-Z]{2})(?=\]|;|$)/g)) if (STATES.has(m[1])) out.add(m[1]);
  }
  return [...out].sort();
}

export interface Vtec {
  action: string;
  office: string;
  phen: string;
  sig: string;
  etn: string;
  /** office.phen.sig.etn: one event across its updates. */
  key: string;
}

export function alertVtec(a: Pick<NwsAlert, "parameters">): Vtec | null {
  const raw = a.parameters?.VTEC;
  for (const v of Array.isArray(raw) ? raw : []) {
    const m = String(v).match(/\/[OTEX]\.([A-Z]{3})\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\./);
    if (m) return { action: m[1], office: m[2], phen: m[3], sig: m[4], etn: m[5], key: `${m[2]}.${m[3]}.${m[4]}.${m[5]}` };
  }
  return null;
}

/** The issuing forecast office's three-letter id (OUN, EPZ), or "". */
export function alertWfo(a: Pick<NwsAlert, "parameters" | "senderName">): string {
  const awips = a.parameters?.AWIPSidentifier?.[0];
  if (awips && /^[A-Z0-9]{3}[A-Z]{3}$/i.test(awips)) return awips.slice(3).toUpperCase();
  const v = alertVtec(a);
  if (v) return v.office.slice(1);
  const m = (a.senderName ?? "").match(/^NWS ([A-Z]{3})$/);
  return m ? m[1] : "";
}

/** "OK, tx ks" -> ["OK", "TX", "KS"]: a filter list typed in Settings. */
export function parseCodeList(raw: string, len: number): string[] {
  return [...new Set((raw ?? "").toUpperCase().split(/[^A-Z0-9]+/).filter((c) => c.length === len))];
}
