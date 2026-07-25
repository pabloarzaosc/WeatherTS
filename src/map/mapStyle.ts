import type { StyleSpecification } from "maplibre-gl";

/**
 * Fixed gray "weather workstation" basemap. It keeps OpenFreeMap vector tiles,
 * but avoids the stock dark palette so alert polygons read cleanly on top.
 */
export const MAP_STYLE: StyleSpecification = {
  version: 8,
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: {
    openmaptiles: {
      type: "vector",
      url: "https://tiles.openfreemap.org/planet",
    },
  },
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#2f3b3f" },
    },
    {
      id: "water",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "water",
      paint: {
        "fill-color": "#60777e",
        "fill-opacity": 1,
      },
    },
    {
      id: "landcover",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landcover",
      paint: {
        "fill-color": [
          "match",
          ["get", "class"],
          "wood",
          "#344446",
          "grass",
          "#3b4849",
          "wetland",
          "#405154",
          "ice",
          "#7f8e92",
          "#374447",
        ],
        "fill-opacity": 0.42,
      },
    },
    {
      id: "landuse",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landuse",
      minzoom: 4,
      paint: {
        "fill-color": [
          "match",
          ["get", "class"],
          "residential",
          "#3a4648",
          "industrial",
          "#40494b",
          "commercial",
          "#40494b",
          "park",
          "#3c4b49",
          "#394649",
        ],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.16, 11, 0.34],
      },
    },
    {
      id: "park",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "park",
      minzoom: 5,
      paint: {
        "fill-color": "#3a4d4a",
        "fill-opacity": 0.34,
      },
    },
    {
      id: "land",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landcover",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "fill-color": "#2f3b3f",
        "fill-opacity": 0.36,
      },
    },
    {
      id: "waterway",
      type: "line",
      source: "openmaptiles",
      "source-layer": "waterway",
      paint: {
        "line-color": "#647d84",
        "line-opacity": 0.55,
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.35, 10, 1.1, 14, 2.2],
      },
    },
    {
      id: "boundary-country",
      type: "line",
      source: "openmaptiles",
      "source-layer": "boundary",
      filter: ["==", ["get", "admin_level"], 2],
      paint: {
        "line-color": "#9aa6aa",
        "line-opacity": 0.72,
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.6, 6, 1.1, 10, 1.8],
      },
    },
    {
      id: "boundary-state",
      type: "line",
      source: "openmaptiles",
      "source-layer": "boundary",
      filter: ["==", ["get", "admin_level"], 4],
      paint: {
        "line-color": "#87959a",
        "line-opacity": 0.42,
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.35, 7, 0.75, 11, 1.2],
      },
    },
    {
      id: "road-minor",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      minzoom: 7,
      filter: ["in", ["get", "class"], ["literal", ["minor", "service", "track"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#657174",
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0, 11, 0.22, 15, 0.42],
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.3, 14, 1.1, 17, 2.2],
      },
    },
    {
      id: "road-major",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      minzoom: 5,
      filter: ["in", ["get", "class"], ["literal", ["primary", "secondary", "tertiary", "trunk", "motorway"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#748084",
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.18, 10, 0.36, 14, 0.58],
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.45, 10, 1.1, 15, 3.2],
      },
    },
    {
      id: "water-name",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "water_name",
      minzoom: 4,
      layout: {
        "symbol-placement": "line",
        "text-field": ["coalesce", ["get", "name:latin"], ["get", "name_en"], ["get", "name"]],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 4, 10, 9, 12],
      },
      paint: {
        "text-color": "#9fb1b7",
        "text-halo-color": "#334147",
        "text-halo-width": 1.2,
        "text-opacity": 0.6,
      },
    },
    {
      id: "place-country",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      filter: ["==", ["get", "class"], "country"],
      layout: {
        "text-field": ["coalesce", ["get", "name:latin"], ["get", "name_en"], ["get", "name"]],
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 2, 13, 5, 17],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.08,
      },
      paint: {
        "text-color": "#d8dee1",
        "text-halo-color": "#273238",
        "text-halo-width": 1.6,
        "text-opacity": 0.88,
      },
    },
    {
      id: "place-state",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      minzoom: 3,
      maxzoom: 7,
      filter: ["==", ["get", "class"], "state"],
      layout: {
        "text-field": ["coalesce", ["get", "name:latin"], ["get", "name_en"], ["get", "name"]],
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 3, 11, 6, 15],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.14,
      },
      paint: {
        "text-color": "#d6dcdf",
        "text-halo-color": "#2b363b",
        "text-halo-width": 1.4,
        "text-opacity": 0.82,
      },
    },
    {
      id: "place-city",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      minzoom: 5,
      filter: ["in", ["get", "class"], ["literal", ["city", "town"]]],
      layout: {
        "text-field": ["coalesce", ["get", "name:latin"], ["get", "name_en"], ["get", "name"]],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 5, 10, 8, 13, 12, 16],
      },
      paint: {
        "text-color": "#c5cdd0",
        "text-halo-color": "#29343a",
        "text-halo-width": 1.4,
        "text-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.45, 7, 0.78],
      },
    },
  ],
};

/** Continental US, per the Phase 1 spec. */
export const INITIAL_VIEW = {
  center: [-98, 39] as [number, number],
  zoom: 4,
};
