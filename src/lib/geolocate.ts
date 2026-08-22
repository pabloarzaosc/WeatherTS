import maplibregl, { type Marker } from "maplibre-gl";
import { getMap } from "../map/mapInstance";

let marker: Marker | null = null;

/** Drop (or move) a pulsing "you are here" dot at the given coordinates. */
function showLocationMarker(lng: number, lat: number): void {
  const map = getMap();
  if (!map) return;
  if (marker) marker.remove();

  const el = document.createElement("div");
  el.className = "loc-marker";
  const pulse = document.createElement("span");
  pulse.className = "loc-marker__pulse";
  const dot = document.createElement("span");
  dot.className = "loc-marker__dot";
  el.append(pulse, dot);

  marker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
}

/**
 * Where the browser thinks it is, when the device itself will not say.
 *
 * Electron ships without the Google API key Chromium's network location
 * service wants, so on the desktop `navigator.geolocation` answers every
 * request with "Failed to query location from network service" -- not a
 * permission problem and not something the user can fix, just a dead feature
 * with a confusing message under it. Windows may or may not offer a platform
 * provider depending on the build, so the failure is not even consistent.
 *
 * The trade is worth stating plainly: this asks a third party what location
 * an IP address maps to, so the address is seen by whichever service answers.
 * It is only reached after the device has already refused or failed, never
 * before, and never after an outright permission denial -- see watchPosition.
 */
/** A coordinate, whatever shape the provider chose to send it in. GeoJS sends
 *  strings; the others send numbers. */
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Three of them, because any one is a free service that can be down, rate
 *  limited, or blocked on the network the user happens to be on. Each entry
 *  returns [lat, lon, accuracy in metres] or null if the answer is unusable. */
const IP_PROVIDERS: { url: string; read: (json: unknown) => [number, number, number | null] | null }[] = [
  {
    url: "https://ipwho.is/",
    read: (json) => {
      const d = json as { success?: boolean; latitude?: unknown; longitude?: unknown };
      if (d.success === false) return null;
      const lat = num(d.latitude);
      const lon = num(d.longitude);
      return lat != null && lon != null ? [lat, lon, null] : null;
    },
  },
  {
    url: "https://get.geojs.io/v1/ip/geo.json",
    read: (json) => {
      const d = json as { latitude?: unknown; longitude?: unknown; accuracy?: unknown };
      const lat = num(d.latitude);
      const lon = num(d.longitude);
      if (lat == null || lon == null) return null;
      // GeoJS reports accuracy in kilometres.
      const km = num(d.accuracy);
      return [lat, lon, km != null ? km * 1000 : null];
    },
  },
  {
    url: "https://api.ipbase.com/v1/json/",
    read: (json) => {
      const d = json as { latitude?: unknown; longitude?: unknown };
      const lat = num(d.latitude);
      const lon = num(d.longitude);
      return lat != null && lon != null ? [lat, lon, null] : null;
    },
  },
];

/** What an IP fix is worth in metres. Providers do not report an accuracy, and
 *  claiming none would let a caller treat a city as a street corner. */
const IP_ACCURACY_M = 25000;

export async function networkLocate(timeoutMs = 6000): Promise<Fix | null> {
  for (const provider of IP_PROVIDERS) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const res = await fetch(provider.url, { signal: abort.signal });
      if (!res.ok) continue;
      const parsed = provider.read((await res.json()) as never);
      if (!parsed) continue;
      const [lat, lon, accuracy] = parsed;
      return {
        lat,
        lon,
        accuracy: accuracy ?? IP_ACCURACY_M,
        heading: null,
        speed: null,
        at: Date.now(),
        source: "network",
      };
    } catch {
      // A provider that is down, rate-limited or blocked is why there is a
      // list. Only an empty list is a failure.
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

const toFix = (pos: GeolocationPosition): Fix => {
  const c = pos.coords;
  return {
    lat: c.latitude,
    lon: c.longitude,
    accuracy: Number.isFinite(c.accuracy) ? c.accuracy : null,
    // Both are null when stationary, and NaN on some devices; either way
    // there is no heading to report rather than a heading of zero.
    heading: c.heading != null && Number.isFinite(c.heading) ? c.heading : null,
    speed: c.speed != null && Number.isFinite(c.speed) ? c.speed : null,
    at: pos.timestamp,
    source: "device",
  };
};

const devicePosition = (options: PositionOptions) =>
  new Promise<GeolocationPosition>((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Geolocation unavailable"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });

/**
 * One fix, from the device if it can, from the network if it cannot.
 *
 * A refused permission is a decision, not a failure, so it is passed straight
 * back out: quietly falling back to an IP lookup after someone has said no
 * would be locating them anyway, by another route.
 */
export async function currentFix(options: PositionOptions = {}): Promise<Fix> {
  try {
    return toFix(await devicePosition({ enableHighAccuracy: true, timeout: 8000, ...options }));
  } catch (err) {
    const code = (err as GeolocationPositionError | undefined)?.code;
    if (code === 1) throw err;
    const fix = await networkLocate();
    if (fix) return fix;
    throw err;
  }
}

/** Center the map on the device's current position (browser Geolocation API)
 *  and mark it. Depends on the browser granting location access.
 *  Rejects if unavailable/denied. */
export async function flyToMyLocation(): Promise<void> {
  const fix = await currentFix({ maximumAge: 60000 });
  const map = getMap();
  // A network fix knows the city, so flying to street level would be showing
  // a precision the number does not have.
  const zoom = fix.source === "device" ? 11 : 8;
  map?.flyTo({
    center: [fix.lon, fix.lat],
    zoom: Math.max(map.getZoom(), zoom),
    essential: true,
  });
  showLocationMarker(fix.lon, fix.lat);
}

export interface Fix {
  lat: number;
  lon: number;
  /** Metres, as reported by the device. */
  accuracy: number | null;
  /** Degrees true, only while actually moving. */
  heading: number | null;
  /** Metres per second. */
  speed: number | null;
  /** When the device took the reading, unix ms. */
  at: number;
  /** Where the reading came from. A "network" fix is an IP lookup: the right
   *  city, usually, and nothing finer. Anything that draws a fix should read
   *  `accuracy` rather than assume metres. */
  source: FixSource;
}

export type FixSource = "device" | "network";

/**
 * Follow the device's position until the returned function is called.
 *
 * Separate from flyToMyLocation, which answers "where am I" once and moves the
 * camera. This one never touches the camera -- a map that yanks itself back
 * every few seconds is unusable while you are also trying to look ahead of the
 * storm -- it only reports fixes.
 */
export function watchPosition(
  onFix: (fix: Fix) => void,
  onError?: (err: GeolocationPositionError) => void,
): () => void {
  if (!("geolocation" in navigator)) {
    onError?.({
      code: 2,
      message: "Geolocation unavailable",
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3,
    } as GeolocationPositionError);
    return () => {};
  }

  // The device is always preferred, and takes over the moment it produces
  // anything -- the fallback below is what runs while it produces nothing.
  let deviceAnswered = false;
  let netTimer: ReturnType<typeof setInterval> | null = null;
  let netStarted = false;

  const stopNetwork = () => {
    if (netTimer) clearInterval(netTimer);
    netTimer = null;
  };

  const startNetwork = (cause: GeolocationPositionError) => {
    if (netStarted) return;
    netStarted = true;
    const tick = async () => {
      if (deviceAnswered) {
        stopNetwork();
        return;
      }
      const fix = await networkLocate();
      if (deviceAnswered) return;
      if (fix) onFix(fix);
      else if (!netTimer) onError?.(cause);
    };
    void tick().then(() => {
      // Only keep polling if the first attempt is what kept the feature alive.
      // An IP address moves when the network does, which for a chaser on a
      // phone hotspot is often enough to be worth re-reading, and rarely
      // enough that ten minutes is not a slow interval.
      if (!deviceAnswered && !netTimer) netTimer = setInterval(() => void tick(), 600000);
    });
  };

  const id = navigator.geolocation.watchPosition(
    (pos) => {
      deviceAnswered = true;
      stopNetwork();
      onFix(toFix(pos));
    },
    (err) => {
      // A refusal is an answer. Reaching for the network after it would be
      // locating someone who has just said not to.
      if (err.code === err.PERMISSION_DENIED) {
        onError?.(err);
        return;
      }
      startNetwork(err);
    },
    // No maximumAge: a cached fix from before the last few miles of driving is
    // worse than waiting for a real one when the whole point is where you are
    // right now.
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
  );
  return () => {
    stopNetwork();
    navigator.geolocation.clearWatch(id);
  };
}
