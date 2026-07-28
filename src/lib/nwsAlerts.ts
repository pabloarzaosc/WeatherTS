/** Live alerts from the US National Weather Service (api.weather.gov, public domain). */

export type AlertParameters = Record<string, string[] | undefined>;

export interface NwsAlert {
  id: string;
  areaDesc: string;
  sent: string;
  effective: string;
  onset: string | null;
  expires: string;
  ends: string | null;
  status: string;
  messageType: string; // Alert | Update | Cancel
  category: string;
  severity: string; // Extreme | Severe | Moderate | Minor | Unknown
  certainty: string;
  urgency: string;
  event: string;
  senderName: string;
  headline: string | null;
  description: string;
  instruction: string | null;
  response: string;
  parameters: AlertParameters;
  affectedZones: string[];
}

export interface AlertFeature {
  alert: NwsAlert;
  geometry: GeoJSON.Geometry | null;
}

export interface ActiveAlertQuery {
  area?: string;
  event?: string;
  point?: string | { lat: number; lon: number };
}

interface RawFeature {
  id?: string;
  geometry?: GeoJSON.Geometry | null;
  properties?: Record<string, unknown>;
}

const NWS_ALERTS_URL = "https://api.weather.gov/alerts";
const NWS_REFERENCE_MAP_URL =
  "https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/nws_reference_map/MapServer";
const ZONE_DB_NAME = "weatherts-nws-zone-geometries";
const ZONE_DB_STORE = "zones";
const ZONE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const REFERENCE_QUERY_CHUNK_SIZE = 70;
const REFERENCE_QUERY_CONCURRENCY = 8;

const PUBLIC_WEATHER_ZONE_LAYER = 8;
const FIRE_WEATHER_ZONE_LAYER = 9;
const COUNTY_LAYER = 2;
const MARINE_ZONE_LAYERS = [5, 6, 10] as const;

const zoneGeometryCache = new Map<string, GeoJSON.Geometry | null>();
let zoneDbPromise: Promise<IDBDatabase | null> | null = null;

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const stringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((item): item is string => typeof item === "string") : [];

interface ZoneGeometryRecord {
  url: string;
  geometry: GeoJSON.Geometry | null;
  storedAt: number;
}

interface ParsedZoneUrl {
  url: string;
  type: string;
  id: string;
}

interface ReferenceFeature {
  geometry?: GeoJSON.Geometry | null;
  properties?: Record<string, unknown>;
}

interface ReferenceQuery {
  layerId: number;
  field: string;
  values: string[];
  targets: Map<string, string[]>;
}

const STATE_FIPS: Record<string, string> = {
  AL: "01",
  AK: "02",
  AZ: "04",
  AR: "05",
  CA: "06",
  CO: "08",
  CT: "09",
  DE: "10",
  DC: "11",
  FL: "12",
  GA: "13",
  HI: "15",
  ID: "16",
  IL: "17",
  IN: "18",
  IA: "19",
  KS: "20",
  KY: "21",
  LA: "22",
  ME: "23",
  MD: "24",
  MA: "25",
  MI: "26",
  MN: "27",
  MS: "28",
  MO: "29",
  MT: "30",
  NE: "31",
  NV: "32",
  NH: "33",
  NJ: "34",
  NM: "35",
  NY: "36",
  NC: "37",
  ND: "38",
  OH: "39",
  OK: "40",
  OR: "41",
  PA: "42",
  RI: "44",
  SC: "45",
  SD: "46",
  TN: "47",
  TX: "48",
  UT: "49",
  VT: "50",
  VA: "51",
  WA: "53",
  WV: "54",
  WI: "55",
  WY: "56",
  AS: "60",
  GU: "66",
  MP: "69",
  PR: "72",
  VI: "78",
};

function activeAlertsUrl(query: ActiveAlertQuery = {}): string {
  const url = new URL(`${NWS_ALERTS_URL}/active`);
  if (query.area) url.searchParams.set("area", query.area.trim().toUpperCase());
  if (query.event) url.searchParams.set("event", query.event.trim());
  if (query.point) {
    const point =
      typeof query.point === "string" ? query.point : `${query.point.lat},${query.point.lon}`;
    url.searchParams.set("point", point);
  }
  return url.toString();
}

async function readNwsProblem(res: Response): Promise<string> {
  try {
    const problem = (await res.json()) as { detail?: unknown; title?: unknown };
    return str(problem.detail) || str(problem.title) || res.statusText;
  } catch {
    return res.statusText;
  }
}

export async function fetchActiveAlerts(
  signal?: AbortSignal,
  query?: ActiveAlertQuery,
): Promise<AlertFeature[]> {
  const res = await fetch(activeAlertsUrl(query), {
    signal,
    headers: { Accept: "application/geo+json" },
  });
  if (!res.ok) throw new Error(`NWS API ${res.status}: ${await readNwsProblem(res)}`);
  const data = (await res.json()) as { features?: RawFeature[] };

  return (data.features ?? []).map((f) => {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    const alert: NwsAlert = {
      id: str(p.id) || str(f.id) || `${str(p.event)}-${str(p.sent)}`,
      areaDesc: str(p.areaDesc),
      sent: str(p.sent),
      effective: str(p.effective),
      onset: strOrNull(p.onset),
      expires: str(p.expires),
      ends: strOrNull(p.ends),
      status: str(p.status),
      messageType: str(p.messageType),
      category: str(p.category),
      severity: str(p.severity, "Unknown"),
      certainty: str(p.certainty),
      urgency: str(p.urgency),
      event: str(p.event, "Alert"),
      senderName: str(p.senderName),
      headline: strOrNull(p.headline),
      description: str(p.description),
      instruction: strOrNull(p.instruction),
      response: str(p.response),
      parameters: (p.parameters as AlertParameters) ?? {},
      affectedZones: stringArray(p.affectedZones),
    };
    return { alert, geometry: f.geometry ?? null };
  });
}

function polygonCoordinates(geometry: GeoJSON.Geometry | null): GeoJSON.Position[][][] {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  if (geometry.type === "GeometryCollection") {
    return geometry.geometries.flatMap((item) => polygonCoordinates(item));
  }
  return [];
}

function combineZoneGeometries(geometries: Array<GeoJSON.Geometry | null>): GeoJSON.Geometry | null {
  const polygons = geometries.flatMap(polygonCoordinates);
  if (polygons.length === 0) return null;
  if (polygons.length === 1) return { type: "Polygon", coordinates: polygons[0] };
  return { type: "MultiPolygon", coordinates: polygons };
}

/**
 * Planar centroid and |area| of a ring, by the shoelace formula. Only ever fed
 * to a nearest-site comparison, so raw lon/lat degrees (no projection) are fine.
 *
 * Not the mean of the vertices, which is what this used to be: NWS zone rings
 * carry their vertices very unevenly -- dense along coastlines and ragged county
 * borders, sparse along straight edges -- so a vertex mean drifts toward
 * whichever side happens to be drawn in more detail.
 */
function ringCentroid(ring: GeoJSON.Position[]): { x: number; y: number; area: number } | null {
  if (ring.length === 0) return null;
  // A GeoJSON ring repeats its first position as its last. Drop the duplicate:
  // the shoelace sum is unaffected, but it would otherwise weigh that one corner
  // twice in the degenerate-ring fallback below.
  const closed =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  const pts = closed ? ring.slice(0, -1) : ring;
  if (pts.length === 0) return null;

  let twiceArea = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const cross = x1 * y2 - x2 * y1;
    twiceArea += cross;
    x += (x1 + x2) * cross;
    y += (y1 + y2) * cross;
  }

  if (Math.abs(twiceArea) < 1e-12) {
    // A single point or a collinear sliver: the shoelace centroid is 0/0, but
    // the vertex mean still names a point on the shape.
    let mx = 0;
    let my = 0;
    for (const [px, py] of pts) {
      mx += px;
      my += py;
    }
    return { x: mx / pts.length, y: my / pts.length, area: 0 };
  }

  return { x: x / (twiceArea * 3), y: y / (twiceArea * 3), area: Math.abs(twiceArea) / 2 };
}

/**
 * A representative [lon, lat] for an alert's footprint: the area-weighted mean
 * of its polygons' outer-ring centroids. Weighting by area keeps a multi-part
 * alert (say two far-apart counties) from landing in the empty space between
 * them -- the point follows the dominant polygon, which is what "which radar is
 * nearest" actually wants. Returns null when the alert has no drawable geometry.
 */
export function alertCentroid(geometry: GeoJSON.Geometry | null): [number, number] | null {
  const polys = polygonCoordinates(geometry);
  if (polys.length === 0) return null;
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (const rings of polys) {
    const outer = rings[0];
    if (!outer || outer.length === 0) continue;
    const c = ringCentroid(outer);
    if (!c) continue;
    const w = c.area || 1e-9; // a degenerate ring still counts, faintly
    sx += c.x * w;
    sy += c.y * w;
    sw += w;
  }
  if (sw === 0) return null;
  return [sx / sw, sy / sw];
}

/**
 * The lon/lat bounding box of an alert's footprint as [[west, south], [east,
 * north]], for framing it with map.fitBounds. Null when the alert has no
 * drawable geometry (zone-only alerts before their zones are enriched).
 */
const EARTH_KM = 6371;

/** Great-circle distance in km between two [lon, lat] points. */
export function distanceKm(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(s));
}

/** Ray casting in lon/lat. Fine at alert scale, where a polygon spans degrees. */
function pointInRing(pt: [number, number], ring: GeoJSON.Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = yi > pt[1] !== yj > pt[1];
    if (crosses && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Whether an alert's footprint comes within `km` of a point.
 *
 * Deliberately not a centroid test: a warning covering half a state can be
 * hundreds of kilometres wide, so its centre may sit far outside a watch radius
 * that the polygon itself overlaps. Checks containment first, then the closest
 * vertex -- for shapes this size that is close enough, and it never reports a
 * near miss as a hit.
 */
export function alertWithinKm(
  geometry: GeoJSON.Geometry | null,
  center: [number, number],
  km: number,
): boolean {
  const polys = polygonCoordinates(geometry);
  if (polys.length === 0) return false;
  for (const rings of polys) {
    const outer = rings[0];
    if (!outer || outer.length === 0) continue;
    if (pointInRing(center, outer)) return true;
    for (const v of outer) {
      if (distanceKm(center, [v[0], v[1]]) <= km) return true;
    }
  }
  return false;
}

export function alertBounds(
  geometry: GeoJSON.Geometry | null,
): [[number, number], [number, number]] | null {
  const polys = polygonCoordinates(geometry);
  if (polys.length === 0) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const rings of polys) {
    for (const ring of rings) {
      for (const [x, y] of ring) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < west) west = x;
        if (x > east) east = x;
        if (y < south) south = y;
        if (y > north) north = y;
      }
    }
  }
  if (west > east || south > north) return null;
  return [
    [west, south],
    [east, north],
  ];
}

function openZoneDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (zoneDbPromise) return zoneDbPromise;

  zoneDbPromise = new Promise((resolve) => {
    const req = indexedDB.open(ZONE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ZONE_DB_STORE)) {
        db.createObjectStore(ZONE_DB_STORE, { keyPath: "url" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });

  return zoneDbPromise;
}

async function loadZoneFromDb(db: IDBDatabase, url: string): Promise<void> {
  if (zoneGeometryCache.has(url)) return;

  await new Promise<void>((resolve) => {
    const tx = db.transaction(ZONE_DB_STORE, "readonly");
    const req = tx.objectStore(ZONE_DB_STORE).get(url);
    req.onsuccess = () => {
      const record = req.result as ZoneGeometryRecord | undefined;
      if (record && Date.now() - record.storedAt < ZONE_CACHE_MAX_AGE_MS) {
        zoneGeometryCache.set(url, record.geometry);
      }
      resolve();
    };
    req.onerror = () => resolve();
  });
}

async function saveZoneToDb(url: string, geometry: GeoJSON.Geometry | null): Promise<void> {
  const db = await openZoneDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    const tx = db.transaction(ZONE_DB_STORE, "readwrite");
    tx.objectStore(ZONE_DB_STORE).put({ url, geometry, storedAt: Date.now() } satisfies ZoneGeometryRecord);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function saveZonesToDb(records: ZoneGeometryRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await openZoneDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    const tx = db.transaction(ZONE_DB_STORE, "readwrite");
    const store = tx.objectStore(ZONE_DB_STORE);
    for (const record of records) store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function hydrateZoneCache(urls: string[]): Promise<void> {
  const db = await openZoneDb();
  if (!db) return;
  const missing = urls.filter((url) => !zoneGeometryCache.has(url));
  await mapLimit(missing, 40, (url) => loadZoneFromDb(db, url));
}

function parseZoneUrl(url: string): ParsedZoneUrl | null {
  const match = url.match(/\/zones\/([^/?#]+)\/([^/?#]+)/);
  if (!match) return null;
  return { url, type: match[1], id: decodeURIComponent(match[2]).toUpperCase() };
}

function stateZoneKey(id: string): string | null {
  const match = id.match(/^([A-Z]{2})Z(\d{3})$/);
  if (!match || !STATE_FIPS[match[1]]) return null;
  return `${match[1]}${match[2]}`;
}

function countyFips(id: string): string | null {
  const match = id.match(/^([A-Z]{2})C(\d{3})$/);
  const stateFips = match ? STATE_FIPS[match[1]] : undefined;
  return stateFips ? `${stateFips}${match?.[2]}` : null;
}

function addTarget(targets: Map<string, string[]>, key: string | null, url: string) {
  if (!key) return;
  const urls = targets.get(key);
  if (urls) urls.push(url);
  else targets.set(key, [url]);
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function referenceQueryUrl(layerId: number, field: string, values: string[]): string {
  const url = new URL(`${NWS_REFERENCE_MAP_URL}/${layerId}/query`);
  const quoted = values.map((value) => `'${value.replace(/'/g, "''")}'`).join(",");
  url.searchParams.set("f", "geojson");
  url.searchParams.set("where", `${field} IN (${quoted})`);
  url.searchParams.set("outFields", field);
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("geometryPrecision", "4");
  return url.toString();
}

async function fetchReferenceFeatures(
  query: ReferenceQuery,
  signal?: AbortSignal,
): Promise<ReferenceFeature[]> {
  try {
    const res = await fetch(referenceQueryUrl(query.layerId, query.field, query.values), {
      signal,
      headers: { Accept: "application/geo+json" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { features?: ReferenceFeature[] };
    return (data.features ?? []).filter((feature) => feature.geometry);
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    return [];
  }
}

function buildReferenceQueries(zoneUrls: string[]): ReferenceQuery[] {
  const publicWeather = new Map<string, string[]>();
  const marine = new Map<string, string[]>();
  const fire = new Map<string, string[]>();
  const counties = new Map<string, string[]>();

  for (const url of zoneUrls) {
    const parsed = parseZoneUrl(url);
    if (!parsed) continue;

    if (parsed.type === "forecast") {
      const publicKey = stateZoneKey(parsed.id);
      if (publicKey) addTarget(publicWeather, publicKey, parsed.url);
      else addTarget(marine, parsed.id, parsed.url);
    } else if (parsed.type === "fire") {
      addTarget(fire, stateZoneKey(parsed.id), parsed.url);
    } else if (parsed.type === "county") {
      addTarget(counties, countyFips(parsed.id), parsed.url);
    }
  }

  const queries: ReferenceQuery[] = [];
  for (const values of chunks(Array.from(publicWeather.keys()), REFERENCE_QUERY_CHUNK_SIZE)) {
    queries.push({ layerId: PUBLIC_WEATHER_ZONE_LAYER, field: "state_zone", values, targets: publicWeather });
  }
  for (const layerId of MARINE_ZONE_LAYERS) {
    for (const values of chunks(Array.from(marine.keys()), REFERENCE_QUERY_CHUNK_SIZE)) {
      queries.push({ layerId, field: "id", values, targets: marine });
    }
  }
  for (const values of chunks(Array.from(fire.keys()), REFERENCE_QUERY_CHUNK_SIZE)) {
    queries.push({ layerId: FIRE_WEATHER_ZONE_LAYER, field: "state_zone", values, targets: fire });
  }
  for (const values of chunks(Array.from(counties.keys()), REFERENCE_QUERY_CHUNK_SIZE)) {
    queries.push({ layerId: COUNTY_LAYER, field: "fips", values, targets: counties });
  }
  return queries;
}

async function fetchReferenceMapZoneGeometries(
  zoneUrls: string[],
  signal?: AbortSignal,
  onProgress?: () => void,
): Promise<void> {
  const queries = buildReferenceQueries(zoneUrls);
  const records: ZoneGeometryRecord[] = [];
  const saved = new Set<string>();

  await mapLimit(queries, REFERENCE_QUERY_CONCURRENCY, async (query) => {
    const features = await fetchReferenceFeatures(query, signal);
    const storedAt = Date.now();

    for (const feature of features) {
      const key = str(feature.properties?.[query.field]);
      const geometry = feature.geometry ?? null;
      const urls = key ? query.targets.get(key) : undefined;
      if (!urls || !geometry) continue;

      for (const url of urls) {
        if (zoneGeometryCache.has(url)) continue;
        zoneGeometryCache.set(url, geometry);
        if (!saved.has(url)) {
          records.push({ url, geometry, storedAt });
          saved.add(url);
        }
      }
    }

    onProgress?.();
  });

  await saveZonesToDb(records);
}

async function fetchZoneGeometry(url: string, signal?: AbortSignal): Promise<GeoJSON.Geometry | null> {
  if (zoneGeometryCache.has(url)) return zoneGeometryCache.get(url) ?? null;
  try {
    const res = await fetch(url, { signal, headers: { Accept: "application/geo+json" } });
    if (!res.ok) {
      zoneGeometryCache.set(url, null);
      void saveZoneToDb(url, null);
      return null;
    }
    const data = (await res.json()) as { geometry?: GeoJSON.Geometry | null };
    const geometry = data.geometry ?? null;
    zoneGeometryCache.set(url, geometry);
    void saveZoneToDb(url, geometry);
    return geometry;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    zoneGeometryCache.set(url, null);
    return null;
  }
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function applyCachedZoneGeometries(features: AlertFeature[]): AlertFeature[] {
  return features.map((feature) => {
    if (feature.geometry || feature.alert.affectedZones.length === 0) return feature;
    const geometries = feature.alert.affectedZones.map((url) => zoneGeometryCache.get(url) ?? null);
    const geometry = combineZoneGeometries(geometries);
    return geometry ? { ...feature, geometry } : feature;
  });
}

export async function enrichAlertZoneGeometries(
  features: AlertFeature[],
  signal?: AbortSignal,
  onProgress?: (fetched: number, total: number) => void,
): Promise<AlertFeature[]> {
  const allZoneUrls = Array.from(
    new Set(
      features
        .filter((feature) => !feature.geometry)
        .flatMap((feature) => feature.alert.affectedZones)
    ),
  );
  await hydrateZoneCache(allZoneUrls);

  const total = allZoneUrls.length;
  const report = () => {
    if (total > 0) {
      onProgress?.(allZoneUrls.filter((url) => zoneGeometryCache.has(url)).length, total);
    }
  };

  let zoneUrls = allZoneUrls.filter((url) => !zoneGeometryCache.has(url));

  if (zoneUrls.length === 0) {
    const enriched = applyCachedZoneGeometries(features);
    onProgress?.(total, total);
    return enriched;
  }

  await fetchReferenceMapZoneGeometries(zoneUrls, signal, report);
  zoneUrls = allZoneUrls.filter((url) => !zoneGeometryCache.has(url));

  if (zoneUrls.length === 0) {
    report();
    return applyCachedZoneGeometries(features);
  }

  let fetched = 0;
  await mapLimit(zoneUrls, 16, async (url) => {
    await fetchZoneGeometry(url, signal);
    fetched += 1;
    if (fetched % 40 === 0 || fetched === zoneUrls.length) {
      report();
    }
  });

  return applyCachedZoneGeometries(features);
}

/** Unix seconds, or `fallback` when the timestamp is absent/unparseable. */
function unix(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const t = Date.parse(value);
  return Number.isNaN(t) ? fallback : Math.round(t / 1000);
}

const FAR_FUTURE = Math.round(Number.MAX_SAFE_INTEGER / 1000);

/** When an alert is in force, in unix seconds. */
export function alertWindow(a: NwsAlert): { start: number; end: number } {
  // onset is when the hazard starts; effective/sent are the fallbacks for
  // alerts that don't carry a distinct onset.
  return {
    start: unix(a.onset, unix(a.effective, unix(a.sent, 0))),
    end: unix(a.ends, unix(a.expires, FAR_FUTURE)),
  };
}

export function alertInForceAt(a: NwsAlert, t: number): boolean {
  const w = alertWindow(a);
  return w.start <= t && t <= w.end;
}

export function alertsToFeatureCollection(features: AlertFeature[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [...features]
      .filter((f) => f.geometry)
      .sort((a, b) => alertPriority(a.alert) - alertPriority(b.alert))
      .map((f) => {
        const a = f.alert;
        // carried onto the feature so the map can filter by time without a
        // round trip through the store
        const { start: startUnix, end: endUnix } = alertWindow(a);
        return {
          type: "Feature" as const,
          id: a.id,
          properties: {
            id: a.id,
            severity: a.severity,
            event: a.event,
            color: eventColor(a.event),
            priority: alertPriority(a),
            startUnix,
            endUnix,
          },
          geometry: f.geometry as GeoJSON.Geometry,
        };
      }),
  };
}

/* --------------------------------------------------------------- helpers */

export function severityColor(severity: string): string {
  switch (severity) {
    case "Extreme":
      return "#d946ef";
    case "Severe":
      return "#ef4444";
    case "Moderate":
      return "#f59e0b";
    case "Minor":
      return "#eab308";
    default:
      return "#9ca3af";
  }
}

const EXACT_EVENT_COLORS: Record<string, string> = {
  "tornado warning": "#e11d48",
  "severe thunderstorm warning": "#f59e0b",
  "flash flood warning": "#22c55e",
  "special marine warning": "#06b6d4",
  "red flag warning": "#dc2626",
  "fire warning": "#f97316",
  "extreme heat warning": "#ec4899",
  "excessive heat warning": "#ec4899",
  "flood warning": "#0ea5e9",
  "coastal flood warning": "#14b8a6",
  "lakeshore flood warning": "#2dd4bf",
  "high surf warning": "#eab308",
  "winter storm warning": "#60a5fa",
  "blizzard warning": "#38bdf8",
  "ice storm warning": "#a78bfa",
  "snow squall warning": "#c084fc",
  "high wind warning": "#8b5cf6",
  "extreme wind warning": "#f97316",
  "dust storm warning": "#fbbf24",
  "dense fog advisory": "#94a3b8",
  "air quality alert": "#84cc16",
  "civil emergency message": "#b91c1c",
  "evacuation immediate": "#fb7185",
  "shelter in place warning": "#f43f5e",

  "tornado watch": "#fde047",
  "severe thunderstorm watch": "#fb7185",
  "flash flood watch": "#16a34a",
  "flood watch": "#0891b2",
  "coastal flood watch": "#5eead4",
  "winter storm watch": "#3b82f6",
  "fire weather watch": "#fb923c",
  "high wind watch": "#7c3aed",
  "extreme heat watch": "#db2777",
  "hurricane watch": "#d946ef",
  "tropical storm watch": "#f472b6",
  "storm surge watch": "#c026d3",
  "gale watch": "#f9a8d4",
  "hazardous seas watch": "#818cf8",

  "heat advisory": "#ea580c",
  "flood advisory": "#0284c7",
  "coastal flood advisory": "#0d9488",
  "lakeshore flood advisory": "#0f766e",
  "winter weather advisory": "#6366f1",
  "wind advisory": "#a855f7",
  "small craft advisory": "#d8b4fe",
  "dense smoke advisory": "#ca8a04",
  "dust advisory": "#a16207",
  "freezing fog advisory": "#0891b2",
  "frost advisory": "#93c5fd",
  "cold weather advisory": "#67e8f9",
  "beach hazards statement": "#facc15",
  "rip current statement": "#06b6d4",
  "special weather statement": "#22d3ee",
  "marine weather statement": "#fed7aa",
  "hazardous weather outlook": "#fef08a",
  "short term forecast": "#86efac",
};

const EVENT_PATTERNS: Array<[RegExp, string]> = [
  [/Tornado Emergency|Tornado Warning/i, "#e11d48"],
  [/Flash Flood Emergency|Flash Flood Warning/i, "#22c55e"],
  [/Severe Thunderstorm Warning/i, "#f59e0b"],
  [/Special Marine Warning/i, "#06b6d4"],
  [/Red Flag Warning/i, "#dc2626"],
];

const FALLBACK_EVENT_COLORS = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#84cc16",
  "#22c55e",
  "#10b981",
  "#14b8a6",
  "#06b6d4",
  "#0ea5e9",
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#a855f7",
  "#d946ef",
  "#ec4899",
  "#f43f5e",
  "#64748b",
  "#a16207",
  "#be123c",
  "#0f766e",
];

function hashColor(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_EVENT_COLORS[hash % FALLBACK_EVENT_COLORS.length];
}

export function eventColor(event: string): string {
  const normalized = event.trim().replace(/\s+/g, " ").toLowerCase();
  return (
    EXACT_EVENT_COLORS[normalized] ??
    EVENT_PATTERNS.find(([pattern]) => pattern.test(event))?.[1] ??
    hashColor(event || "Alert")
  );
}

/** First value of an NWS parameter array (parameters values are string[]). */
export function param(p: AlertParameters, key: string): string | undefined {
  const v = p[key];
  return Array.isArray(v) && v.length > 0 ? v[0] : undefined;
}

export interface HumanAlertParameter {
  key: string;
  label: string;
  value: string;
}

const PARAM_LABELS: Record<string, string> = {
  tornadoDetection: "Tornado",
  tornadoDamageThreat: "Tornado Damage Threat",
  flashFloodDetection: "Flash Flood",
  flashFloodDamageThreat: "Flood Damage Threat",
  thunderstormDamageThreat: "Damage Threat",
  maxHailSize: "Hail",
  hailThreat: "Hail Source",
  maxWindGust: "Wind",
  windThreat: "Wind Source",
  eventMotionDescription: "Storm Motion",
  eventEndingTime: "Ends",
  NWSheadline: "NWS Headline",
  WEAHandling: "Wireless Alert",
  CMAMtext: "Wireless Message",
  CMAMlongtext: "Wireless Long Message",
  timezone: "Time Zone",
  BLOCKCHANNEL: "Channels",
  "EAS-ORG": "EAS Originator",
  AWIPSidentifier: "AWIPS",
  WMOidentifier: "WMO",
  VTEC: "VTEC",
  expiredReferences: "Expired References",
};

const PARAM_ORDER = [
  "tornadoDetection",
  "tornadoDamageThreat",
  "flashFloodDetection",
  "flashFloodDamageThreat",
  "thunderstormDamageThreat",
  "maxHailSize",
  "hailThreat",
  "maxWindGust",
  "windThreat",
  "eventMotionDescription",
  "eventEndingTime",
  "NWSheadline",
  "WEAHandling",
  "CMAMtext",
  "CMAMlongtext",
  "timezone",
  "BLOCKCHANNEL",
  "EAS-ORG",
  "AWIPSidentifier",
  "WMOidentifier",
  "VTEC",
  "expiredReferences",
];

const EVENT_PRIORITY: Array<[RegExp, number]> = [
  [/^Tornado Warning$/i, 1000],
  [/^Flash Flood Warning$/i, 940],
  [/^Severe Thunderstorm Warning$/i, 900],
  [/^Extreme Wind Warning$/i, 890],
  [/^Civil Emergency Message$/i, 880],
  [/^Special Marine Warning$/i, 820],
  [/^High Wind Warning$/i, 780],
  [/^Red Flag Warning$/i, 760],
  [/^Extreme Heat Warning$/i, 720],
  [/^Flood Warning$/i, 700],
  [/^Gale Warning$/i, 690],
  [/^Hazardous Seas Warning$/i, 680],
  [/^Winter Storm Warning$/i, 670],
  [/^Blizzard Warning$/i, 670],
  [/^Ice Storm Warning$/i, 670],
  [/Warning$/i, 650],
  [/Tornado Watch$/i, 620],
  [/Severe Thunderstorm Watch$/i, 590],
  [/Flash Flood Watch$/i, 570],
  [/^Fire Weather Watch$/i, 560],
  [/^High Wind Watch$/i, 550],
  [/^Extreme Heat Watch$/i, 540],
  [/Watch$/i, 520],
  [/^Heat Advisory$/i, 430],
  [/^Wind Advisory$/i, 420],
  [/^Dense Fog Advisory$/i, 400],
  [/^Small Craft Advisory$/i, 390],
  [/Advisory$/i, 360],
  [/^Air Quality Alert$/i, 340],
  [/^Beach Hazards Statement$/i, 330],
  [/^Rip Current Statement$/i, 320],
  [/Statement$/i, 250],
];

const SEVERITY_PRIORITY: Record<string, number> = {
  Extreme: 400,
  Severe: 300,
  Moderate: 180,
  Minor: 80,
  Unknown: 0,
};

const URGENCY_PRIORITY: Record<string, number> = {
  Immediate: 120,
  Expected: 70,
  Future: 30,
  Past: 0,
  Unknown: 0,
};

const CERTAINTY_PRIORITY: Record<string, number> = {
  Observed: 100,
  Likely: 70,
  Possible: 35,
  Unlikely: 0,
  Unknown: 0,
};

const ACRONYMS: Record<string, string> = {
  Am: "AM",
  Pm: "PM",
  Cdt: "CDT",
  Cst: "CST",
  Edt: "EDT",
  Est: "EST",
  Mdt: "MDT",
  Mst: "MST",
  Pdt: "PDT",
  Pst: "PST",
  Nws: "NWS",
  Noaa: "NOAA",
  Wmo: "WMO",
  Awips: "AWIPS",
  Vtec: "VTEC",
  Eas: "EAS",
};

const titleCase = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/\b[a-z]/g, (char) => char.toUpperCase())
    .replace(/\b(Am|Pm|Cdt|Cst|Edt|Est|Mdt|Mst|Pdt|Pst|Nws|Noaa|Wmo|Awips|Vtec|Eas)\b/g, (word) => ACRONYMS[word]);

const startCase = (value: string): string =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (char) => char.toUpperCase());

function smartCase(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return trimmed;
  if (/^[A-Z][A-Z\s-]+$/.test(trimmed) && trimmed.length > 3) return titleCase(trimmed);
  return trimmed;
}

function formatHail(raw: string): string {
  const n = Number(raw);
  return Number.isFinite(n) ? `${n.toFixed(2)}"` : raw;
}

function formatWind(raw: string): string {
  return raw.replace(/\bMPH\b/i, "mph").replace(/\bKT\b/i, "kt");
}

function compassFromDegrees(degrees: number): string {
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return directions[Math.round(degrees / 45) % directions.length];
}

function formatMotion(raw: string): string {
  const parts = raw.match(/\.\.\.[a-z]+\.\.\.(\d+)DEG\.\.\.(\d+)KT/i);
  if (!parts) return raw;
  const fromDegrees = Number(parts[1]);
  const kt = Number(parts[2]);
  if (!Number.isFinite(fromDegrees) || !Number.isFinite(kt)) return raw;
  const toward = compassFromDegrees((fromDegrees + 180) % 360);
  const mph = Math.round(kt * 1.15078);
  return `Moving ${toward} at ${mph} mph`;
}

function formatDateTime(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseDescriptionSections(description: string): Map<string, string> {
  const sections = new Map<string, string>();
  let currentKey: string | null = null;

  for (const rawLine of description.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;

    const bullet = line.match(/^\*\s*([A-Z][A-Z0-9 /-]+)\.\.\.(.*)$/);
    const inline = line.match(/^([A-Z][A-Z0-9 /-]+)\.\.\.(.*)$/);
    const match = bullet ?? inline;

    if (match) {
      currentKey = match[1].trim().toUpperCase();
      const value = cleanText(match[2]);
      if (value) sections.set(currentKey, value);
      else if (!sections.has(currentKey)) sections.set(currentKey, "");
      continue;
    }

    if (currentKey) {
      const prev = sections.get(currentKey) ?? "";
      sections.set(currentKey, cleanText(`${prev} ${line}`));
    }
  }

  return sections;
}

function addSectionFact(
  rows: HumanAlertParameter[],
  sections: Map<string, string>,
  key: string,
  label: string,
) {
  const value = sections.get(key);
  if (value) rows.push({ key: `section:${key}`, label, value: smartCase(value) });
}

function formatParamValue(key: string, values: string[]): string {
  if (values.length === 0) return "";
  if (key === "expiredReferences") {
    return `${values.length} previous ${values.length === 1 ? "alert" : "alerts"}`;
  }
  if (key === "maxHailSize") return formatHail(values[0]);
  if (key === "maxWindGust") return formatWind(values[0]);
  if (key === "eventMotionDescription") return formatMotion(values[0]);
  if (key === "eventEndingTime") return formatDateTime(values[0]);
  if (
    key === "tornadoDetection" ||
    key === "tornadoDamageThreat" ||
    key === "flashFloodDetection" ||
    key === "flashFloodDamageThreat" ||
    key === "thunderstormDamageThreat" ||
    key === "hailThreat" ||
    key === "windThreat" ||
    key === "WEAHandling"
  ) {
    return values.map(titleCase).join(", ");
  }
  if (key === "NWSheadline") return smartCase(values[0]);
  return values.map(smartCase).join(", ");
}

function threatScore(value?: string): number {
  switch (value?.toUpperCase()) {
    case "CATASTROPHIC":
    case "DESTRUCTIVE":
      return 180;
    case "CONSIDERABLE":
      return 120;
    case "RADAR INDICATED":
    case "OBSERVED":
      return 70;
    case "POSSIBLE":
      return 35;
    default:
      return 0;
  }
}

function numericParam(alert: NwsAlert, key: string): number {
  const value = Number(param(alert.parameters, key));
  return Number.isFinite(value) ? value : 0;
}

function windMph(alert: NwsAlert): number {
  const raw = param(alert.parameters, "maxWindGust") ?? "";
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : 0;
}

export function humanAlertParameters(alert: NwsAlert): HumanAlertParameter[] {
  return Object.entries(alert.parameters)
    .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].length > 0)
    .map(([key, values]) => ({
      key,
      label: PARAM_LABELS[key] ?? startCase(key),
      value: formatParamValue(key, values),
    }))
    .filter((row) => row.value !== "")
    .sort((a, b) => {
      const ai = PARAM_ORDER.indexOf(a.key);
      const bi = PARAM_ORDER.indexOf(b.key);
      if (ai !== -1 || bi !== -1) {
        return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
      }
      return a.label.localeCompare(b.label);
    });
}

export function alertPriority(alert: NwsAlert): number {
  let score = EVENT_PRIORITY.find(([pattern]) => pattern.test(alert.event))?.[1] ?? 100;
  const upper = `${alert.event} ${alert.headline ?? ""} ${alert.description}`.toUpperCase();
  if (upper.includes("TORNADO EMERGENCY") || upper.includes("FLASH FLOOD EMERGENCY")) score += 350;
  if (upper.includes("PARTICULARLY DANGEROUS SITUATION")) score += 180;
  score += SEVERITY_PRIORITY[alert.severity] ?? 0;
  score += URGENCY_PRIORITY[alert.urgency] ?? 0;
  score += CERTAINTY_PRIORITY[alert.certainty] ?? 0;
  score += threatScore(param(alert.parameters, "tornadoDetection"));
  score += threatScore(param(alert.parameters, "tornadoDamageThreat"));
  score += threatScore(param(alert.parameters, "flashFloodDetection"));
  score += threatScore(param(alert.parameters, "flashFloodDamageThreat"));
  score += threatScore(param(alert.parameters, "thunderstormDamageThreat"));
  score += Math.min(numericParam(alert, "maxHailSize") * 20, 80);
  score += Math.min(Math.max(windMph(alert) - 50, 0) * 2, 100);
  return score;
}

export function formatTimeLeft(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const totalMin = Math.max(1, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} ${m === 1 ? "minute" : "minutes"}`;
  if (m === 0) return `${h} ${h === 1 ? "hour" : "hours"}`;
  return `${h}h ${m}m`;
}

export function alertSummaryFacts(alert: NwsAlert, now = Date.now()): HumanAlertParameter[] {
  const rows: HumanAlertParameter[] = [];
  const add = (key: string, label: string, value?: string) => {
    if (value) rows.push({ key, label, value });
  };
  const sections = parseDescriptionSections(alert.description);
  const tornado = param(alert.parameters, "tornadoDetection");
  const tornadoDamage = param(alert.parameters, "tornadoDamageThreat");
  const flashFlood = param(alert.parameters, "flashFloodDetection");
  const flashDamage = param(alert.parameters, "flashFloodDamageThreat");
  const hail = param(alert.parameters, "maxHailSize");
  const hailSource = param(alert.parameters, "hailThreat");
  const wind = param(alert.parameters, "maxWindGust");
  const windSource = param(alert.parameters, "windThreat");
  const damage = param(alert.parameters, "thunderstormDamageThreat");
  const motion = param(alert.parameters, "eventMotionDescription");
  const expires = Date.parse(alert.expires);

  add("tornadoDetection", "Tornado", tornado ? titleCase(tornado) : undefined);
  add("tornadoDamageThreat", "Tornado Damage", tornadoDamage ? titleCase(tornadoDamage) : undefined);
  add("flashFloodDetection", "Flash Flood", flashFlood ? titleCase(flashFlood) : undefined);
  add("flashFloodDamageThreat", "Flood Damage", flashDamage ? titleCase(flashDamage) : undefined);
  add(
    "maxHailSize",
    "Hail",
    hail ? [formatHail(hail), hailSource && titleCase(hailSource)].filter(Boolean).join(", ") : undefined,
  );
  add(
    "maxWindGust",
    "Wind",
    wind ? [formatWind(wind), windSource && titleCase(windSource)].filter(Boolean).join(", ") : undefined,
  );
  add("thunderstormDamageThreat", "Damage Threat", damage ? titleCase(damage) : undefined);
  add("eventMotionDescription", "Motion", motion ? formatMotion(motion) : undefined);
  addSectionFact(rows, sections, "WHAT", "What");
  addSectionFact(rows, sections, "HAZARD", "Hazard");
  addSectionFact(rows, sections, "SOURCE", "Source");
  addSectionFact(rows, sections, "WHEN", "When");
  addSectionFact(rows, sections, "TIMING", "Timing");
  addSectionFact(rows, sections, "WINDS", "Winds");
  addSectionFact(rows, sections, "RELATIVE HUMIDITY", "Humidity");
  addSectionFact(rows, sections, "VISIBILITY", "Visibility");
  addSectionFact(rows, sections, "WAVES", "Waves");
  addSectionFact(rows, sections, "IMPACTS", "Impacts");
  addSectionFact(rows, sections, "IMPACT", "Impact");
  addSectionFact(rows, sections, "ADDITIONAL DETAILS", "Details");
  add("expires", "Expires", Number.isNaN(expires) ? undefined : `in ${formatTimeLeft(expires - now)}`);
  return rows;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return "00:00";
  const total = Math.floor(ms / 1000);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hh > 0 ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}
