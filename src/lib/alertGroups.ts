/**
 * How the alert list sorts alerts into groups, and the short facts a row or
 * the click-a-point card shows: age, time left, hail / wind / tornado tags,
 * places. Pure helpers over NwsAlert; no store or map imports.
 */

import { alertKind, alertPriority, param, type NwsAlert } from "./nwsAlerts";
import { hazardOf } from "./alertTiers";

export type AlertGroupId =
  | "warning"
  | "watch"
  | "alert"
  | "advisory"
  | "statement"
  | "outlook"
  | "forecast"
  | "discussion"
  | "tropical";

export const ALERT_GROUPS: { id: AlertGroupId; label: string }[] = [
  { id: "warning", label: "Warnings" },
  { id: "watch", label: "Watches" },
  { id: "alert", label: "Alerts" },
  { id: "advisory", label: "Advisories" },
  { id: "statement", label: "Statements" },
  { id: "outlook", label: "Outlooks" },
  { id: "forecast", label: "Forecasts" },
  { id: "discussion", label: "Discussions" },
  { id: "tropical", label: "Tropical" },
];

/** Tropical first (a Hurricane Warning belongs with the storm, not with the
 *  thunderstorm warnings); then outlooks and forecasts by name; the rest by
 *  the product's kind. Discussions are SPC/WPC products, never NWS alerts. */
export function alertGroup(a: Pick<NwsAlert, "event">): AlertGroupId {
  const ev = a.event || "";
  if (hazardOf(ev) === "tropical") return "tropical";
  if (/outlook/i.test(ev)) return "outlook";
  if (/forecast/i.test(ev)) return "forecast";
  const k = alertKind(ev);
  // Brazil's colour notices: a watch in all but name.
  if (k === "watch" && / alert$/i.test(ev)) return "alert";
  return k === "other" ? "advisory" : k;
}

const PRIORITY = new WeakMap<NwsAlert, number>();
/** alertPriority, worked out once per alert object (it reads the whole text). */
export function priorityOf(a: NwsAlert): number {
  let p = PRIORITY.get(a);
  if (p === undefined) {
    p = alertPriority(a);
    PRIORITY.set(a, p);
  }
  return p;
}

/** When the alert was issued (unix ms): sent, else effective. */
export function issuedMs(a: NwsAlert): number {
  const t = Date.parse(a.sent || a.effective);
  return Number.isNaN(t) ? 0 : t;
}

/** Worst first, then newest. */
export function compareAlerts(x: NwsAlert, y: NwsAlert): number {
  const p = priorityOf(y) - priorityOf(x);
  return p !== 0 ? p : issuedMs(y) - issuedMs(x);
}

/* -------------------------------------------------------------- severity --- */

export type SeverityFilter = "any" | "moderate" | "severe" | "extreme";

export const SEVERITY_FILTERS: { id: SeverityFilter; label: string }[] = [
  { id: "any", label: "Any severity" },
  { id: "moderate", label: "Moderate and up" },
  { id: "severe", label: "Severe and up" },
  { id: "extreme", label: "Extreme only" },
];

const SEV_RANK: Record<string, number> = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 };
const SEV_MIN: Record<SeverityFilter, number> = { any: 0, moderate: 2, severe: 3, extreme: 4 };

export function passesSeverity(a: NwsAlert, f: SeverityFilter): boolean {
  return f === "any" || (SEV_RANK[a.severity] ?? 0) >= SEV_MIN[f];
}

/* ----------------------------------------------------------- text filter --- */

const HAYSTACK = new WeakMap<NwsAlert, string>();
/** Event, places, headline, office and text, lower-cased once per alert. */
export function matchesText(a: NwsAlert, q: string, wfo: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  let h = HAYSTACK.get(a);
  if (h === undefined) {
    h = [a.event, a.areaDesc, a.headline ?? "", a.senderName, wfo, a.description].join("\n").toLowerCase();
    HAYSTACK.set(a, h);
  }
  return needle.split(/\s+/).every((w) => h!.includes(w));
}

/* ----------------------------------------------------------- short facts --- */

/** "4 min", "2 h 10 min", "3 d" -- compact, for ages and time left. */
export function shortSpan(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** "Issued 12 min ago" from `nowMs` (a past timeline frame counts from there). */
export function agePhrase(a: NwsAlert, nowMs: number): string {
  const t = issuedMs(a);
  if (!t) return "";
  // the list counts in whole minutes: an alert sent this minute is "just now"
  if (t > nowMs - 60_000 && t < nowMs + 120_000) return "Issued just now";
  return t > nowMs ? `Issued in ${shortSpan(t - nowMs)}` : `Issued ${shortSpan(nowMs - t)} ago`;
}

/** "Expires in 34 min" / "Expired". Uses `ends` when the product gives one. */
export function expiryPhrase(a: NwsAlert, nowMs: number): string {
  const end = Date.parse(a.ends || a.expires);
  if (Number.isNaN(end)) return "";
  if (end < nowMs) return "Expired";
  return end - nowMs < 60_000 ? "Expires now" : `Expires in ${shortSpan(end - nowMs)}`;
}

/** The end time on the clock, local: "until 21:45" (with the day when not today). */
export function untilClock(a: NwsAlert, nowMs: number): string {
  const end = Date.parse(a.ends || a.expires);
  if (Number.isNaN(end)) return "";
  const d = new Date(end);
  const sameDay = new Date(nowMs).toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `until ${hm}` : `until ${d.toLocaleDateString(undefined, { weekday: "short" })} ${hm}`;
}

export interface AlertTag {
  key: string;
  text: string;
  /** "hot" = observed / destructive, drawn stronger. */
  hot?: boolean;
}

const TAGS = new WeakMap<NwsAlert, AlertTag[]>();
/** Hail, wind, tornado and flash-flood tags from the product's parameters. */
export function alertTags(a: NwsAlert): AlertTag[] {
  let t = TAGS.get(a);
  if (t) return t;
  t = [];
  if (a.level) t.push({ key: "lvl", text: a.level, hot: a.severity === "Extreme" });
  const p = a.parameters;
  const tor = param(p, "tornadoDetection");
  if (tor) t.push({ key: "tor", text: `Tornado ${tor.toLowerCase()}`, hot: /observed/i.test(tor) });
  const hail = Number(param(p, "maxHailSize"));
  if (Number.isFinite(hail) && hail > 0) {
    const src = param(p, "hailThreat");
    t.push({ key: "hail", text: `${hail.toFixed(2)} in hail${src ? ` (${src.toLowerCase()})` : ""}`, hot: hail >= 2 });
  }
  const windRaw = param(p, "maxWindGust") ?? "";
  const wm = windRaw.match(/(\d+(?:\.\d+)?)\s*(MPH|KTS?|KT)?/i);
  if (wm && Number(wm[1]) > 0) {
    const unit = /kt/i.test(wm[2] ?? "") ? "kt" : "mph";
    const src = param(p, "windThreat");
    t.push({ key: "wind", text: `${Math.round(Number(wm[1]))} ${unit} wind${src ? ` (${src.toLowerCase()})` : ""}`, hot: Number(wm[1]) >= 80 });
  }
  const ff = param(p, "flashFloodDetection");
  if (ff) t.push({ key: "ff", text: `Flash flood ${ff.toLowerCase()}`, hot: /observed/i.test(ff) });
  const dmg = param(p, "thunderstormDamageThreat") || param(p, "tornadoDamageThreat") || param(p, "flashFloodDamageThreat");
  if (dmg && !/^base$/i.test(dmg)) t.push({ key: "dmg", text: `${dmg.charAt(0)}${dmg.slice(1).toLowerCase()} damage`, hot: /destructive|catastrophic/i.test(dmg) });
  TAGS.set(a, t);
  return t;
}

/** "Cleveland, OK; McClain, OK +4 more" from the area description. */
export function placesSummary(a: Pick<NwsAlert, "areaDesc">, max = 3): string {
  const zones = (a.areaDesc || "").split(";").map((z) => z.trim()).filter(Boolean);
  if (zones.length <= max) return zones.join("; ");
  return `${zones.slice(0, max).join("; ")} +${zones.length - max} more`;
}
