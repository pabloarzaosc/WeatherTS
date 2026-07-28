import { getMap } from "../map/mapInstance";
import { useAppStore } from "../store/useAppStore";
import { useNexradStore } from "../store/useNexradStore";
import type { NexradSite } from "./nexrad";
import { alertBounds, alertCentroid, alertWithinKm, distanceKm } from "./nwsAlerts";

/**
 * Framing an alert and pointing the radar at it, in one place.
 *
 * Both the alert rail and a clicked desktop notification need to do this. Two
 * copies would drift, and the notification path is the one nobody exercises by
 * hand -- it would be the copy that quietly stopped matching.
 */

/**
 * Ids of the alerts whose footprint reaches into the watch area. Shared by the
 * rail (which marks them) and the notifier (which announces them), so the badge
 * and the toast can never disagree about what counts as "yours".
 */
export function alertsInArea(
  features: { alert: { id: string }; geometry: GeoJSON.Geometry | null }[],
  center: [number, number] | null,
  radiusKm: number,
): Set<string> {
  const hits = new Set<string>();
  if (!center) return hits;
  for (const f of features) {
    if (alertWithinKm(f.geometry, center, radiusKm)) hits.add(f.alert.id);
  }
  return hits;
}

/** The `n` closest online radar sites to a point, nearest first. */
export function nearestSites(
  center: [number, number],
  sites: NexradSite[],
  n = 2,
): { site: NexradSite; km: number }[] {
  return sites
    .filter((s) => s.online !== false && Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .map((s) => ({ site: s, km: distanceKm(center, [s.lon, s.lat]) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, n);
}

/** Puts the whole footprint on screen; falls back to its centre point. */
export function frameAlert(geometry: GeoJSON.Geometry | null): boolean {
  const map = getMap();
  if (!map) return false;
  const b = alertBounds(geometry);
  if (b) {
    // Padding keeps the outline off the panel edges, where the rail overlaps.
    map.fitBounds(b, { padding: 80, maxZoom: 9, essential: true });
    return true;
  }
  const c = alertCentroid(geometry);
  if (!c) return false;
  map.flyTo({ center: c, zoom: Math.max(map.getZoom(), 7.2), essential: true });
  return true;
}

/** Turns the radar on and tunes it to whichever site covers the alert best. */
export function pointRadarAt(geometry: GeoJSON.Geometry | null): NexradSite | null {
  const center = alertCentroid(geometry);
  if (!center) return null;
  const { sites, selectSite } = useNexradStore.getState();
  const pick = nearestSites(center, sites, 1)[0];
  if (!pick) return null;
  useAppStore.getState().setLayerVisible("nexrad", true);
  selectSite(pick.site.id);
  return pick.site;
}

/** Frame the alert, and optionally bring the nearest radar up with it. */
export function focusAlert(
  geometry: GeoJSON.Geometry | null,
  { withRadar = false }: { withRadar?: boolean } = {},
): void {
  if (withRadar) {
    // The catalog is loaded lazily by the radar panel, and a notification can
    // arrive before it was ever opened.
    void useNexradStore
      .getState()
      .loadCatalog()
      .then(() => {
        pointRadarAt(geometry);
        frameAlert(geometry);
      });
    return;
  }
  frameAlert(geometry);
}
