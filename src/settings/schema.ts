/**
 * Every configurable setting in the app, in one table.
 *
 * The Settings drawer is drawn from this list and the store takes its defaults
 * from it, so a new setting is one entry here plus the code that reads it. The
 * defaults are the values the app used before they were settings -- switching
 * this on changed nothing on screen until something was edited.
 *
 * Map styling is applied by settings/mapStyle.ts; the rest is read where it is
 * used, through getSetting().
 */

export type SettingValue = boolean | number | string;

interface Base {
  key: string;
  label: string;
  hint?: string;
  /** Sub-heading inside the section. */
  group?: string;
}

export type SettingDef =
  | (Base & { type: "toggle"; default: boolean })
  | (Base & { type: "slider"; default: number; min: number; max: number; step: number; unit?: string; percent?: boolean })
  | (Base & { type: "color"; default: string })
  | (Base & { type: "select"; default: string; options: { value: string; label: string }[] });

export interface SettingsSection {
  id: string;
  label: string;
  description: string;
  items: SettingDef[];
}

/** The alert products whose colour can be changed, with the colour each has
 *  by default. The key is the NWS event name, lower-cased. */
export const ALERT_COLOR_EVENTS: { event: string; label: string; color: string; group: string }[] = [
  { event: "tornado warning", label: "Tornado Warning", color: "#e11d48", group: "Warnings" },
  { event: "severe thunderstorm warning", label: "Severe Thunderstorm Warning", color: "#f59e0b", group: "Warnings" },
  { event: "flash flood warning", label: "Flash Flood Warning", color: "#22c55e", group: "Warnings" },
  { event: "special marine warning", label: "Special Marine Warning", color: "#06b6d4", group: "Warnings" },
  { event: "flood warning", label: "Flood Warning", color: "#0ea5e9", group: "Warnings" },
  { event: "snow squall warning", label: "Snow Squall Warning", color: "#c084fc", group: "Warnings" },
  { event: "winter storm warning", label: "Winter Storm Warning", color: "#60a5fa", group: "Warnings" },
  { event: "blizzard warning", label: "Blizzard Warning", color: "#38bdf8", group: "Warnings" },
  { event: "ice storm warning", label: "Ice Storm Warning", color: "#a78bfa", group: "Warnings" },
  { event: "high wind warning", label: "High Wind Warning", color: "#8b5cf6", group: "Warnings" },
  { event: "extreme wind warning", label: "Extreme Wind Warning", color: "#f97316", group: "Warnings" },
  { event: "dust storm warning", label: "Dust Storm Warning", color: "#fbbf24", group: "Warnings" },
  { event: "red flag warning", label: "Red Flag Warning", color: "#dc2626", group: "Warnings" },
  { event: "extreme heat warning", label: "Extreme Heat Warning", color: "#ec4899", group: "Warnings" },
  { event: "tornado watch", label: "Tornado Watch", color: "#fde047", group: "Watches" },
  { event: "severe thunderstorm watch", label: "Severe Thunderstorm Watch", color: "#fb7185", group: "Watches" },
  { event: "flash flood watch", label: "Flash Flood Watch", color: "#16a34a", group: "Watches" },
  { event: "flood watch", label: "Flood Watch", color: "#0891b2", group: "Watches" },
  { event: "winter storm watch", label: "Winter Storm Watch", color: "#3b82f6", group: "Watches" },
  { event: "fire weather watch", label: "Fire Weather Watch", color: "#fb923c", group: "Watches" },
  { event: "high wind watch", label: "High Wind Watch", color: "#7c3aed", group: "Watches" },
  { event: "flood advisory", label: "Flood Advisory", color: "#0284c7", group: "Advisories & statements" },
  { event: "winter weather advisory", label: "Winter Weather Advisory", color: "#6366f1", group: "Advisories & statements" },
  { event: "wind advisory", label: "Wind Advisory", color: "#a855f7", group: "Advisories & statements" },
  { event: "heat advisory", label: "Heat Advisory", color: "#ea580c", group: "Advisories & statements" },
  { event: "dense fog advisory", label: "Dense Fog Advisory", color: "#94a3b8", group: "Advisories & statements" },
  { event: "special weather statement", label: "Special Weather Statement", color: "#22d3ee", group: "Advisories & statements" },
];

export const alertColorKey = (event: string) => `alerts.color.${event.replace(/\s+/g, "-")}`;

const scale = (key: string, label: string, def = 1, hint?: string, group?: string): SettingDef => ({
  key, label, type: "slider", default: def, min: 0.5, max: 2.5, step: 0.05, unit: "×", hint, group,
});
const pct = (key: string, label: string, def: number, max = 1, hint?: string, group?: string): SettingDef => ({
  key, label, type: "slider", default: def, min: 0, max, step: 0.01, percent: true, hint, group,
});
const ms = (key: string, label: string, def: number, hint?: string): SettingDef => ({
  key, label, type: "slider", default: def, min: 100, max: 3000, step: 50, unit: " ms", hint, group: "Time per frame at 1×",
});

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: "map",
    label: "Map",
    description: "Borders, place names, the grid and the night shading.",
    items: [
      { key: "map.placeLabels", label: "Place names", type: "toggle", default: true, group: "Place names",
        hint: "Country, state and city names on the basemap and over satellite." },
      scale("map.labelScale", "Name size", 1, undefined, "Place names"),
      { key: "map.borderColor", label: "Border colour", type: "color", default: "#a9c1e6", group: "Borders" },
      scale("map.borderWidth", "Border width", 1, undefined, "Borders"),
      { key: "map.stateLines", label: "State and province lines", type: "toggle", default: true, group: "Borders" },
      { key: "map.coastlines", label: "Coastlines and lakes", type: "toggle", default: true, group: "Borders" },
      { key: "map.borderCasing", label: "Dark edge under country borders", type: "toggle", default: true, group: "Borders",
        hint: "Keeps borders readable over cloud and bright radar." },
      { key: "map.graticuleColor", label: "Grid colour", type: "color", default: "#7f9ac4", group: "Lat / lon grid" },
      scale("map.graticuleWidth", "Grid width", 1, undefined, "Lat / lon grid"),
      { key: "map.nightColor", label: "Night shading colour", type: "color", default: "#070d1f", group: "Day / night",
        hint: "Its strength is the layer's opacity in Layers." },
    ],
  },
  {
    id: "radar",
    label: "Radar",
    description: "The range ring, storm tracks and site markers.",
    items: [
      { key: "radar.siteLabels", label: "Radar site markers", type: "toggle", default: true, group: "Sites" },
      scale("radar.siteScale", "Site marker size", 1, undefined, "Sites"),
      { key: "radar.ringColor", label: "Range ring colour", type: "color", default: "#8ea0b6", group: "Range ring" },
      scale("radar.ringWidth", "Range ring width", 1, undefined, "Range ring"),
      { key: "radar.ringDashed", label: "Dashed range ring", type: "toggle", default: true, group: "Range ring" },
      { key: "storms.forecastColor", label: "Forecast track colour", type: "color", default: "#ffffff", group: "Storm tracks" },
      { key: "storms.pastColor", label: "Past track colour", type: "color", default: "#e2ecf7", group: "Storm tracks" },
      { key: "storms.selectedColor", label: "Selected storm colour", type: "color", default: "#facc15", group: "Storm tracks" },
      scale("storms.trackWidth", "Track width", 1, undefined, "Storm tracks"),
      { key: "storms.cone", label: "Forecast cone", type: "toggle", default: true, group: "Storm tracks" },
      { key: "storms.labels", label: "Storm IDs", type: "toggle", default: true, group: "Storm tracks" },
    ],
  },
  {
    id: "alerts",
    label: "Alerts",
    description: "Warning colours, fill strength and outlines.",
    items: [
      pct("alerts.warningFill", "Warning fill", 0.1, 0.6, "Shading inside warning polygons.", "Drawing"),
      pct("alerts.areaFill", "Watch and advisory fill", 0.14, 0.6, "Watches and advisories have no outline by default, so this is their whole shape.", "Drawing"),
      scale("alerts.lineWidth", "Outline width", 1, undefined, "Drawing"),
      { key: "alerts.casing", label: "Dark edge under outlines", type: "toggle", default: true, group: "Drawing",
        hint: "Keeps the outline visible where radar is the same colour." },
      { key: "alerts.outlineWatches", label: "Outline watches and advisories too", type: "toggle", default: false, group: "Drawing" },
      { key: "alerts.emergencyColor", label: "Emergency outline", type: "color", default: "#ff1d48", group: "Drawing",
        hint: "Tornado and flash flood emergencies, and catastrophic damage threats." },
      ...ALERT_COLOR_EVENTS.map(
        (e): SettingDef => ({ key: alertColorKey(e.event), label: e.label, type: "color", default: e.color, group: e.group }),
      ),
    ],
  },
  {
    id: "lsr",
    label: "Storm reports",
    description: "Local storm report icons and magnitudes.",
    items: [
      scale("lsr.iconScale", "Icon size"),
      { key: "lsr.labels", label: "Magnitude labels", type: "toggle", default: true },
      { key: "lsr.labelColor", label: "Label colour", type: "color", default: "#f2f7ff" },
    ],
  },
  {
    id: "md",
    label: "Mesoscale discussions",
    description: "SPC mesoscale discussions and WPC precipitation discussions.",
    items: [
      { key: "md.severeColor", label: "Severe / tornado", type: "color", default: "#ef4444", group: "Colours" },
      { key: "md.floodColor", label: "Heavy rain / flooding", type: "color", default: "#3b82f6", group: "Colours" },
      { key: "md.otherColor", label: "Winter and other", type: "color", default: "#f5a524", group: "Colours" },
      pct("md.fill", "Fill", 0.13, 0.6, undefined, "Drawing"),
      { key: "md.lineWidth", label: "Outline width", type: "slider", default: 2, min: 0.5, max: 5, step: 0.1, unit: " px", group: "Drawing" },
      { key: "md.labels", label: "MD numbers", type: "toggle", default: true, group: "Drawing" },
    ],
  },
  {
    id: "outlooks",
    label: "Outlooks",
    description: "SPC, WPC, CPC and NadoCast outlook areas.",
    items: [
      pct("outlooks.fill", "Fill", 0.32, 0.9),
      pct("outlooks.hatch", "Hatching (conditional intensity)", 1, 1),
      { key: "outlooks.lineWidth", label: "Outline width", type: "slider", default: 1.25, min: 0, max: 4, step: 0.05, unit: " px" },
    ],
  },
  {
    id: "pressure",
    label: "Pressure & thickness",
    description: "Isobars, pressure centres and 1000–500 mb thickness.",
    items: [
      { key: "mslp.lowColor", label: "Isobars below 1013 hPa", type: "color", default: "#8ab4ff", group: "Isobars" },
      { key: "mslp.highColor", label: "Isobars from 1013 hPa", type: "color", default: "#f0f3f8", group: "Isobars" },
      { key: "mslp.hColor", label: "High (H) centres", type: "color", default: "#6ea8ff", group: "Isobars" },
      { key: "mslp.lColor", label: "Low (L) centres", type: "color", default: "#ff6b6b", group: "Isobars" },
      { key: "mslp.labelSize", label: "Label size", type: "slider", default: 10, min: 8, max: 18, step: 1, unit: " px", group: "Isobars" },
      { key: "thickness.coldColor", label: "Below 540 dam", type: "color", default: "#7cb3ff", group: "Thickness" },
      { key: "thickness.warmColor", label: "540 dam and above", type: "color", default: "#ff8f8f", group: "Thickness" },
      { key: "thickness.labelSize", label: "Label size", type: "slider", default: 10, min: 8, max: 18, step: 1, unit: " px", group: "Thickness" },
    ],
  },
  {
    id: "markers",
    label: "Soundings & profilers",
    description: "Radiosonde, aircraft (ACARS) and VAD wind profile markers.",
    items: [
      scale("markers.raobScale", "Radiosonde dot size"),
      scale("markers.acarsScale", "Aircraft dot size"),
      { key: "markers.acarsLabels", label: "Airport labels", type: "toggle", default: true },
      scale("markers.vwpScale", "VWP dot size"),
      { key: "markers.vwpLabels", label: "VWP site labels", type: "toggle", default: true },
    ],
  },
  {
    id: "chasers",
    label: "Chasers",
    description: "Other chasers and home pins on the map.",
    items: [
      { key: "chasers.labels", label: "Chaser names", type: "toggle", default: true },
      { key: "chasers.homeLabels", label: "Home pin names", type: "toggle", default: true },
    ],
  },
  {
    id: "timeline",
    label: "Timeline & playback",
    description: "How fast each product plays, and how playback starts.",
    items: [
      { key: "timeline.loop", label: "Loop when playback reaches the end", type: "toggle", default: false, group: "Playback" },
      {
        key: "timeline.speed", label: "Starting speed", type: "select", default: "1", group: "Playback",
        options: ["1", "2", "4", "8", "12", "16", "20"].map((v) => ({ value: v, label: `${v}×` })),
      },
      ms("timeline.radarMs", "Radar", 700),
      ms("timeline.satMs", "Satellite", 350),
      ms("timeline.obsMs", "Observations", 400),
      ms("timeline.modelMs", "Model fields", 600),
      ms("timeline.lsrMs", "Storm reports", 900),
      ms("timeline.frontsMs", "Fronts", 1100),
      ms("timeline.soundingMs", "Soundings", 2800),
    ],
  },
];

export const SETTING_DEFS: Record<string, SettingDef> = Object.fromEntries(
  SETTINGS_SECTIONS.flatMap((s) => s.items.map((i) => [i.key, i])),
);
