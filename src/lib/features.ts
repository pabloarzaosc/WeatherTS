/**
 * The app's features as switches (ux-shell): Settings > Features and the
 * first-run question "How do you watch the weather?" turn whole parts of the
 * app off, so someone who only wants radar and warnings is not handed seventy
 * buttons.
 *
 * A feature that is off loses its way in -- its Catalog button, dock button,
 * radar tool button and its layers in the layer lists -- and its layers are
 * switched off. Nothing is deleted: turning it back on puts every button back.
 * Everything is ON unless someone turns it off, so an existing install sees
 * no change at all.
 */

export type FeatureKind = "panel" | "tool" | "layer";

export interface FeatureDef {
  id: string;
  label: string;
  kind: FeatureKind;
  hint: string;
  /** Catalog categories (CatalogView CATEGORIES ids). */
  catalog?: string[];
  /** Layer ids; "prefix-*" matches every id with that prefix. */
  layers?: string[];
  /** Layer registry categories. */
  categories?: string[];
  /** More words the Settings search should match. */
  words?: string;
}

export const FEATURES: FeatureDef[] = [
  // ---- panels (Catalog) ----
  { id: "alerts", label: "Alerts", kind: "panel", hint: "NWS warnings, watches and advisories, the alert rail and its sounds.", catalog: ["alerts"], layers: ["nws-alerts", "spc-md"], words: "warnings watches advisories rail" },
  { id: "now", label: "Now panel", kind: "panel", hint: "The dock's live list of what is serious right now.", words: "now serious live feed" },
  { id: "surface", label: "Surface observations", kind: "panel", hint: "METAR station plots and mesonets.", catalog: ["surface"], layers: ["surfobs"], words: "metar stations obs mesonet" },
  { id: "satellite", label: "Satellite", kind: "panel", hint: "GOES, Himawari and other imagery.", catalog: ["satellite"], layers: ["satellite"], words: "goes himawari imagery" },
  { id: "soundings", label: "Soundings", kind: "panel", hint: "Radiosondes, aircraft soundings and wind profiles.", catalog: ["sounding"], layers: ["raob", "vwp", "acars"], words: "skew-t raob acars vwp profile" },
  { id: "stormReports", label: "Storm reports", kind: "panel", hint: "Local storm reports on the map.", catalog: ["lsr"], layers: ["lsr"], words: "lsr reports" },
  { id: "models", label: "Models", kind: "panel", hint: "HRRR, RAP, GFS and the other model fields.", catalog: ["observations"], layers: ["observations"], words: "hrrr rap gfs ecmwf model mesoanalysis" },
  { id: "outlooks", label: "Outlooks", kind: "panel", hint: "SPC, WPC, CPC and NHC outlooks.", catalog: ["outlooks"], categories: ["outlooks"], words: "spc wpc cpc convective" },
  { id: "lightning", label: "Lightning", kind: "panel", hint: "GOES lightning flashes.", catalog: ["lightning"], layers: ["glm"], words: "glm flashes" },
  { id: "flooding", label: "Flooding", kind: "panel", hint: "River gauges, hydrographs and the water model.", catalog: ["flooding"], layers: ["rivers", "nwm"], words: "rivers gauges hydrograph flood" },
  { id: "tropical", label: "Tropical", kind: "panel", hint: "Hurricanes, guidance, recon and the season.", catalog: ["tropical"], layers: ["tropical-*"], words: "hurricane cyclone nhc recon" },
  { id: "space", label: "Space weather", kind: "panel", hint: "Aurora, solar wind and the Sun.", catalog: ["space"], layers: ["space-*"], words: "aurora solar swpc" },
  { id: "aviation", label: "Aviation", kind: "panel", hint: "Airports, TAFs, SIGMETs and airspace.", catalog: ["aviation"], categories: ["aviation"], words: "taf sigmet pirep airspace airport" },
  { id: "archive", label: "Archive", kind: "panel", hint: "Past radar by date and the notable events.", catalog: ["archive"], layers: ["radarEvents"], words: "history past events cases" },
  // ---- tools ----
  { id: "multiPane", label: "Split view", kind: "tool", hint: "Two to six map panes side by side.", words: "panes multi-pane layout compare" },
  { id: "radar3d", label: "3D view", kind: "tool", hint: "The radar volume in 3D over a box drawn on the map.", words: "3d volume" },
  { id: "xsect", label: "Cross section", kind: "tool", hint: "A vertical slice through every tilt along a line.", words: "cross-section xsect slice" },
  { id: "measure", label: "Measure", kind: "tool", hint: "Distances and areas on the map.", words: "distance ruler" },
  { id: "draw", label: "Draw", kind: "tool", hint: "Pen, shapes and text on the map.", layers: ["drawings"], words: "annotate pen" },
  { id: "export", label: "Export", kind: "tool", hint: "Save the view as an image or an animation.", words: "png gif mp4 video image" },
  { id: "broadcast", label: "Broadcast mode", kind: "tool", hint: "The map alone, with captions, for streaming.", words: "stream tv obs projector" },
  // ---- layers ----
  { id: "detections", label: "Radar detections", kind: "layer", hint: "Mesocyclone, TVS and debris markers.", layers: ["radar-detections"], words: "meso tvs tds rotation" },
  { id: "tdwr", label: "Airport radars (TDWR)", kind: "layer", hint: "The FAA's 45 short-range radars beside the big airports, in the site list and on the map.", words: "tdwr terminal doppler airport faa short range" },
  { id: "chasers", label: "Chasers", kind: "layer", hint: "Other chasers' live positions and home pins.", categories: ["chasers"], words: "spotters positions" },
];

export const FEATURE_BY_ID = new Map(FEATURES.map((f) => [f.id, f]));

export type PresetId = "essentials" | "chaser" | "analyst" | "all";

export interface PresetDef {
  id: PresetId;
  label: string;
  blurb: string;
  /** Features this preset turns off; every other one is on. */
  off: string[];
}

export const PRESETS: PresetDef[] = [
  {
    id: "essentials",
    label: "Essentials",
    blurb: "Radar, warnings and the sky: the fewest buttons.",
    off: ["soundings", "models", "flooding", "tropical", "space", "aviation", "archive", "multiPane", "radar3d", "xsect", "draw", "detections", "chasers"],
  },
  {
    id: "chaser",
    label: "Chaser",
    blurb: "Radar up close, soundings, models, other chasers and the drawing tools.",
    off: ["flooding", "tropical", "space", "aviation", "archive", "radar3d"],
  },
  {
    id: "analyst",
    label: "Analyst",
    blurb: "Every analysis tool: archive, 3D, cross sections, models and soundings.",
    off: ["chasers", "aviation"],
  },
  { id: "all", label: "All", blurb: "Everything WeatherTS has.", off: [] },
];

/** Which feature a Catalog category belongs to, if any. */
export const CATALOG_FEATURE: Record<string, string> = Object.fromEntries(
  FEATURES.flatMap((f) => (f.catalog ?? []).map((c) => [c, f.id])),
);

/** The feature that owns a layer, if any. */
export function featureOfLayer(id: string, category?: string): string | null {
  for (const f of FEATURES) {
    if (f.layers?.some((p) => (p.endsWith("*") ? id.startsWith(p.slice(0, -1)) : p === id))) return f.id;
    if (category && f.categories?.includes(category)) return f.id;
  }
  return null;
}
