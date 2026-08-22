import { BACKEND_BASE as BASE } from "./apiConfig";

/** The SHARPpy parameter set the backend already computes for every sounding. */
export interface SoundingParams {
  [key: string]: number | null | undefined;
}

export interface ProfileResult {
  label: string;
  validUnix: number | null;
  source: string | null;
  params: SoundingParams;
  levels: number;
  /** How many observations this station has in the window. */
  axisLength?: number;
}

/** Parameters worth putting side by side. Ordered the way a chaser reads them:
 *  instability, then moisture, then shear, then the composites. */
export const KEY_PARAMS: { key: string; label: string; unit: string; digits?: number }[] = [
  { key: "sbcape", label: "SBCAPE", unit: "J/kg", digits: 0 },
  { key: "mlcape", label: "MLCAPE", unit: "J/kg", digits: 0 },
  { key: "mucape", label: "MUCAPE", unit: "J/kg", digits: 0 },
  { key: "mlcin", label: "MLCIN", unit: "J/kg", digits: 0 },
  { key: "mllcl", label: "MLLCL", unit: "m", digits: 0 },
  { key: "pwat", label: "PWAT", unit: "mm", digits: 1 },
  { key: "lr700_500", label: "LR 700-500", unit: "C/km", digits: 1 },
  { key: "dcape", label: "DCAPE", unit: "J/kg", digits: 0 },
  { key: "srh1km", label: "SRH 1km", unit: "m²/s²", digits: 0 },
  { key: "esrh", label: "ESRH", unit: "m²/s²", digits: 0 },
  { key: "bwd6km", label: "0-6 shear", unit: "kt", digits: 0 },
  { key: "ebwd", label: "EBWD", unit: "kt", digits: 0 },
  { key: "stp_eff", label: "STP (eff)", unit: "", digits: 1 },
  { key: "scp", label: "SCP", unit: "", digits: 1 },
  { key: "ship", label: "SHIP", unit: "", digits: 1 },
];

export function fmtParam(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

function viewless(url: string): string {
  // Parameters only: the SHARPpy render is seconds per profile and nothing
  // here draws the plot, so asking for it would make a four-station compare
  // take half a minute.
  return `${url}&render=false`;
}

/** One observed station's parameters at a synoptic slot (default: newest).
 *
 *  `axis` false skips probing the whole ten-day window for the time axis --
 *  the risk scan wants two dozen stations' current numbers and never steps
 *  through any of them, so paying for their axes would be twenty times the
 *  requests for nothing. */
export async function fetchStationParams(
  station: { id: string; name: string; lat: number; lon: number; wmo?: string },
  hour = 9999,
  signal?: AbortSignal,
  axis = true,
): Promise<ProfileResult> {
  const url = viewless(
    `${BASE}/api/raob?station=${encodeURIComponent(station.id)}` +
      `&name=${encodeURIComponent(station.name)}` +
      (station.wmo ? `&wmo=${encodeURIComponent(station.wmo)}` : "") +
      `&lat=${station.lat.toFixed(4)}&lon=${station.lon.toFixed(4)}&hour=${hour}` +
      (axis ? "" : "&axis=false"),
  );
  const res = await fetch(url, { signal });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      detail = ((await res.json()) as { detail?: string }).detail ?? detail;
    } catch {
      /* keep the status */
    }
    throw new Error(detail);
  }
  const j = (await res.json()) as {
    meta: { modelLabel?: string; validUnix?: number | null; source?: string; times?: number[] };
    params: SoundingParams;
    levels: unknown[];
  };
  return {
    label: j.meta.modelLabel ?? station.name,
    validUnix: j.meta.validUnix ?? null,
    source: j.meta.source ?? null,
    params: j.params ?? {},
    levels: j.levels?.length ?? 0,
    axisLength: j.meta.times?.length ?? 1,
  };
}

/** A model point forecast's parameters. */
export async function fetchPointParams(
  lat: number,
  lon: number,
  model: string,
  hour: number,
  signal?: AbortSignal,
): Promise<ProfileResult> {
  const url = viewless(
    `${BASE}/api/sounding?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}` +
      `&model=${encodeURIComponent(model)}&hour=${hour}`,
  );
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as {
    meta: { modelLabel?: string; validUnix?: number | null };
    params: SoundingParams;
    levels: unknown[];
  };
  return {
    label: j.meta.modelLabel ?? `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
    validUnix: j.meta.validUnix ?? null,
    source: model,
    params: j.params ?? {},
    levels: j.levels?.length ?? 0,
  };
}

export interface UploadResult extends ProfileResult {
  image: string | null;
}

/** A sounding the user pasted, parsed and rendered by the backend. */
export async function uploadSounding(
  text: string,
  title: string,
  signal?: AbortSignal,
): Promise<UploadResult> {
  const res = await fetch(`${BASE}/api/sounding/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, title }),
    signal,
  });
  const j = (await res.json()) as {
    detail?: string;
    meta?: { modelLabel?: string; validUnix?: number | null };
    params?: SoundingParams;
    levels?: unknown[];
    image?: string | null;
  };
  if (!res.ok) throw new Error(j.detail ?? `HTTP ${res.status}`);
  return {
    label: j.meta?.modelLabel ?? title ?? "Uploaded",
    validUnix: j.meta?.validUnix ?? null,
    source: "Pasted",
    params: j.params ?? {},
    levels: j.levels?.length ?? 0,
    image: j.image ?? null,
  };
}

/** Run jobs a few at a time: the backend renders nothing here, but each
 *  profile is still a fetch and a decode, and a scan can be thirty of them. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await worker(items[i], i);
      }
    }),
  );
  return out;
}
