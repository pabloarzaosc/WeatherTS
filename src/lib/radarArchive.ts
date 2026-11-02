import { BACKEND_BASE } from "./apiConfig";

/**
 * The NEXRAD Level II archive by day (archive-l2): every volume a radar wrote
 * on a UTC day, back to June 1991, from the public bucket on AWS (backend
 * nexrad_level2.archive_day).
 */

export interface ArchiveVolume {
  /** "L2A:<file name>" -- the frame key every Level II product loads. */
  key: string;
  /** Volume start, unix seconds. */
  time: number;
  /** File size in bytes (compressed, as downloaded). */
  size: number;
  /** A fragment of a volume (a few kB: one partial sweep); not loadable. */
  partial: boolean;
}

export interface ArchiveDay {
  site: string;
  date: string;
  volumes: ArchiveVolume[];
  /** Level III products exist that day too (March 2022 on). */
  level3: boolean;
}

/** The first day in the archive (KTLX, 1991-06-05). */
export const ARCHIVE_FIRST_DAY = "1991-06-01";

export async function fetchArchiveDay(site: string, date: string, signal?: AbortSignal): Promise<ArchiveDay> {
  const r = await fetch(
    `${BACKEND_BASE}/api/nexrad/archive/day?site=${encodeURIComponent(site)}&date=${encodeURIComponent(date)}`,
    { signal },
  );
  if (!r.ok) {
    let detail = `archive ${r.status}`;
    try {
      const body = (await r.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      /* the status says enough */
    }
    throw new Error(detail);
  }
  return r.json();
}

/**
 * The stretches of the day the picked volumes cover: each from its start to
 * the next volume's (at most 15 min), touching ones joined. Level III scans
 * of a picked volume fall inside its stretch, so one pick serves every product.
 */
export function pickSpans(volumes: ArchiveVolume[], picked: Set<string>): Array<[number, number]> {
  const whole = volumes.filter((v) => !v.partial).sort((a, b) => a.time - b.time);
  const out: Array<[number, number]> = [];
  whole.forEach((v, i) => {
    if (!picked.has(v.key)) return;
    const next = whole[i + 1]?.time ?? v.time + 600;
    const end = Math.min(next, v.time + 900);
    const last = out[out.length - 1];
    if (last && last[1] >= v.time) last[1] = Math.max(last[1], end);
    else out.push([v.time, end]);
  });
  return out;
}

/** "2.3 MB" / "840 kB". */
export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} kB`;
}

/** "23:16:33Z". */
export function hmsZ(unix: number): string {
  return `${new Date(unix * 1000).toISOString().slice(11, 19)}Z`;
}
