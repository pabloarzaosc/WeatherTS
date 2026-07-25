import type { LayerModule } from "../types";
import { buildGraticule } from "../geo/graticule";

const SOURCE_ID = "graticule";
const LINE_LAYER = "graticule-line";
const LINE_COLOR = "#7f9ac4"; // tuned for the gray basemap

/** Lat/lon grid generated in-app (proves a runtime-built LayerModule). */
export const graticuleLayer: LayerModule = {
  id: "graticule",
  name: "Lat / Lon Graticule",
  description: "Coordinate grid generated in-app at 15° spacing.",
  category: "reference",
  source: "Generated client-side",
  defaultVisible: true,
  defaultOpacity: 0.35,

  addTo(map) {
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, { type: "geojson", data: buildGraticule(15) });
    }
    if (!map.getLayer(LINE_LAYER)) {
      map.addLayer({
        id: LINE_LAYER,
        type: "line",
        source: SOURCE_ID,
        paint: {
          "line-color": LINE_COLOR,
          "line-width": ["case", ["get", "major"], 1.2, 0.5],
          "line-opacity": 0.35,
          "line-dasharray": [2, 2.5],
        },
      });
    }
  },
  removeFrom(map) {
    if (map.getLayer(LINE_LAYER)) map.removeLayer(LINE_LAYER);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  },
  setOpacity(map, opacity) {
    if (map.getLayer(LINE_LAYER)) map.setPaintProperty(LINE_LAYER, "line-opacity", opacity);
  },
  getLayerIds() {
    return [LINE_LAYER];
  },
};
