import type { LayerSpecification, Map as MapLibreMap } from "maplibre-gl";

import { VECTOR_SOURCE } from "../../map/basemaps";

/**
 * The basemap's country, state and city names, copied above a product that
 * covers the map -- an opaque satellite picture hides the basemap's own names
 * completely. Bright text on a dark halo, the way the imagery basemaps draw
 * them, so they read over cloud and over bare ground alike.
 */

const nameField = ["coalesce", ["get", "name:latin"], ["get", "name_en"], ["get", "name"]] as never;

export function refLabelIds(prefix: string): string[] {
  return [`${prefix}-place-country`, `${prefix}-place-state`, `${prefix}-place-city`];
}

export function addRefLabels(map: MapLibreMap, prefix: string): void {
  if (!map.getSource(VECTOR_SOURCE)) return;
  const [country, state, city] = refLabelIds(prefix);
  const layers: LayerSpecification[] = [
    {
      id: country,
      type: "symbol",
      source: VECTOR_SOURCE,
      "source-layer": "place",
      filter: ["==", ["get", "class"], "country"],
      layout: {
        "text-field": nameField,
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 2, 13, 5, 17],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.08,
      },
      paint: { "text-color": "#f2f6f7", "text-halo-color": "rgba(8, 12, 16, 0.9)", "text-halo-width": 1.6 },
    },
    {
      id: state,
      type: "symbol",
      source: VECTOR_SOURCE,
      "source-layer": "place",
      minzoom: 3,
      maxzoom: 7,
      filter: ["==", ["get", "class"], "state"],
      layout: {
        "text-field": nameField,
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 3, 11, 6, 15],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.14,
      },
      paint: { "text-color": "#eef3f5", "text-halo-color": "rgba(8, 12, 16, 0.88)", "text-halo-width": 1.5 },
    },
    {
      id: city,
      type: "symbol",
      source: VECTOR_SOURCE,
      "source-layer": "place",
      minzoom: 5,
      filter: ["in", ["get", "class"], ["literal", ["city", "town"]]],
      layout: {
        "text-field": nameField,
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 5, 10, 8, 13, 12, 16],
      },
      paint: { "text-color": "#e6edf0", "text-halo-color": "rgba(8, 12, 16, 0.88)", "text-halo-width": 1.5 },
    },
  ];
  for (const layer of layers) if (!map.getLayer(layer.id)) map.addLayer(layer);
}

export function setRefLabelsVisible(map: MapLibreMap, prefix: string, on: boolean): void {
  for (const id of refLabelIds(prefix)) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  }
}

export function removeRefLabels(map: MapLibreMap, prefix: string): void {
  for (const id of refLabelIds(prefix)) if (map.getLayer(id)) map.removeLayer(id);
}
