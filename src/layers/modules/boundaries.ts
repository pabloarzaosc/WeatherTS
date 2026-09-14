import type { Map as MapLibreMap } from "maplibre-gl";

import type { LayerModule } from "../types";
import { VECTOR_SOURCE } from "../../map/basemaps";

const SOURCE_ID = "ne-countries";
const LINE_LAYER = "ne-countries-line";
const COAST = "ref-coastline";
const COUNTRY = "ref-country-line";
const STATE = "ref-state-line";
const CASING = "ref-country-casing";
const ALL = [CASING, COAST, STATE, COUNTRY, LINE_LAYER];

// Bundled at build time from public/ -- used only where the basemap has no
// vector tiles to draw from (the Blank basemap).
const DATA_URL = "/data/ne_110m_admin_0_countries.geojson";
const LINE_COLOR = "#7d97bd"; // tuned for the gray basemap
/** Over satellite the lines sit on white cloud as often as on dark ground; a
 *  faint dark edge under them keeps them readable on both. */
const VECTOR_LINE = "#a9c1e6";
const CASING_COLOR = "rgba(6, 10, 16, 0.55)";

const width = (a: number, b: number, c: number) =>
  ["interpolate", ["linear"], ["zoom"], 2, a, 6, b, 10, c] as never;

/**
 * Country, state and province borders and the coastline, drawn over every
 * product.
 *
 * They were Natural Earth's 1:110m outlines: a whole country in a few dozen
 * points, so at chase zoom a border ran in long straight segments and a coast
 * in right angles. The basemap's own vector tiles carry the same lines at a
 * detail that follows the zoom, and they are already being downloaded for the
 * basemap -- so the lines come from there, above the products instead of
 * buried under them. The bundled file remains for a basemap with no tiles.
 */
export const boundariesLayer: LayerModule = {
  id: "boundaries",
  name: "Country Boundaries",
  description: "Country, state and province borders and the coastline, at the detail of the zoom.",
  category: "boundaries",
  source: "OpenStreetMap via OpenFreeMap · Natural Earth (offline fallback)",
  defaultVisible: true,
  defaultOpacity: 0.75,

  addTo(map) {
    if (map.getSource(VECTOR_SOURCE)) {
      addVectorLines(map);
      return;
    }
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
    for (const id of ALL) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  },

  setOpacity(map, opacity) {
    if (map.getLayer(LINE_LAYER)) map.setPaintProperty(LINE_LAYER, "line-opacity", opacity);
    if (map.getLayer(CASING)) map.setPaintProperty(CASING, "line-opacity", opacity * 0.7);
    if (map.getLayer(COUNTRY)) map.setPaintProperty(COUNTRY, "line-opacity", opacity);
    if (map.getLayer(COAST)) map.setPaintProperty(COAST, "line-opacity", opacity * 0.9);
    // States and provinces are the secondary line and stay lighter than borders.
    if (map.getLayer(STATE)) map.setPaintProperty(STATE, "line-opacity", opacity * 0.6);
  },

  getLayerIds() {
    return ALL;
  },
};

function addVectorLines(map: MapLibreMap): void {
  if (!map.getLayer(CASING)) {
    map.addLayer({
      id: CASING,
      type: "line",
      source: VECTOR_SOURCE,
      "source-layer": "boundary",
      filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
      layout: { "line-join": "round" },
      paint: {
        "line-color": CASING_COLOR,
        "line-width": width(1.4, 2.4, 3.4),
        "line-opacity": 0.5,
        "line-blur": 0.6,
      },
    });
  }
  if (!map.getLayer(COAST)) {
    map.addLayer({
      id: COAST,
      type: "line",
      source: VECTOR_SOURCE,
      "source-layer": "water",
      filter: ["in", ["get", "class"], ["literal", ["ocean", "lake"]]],
      layout: { "line-join": "round" },
      paint: {
        "line-color": VECTOR_LINE,
        "line-width": width(0.35, 0.8, 1.3),
        "line-opacity": 0.68,
      },
    });
  }
  if (!map.getLayer(STATE)) {
    map.addLayer({
      id: STATE,
      type: "line",
      source: VECTOR_SOURCE,
      "source-layer": "boundary",
      minzoom: 2,
      filter: ["all", ["==", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]],
      layout: { "line-join": "round" },
      paint: {
        "line-color": VECTOR_LINE,
        "line-width": width(0.3, 0.6, 1.1),
        "line-opacity": 0.45,
        "line-dasharray": [3, 1.5],
      },
    });
  }
  if (!map.getLayer(COUNTRY)) {
    map.addLayer({
      id: COUNTRY,
      type: "line",
      source: VECTOR_SOURCE,
      "source-layer": "boundary",
      filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
      layout: { "line-join": "round" },
      paint: {
        "line-color": VECTOR_LINE,
        "line-width": width(0.5, 1.1, 1.9),
        "line-opacity": 0.75,
      },
    });
  }
}
