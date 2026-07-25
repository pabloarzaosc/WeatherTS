import type { LayerModule } from "../types";

const SOURCE_ID = "ne-countries";
const LINE_LAYER = "ne-countries-line";
// Bundled at build time from public/ — fully offline, no network needed.
const DATA_URL = "/data/ne_110m_admin_0_countries.geojson";
const LINE_COLOR = "#7d97bd"; // tuned for the gray basemap

/** Country outlines from a bundled Natural Earth file (public domain). */
export const boundariesLayer: LayerModule = {
  id: "boundaries",
  name: "Country Boundaries",
  description: "Natural Earth 1:110m admin-0 outlines (bundled, offline).",
  category: "boundaries",
  source: "Natural Earth · public domain",
  defaultVisible: true,
  defaultOpacity: 0.75,

  addTo(map) {
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, { type: "geojson", data: DATA_URL });
    }
    if (!map.getLayer(LINE_LAYER)) {
      map.addLayer({
        id: LINE_LAYER,
        type: "line",
        source: SOURCE_ID,
        paint: {
          "line-color": LINE_COLOR,
          "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.4, 5, 1, 9, 1.8],
          "line-opacity": 0.75,
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
