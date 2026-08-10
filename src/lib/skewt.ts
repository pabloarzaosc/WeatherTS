/**
 * Skew-T / log-p and hodograph maths for the interactive sounding plot.
 *
 * The backend already ships the whole level-by-level profile with every
 * sounding (see /api/sounding -> `levels`), so the interactive plot is drawn
 * entirely client-side: no extra request, and it stays responsive while the
 * SHARPpy PNG for the next hour is still rendering.
 *
 * The thermodynamics here deliberately mirror SHARPpy's (Wobus wetlift), so a
 * moist adiabat drawn in the browser lands on the same curve as the parcel
 * trace the backend computed.
 */

export const ROCP = 0.28571426; // Rd / Cp
export const ZEROCNK = 273.15;

// ---------------------------------------------------------------------------
// Plot geometry
// ---------------------------------------------------------------------------

export interface SkewTGeom {
  /** Plot box in SVG user units. */
  w: number;
  h: number;
  /** Pressure range, bottom -> top (hPa). */
  pBot: number;
  pTop: number;
  /** Temperature range at the BOTTOM of the plot (C). */
  tMin: number;
  tMax: number;
  /** How far one full plot height shifts an isotherm to the right, in px. */
  skew: number;
}

export const DEFAULT_GEOM: SkewTGeom = {
  w: 560,
  // Near-square: the viewer is a 512x512 window, so the whole SVG (plot +
  // barb gutter + three strips) has to come out at roughly 4:3, not portrait,
  // or `preserveAspectRatio` letterboxes it with dead space down both sides.
  h: 560,
  pBot: 1050,
  pTop: 100,
  tMin: -42,
  tMax: 46,
  skew: 0.92,
};

/** Pressure (hPa) -> y in plot units (0 = top). */
export function yOfP(g: SkewTGeom, p: number): number {
  const lo = Math.log(g.pTop);
  const hi = Math.log(g.pBot);
  return (g.h * (Math.log(p) - lo)) / (hi - lo);
}

/** y -> pressure (hPa). */
export function pOfY(g: SkewTGeom, y: number): number {
  const lo = Math.log(g.pTop);
  const hi = Math.log(g.pBot);
  return Math.exp(lo + (y / g.h) * (hi - lo));
}

/** Temperature (C) at the plot's bottom edge -> x, before the skew shift. */
function xOfT0(g: SkewTGeom, t: number): number {
  return ((t - g.tMin) / (g.tMax - g.tMin)) * g.w;
}

/** (T, p) -> x in plot units. Isotherms lean right as they rise: that is the skew. */
export function xOfTP(g: SkewTGeom, t: number, p: number): number {
  return xOfT0(g, t) + g.skew * (g.h - yOfP(g, p));
}

/** Inverse of xOfTP for a point already on the plot. */
export function tOfXY(g: SkewTGeom, x: number, y: number): number {
  const x0 = x - g.skew * (g.h - y);
  return g.tMin + (x0 / g.w) * (g.tMax - g.tMin);
}

// ---------------------------------------------------------------------------
// Thermodynamics (SHARPpy-compatible)
// ---------------------------------------------------------------------------

/** Potential temperature (C) of a parcel at (p, t) referenced to p2. */
export function theta(p: number, t: number, p2 = 1000): number {
  return (t + ZEROCNK) * Math.pow(p2 / p, ROCP) - ZEROCNK;
}

/** Temperature (C) a dry parcel from (p, t) reaches at p2. */
export function dryLift(p: number, t: number, p2: number): number {
  return theta(p, t, 1000) === 0 ? t : (t + ZEROCNK) * Math.pow(p2 / p, ROCP) - ZEROCNK;
}

/** Wobus' correction function — the empirical core of the moist adiabat. */
export function wobf(tC: number): number {
  const t = tC - 20;
  if (t <= 0) {
    let npol =
      1 +
      t *
        (-8.8416605e-3 +
          t * (1.4714143e-4 + t * (-9.671989e-7 + t * (-3.2607217e-8 + t * -3.8598073e-10))));
    npol = 15.13 / Math.pow(npol, 4);
    return npol;
  }
  let ppol =
    t * (4.9618922e-7 + t * (-6.1059365e-9 + t * (3.9401551e-11 + t * (-1.2588129e-13 + t * 1.668828e-16))));
  ppol = 1 + t * (3.6182989e-3 + t * (-1.3603273e-5 + ppol));
  return 29.93 / Math.pow(ppol, 4) + 0.96 * t - 14.8;
}

/** Temperature (C) on the moist adiabat `thetam` at pressure p. */
export function satlift(p: number, thetam: number): number {
  if (Math.abs(p - 1000) - 0.001 <= 0) return thetam;
  let eor = 999;
  let t1 = 0;
  let t2 = 0;
  let e1 = 0;
  let e2 = 0;
  let rate = 1;
  const pwrp = Math.pow(p / 1000, ROCP);
  let guard = 0;
  while (Math.abs(eor) - 0.1 > 0 && guard++ < 50) {
    if (eor === 999) {
      t1 = (thetam + ZEROCNK) * pwrp - ZEROCNK;
      e1 = wobf(t1) - wobf(thetam);
      rate = 1;
    } else {
      rate = (t2 - t1) / (e2 - e1);
      t1 = t2;
      e1 = e2;
    }
    t2 = t1 - e1 * rate;
    e2 = (t2 + ZEROCNK) / pwrp - ZEROCNK;
    e2 += wobf(t2) - wobf(e2) - thetam;
    eor = e2 * rate;
  }
  return t2 - eor;
}

/** Lift a saturated parcel from (p, t) to p2. Mirrors SHARPpy's wetlift. */
export function wetlift(p: number, t: number, p2: number): number {
  const thta = theta(p, t, 1000);
  const thetam = thta - wobf(thta) + wobf(t);
  return satlift(p2, thetam);
}

/** Saturation vapour pressure (hPa) over water — Bolton 1980. */
export function esat(tC: number): number {
  return 6.112 * Math.exp((17.67 * tC) / (tC + 243.5));
}

/** Mixing ratio (g/kg) at (p, t). */
export function mixRatio(p: number, tC: number): number {
  const e = esat(tC);
  return (621.97 * e) / Math.max(p - e, 1e-6);
}

/** Temperature (C) whose saturation mixing ratio at p equals w (g/kg). */
export function tempAtMixRatio(p: number, w: number): number {
  const e = (w * p) / (621.97 + w);
  const l = Math.log(Math.max(e, 1e-9) / 6.112);
  return (243.5 * l) / (17.67 - l);
}

/**
 * Equivalent potential temperature (C) — Bolton (1980) eqs. 38-39, the same
 * formulation SHARPpy uses, so the theta-E inset agrees with its numbers.
 */
export function thetaE(p: number, t: number, td: number): number {
  const [, lclT] = lclOf(p, t, td);
  const tk = t + ZEROCNK;
  const tlk = lclT + ZEROCNK;
  const w = mixRatio(p, td); // g/kg
  const th = tk * Math.pow(1000 / p, 0.2854 * (1 - 0.28e-3 * w));
  return th * Math.exp((3.376 / tlk - 0.00254) * w * (1 + 0.81e-3 * w)) - ZEROCNK;
}

/** Wet-bulb temperature (C) at (p, t, td), via the LCL then a moist descent. */
export function wetbulb(p: number, t: number, td: number): number {
  const [lclP, lclT] = lclOf(p, t, td);
  return wetlift(lclP, lclT, p);
}

/** LCL of a parcel at (p, t, td) as [pressure hPa, temperature C]. */
export function lclOf(p: number, t: number, td: number): [number, number] {
  // Bolton (1980) eq. 15 for the LCL temperature, then dry-adiabatic pressure.
  const tk = t + ZEROCNK;
  const tdk = td + ZEROCNK;
  const tl = 1 / (1 / (tdk - 56) + Math.log(tk / tdk) / 800) + 56;
  const pl = p * Math.pow(tl / tk, 1 / ROCP);
  return [pl, tl - ZEROCNK];
}

// ---------------------------------------------------------------------------
// Background line families
// ---------------------------------------------------------------------------

export interface PlotLine {
  /** SVG path `d`. */
  d: string;
  /** The line's defining value (isotherm C, adiabat theta, mixing ratio g/kg). */
  value: number;
  /** Label anchor, if the line should carry one. */
  label?: { x: number; y: number; text: string };
}

/** Log-spaced pressure samples from bottom to top, for curved families. */
function pSamples(g: SkewTGeom, n = 34): number[] {
  const out: number[] = [];
  const lo = Math.log(g.pTop);
  const hi = Math.log(g.pBot);
  for (let i = 0; i <= n; i++) out.push(Math.exp(hi + ((lo - hi) * i) / n));
  return out;
}

function pathFrom(pts: Array<[number, number]>): string {
  return pts.map((pt, i) => `${i === 0 ? "M" : "L"}${pt[0].toFixed(2)} ${pt[1].toFixed(2)}`).join("");
}

/** Straight, skewed isotherms every `step` degrees. */
export function isotherms(g: SkewTGeom, step = 10): PlotLine[] {
  const out: PlotLine[] = [];
  // Reach well past the box on the cold side: skew drags those lines into view
  // near the top even though their surface value sits far left of the frame.
  for (let t = -140; t <= 60; t += step) {
    const a: [number, number] = [xOfTP(g, t, g.pBot), yOfP(g, g.pBot)];
    const b: [number, number] = [xOfTP(g, t, g.pTop), yOfP(g, g.pTop)];
    if (Math.max(a[0], b[0]) < -10 || Math.min(a[0], b[0]) > g.w + 10) continue;
    out.push({ d: pathFrom([a, b]), value: t });
  }
  return out;
}

/** Dry adiabats (constant potential temperature). */
export function dryAdiabats(g: SkewTGeom, step = 10): PlotLine[] {
  const ps = pSamples(g);
  const out: PlotLine[] = [];
  for (let th = -30; th <= 200; th += step) {
    const pts: Array<[number, number]> = [];
    for (const p of ps) {
      const t = (th + ZEROCNK) * Math.pow(p / 1000, ROCP) - ZEROCNK;
      pts.push([xOfTP(g, t, p), yOfP(g, p)]);
    }
    if (pts.every((q) => q[0] < -20) || pts.every((q) => q[0] > g.w + 20)) continue;
    out.push({ d: pathFrom(pts), value: th });
  }
  return out;
}

/** Moist (pseudo-)adiabats. */
export function moistAdiabats(g: SkewTGeom, step = 5): PlotLine[] {
  const ps = pSamples(g, 26);
  const out: PlotLine[] = [];
  for (let tw = -20; tw <= 40; tw += step) {
    const pts: Array<[number, number]> = [];
    for (const p of ps) {
      const t = wetlift(1000, tw, p);
      if (!Number.isFinite(t)) continue;
      pts.push([xOfTP(g, t, p), yOfP(g, p)]);
    }
    if (pts.length < 2) continue;
    if (pts.every((q) => q[0] < -20) || pts.every((q) => q[0] > g.w + 20)) continue;
    out.push({ d: pathFrom(pts), value: tw });
  }
  return out;
}

/** Saturation mixing-ratio lines (g/kg), drawn only in the lower troposphere. */
export function mixingRatioLines(
  g: SkewTGeom,
  values = [0.4, 1, 2, 3, 5, 8, 12, 16, 20],
): PlotLine[] {
  const pStop = 600;
  const out: PlotLine[] = [];
  for (const w of values) {
    const pts: Array<[number, number]> = [];
    for (let p = g.pBot; p >= pStop; p -= 25) {
      const t = tempAtMixRatio(p, w);
      pts.push([xOfTP(g, t, p), yOfP(g, p)]);
    }
    if (pts.length < 2) continue;
    const last = pts[pts.length - 1];
    out.push({
      d: pathFrom(pts),
      value: w,
      label: { x: last[0], y: last[1], text: String(w) },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Winds
// ---------------------------------------------------------------------------

/** Meteorological (dir, speed) -> u/v components (same units as speed). */
export function uvOf(dirDeg: number, spd: number): [number, number] {
  const r = (dirDeg * Math.PI) / 180;
  return [-spd * Math.sin(r), -spd * Math.cos(r)];
}

/** u/v -> (dir, speed). */
export function dirSpdOf(u: number, v: number): [number, number] {
  const spd = Math.hypot(u, v);
  const dir = (270 - (Math.atan2(v, u) * 180) / Math.PI) % 360;
  return [(dir + 360) % 360, spd];
}

export interface BarbGeom {
  /** Shaft plus every flag/barb, as one path. */
  d: string;
  /** True when the barb is a calm circle instead of a shaft. */
  calm: boolean;
}

/**
 * A station-model wind barb centred on (0,0), drawn straight up in a local
 * frame. Direction is the CALLER's job: it wraps this in a rotate() by the wind
 * direction, which is also what makes the same path reusable on the skew-T and
 * on the VWP time-height display. Length is in plot units.
 */
export function windBarb(spdKt: number, len = 34): BarbGeom {
  if (spdKt < 2.5) return { d: "M-3.5 0a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0", calm: true };

  const parts: string[] = [`M0 0L0 ${-len}`];
  // Barbs hang off the tail (the far end of the shaft) and march back toward 0.
  let y = -len;
  const step = 5.2;
  const flagW = 11;
  const fullW = 11;
  const halfW = 5.5;

  let rem = Math.round(spdKt / 5) * 5;
  let first = true;
  while (rem >= 50) {
    parts.push(`M0 ${y}L${flagW} ${y + step * 0.9}L0 ${y + step * 1.8}Z`);
    y += step * 1.9;
    rem -= 50;
    first = false;
  }
  while (rem >= 10) {
    parts.push(`M0 ${y}L${fullW} ${y - step * 0.35}`);
    y += step;
    rem -= 10;
    first = false;
  }
  if (rem >= 5) {
    // A lone half-barb sits one notch in from the tail, never on the very end.
    if (first) y += step;
    parts.push(`M0 ${y}L${halfW} ${y - step * 0.2}`);
  }
  return { d: parts.join(" "), calm: false };
}

// ---------------------------------------------------------------------------
// Hodograph
// ---------------------------------------------------------------------------

export interface HodoGeom {
  size: number; // square side, plot units
  maxKt: number; // radius of the outermost ring
}

export function hodoX(hg: HodoGeom, u: number): number {
  return hg.size / 2 + (u / hg.maxKt) * (hg.size / 2);
}
export function hodoY(hg: HodoGeom, v: number): number {
  return hg.size / 2 - (v / hg.maxKt) * (hg.size / 2);
}

/** Height bands the hodograph trace is coloured by (m AGL). */
export const HODO_BANDS: Array<{ maxM: number; color: string; label: string }> = [
  { maxM: 3000, color: "#e2554f", label: "0-3 km" },
  { maxM: 6000, color: "#4ea1e8", label: "3-6 km" },
  { maxM: 9000, color: "#3fb07a", label: "6-9 km" },
  { maxM: Infinity, color: "#c9a227", label: "9+ km" },
];

export function hodoBandColor(agl: number): string {
  for (const b of HODO_BANDS) if (agl <= b.maxM) return b.color;
  return HODO_BANDS[HODO_BANDS.length - 1].color;
}

// ---------------------------------------------------------------------------
// Profile helpers
// ---------------------------------------------------------------------------

export interface Lvl {
  p: number;
  h: number;
  t: number;
  td: number;
  wd: number;
  ws: number;
}

/** Linear-in-log-p interpolation of the profile at a pressure. */
export function interpAtP(levels: Lvl[], p: number): Lvl | null {
  if (levels.length === 0) return null;
  if (p >= levels[0].p) return levels[0];
  if (p <= levels[levels.length - 1].p) return levels[levels.length - 1];
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1];
    const b = levels[i];
    if (p <= a.p && p >= b.p) {
      const f = (Math.log(a.p) - Math.log(p)) / (Math.log(a.p) - Math.log(b.p));
      const mix = (x: number, y: number) => x + (y - x) * f;
      // Winds interpolate through u/v so a 350->010 shift doesn't sweep backwards.
      const [au, av] = uvOf(a.wd, a.ws);
      const [bu, bv] = uvOf(b.wd, b.ws);
      const [wd, ws] = dirSpdOf(mix(au, bu), mix(av, bv));
      return { p, h: mix(a.h, b.h), t: mix(a.t, b.t), td: mix(a.td, b.td), wd, ws };
    }
  }
  return levels[levels.length - 1];
}

/** Thin a profile so barbs/points don't pile up: keep one per ~`gapM` metres. */
export function thinByHeight<T extends { h: number }>(levels: T[], gapM: number): T[] {
  const out: T[] = [];
  let last = -Infinity;
  for (const l of levels) {
    if (l.h - last >= gapM) {
      out.push(l);
      last = l.h;
    }
  }
  if (levels.length && out[out.length - 1] !== levels[levels.length - 1]) {
    out.push(levels[levels.length - 1]);
  }
  return out;
}
