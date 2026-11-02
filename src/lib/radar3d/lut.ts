/**
 * The "Radar" style's colours: the app's palette for the moment, by voxel
 * code, with an opacity curve over the values. The curve is a preset (how
 * interesting each value is: strong reflectivity, fast inbound/outbound, low
 * CC...) or the viewer's own points, [value in the moment's units, opacity].
 * The table is 256 x 2 RGBA, indexed by code: row 0 = palette x curve (the
 * volume), row 1 = the palette as it is (the cut face and the colour bar).
 */
import { lookup, type PalLut } from "../pal";
import type { Volume3DHeader } from "./volume";

export type OpacityPreset = "soft" | "cores" | "even" | "veil";
/** A preset, the edited curve of this moment ("custom"), or a saved one. */
export type CurveId = OpacityPreset | "custom" | `saved:${string}`;
/** [value in the moment's units, opacity 0-1], values rising. */
export type CurvePoint = [number, number];

export interface SavedCurve {
  name: string;
  /** The moment kind (ref, vel, cc...) whose units the values are in. */
  kind: string;
  points: CurvePoint[];
}

export const OPACITY_PRESETS: { id: OpacityPreset; label: string; hint: string }[] = [
  { id: "soft", label: "Soft", hint: "Weak echo faint, strong echo solid" },
  { id: "cores", label: "Cores", hint: "Only the strongest values" },
  { id: "even", label: "Even", hint: "Opacity rises evenly with the value" },
  { id: "veil", label: "Faint", hint: "Everything translucent" },
];

export const PRESET_IDS = OPACITY_PRESETS.map((o) => o.id) as string[];

/** The file format of an exported curve. */
export const CURVE_FORMAT = "weatherts-3d-opacity";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** 0 (dull) to 1 (what the eye should land on) for a value of this moment. */
function interest(h: Pick<Volume3DHeader, "kind" | "vmin" | "vmax">, v: number): number {
  const amax = Math.max(Math.abs(h.vmin), Math.abs(h.vmax)) || 1;
  switch (h.kind) {
    case "ref":
      return clamp01((v - 5) / 65);
    case "vel":
    case "srv":
      return clamp01(Math.abs(v) / (0.6 * amax));
    case "sw":
      return clamp01((v - 1) / (0.6 * (h.vmax || 1)));
    case "cc":
      return 0.3 + 0.7 * clamp01((0.97 - v) / 0.5);
    case "zdr":
      return clamp01(Math.abs(v) / 4);
    case "kdp":
      return clamp01(v / 3);
    default:
      return 0.5;
  }
}

function presetCurve(p: OpacityPreset, t: number): number {
  switch (p) {
    case "cores":
      return t <= 0.45 ? 0 : t >= 0.85 ? 1 : ((t - 0.45) / 0.4) ** 2 * (3 - 2 * ((t - 0.45) / 0.4));
    case "even":
      return 0.04 + 0.96 * t;
    case "veil":
      return 0.22 + 0.18 * t;
    case "soft":
    default:
      return t <= 0 ? 0.008 : 0.02 + 0.98 * t * t;
  }
}

export function isPreset(id: string): id is OpacityPreset {
  return PRESET_IDS.includes(id);
}

/** A preset as editable points over the moment's range: 11 evenly spaced
 *  values (velocity gets its zero). */
export function presetPoints(h: Pick<Volume3DHeader, "kind" | "vmin" | "vmax">, p: OpacityPreset): CurvePoint[] {
  const out: CurvePoint[] = [];
  const n = 10;
  for (let i = 0; i <= n; i++) {
    const v = h.vmin + ((h.vmax - h.vmin) * i) / n;
    out.push([round(v), round(presetCurve(p, interest(h, v)))]);
  }
  if ((h.kind === "vel" || h.kind === "srv") && h.vmin < 0 && h.vmax > 0 && !out.some(([v]) => v === 0)) {
    out.push([0, round(presetCurve(p, 0))]);
    out.sort((a, b) => a[0] - b[0]);
  }
  return out;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** The curve's opacity at a value: straight lines between the points, flat
 *  past the ends. */
export function curveAt(pts: CurvePoint[], v: number): number {
  if (!pts.length) return 1;
  if (v <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    if (v <= x1) {
      const [x0, y0] = pts[i - 1];
      const t = x1 > x0 ? (v - x0) / (x1 - x0) : 1;
      return y0 + (y1 - y0) * t;
    }
  }
  return pts[pts.length - 1][1];
}

/** Clean points from anywhere (an import, a drag): finite, inside 0-1
 *  opacity, sorted by value, 2-32 of them; null when unusable. */
export function cleanPoints(raw: unknown): CurvePoint[] | null {
  if (!Array.isArray(raw)) return null;
  const pts: CurvePoint[] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const v = Number(p[0]);
    const a = Number(p[1]);
    if (!Number.isFinite(v) || !Number.isFinite(a)) continue;
    pts.push([v, clamp01(a)]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  if (pts.length < 2 || pts.length > 32) return null;
  return pts;
}

export function buildLut3D(h: Volume3DHeader, pal: PalLut | null, curve: OpacityPreset | CurvePoint[]): Uint8Array {
  const out = new Uint8Array(256 * 2 * 4);
  const px = new Uint8Array(4);
  for (let c = 1; c <= 254; c++) {
    const v = h.lut[c];
    if (v == null) continue;
    if (pal) lookup(pal, v, px);
    else {
      const g = Math.round(40 + (c / 254) * 215);
      px[0] = px[1] = px[2] = g;
      px[3] = 255;
    }
    const k = typeof curve === "string" ? presetCurve(curve, interest(h, v)) : curveAt(curve, v);
    const o = c * 4;
    out[o] = px[0];
    out[o + 1] = px[1];
    out[o + 2] = px[2];
    out[o + 3] = Math.round(px[3] * clamp01(k));
    const o2 = (256 + c) * 4;
    out[o2] = px[0];
    out[o2 + 1] = px[1];
    out[o2 + 2] = px[2];
    out[o2 + 3] = px[3];
  }
  return out;
}
