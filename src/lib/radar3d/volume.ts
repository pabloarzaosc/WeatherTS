/**
 * The 3D view's data: GET /api/radar/volume3d (backend/radar_volume3d.py), a
 * voxel box of one moment of a whole radar volume, and its progress endpoint.
 *
 * Body (gzip, inflated by fetch): little-endian
 *   [u32 header length][header JSON][codes u8 nz*ny*nx][flashes f32 x5 each]
 * codes: 0 = seen, no echo; 1..254 = lut[code]; 255 = not seen (cone of silence).
 */
import { BACKEND_BASE } from "../apiConfig";
import { velocityParams } from "../radarOptions";

export interface Volume3DHeader {
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
  defaultPalette: string;
  vmin: number;
  vmax: number;
  lut: (number | null)[];
  nx: number;
  ny: number;
  nz: number;
  halfXKm: number;
  halfYKm: number;
  topKm: number;
  dzKm: number;
  centerLat: number;
  centerLon: number;
  radarXKm: number;
  radarYKm: number;
  bbox: [number, number, number, number];
  elevations: number[];
  topElev: number;
  key: string;
  scanUnix: number;
  vcp: number | null;
  motion: [number, number] | null;
  /** Where SRV's motion came from: track | sti | manual | none. */
  motionSource?: string | null;
  /** How velocity was unfolded: region | vad | off (null for other moments). */
  dealias?: string | null;
  cone: { voxels: number; left: number };
  fill: {
    mode: string;
    status?: "filled" | "failed" | "off";
    site?: string;
    scanUnix?: number;
    km?: number;
    voxels?: number;
    reason?: string;
  };
  glm: {
    available: boolean;
    reason?: string;
    sats?: string[];
    files?: number;
    pending?: number;
    count?: number;
    start?: number;
    end?: number;
  };
  flashCount: number;
  volumeBytes: number;
  ms: number;
}

/** One GOES flash in the box's frame: km east/north of the centre, seconds
 *  after the scan, energy (fJ), and the echo top over it (km, 0 = none). */
export interface Flash3D {
  x: number;
  y: number;
  t: number;
  energy: number;
  top: number;
}

export interface Volume3D {
  header: Volume3DHeader;
  codes: Uint8Array;
  flashes: Flash3D[];
}

export interface Volume3DQuery {
  site: string;
  fam: string;
  at: number | null;
  key: string;
  bbox: [number, number, number, number] | null;
  fill: boolean;
  lightning: boolean;
  part?: "all" | "glm";
  rid: string;
  /** "smooth" (the storm look: edges slope between tilts) or "beams". */
  look?: "smooth" | "beams";
}

export class Volume3DError extends Error {
  /** 422: the box itself is the problem (out of range, too big). */
  box: boolean;
  constructor(message: string, box: boolean) {
    super(message);
    this.box = box;
  }
}

function query(q: Volume3DQuery): URLSearchParams {
  const p = new URLSearchParams({ site: q.site, fam: q.fam, fill: q.fill ? "neighbor" : "none" });
  if (q.key) p.set("key", q.key);
  else if (q.at != null) p.set("at", String(Math.round(q.at)));
  if (q.bbox) p.set("bbox", q.bbox.map((v) => v.toFixed(4)).join(","));
  p.set("lightning", q.lightning ? "true" : "false");
  if (q.part) p.set("part", q.part);
  p.set("look", q.look ?? "smooth");
  if (q.rid) p.set("rid", q.rid);
  // Velocity and SRV unfolded, and SRV's storm motion, as the map draws them.
  for (const [k, v] of Object.entries(velocityParams(q.site, q.fam))) p.set(k, v);
  return p;
}

export async function fetchVolume3D(q: Volume3DQuery, signal?: AbortSignal): Promise<Volume3D> {
  const res = await fetch(`${BACKEND_BASE}/api/radar/volume3d?${query(q)}`, { signal });
  if (!res.ok) {
    let detail = `The radar service answered ${res.status}.`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* not JSON */
    }
    throw new Volume3DError(detail, res.status === 422);
  }
  const buf = await res.arrayBuffer();
  const n = new DataView(buf).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n))) as Volume3DHeader;
  const start = 4 + n;
  const vb = header.volumeBytes ?? header.nx * header.ny * header.nz;
  const codes = new Uint8Array(buf, start, vb);
  // The flashes follow the codes, not necessarily 4-byte aligned: copy them out.
  const fBytes = buf.byteLength - start - vb;
  const count = Math.min(header.flashCount ?? 0, Math.floor(fBytes / 20));
  const fl = new Float32Array(buf.slice(start + vb, start + vb + count * 20));
  const flashes: Flash3D[] = [];
  for (let i = 0; i < count; i++) {
    const o = i * 5;
    flashes.push({ x: fl[o], y: fl[o + 1], t: fl[o + 2], energy: fl[o + 3], top: fl[o + 4] });
  }
  return { header, codes, flashes };
}

export interface Volume3DProgress {
  stage?: string;
  site?: string;
  downloads?: { site: string; done: boolean }[];
  step?: number;
  steps?: number;
  tilts?: number;
  fillSite?: string;
  error?: string;
  elapsedMs?: number;
}

export async function fetchVolume3DProgress(rid: string, signal?: AbortSignal): Promise<Volume3DProgress | null> {
  try {
    const res = await fetch(`${BACKEND_BASE}/api/radar/volume3d/progress?rid=${encodeURIComponent(rid)}`, { signal });
    if (!res.ok) return null;
    return (await res.json()) as Volume3DProgress;
  } catch {
    return null;
  }
}

/** The pill's words for a progress answer, and how far along it is (0-1). */
export function describeProgress(p: Volume3DProgress | null, site: string): { text: string; frac: number } {
  if (!p || !p.stage || p.stage === "waiting") return { text: `Finding the ${site} volume`, frac: 0.03 };
  switch (p.stage) {
    case "find":
      return { text: `Finding the ${p.site ?? site} volume`, frac: 0.06 };
    case "download": {
      const d = p.downloads ?? [];
      const done = d.filter((x) => x.done).length;
      const names = d.map((x) => x.site).join(", ") || p.site || site;
      return { text: `Downloading ${names} · ${done}/${Math.max(1, d.length)}`, frac: 0.1 + 0.5 * (d.length ? done / d.length : 0) };
    }
    case "decode":
      return { text: `Reading the ${p.site ?? site} tilts`, frac: 0.62 };
    case "build": {
      const tilts = p.tilts ? ` from ${p.tilts} tilts` : "";
      const st = p.steps ? ` · ${p.step ?? 0}/${p.steps}` : "";
      return { text: `Building the 3D volume${tilts}${st}`, frac: 0.66 + 0.24 * (p.steps ? (p.step ?? 0) / p.steps : 0) };
    }
    case "fill":
      return { text: `Filling from ${p.fillSite ?? "a neighbouring radar"}`, frac: 0.92 };
    case "lightning":
      return { text: "Reading GOES lightning", frac: 0.96 };
    case "done":
      return { text: "Drawing", frac: 1 };
    default:
      return { text: "Working", frac: 0.5 };
  }
}

/** Moments the 3D view offers, by family letter (NEXRAD and BR- radars). */
export const VOLUME3D_MOMENTS: { fam: string; short: string; label: string }[] = [
  { fam: "B", short: "REF", label: "Reflectivity" },
  { fam: "G", short: "VEL", label: "Velocity" },
  { fam: "C", short: "CC", label: "Correlation coefficient" },
  { fam: "X", short: "ZDR", label: "Differential reflectivity" },
  { fam: "K", short: "KDP", label: "Specific differential phase" },
  { fam: "W", short: "SW", label: "Spectrum width" },
];
