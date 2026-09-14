import type { LayerSpecification, StyleSpecification } from "maplibre-gl";

/**
 * The basemaps the map can wear.
 *
 * Two families. The vector ones are the same hand-built OpenMapTiles layer
 * stack driven by a palette, so a new tint is ~16 colours rather than a
 * duplicated 240-line style. The raster ones are somebody else's imagery with
 * *our* borders and place labels drawn over the top -- imagery with no
 * coastline reference is close to unreadable for weather work.
 *
 * Every source here is keyless and public; nothing in this file needs a token.
 */

export const VECTOR_SOURCE = "openmaptiles";
/** The basemap's own place-name layers, for a product that draws names over itself. */
export const BASEMAP_PLACE_LAYERS = ["place-country", "place-state", "place-city"];
const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
const OFM_ATTRIB = "© OpenFreeMap · OpenStreetMap";

export type BasemapGroup = "Vector" | "Imagery" | "Terrain";

export interface BasemapInfo {
  id: string;
  label: string;
  group: BasemapGroup;
  /** One line in the picker, saying what it is actually for. */
  hint: string;
  attribution: string;
}

interface Palette {
  bg: string;
  water: string;
  waterway: string;
  wood: string;
  grass: string;
  wetland: string;
  ice: string;
  landDefault: string;
  urban: string;
  urbanPark: string;
  park: string;
  country: string;
  state: string;
  roadMinor: string;
  roadMajor: string;
  text: string;
  textDim: string;
  halo: string;
}

/** Near-black. For radar and satellite, where the base should get out of the way. */
const DARK: Palette = {
  bg: "#14181b",
  water: "#1d262c",
  waterway: "#27333a",
  wood: "#181f20",
  grass: "#1b2223",
  wetland: "#1d2629",
  ice: "#3d4649",
  landDefault: "#1a2022",
  urban: "#222829",
  urbanPark: "#1e2625",
  park: "#1d2726",
  country: "#5f6d73",
  state: "#48545a",
  roadMinor: "#3a4245",
  roadMajor: "#495154",
  text: "#b9c3c7",
  textDim: "#93a0a5",
  halo: "#0b0f11",
};

/** Pale. Reads well in a bright room and prints without eating a cartridge. */
const LIGHT: Palette = {
  bg: "#e9ecec",
  water: "#c2d3da",
  waterway: "#a9c0c9",
  wood: "#dae2dc",
  grass: "#e0e6de",
  wetland: "#d6e0e0",
  ice: "#f2f5f6",
  landDefault: "#e4e8e7",
  urban: "#dcdfde",
  urbanPark: "#dde6de",
  park: "#d8e4d9",
  country: "#7c8a90",
  state: "#9aa5aa",
  roadMinor: "#c9cfd0",
  roadMajor: "#b7bfc1",
  text: "#2b3438",
  textDim: "#4a565b",
  halo: "#f4f6f6",
};

// ---------------------------------------------------------------- vector ---

const nameField = ["coalesce", ["get", "name:latin"], ["get", "name_en"], ["get", "name"]] as never;

/** Country and state borders plus place names — shared by every basemap. */
function referenceLayers(p: Palette): LayerSpecification[] {
  return [
    {
      id: "boundary-country",
      type: "line",
      source: VECTOR_SOURCE,
      "source-layer": "boundary",
      filter: ["==", ["get", "admin_level"], 2],
      paint: {
        "line-color": p.country,
        "line-opacity": 0.72,
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.6, 6, 1.1, 10, 1.8],
      },
    },
    {
      id: "boundary-state",
      type: "line",
      source: VECTOR_SOURCE,
      "source-layer": "boundary",
      filter: ["==", ["get", "admin_level"], 4],
      paint: {
        "line-color": p.state,
        "line-opacity": 0.42,
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.35, 7, 0.75, 11, 1.2],
      },
    },
    {
      id: "place-country",
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
      paint: {
        "text-color": p.text,
        "text-halo-color": p.halo,
        "text-halo-width": 1.6,
        "text-opacity": 0.88,
      },
    },
    {
      id: "place-state",
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
      paint: {
        "text-color": p.text,
        "text-halo-color": p.halo,
        "text-halo-width": 1.4,
        "text-opacity": 0.82,
      },
    },
    {
      id: "place-city",
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
      paint: {
        "text-color": p.textDim,
        "text-halo-color": p.halo,
        "text-halo-width": 1.4,
        "text-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.45, 7, 0.78],
      },
    },
  ];
}

function vectorStyle(p: Palette): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      [VECTOR_SOURCE]: { type: "vector", url: "https://tiles.openfreemap.org/planet", attribution: OFM_ATTRIB },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": p.bg } },
      {
        id: "water",
        type: "fill",
        source: VECTOR_SOURCE,
        "source-layer": "water",
        paint: { "fill-color": p.water, "fill-opacity": 1 },
      },
      {
        id: "landcover",
        type: "fill",
        source: VECTOR_SOURCE,
        "source-layer": "landcover",
        paint: {
          "fill-color": [
            "match",
            ["get", "class"],
            "wood", p.wood,
            "grass", p.grass,
            "wetland", p.wetland,
            "ice", p.ice,
            p.landDefault,
          ],
          "fill-opacity": 0.42,
        },
      },
      {
        id: "landuse",
        type: "fill",
        source: VECTOR_SOURCE,
        "source-layer": "landuse",
        minzoom: 4,
        paint: {
          "fill-color": [
            "match",
            ["get", "class"],
            "park", p.urbanPark,
            p.urban,
          ],
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.16, 11, 0.34],
        },
      },
      {
        id: "park",
        type: "fill",
        source: VECTOR_SOURCE,
        "source-layer": "park",
        minzoom: 5,
        paint: { "fill-color": p.park, "fill-opacity": 0.34 },
      },
      {
        id: "waterway",
        type: "line",
        source: VECTOR_SOURCE,
        "source-layer": "waterway",
        paint: {
          "line-color": p.waterway,
          "line-opacity": 0.55,
          "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.35, 10, 1.1, 14, 2.2],
        },
      },
      {
        id: "road-minor",
        type: "line",
        source: VECTOR_SOURCE,
        "source-layer": "transportation",
        minzoom: 7,
        filter: ["in", ["get", "class"], ["literal", ["minor", "service", "track"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": p.roadMinor,
          "line-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0, 11, 0.22, 15, 0.42],
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.3, 14, 1.1, 17, 2.2],
        },
      },
      {
        id: "road-major",
        type: "line",
        source: VECTOR_SOURCE,
        "source-layer": "transportation",
        minzoom: 5,
        filter: [
          "in",
          ["get", "class"],
          ["literal", ["primary", "secondary", "tertiary", "trunk", "motorway"]],
        ],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": p.roadMajor,
          "line-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.18, 10, 0.36, 14, 0.58],
          "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.45, 10, 1.1, 15, 3.2],
        },
      },
      {
        id: "water-name",
        type: "symbol",
        source: VECTOR_SOURCE,
        "source-layer": "water_name",
        minzoom: 4,
        layout: {
          "symbol-placement": "line",
          "text-field": nameField,
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 4, 10, 9, 12],
        },
        paint: {
          "text-color": p.textDim,
          "text-halo-color": p.halo,
          "text-halo-width": 1.2,
          "text-opacity": 0.6,
        },
      },
      ...referenceLayers(p),
    ],
  };
}

/** No tiles at all: a flat canvas for reading a data field with nothing behind it. */
function blankStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": "#0c1013" } }],
  };
}

// ---------------------------------------------------------------- raster ---

/** Labels over imagery are dark-haloed and bright, whatever the picture beneath. */
const OVER_IMAGERY: Palette = {
  ...DARK,
  country: "#e8eef0",
  state: "#c3ced3",
  text: "#f2f6f7",
  textDim: "#dbe3e6",
  halo: "#0a0d0f",
};

function rasterStyle(opts: {
  tiles: string[];
  attribution: string;
  maxzoom?: number;
  /** Some imagery is bright enough that the labels need a darker plate. */
  labels?: Palette;
}): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      base: {
        type: "raster",
        tiles: opts.tiles,
        tileSize: 256,
        maxzoom: opts.maxzoom ?? 18,
        attribution: opts.attribution,
      },
      [VECTOR_SOURCE]: { type: "vector", url: "https://tiles.openfreemap.org/planet", attribution: OFM_ATTRIB },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#0c1013" } },
      { id: "base", type: "raster", source: "base", paint: { "raster-opacity": 1 } },
      ...referenceLayers(opts.labels ?? OVER_IMAGERY),
    ],
  };
}

/**
 * NASA's daily true-colour mosaic is dated, and today's is still being stitched
 * for part of the globe, so the most recent *complete* day is yesterday UTC.
 */
function gibsDay(): string {
  const d = new Date(Date.now() - 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";

// ------------------------------------------------------------------ table ---

export const BASEMAPS: BasemapInfo[] = [
  { id: "dark", label: "Dark", group: "Vector", hint: "The workstation default — near-black, lets radar and satellite carry the colour.", attribution: OFM_ATTRIB },
  { id: "light", label: "Light", group: "Vector", hint: "Pale base for bright rooms and printing.", attribution: OFM_ATTRIB },
  { id: "blank", label: "Blank", group: "Vector", hint: "No tiles at all — just the data field.", attribution: "" },
  { id: "satellite", label: "Satellite", group: "Imagery", hint: "High-resolution imagery, borders drawn over it.", attribution: "Imagery © Esri, Maxar, Earthstar Geographics" },
  { id: "truecolor", label: "True colour (daily)", group: "Imagery", hint: "NASA VIIRS mosaic — yesterday's actual clouds.", attribution: "NASA EOSDIS GIBS · VIIRS/SNPP" },
  { id: "bluemarble", label: "Blue Marble", group: "Imagery", hint: "Cloud-free relief and bathymetry, no date.", attribution: "NASA EOSDIS GIBS · Blue Marble" },
  { id: "hillshade", label: "Hillshade", group: "Terrain", hint: "Bare terrain relief — reads orographic effects.", attribution: "Esri · USGS, NGA, NASA" },
  { id: "topo", label: "Topographic", group: "Terrain", hint: "Contours and trails, OpenTopoMap.", attribution: "© OpenTopoMap · OpenStreetMap (CC-BY-SA)" },
  { id: "ocean", label: "Ocean", group: "Terrain", hint: "Seafloor base for marine and tropical work.", attribution: "Esri · GEBCO, NOAA, National Geographic" },
];

export const DEFAULT_BASEMAP = "dark";

export const basemapInfo = (id: string): BasemapInfo =>
  BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0];

/**
 * The two vector basemaps built to sit under a light or dark app chrome --
 * their ids double as the theme names they match. When the UI theme flips,
 * whichever of these two is on screen swaps to match it. Everything else --
 * imagery, terrain, "blank" -- has no light/dark counterpart and is a
 * deliberate choice, so it's left alone.
 */
const THEME_LINKED_BASEMAPS = new Set(["light", "dark"]);

/** Next basemap id to switch to for this theme, or null if this basemap
 *  isn't theme-linked or already matches. */
export function themeLinkedBasemap(theme: "light" | "dark", currentId: string): string | null {
  if (!THEME_LINKED_BASEMAPS.has(currentId)) return null;
  return theme === currentId ? null : theme;
}

/** Fresh style object per call — MapLibre takes ownership of what it is given. */
export function buildBasemapStyle(id: string): StyleSpecification {
  switch (id) {
    case "dark":
      return vectorStyle(DARK);
    case "light":
      return vectorStyle(LIGHT);
    case "blank":
      return blankStyle();
    case "satellite":
      return rasterStyle({
        tiles: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`],
        attribution: basemapInfo("satellite").attribution,
        maxzoom: 19,
      });
    case "truecolor":
      return rasterStyle({
        tiles: [
          `${GIBS}/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${gibsDay()}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
        ],
        attribution: basemapInfo("truecolor").attribution,
        maxzoom: 9,
      });
    case "bluemarble":
      return rasterStyle({
        tiles: [
          `${GIBS}/BlueMarble_ShadedRelief_Bathymetry/default/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg`,
        ],
        attribution: basemapInfo("bluemarble").attribution,
        maxzoom: 8,
      });
    case "hillshade":
      return rasterStyle({
        tiles: [`${ESRI}/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}`],
        attribution: basemapInfo("hillshade").attribution,
        maxzoom: 16,
        // Hillshade is pale grey, so bright labels would disappear into it.
        labels: { ...OVER_IMAGERY, country: "#33403f", state: "#4d5a5a", text: "#1d2626", textDim: "#33403f", halo: "#eef1f0" },
      });
    case "topo":
      return rasterStyle({
        tiles: ["https://a.tile.opentopomap.org/{z}/{x}/{y}.png", "https://b.tile.opentopomap.org/{z}/{x}/{y}.png"],
        attribution: basemapInfo("topo").attribution,
        maxzoom: 15,
        labels: { ...OVER_IMAGERY, country: "#3b3227", state: "#57503f", text: "#241f18", textDim: "#3b3227", halo: "#f3efe6" },
      });
    case "ocean":
      return rasterStyle({
        tiles: [`${ESRI}/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}`],
        attribution: basemapInfo("ocean").attribution,
        maxzoom: 13,
        labels: { ...OVER_IMAGERY, country: "#20343d", state: "#3a4e57", text: "#12242c", textDim: "#254049", halo: "#e6f0f4" },
      });
    default:
      return vectorStyle(DARK);
  }
}
