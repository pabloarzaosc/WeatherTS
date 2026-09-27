import type { Map as MapLibreMap } from "maplibre-gl";

import type { LayerModule } from "../types";
import { LAKES_SOURCE, VECTOR_SOURCE, chartInk } from "../../map/basemaps";
import { useAppStore } from "../../store/useAppStore";

const SOURCE_ID = "ne-countries";
const LINE_LAYER = "ne-countries-line";
const COAST = "ref-coastline";
const COUNTRY = "ref-country-line";
const STATE = "ref-state-line";
const CASING = "ref-country-casing";
/** A chart's lakes, from its zoom-5 copy of the tiles (see LAKES_SOURCE). */
const LAKES = "ref-lakes";
const ALL = [CASING, COAST, LAKES, STATE, COUNTRY, LINE_LAYER];

// Bundled at build time from public/ -- used only where the basemap has no
// vector tiles to draw from (the Blank basemap).
const DATA_URL = `${import.meta.env.BASE_URL}data/ne_110m_admin_0_countries.geojson`;
const LINE_COLOR = "#7d97bd"; // tuned for the gray basemap
/** Over bright imagery the lines sit on white as often as on dark ground; a
 *  faint dark edge under them keeps them readable on both. */
const VECTOR_LINE = "#a9c1e6";
const CASING_COLOR = "rgba(6, 10, 16, 0.55)";

const width = (a: number, b: number, c: number) =>
  ["interpolate", ["linear"], ["zoom"], 2, a, 6, b, 10, c] as never;

/** On a chart basemap the lines over the products are the chart's own: the
 *  same weight for every kind, and state lines solid, as a chart draws them. */
const onChart = () => chartInk(useAppStore.getState().basemapId) !== null;

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
    const chart = onChart();
    if (map.getLayer(LINE_LAYER)) map.setPaintProperty(LINE_LAYER, "line-opacity", opacity);
    if (map.getLayer(CASING)) map.setPaintProperty(CASING, "line-opacity", opacity * 0.7);
    if (map.getLayer(COUNTRY)) map.setPaintProperty(COUNTRY, "line-opacity", opacity);
    if (map.getLayer(COAST)) map.setPaintProperty(COAST, "line-opacity", opacity * (chart ? 1 : 0.9));
    if (map.getLayer(LAKES)) map.setPaintProperty(LAKES, "line-opacity", opacity);
    // States and provinces are the secondary line and stay lighter than borders
    // -- except on a chart, where they are ink like the rest and only thinner.
    if (map.getLayer(STATE)) map.setPaintProperty(STATE, "line-opacity", opacity * (chart ? 1 : 0.6));
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
  // A chart draws its lakes from their own source, only the big ones; the
  // coast here is then the sea's alone, or every reservoir would be back.
  const chartLakes = Boolean(map.getSource(LAKES_SOURCE));
  if (chartLakes && !map.getLayer(LAKES)) {
    map.addLayer({
      id: LAKES,
      type: "line",
      source: LAKES_SOURCE,
      "source-layer": "water",
      filter: ["==", ["get", "class"], "lake"],
      layout: { "line-join": "round" },
      paint: {
        "line-color": VECTOR_LINE,
        "line-width": width(0.35, 0.8, 1.3),
        "line-opacity": 0.68,
      },
    });
  }
  if (!map.getLayer(COAST)) {
    map.addLayer({
      id: COAST,
      type: "line",
      source: VECTOR_SOURCE,
      "source-layer": "water",
      filter: chartLakes ? ["==", ["get", "class"], "ocean"] : ["in", ["get", "class"], ["literal", ["ocean", "lake"]]],
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
        // The basemap is rebuilt, and these lines with it, when it changes.
        ...(onChart() ? {} : { "line-dasharray": [3, 1.5] }),
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
