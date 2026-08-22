/**
 * Wind-profile kinematics: shear, helicity and storm motion from a VWP.
 *
 * Everything here needs only wind against height, which is exactly what a VAD
 * profile is. Quantities that need a thermodynamic profile -- EHI needs CAPE,
 * Corfidi's cloud-layer mean is defined on pressure -- are deliberately absent
 * rather than approximated: a VWP cannot know them, and a plausible-looking
 * wrong number is worse than a dash.
 */

export interface VwpLevel {
  altM: number;
  u: number | null;
  v: number | null;
  spdKt: number | null;
  dirDeg: number | null;
}

export interface Vec {
  u: number;
  v: number;
}

export const KT_PER_MS = 1.94384;

/** Levels with usable winds, ascending by height, heights converted to AGL. */
export function cleanProfile(levels: VwpLevel[], siteElevM = 0): { z: number; u: number; v: number }[] {
  return levels
    .filter((l) => l.u != null && l.v != null && Number.isFinite(l.altM))
    .map((l) => ({ z: l.altM - siteElevM, u: l.u as number, v: l.v as number }))
    .filter((l) => l.z >= 0)
    .sort((a, b) => a.z - b.z);
}

/**
 * Wind at a height, linearly interpolated.
 *
 * The two ends are not symmetrical, and that is deliberate. A VAD cannot see
 * the lowest few hundred metres -- the beam is already above them at the
 * closest range it trusts -- so asking for "the surface" is asking for
 * something the radar structurally never has, and using its lowest level is
 * the honest reading of "as low as this profile goes". Above the top is
 * different: the radar simply lost returns there, and stretching the last
 * level up to 6 km would invent shear that was never measured. So the bottom
 * clamps and the top does not.
 */
export function windAt(
  prof: { z: number; u: number; v: number }[],
  z: number,
  clampBottom = true,
): Vec | null {
  if (prof.length < 2) return null;
  if (z < prof[0].z) {
    if (!clampBottom) return null;
    return { u: prof[0].u, v: prof[0].v };
  }
  if (z > prof[prof.length - 1].z) return null;
  for (let i = 1; i < prof.length; i++) {
    if (z <= prof[i].z) {
      const a = prof[i - 1];
      const b = prof[i];
      const span = b.z - a.z;
      const t = span === 0 ? 0 : (z - a.z) / span;
      return { u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t };
    }
  }
  return null;
}

/** Mean wind through a layer, weighted by depth so uneven VAD spacing does not
 *  let a cluster of close levels dominate. */
export function meanWind(
  prof: { z: number; u: number; v: number }[],
  bottom: number,
  top: number,
): Vec | null {
  const lo = windAt(prof, bottom);
  const hi = windAt(prof, top);
  if (!lo || !hi) return null;
  const b = Math.max(bottom, prof[0].z);
  const pts = [{ z: b, ...lo }, ...prof.filter((p) => p.z > b && p.z < top), { z: top, ...hi }];
  let su = 0;
  let sv = 0;
  let sw = 0;
  for (let i = 1; i < pts.length; i++) {
    const dz = pts[i].z - pts[i - 1].z;
    if (dz <= 0) continue;
    su += ((pts[i].u + pts[i - 1].u) / 2) * dz;
    sv += ((pts[i].v + pts[i - 1].v) / 2) * dz;
    sw += dz;
  }
  return sw > 0 ? { u: su / sw, v: sv / sw } : null;
}

/** Bulk shear across a layer: the vector difference of its end winds. */
export function bulkShear(
  prof: { z: number; u: number; v: number }[],
  bottom: number,
  top: number,
): Vec | null {
  const lo = windAt(prof, bottom);
  const hi = windAt(prof, top);
  if (!lo || !hi) return null;
  return { u: hi.u - lo.u, v: hi.v - lo.v };
}

/** Storm-relative helicity through a layer, m²/s². */
export function srh(
  prof: { z: number; u: number; v: number }[],
  bottom: number,
  top: number,
  storm: Vec,
): number | null {
  const lo = windAt(prof, bottom);
  const hi = windAt(prof, top);
  if (!lo || !hi) return null;
  const floor = Math.max(bottom, prof[0].z);
  const pts = [
    { z: floor, ...lo },
    ...prof.filter((p) => p.z > floor && p.z < top),
    { z: top, ...hi },
  ];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const lower = pts[i - 1];
    const upper = pts[i];
    total +=
      (upper.u - storm.u) * (lower.v - storm.v) -
      (lower.u - storm.u) * (upper.v - storm.v);
  }
  return total;
}

/** Mean storm-relative wind through a layer. */
export function srWind(
  prof: { z: number; u: number; v: number }[],
  bottom: number,
  top: number,
  storm: Vec,
): Vec | null {
  const m = meanWind(prof, bottom, top);
  return m ? { u: m.u - storm.u, v: m.v - storm.v } : null;
}

/**
 * Bunkers right and left movers.
 *
 * The 0-6 km mean wind, displaced 7.5 m/s perpendicular to the 0-6 km shear --
 * to its right for the right mover, its left for the left. Units here are m/s
 * because that 7.5 is defined in m/s.
 */
export function bunkers(
  prof: { z: number; u: number; v: number }[],
): { right: Vec; left: Vec; mean: Vec } | null {
  // Bunkers is defined on the 0-6 km layer. A VAD that stops at 3 km cannot
  // produce it, and rescaling the formula to whatever depth happened to be
  // available would give a number that looks like a storm motion and is not.
  if (!prof.length || prof[prof.length - 1].z < 5500) return null;
  const mean = meanWind(prof, 0, 6000);
  const shear = bulkShear(prof, 0, 6000);
  if (!mean || !shear) return null;
  const mag = Math.hypot(shear.u, shear.v);
  if (mag === 0) return { right: mean, left: mean, mean };
  const D = 7.5 * KT_PER_MS; // the profile is in knots, so displace in knots
  const nx = (shear.v / mag) * D;
  const ny = (-shear.u / mag) * D;
  return {
    right: { u: mean.u + nx, v: mean.v + ny },
    left: { u: mean.u - nx, v: mean.v - ny },
    mean,
  };
}

/**
 * Nixon deviant tornado motion: the midpoint of the storm's own motion and the
 * 0-500 m mean wind. A tornado tends to track left of and slower than its
 * parent supercell, and this is the operational shorthand for that.
 */
export function nixonDeviant(
  prof: { z: number; u: number; v: number }[],
  storm: Vec,
): Vec | null {
  const low = meanWind(prof, 0, 500);
  if (!low) return null;
  return { u: (storm.u + low.u) / 2, v: (storm.v + low.v) / 2 };
}

/** Mean wind over the depth this profile actually covers.
 *
 *  The fallback storm motion when the VAD is too shallow for Bunkers: it is a
 *  real measurement of a real layer, and the caller says which layer that was
 *  rather than passing it off as 0-6 km. */
export function meanOverProfile(
  prof: { z: number; u: number; v: number }[],
): { vec: Vec; bottom: number; top: number } | null {
  if (prof.length < 2) return null;
  const bottom = prof[0].z;
  const top = prof[prof.length - 1].z;
  const vec = meanWind(prof, bottom, top);
  return vec ? { vec, bottom, top } : null;
}

/** Meteorological direction (degrees the wind comes FROM) and speed. */
export function toDirSpd(v: Vec | null): { dir: number; spd: number } | null {
  if (!v) return null;
  const spd = Math.hypot(v.u, v.v);
  let dir = (Math.atan2(-v.u, -v.v) * 180) / Math.PI;
  if (dir < 0) dir += 360;
  return { dir, spd };
}

export function fromDirSpd(dirDeg: number, spdKt: number): Vec {
  const r = (dirDeg * Math.PI) / 180;
  return { u: -spdKt * Math.sin(r), v: -spdKt * Math.cos(r) };
}

export interface LayerRow {
  label: string;
  bottom: number;
  top: number;
  /** The layer actually measured, when the VAD's floor is above `bottom`. */
  effBottom: number | null;
  shear: { dir: number; spd: number } | null;
  srh: number | null;
  srWind: { dir: number; spd: number } | null;
}

/** The layers an operational hodograph readout carries. */
export const LAYERS: { label: string; bottom: number; top: number }[] = [
  { label: "Sfc-500m", bottom: 0, top: 500 },
  { label: "Sfc-1km", bottom: 0, top: 1000 },
  { label: "Sfc-3km", bottom: 0, top: 3000 },
  { label: "1km-3km", bottom: 1000, top: 3000 },
  { label: "3km-6km", bottom: 3000, top: 6000 },
  { label: "Sfc-6km", bottom: 0, top: 6000 },
  { label: "0km-2km", bottom: 0, top: 2000 },
];

export function layerTable(
  prof: { z: number; u: number; v: number }[],
  storm: Vec,
): LayerRow[] {
  const floor = prof.length ? prof[0].z : 0;
  return LAYERS.map((l) => ({
    ...l,
    effBottom: floor > l.bottom ? floor : null,
    shear: toDirSpd(bulkShear(prof, l.bottom, l.top)),
    srh: srh(prof, l.bottom, l.top, storm),
    srWind: toDirSpd(srWind(prof, l.bottom, l.top, storm)),
  }));
}
