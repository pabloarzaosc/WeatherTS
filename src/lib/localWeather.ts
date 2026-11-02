/**
 * Local weather for a US point, straight from api.weather.gov (public domain,
 * CORS open): the alerts in force there, current conditions from the nearest
 * reporting station, the next 24 hours and the 7-day forecast with the
 * forecaster's own words, and the office that writes it.
 *
 * One /points call resolves the place (forecast grid, office, stations); the
 * rest go out together. Each part can fail on its own -- a gridpoint forecast
 * is sometimes a 500 for a minute -- so the card shows what came back.
 */

import { fetchActiveAlerts, type AlertFeature } from "./nwsAlerts";

const API = "https://api.weather.gov";

export class OutsideUsError extends Error {
  constructor() {
    super("Local weather covers the US and its territories (api.weather.gov has no forecast here).");
  }
}

export interface LocalObs {
  station: string;
  name: string;
  km: number;
  /** ms */
  time: number;
  tempC: number | null;
  dewC: number | null;
  rh: number | null;
  windDeg: number | null;
  windKmh: number | null;
  gustKmh: number | null;
  /** Sea-level pressure when reported, else station pressure (Pa). */
  pressurePa: number | null;
  visM: number | null;
  heatIndexC: number | null;
  windChillC: number | null;
  max24C: number | null;
  min24C: number | null;
  precip1hMm: number | null;
  text: string;
  clouds: string;
}

export interface LocalPeriod {
  name: string;
  /** ms */
  start: number;
  end: number;
  isDay: boolean;
  tempF: number | null;
  pop: number | null;
  wind: string;
  windDir: string;
  short: string;
  detailed: string;
  dewC: number | null;
  rh: number | null;
}

export interface LocalWeather {
  lat: number;
  lon: number;
  /** "Norman, OK", or "4 mi NE of Norman, OK" away from the town. */
  place: string;
  wfo: string;
  timeZone: string | null;
  radar: string | null;
  link: string;
  obs: LocalObs | null;
  obsError: string | null;
  hourly: LocalPeriod[];
  daily: LocalPeriod[];
  forecastError: string | null;
  updated: number | null;
  alerts: AlertFeature[];
  alertsError: string | null;
}

const coord = (v: number) => String(Number(v.toFixed(4)));

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { Accept: "application/geo+json" } });
  if (res.status === 404 && url.includes("/points/")) throw new OutsideUsError();
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { detail?: string; title?: string };
      detail = body.detail || body.title || detail;
    } catch {
      /* keep the status text */
    }
    throw new Error(`api.weather.gov ${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

interface Qv {
  value: number | null;
  qualityControl?: string;
}
const qv = (q: Qv | undefined | null): number | null =>
  q && q.value != null && Number.isFinite(q.value) && q.qualityControl !== "X" ? q.value : null;

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

function kmBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const h =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const COVER: Record<string, string> = {
  SKC: "Clear", CLR: "Clear", FEW: "Few clouds", SCT: "Scattered clouds", BKN: "Broken clouds", OVC: "Overcast", VV: "Sky obscured",
};

function cloudText(layers: Array<{ amount?: string; base?: Qv }> | undefined): string {
  if (!layers?.length) return "";
  // the most covering layer names the sky; its base, in feet, says how low
  const order = ["SKC", "CLR", "FEW", "SCT", "BKN", "OVC", "VV"];
  const top = [...layers].sort((a, b) => order.indexOf(b.amount ?? "") - order.indexOf(a.amount ?? ""))[0];
  const base = qv(top.base);
  const name = COVER[top.amount ?? ""] ?? top.amount ?? "";
  return base != null && top.amount !== "SKC" && top.amount !== "CLR" ? `${name} at ${Math.round((base * 3.28084) / 100) * 100} ft` : name;
}

interface ObsProps {
  stationId?: string;
  stationName?: string;
  timestamp: string;
  textDescription?: string;
  temperature?: Qv;
  dewpoint?: Qv;
  relativeHumidity?: Qv;
  windDirection?: Qv;
  windSpeed?: Qv;
  windGust?: Qv;
  seaLevelPressure?: Qv;
  barometricPressure?: Qv;
  visibility?: Qv;
  heatIndex?: Qv;
  windChill?: Qv;
  maxTemperatureLast24Hours?: Qv;
  minTemperatureLast24Hours?: Qv;
  precipitationLastHour?: Qv;
  cloudLayers?: Array<{ amount?: string; base?: Qv }>;
}

function toObs(p: ObsProps, station: string, name: string, km: number): LocalObs {
  const tempC = qv(p.temperature);
  const dewC = qv(p.dewpoint);
  let rh = qv(p.relativeHumidity);
  if (rh == null && tempC != null && dewC != null) {
    // Magnus formula, when the station leaves humidity out
    const es = (t: number) => Math.exp((17.625 * t) / (243.04 + t));
    rh = (100 * es(dewC)) / es(tempC);
  }
  return {
    station,
    name,
    km,
    time: Date.parse(p.timestamp),
    tempC,
    dewC,
    rh,
    windDeg: qv(p.windDirection),
    windKmh: qv(p.windSpeed),
    gustKmh: qv(p.windGust),
    pressurePa: qv(p.seaLevelPressure) ?? qv(p.barometricPressure),
    visM: qv(p.visibility),
    heatIndexC: qv(p.heatIndex),
    windChillC: qv(p.windChill),
    max24C: qv(p.maxTemperatureLast24Hours),
    min24C: qv(p.minTemperatureLast24Hours),
    precip1hMm: qv(p.precipitationLastHour),
    text: p.textDescription ?? "",
    clouds: cloudText(p.cloudLayers),
  };
}

/** How complete a report is, for picking between nearby stations. */
const filled = (o: LocalObs) =>
  [o.tempC, o.dewC, o.windKmh, o.pressurePa, o.visM].filter((v) => v != null).length;

async function nearestObs(stationsUrl: string, lat: number, lon: number, signal?: AbortSignal): Promise<LocalObs | null> {
  const st = await getJson<{ features: Array<{ geometry: { coordinates: [number, number] }; properties: { stationIdentifier: string; name: string } }> }>(
    `${stationsUrl}?limit=4`,
    signal,
  );
  const near = st.features
    .map((f) => ({
      id: f.properties.stationIdentifier,
      name: f.properties.name,
      km: kmBetween(lat, lon, f.geometry.coordinates[1], f.geometry.coordinates[0]),
    }))
    .sort((a, b) => a.km - b.km)
    .slice(0, 3);
  const got = await Promise.allSettled(
    near.map((s) =>
      getJson<{ properties: ObsProps }>(`${API}/stations/${s.id}/observations/latest`, signal).then((r) =>
        toObs(r.properties, s.id, s.name, s.km),
      ),
    ),
  );
  const fresh = Date.now() - 2 * 3600_000;
  const ok = got
    .map((g) => (g.status === "fulfilled" ? g.value : null))
    .filter((o): o is LocalObs => !!o && o.tempC != null && o.time > fresh);
  if (!ok.length) return null;
  // nearest first, unless a slightly farther station reports much more
  return ok.reduce((best, o) => (filled(o) >= filled(best) + 2 && o.km < best.km + 25 ? o : best), ok[0]);
}

interface RawPeriod {
  name: string;
  startTime: string;
  endTime: string;
  isDaytime: boolean;
  temperature: number | null;
  probabilityOfPrecipitation?: Qv;
  windSpeed?: string;
  windDirection?: string;
  shortForecast?: string;
  detailedForecast?: string;
  dewpoint?: Qv;
  relativeHumidity?: Qv;
}

const period = (p: RawPeriod): LocalPeriod => ({
  name: p.name,
  start: Date.parse(p.startTime),
  end: Date.parse(p.endTime),
  isDay: p.isDaytime,
  tempF: p.temperature,
  pop: qv(p.probabilityOfPrecipitation),
  wind: p.windSpeed ?? "",
  windDir: p.windDirection ?? "",
  short: p.shortForecast ?? "",
  detailed: p.detailedForecast ?? "",
  dewC: qv(p.dewpoint),
  rh: qv(p.relativeHumidity),
});

export async function fetchLocalWeather(lat: number, lon: number, signal?: AbortSignal): Promise<LocalWeather> {
  const pt = await getJson<{
    properties: {
      cwa: string;
      forecast: string | null;
      forecastHourly: string | null;
      observationStations: string;
      timeZone?: string;
      radarStation?: string;
      relativeLocation?: { properties: { city: string; state: string; distance?: Qv; bearing?: Qv } };
    };
  }>(`${API}/points/${coord(lat)},${coord(lon)}`, signal);
  const p = pt.properties;
  const rel = p.relativeLocation?.properties;
  let place = rel ? `${rel.city}, ${rel.state}` : `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  const dist = qv(rel?.distance);
  const bearing = qv(rel?.bearing);
  // relativeLocation names the town the point is near and how far, from it
  if (rel && dist != null && dist > 3000 && bearing != null) place = `${Math.round(dist / 1609.344)} mi ${compass(bearing)} of ${place}`;

  const [obs, fc, hr, al] = await Promise.allSettled([
    nearestObs(p.observationStations, lat, lon, signal),
    p.forecast ? getJson<{ properties: { periods: RawPeriod[]; updateTime?: string; generatedAt?: string } }>(p.forecast, signal) : Promise.reject(new Error("No forecast for this point")),
    p.forecastHourly ? getJson<{ properties: { periods: RawPeriod[] } }>(p.forecastHourly, signal) : Promise.reject(new Error("No hourly forecast for this point")),
    fetchActiveAlerts(signal, { point: { lat: Number(coord(lat)), lon: Number(coord(lon)) } }),
  ]);
  const now = Date.now();
  const why = (r: PromiseSettledResult<unknown>) => (r.status === "rejected" ? String((r.reason as Error)?.message ?? r.reason) : null);
  return {
    lat,
    lon,
    place,
    wfo: p.cwa,
    timeZone: p.timeZone ?? null,
    radar: p.radarStation ?? null,
    link: `https://forecast.weather.gov/MapClick.php?lat=${coord(lat)}&lon=${coord(lon)}`,
    obs: obs.status === "fulfilled" ? obs.value : null,
    obsError: obs.status === "fulfilled" ? (obs.value ? null : "No station nearby has reported in the last 2 hours.") : why(obs),
    hourly: hr.status === "fulfilled" ? hr.value.properties.periods.map(period).filter((x) => x.end > now).slice(0, 24) : [],
    daily: fc.status === "fulfilled" ? fc.value.properties.periods.map(period).filter((x) => x.end > now) : [],
    forecastError: why(fc) ?? why(hr),
    updated:
      fc.status === "fulfilled"
        ? Date.parse(fc.value.properties.updateTime ?? fc.value.properties.generatedAt ?? "") || null
        : null,
    alerts: al.status === "fulfilled" ? al.value.filter((f) => f.alert.messageType !== "Cancel") : [],
    alertsError: why(al),
  };
}
