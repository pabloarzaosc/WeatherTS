import type { Map as MapLibreMap, RasterTileSource } from "maplibre-gl";

import type { LayerModule } from "../types";
import { NWM_BASE, NWM_PRODUCTS, type NwmProduct } from "../../lib/rivers";
import { useRiverStore } from "../../store/useRiverStore";

const SRC = "nwm-src";
const LAYER = "nwm-raster";
const DEFAULT_OPACITY = 0.9;
/** The analysis is hourly and the forecasts come every hour or six: tiles are
 *  asked for again when the hour turns. */
const REFRESH_MS = 5 * 60_000;

interface PaneState {
  unsub: () => void;
  timer: number;
  hour: number;
}
const state = new WeakMap<MapLibreMap, PaneState>();
let opacity = DEFAULT_OPACITY;

function product(): NwmProduct {
  const id = useRiverStore.getState().nwm;
  return NWM_PRODUCTS.find((p) => p.id === id) ?? NWM_PRODUCTS[0];
}

/** The service's export image for each tile, in web mercator, transparent. */
function tiles(p: NwmProduct, hour: number): string[] {
  return [
    `${NWM_BASE}/${p.service}/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512` +
      `&format=png32&transparent=true&dpi=96&f=image&layers=show:${p.layer}&_h=${hour}`,
  ];
}

const nowHour = () => Math.floor(Date.now() / 3_600_000);

function build(map: MapLibreMap, hour: number) {
  const p = product();
  if (map.getLayer(LAYER)) map.removeLayer(LAYER);
  if (map.getSource(SRC)) map.removeSource(SRC);
  map.addSource(SRC, {
    type: "raster",
    tiles: tiles(p, hour),
    tileSize: 512,
    attribution: "NOAA National Water Model",
  });
  map.addLayer({
    id: LAYER,
    type: "raster",
    source: SRC,
    minzoom: p.minzoom ?? 0,
    paint: { "raster-opacity": opacity, "raster-fade-duration": 0, "raster-resampling": "nearest" },
  });
}

/** The National Water Model's streams in high flow, now and forecast, and
 *  where it puts the land under water: NOAA's own maps of it. */
export const nwmLayer: LayerModule = {
  id: "nwm",
  name: "National Water Model",
  description:
    "NOAA's National Water Model over the US: streams in high flow now and forecast, rapid onset flooding, the chance of high water, the inundation extent. Pick the product in the Flooding panel.",
  category: "weather",
  source: "NOAA Office of Water Prediction (maps.water.noaa.gov)",
  defaultVisible: false,
  defaultOpacity: DEFAULT_OPACITY,

  addTo(map) {
    const hour = nowHour();
    build(map, hour);
    const st: PaneState = { unsub: () => {}, timer: 0, hour };
    // A new product is new tiles in the same source and layer, so the layer
    // keeps its place in the stack.
    st.unsub = useRiverStore.subscribe((s, prev) => {
      if (s.nwm === prev.nwm || !map.getLayer(LAYER)) return;
      const p = product();
      (map.getSource(SRC) as RasterTileSource | undefined)?.setTiles(tiles(p, st.hour));
      map.setLayerZoomRange(LAYER, p.minzoom ?? 0, 24);
    });
    st.timer = window.setInterval(() => {
      const h = nowHour();
      if (h === st.hour) return;
      st.hour = h;
      (map.getSource(SRC) as RasterTileSource | undefined)?.setTiles(tiles(product(), h));
    }, REFRESH_MS);
    state.set(map, st);
  },

  removeFrom(map) {
    const st = state.get(map);
    if (st) {
      st.unsub();
      window.clearInterval(st.timer);
      state.delete(map);
    }
    if (map.getLayer(LAYER)) map.removeLayer(LAYER);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },

  setOpacity(map, o) {
    opacity = o;
    if (map.getLayer(LAYER)) map.setPaintProperty(LAYER, "raster-opacity", o);
  },

  getLayerIds() {
    return [LAYER];
  },
};
