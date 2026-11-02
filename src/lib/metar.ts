/**
 * METAR decoding shared by the map popup and the station panel.
 *
 * The numbers here are the FAA's, not ours: ceiling and visibility thresholds
 * for the flight categories are fixed, so they belong in one place rather than
 * being re-derived wherever a badge is drawn.
 */

export interface CloudLayer {
  cover: string;
  base: number | null;
}

export type FlightCategory = "VFR" | "MVFR" | "IFR" | "LIFR";

export const CATEGORY_LABEL: Record<FlightCategory, string> = {
  VFR: "Visual Flight Rules",
  MVFR: "Marginal Visual Flight Rules",
  IFR: "Instrument Flight Rules",
  LIFR: "Low Instrument Flight Rules",
};

export const CATEGORY_COLOR: Record<FlightCategory, string> = {
  VFR: "#4ade80",
  MVFR: "#3b82f6",
  IFR: "#ff6b5e",
  LIFR: "#c58af9",
};

export const SKY_WORDS: Record<string, string> = {
  SKC: "Clear",
  CLR: "Clear",
  NCD: "Clear",
  NSC: "No significant cloud",
  CAVOK: "CAVOK",
  FEW: "Few",
  SCT: "Scattered",
  BKN: "Broken",
  OVC: "Overcast",
  VV: "Vertical visibility",
};

/** Layers as reported, lowest first. Tolerates the JSON-as-string MapLibre
 *  hands back through feature properties. */
export function parseClouds(value: unknown): CloudLayer[] {
  let raw: unknown = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is CloudLayer => !!c && typeof (c as CloudLayer).cover === "string")
    .map((c) => ({ cover: c.cover, base: typeof c.base === "number" ? c.base : null }))
    .sort((a, b) => (a.base ?? Infinity) - (b.base ?? Infinity));
}

/**
 * The ceiling: the lowest broken or overcast layer, in feet. Scattered and few
 * are not a ceiling however low they sit -- that distinction is the whole point
 * of the term, and getting it wrong would shift the flight category.
 */
export function ceilingFt(clouds: CloudLayer[]): number | null {
  for (const c of clouds) {
    if ((c.cover === "BKN" || c.cover === "OVC" || c.cover === "VV") && c.base != null) return c.base;
  }
  return null;
}

/**
 * Flight category from ceiling and visibility, by the FAA thresholds. The worse
 * of the two wins: a 900 ft ceiling is IFR even under unlimited visibility.
 */
export function flightCategory(ceiling: number | null, visibilitySm: number | null): FlightCategory | null {
  if (ceiling == null && visibilitySm == null) return null;
  const c = ceiling ?? Infinity;
  const v = visibilitySm ?? Infinity;
  if (c < 500 || v < 1) return "LIFR";
  if (c < 1000 || v < 3) return "IFR";
  if (c <= 3000 || v <= 5) return "MVFR";
  return "VFR";
}

/** "24 minutes ago" / "just now" / "3 hours ago". */
export function relativeTime(unix: number | null, now = Date.now()): string {
  if (unix == null || !Number.isFinite(unix)) return "";
  const ms = unix > 1e11 ? unix : unix * 1000;
  const mins = Math.round((now - ms) / 60_000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 minute ago";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

/** Compass point a wind is blowing *from*, the way METAR reports it. */
export function compassPoint(deg: number | null): string {
  if (deg == null || !Number.isFinite(deg)) return "";
  return COMPASS[Math.round(deg / 22.5) % 16];
}

const WX_INTENSITY: Record<string, string> = { "-": "Light", "+": "Heavy", VC: "Nearby" };
const WX_DESCRIPTOR: Record<string, string> = {
  MI: "shallow", PR: "partial", BC: "patches of", DR: "drifting", BL: "blowing",
  SH: "showers of", TS: "thunderstorm with", FZ: "freezing",
};
const WX_PHENOMENA: Record<string, string> = {
  DZ: "drizzle", RA: "rain", SN: "snow", SG: "snow grains", IC: "ice crystals", PL: "ice pellets",
  GR: "hail", GS: "small hail", UP: "unknown precipitation", BR: "mist", FG: "fog", FU: "smoke",
  VA: "volcanic ash", DU: "dust", SA: "sand", HZ: "haze", PY: "spray", PO: "dust whirls",
  SQ: "squalls", FC: "funnel cloud", SS: "sandstorm", DS: "duststorm",
};

/** "TSRA" -> "Thunderstorm with rain". METAR groups read right to left: an
 *  intensity sign, an optional descriptor, then the phenomenon itself. */
export function describeWx(codes: string | null | undefined): string[] {
  if (!codes) return [];
  const out: string[] = [];
  for (const token of String(codes).trim().split(/\s+/)) {
    if (!token) continue;
    let rest = token.toUpperCase();
    if (rest === "NSW") {
      out.push("No significant weather");
      continue;
    }
    const words: string[] = [];
    if (rest.startsWith("-") || rest.startsWith("+")) {
      words.push(WX_INTENSITY[rest[0]]);
      rest = rest.slice(1);
    }
    if (rest.startsWith("VC")) {
      words.push(WX_INTENSITY.VC);
      rest = rest.slice(2);
    }
    // A thunderstorm alone, with no precipitation named.
    if (rest === "TS") words.push("thunderstorm");
    else if (rest === "SH") words.push("showers");
    // Several phenomena in one group ("RAGS") are rain and small hail.
    const things: string[] = [];
    while (rest.length >= 2 && rest !== "TS" && rest !== "SH") {
      const pair = rest.slice(0, 2);
      if (WX_DESCRIPTOR[pair] && rest.length > 2 && !things.length) words.push(WX_DESCRIPTOR[pair]);
      else if (WX_PHENOMENA[pair]) things.push(WX_PHENOMENA[pair]);
      else things.push(pair.toLowerCase());
      rest = rest.slice(2);
    }
    if (things.length) words.push(things.length > 1 ? `${things.slice(0, -1).join(", ")} and ${things[things.length - 1]}` : things[0]);
    const text = words.filter(Boolean).join(" ").trim();
    if (text) out.push(text.charAt(0).toUpperCase() + text.slice(1));
  }
  return out;
}
