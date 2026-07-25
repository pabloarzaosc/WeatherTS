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
