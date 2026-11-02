// Colour tables: which table each radar product draws with, and the tools
// around them (the in-pane editor, ] / [, colour scale and offset, the bulk
// .pal import, Export .pal).
//
// A product is named by its default palette id (FILE_DR for reflectivity,
// FILE_amixof2BV for velocity -- nexrad_core._KIND_DEFAULT_PALETTE). It can
// draw with that default, a built-in alternate (BUILTIN_ALTERNATES) or a saved
// palette (usePaletteStore.custom). resolveTableText() is the one answer to
// "what table does this product draw with right now", used by the meshes, the
// colour bars, the 3D view, cross-sections and the GIF legend alike -- so an
// editor draft or a scale/offset shows everywhere at once.

import { pidOfCustom, slugOf, usePaletteStore, type PalAdjust } from "../store/usePaletteStore";
import { useColorTableStore, type ImportItem, type TableSource } from "../store/useColorTableStore";
import { moveEntries, palNum, palSignature, parsePal, writePal, type PalEntry, type PalHeader, type PalTable } from "./pal";
import type { PaletteDef } from "./nexrad";

export type Tables = Record<string, PaletteDef>;

/** The other built-ins worth offering for a product: same quantity, same
 *  units. (The WCT correlation table is authored in rho x100 and would clamp
 *  our 0-1 field to one colour, so it is not offered for CC.) */
export const BUILTIN_ALTERNATES: Record<string, string[]> = {
  FILE_DR: ["REF_WINTER", "REF"],
  FILE_amixof2BV: ["FILE_DV", "VEL"],
  FILE_SRV: ["SRV"],
  FILE_ZDR: ["ZDR"],
  FILE_KDP: ["KDP"],
  FILE_SW: ["SW"],
  FILE_ET_steep: ["FILE_ET", "EET"],
  FILE_OHP: ["DAA"],
  FILE_STP: ["DTA"],
  PTDS: ["PTDS_STEPS"],
};

export interface TableChoice {
  id: string;
  label: string;
  source: TableSource;
}

const emptyTable = (entries: PalEntry[]): PalTable => ({
  entries,
  product: null,
  units: null,
  step: null,
  rf: null,
  scale: null,
  offset: null,
});
export const tableOf = emptyTable;

// ---------------------------------------------------------------------------
// Products: GR product codes and names, our kinds, export headers
// ---------------------------------------------------------------------------

/** GR / WCT product codes (and a few names) -> our product kind. */
const CODE_KIND: Record<string, string> = {
  BR: "ref", BREF: "ref", REF: "ref", R: "ref", Z: "ref", DZ: "ref", DBZ: "ref", N0Q: "ref", N0R: "ref",
  N0B: "ref", NXQ: "ref", CR: "ref", CREF: "ref", REFL: "ref",
  BV: "vel", V: "vel", VEL: "vel", N0U: "vel", N0V: "vel", N0G: "vel",
  SRV: "srv", SRM: "srv", N0S: "srv",
  SW: "sw", NSW: "sw",
  CC: "cc", RHO: "cc", RHOHV: "cc", N0C: "cc",
  ZDR: "zdr", DR: "zdr", N0X: "zdr",
  KDP: "kdp", N0K: "kdp",
  PHI: "phi", PHIDP: "phi", DP: "phi",
  CFP: "cfp",
  ET: "tops", EET: "tops", TOPS: "tops",
  VIL: "vil", DVL: "vil",
  HC: "hca", HHC: "hca", HCA: "hca", N0H: "hca",
  OHP: "precip", DAA: "precip", N1P: "precip",
  STP: "storm_precip", DTA: "storm_precip", NTP: "storm_precip",
  DVIL: "dvil", VROT: "vrot", NROT: "nrot", PTDS: "ptds", TDS: "ptds",
  MEHS: "mehs", POSH: "posh", RATE: "rate",
};
/** Codes too short or too common to trust inside a file NAME. */
const NAME_UNSAFE = new Set(["R", "V", "Z", "DR", "DP", "DZ", "RHO", "CR"]);
/** Words a file name or Product: line may spell out. Order matters: storm
 *  relative velocity before velocity. */
const WORDS: [RegExp, string][] = [
  [/storm.?rel|stormrel/i, "srv"],
  [/veloc/i, "vel"],
  [/reflect/i, "ref"],
  [/correl/i, "cc"],
  [/differential.?ref|diffref/i, "zdr"],
  [/spectrum|specwidth/i, "sw"],
  [/echo.?top/i, "tops"],
  [/debris/i, "ptds"],
  [/hydromet/i, "hca"],
  [/rotation/i, "vrot"],
];

/** What Export writes on the Product: line, and the units its stops are in. */
const KIND_CODE: Record<string, string> = {
  ref: "BR", vel: "BV", srv: "SRV", sw: "SW", cc: "CC", zdr: "ZDR", kdp: "KDP", phi: "PHI", cfp: "CFP",
  tops: "ET", vil: "VIL", hca: "HC", precip: "OHP", storm_precip: "STP", nrot: "NROT", ptds: "PTDS",
  dvil: "DVIL", vrot: "VROT", mehs: "MEHS", posh: "POSH", rate: "RATE",
};
const KIND_UNITS: Record<string, string> = {
  ref: "DBZ", vel: "KTS", srv: "KTS", sw: "KTS", vrot: "KTS", zdr: "DB", kdp: "DEG/KM", phi: "DEG",
  tops: "KFT", vil: "KG/M2", precip: "IN", storm_precip: "IN", dvil: "G/M3", mehs: "MM", rate: "MM/H",
  ptds: "SCORE", posh: "%", cfp: "DB",
};
/** The unit a value field shows, per kind. */
export const KIND_UNIT_LABEL: Record<string, string> = {
  ref: "dBZ", vel: "kt", srv: "kt", sw: "kt", vrot: "kt", zdr: "dB", kdp: "°/km", phi: "°", tops: "kft",
  vil: "kg/m²", precip: "in", storm_precip: "in", dvil: "g/m³", mehs: "mm", rate: "mm/h", ptds: "",
  posh: "%", cfp: "dB", cc: "", nrot: "",
};
const SPEED = new Set(["vel", "srv", "sw", "vrot"]);
/** GR's own convention for speed tables: the radar's m/s times this = knots.
 *  Written on exports so GR reads them right too; our importer takes "KTS". */
const KNOTS_PER_MS = 1.943844;

function kindOfCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const c = code.toUpperCase().replace(/\s+/g, "");
  if (CODE_KIND[c]) return CODE_KIND[c];
  for (const [re, kind] of WORDS) if (re.test(code)) return kind;
  return null;
}

/** The kinds a file NAME mentions, e.g. GareBear_REF -> ref, samCC -> cc. */
function kindsOfName(name: string): string[] {
  const base = name.replace(/\.pal$/i, "");
  const tokens = base
    .split(/[^A-Za-z0-9]+/)
    .flatMap((p) => p.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/))
    .filter(Boolean);
  const out: string[] = [];
  for (const t of tokens) {
    const u = t.toUpperCase();
    if (NAME_UNSAFE.has(u)) continue;
    const k = CODE_KIND[u];
    if (k && !out.includes(k)) out.push(k);
  }
  if (!out.length) for (const [re, kind] of WORDS) if (re.test(base) && !out.includes(kind)) out.push(kind);
  return out;
}

/** The default palette id a kind draws with. */
export function pidOfKind(kind: string | null, kindDefaults: Record<string, string>): string | null {
  return kind ? (kindDefaults[kind] ?? null) : null;
}

/** A kind that draws with this product id (for units and export headers). */
export function kindOfPid(pid: string, kindDefaults: Record<string, string>): string | null {
  const hit = Object.entries(kindDefaults).find(([, v]) => v === pid);
  return hit ? hit[0] : null;
}

// ---------------------------------------------------------------------------
// Which table a product draws with
// ---------------------------------------------------------------------------

/** The product a saved palette belongs to (its own field, the product it is
 *  drawn for, else its Product: line). */
export function productOfCustom(id: string, kindDefaults: Record<string, string>): string | null {
  const { custom, overrides } = usePaletteStore.getState();
  const c = custom.find((p) => p.id === id);
  if (!c) return null;
  return pidOfCustom(c, overrides) ?? pidOfKind(kindOfCode(c.product), kindDefaults);
}

/** Default, the built-in alternates, then the saved palettes for a product. */
export function choicesFor(pid: string, tables: Tables, kindDefaults: Record<string, string> = {}): TableChoice[] {
  const out: TableChoice[] = [];
  if (tables[pid]) out.push({ id: pid, label: tables[pid].label, source: "default" });
  for (const id of BUILTIN_ALTERNATES[pid] ?? []) if (tables[id]) out.push({ id, label: tables[id].label, source: "builtin" });
  const { custom, overrides } = usePaletteStore.getState();
  for (const c of custom) {
    const p = pidOfCustom(c, overrides) ?? pidOfKind(kindOfCode(c.product), kindDefaults);
    if (p === pid) out.push({ id: c.id, label: c.label, source: "custom" });
  }
  return out;
}

/** The table a product draws with now: its choice if that still exists, else
 *  its default. */
export function activeTableId(pid: string, tables: Tables): string {
  const { overrides, custom } = usePaletteStore.getState();
  const o = overrides[pid];
  if (o && (custom.some((c) => c.id === o) || (!o.startsWith("user:") && tables[o]))) return o;
  return pid;
}

export function tableText(id: string, tables: Tables): string | null {
  if (id.startsWith("user:")) return usePaletteStore.getState().custom.find((c) => c.id === id)?.pal ?? null;
  return tables[id]?.pal ?? null;
}

export function tableLabel(id: string, tables: Tables): string {
  if (id.startsWith("user:")) return usePaletteStore.getState().custom.find((c) => c.id === id)?.label ?? id;
  return tables[id]?.label ?? id;
}

export function sourceOf(id: string, pid: string): TableSource {
  return id.startsWith("user:") ? "custom" : id === pid ? "default" : "builtin";
}

/** A table moved by its colour scale and offset. The legend step only
 *  survives a plain shift; a stretched table ticks at round numbers instead. */
export function adjustText(text: string, adj: PalAdjust): string {
  const t = parsePal(text);
  return writePal(moveEntries(t.entries, adj.scale, adj.offset), {
    product: t.product,
    units: t.units,
    step: adj.scale === 1 ? t.step : null,
    rf: t.rf,
  });
}

const memo = new Map<string, { deps: unknown[]; out: string | null }>();

/** The .pal text a product draws with right now: the open editor's draft,
 *  else its chosen table, moved by that table's colour scale and offset.
 *  Called for every frame built, so it is memoised on the stores' states. */
export function resolveTableText(pid: string, tables: Tables): string | null {
  const ps = usePaletteStore.getState();
  const ct = useColorTableStore.getState();
  const deps: unknown[] = [tables, ps.custom, ps.overrides, ps.adjust, ct.draft, ct.editor?.baseId];
  const m = memo.get(pid);
  if (m && m.deps.length === deps.length && m.deps.every((d, i) => d === deps[i])) return m.out;
  const drafting = ct.draft && ct.draft.pid === pid && ct.editor?.pid === pid;
  const id = drafting && ct.editor ? ct.editor.baseId : activeTableId(pid, tables);
  let text = drafting && ct.draft ? ct.draft.text : tableText(id, tables);
  const adj = ps.adjust[id];
  if (text && adj) text = adjustText(text, adj);
  memo.set(pid, { deps, out: text });
  return text;
}

/** ] / [: the next (dir 1) or previous table for a product. */
export function cycleTable(pid: string, dir: 1 | -1, tables: Tables, kindDefaults: Record<string, string>): { choice: TableChoice; index: number; count: number } | null {
  const list = choicesFor(pid, tables, kindDefaults);
  if (list.length < 2) return list.length ? { choice: list[0], index: 0, count: 1 } : null;
  const cur = Math.max(0, list.findIndex((c) => c.id === activeTableId(pid, tables)));
  const index = (cur + dir + list.length) % list.length;
  const choice = list[index];
  usePaletteStore.getState().select(pid, choice.source === "default" ? null : choice.id);
  return { choice, index, count: list.length };
}

/** What Export and Save write: our units, GR's scale for speeds so GR reads
 *  the file right too, and the stops as they are. */
export function exportHeader(kind: string | null, h: { product: string | null; units: string | null; step: number | null; rf: PalHeader["rf"] }, comment?: string): PalHeader {
  const speed = kind ? SPEED.has(kind) : false;
  return {
    comment: comment ?? null,
    product: (kind && KIND_CODE[kind]) || h.product,
    units: (kind && KIND_UNITS[kind]) || h.units,
    step: h.step,
    scale: speed ? KNOTS_PER_MS : 1,
    offset: 0,
    rf: h.rf,
  };
}

/** A text file the user keeps (Export .pal). */
export function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const palFileName = (label: string) => `${slugOf(label)}.pal`;

// ---------------------------------------------------------------------------
// Bulk .pal import
// ---------------------------------------------------------------------------

export const MAX_PAL_BYTES = 100 * 1024;

type UnitGroup = "speed" | "tops" | "precip" | "mm" | "rate";
const KIND_GROUP: Record<string, UnitGroup> = {
  vel: "speed", srv: "speed", sw: "speed", vrot: "speed",
  tops: "tops", precip: "precip", storm_precip: "precip", mehs: "mm", rate: "rate",
};
/** Table unit -> our unit, per group. */
const TO_OURS: Record<UnitGroup, Record<string, number>> = {
  speed: { kt: 1, mph: 0.868976, ms: KNOTS_PER_MS, kmh: 0.539957 },
  tops: { kft: 1, km: 3.28084, ft: 0.001, m: 0.00328084 },
  precip: { in: 1, mm: 1 / 25.4, cm: 1 / 2.54 },
  mm: { mm: 1, in: 25.4, cm: 10 },
  rate: { mmh: 1, inh: 25.4 },
};
const OUR_UNIT: Record<UnitGroup, string> = { speed: "kt", tops: "kft", precip: "in", mm: "mm", rate: "mmh" };
const UNIT_NAME: Record<string, string> = {
  kt: "knots", mph: "mph", ms: "m/s", kmh: "km/h", kft: "kft", km: "km", ft: "ft", m: "m",
  in: "inches", mm: "mm", cm: "cm", mmh: "mm/h", inh: "in/h",
};
const UNIT_HEADER: Record<string, string> = { kt: "KTS", kft: "KFT", in: "IN", mm: "MM", mmh: "MM/H" };

function unitId(u: string | null): string | null {
  if (!u) return null;
  const s = u.toUpperCase().replace(/\s+/g, "");
  const is = (...xs: string[]) => xs.includes(s);
  if (is("KT", "KTS", "KNOT", "KNOTS")) return "kt";
  if (is("MPH")) return "mph";
  if (is("M/S", "MPS", "MS", "M/SEC", "MS-1", "MS^-1")) return "ms";
  if (is("KM/H", "KMH", "KPH", "KMPH", "KM/HR")) return "kmh";
  if (is("KFT")) return "kft";
  if (is("KM")) return "km";
  if (is("FT", "FEET")) return "ft";
  if (is("M")) return "m";
  if (is("IN", "INCH", "INCHES")) return "in";
  if (is("MM")) return "mm";
  if (is("CM")) return "cm";
  if (is("MM/H", "MM/HR", "MMH")) return "mmh";
  if (is("IN/H", "IN/HR", "INH")) return "inh";
  if (is("DBZ")) return "dbz";
  if (is("DB")) return "db";
  if (is("DEG/KM")) return "degkm";
  if (is("DEG", "DEGREES")) return "deg";
  if (is("KG/M2", "KG/M^2", "KGM2", "KG/M**2")) return "kgm2";
  if (is("%", "PCT", "PERCENT")) return "pct";
  return null;
}

/** The speed unit a Scale: line implies: GR multiplies its m/s by it. */
function speedOfScale(s: number | null): string | null {
  if (s == null) return null;
  const near = (t: number) => Math.abs(s - t) / t < 0.005;
  if (near(2.23694)) return "mph";
  if (near(KNOTS_PER_MS)) return "kt"; // also GR's older 1.9426
  if (near(3.6)) return "kmh";
  return null;
}

/** A kind from the units and values alone, when nothing names the product. */
function guessKind(t: PalTable): { kind: string; why: string } | null {
  const u = unitId(t.units);
  const vs = t.entries.map((e) => e.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const speed = u === "kt" || u === "mph" || u === "ms" || u === "kmh" || speedOfScale(t.scale);
  if (u === "dbz") return { kind: "ref", why: "units dBZ" };
  if (speed) return min < 0 ? { kind: "vel", why: "speed units, values both sides of 0" } : { kind: "sw", why: "speed units, no negative values" };
  if (u === "db") return { kind: "zdr", why: "units dB" };
  if (u === "degkm") return { kind: "kdp", why: "units deg/km" };
  if (u === "deg") return { kind: "phi", why: "units deg" };
  if (u === "kft" || u === "km") return { kind: "tops", why: "height units" };
  if (u === "kgm2") return { kind: "vil", why: "units kg/m²" };
  if (u === "in" || u === "mm") return { kind: "precip", why: "rain units" };
  if (t.entries.length >= 3 && min >= -0.05 && max <= 1.1 && max - min >= 0.3) return { kind: "cc", why: "values within 0-1" };
  if (min <= -10 && min >= -40 && max >= 55 && max <= 95) return { kind: "ref", why: `values ${palNum(min)} to ${palNum(max)}` };
  return null;
}

interface FileIn {
  name: string;
  text: string | null;
  size: number;
}

/** One file sorted to its product, checked, and marked for import. */
function analyzeOne(f: FileIn, i: number, kindDefaults: Record<string, string>, picked?: string): ImportItem {
  const item: ImportItem = {
    key: `f${i}`, name: f.name, text: f.text ?? "", orig: f.text ?? "", pid: null, how: null, hint: "", group: "bad",
    warnings: [], fix: null, fixed: false, dup: null, checked: false, error: null,
  };
  if (f.size > MAX_PAL_BYTES) return { ...item, error: `${Math.round(f.size / 1024)} KB: bigger than a colour table (100 KB at most)` };
  if (f.text == null) return { ...item, error: "Could not be read" };
  if (f.text.includes("\u0000")) return { ...item, error: "Not a text file" };
  const t = parsePal(f.text);
  if (t.entries.length < 2) return { ...item, error: "No colour stops (Color: value r g b lines)" };
  if (t.entries[0].v === t.entries[t.entries.length - 1].v) return { ...item, error: "All stops sit at one value" };

  // 1. its Product: line, 2. a product in its file name, 3. a guess (or the
  // product the user picked for it in the dialog)
  let kind = picked ? null : kindOfCode(t.product);
  const fromName = picked ? [] : kindsOfName(f.name);
  if (picked) {
    kind = picked;
    item.how = "picked";
    item.hint = "picked by you";
  } else if (kind) {
    item.how = "product";
    item.hint = `Product: ${t.product}`;
    const other = fromName.find((k) => k !== kind);
    if (other && !fromName.includes(kind)) item.warnings.push(`Its Product: line says ${t.product}, its name suggests ${KIND_CODE[other] ?? other}. Going by the Product: line.`);
  } else if (fromName.length) {
    kind = fromName[0];
    item.how = "name";
    item.hint = `from the file name`;
    if (fromName.length > 1) item.warnings.push(`Its name mentions ${fromName.map((k) => KIND_CODE[k] ?? k).join(" and ")}: check the product.`);
  } else {
    const g = guessKind(t);
    if (g) {
      kind = g.kind;
      item.how = "guess";
      item.hint = `guessed from ${g.why}`;
      item.warnings.push(`Nothing names its product: guessed from ${g.why}. Check it.`);
    }
  }
  item.pid = pidOfKind(kind, kindDefaults);
  if (kind && !item.pid) item.warnings.push(`WeatherTS has no ${KIND_CODE[kind] ?? kind} product to use it on.`);

  // Units: a table in other units than ours places every colour wrong.
  const vs = t.entries.map((e) => e.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const group = kind ? KIND_GROUP[kind] : undefined;
  if (group) {
    const lineUnit = unitId(t.units);
    const scaleUnit = group === "speed" ? speedOfScale(t.scale) : null;
    const known = TO_OURS[group];
    const fromLine = lineUnit && known[lineUnit] ? lineUnit : null;
    if (scaleUnit && fromLine && scaleUnit !== fromLine) {
      item.warnings.push(`Units say ${UNIT_NAME[fromLine]} but Scale ${palNum(t.scale ?? 0)} is the ${UNIT_NAME[scaleUnit]} conversion: going by the Scale.`);
    }
    const unit = scaleUnit ?? fromLine ?? OUR_UNIT[group];
    const factor = known[unit] ?? 1;
    if (Math.abs(factor - 1) > 1e-6) {
      const our = OUR_UNIT[group];
      const why = scaleUnit ? ` (Scale ${palNum(t.scale ?? 0)})` : t.units ? ` (Units: ${t.units})` : "";
      item.fix = { factor, from: UNIT_NAME[unit], to: UNIT_NAME[our], label: `×${palNum(factor)}` };
      item.warnings.push(
        `In ${UNIT_NAME[unit]}${why}: WeatherTS keeps ${kind === "tops" ? "echo tops" : group === "speed" ? "speeds" : "this product"} in ${UNIT_NAME[our]}, so every colour would sit at the wrong value. Fix Scale converts the stops (${item.fix.label}).`,
      );
    }
  } else if (kind === "cc" && max > 2) {
    item.fix = { factor: 0.01, from: "percent", to: "0-1", label: "÷100" };
    item.warnings.push(`Values run ${palNum(min)}–${palNum(max)}: correlation here runs 0–1.05, so this looks like a ×100 table. Fix Scale divides the stops by 100.`);
  } else if (kind === "ref" && (min < -50 || max > 100)) {
    item.warnings.push(`Values run ${palNum(min)}–${palNum(max)}: not the usual dBZ range.`);
  }
  item.group = !item.pid ? "pick" : item.warnings.length ? "check" : "sorted";
  item.checked = !!item.pid;
  return item;
}

/** A product picked by hand for one file: the same unit checks as a file
 *  sorted by itself, from the file as read (an earlier Fix Scale is undone). */
export function repickItem(it: ImportItem, pid: string | null, kindDefaults: Record<string, string>): Partial<ImportItem> {
  const base = { text: it.orig, fixed: false };
  if (!pid) return { ...base, pid: null, how: null, hint: "", checked: false, warnings: [], fix: null };
  const kind = kindOfPid(pid, kindDefaults);
  const a = kind ? analyzeOne({ name: it.name, text: it.orig, size: 0 }, 0, kindDefaults, kind) : null;
  return { ...base, pid, how: "picked", hint: "picked by you", warnings: a?.warnings ?? [], fix: a?.fix ?? null, checked: !it.dup };
}

/** A legend step converted to other units, rounded to 1, 2, 2.5 or 5 x 10^n
 *  (20 mph is 17.4 kt: the legend ticks every 20 kt instead). */
function niceStep(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  const m = [1, 2, 2.5, 5, 10].reduce((a, b) => (Math.abs(b * p - v) < Math.abs(a * p - v) ? b : a));
  return Number((m * p).toPrecision(3));
}

/** The converted table for an item's Fix Scale. */
export function fixedText(it: ImportItem, kindDefaults: Record<string, string>): string {
  if (!it.fix) return it.text;
  const t = parsePal(it.text);
  const kind = it.pid ? kindOfPid(it.pid, kindDefaults) : null;
  const group = kind ? KIND_GROUP[kind] : undefined;
  const our = group ? OUR_UNIT[group] : null;
  const f = it.fix.factor;
  return writePal(moveEntries(t.entries, f, 0), {
    comment: `${it.name}: stops converted from ${it.fix.from} to ${it.fix.to} on import`,
    product: t.product ?? (kind ? KIND_CODE[kind] : null),
    units: our ? UNIT_HEADER[our] : t.units,
    step: t.step ? niceStep(t.step * f) : null,
    scale: group === "speed" ? KNOTS_PER_MS : t.scale != null ? 1 : null,
    offset: t.offset != null ? 0 : null,
    rf: t.rf,
  });
}

/** Sort a set of dropped / picked files. Duplicates (same stops as a saved
 *  palette or an earlier file) start unticked. */
export function analyzeFiles(files: FileIn[], kindDefaults: Record<string, string>): ImportItem[] {
  const seen = new Map<string, string>();
  for (const c of usePaletteStore.getState().custom) seen.set(palSignature(parsePal(c.pal).entries), `saved “${c.label}”`);
  const items = files.map((f, i) => analyzeOne(f, i, kindDefaults));
  for (const it of items) {
    if (it.error) continue;
    const sig = palSignature(parsePal(it.text).entries);
    const dup = seen.get(sig);
    if (dup) {
      it.dup = dup;
      it.checked = false;
    } else seen.set(sig, `“${it.name}”`);
  }
  return items;
}

/** Read what was dropped: files, and folders walked for .pal files. The
 *  entries must be taken during the drop event, so this starts synchronously. */
export function collectDrop(dt: DataTransfer): Promise<{ files: File[]; skipped: number }> {
  const roots: FileSystemEntry[] = [];
  const loose: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
    else {
      const f = item.getAsFile();
      if (f) loose.push(f);
    }
  }
  if (!roots.length && !loose.length) loose.push(...Array.from(dt.files ?? []));
  return (async () => {
    const files: File[] = [...loose];
    let budget = 2000;
    const walk = async (e: FileSystemEntry, depth: number): Promise<void> => {
      if (budget-- <= 0) return;
      if (e.isFile) {
        const f = await new Promise<File | null>((res) => (e as FileSystemFileEntry).file(res, () => res(null)));
        if (f) files.push(f);
      } else if (e.isDirectory && depth < 8) {
        const reader = (e as FileSystemDirectoryEntry).createReader();
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>((res) => reader.readEntries(res, () => res([])));
          if (!batch.length) break;
          for (const c of batch) await walk(c, depth + 1);
        }
      }
    };
    for (const r of roots) await walk(r, 0);
    const pal = files.filter((f) => /\.pal$/i.test(f.name));
    return { files: pal, skipped: files.length - pal.length };
  })();
}

/** Read the files and open the import dialog. */
export async function startImport(files: File[], skipped: number, kindDefaults: Record<string, string>): Promise<void> {
  const ins: FileIn[] = await Promise.all(
    files.slice(0, 500).map(async (f) => ({
      name: f.name,
      size: f.size,
      text: f.size > MAX_PAL_BYTES ? "" : await f.text().catch(() => null),
    })),
  );
  // by name without the extension, so "X.pal" comes before "X copy.pal" and
  // the copy is the one a duplicate check leaves unticked
  const base = (n: string) => n.replace(/\.pal$/i, "");
  ins.sort((a, b) => base(a.name).localeCompare(base(b.name), undefined, { numeric: true }));
  useColorTableStore.getState().openImport(analyzeFiles(ins, kindDefaults), skipped + Math.max(0, files.length - 500));
}

/** Save the ticked files; "Switch to them" draws each product with its first
 *  imported table. */
export function commitImport(): boolean {
  const ct = useColorTableStore.getState();
  const im = ct.importer;
  if (!im) return false;
  const pick = im.items.filter((it) => it.checked && it.pid && !it.error);
  if (!pick.length) {
    ct.setImport({ error: "Nothing ticked to import." });
    return false;
  }
  const taken = new Set(usePaletteStore.getState().custom.map((c) => c.label.toLowerCase()));
  const labels = pick.map((it) => {
    const base = it.name.replace(/\.pal$/i, "").trim() || "Palette";
    let l = base;
    for (let n = 2; taken.has(l.toLowerCase()); n++) l = `${base} (${n})`;
    taken.add(l.toLowerCase());
    return l;
  });
  const r = usePaletteStore.getState().saveMany(pick.map((it, i) => ({ label: labels[i], pal: it.text, pid: it.pid })));
  if (!r.ok) {
    ct.setImport({ error: r.error });
    return false;
  }
  if (im.switchTo) {
    const done = new Set<string>();
    pick.forEach((it, i) => {
      if (!it.pid || done.has(it.pid)) return;
      done.add(it.pid);
      usePaletteStore.getState().select(it.pid, r.ids[i]);
    });
  }
  ct.closeImport();
  ct.showNote(`Imported ${pick.length} colour table${pick.length === 1 ? "" : "s"}${im.switchTo ? " and switched to them" : ""}`);
  return true;
}
