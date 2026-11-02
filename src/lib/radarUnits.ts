/**
 * Display units for radar products.
 *
 * Conversion happens at the moment a number is printed, never to the data.
 * The colours come from a palette whose stops are in the product's own unit,
 * and the backend maps value to colour before the mesh ever reaches the
 * browser -- so a unit is a way of reading the scan, not a way of changing it.
 * Switching to mph relabels the colour bar and the readout; the picture under
 * them stays exactly the same, which is the point.
 */

export interface UnitOption {
  id: string;
  /** What the colour bar and readout print. */
  label: string;
  /** Native -> this. Every one of these is a plain scale factor, which is what
   *  lets the colour bar tick at round numbers in the chosen unit and still
   *  place each tick by converting back. */
  factor: number;
  decimals: number;
  /** Suggested spacing for a colour-bar tick, in this unit. */
  step: number;
}

export const toDisplay = (u: UnitOption, native: number) => native * u.factor;
export const toNative = (u: UnitOption, display: number) => display / u.factor;

const KT_TO_MPH = 1.150779448;
const KT_TO_MS = 0.5144444444;
const KT_TO_KMH = 1.852;
const KFT_TO_KM = 0.3048;
const IN_TO_MM = 25.4;

const speed: UnitOption[] = [
  { id: "mph", label: "mph", factor: KT_TO_MPH, decimals: 0, step: 20 },
  { id: "kt", label: "kt", factor: 1, decimals: 0, step: 20 },
  { id: "ms", label: "m/s", factor: KT_TO_MS, decimals: 0, step: 10 },
  { id: "kmh", label: "km/h", factor: KT_TO_KMH, decimals: 0, step: 40 },
];

/** Only the kinds with a real choice. Anything absent has one sensible unit
 *  and no menu -- dBZ is dBZ, and offering to "convert" it would be noise. */
export const UNITS_BY_KIND: Record<string, UnitOption[]> = {
  vel: speed,
  srv: speed,
  sw: speed,
  tops: [
    { id: "kft", label: "kft", factor: 1, decimals: 0, step: 10 },
    { id: "km", label: "km", factor: KFT_TO_KM, decimals: 1, step: 3 },
  ],
  precip: [
    { id: "in", label: "in", factor: 1, decimals: 2, step: 1 },
    { id: "mm", label: "mm", factor: IN_TO_MM, decimals: 1, step: 25 },
  ],
  storm_precip: [
    { id: "in", label: "in", factor: 1, decimals: 2, step: 1 },
    { id: "mm", label: "mm", factor: IN_TO_MM, decimals: 1, step: 25 },
  ],
  // The Brazilian radars' hail size and rain rate arrive in millimetres.
  mehs: [
    { id: "mm", label: "mm", factor: 1, decimals: 0, step: 10 },
    { id: "in", label: "in", factor: 1 / IN_TO_MM, decimals: 2, step: 0.5 },
    { id: "cm", label: "cm", factor: 0.1, decimals: 1, step: 1 },
  ],
  rate: [
    { id: "mmh", label: "mm/h", factor: 1, decimals: 1, step: 25 },
    { id: "inh", label: "in/h", factor: 1 / IN_TO_MM, decimals: 2, step: 1 },
  ],
};

/** What a kind shows until somebody chooses otherwise. */
export const DEFAULT_UNIT: Record<string, string> = {
  vel: "mph",
  srv: "mph",
  sw: "mph",
  tops: "kft",
  precip: "in",
  storm_precip: "in",
  mehs: "mm",
  rate: "mmh",
};

/** Products that have something to choose, in the order the settings list
 *  them. Labels match what the product picker calls them. */
export const UNIT_CHOICES: { kind: string; label: string }[] = [
  { kind: "vel", label: "Velocity" },
  { kind: "srv", label: "Storm relative velocity" },
  { kind: "sw", label: "Spectrum width" },
  { kind: "tops", label: "Echo tops" },
  { kind: "precip", label: "One hour precip" },
  { kind: "storm_precip", label: "Storm total precip" },
  { kind: "mehs", label: "Hail size (MEHS)" },
  { kind: "rate", label: "Rain rate" },
];

export function unitFor(kind: string | undefined, chosen: Record<string, string>): UnitOption | null {
  if (!kind) return null;
  const options = UNITS_BY_KIND[kind];
  if (!options) return null;
  const id = chosen[kind] ?? DEFAULT_UNIT[kind] ?? options[0].id;
  return options.find((o) => o.id === id) ?? options[0];
}

/**
 * A value and its unit, ready to print.
 *
 * `nativeUnits` is what the backend called it; it is used unchanged for every
 * product with no choice to make, so adding a product needs no entry here.
 */
export function formatValue(
  value: number,
  kind: string | undefined,
  nativeUnits: string,
  chosen: Record<string, string>,
  fallbackDecimals: number,
): string {
  const unit = unitFor(kind, chosen);
  if (!unit) {
    return `${value.toFixed(fallbackDecimals)}${nativeUnits ? ` ${nativeUnits}` : ""}`;
  }
  return `${toDisplay(unit, value).toFixed(unit.decimals)} ${unit.label}`;
}

/** Round tick values in the chosen unit, and where each one sits in the
 *  product's own unit so the colour bar can place it. */
export function unitTicks(unit: UnitOption, vminNative: number, vmaxNative: number) {
  const lo = toDisplay(unit, vminNative);
  const hi = toDisplay(unit, vmaxNative);
  const step = unit.step > 0 ? unit.step : 1;
  const first = Math.ceil(Math.min(lo, hi) / step) * step;
  const out: { label: string; native: number }[] = [];
  for (let v = first; v <= Math.max(lo, hi) + 1e-9; v += step) {
    // -0 prints as "-0"; it is the same tick as 0 and reads like a mistake.
    const clean = Object.is(v, -0) ? 0 : v;
    out.push({ label: clean.toFixed(unit.decimals), native: toNative(unit, clean) });
  }
  return out;
}
