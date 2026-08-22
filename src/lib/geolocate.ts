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

/** Center the map on the device's current position (browser Geolocation API)
 *  and mark it. Depends on the browser granting location access.
 *  Rejects if unavailable/denied. */
export function flyToMyLocation(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Geolocation unavailable"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { longitude, latitude } = pos.coords;
        const map = getMap();
        map?.flyTo({
          center: [longitude, latitude],
          zoom: Math.max(map.getZoom(), 11),
          essential: true,
        });
        showLocationMarker(longitude, latitude);
        resolve();
      },
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    );
  });
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
}

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

  const id = navigator.geolocation.watchPosition(
    (pos) => {
      const c = pos.coords;
      onFix({
        lat: c.latitude,
        lon: c.longitude,
        accuracy: Number.isFinite(c.accuracy) ? c.accuracy : null,
        // Both are null when stationary, and NaN on some devices; either way
        // there is no heading to report rather than a heading of zero.
        heading: c.heading != null && Number.isFinite(c.heading) ? c.heading : null,
        speed: c.speed != null && Number.isFinite(c.speed) ? c.speed : null,
        at: pos.timestamp,
      });
    },
    (err) => onError?.(err),
    // No maximumAge: a cached fix from before the last few miles of driving is
    // worse than waiting for a real one when the whole point is where you are
    // right now.
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
  );
  return () => navigator.geolocation.clearWatch(id);
}
