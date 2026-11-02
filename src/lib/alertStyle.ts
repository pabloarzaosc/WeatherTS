/**
 * What the map and the list need from Settings for each alert: its tier and
 * the tier's colour, its type's outline / edge / fill / flash settings, and the
 * facts the filters test (states, office, onset, whether its type is shown).
 *
 * The values are baked onto each GeoJSON feature, so the map layers read
 * ["get", ...] and a filter change is one setFilter; a settings edit redraws
 * the source once (AlertController debounces it).
 */

import {
  alertKind,
  alertsToFeatureCollection,
  alertWindow,
  alertCategoryFlags,
  eventColor,
  param,
  type AlertFeature,
  type NwsAlert,
} from "./nwsAlerts";
import {
  alertStates,
  alertTier,
  alertWfo,
  destination,
  motionText,
  parseCodeList,
  parseStormMotion,
  type AlertSoundId,
  type StormMotion,
  type TierDef,
} from "./alertTiers";
import { alertGroup } from "./alertGroups";
import { alertTierKey, alertTypeKey, SETTING_DEFS, type AlertTypeProp } from "../settings/schema";
import { getSetting } from "../settings/useSettingsStore";

const tiers = new WeakMap<NwsAlert, TierDef | null>();

/** An alert's intensity tier (cached per alert object). */
export function tierOf(a: NwsAlert): TierDef | null {
  let t = tiers.get(a);
  if (t === undefined) {
    // The tiers read the NWS's own tags and wording; other sources have their own levels.
    t = a.source ? null : alertTier(a);
    tiers.set(a, t);
  }
  return t;
}

const motions = new WeakMap<NwsAlert, StormMotion | null>();

/** The storm motion a storm-based warning reports, or null. */
export function motionOf(a: NwsAlert): StormMotion | null {
  let m = motions.get(a);
  if (m === undefined) {
    m = parseStormMotion(param(a.parameters, "eventMotionDescription"));
    motions.set(a, m);
  }
  return m;
}

const TYPE_FALLBACK: Record<AlertTypeProp, boolean | number | string> = {
  on: true,
  line: 1,
  border: true,
  fill: 1,
  flash: "10",
  flashColor: "#ffffff",
  sound: "none",
};

/** One per-type setting; a product missing from the catalogue gets the defaults. */
export function typeSetting<T extends boolean | number | string>(event: string, prop: AlertTypeProp): T {
  const key = alertTypeKey(event, prop);
  return (SETTING_DEFS[key] ? getSetting<T>(key) : TYPE_FALLBACK[prop]) as T;
}

export function tierColor(t: TierDef): string {
  return getSetting<string>(alertTierKey(t.id, "color"));
}

export function tierSound(t: TierDef): AlertSoundId {
  return getSetting<string>(alertTierKey(t.id, "sound")) as AlertSoundId;
}

/** The colour an alert is drawn and listed in: its tier's, else its type's. */
export function alertDrawColor(a: NwsAlert): string {
  const t = tierOf(a);
  return t ? tierColor(t) : a.color ?? eventColor(a.event);
}

/** The sound an alert plays: its tier's, else its type's. */
export function alertSound(a: NwsAlert): AlertSoundId {
  if (a.source) return alertKind(a.event) === "warning" ? (a.severity === "Extreme" ? "alarm" : "double") : "none";
  const t = tierOf(a);
  return t ? tierSound(t) : typeSetting<string>(a.event, "sound") as AlertSoundId;
}

/** How long a new alert flashes (ms), or 0; "Until it expires" runs to its end. */
export function alertFlashMs(a: NwsAlert, nowMs = Date.now()): number {
  const v = typeSetting<string>(a.event, "flash");
  if (v === "off") return 0;
  if (v === "expiry") return Math.max(0, alertWindow(a).end * 1000 - nowMs);
  const s = Number(v);
  return Number.isFinite(s) ? s * 1000 : 10_000;
}

/* --------------------------------------------------------------- filters --- */

export interface AlertFilters {
  states: string[];
  wfos: string[];
  onlyActive: boolean;
  /** Lower-cased event names whose type is switched off. */
  hidden: string[];
}

export function alertFilters(): AlertFilters {
  const hidden: string[] = [];
  for (const key of Object.keys(SETTING_DEFS)) {
    if (key.startsWith("alerts.type.") && key.endsWith(".on") && getSetting<boolean>(key) === false) {
      hidden.push(key.slice("alerts.type.".length, -".on".length).replace(/-/g, " "));
    }
  }
  return {
    states: parseCodeList(getSetting<string>("alerts.states"), 2),
    wfos: parseCodeList(getSetting<string>("alerts.wfos"), 3),
    onlyActive: getSetting<boolean>("alerts.onlyActive"),
    hidden,
  };
}

const onsetUnix = (a: NwsAlert): number => {
  const t = Date.parse(a.onset ?? a.effective ?? a.sent);
  return Number.isNaN(t) ? 0 : Math.round(t / 1000);
};

const facts = new WeakMap<NwsAlert, { states: string[]; wfo: string }>();
function factsOf(a: NwsAlert): { states: string[]; wfo: string } {
  let f = facts.get(a);
  if (!f) {
    f = { states: alertStates(a), wfo: alertWfo(a) };
    facts.set(a, f);
  }
  return f;
}

/** The list's half of the filters the map applies (alertsLayer builds the
 *  same test as an expression from the same values). `t` = unix seconds. */
export function passesAlertFilters(a: NwsAlert, f: AlertFilters, t: number): boolean {
  if (f.hidden.length && f.hidden.includes((a.event || "").trim().toLowerCase())) return false;
  if (f.onlyActive && onsetUnix(a) > t) return false;
  if (f.states.length || f.wfos.length) {
    const { states, wfo } = factsOf(a);
    if (f.states.length && !states.some((s) => f.states.includes(s))) return false;
    if (f.wfos.length && !f.wfos.includes(wfo)) return false;
  }
  return true;
}

/* -------------------------------------------------------------- map data --- */

/** The alert polygons with everything the layers read baked on. */
export function alertMapData(features: AlertFeature[]): GeoJSON.FeatureCollection {
  const fc = alertsToFeatureCollection(features);
  const byId = new Map(features.map((f) => [f.alert.id, f.alert]));
  for (const feat of fc.features) {
    const p = feat.properties as Record<string, unknown>;
    const a = byId.get(String(p.id));
    if (!a) continue;
    const t = tierOf(a);
    const { states, wfo } = factsOf(a);
    p.color = t ? tierColor(t) : p.color;
    p.tier = t?.id ?? "";
    p.tierLabel = t?.label ?? "";
    p.lineMul = typeSetting<number>(a.event, "line");
    p.border = typeSetting<boolean>(a.event, "border");
    p.fillMul = typeSetting<number>(a.event, "fill");
    p.flashColor = typeSetting<string>(a.event, "flashColor");
    p.evKey = (a.event || "").trim().toLowerCase();
    p.grp = alertGroup(a);
    p.states = `|${states.join("|")}|`;
    p.wfo = wfo;
    p.onsetUnix = onsetUnix(a);
  }
  return fc;
}

/** Minutes of travel an arrow shows. */
const ARROW_MIN = 30;

/**
 * Storm motion arrows: from each position a warning gives, 30 minutes of
 * travel along its heading, with a head; a label at the tip. Carries the same
 * filter properties as the polygons, so the map hides them with their alert.
 */
export function alertMotionData(features: AlertFeature[]): GeoJSON.FeatureCollection {
  const out: GeoJSON.Feature[] = [];
  for (const f of features) {
    const a = f.alert;
    if (!f.geometry || alertKind(a.event || "") !== "warning" || a.messageType === "Cancel") continue;
    const m = motionOf(a);
    if (!m || m.kt <= 0 || m.points.length === 0) continue;
    const { start, end } = alertWindow(a);
    const cat = alertCategoryFlags(a);
    const { states, wfo } = factsOf(a);
    const t = tierOf(a);
    const props = {
      id: a.id,
      color: t ? tierColor(t) : a.color ?? eventColor(a.event),
      startUnix: start,
      endUnix: end,
      catTornado: cat.tornado,
      catSpecial: cat.special,
      catSevere: cat.severe,
      evKey: (a.event || "").trim().toLowerCase(),
      grp: alertGroup(a),
      states: `|${states.join("|")}|`,
      wfo,
      onsetUnix: onsetUnix(a),
    };
    const km = Math.max(4, (m.kt * 1.852 * ARROW_MIN) / 60);
    const head = Math.max(2, km * 0.28);
    // A line of storms gives several positions: one arrow at each end and the
    // middle is plenty.
    const pts = m.points.length <= 3 ? m.points : [m.points[0], m.points[Math.floor(m.points.length / 2)], m.points[m.points.length - 1]];
    pts.forEach((p, i) => {
      const tip = destination(p, m.towardDeg, km);
      const left = destination(tip, m.towardDeg + 150, head);
      const right = destination(tip, m.towardDeg - 150, head);
      out.push({
        type: "Feature",
        properties: { ...props, part: "arrow" },
        geometry: { type: "MultiLineString", coordinates: [[p, tip], [left, tip, right]] },
      });
      if (i === 0) {
        out.push({
          type: "Feature",
          properties: { ...props, part: "label", label: `${Math.round(m.kt)} kt`, text: motionText(m), heading: m.towardDeg },
          geometry: { type: "Point", coordinates: destination(tip, m.towardDeg, Math.max(1.5, km * 0.12)) },
        });
      }
    });
  }
  return { type: "FeatureCollection", features: out };
}
