/**
 * Radar cross-sections: the backend's /api/nexrad/xsect (backend/radar_xsect.py),
 * a vertical slice A to B through a Level II volume.
 */
import { BACKEND_BASE } from "./apiConfig";
import { velocityParams } from "./radarOptions";

/** The Level II moments a section can show, by family code. */
export const XSECT_MOMENTS: { fam: string; short: string; label: string }[] = [
  { fam: "B", short: "REF", label: "Reflectivity" },
  { fam: "G", short: "VEL", label: "Velocity" },
  { fam: "S", short: "SRV", label: "Storm-relative velocity" },
  { fam: "C", short: "CC", label: "Correlation coefficient" },
  { fam: "X", short: "ZDR", label: "Differential reflectivity" },
  { fam: "W", short: "SW", label: "Spectrum width" },
  { fam: "P", short: "PHI", label: "Differential phase" },
];

export interface XsectMeta {
  site: string;
  siteLat: number;
  siteLon: number;
  radarHeightKm: number;
  groundKm: number;
  product: string;
  productLabel: string;
  units: string;
  kind: string;
  family: string;
  vmin: number;
  vmax: number;
  rows: number;
  cols: number;
  topKm: number;
  lengthKm: number;
  /** [lat, lon] */
  a: [number, number];
  b: [number, number];
  /** Distance from the radar under each column, km. */
  rangeKm: number[];
  /** The volume's cuts, degrees, low to high. */
  elevations: number[];
  key: string;
  scanUnix: number;
  vcp: number | null;
  /** Code -> value; code 0 is no data. */
  lut: (number | null)[];
  ms: number;
}

export interface XsectData {
  meta: XsectMeta;
  /** rows x cols, top row first. */
  codes: Uint8Array;
}

export async function fetchXsect(
  opts: {
    site: string;
    /** [lng, lat] */
    a: [number, number];
    b: [number, number];
    fam: string;
    at: number | null;
    key: string;
    topKm: number;
  },
  signal?: AbortSignal,
): Promise<XsectData> {
  const q = new URLSearchParams({
    site: opts.site,
    a: `${opts.a[1].toFixed(4)},${opts.a[0].toFixed(4)}`,
    b: `${opts.b[1].toFixed(4)},${opts.b[0].toFixed(4)}`,
    fam: opts.fam,
    top: String(opts.topKm),
  });
  if (opts.at != null) q.set("at", String(Math.round(opts.at)));
  if (opts.key) q.set("key", opts.key);
  // Velocity and SRV unfolded, and SRV's storm motion, as the map draws them.
  for (const [k, v] of Object.entries(velocityParams(opts.site, opts.fam))) q.set(k, v);
  const res = await fetch(`${BACKEND_BASE}/api/nexrad/xsect?${q}`, { signal });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* not JSON */
    }
    throw new Error(detail);
  }
  const buf = await res.arrayBuffer();
  const n = new DataView(buf).getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n))) as XsectMeta;
  return { meta, codes: new Uint8Array(buf, 4 + n) };
}

/** Height of a beam's centre (km above sea level) at ground distance s from the
 *  radar: the 4/3-earth model the backend samples with. */
export function beamHeightKm(sKm: number, elevDeg: number, radarKm: number): number {
  const re = (6371 * 4) / 3;
  const phi = sKm / re;
  const e = (elevDeg * Math.PI) / 180;
  // Along the beam from radius re + radarKm at angle e, to the vertical at phi.
  const ra = re + radarKm;
  const r = (ra * Math.sin(phi)) / Math.cos(e + phi);
  return Math.sqrt(r * r + ra * ra + 2 * r * ra * Math.sin(e)) - re;
}
