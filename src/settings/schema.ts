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

import { PLAY_SPEEDS, speedLabel } from "../lib/playSpeeds";
import { ALERT_SOUNDS, ALERT_TIERS, HAZARD_GROUPS, NWS_EVENTS, defaultTypeSound, eventSlug, hazardOf } from "../lib/alertTiers";
import { defaultEventColor } from "../lib/nwsAlerts";
import { WORLD_SOURCES, worldSourceKey } from "../lib/worldAlerts";

const HAZARD_LABEL = new Map(HAZARD_GROUPS.map((g) => [g.id, g.label]));

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
  | (Base & { type: "select"; default: string; options: { value: string; label: string }[] })
  | (Base & { type: "text"; default: string; placeholder?: string });

export interface SettingsSection {
  id: string;
  label: string;
  description: string;
  items: SettingDef[];
}

/** Every alert product, each with its own colour, by default the colour the
 *  map has always drawn it in. The key is the NWS event name, lower-cased; the
 *  group is its hazard (the per-type settings pages are grouped by it). */
export const ALERT_COLOR_EVENTS: { event: string; label: string; color: string; group: string }[] = NWS_EVENTS.map((event) => ({
  event: event.toLowerCase(),
  label: event,
  color: defaultEventColor(event),
  group: HAZARD_LABEL.get(hazardOf(event)) ?? "Other",
}));

export const alertColorKey = (event: string) => `alerts.color.${event.replace(/\s+/g, "-")}`;

/** One per-type setting of an alert product. */
export type AlertTypeProp = "on" | "line" | "border" | "fill" | "flash" | "flashColor" | "sound";
export const alertTypeKey = (event: string, prop: AlertTypeProp) => `alerts.type.${eventSlug(event)}.${prop}`;
/** One setting of an intensity tier (alertTiers.ALERT_TIERS): its colour or sound. */
export const alertTierKey = (id: string, prop: "color" | "sound") => `alerts.tier.${id}.${prop}`;

export const SOUND_OPTIONS = ALERT_SOUNDS.map((s) => ({ value: s.id, label: s.label }));
export const FLASH_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "10", label: "10 s" },
  { value: "20", label: "20 s" },
  { value: "40", label: "40 s" },
  { value: "60", label: "60 s" },
  { value: "expiry", label: "Until it expires" },
];

/**
 * The settings of every alert product and tier. They live in a section of
 * their own that the drawer does not list row by row: the Alerts section
 * draws them as per-type pages (ui/settings/AlertTypeSettings.tsx).
 */
function alertTypeItems(): SettingDef[] {
  const out: SettingDef[] = [];
  for (const e of ALERT_COLOR_EVENTS) {
    const ev = e.event;
    const g = e.group;
    out.push(
      { key: alertColorKey(ev), label: `${e.label} colour`, type: "color", default: e.color, group: g },
      { key: alertTypeKey(ev, "on"), label: `${e.label} shown`, type: "toggle", default: true, group: g },
      { key: alertTypeKey(ev, "line"), label: `${e.label} outline`, type: "slider", default: 1, min: 0, max: 3, step: 0.1, unit: "×", group: g },
      { key: alertTypeKey(ev, "border"), label: `${e.label} dark edge`, type: "toggle", default: true, group: g },
      { key: alertTypeKey(ev, "fill"), label: `${e.label} fill`, type: "slider", default: 1, min: 0, max: 3, step: 0.1, unit: "×", group: g },
      { key: alertTypeKey(ev, "flash"), label: `${e.label} flash`, type: "select", default: "10", options: FLASH_OPTIONS, group: g },
      { key: alertTypeKey(ev, "flashColor"), label: `${e.label} flash colour`, type: "color", default: "#ffffff", group: g },
      { key: alertTypeKey(ev, "sound"), label: `${e.label} sound`, type: "select", default: defaultTypeSound(ev), options: SOUND_OPTIONS, group: g },
    );
  }
  for (const t of ALERT_TIERS) {
    out.push(
      { key: alertTierKey(t.id, "color"), label: `${t.of} ${t.label} colour`, type: "color", default: t.color, group: "Intensity" },
      { key: alertTierKey(t.id, "sound"), label: `${t.of} ${t.label} sound`, type: "select", default: t.sound, options: SOUND_OPTIONS, group: "Intensity" },
    );
  }
  return out;
}

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
        hint: "Country, state and city names on the basemap." },
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
      { key: "radar.siteBlink", label: "Blink when a radar finishes a scan", type: "toggle", default: true, group: "Sites",
        hint: "Another radar's label blinks twice when its new scan comes in (live, radars in view)." },
      { key: "radar.siteVcp", label: "Scan strategy (VCP) after the id", type: "toggle", default: false, group: "Sites" },
      { key: "radar.siteCity", label: "City instead of the id", type: "toggle", default: false, group: "Sites" },
      { key: "radar.defaultSite", label: "Default radar site", type: "text", default: "", placeholder: "e.g. KTLX", group: "Sites",
        hint: "The radar the map opens on when no radar was open. An id with or without its first letter." },
      { key: "radar.ringColor", label: "Range ring colour", type: "color", default: "#8ea0b6", group: "Range ring" },
      scale("radar.ringWidth", "Range ring width", 1, undefined, "Range ring"),
      { key: "radar.ringDashed", label: "Dashed range ring", type: "toggle", default: true, group: "Range ring" },
      { key: "storms.forecastColor", label: "Forecast track colour", type: "color", default: "#ffffff", group: "Storm tracks" },
      { key: "storms.pastColor", label: "Past track colour", type: "color", default: "#e2ecf7", group: "Storm tracks" },
      { key: "storms.selectedColor", label: "Selected storm colour", type: "color", default: "#facc15", group: "Storm tracks" },
      scale("storms.trackWidth", "Track width", 1, undefined, "Storm tracks"),
      { key: "storms.cone", label: "Forecast cone", type: "toggle", default: true, group: "Storm tracks" },
      { key: "storms.labels", label: "Storm IDs", type: "toggle", default: true, group: "Storm tracks" },
      {
        key: "radar.readoutDistance", label: "Readout distances", type: "select", default: "mi", group: "Readout",
        hint: "Range, beam width and gates in the Shift readout and product info; heights follow (feet or metres).",
        options: [
          { value: "mi", label: "Miles and feet" },
          { value: "km", label: "Kilometres and metres" },
        ],
      },
      // Level II velocity options (src/lib/radarOptions.ts rides them on the
      // wire code). One app-wide storm motion for SRV.
      {
        key: "radar.dealias", label: "Velocity dealiasing", type: "select", default: "region", group: "Velocity",
        hint: "Unfolds aliased Level II velocity, SRV, VROT and the debris score. Level III velocity comes already unfolded.",
        options: [
          { value: "region", label: "Region-based" },
          { value: "vad", label: "VAD-seeded" },
          { value: "off", label: "Off (as observed)" },
        ],
      },
      { key: "radar.showRangeFolded", label: "Show range folded", type: "toggle", default: true, group: "Velocity",
        hint: "Gates the radar could not place in range, drawn purple on velocity and SRV." },
      {
        key: "radar.stormMotionMode", label: "SRV storm motion", type: "select", default: "auto", group: "Velocity",
        options: [
          { value: "auto", label: "Auto (echo tracking)" },
          { value: "sti", label: "From STI (NWS storm cells)" },
          { value: "manual", label: "Manual" },
        ],
      },
      { key: "radar.stormMotionFrom", label: "Storm motion from", type: "slider", default: 240, min: 0, max: 359, step: 1, unit: "°", group: "Velocity" },
      { key: "radar.stormMotionKt", label: "Storm motion speed", type: "slider", default: 30, min: 0, max: 90, step: 1, unit: " kt", group: "Velocity" },
      // Live Level II and the loop (src/lib/radarFrames.ts, backend/level2_live.py).
      { key: "radar.inProgress", label: "Show in-progress scans", type: "toggle", default: true, group: "Live and loop",
        hint: "The newest Level II frame fills in tilt by tilt as the radar scans; a tilt not reached yet shows the previous scan." },
      { key: "radar.expandSails", label: "Expand SAILS cuts in timeline", type: "toggle", default: true, group: "Live and loop",
        hint: "Each extra low-level scan (SAILS / MRLE) is its own frame on that tilt. Off: step through them from the tilt button." },
      { key: "radar.holdElevation", label: "Hold elevation", type: "toggle", default: true, group: "Live and loop",
        hint: "When the scan strategy changes, keep the angle you picked (nearest tilt within 1.5°) rather than the tilt's place in the scan." },
      // Display options, shared by every pane (src/lib/radarDisplay.ts,
      // layers/nexradGlLayer.ts flash, layers/radarSweep.ts scan line).
      { key: "radar.gateLow", label: "Gate filter: lowest", type: "slider", default: 0, min: 0, max: 95, step: 1, unit: " dBZ", group: "Gate filter",
        hint: "Gates whose reflectivity is outside the range are hidden, on velocity and dual-pol of the same tilt too. 0 to 95 = off." },
      { key: "radar.gateHigh", label: "Gate filter: highest", type: "slider", default: 95, min: 0, max: 95, step: 1, unit: " dBZ", group: "Gate filter" },
      { key: "radar.flash", label: "Flash reflectivity", type: "toggle", default: false, group: "Flash reflectivity",
        hint: "The strongest reflectivity blinks once a second, on reflectivity panes." },
      { key: "radar.flashMin", label: "Flash from", type: "slider", default: 47, min: 20, max: 80, step: 1, unit: " dBZ", group: "Flash reflectivity" },
      { key: "radar.flashColor", label: "Flash colour", type: "color", default: "#ffffff", group: "Flash reflectivity" },
      pct("radar.flashOpacity", "Flash opacity", 0.85, 1, undefined, "Flash reflectivity"),
      {
        key: "radar.scanLine", label: "Scan line", type: "select", default: "never", group: "Scan line",
        hint: "Live radar only: a line sweeps round the radar as a new scan comes in, at about the radar's own pace.",
        options: [
          { value: "never", label: "Never" },
          { value: "new", label: "When a new scan arrives" },
          { value: "always", label: "Always" },
        ],
      },
      { key: "radar.scanLineColor", label: "Sweep colour", type: "color", default: "#7fdcff", group: "Scan line" },
      { key: "radar.scanMarksColor", label: "Increment marks colour", type: "color", default: "#ffffff", group: "Scan line" },
      { key: "radar.scanMarksKm", label: "Increment marks every", type: "slider", default: 25, min: 10, max: 50, step: 5, unit: " km", group: "Scan line" },
      {
        key: "radar.scanSound", label: "Sweep sound", type: "select", default: "off", group: "Scan line",
        options: [
          { value: "off", label: "Off" },
          { value: "start", label: "When a sweep starts" },
          { value: "update", label: "Every update" },
        ],
      },
      {
        key: "radar.scanSoundEffect", label: "Sound effect", type: "select", default: "blip", group: "Scan line",
        options: [
          { value: "blip", label: "Radar blip" },
          { value: "tone", label: "Sweep tone" },
          { value: "tick", label: "Soft tick" },
        ],
      },
      pct("radar.scanSoundVolume", "Sound volume", 0.5, 1, undefined, "Scan line"),
    ],
  },
  {
    id: "alerts",
    label: "Alerts",
    description: "Drawing, filters, flashing and sounds. Each alert type has its own page below.",
    items: [
      { key: "alerts.source.us", label: "United States: NWS", type: "toggle", default: true, group: "Sources" },
      ...WORLD_SOURCES.map((s): SettingDef => ({ key: worldSourceKey(s.id), label: s.label, type: "toggle", default: true, group: "Sources", hint: s.hint })),
      pct("alerts.warningFill", "Warning fill", 0.1, 0.6, "Shading inside warning polygons.", "Drawing"),
      pct("alerts.areaFill", "Watch and advisory fill", 0.14, 0.6, "Watches and advisories have no outline by default, so this is their whole shape.", "Drawing"),
      { key: "alerts.lineWidth", label: "Outline width", type: "slider", default: 1, min: 0, max: 4, step: 0.05, unit: "×", group: "Drawing" },
      { key: "alerts.casing", label: "Dark edge under outlines", type: "toggle", default: true, group: "Drawing",
        hint: "Keeps the outline visible where radar is the same colour." },
      { key: "alerts.casingWidth", label: "Dark edge width", type: "slider", default: 1.6, min: 0.5, max: 5, step: 0.1, unit: " px", group: "Drawing" },
      { key: "alerts.casingColor", label: "Dark edge colour", type: "color", default: "#060a10", group: "Drawing" },
      { key: "alerts.outlineWatches", label: "Outline watches and advisories too", type: "toggle", default: false, group: "Drawing" },
      { key: "alerts.motionArrows", label: "Storm motion arrows", type: "toggle", default: true, group: "Drawing",
        hint: "Where a storm-based warning's storm is heading and how fast; the arrow is 30 minutes of travel." },
      { key: "alerts.onlyActive", label: "Show only active alerts", type: "toggle", default: false, group: "Filters",
        hint: "Hide alerts issued ahead of time that have not started yet." },
      { key: "alerts.states", label: "Filter by state", type: "text", default: "", placeholder: "OK, TX, KS", group: "Filters",
        hint: "Two-letter codes. Empty shows every state. Changes the map and the list." },
      { key: "alerts.wfos", label: "Filter by forecast office", type: "text", default: "", placeholder: "OUN, FWD, TSA", group: "Filters",
        hint: "Three-letter NWS office ids. Empty shows every office." },
      { key: "alerts.flashNew", label: "Flash new alerts", type: "toggle", default: true, group: "Flashing",
        hint: "A new alert pulses for its type's flash time (10 s unless changed on its page)." },
      { key: "alerts.animatePlayback", label: "Flash alerts as they are issued in playback", type: "toggle", default: true, group: "Flashing" },
      { key: "alerts.sounds", label: "Alert sounds", type: "toggle", default: false, group: "Sounds",
        hint: "Plays when an alert issued in the last 10 minutes first shows up in view, never on start. Alerts keep being checked with the window hidden." },
      pct("alerts.volume", "Volume", 0.7, 1, undefined, "Sounds"),
    ],
  },
  {
    id: "alertTypes",
    label: "Alert types",
    description: "Per-type and per-tier alert settings.",
    items: alertTypeItems(),
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
    label: "Pressure",
    description: "Isobars and pressure centres, on the model products that carry sea-level pressure.",
    items: [
      { key: "mslp.lowColor", label: "Isobars below 1013 hPa", type: "color", default: "#8ab4ff", group: "Isobars" },
      { key: "mslp.highColor", label: "Isobars from 1013 hPa", type: "color", default: "#f0f3f8", group: "Isobars" },
      { key: "mslp.hColor", label: "High (H) centres", type: "color", default: "#6ea8ff", group: "Isobars" },
      { key: "mslp.lColor", label: "Low (L) centres", type: "color", default: "#ff6b6b", group: "Isobars" },
      { key: "mslp.labelSize", label: "Label size", type: "slider", default: 10, min: 8, max: 18, step: 1, unit: " px", group: "Isobars" },
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
        options: PLAY_SPEEDS.map((v) => ({ value: String(v), label: speedLabel(v) })),
      },
      { key: "timeline.loopDelay", label: "Loop delay", type: "slider", default: 0, min: 0, max: 5, step: 0.5, unit: " s",
        group: "Playback", hint: "How long a looping play holds the last frame before it starts again." },
      ms("timeline.radarMs", "Radar", 700),
      ms("timeline.satMs", "Satellite", 350),
      ms("timeline.obsMs", "Models", 400),
      ms("timeline.lsrMs", "Storm reports", 900),
      ms("timeline.frontsMs", "Fronts", 1100),
      ms("timeline.soundingMs", "Soundings", 2800),
    ],
  },
  {
    // ux-shell: applied by lib/uiScale.ts. Settings live in this browser /
    // this install anyway; the hints say so because a size is a screen's.
    id: "ui",
    label: "Interface",
    description: "Size and density of the controls.",
    items: [
      { key: "ui.scale", label: "Interface size", type: "slider", default: 1, min: 0.75, max: 1.25, step: 0.05, percent: true,
        group: "Size and density", hint: "Every panel, button and label, map labels included. This device only." },
      { key: "ui.density", label: "Density", type: "select", default: "comfortable", group: "Size and density",
        options: [{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }],
        hint: "Compact tightens rows, buttons and the dock. This device only." },
    ],
  },
];

export const SETTING_DEFS: Record<string, SettingDef> = Object.fromEntries(
  SETTINGS_SECTIONS.flatMap((s) => s.items.map((i) => [i.key, i])),
);
