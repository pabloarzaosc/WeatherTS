// A METAR read group by group into plain English: the body as ICAO Annex 3
// and the FAA write it (wind, visibility, RVR, weather, sky, temperatures,
// pressure, recent weather, wind shear, runway state, sea state, trends) and
// the remarks the US and others add (peak wind, wind shift, precipitation
// begin and end times, the hourly temperature to a tenth, the 6- and 24-hour
// extremes and totals, the pressure tendency, sensor outages...).
//
// Anything not recognised is kept and shown as written, never dropped.

import { describeWx } from "./metar";

export interface DecodedGroup {
  /** The group as written in the report. */
  code: string;
  label: string;
  text: string;
  tone?: "warn" | "bad";
}

export interface DecodedMetar {
  body: DecodedGroup[];
  trend: DecodedGroup[];
  remarks: DecodedGroup[];
}

const POINTS: Record<string, string> = {
  N: "north", NE: "northeast", E: "east", SE: "southeast", S: "south", SW: "southwest", W: "west", NW: "northwest",
};
const COVER: Record<string, string> = {
  FEW: "Few", SCT: "Scattered", BKN: "Broken", OVC: "Overcast", SKC: "Sky clear", CLR: "Clear below 12,000 ft",
  NSC: "No significant cloud", NCD: "No cloud detected",
};
const CLOUD_TYPE: Record<string, string> = { CB: "cumulonimbus", TCU: "towering cumulus" };

const ft = (n: number) => `${Math.round(n).toLocaleString("en-US")} ft`;
const signed = (s: string, t: string) => (s === "1" ? -1 : 1) * (Number(t) / 10);
const tempWord = (c: number) => `${c.toFixed(1)}°C (${((c * 9) / 5 + 32).toFixed(1)}°F)`;

function utcTime(hhmm: string, day?: string): string {
  return `${day ? `Day ${Number(day)}, ` : ""}${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)} UTC`;
}

/** Statute-mile fractions and wholes: "1 1/2", "3/4", "M1/4", "P6". */
function smText(s: string): string {
  const less = s.startsWith("M");
  const more = s.startsWith("P");
  const body = s.replace(/^[MP]/, "");
  let n = 0;
  for (const part of body.split(" ")) {
    if (part.includes("/")) {
      const [a, b] = part.split("/").map(Number);
      n += a / b;
    } else n += Number(part);
  }
  const km = n * 1.609344;
  const word = `${body} statute mile${n === 1 ? "" : "s"} (${km >= 10 ? Math.round(km) : km.toFixed(1)} km)`;
  return less ? `Less than ${word}` : more ? `More than ${word}` : word;
}

function metresText(m: number): string {
  if (m >= 9999) return "10 km or more";
  const sm = m / 1609.344;
  const smWord = sm >= 3 ? sm.toFixed(0) : sm.toFixed(sm < 1 ? 2 : 1);
  return m >= 5000 ? `${m / 1000} km (${smWord} SM)` : `${m.toLocaleString("en-US")} m (${smWord} SM)`;
}

function windText(m: RegExpMatchArray): { text: string; tone?: "warn" | "bad" } {
  const [, dir, spdRaw, , gstRaw, unit] = m;
  const k = unit === "MPS" ? 1.943844 : unit === "KMH" ? 0.539957 : 1;
  const spd = Number(spdRaw) * k;
  const gst = gstRaw ? Number(gstRaw) * k : null;
  if (spd === 0 && dir === "000") return { text: "Calm" };
  const from = dir === "VRB" ? "Variable direction" : `From ${dir}° true`;
  const u = unit === "KT" ? "kt" : unit === "MPS" ? `m/s (${Math.round(spd)} kt)` : `km/h (${Math.round(spd)} kt)`;
  const shown = unit === "KT" ? `${Math.round(spd)} kt` : `${Number(spdRaw)} ${u}`;
  const text = `${from} at ${shown}${gst != null ? `, gusting ${unit === "KT" ? `${Math.round(gst)} kt` : `${Number(gstRaw)} (${Math.round(gst)} kt)`}` : ""}`;
  const worst = gst ?? spd;
  return { text, tone: worst >= 35 ? "bad" : worst >= 25 ? "warn" : undefined };
}

const WX_TOKEN = /^(\+|-|VC|RE)?(MI|PR|BC|DR|BL|SH|TS|FZ)?((?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)*)$/;
const isWx = (t: string) => t !== "" && WX_TOKEN.test(t) && t !== "VC" && t !== "RE" && t !== "-" && t !== "+";
const wxText = (t: string) => {
  const words = describeWx(t.replace(/^RE/, ""));
  return words.join(", ") || t;
};
const wxTone = (t: string): "warn" | "bad" | undefined =>
  /TS|FC|\+|GR|FZ|SQ|SS|DS|VA|PL/.test(t) ? "bad" : /SN|FG|SH|GS|BL/.test(t) ? "warn" : undefined;

const RWY_DEPOSIT = ["Clear and dry", "Damp", "Wet or water patches", "Rime or frost", "Dry snow", "Wet snow", "Slush",
  "Ice", "Compacted snow", "Frozen ruts"];
const RWY_EXTENT: Record<string, string> = { "1": "10% or less", "2": "11-25%", "5": "26-50%", "9": "51-100%" };

function depthText(d: string): string {
  if (d === "//") return "depth not reported";
  const n = Number(d);
  if (n === 0) return "less than 1 mm deep";
  if (n <= 90) return `${n} mm deep`;
  return ({ 92: "10 cm deep", 93: "15 cm deep", 94: "20 cm deep", 95: "25 cm deep", 96: "30 cm deep", 97: "35 cm deep",
    98: "40 cm or more deep", 99: "runway closed" } as Record<number, string>)[n] ?? `code ${d}`;
}

function brakingText(b: string): string {
  if (b === "//") return "braking not reported";
  const n = Number(b);
  if (n <= 90) return `friction 0.${String(n).padStart(2, "0")}`;
  return ({ 91: "braking poor", 92: "braking medium to poor", 93: "braking medium", 94: "braking medium to good",
    95: "braking good", 99: "braking unreliable" } as Record<number, string>)[n] ?? `braking code ${b}`;
}

const TENDENCY = [
  "rising, then falling", "rising, then steady (or rising more slowly)", "rising steadily", "falling or steady, then rising",
  "steady", "falling, then rising", "falling, then steady (or falling more slowly)", "falling steadily",
  "steady or rising, then falling",
];

/** One body group, or null when it is not one: shared by the body and the trends. */
function bodyGroup(t: string, next: string | undefined): (DecodedGroup & { eat?: number }) | null {
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(\d{3}|VRB|\/\/\/)(\d{2,3}|\/\/)(G(\d{2,3}))?(KT|MPS|KMH)$/))) {
    if (m[1] === "///") return { code: t, label: "Wind", text: "Not reported" };
    const w = windText(m);
    return { code: t, label: "Wind", ...w };
  }
  if ((m = t.match(/^(\d{3})V(\d{3})$/))) return { code: t, label: "Wind varying", text: `Between ${m[1]}° and ${m[2]}°` };
  if (t === "CAVOK") return { code: t, label: "CAVOK", text: "Visibility 10 km or more, no cloud below 5,000 ft or the highest minimum sector altitude, no CB or TCU, no significant weather" };
  if (/^\d+$/.test(t) && next && /^\d\/\d+SM$/.test(next)) {
    return { code: `${t} ${next}`, label: "Visibility", text: smText(`${t} ${next.replace("SM", "")}`), eat: 1 };
  }
  if ((m = t.match(/^([MP]?\d+(?:\/\d+)?)SM$/))) {
    const v = m[1];
    const n = v.includes("/") ? 0.5 : Number(v.replace(/[MP]/, ""));
    return { code: t, label: "Visibility", text: smText(v), tone: n < 1 ? "bad" : n < 3 ? "warn" : undefined };
  }
  if ((m = t.match(/^(\d{4})(NDV)?$/))) {
    const v = Number(m[1]);
    return { code: t, label: "Visibility", text: `${metresText(v)}${m[2] ? " (no directional variation measured)" : ""}`,
      tone: v < 1600 ? "bad" : v < 5000 ? "warn" : undefined };
  }
  if ((m = t.match(/^(\d{4})(N|NE|E|SE|S|SW|W|NW)$/))) {
    return { code: t, label: "Lowest visibility", text: `${metresText(Number(m[1]))} toward the ${POINTS[m[2]]}` };
  }
  if ((m = t.match(/^R(\d{2}[LRC]?)\/([PM])?(\d{4})(?:V([PM])?(\d{4}))?(FT)?\/?([UDN])?$/))) {
    const unit = m[6] ? " ft" : " m";
    const val = (q: string | undefined, v: string) => `${q === "P" ? "more than " : q === "M" ? "less than " : ""}${Number(v).toLocaleString("en-US")}${unit}`;
    const trend = { U: ", rising", D: ", falling", N: ", no change" }[m[7] ?? ""] ?? "";
    return { code: t, label: `RVR runway ${m[1]}`, text: m[5] ? `Varying ${val(m[2], m[3])} to ${val(m[4], m[5])}${trend}` : `${val(m[2], m[3])}${trend}`,
      tone: Number(m[3]) < (m[6] ? 2400 : 800) ? "bad" : "warn" };
  }
  if ((m = t.match(/^R(\d{2}[LRC]?)\/(\d|\/)(\d|\/)(\d{2}|\/\/)(\d{2}|\/\/)$/))) {
    const dep = m[2] === "/" ? "deposit not reported" : RWY_DEPOSIT[Number(m[2])];
    const ext = RWY_EXTENT[m[3]] ? `, covering ${RWY_EXTENT[m[3]]}` : "";
    const rwy = m[1] === "88" ? "All runways: " : m[1] === "99" ? "Repeated, no new report: " : "";
    return { code: t, label: m[1] === "88" || m[1] === "99" ? "Runway state" : `Runway ${m[1]} state`,
      text: `${rwy}${dep}${ext}, ${depthText(m[4])}, ${brakingText(m[5])}`,
      tone: m[2] !== "0" ? "warn" : undefined };
  }
  if ((m = t.match(/^R(\d{2}[LRC]?)\/CLRD(\d{2})$/))) return { code: t, label: `Runway state ${m[1]}`, text: `Contamination cleared, ${brakingText(m[2])}` };
  if (t === "SNOCLO" || t === "R/SNOCLO") return { code: t, label: "Aerodrome", text: "Closed by snow", tone: "bad" };
  if (t === "NSW") return { code: t, label: "Weather", text: "No significant weather" };
  if ((m = t.match(/^(FEW|SCT|BKN|OVC)(\d{3}|\/\/\/)(CB|TCU|\/\/\/)?$/))) {
    const base = m[2] === "///" ? "base not reported" : `at ${ft(Number(m[2]) * 100)}`;
    const typ = m[3] && m[3] !== "///" ? `, ${CLOUD_TYPE[m[3]]}` : "";
    const low = m[2] !== "///" && Number(m[2]) * 100;
    return { code: t, label: "Clouds", text: `${COVER[m[1]]} ${base}${typ}`,
      tone: m[3] === "CB" ? "bad" : (m[1] === "BKN" || m[1] === "OVC") && low !== false && low < 1000 ? "warn" : undefined };
  }
  if ((m = t.match(/^VV(\d{3}|\/\/\/)$/))) {
    return { code: t, label: "Vertical visibility", text: m[1] === "///" ? "Sky obscured, not measured" : `Sky obscured, ${ft(Number(m[1]) * 100)}`, tone: "bad" };
  }
  if (/^(SKC|CLR|NSC|NCD)$/.test(t)) return { code: t, label: "Clouds", text: COVER[t] };
  if ((m = t.match(/^(M)?(\d{2})\/(M)?(\d{2})?$/))) {
    const tc = (m[1] ? -1 : 1) * Number(m[2]);
    const dc = m[4] != null ? (m[3] ? -1 : 1) * Number(m[4]) : null;
    return { code: t, label: "Temperature / dew point",
      text: `${tc}°C (${Math.round((tc * 9) / 5 + 32)}°F) / ${dc == null ? "not reported" : `${dc}°C (${Math.round((dc * 9) / 5 + 32)}°F), spread ${tc - dc}°`}` };
  }
  if ((m = t.match(/^A(\d{4})$/))) {
    const inhg = Number(m[1]) / 100;
    return { code: t, label: "Altimeter", text: `${inhg.toFixed(2)} inHg (${Math.round(inhg * 33.8639)} hPa)` };
  }
  if ((m = t.match(/^Q(\d{4})$/))) {
    const hpa = Number(m[1]);
    return { code: t, label: "QNH", text: `${hpa} hPa (${(hpa / 33.8639).toFixed(2)} inHg)` };
  }
  if ((m = t.match(/^W(M)?(\d{2})\/(S(\d)|H(\d+))$/))) {
    const sea = ["calm (glassy)", "calm (rippled)", "smooth", "slight", "moderate", "rough", "very rough", "high", "very high", "phenomenal"];
    return { code: t, label: "Sea", text: `Surface ${(m[1] ? -1 : 1) * Number(m[2])}°C, ${m[4] != null ? `state ${m[4]}: ${sea[Number(m[4])]}` : `waves ${Number(m[5]) / 10} m`}` };
  }
  if (/^(BLU|WHT|GRN|YLO1?|YLO2?|AMB|RED)\+?$/.test(t) || /^BL(BLU|WHT|GRN|YLO|AMB|RED)/.test(t)) {
    return { code: t, label: "Colour state", text: `${t.startsWith("BL") && t !== "BLU" ? "Black (airfield unusable), " : ""}military colour code ${t.replace(/^BL(?!U)/, "")}` };
  }
  if (t.startsWith("RE") && isWx(t)) return { code: t, label: "Recent weather", text: wxText(t) };
  if (isWx(t)) return { code: t, label: "Weather", text: wxText(t), tone: wxTone(t) };
  return null;
}

/** A METAR (or SPECI) into its groups, its trend and its remarks. */
export function decodeMetar(raw: string | null | undefined): DecodedMetar {
  const out: DecodedMetar = { body: [], trend: [], remarks: [] };
  if (!raw) return out;
  const text = raw.trim().replace(/=+$/, "");
  const rmkAt = text.search(/\sRMK\s/);
  const main = rmkAt >= 0 ? text.slice(0, rmkAt) : text;
  const rmk = rmkAt >= 0 ? text.slice(rmkAt + 5).trim() : "";
  const tokens = main.split(/\s+/);
  let i = 0;
  const unknown: string[] = [];

  if (/^(METAR|SPECI)$/.test(tokens[i])) {
    out.body.push({ code: tokens[i], label: "Report", text: tokens[i] === "SPECI" ? "Special report (conditions changed)" : "Routine report" });
    i++;
  }
  if (tokens[i] === "COR") {
    out.body.push({ code: "COR", label: "Correction", text: "Corrects an earlier report" });
    i++;
  }
  if (tokens[i] && /^[A-Z][A-Z0-9]{3}$/.test(tokens[i])) {
    out.body.push({ code: tokens[i], label: "Station", text: tokens[i] });
    i++;
  }
  if (tokens[i] && /^\d{6}Z$/.test(tokens[i])) {
    const t = tokens[i];
    out.body.push({ code: t, label: "Observed", text: utcTime(t.slice(2, 6), t.slice(0, 2)) });
    i++;
  }
  // The trend groups start a forecast of the next two hours; what follows them is theirs.
  let trend: DecodedGroup | null = null;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    const target = trend ? out.trend : out.body;
    if (t === "NIL") {
      out.body.push({ code: t, label: "Report", text: "Missing (NIL)", tone: "bad" });
      continue;
    }
    if (t === "AUTO") {
      out.body.push({ code: t, label: "Automated", text: "Fully automated, no human observer" });
      continue;
    }
    if (t === "COR" || t === "RTD" || /^CC[A-Z]$/.test(t)) {
      out.body.push({ code: t, label: "Amended", text: t === "RTD" ? "Delayed report" : "Corrected report" });
      continue;
    }
    if (t === "NOSIG") {
      out.trend.push({ code: t, label: "Trend", text: "No significant change expected in the next 2 hours" });
      continue;
    }
    if (t === "BECMG" || t === "TEMPO") {
      trend = { code: t, label: "Trend", text: t === "BECMG" ? "Becoming, in the next 2 hours:" : "Temporarily, in the next 2 hours:" };
      out.trend.push(trend);
      continue;
    }
    if (trend && /^(FM|TL|AT)\d{4}$/.test(t)) {
      const word = { FM: "from", TL: "until", AT: "at" }[t.slice(0, 2)]!;
      trend.text = trend.text.replace(/:$/, `, ${word} ${t.slice(2, 4)}:${t.slice(4)} UTC:`);
      trend.code += ` ${t}`;
      continue;
    }
    if (t === "WS" && tokens[i + 1]) {
      if (tokens[i + 1] === "ALL" && tokens[i + 2] === "RWY") {
        target.push({ code: "WS ALL RWY", label: "Wind shear", text: "Reported on all runways", tone: "bad" });
        i += 2;
      } else {
        const r = tokens[i + 1].replace(/^R(WY)?/, "");
        target.push({ code: `WS ${tokens[i + 1]}`, label: "Wind shear", text: `Reported on runway ${r}`, tone: "bad" });
        i += 1;
      }
      continue;
    }
    const g = bodyGroup(t, tokens[i + 1]);
    if (g) {
      i += g.eat ?? 0;
      delete g.eat;
      target.push(g);
      continue;
    }
    unknown.push(t);
  }
  if (unknown.length) out.body.push({ code: unknown.join(" "), label: "Not decoded", text: unknown.join(" ") });
  if (rmk) out.remarks = decodeRemarks(rmk);
  return out;
}

const EVENT_WX = /((?:\+|-|VC)?(?:MI|PR|BC|DR|BL|SH|TS|FZ)?(?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)*|TS)((?:[BE]\d{2,4})+)/g;

/** "RAB15E30SNB30" -> "Rain began :15, ended :30; snow began :30". */
function eventsText(t: string): string | null {
  if (!/^([A-Z+-]+[BE]\d{2,4})+$/.test(t)) return null;
  const parts: string[] = [];
  for (const m of t.matchAll(EVENT_WX)) {
    if (!m[1] || !m[2]) continue;
    const what = describeWx(m[1]).join(", ") || m[1];
    const times = [...m[2].matchAll(/([BE])(\d{2,4})/g)].map(
      ([, be, hm]) => `${be === "B" ? "began" : "ended"} ${hm.length === 4 ? `${hm.slice(0, 2)}:${hm.slice(2)}` : `:${hm}`}`,
    );
    parts.push(`${what} ${times.join(", ")}`);
  }
  return parts.length ? parts.join("; ") : null;
}

const LOC = /^(OHD|VC|DSNT|ALQDS|ALQS|N|NE|E|SE|S|SW|W|NW|AND|-)+$/;
function locWords(list: string[]): string {
  return list
    .map((x) => ({ OHD: "overhead", VC: "in the vicinity", DSNT: "distant", ALQDS: "all quadrants", ALQS: "all quadrants", AND: "and" } as Record<string, string>)[x] ??
      x.split("-").map((p) => POINTS[p] ?? p).join(" to "))
    .join(" ");
}

/** The remarks after RMK, US practice first, the rest kept as written. */
export function decodeRemarks(rmk: string): DecodedGroup[] {
  const tokens = rmk.split(/\s+/).filter(Boolean);
  const out: DecodedGroup[] = [];
  const other: string[] = [];
  const flush = () => {
    if (other.length) out.push({ code: other.join(" "), label: "Remark", text: other.join(" ") });
    other.length = 0;
  };
  const push = (g: DecodedGroup) => {
    flush();
    out.push(g);
  };
  let m: RegExpMatchArray | null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const nxt = tokens[i + 1];
    if ((m = t.match(/^AO([12])A?$/))) {
      push({ code: t, label: "Station", text: m[1] === "2" ? "Automated, with a precipitation discriminator (rain vs snow)" : "Automated, no precipitation discriminator" });
      continue;
    }
    if (t === "PK" && nxt === "WND" && tokens[i + 2]) {
      const g = tokens[i + 2];
      const pm = g.match(/^(\d{3})(\d{2,3})\/(\d{2})?(\d{2})$/);
      if (pm) push({ code: `PK WND ${g}`, label: "Peak wind", text: `${pm[1]}° at ${Number(pm[2])} kt, at ${pm[3] ? `${pm[3]}:${pm[4]}` : `:${pm[4]}`} UTC`, tone: Number(pm[2]) >= 35 ? "bad" : "warn" });
      else other.push(`PK WND ${g}`);
      i += 2;
      continue;
    }
    if (t === "WSHFT" && nxt) {
      const fropa = tokens[i + 2] === "FROPA";
      const hm = nxt;
      push({ code: `WSHFT ${hm}${fropa ? " FROPA" : ""}`, label: "Wind shift", text: `At ${hm.length === 4 ? `${hm.slice(0, 2)}:${hm.slice(2)}` : `:${hm}`} UTC${fropa ? ", with a frontal passage" : ""}` });
      i += fropa ? 2 : 1;
      continue;
    }
    if (t === "FROPA") {
      push({ code: t, label: "Front", text: "Frontal passage" });
      continue;
    }
    if ((t === "TWR" || t === "SFC") && nxt === "VIS") {
      let v = tokens[i + 2] ?? "";
      let used = 2;
      if (/^\d+$/.test(v) && /^\d\/\d+$/.test(tokens[i + 3] ?? "")) {
        v = `${v} ${tokens[i + 3]}`;
        used = 3;
      }
      push({ code: `${t} VIS ${v}`, label: t === "TWR" ? "Tower visibility" : "Surface visibility", text: smText(v) });
      i += used;
      continue;
    }
    if (t === "VIS" && nxt) {
      // VIS 1/2V2, VIS NE 2 1/2, VIS 2 1/2 RWY11
      let j = i + 1;
      let dir = "";
      if (POINTS[tokens[j]]) {
        dir = tokens[j];
        j++;
      }
      let v = tokens[j] ?? "";
      if (/^\d+$/.test(v) && /^\d\/\d+(V.*)?$/.test(tokens[j + 1] ?? "")) {
        v = `${v} ${tokens[j + 1]}`;
        j++;
      }
      let rwy = "";
      if (/^RWY\d/.test(tokens[j + 1] ?? "")) {
        rwy = tokens[j + 1];
        j++;
      }
      const vv = v.match(/^(.+)V(.+)$/);
      const text = vv ? `Varying ${smText(vv[1])} to ${smText(vv[2])}` : smText(v);
      push({ code: tokens.slice(i, j + 1).join(" "), label: "Visibility", text: `${text}${dir ? ` toward the ${POINTS[dir]}` : ""}${rwy ? ` at runway ${rwy.slice(3)}` : ""}` });
      i = j;
      continue;
    }
    if (t === "CIG" && nxt) {
      const cm = nxt.match(/^(\d{3})V(\d{3})$/);
      if (cm) {
        push({ code: `CIG ${nxt}`, label: "Ceiling", text: `Varying ${ft(Number(cm[1]) * 100)} to ${ft(Number(cm[2]) * 100)}`, tone: "warn" });
        i++;
        continue;
      }
      if (/^\d{3}$/.test(nxt)) {
        const r = /^RWY/.test(tokens[i + 2] ?? "") ? tokens[i + 2] : "";
        push({ code: `CIG ${nxt}${r ? ` ${r}` : ""}`, label: "Ceiling", text: `${ft(Number(nxt) * 100)}${r ? ` at runway ${r.slice(3)}` : ""}` });
        i += r ? 2 : 1;
        continue;
      }
    }
    if ((m = t.match(/^(OCNL|FRQ|CONS)$/)) && /^LTG/.test(nxt ?? "")) {
      const kinds = (nxt.slice(3).match(/IC|CC|CG|CA/g) ?? []).map((k) => ({ IC: "in-cloud", CC: "cloud-to-cloud", CG: "cloud-to-ground", CA: "cloud-to-air" })[k]);
      const loc: string[] = [];
      let j = i + 2;
      while (tokens[j] && LOC.test(tokens[j])) loc.push(tokens[j++]);
      push({ code: tokens.slice(i, j).join(" "), label: "Lightning",
        text: `${{ OCNL: "Occasional", FRQ: "Frequent", CONS: "Continuous" }[m[1]]} ${kinds.length ? kinds.join(", ") : ""} lightning${loc.length ? `, ${locWords(loc)}` : ""}`, tone: "bad" });
      i = j - 1;
      continue;
    }
    if (/^LTG/.test(t)) {
      const kinds = (t.slice(3).match(/IC|CC|CG|CA/g) ?? []).map((k) => ({ IC: "in-cloud", CC: "cloud-to-cloud", CG: "cloud-to-ground", CA: "cloud-to-air" })[k]);
      const loc: string[] = [];
      let j = i + 1;
      while (tokens[j] && LOC.test(tokens[j])) loc.push(tokens[j++]);
      push({ code: tokens.slice(i, j).join(" "), label: "Lightning", text: `${kinds.length ? kinds.join(", ") : "Lightning"}${kinds.length ? " lightning" : ""}${loc.length ? `, ${locWords(loc)}` : ""}`, tone: "bad" });
      i = j - 1;
      continue;
    }
    if (/^(TS|CB|TCU|ACC|ACSL|CCSL|SCSL|VIRGA|CBMAM|FU|HZ|BR|FG)$/.test(t) && nxt && (LOC.test(nxt) || nxt === "MOV")) {
      const loc: string[] = [];
      let j = i + 1;
      while (tokens[j] && LOC.test(tokens[j])) loc.push(tokens[j++]);
      let mov = "";
      if (tokens[j] === "MOV" && tokens[j + 1]) {
        mov = tokens[j + 1] === "STNRY" || tokens[j + 1] === "STNR" ? ", stationary" : `, moving ${POINTS[tokens[j + 1]] ?? tokens[j + 1]}`;
        j += 2;
      }
      const what = ({ TS: "Thunderstorm", CB: "Cumulonimbus", TCU: "Towering cumulus", ACC: "Altocumulus castellanus",
        ACSL: "Standing lenticular altocumulus", CCSL: "Standing lenticular cirrocumulus", SCSL: "Standing lenticular stratocumulus",
        VIRGA: "Virga", CBMAM: "Cumulonimbus mammatus", FU: "Smoke", HZ: "Haze", BR: "Mist", FG: "Fog" } as Record<string, string>)[t];
      push({ code: tokens.slice(i, j).join(" "), label: "Seen", text: `${what}${loc.length ? `, ${locWords(loc)}` : ""}${mov}`, tone: t === "TS" || t === "CB" ? "bad" : undefined });
      i = j - 1;
      continue;
    }
    if (t === "GR" && nxt) {
      let v = nxt;
      if (/^\d\/\d$/.test(tokens[i + 2] ?? "")) {
        v = `${nxt} ${tokens[i + 2]}`;
        i++;
      }
      push({ code: `GR ${v}`, label: "Hail", text: `Largest stones ${v} in`, tone: "bad" });
      i++;
      continue;
    }
    const ev = eventsText(t);
    if (ev) {
      push({ code: t, label: "Began / ended", text: ev });
      continue;
    }
    if (t === "PRESRR" || t === "PRESFR") {
      push({ code: t, label: "Pressure", text: t === "PRESRR" ? "Rising rapidly" : "Falling rapidly", tone: "warn" });
      continue;
    }
    if ((m = t.match(/^SLP(\d{3}|NO)$/))) {
      if (m[1] === "NO") push({ code: t, label: "Sea-level pressure", text: "Not available" });
      else {
        const v = Number(m[1]) / 10;
        const hpa = v >= 50 ? 900 + v : 1000 + v;
        push({ code: t, label: "Sea-level pressure", text: `${hpa.toFixed(1)} hPa` });
      }
      continue;
    }
    if (t === "SNINCR" && nxt) {
      const [a, b] = nxt.split("/");
      push({ code: `SNINCR ${nxt}`, label: "Snow increasing rapidly", text: `${a} in in the past hour, ${b} in on the ground` });
      i++;
      continue;
    }
    if ((m = t.match(/^P(\d{4})$/))) {
      const v = Number(m[1]) / 100;
      push({ code: t, label: "Precipitation, past hour", text: v === 0 ? "A trace" : `${v.toFixed(2)} in (${(v * 25.4).toFixed(1)} mm)` });
      continue;
    }
    if ((m = t.match(/^6(\d{4}|\/{4})$/))) {
      const v = m[1].includes("/") ? null : Number(m[1]) / 100;
      push({ code: t, label: "Precipitation, past 3 or 6 h", text: v == null ? "Not measured" : v === 0 ? "A trace" : `${v.toFixed(2)} in (${(v * 25.4).toFixed(1)} mm)` });
      continue;
    }
    if ((m = t.match(/^7(\d{4}|\/{4})$/))) {
      const v = m[1].includes("/") ? null : Number(m[1]) / 100;
      push({ code: t, label: "Precipitation, past 24 h", text: v == null ? "Not measured" : v === 0 ? "A trace" : `${v.toFixed(2)} in (${(v * 25.4).toFixed(1)} mm)` });
      continue;
    }
    if ((m = t.match(/^4\/(\d{3})$/))) {
      push({ code: t, label: "Snow depth", text: `${Number(m[1])} in (${Math.round(Number(m[1]) * 2.54)} cm)` });
      continue;
    }
    if ((m = t.match(/^933(\d{3})$/))) {
      push({ code: t, label: "Water in the snow", text: `${(Number(m[1]) / 10).toFixed(1)} in on the ground` });
      continue;
    }
    if ((m = t.match(/^98(\d{3})$/))) {
      push({ code: t, label: "Sunshine", text: `${Number(m[1])} minutes yesterday` });
      continue;
    }
    if ((m = t.match(/^T([01])(\d{3})([01])(\d{3})?$/))) {
      const tc = signed(m[1], m[2]);
      const dc = m[4] ? signed(m[3], m[4]) : null;
      push({ code: t, label: "Temperature / dew point", text: `${tempWord(tc)}${dc != null ? ` / ${tempWord(dc)}` : ""} (to a tenth)` });
      continue;
    }
    if ((m = t.match(/^1([01])(\d{3})$/))) {
      push({ code: t, label: "Maximum, past 6 h", text: tempWord(signed(m[1], m[2])) });
      continue;
    }
    if ((m = t.match(/^2([01])(\d{3})$/))) {
      push({ code: t, label: "Minimum, past 6 h", text: tempWord(signed(m[1], m[2])) });
      continue;
    }
    if ((m = t.match(/^4([01])(\d{3})([01])(\d{3})$/))) {
      push({ code: t, label: "24-hour extremes", text: `Maximum ${tempWord(signed(m[1], m[2]))}, minimum ${tempWord(signed(m[3], m[4]))}` });
      continue;
    }
    if ((m = t.match(/^5([0-8])(\d{3})$/))) {
      const v = Number(m[2]) / 10;
      const a = Number(m[1]);
      // Codes 0-3 end higher than three hours before, 4 the same, 5-8 lower.
      const sign = v === 0 || a === 4 ? "" : a <= 3 ? "+" : "-";
      push({ code: t, label: "Pressure tendency, 3 h", text: `${sign}${v.toFixed(1)} hPa, ${TENDENCY[a]}`, tone: v >= 3 ? "warn" : undefined });
      continue;
    }
    if ((m = t.match(/^8\/(\d|\/)(\d|\/)(\d|\/)$/))) {
      push({ code: t, label: "Cloud types", text: `Low type ${m[1]}, middle type ${m[2]}, high type ${m[3]} (WMO codes)` });
      continue;
    }
    if (/^(RVRNO|PWINO|PNO|FZRANO|TSNO|VISNO|CHINO|SLPNO)$/.test(t)) {
      const what = { RVRNO: "RVR", PWINO: "Present-weather sensor", PNO: "Precipitation gauge", FZRANO: "Freezing-rain sensor",
        TSNO: "Lightning sensor", VISNO: "Visibility sensor", CHINO: "Ceilometer", SLPNO: "Sea-level pressure" }[t]!;
      const r = /^RWY/.test(nxt ?? "") ? ` at runway ${nxt.slice(3)}` : "";
      push({ code: `${t}${r ? ` ${nxt}` : ""}`, label: "Out of service", text: `${what}${r}` , tone: "warn" });
      if (r) i++;
      continue;
    }
    if (t === "$") {
      push({ code: t, label: "Maintenance", text: "The station needs maintenance" });
      continue;
    }
    if (t === "NOSPECI") {
      push({ code: t, label: "Station", text: "Does not issue special reports" });
      continue;
    }
    if (t === "LAST" || t === "FIRST") {
      push({ code: t, label: "Station", text: t === "LAST" ? "Last report before closing" : "First report after opening" });
      continue;
    }
    if ((m = t.match(/^QFE(\d{3,4})(\/(\d{4}))?$/))) {
      push({ code: t, label: "QFE", text: `${m[1]} mmHg${m[3] ? ` (${Number(m[3])} hPa)` : ""}` });
      continue;
    }
    if ((m = t.match(/^R(\d{2}[LRC]?)\/(\d|\/)(\d|\/)(\d{2}|\/\/)(\d{2}|\/\/)$/))) {
      const g = bodyGroup(t, nxt);
      if (g) push(g);
      continue;
    }
    other.push(t);
  }
  flush();
  return out;
}
