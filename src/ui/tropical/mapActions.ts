import { getMap } from "../../map/mapInstance";
import { useAppStore } from "../../store/useAppStore";
import { useTropicalStore } from "../../store/useTropicalStore";

export const STORMS_LAYER = "tropical-storms";
export const GUIDANCE_LAYER = "tropical-guidance";
export const WSP_LAYER = "tropical-wsp";
export const RECON_LAYER = "tropical-recon";
export const SEASON_LAYER = "tropical-season";
export const SST_LAYER = "tropical-sst";

/** Close the dashboard and put a layer on the map. */
export function showOnMap(layer: string, extra?: () => void): void {
  useAppStore.getState().setLayerVisible(layer, true);
  extra?.();
  useTropicalStore.getState().close();
}

/** Close the dashboard, put the storms and the storm's guidance on, and go to it. */
export function flyToStorm(s: { id: string; lat: number; lon: number }): void {
  useTropicalStore.getState().setStorm(s.id);
  useAppStore.getState().setLayerVisible(STORMS_LAYER, true);
  useAppStore.getState().setLayerVisible(GUIDANCE_LAYER, true);
  useTropicalStore.getState().close();
  getMap()?.flyTo({ center: [s.lon, s.lat], zoom: Math.max(getMap()?.getZoom() ?? 4, 4.5), essential: true });
}

/** Frame a set of positions. */
export function fitTo(points: [number, number][], maxZoom = 6): void {
  const map = getMap();
  if (!map || !points.length) return;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lon, lat] of points) {
    w = Math.min(w, lon);
    e = Math.max(e, lon);
    s = Math.min(s, lat);
    n = Math.max(n, lat);
  }
  map.fitBounds([[w, s], [e, n]], { padding: 60, maxZoom, duration: 800 });
}
