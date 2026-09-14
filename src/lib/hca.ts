import { colorAt, type PalTable } from "./pal";

/** WSR-88D hydrometeor classes. The raw byte IS the class code on these
 *  products (see nexrad_core._decode), spaced by ten. Names taken from the
 *  labels in palettes/HC.pal rather than guessed -- an earlier version had 100
 *  as "hail, possibly with rain" and left 110 and 120 unnamed, when they are
 *  the small / large / giant hail split. 130 is the one genuinely unassigned
 *  code, so it falls through to the numeric label. */
export const HCA_CLASSES: Record<number, string> = {
  10: "Biological",
  20: "Ground clutter / AP",
  30: "Ice crystals",
  40: "Dry snow",
  50: "Wet snow",
  60: "Light-moderate rain",
  70: "Heavy rain",
  80: "Big drops",
  90: "Graupel",
  100: "Small hail",
  110: "Large hail",
  120: "Giant hail",
  140: "Unknown",
  150: "Range folded",
};

/** The NWS's own two-letter codes, for a legend too narrow for the names. */
export const HCA_CODES: Record<number, string> = {
  10: "BI",
  20: "GC",
  30: "IC",
  40: "DS",
  50: "WS",
  60: "RA",
  70: "HR",
  80: "BD",
  90: "GR",
  100: "HA",
  110: "LH",
  120: "GH",
  140: "UK",
  150: "RF",
};

export interface HcaKeyItem {
  code: number;
  label: string;
  short: string;
  /** CSS colour the table draws the class in. */
  color: string;
}

/**
 * The classes a colour table draws, each with its colour.
 *
 * The classification is categories, not a scale: a ramp with numbers under it
 * said "50" where it meant wet snow. Colours are read from the table itself at
 * each class code, so an imported table keys correctly too; a class the table
 * leaves transparent is left out, since nothing on the map is drawn in it.
 */
export function hcaKey(table: PalTable): HcaKeyItem[] {
  const { entries } = table;
  if (entries.length === 0) return [];
  const lo = entries[0].v;
  const hi = entries[entries.length - 1].v;
  const out: HcaKeyItem[] = [];
  for (const [k, label] of Object.entries(HCA_CLASSES)) {
    const code = Number(k);
    if (code < lo || code > hi) continue;
    const c = colorAt(table, code);
    if (c.a === 0) continue;
    out.push({ code, label, short: HCA_CODES[code] ?? String(code), color: `rgba(${c.r},${c.g},${c.b},${(c.a / 255).toFixed(3)})` });
  }
  return out;
}
