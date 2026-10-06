/**
 * Space weather data, read straight from NOAA's Space Weather Prediction
 * Center (services.swpc.noaa.gov). SWPC serves every file with CORS open, so
 * the app reads it in the browser -- no backend in the way, and the web
 * version can do the same.
 *
 * Everything is cached in memory for a short while: SWPC itself asks clients
 * to keep files for 60 s, and the dashboard asks for the same few files from
 * several charts at once.
 */

export const SWPC = "https://services.swpc.noaa.gov";

const cache = new Map<string, { at: number; ttl: number; data: Promise<unknown> }>();

/** A SWPC file (path from the site root, or a full URL), cached for `ttlS`. */
export function swpcGet<T>(path: string, ttlS = 60, kind: "json" | "text" = "json"): Promise<T> {
  const url = path.startsWith("http") ? path : `${SWPC}${path.startsWith("/") ? "" : "/"}${path}`;
  const hit = cache.get(url);
  const now = Date.now();
  if (hit && now - hit.at < hit.ttl * 1000) return hit.data as Promise<T>;
  const data = fetch(url, { cache: "no-cache" }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.replace(SWPC, "").split("?")[0]}`);
    return kind === "json" ? r.json() : r.text();
  });
  cache.set(url, { at: now, ttl: ttlS, data });
  // A failure must not stay cached: the next ask tries again.
  data.catch(() => {
    if (cache.get(url)?.data === data) cache.delete(url);
  });
  return data as Promise<T>;
}

/** A URL on the SWPC site for a path its lists hand out ("/images/..."). */
export function swpcUrl(path: string): string {
  return path.startsWith("http") ? path : `${SWPC}${path}`;
}

/** Unix ms of a SWPC time tag. Most carry no zone and are UTC; some end in Z. */
export function tagMs(tag: string | null | undefined): number {
  if (!tag) return NaN;
  const t = tag.trim().replace(" ", "T");
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
}
