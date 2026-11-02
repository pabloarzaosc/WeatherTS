/**
 * What the radar measured at a point, and what the beam looked like there.
 *
 * Used by the Shift readout and the product info panel. The gate lookup is the
 * same flat-earth inverse the mesh is drawn with (see radarMesh.sampleScan), so
 * the gate this reads is the gate under the pointer on screen.
 */

import { findAzBin, type PolarScan } from "./radarMesh";

const KM_PER_DEG_LAT = 111.32;
const EARTH_KM = 6371;
/** Standard refraction: the four-thirds earth radius. */
const K43 = 4 / 3;
const KT_TO_MS = 0.5144444444;

export type ProbeStatus = "ok" | "rf" | "nodata" | "outside";

export interface Probe {
  status: ProbeStatus;
  /** Physical value in the scan's own unit; null unless status is "ok". */
  value: number | null;
  azimuth: number;
  rangeKm: number;
}

function kmPerDegLon(lat: number): number {
  return KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** The gate under a point: its value, or why there is none. */
export function probeScan(scan: PolarScan, lat: number, lon: number): Probe {
  const { az, lut, codes, meta } = scan;
  const { nAz, nGates, siteLat, siteLon, rangeStartKm, gateWidthKm } = meta;
  const dx = (lon - siteLon) * kmPerDegLon(siteLat);
  const dy = (lat - siteLat) * KM_PER_DEG_LAT;
  const rangeKm = Math.hypot(dx, dy);
  let azimuth = (Math.atan2(dx, dy) * 180) / Math.PI;
  if (azimuth < 0) azimuth += 360;
  const out: Probe = { status: "outside", value: null, azimuth, rangeKm };

  const g = Math.floor((rangeKm - rangeStartKm) / gateWidthKm);
  if (g < 0 || g >= nGates) return out;
  const a = findAzBin(az, nAz, azimuth);
  if (a < 0) return out;
  const code = codes[a * nGates + g];
  const v = lut[code];
  if (Number.isFinite(v)) return { ...out, status: "ok", value: v };
  if (meta.rfCode != null && code === meta.rfCode && code !== 0) return { ...out, status: "rf" };
  return { ...out, status: "nodata" };
}

/**
 * Height of the beam centre above the antenna, in km, on a four-thirds earth.
 * The same 46 dBZ at 1 kft and at 25 kft are different weather.
 */
export function beamHeightKm(rangeKm: number, elevationDeg: number): number {
  const ka = K43 * EARTH_KM;
  const t = (elevationDeg * Math.PI) / 180;
  return Math.sqrt(rangeKm * rangeKm + ka * ka + 2 * rangeKm * ka * Math.sin(t)) - ka;
}

/** How wide the beam is at a range (its half-power width), in km. */
export function beamWidthKm(rangeKm: number, beamDeg: number): number {
  return rangeKm * ((beamDeg * Math.PI) / 180);
}

export interface CoupletEnd {
  /** Velocity in kt (negative = toward the radar). */
  v: number;
  lat: number;
  lon: number;
}

export interface Couplet {
  vin: CoupletEnd | null;
  vout: CoupletEnd | null;
  /** Only when both ends exist. */
  dvKt: number | null;
  diaKm: number | null;
  /** Delta-V over the distance between the two gates, in 10^-3 s^-1. */
  azShear: number | null;
  vrotKt: number | null;
  /** Gates in the circle were unfolded across the Nyquist velocity first. */
  unfolded: boolean;
}

/** Neighbouring gates of one window: radial a, gate g -> window index. */
type GateIndex = Map<number, number>;
const gkey = (a: number, g: number) => a * 65536 + g;
/** Neighbours a gate needs within tolerance to count as echo, not noise. */
const BACKING = 3;

/** Each gate's window indices of its eight neighbours that are in the window. */
function neighbours(a: number[], g: number[], at: GateIndex, nAz: number): number[][] {
  return a.map((ai, i) => {
    const out: number[] = [];
    for (let da = -1; da <= 1; da++) {
      for (let dg = -1; dg <= 1; dg++) {
        if (da === 0 && dg === 0) continue;
        const j = at.get(gkey((ai + da + nAz) % nAz, g[i] + dg));
        if (j !== undefined) out.push(j);
      }
    }
    return out;
  });
}

/**
 * Unfold the gates of a small window across the Nyquist velocity: raw Level II
 * velocity is aliased, and a fold reads as a +-Nyquist "couplet" that is not
 * there, while a real one strong enough to fold loses its ends.
 *
 * Quality-guided unwrapping (after the reliability sorting of Herraez et al.
 * 2002): neighbouring gates are joined smoothest pair first, each join shifting
 * the smaller group by whole Nyquist intervals to continue the larger one. The
 * smooth paths round a vortex join its inbound and outbound sides before the
 * steep pair across its core is ever looked at, so the couplet keeps its
 * strength. Steps of more than 0.6 Nyquist join nothing (noise beside echo
 * looks like a fold either way); each group is then placed nearest its raw
 * median. Gates in `skip` (noise) take no part.
 */
function unfoldWindow(v: number[], nb: number[][], skip: Uint8Array, nyq: number): Float32Array {
  const n = v.length;
  const two = 2 * nyq;
  const wrap = (x: number) => x - two * Math.round(x / two);
  const ei: number[] = [];
  const ej: number[] = [];
  const ed: number[] = [];
  for (let i = 0; i < n; i++) {
    if (skip[i]) continue;
    for (const j of nb[i]) {
      if (j <= i || skip[j]) continue;
      ei.push(i);
      ej.push(j);
      ed.push(wrap(v[j] - v[i]));
    }
  }
  const order = ed.map((_, k) => k).sort((p, q) => Math.abs(ed[p]) - Math.abs(ed[q]));
  const fold = new Int32Array(n);
  const root = new Int32Array(n);
  const members: number[][] = [];
  for (let i = 0; i < n; i++) {
    root[i] = i;
    members.push([i]);
  }
  for (const k of order) {
    // A step near the Nyquist velocity says nothing about the fold: past this
    // the groups stay apart, each placed by its own median.
    if (Math.abs(ed[k]) > 0.6 * nyq) break;
    const i = ei[k];
    const j = ej[k];
    const ri = root[i];
    const rj = root[j];
    if (ri === rj) continue;
    // Shift j's group so that u_j = u_i + d.
    const want = v[i] + two * fold[i] + ed[k];
    const shift = Math.round((want - v[j] - two * fold[j]) / two);
    const [keep, move, s] =
      members[ri].length >= members[rj].length ? [ri, rj, shift] : [rj, ri, -shift];
    for (const m of members[move]) {
      fold[m] += s;
      root[m] = keep;
      members[keep].push(m);
    }
    members[move] = [];
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = v[i] + two * fold[i];
  for (const grp of members) {
    if (grp.length < 2) continue;
    const raw = grp.map((m) => v[m]).sort((p, q) => p - q);
    const unf = grp.map((m) => out[m]).sort((p, q) => p - q);
    const mid = grp.length >> 1;
    const s = Math.round((raw[mid] - unf[mid]) / two);
    if (s !== 0) for (const m of grp) out[m] += two * s;
  }
  // One fold at most, and only the way a fold goes: a gate read near +Nyquist
  // may really be beyond -Nyquist, and the reverse. A gate read near zero, or
  // pushed further out on its own side, is a chain through noise -- kept raw.
  for (let i = 0; i < n; i++) {
    const k = Math.round((out[i] - v[i]) / two);
    if (k !== 0 && (Math.abs(k) > 1 || k * v[i] > 0 || Math.abs(v[i]) < 0.4 * nyq)) out[i] = v[i];
  }
  return out;
}

/**
 * The strongest inbound and outbound gates within `radiusKm` of a point, on a
 * velocity scan (kt). Walks only the radials and gates that can be inside the
 * circle, so it costs a few thousand gates even on a super-res sweep.
 *
 * An end has to be backed by its neighbours -- three of its eight within a
 * fifth of the folding interval -- so a lone noisy gate is never read as half
 * of a couplet. Raw Level II velocity is unfolded across its Nyquist velocity
 * first; Level III comes dealiased by the radar's own processing.
 */
export function findCouplet(scan: PolarScan, lat: number, lon: number, radiusKm = 5): Couplet {
  const { az, lut, codes, meta } = scan;
  const { nAz, nGates, siteLat, siteLon, rangeStartKm, gateWidthKm } = meta;
  const kx = kmPerDegLon(siteLat);
  const px = (lon - siteLon) * kx;
  const py = (lat - siteLat) * KM_PER_DEG_LAT;
  const r0 = Math.hypot(px, py);
  const az0 = (Math.atan2(px, py) * 180) / Math.PI;
  const R2 = radiusKm * radiusKm;

  const g0 = Math.max(0, Math.floor((r0 - radiusKm - rangeStartKm) / gateWidthKm));
  const g1 = Math.min(nGates - 1, Math.ceil((r0 + radiusKm - rangeStartKm) / gateWidthKm));
  // Radials farther round than the circle reaches are skipped outright.
  const halfDeg = r0 > radiusKm ? (Math.asin(radiusKm / r0) * 180) / Math.PI + 1 : 181;

  const vs: number[] = [];
  const as: number[] = [];
  const gs: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const at: GateIndex = new Map();
  for (let a = 0; a < nAz; a++) {
    const lo = az[a];
    let span = az[a + 1] - lo;
    if (span < 0) span += 360;
    const mid = lo + span / 2;
    const d = ((mid - az0) % 360 + 540) % 360 - 180;
    if (Math.abs(d) > halfDeg) continue;
    const t = (mid * Math.PI) / 180;
    const sx = Math.sin(t);
    const sy = Math.cos(t);
    const row = a * nGates;
    for (let g = g0; g <= g1; g++) {
      const v = lut[codes[row + g]];
      if (!Number.isFinite(v)) continue;
      const r = rangeStartKm + (g + 0.5) * gateWidthKm;
      const x = r * sx;
      const y = r * sy;
      const ddx = x - px;
      const ddy = y - py;
      if (ddx * ddx + ddy * ddy > R2) continue;
      at.set(gkey(a, g), vs.length);
      vs.push(v);
      as.push(a);
      gs.push(g);
      xs.push(x);
      ys.push(y);
    }
  }

  const n = vs.length;
  const nb = neighbours(as, gs, at, nAz);
  const nyq = meta.nyquistKt;
  // The map's Level II velocity comes unfolded by the backend (meta.dealias
  // region | vad): read it as drawn, the same field. Only a raw sweep
  // (dealias off) is unfolded here, inside the search window.
  const preUnfolded = meta.dealias === "region" || meta.dealias === "vad";
  const aliased = !preUnfolded && meta.source === "level2" && (meta.kind === "vel" || meta.kind === "srv") && !!nyq;
  // "Backed": two neighbours within a fifth of the folding interval (20 kt
  // when the Nyquist velocity is unknown), measured across a fold if aliased.
  const tol = nyq ? 0.4 * nyq : 20;
  const two = nyq ? 2 * nyq : 0;
  const backed = (val: ArrayLike<number>, i: number, wrapIt: boolean) => {
    let c = 0;
    for (const j of nb[i]) {
      let dv = val[j] - val[i];
      if (wrapIt) dv -= two * Math.round(dv / two);
      if (Math.abs(dv) <= tol && ++c >= BACKING) return true;
    }
    return false;
  };
  const noise = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (!backed(vs, i, aliased)) noise[i] = 1;

  let vals: ArrayLike<number> = vs;
  let unfolded = preUnfolded;
  if (aliased && n > 1) {
    const u = unfoldWindow(vs, nb, noise, nyq as number);
    for (let i = 0; i < n; i++) if (!noise[i] && Math.abs(u[i] - vs[i]) > 1) unfolded = true;
    vals = u;
  }

  let minV = Infinity;
  let maxV = -Infinity;
  let iMin = -1;
  let iMax = -1;
  for (let i = 0; i < n; i++) {
    if (noise[i]) continue;
    const v = vals[i];
    if ((v < minV || v > maxV) && !backed(vals, i, false)) continue;
    if (v < minV) { minV = v; iMin = i; }
    if (v > maxV) { maxV = v; iMax = i; }
  }

  const toLL = (x: number, y: number) => ({ lat: siteLat + y / KM_PER_DEG_LAT, lon: siteLon + x / kx });
  const vin = iMin >= 0 && minV < 0 ? { v: minV, ...toLL(xs[iMin], ys[iMin]) } : null;
  const vout = iMax >= 0 && maxV > 0 ? { v: maxV, ...toLL(xs[iMax], ys[iMax]) } : null;
  if (!vin || !vout) return { vin, vout, dvKt: null, diaKm: null, azShear: null, vrotKt: null, unfolded };
  const dvKt = vout.v - vin.v;
  // Never closer than one gate: two neighbouring gates are a gate apart.
  const diaKm = Math.max(Math.hypot(xs[iMax] - xs[iMin], ys[iMax] - ys[iMin]), gateWidthKm);
  return { vin, vout, dvKt, diaKm, azShear: (dvKt * KT_TO_MS) / diaKm, vrotKt: dvKt / 2, unfolded };
}

/**
 * Conditional odds (%) that a tornado reaches EF1+, EF2+ and EF3+, given the
 * rotational velocity of its parent circulation -- assuming a tornado is on the
 * ground. Approximate values after the published curves of:
 *   Smith, B. T., R. L. Thompson, A. R. Dean, and P. T. Marsh, 2015: Diagnosing
 *     the conditional probability of tornado damage rating using environmental
 *     and radar attributes. Wea. Forecasting, 30, 914-932.
 *   Thompson, R. L., and co-authors, 2017: Tornado damage rating probabilities
 *     derived from WSR-88D data. Wea. Forecasting, 32.
 * Their Vrot is the peak 0.5 deg value of a tornadic circulation in 10 kt
 * bins; this table reads the bin floors and interpolates between them, so it
 * is a rough guide, not a reproduction of either paper's numbers.
 */
const EF_ODDS: [vrot: number, ef1: number, ef2: number, ef3: number][] = [
  [20, 20, 4, 1],
  [30, 35, 9, 2],
  [40, 52, 17, 4],
  [50, 67, 30, 9],
  [60, 79, 44, 16],
  [70, 87, 57, 26],
  [80, 92, 67, 37],
  [90, 95, 75, 47],
  [100, 97, 82, 55],
];

export interface EfOdds {
  ef1: number;
  ef2: number;
  ef3: number;
}

/** EF1+/EF2+/EF3+ odds for a Vrot in kt; null under 20 kt. */
export function efOdds(vrotKt: number): EfOdds | null {
  if (!(vrotKt >= 20)) return null;
  const last = EF_ODDS[EF_ODDS.length - 1];
  if (vrotKt >= last[0]) return { ef1: last[1], ef2: last[2], ef3: last[3] };
  for (let i = 0; i < EF_ODDS.length - 1; i++) {
    const a = EF_ODDS[i];
    const b = EF_ODDS[i + 1];
    if (vrotKt < b[0]) {
      const f = (vrotKt - a[0]) / (b[0] - a[0]);
      const lerp = (j: 1 | 2 | 3) => Math.round(a[j] + (b[j] - a[j]) * f);
      return { ef1: lerp(1), ef2: lerp(2), ef3: lerp(3) };
    }
  }
  return null;
}

/** Distances in the readout's chosen system. */
export type ReadoutDistance = "mi" | "km";

export function fmtRange(km: number, sys: ReadoutDistance): string {
  const v = sys === "km" ? km : km / 1.609344;
  return `${v < 100 ? v.toFixed(1) : v.toFixed(0)} ${sys}`;
}

/** A short length (a beam width, a gate): metres or feet when small. */
export function fmtShort(km: number, sys: ReadoutDistance): string {
  if (sys === "km") return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(2)} km`;
  const ft = km * 3280.84;
  return ft < 1000 ? `${Math.round(ft)} ft` : `${(km / 1.609344).toFixed(2)} mi`;
}

/** A height: feet with miles, metres with kilometres. */
export function fmtHeight(km: number, sys: ReadoutDistance): string {
  const v = sys === "km" ? km * 1000 : km * 3280.84;
  return `${Math.round(v).toLocaleString("en-US")} ${sys === "km" ? "m" : "ft"}`;
}
