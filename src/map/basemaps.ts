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

export type BasemapGroup = "Vector" | "Chart" | "Imagery" | "Terrain";

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

/** Near-black, and neutral: the same grey family as the dark chrome (#202020)
 *  around it, a shade darker so radar and satellite carry the colour. It was a
 *  blue-green slate, which read as a second, unrelated colour beside the panels
 *  once they went grey. Water sits darker than land, as on a night chart. */
const DARK: Palette = {
  bg: "#1b1b1b",
  water: "#131313",
  waterway: "#2b2b2b",
  wood: "#1d1d1d",
  grass: "#1e1e1e",
  wetland: "#1c1c1c",
  ice: "#424242",
  landDefault: "#1c1c1c",
  urban: "#252525",
  urbanPark: "#202020",
  park: "#1f1f1f",
  country: "#6e6e6e",
  state: "#525252",
  roadMinor: "#3c3c3c",
  roadMajor: "#4b4b4b",
  text: "#c2c2c2",
  textDim: "#9a9a9a",
  halo: "#0e0e0e",
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

// ----------------------------------------------------------------- chart ---

/**
 * The weather-chart base: paper, and in ink only the coastlines, lakes,
 * country and state lines -- the map under every NCEP, SPC and GEMPAK chart,
 * and under most of the model images shared around. Nothing else: no land
 * colour, no roads, no names, so whatever is drawn on it is the only thing
 * read.
 */
interface Chart {
  paper: string;
  ink: string;
  /** Its names: set in ink, and haloed in the paper so a line under one parts. */
  labels: Palette;
  /** What comes in as the map is zoomed to a city -- towns, water, counties,
   *  roads -- in greys a step off the paper, so the chart's own lines and the
   *  data over them stay the first thing read. */
  town: string;
  water: string;
  county: string;
  motorway: string;
  trunk: string;
  primary: string;
  secondary: string;
  minor: string;
  roadName: string;
}

const CHART_WHITE: Chart = {
  paper: "#ffffff",
  ink: "#000000",
  labels: { ...LIGHT, text: "#111111", textDim: "#1c1c1c", halo: "#ffffff" },
  town: "#ededed",
  water: "#e6ebef",
  county: "#9a9a9a",
  motorway: "#7d7d7d",
  trunk: "#959595",
  primary: "#adadad",
  secondary: "#c4c4c4",
  minor: "#d9d9d9",
  roadName: "#5a5a5a",
};
const CHART_DARK: Chart = {
  paper: "#0e0e0e",
  ink: "#ededed",
  labels: { ...DARK, text: "#f2f2f2", textDim: "#dcdcdc", halo: "#0e0e0e" },
  town: "#1b1b1b",
  water: "#141a1e",
  county: "#555555",
  motorway: "#6e6e6e",
  trunk: "#5c5c5c",
  primary: "#4a4a4a",
  secondary: "#3b3b3b",
  minor: "#2c2c2c",
  roadName: "#a8a8a8",
};

/** US counties, from the outlines bundled for the analyses: the tiles carry
 *  them only from zoom 9, and a radar is read county by county from 6 in. */
// Relative to the page, as the raob layer's is: the desktop app loads the
// page from a file:// path, where "/data/..." would mean the drive's root.
const COUNTY_DATA = `${import.meta.env.BASE_URL}data/borders.geojson`;
const CHARTS: Record<string, Chart> = { chart: CHART_WHITE, "chart-dark": CHART_DARK };

/** The ink of a chart basemap, for the borders drawn over products to match
 *  it; null for every other basemap. */
export function chartInk(id: string): string | null {
  return CHARTS[id]?.ink ?? null;
}

const zoomWidth = (...stops: number[]) => ["interpolate", ["linear"], ["zoom"], ...stops] as never;

/**
 * The same tiles, never asked for past zoom 5, for a chart's lakes. Up to 5 the
 * water is Natural Earth's -- the lakes a chart shows -- and from 6 it is every
 * reservoir in OpenStreetMap: at chase zoom a state is freckled with a hundred
 * outlines. Held at 5, the big lakes keep their shores at every zoom and the
 * rest never arrive. The tiles carry no area to filter on instead.
 */
export const LAKES_SOURCE = "openmaptiles-lakes";
const lakesSource = {
  type: "vector" as const,
  url: "https://tiles.openfreemap.org/planet",
  // An explicit maxzoom wins over the TileJSON's: tiles past it are the z5 ones, overzoomed.
  maxzoom: 5,
};

/**
 * Roads by rank, each from the zoom its class starts to matter at: interstates
 * across a state, highways across a county, streets across a town. Names come
 * with them further in -- the route numbers first, street names at city zoom.
 */
function chartRoads(c: Chart): LayerSpecification[] {
  const road = (
    id: string,
    classes: string[],
    minzoom: number,
    color: string,
    widths: number[],
  ): LayerSpecification => ({
    id,
    type: "line",
    source: VECTOR_SOURCE,
    "source-layer": "transportation",
    minzoom,
    filter: ["in", ["get", "class"], ["literal", classes]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": color, "line-width": zoomWidth(...widths) },
  });
  return [
    road("chart-road-minor", ["minor", "service"], 12, c.minor, [12, 0.4, 14, 1.2, 17, 3]),
    road("chart-road-tertiary", ["tertiary"], 10, c.minor, [10, 0.35, 13, 1, 16, 2.6]),
    road("chart-road-secondary", ["secondary"], 8.5, c.secondary, [8.5, 0.35, 12, 1, 16, 3]),
    road("chart-road-primary", ["primary"], 7, c.primary, [7, 0.35, 10, 0.9, 14, 2.4, 17, 4.5]),
    road("chart-road-trunk", ["trunk"], 6, c.trunk, [6, 0.35, 10, 1, 14, 2.8, 17, 5]),
    road("chart-road-motorway", ["motorway"], 5, c.motorway, [5, 0.4, 8, 0.9, 12, 1.8, 16, 4.5]),
    {
      id: "chart-road-ref",
      type: "symbol",
      source: VECTOR_SOURCE,
      "source-layer": "transportation_name",
      minzoom: 8,
      filter: ["all", ["in", ["get", "class"], ["literal", ["motorway", "trunk"]]], ["has", "ref"]],
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 320,
        "text-field": ["get", "ref"],
        "text-font": ["Noto Sans Bold"],
        "text-size": zoomWidth(8, 9, 12, 11),
        "text-rotation-alignment": "viewport",
      },
      paint: { "text-color": c.roadName, "text-halo-color": c.paper, "text-halo-width": 1.6 },
    },
    {
      id: "chart-road-name",
      type: "symbol",
      source: VECTOR_SOURCE,
      "source-layer": "transportation_name",
      minzoom: 12,
      filter: ["in", ["get", "class"], ["literal", ["primary", "secondary", "tertiary", "minor"]]],
      layout: {
        "symbol-placement": "line",
        "text-field": nameField,
        "text-font": ["Noto Sans Regular"],
        "text-size": zoomWidth(12, 9.5, 16, 12),
      },
      paint: { "text-color": c.roadName, "text-halo-color": c.paper, "text-halo-width": 1.4 },
    },
  ];
}

function chartStyle(c: Chart): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      [VECTOR_SOURCE]: { type: "vector", url: "https://tiles.openfreemap.org/planet", attribution: OFM_ATTRIB },
      [LAKES_SOURCE]: lakesSource,
      "chart-counties": { type: "geojson", data: COUNTY_DATA },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": c.paper } },
      // --- what zooming in adds, under the chart's own lines ---------------
      {
        // Built-up land: the town itself, not only its name.
        id: "chart-town",
        type: "fill",
        source: VECTOR_SOURCE,
        "source-layer": "landuse",
        minzoom: 6,
        filter: ["in", ["get", "class"], ["literal", ["residential", "suburb", "neighbourhood", "quarter", "commercial", "industrial", "retail"]]],
        paint: { "fill-color": c.town, "fill-opacity": zoomWidth(6, 0.7, 9, 1) },
      },
      {
        // Water as a tint once lakes and rivers are big enough to be places.
        id: "chart-water",
        type: "fill",
        source: VECTOR_SOURCE,
        "source-layer": "water",
        minzoom: 9,
        filter: ["!=", ["get", "class"], "ocean"],
        paint: { "fill-color": c.water },
      },
      {
        id: "chart-river",
        type: "line",
        source: VECTOR_SOURCE,
        "source-layer": "waterway",
        minzoom: 9,
        filter: ["in", ["get", "class"], ["literal", ["river", "canal"]]],
        paint: { "line-color": c.water, "line-width": zoomWidth(9, 0.6, 14, 2.4) },
      },
      {
        id: "chart-county",
        type: "line",
        source: "chart-counties",
        minzoom: 5.5,
        filter: ["==", ["get", "kind"], "county"],
        layout: { "line-join": "round" },
        paint: {
          "line-color": c.county,
          "line-width": zoomWidth(5.5, 0.3, 8, 0.6, 12, 1),
          "line-opacity": zoomWidth(5.5, 0, 6.5, 1),
        },
      },
      ...chartRoads(c),
      // --- the chart ---------------------------------------------------------
      {
        // The outline of the water, not a fill: sea and land are the same paper.
        id: "chart-coast",
        type: "line",
        source: VECTOR_SOURCE,
        "source-layer": "water",
        filter: ["==", ["get", "class"], "ocean"],
        layout: { "line-join": "round" },
        paint: { "line-color": c.ink, "line-width": zoomWidth(2, 0.5, 5, 0.8, 8, 1.1, 12, 1.6) },
      },
      {
        id: "chart-lakes",
        type: "line",
        source: LAKES_SOURCE,
        "source-layer": "water",
        filter: ["==", ["get", "class"], "lake"],
        layout: { "line-join": "round" },
        paint: { "line-color": c.ink, "line-width": zoomWidth(2, 0.4, 5, 0.7, 8, 1, 12, 1.4) },
      },
      {
        id: "chart-state",
        type: "line",
        source: VECTOR_SOURCE,
        "source-layer": "boundary",
        filter: ["all", ["==", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]],
        layout: { "line-join": "round" },
        paint: { "line-color": c.ink, "line-width": zoomWidth(2, 0.4, 5, 0.65, 8, 0.9, 12, 1.3) },
      },
      {
        id: "chart-country",
        type: "line",
        source: VECTOR_SOURCE,
        "source-layer": "boundary",
        filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
        layout: { "line-join": "round" },
        paint: { "line-color": c.ink, "line-width": zoomWidth(2, 0.7, 5, 1.05, 8, 1.4, 12, 2) },
      },
      // Country, state and city names, as every basemap has them (and under the
      // same ids, so Settings and the products that hide them find them).
      ...referenceLayers(c.labels).filter((l) => l.id.startsWith("place-")),
    ],
  };
}

/**
 * Whether a basemap is a light surface or a dark one, for what is drawn over
 * it: a label in pale text on a dark halo is made for a dark map, and on white
 * paper it is a grey smudge -- names, radar badges, report magnitudes turn to
 * dark ink on a light halo instead.
 */
export type MapTone = "dark" | "light";
const LIGHT_TONE = new Set(["light", "chart", "hillshade", "topo", "ocean"]);

export function basemapTone(id: string): MapTone {
  return LIGHT_TONE.has(id) ? "light" : "dark";
}

/** No tiles at all: a flat canvas for reading a data field with nothing behind it. */
function blankStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": "#161616" } }],
  };
}

// ---------------------------------------------------------------- raster ---

/** Labels over imagery are dark-haloed and bright, whatever the picture beneath. */
const OVER_IMAGERY: Palette = {
  ...DARK,
  country: "#ececec",
  state: "#c8c8c8",
  text: "#f4f4f4",
  textDim: "#dedede",
  halo: "#0c0c0c",
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
      { id: "background", type: "background", paint: { "background-color": "#161616" } },
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
  { id: "chart", label: "Chart", group: "Chart", hint: "White paper, black coastlines and borders — the classic weather chart.", attribution: OFM_ATTRIB },
  { id: "chart-dark", label: "Chart (dark)", group: "Chart", hint: "The same chart in white ink on black.", attribution: OFM_ATTRIB },
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
 * The basemaps that come as a light and a dark pair, to sit under a light or
 * dark app chrome. When the UI theme flips, whichever of a pair is on screen
 * swaps to its twin. Everything else -- imagery, terrain, "blank", and the
 * charts, whose paper is picked for the picture being made rather than for the
 * room -- is a deliberate choice, so it's left alone. (The theme is also synced
 * at start-up, so a linked chart would turn dark again on every launch.)
 */
const THEME_PAIRS: Record<string, { light: string; dark: string }> = {
  light: { light: "light", dark: "dark" },
  dark: { light: "light", dark: "dark" },
};

/** Next basemap id to switch to for this theme, or null if this basemap
 *  isn't theme-linked or already matches. */
export function themeLinkedBasemap(theme: "light" | "dark", currentId: string): string | null {
  const pair = THEME_PAIRS[currentId];
  if (!pair) return null;
  return pair[theme] === currentId ? null : pair[theme];
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
    case "chart":
    case "chart-dark":
      return chartStyle(CHARTS[id]);
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
