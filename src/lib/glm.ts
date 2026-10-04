/**
 * Lightning from the GOES Geostationary Lightning Mappers: the backend's
 * /api/glm/flashes (backend/glm.py), every flash over a trailing window.
 */
import { BACKEND_BASE } from "./apiConfig";

export type GlmSat = "both" | "goes19" | "goes18";

export const GLM_SATS: { id: GlmSat; label: string; title: string }[] = [
  { id: "both", label: "Both", title: "GOES-East east of 106°W, GOES-West west of it" },
  { id: "goes19", label: "East", title: "GOES-19: the Americas, the Atlantic to Africa's coast" },
  { id: "goes18", label: "West", title: "GOES-18: the western US, the Pacific to past Hawaii" },
];

export interface GlmInfo {
  start: number;
  end: number;
  minutes: number;
  sats: string[];
  /** Files in the window, and how many are still downloading. */
  files: number;
  pending: number;
  /** Where NOAA's published files reach (unix s): ~25 s behind real time. */
  latest: number | null;
  count: number;
  live: boolean;
}

export interface GlmData {
  info: GlmInfo;
  /** lon, lat, age (s before the window's end), energy (fJ) per flash, oldest first. */
  values: Float32Array;
  count: number;
}

export async function fetchGlm(
  opts: { sat: GlmSat; minutes: number; end: number | null; bbox: [number, number, number, number] | null },
  signal?: AbortSignal,
): Promise<GlmData> {
  const q = new URLSearchParams({ sat: opts.sat, minutes: String(opts.minutes) });
  if (opts.end != null) q.set("end", String(Math.round(opts.end)));
  if (opts.bbox) q.set("bbox", opts.bbox.map((v) => v.toFixed(2)).join(","));
  const res = await fetch(`${BACKEND_BASE}/api/glm/flashes?${q}`, { signal });
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
  const info = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n))) as GlmInfo;
  // Copied out: the floats start at 4 + n, which need not sit on a 4-byte boundary.
  const values = new Float32Array(buf.slice(4 + n));
  return { info, values, count: values.length / 4 };
}

/** Start the downloads of a loop's whole span (backend/glm.py prefetch). */
export async function prefetchGlm(
  opts: { sat: GlmSat; start: number; end: number; bbox: [number, number, number, number] | null },
): Promise<void> {
  const q = new URLSearchParams({ sat: opts.sat, start: String(Math.floor(opts.start)), end: String(Math.ceil(opts.end)) });
  if (opts.bbox) q.set("bbox", opts.bbox.map((v) => v.toFixed(2)).join(","));
  await fetch(`${BACKEND_BASE}/api/glm/prefetch?${q}`);
}

/** Age bands for the colours, seconds: the map and the panel's key share them. */
export const GLM_AGES: { upTo: number; color: string; label: string }[] = [
  { upTo: 60, color: "#ffffff", label: "1 min" },
  { upTo: 120, color: "#fff04a", label: "2" },
  { upTo: 300, color: "#ffb21f", label: "5" },
  { upTo: 600, color: "#ff5f1f", label: "10" },
  { upTo: 1200, color: "#e0163a", label: "20" },
  { upTo: Infinity, color: "#a3125e", label: "older" },
];
