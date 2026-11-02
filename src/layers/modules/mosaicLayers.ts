/**
 * Radar mosaics where no single-site volumes are open: Canada's composite from
 * Environment Canada's GeoMet, as pictures per map tile; and Europe's from EUMETNET
 * OPERA (backend/opera_radar.py), one picture of the continent every five minutes.
 * Both show the newest and keep up with it.
 */
import type { ImageSource, Map as MapLibreMap, RasterTileSource } from "maplibre-gl";

import { BACKEND_BASE } from "../../lib/apiConfig";
import type { LayerModule } from "../types";

const REFRESH_MS = 5 * 60_000;
const GEOMET =
  "https://geo.weather.gc.ca/geomet?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&BBOX={bbox-epsg-3857}&CRS=EPSG:3857" +
  "&WIDTH=512&HEIGHT=512&FORMAT=image/png&TRANSPARENT=TRUE&LAYERS=";

const timers = new WeakMap<MapLibreMap, Map<string, number>>();

function keepUp(map: MapLibreMap, id: string, tick: () => void): void {
  const all = timers.get(map) ?? new Map<string, number>();
  timers.set(map, all);
  all.set(id, window.setInterval(tick, REFRESH_MS));
}

function stop(map: MapLibreMap, id: string): void {
  const all = timers.get(map);
  const timer = all?.get(id);
  if (timer !== undefined) window.clearInterval(timer);
  all?.delete(id);
}

function canada(id: string, name: string, wms: string): LayerModule {
  const source = `${id}-src`;
  const layer = `${id}-layer`;
  const tiles = () => [`${GEOMET}${wms}&_=${Math.floor(Date.now() / REFRESH_MS)}`];
  return {
    id,
    name,
    description: "Environment Canada's national radar composite at 1 km, every 6 minutes.",
    category: "weather",
    source: "Environment Canada, MSC GeoMet",
    defaultVisible: false,
    defaultOpacity: 0.85,
    addTo(map) {
      if (!map.getSource(source)) map.addSource(source, { type: "raster", tiles: tiles(), tileSize: 512, minzoom: 2, maxzoom: 9 });
      if (!map.getLayer(layer)) map.addLayer({ id: layer, type: "raster", source, paint: { "raster-opacity": 0.85 } });
      keepUp(map, id, () => (map.getSource(source) as RasterTileSource | undefined)?.setTiles(tiles()));
    },
    removeFrom(map) {
      stop(map, id);
      if (map.getLayer(layer)) map.removeLayer(layer);
      if (map.getSource(source)) map.removeSource(source);
    },
    setOpacity(map, o) {
      if (map.getLayer(layer)) map.setPaintProperty(layer, "raster-opacity", o);
    },
    getLayerIds() {
      return [layer];
    },
  };
}

const EU_ID = "mosaic-europe";
const EU_SRC = `${EU_ID}-src`;
const EU_LAYER = `${EU_ID}-layer`;

async function newestEurope(): Promise<{ url: string; coordinates: [[number, number], [number, number], [number, number], [number, number]] } | null> {
  const res = await fetch(`${BACKEND_BASE}/api/radar/mosaic/europe?hours=2`);
  if (!res.ok) return null;
  const { times, bounds } = (await res.json()) as { times: number[]; bounds: [number, number, number, number] };
  const t = times[times.length - 1];
  if (!t) return null;
  const [w, s, e, n] = bounds;
  return { url: `${BACKEND_BASE}/api/radar/mosaic/europe.png?t=${t}`, coordinates: [[w, n], [e, n], [e, s], [w, s]] };
}

const europe: LayerModule = {
  id: EU_ID,
  name: "Europe radar mosaic",
  description: "EUMETNET OPERA's maximum reflectivity composite of the European radars, every 5 minutes.",
  category: "weather",
  source: "EUMETNET OPERA Open Radar Data (CC BY 4.0)",
  defaultVisible: false,
  defaultOpacity: 0.85,
  addTo(map) {
    const show = async () => {
      const next = await newestEurope().catch(() => null);
      if (!next || !map.getStyle()) return;
      const src = map.getSource(EU_SRC) as ImageSource | undefined;
      if (src) {
        src.updateImage(next);
      } else {
        map.addSource(EU_SRC, { type: "image", ...next });
        if (!map.getLayer(EU_LAYER)) map.addLayer({ id: EU_LAYER, type: "raster", source: EU_SRC, paint: { "raster-opacity": 0.85, "raster-resampling": "nearest", "raster-fade-duration": 0 } });
      }
    };
    void show();
    keepUp(map, EU_ID, () => void show());
  },
  removeFrom(map) {
    stop(map, EU_ID);
    if (map.getLayer(EU_LAYER)) map.removeLayer(EU_LAYER);
    if (map.getSource(EU_SRC)) map.removeSource(EU_SRC);
  },
  setOpacity(map, o) {
    if (map.getLayer(EU_LAYER)) map.setPaintProperty(EU_LAYER, "raster-opacity", o);
  },
  getLayerIds() {
    return [EU_LAYER];
  },
};

export const mosaicLayers: LayerModule[] = [
  europe,
  canada("mosaic-canada-rain", "Canada radar mosaic (rain)", "RADAR_1KM_RRAI"),
  canada("mosaic-canada-snow", "Canada radar mosaic (snow)", "RADAR_1KM_RSNO"),
];
