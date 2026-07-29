// Client for the GOES GLM lightning endpoint. The Python backend lists and
// decodes the 20-second flash granules off open S3 (see backend/lightning_core.py).

import { BACKEND_BASE as BASE } from "./apiConfig";

export type LightningSat = "east" | "west" | "both";

export interface FlashProps {
  /** Unix seconds of the flash — the layer grades colour by age off this. */
  t: number;
  /** Flash energy in femtojoules. GLM values are ~1e-13 J, so J reads as zero. */
  fJ: number;
  sat: "east" | "west";
}

export interface LightningField {
  source: string;
  satellites: string[];
  minutes: number;
  count: number;
  perMinute: number;
  /** Flashes per minute across the window, oldest bucket first. */
  rateSeries: number[];
  newestUnix: number | null;
  granules: number;
  geojson: GeoJSON.FeatureCollection<GeoJSON.Point, FlashProps>;
}

async function detail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.detail === "string") return body.detail;
  } catch {
    /* fall through to the status code */
  }
  return `HTTP ${res.status}`;
}

export async function fetchLightning(
  opts: { minutes: number; sat: LightningSat },
  signal?: AbortSignal,
): Promise<LightningField> {
  const q = new URLSearchParams({ minutes: String(opts.minutes), sat: opts.sat });
  const res = await fetch(`${BASE}/api/lightning?${q}`, { signal });
  if (!res.ok) throw new Error(await detail(res));
  return res.json();
}

/** "42 s", "6 min" — how far behind real time the newest flash is. */
export function lagLabel(newestUnix: number | null): string {
  if (!newestUnix) return "—";
  const s = Math.max(0, Math.round(Date.now() / 1000 - newestUnix));
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}
