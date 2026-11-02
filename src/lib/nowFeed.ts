/**
 * The Now panel's lines: what is happening across the US at this minute,
 * biggest first. Pure helpers: live alerts, the last hour of storm reports,
 * SPC's day 1 and day 2 outlooks and the radar-event table go in, ranked lines
 * come out. useNowStore fetches, NowView draws, openNowItem acts on a click.
 *
 * Every line carries a place (lat/lon) and the radar product that shows its
 * hazard best: correlation coefficient for a tornado on the ground (the debris
 * signature), velocity for other tornado and wind threats, reflectivity for
 * hail, flooding, tropical systems and outlooks.
 */

import { alertBounds, alertCentroid, eventColor, type AlertFeature, type NwsAlert } from "./nwsAlerts";
import { alertStates, alertTier, alertVtec, alertWfo, type TierDef } from "./alertTiers";
import { alertTags, type AlertTag } from "./alertGroups";
import { LSR_COLORS, lsrEf, lsrMph, lsrPlace, lsrSeverity, type LsrFeature } from "./lsr";
import { SPC_CATEGORICAL, type OutlookResponse } from "./outlooks";
import { EVENT_COLORS, RADAR_EVENTS } from "./radarEvents";
import { WFO_BY_ID } from "./wfoOffices";

export type NowGroupId = "warnings" | "watches" | "reports" | "outlook" | "archive";

export const NOW_GROUPS: { id: NowGroupId; label: string; empty: string }[] = [
  { id: "warnings", label: "Warnings", empty: "No tornado, severe, flash flood or tropical warnings in force." },
  { id: "watches", label: "Watches", empty: "No watches in force." },
  { id: "reports", label: "Storm reports · last hour", empty: "No significant storm reports in the last hour." },
  { id: "outlook", label: "Outlook", empty: "No severe risk today, nor a slight risk or higher tomorrow." },
  { id: "archive", label: "From the archive", empty: "No notable radar event this week in past years." },
];

/** Radar family ids, as the product picker names them. */
export type NowProduct = "B" | "G" | "C";

export const NOW_PRODUCT_NAMES: Record<NowProduct, string> = {
  B: "Reflectivity",
  G: "Velocity",
  C: "Correlation coefficient",
};

export interface NowItem {
  id: string;
  group: NowGroupId;
  /** 0 = most serious. Lines sort by rank, then score, then newest. */
  rank: number;
  score: number;
  /** Counted in the red badge on the dock. */
  serious: boolean;
  title: string;
  sub: string;
  tags: AlertTag[];
  /** The stripe at the line's left: the alert tier or type colour. */
  color: string;
  /** When it was issued or reported (ms), or null. */
  at: number | null;
  /** When it ends (ms), or null. */
  until: number | null;
  lat: number | null;
  lon: number | null;
  bounds: [[number, number], [number, number]] | null;
  product: NowProduct;
  alertIds?: string[];
  eventId?: string;
}

export interface SiteSpot {
  id: string;
  icao: string;
  name: string;
  lat: number;
  lon: number;
}

/* ------------------------------------------------------------- the query --- */

const STORM_EVENTS = new Set([
  "Tornado Warning",
  "Severe Thunderstorm Warning",
  "Extreme Wind Warning",
  "Snow Squall Warning",
  "Dust Storm Warning",
]);
const TROPICAL_WARNINGS = new Set(["Hurricane Warning", "Typhoon Warning", "Tropical Storm Warning", "Storm Surge Warning"]);
const TROPICAL_WATCHES = new Set(["Hurricane Watch", "Typhoon Watch", "Tropical Storm Watch", "Storm Surge Watch"]);
const CONVECTIVE_WATCHES = new Set(["Tornado Watch", "Severe Thunderstorm Watch"]);

/** The event types the panel asks api.weather.gov for (one small request). */
export const NOW_EVENTS: string[] = [
  ...STORM_EVENTS,
  "Flash Flood Warning",
  ...TROPICAL_WARNINGS,
  "Tsunami Warning",
  ...CONVECTIVE_WATCHES,
  ...TROPICAL_WATCHES,
  "Tsunami Watch",
];

/* --------------------------------------------------------------- helpers --- */

const EVENT_WEIGHT: Record<string, number> = {
  "Tornado Warning": 9,
  "Extreme Wind Warning": 8,
  "Tsunami Warning": 8,
  "Severe Thunderstorm Warning": 6,
  "Flash Flood Warning": 5,
  "Hurricane Warning": 5,
  "Typhoon Warning": 5,
  "Storm Surge Warning": 5,
  "Snow Squall Warning": 4,
  "Dust Storm Warning": 3,
  "Tropical Storm Warning": 3,
};

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

const endMs = (a: NwsAlert) => ms(a.ends) ?? ms(a.expires);

/** "Barber, KS" (api.weather.gov) or "Barber [KS]" (IEM's archive) ->
 *  "Barber (KS)"; anything else unchanged. */
export function zonePlace(zone: string): string {
  const m = zone.trim().match(/^(.*?)(?:,\s*|\s*\[)([A-Z]{2})\]?$/);
  return m ? `${m[1]} (${m[2]})` : zone.trim();
}

function zones(a: Pick<NwsAlert, "areaDesc">): string[] {
  const d = a.areaDesc || "";
  // IEM lists "Nemaha [NE], Pawnee [NE]"; the NWS "Barber, KS; Comanche, KS"
  const parts = d.includes("[") && !d.includes(";") ? d.split(/(?<=\])\s*,\s*/) : d.split(";");
  return parts.map((z) => z.trim()).filter(Boolean);
}

/** ["Tornado Warning", "Tornado Warning", "Severe Thunderstorm Warning"] ->
 *  "2 × Tornado Warning + Severe Thunderstorm Warning". */
function countLabels(labels: string[]): string {
  const n = new Map<string, number>();
  for (const l of labels) n.set(l, (n.get(l) ?? 0) + 1);
  return [...n].map(([l, c]) => (c > 1 ? `${c} × ${l}` : l)).join(" + ");
}

function placeList(a: NwsAlert, max = 3): string {
  const z = zones(a).map(zonePlace);
  return z.length <= max ? z.join(", ") : `${z.slice(0, max).join(", ")} +${z.length - max}`;
}

function hailIn(a: NwsAlert): number {
  const v = Number(a.parameters?.maxHailSize?.[0]);
  return Number.isFinite(v) ? v : 0;
}

function windMph(a: NwsAlert): number {
  const m = (a.parameters?.maxWindGust?.[0] ?? "").match(/(\d+(?:\.\d+)?)\s*(MPH|KTS?|KT)?/i);
  if (!m) return 0;
  const v = Number(m[1]);
  return /kt/i.test(m[2] ?? "") ? v * 1.15078 : v;
}

const tornadoOnGround = (a: NwsAlert, tier: TierDef | null) =>
  tier?.id === "tor-emergency" || /observed/i.test(a.parameters?.tornadoDetection?.[0] ?? "");

/** 0 emergencies; 1 PDS / observed tornado, extremely dangerous severe,
 *  tsunami; 2 radar-indicated tornado, destructive severe, hurricane and
 *  surge; 3 the rest. */
export function warningRank(a: NwsAlert, tier: TierDef | null): number {
  const id = tier?.id;
  if (id === "tor-emergency" || id === "ffw-emergency" || a.event === "Extreme Wind Warning") return 0;
  if (id === "tor-pds" || id === "tor-observed" || id === "svr-eds" || a.event === "Tsunami Warning") return 1;
  if (
    a.event === "Tornado Warning" ||
    id === "svr-destructive" ||
    a.event === "Hurricane Warning" ||
    a.event === "Typhoon Warning" ||
    a.event === "Storm Surge Warning"
  )
    return 2;
  return 3;
}

/** Which radar product shows a warning's hazard best. */
export function warningProduct(a: NwsAlert, tier: TierDef | null): NowProduct {
  if (a.event === "Tornado Warning") return tornadoOnGround(a, tier) ? "C" : "G";
  if (a.event === "Extreme Wind Warning") return "G";
  if (a.event === "Severe Thunderstorm Warning") {
    // velocity for a wind-driven storm, reflectivity when the hail is the story
    // a "tornado possible" storm is a rotation question first
    if (/possible/i.test(a.parameters?.tornadoDetection?.[0] ?? "")) return "G";
    const hail = hailIn(a);
    const wind = windMph(a);
    return hail >= 1.75 || (hail >= 1.25 && wind < 70) ? "B" : "G";
  }
  return "B";
}

function warningScore(a: NwsAlert, tier: TierDef | null): number {
  return (tier?.rank ?? 0) * 1e5 + (EVENT_WEIGHT[a.event] ?? 1) * 1e3 + Math.min(999, hailIn(a) * 100 + windMph(a));
}

function mergeTags(list: AlertTag[][]): AlertTag[] {
  const out = new Map<string, AlertTag>();
  for (const tags of list) for (const t of tags) if (!out.has(t.key) || (t.hot && !out.get(t.key)!.hot)) out.set(t.key, t);
  return [...out.values()];
}

function unionBounds(
  list: Array<[[number, number], [number, number]] | null>,
): [[number, number], [number, number]] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const b of list) {
    if (!b) continue;
    w = Math.min(w, b[0][0]);
    s = Math.min(s, b[0][1]);
    e = Math.max(e, b[1][0]);
    n = Math.max(n, b[1][1]);
  }
  return Number.isFinite(w) ? [[w, s], [e, n]] : null;
}

/** Outer rings of a (multi)polygon. */
function rings(g: GeoJSON.Geometry | null): number[][][] {
  if (!g) return [];
  if (g.type === "Polygon") return g.coordinates.length ? [g.coordinates[0]] : [];
  if (g.type === "MultiPolygon") return g.coordinates.map((p) => p[0]).filter(Boolean);
  if (g.type === "GeometryCollection") return g.geometries.flatMap(rings);
  return [];
}

function inRing(ring: number[][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Two storm-based polygons share ground: a corner of one inside the other.
 *  Storm warnings are small convex-ish shapes, so this catches the overlaps
 *  that matter (a tornado warning inside its storm's severe warning). */
function overlaps(a: GeoJSON.Geometry | null, b: GeoJSON.Geometry | null): boolean {
  const ba = alertBounds(a);
  const bb = alertBounds(b);
  if (!ba || !bb) return false;
  if (ba[1][0] < bb[0][0] || bb[1][0] < ba[0][0] || ba[1][1] < bb[0][1] || bb[1][1] < ba[0][1]) return false;
  const ra = rings(a);
  const rb = rings(b);
  const anyIn = (from: number[][][], to: number[][][]) =>
    from.some((r) => r.some(([x, y]) => to.some((t) => inRing(t, x, y))));
  return anyIn(ra, rb) || anyIn(rb, ra);
}

/** Where a zone-based alert is, when it has no polygon: the first radar of
 *  the office that issued it. */
function officeSpot(a: NwsAlert, sites: Map<string, SiteSpot>): [number, number] | null {
  const office = WFO_BY_ID.get(alertWfo(a));
  for (const icao of office?.radars ?? []) {
    const s = sites.get(icao);
    if (s) return [s.lon, s.lat];
  }
  return null;
}

function spotOf(f: AlertFeature, sites: Map<string, SiteSpot>): [number, number] | null {
  return alertCentroid(f.geometry) ?? officeSpot(f.alert, sites);
}

function meanSpot(list: Array<[number, number] | null>): [number, number] | null {
  const ok = list.filter((p): p is [number, number] => !!p);
  if (!ok.length) return null;
  return [ok.reduce((s, p) => s + p[0], 0) / ok.length, ok.reduce((s, p) => s + p[1], 0) / ok.length];
}

function live(features: AlertFeature[], nowMs: number): AlertFeature[] {
  return features.filter((f) => {
    const a = f.alert;
    if (a.messageType === "Cancel" || a.status !== "Actual") return false;
    const end = endMs(a);
    return end == null || end > nowMs;
  });
}

/* -------------------------------------------------------------- warnings --- */

export function buildWarnings(features: AlertFeature[], sites: Map<string, SiteSpot>, nowMs: number): NowItem[] {
  const all = live(features, nowMs);
  const items: NowItem[] = [];

  // Storm-based warnings: several on one storm become one line.
  const storm = all.filter((f) => STORM_EVENTS.has(f.alert.event));
  const parent = storm.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < storm.length; i++)
    for (let j = i + 1; j < storm.length; j++)
      if (find(i) !== find(j) && overlaps(storm[i].geometry, storm[j].geometry)) parent[find(i)] = find(j);
  const groups = new Map<number, AlertFeature[]>();
  storm.forEach((f, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), f]);
  });

  for (const members of groups.values()) {
    const scored = members
      .map((f) => {
        const tier = alertTier(f.alert);
        return { f, tier, rank: warningRank(f.alert, tier), score: warningScore(f.alert, tier) };
      })
      .sort((x, y) => x.rank - y.rank || y.score - x.score);
    const lead = scored[0];
    const a = lead.f.alert;
    const n = scored.length;
    const first = zonePlace(zones(a)[0] ?? a.areaDesc);
    const label = (s: (typeof scored)[number]) => `${s.f.alert.event}${s.tier ? ` (${s.tier.label})` : ""}`;
    const product: NowProduct = scored.some((s) => s.f.alert.event === "Tornado Warning" && tornadoOnGround(s.f.alert, s.tier))
      ? "C"
      : warningProduct(a, lead.tier);
    const spot = spotOf(lead.f, sites);
    items.push({
      id: `w:${a.id}`,
      group: "warnings",
      rank: lead.rank,
      score: lead.score + n,
      serious: lead.rank <= 2,
      title: n > 1 ? `${first} · ${n} warnings` : `${a.event}${lead.tier ? ` · ${lead.tier.label}` : ""}`,
      sub: n > 1 ? countLabels(scored.map(label)) : placeList(a),
      tags: mergeTags(scored.map((s) => alertTags(s.f.alert))),
      color: lead.tier?.color ?? eventColor(a.event),
      at: Math.max(...scored.map((s) => ms(s.f.alert.sent) ?? 0)) || null,
      until: endMs(a),
      lat: spot?.[1] ?? null,
      lon: spot?.[0] ?? null,
      bounds: unionBounds(scored.map((s) => alertBounds(s.f.geometry))),
      product,
      alertIds: scored.map((s) => s.f.alert.id),
    });
  }

  // Flash flood warnings: one line each (their areas are not one storm's).
  for (const f of all.filter((x) => x.alert.event === "Flash Flood Warning")) {
    const a = f.alert;
    const tier = alertTier(a);
    const rank = warningRank(a, tier);
    const spot = spotOf(f, sites);
    items.push({
      id: `w:${a.id}`,
      group: "warnings",
      rank,
      score: warningScore(a, tier),
      serious: rank <= 2,
      title: `${a.event}${tier ? ` · ${tier.label}` : ""}`,
      sub: placeList(a),
      tags: alertTags(a),
      color: tier?.color ?? eventColor(a.event),
      at: ms(a.sent),
      until: endMs(a),
      lat: spot?.[1] ?? null,
      lon: spot?.[0] ?? null,
      bounds: alertBounds(f.geometry),
      product: "B",
      alertIds: [a.id],
    });
  }

  // Tropical and tsunami warnings: one line per type, however many zones.
  items.push(...byEvent(all, [...TROPICAL_WARNINGS, "Tsunami Warning"], "warnings", sites));
  return sortItems(items);
}

/** One line per event type (tropical and tsunami products are zone lists). */
function byEvent(all: AlertFeature[], events: string[], group: NowGroupId, sites: Map<string, SiteSpot>): NowItem[] {
  const out: NowItem[] = [];
  for (const ev of events) {
    const list = all.filter((f) => f.alert.event === ev);
    if (!list.length) continue;
    const lead = list[0].alert;
    const tier = alertTier(lead);
    const states = [...new Set(list.flatMap((f) => alertStates(f.alert)))];
    const areas = new Set(list.flatMap((f) => zones(f.alert)));
    const rank = group === "warnings" ? warningRank(lead, tier) : 3;
    const spot = meanSpot(list.map((f) => spotOf(f, sites)));
    out.push({
      id: `e:${group}:${ev}`,
      group,
      rank,
      score: (EVENT_WEIGHT[ev] ?? 1) * 1e3 + areas.size,
      serious: false,
      title: ev,
      sub: `${areas.size} ${areas.size === 1 ? "area" : "areas"}${states.length ? ` · ${states.slice(0, 6).join(", ")}${states.length > 6 ? " …" : ""}` : ""}`,
      tags: [],
      color: eventColor(ev),
      at: Math.max(...list.map((f) => ms(f.alert.sent) ?? 0)) || null,
      until: Math.max(...list.map((f) => endMs(f.alert) ?? 0)) || null,
      lat: spot?.[1] ?? null,
      lon: spot?.[0] ?? null,
      bounds: unionBounds(list.map((f) => alertBounds(f.geometry))),
      product: "B",
      alertIds: list.map((f) => f.alert.id),
    });
  }
  return out;
}

/* --------------------------------------------------------------- watches --- */

export function buildWatches(features: AlertFeature[], sites: Map<string, SiteSpot>, nowMs: number): NowItem[] {
  const all = live(features, nowMs);
  const groups = new Map<string, AlertFeature[]>();
  for (const f of all.filter((x) => CONVECTIVE_WATCHES.has(x.alert.event))) {
    const v = alertVtec(f.alert);
    // one watch, many offices: the watch number is the identity
    const key = v ? `${v.phen}.${v.etn}` : `${f.alert.event}|${f.alert.id}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const items: NowItem[] = [];
  for (const [key, list] of groups) {
    const lead = list[0].alert;
    const v = alertVtec(lead);
    const pds = list.some((f) => alertTier(f.alert)?.id === "watch-pds");
    const tor = lead.event === "Tornado Watch";
    const states = [...new Set(list.flatMap((f) => alertStates(f.alert)))];
    const areas = new Set(list.flatMap((f) => f.alert.affectedZones?.length ? f.alert.affectedZones : zones(f.alert)));
    const spot = meanSpot(list.map((f) => spotOf(f, sites)));
    items.push({
      id: `wa:${key}`,
      group: "watches",
      rank: pds ? 0 : tor ? 1 : 2,
      score: areas.size,
      serious: pds,
      title: `${pds ? "PDS " : ""}${lead.event}${v ? ` ${Number(v.etn)}` : ""}`,
      sub: `${areas.size} ${areas.size === 1 ? "area" : "areas"}${states.length ? ` · ${states.join(", ")}` : ""}`,
      tags: pds ? [{ key: "pds", text: "Particularly dangerous situation", hot: true }] : [],
      color: pds ? "#ff8a00" : eventColor(lead.event),
      at: Math.max(...list.map((f) => ms(f.alert.sent) ?? 0)) || null,
      until: Math.max(...list.map((f) => endMs(f.alert) ?? 0)) || null,
      lat: spot?.[1] ?? null,
      lon: spot?.[0] ?? null,
      bounds: unionBounds(list.map((f) => alertBounds(f.geometry))),
      product: tor ? "G" : "B",
      alertIds: list.map((f) => f.alert.id),
    });
  }
  items.push(...byEvent(all, [...TROPICAL_WATCHES, "Tsunami Watch"], "watches", sites));
  return sortItems(items);
}

/* ---------------------------------------------------------- storm reports --- */

const REPORT_TITLES: Record<string, string> = {
  T: "Tornado",
  W: "Waterspout",
  C: "Funnel cloud",
  H: "Hail",
  G: "Wind gust",
  M: "Marine wind gust",
  D: "Wind damage",
  B: "Downburst",
  F: "Flash flood",
};

/** Tornadoes, funnels and waterspouts, hail of 1 in or more, gusts of 58 mph
 *  or more, wind damage and flash flooding -- from the last hour. */
export function buildReports(features: LsrFeature[], nowMs: number): NowItem[] {
  const since = nowMs / 1000 - 3600;
  const one: NowItem[] = [];
  for (const f of features) {
    const p = f.properties;
    if (!p || p.unix < since || p.unix > nowMs / 1000 + 60 || !(p.code in REPORT_TITLES)) continue;
    const sev = lsrSeverity(p);
    if ((p.code === "H" || p.code === "G" || p.code === "M") && sev < 1) continue;
    const [lon, lat] = f.geometry.coordinates;
    const mph = lsrMph(p);
    const ef = lsrEf(p);
    let title = REPORT_TITLES[p.code];
    if (p.code === "H" && p.magf != null) title += ` ${p.magf.toFixed(2)} in`;
    else if ((p.code === "G" || p.code === "M" || p.code === "D" || p.code === "B") && mph != null) title += ` ${Math.round(mph)} mph`;
    else if (p.code === "T" && ef != null) title += ` EF${ef}`;
    const tornado = p.code === "T" || p.code === "W";
    one.push({
      id: `r:${p.code}:${p.unix}:${lat.toFixed(3)}:${lon.toFixed(3)}`,
      group: "reports",
      rank: tornado ? 0 : sev >= 2 || p.code === "D" || p.code === "B" ? 1 : 2,
      score: p.rank * 1e3 + Math.min(999, mph ?? (p.magf ?? 0) * 100),
      serious: false,
      title,
      sub: [lsrPlace(p), p.source].filter(Boolean).join(" · "),
      tags: sev >= 2 ? [{ key: "sig", text: "Significant", hot: true }] : [],
      color: LSR_COLORS[p.cat] ?? "#9ca3af",
      at: p.unix * 1000,
      until: null,
      lat,
      lon,
      bounds: null,
      product: tornado ? "C" : p.code === "H" || p.code === "F" ? "B" : "G",
    });
  }
  // One storm sends many reports of the same thing (a tornado reported by
  // spotters, police and the public along its path): those within 15 km of
  // the strongest become one line with a count.
  const FAMILY: Record<string, string> = { T: "tor", W: "tor", C: "funnel", H: "hail", G: "wind", M: "wind", D: "wind", B: "wind", F: "flood" };
  const kind = (i: NowItem) => FAMILY[i.id.split(":")[1]] ?? i.id;
  const lines: { lead: NowItem; n: number; newest: number }[] = [];
  for (const i of sortItems(one)) {
    const near = lines.find(
      (l) => kind(l.lead) === kind(i) && haversineKm(l.lead.lat!, l.lead.lon!, i.lat!, i.lon!) <= 15,
    );
    if (near) {
      near.n++;
      near.newest = Math.max(near.newest, i.at ?? 0);
    } else lines.push({ lead: i, n: 1, newest: i.at ?? 0 });
  }
  return lines.map(({ lead, n, newest }) =>
    n === 1 ? lead : { ...lead, title: `${lead.title} · ${n} reports`, sub: lead.sub.split(" · ")[0], at: newest },
  );
}

/* --------------------------------------------------------------- outlook --- */

function ringArea(r: number[][]): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(s / 2);
}

/** Middle of the biggest piece of the highest category: vertex mean of its
 *  outer ring, nudged inside when the ring is curved around it. */
function outlookSpot(fs: GeoJSON.Feature[]): [number, number] | null {
  let best: number[][] | null = null;
  let bestA = 0;
  for (const f of fs)
    for (const r of rings(f.geometry)) {
      const a = ringArea(r);
      if (a > bestA) {
        bestA = a;
        best = r;
      }
    }
  if (!best) return null;
  const cx = best.reduce((s, p) => s + p[0], 0) / best.length;
  const cy = best.reduce((s, p) => s + p[1], 0) / best.length;
  if (inRing(best, cx, cy)) return [cx, cy];
  // a crescent: the vertex closest to the mean is at least inside the risk
  let pick = best[0];
  let d = Infinity;
  for (const p of best) {
    const dd = (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
    if (dd < d) {
      d = dd;
      pick = p;
    }
  }
  return [pick[0], pick[1]];
}

export function nearestSite(lat: number, lon: number, sites: Iterable<SiteSpot>): { site: SiteSpot; km: number } | null {
  let best: { site: SiteSpot; km: number } | null = null;
  for (const s of sites) {
    const km = haversineKm(lat, lon, s.lat, s.lon);
    if (!best || km < best.km) best = { site: s, km };
  }
  return best;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** SPC's highest risk today (marginal or more) and tomorrow (slight or
 *  more), each placed by the radar nearest the middle of that risk. */
export function buildOutlook(
  day1: OutlookResponse | null,
  day2: OutlookResponse | null,
  sites: Map<string, SiteSpot>,
): NowItem[] {
  const items: NowItem[] = [];
  const add = (res: OutlookResponse | null, day: 1 | 2, min: number) => {
    if (!res) return;
    const feats = res.geojson.features.filter((f) => {
      const p = f.properties as { rank?: number; cig?: boolean } | null;
      return p && !p.cig && typeof p.rank === "number" && p.rank <= 6;
    });
    const top = Math.max(0, ...feats.map((f) => (f.properties as { rank: number }).rank));
    if (top < min) return;
    const cat = SPC_CATEGORICAL.find((c) => c.rank === top);
    const mine = feats.filter((f) => (f.properties as { rank: number }).rank === top);
    const spot = outlookSpot(mine);
    const near = spot ? nearestSite(spot[1], spot[0], sites.values()) : null;
    const p = mine[0]?.properties as { color?: string } | undefined;
    const valid = ms(res.valid);
    const expire = ms(res.expire);
    items.push({
      id: `o:${day}`,
      group: "outlook",
      rank: day - 1,
      score: top,
      serious: false,
      title: `${cat?.name ?? "Severe"} risk ${day === 1 ? "today" : "tomorrow"}`,
      sub: `${near ? `Around ${near.site.icao} · ${near.site.name}` : "SPC"} · SPC day ${day}`,
      tags: [],
      color: p?.color ?? cat?.color ?? "#ffe066",
      at: valid,
      until: expire,
      lat: spot?.[1] ?? null,
      lon: spot?.[0] ?? null,
      bounds: unionBounds(mine.map((f) => alertBounds(f.geometry))),
      product: "B",
    });
  };
  add(day1, 1, 2);
  add(day2, 2, 3);
  return items;
}

/* --------------------------------------------------------------- archive --- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Notable radar events on this calendar day in past years, or within a week
 *  of it when none fell on the day itself. */
export function buildArchive(nowMs: number): NowItem[] {
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const dayOf = (d: Date) => Date.UTC(2001, d.getUTCMonth(), d.getUTCDate()) / 86400000;
  // today on the viewer's calendar; an event's day is its UTC day
  const today = Date.UTC(2001, now.getMonth(), now.getDate()) / 86400000;
  const rows = RADAR_EVENTS.map((e) => {
    const d = new Date(e.peak * 1000);
    let diff = Math.abs(dayOf(d) - today);
    diff = Math.min(diff, 365 - diff);
    return { e, d, diff };
  }).filter((r) => r.d.getUTCFullYear() < year && r.diff <= 7);
  const exact = rows.some((r) => r.diff === 0);
  return rows
    .filter((r) => !exact || r.diff === 0)
    .sort((x, y) => x.diff - y.diff || (y.e.dvKt ?? 0) - (x.e.dvKt ?? 0))
    .map(({ e, d, diff }, i) => ({
      id: `a:${e.id}`,
      group: "archive" as const,
      rank: diff,
      score: -i,
      serious: false,
      title: e.title,
      sub: `${diff === 0 ? `On this day in ${d.getUTCFullYear()}` : `This week in ${d.getUTCFullYear()} (${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()})`} · ${e.place}`,
      tags: [],
      color: EVENT_COLORS[e.category],
      at: e.peak * 1000,
      until: null,
      lat: e.lat,
      lon: e.lon,
      bounds: null,
      product: "B" as const,
      eventId: e.id,
    }));
}

/* ------------------------------------------------------------------ sort --- */

export function sortItems(items: NowItem[]): NowItem[] {
  return items.sort((x, y) => x.rank - y.rank || y.score - x.score || (y.at ?? 0) - (x.at ?? 0));
}
