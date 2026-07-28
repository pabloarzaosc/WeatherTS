import { create } from "zustand";

// Settings for the Surface Obs (METAR station-plot) layer. The layer reads
// these; the Surface Obs panel edits them.

export type SurfaceDisplayMode =
  | "station" // full station plot
  | "temp"
  | "dewp"
  | "wspd"
  | "wgst"
  | "altim"
  | "visib"
  | "rh"
  | "thetae"
  | "id";

export interface StationElements {
  wind: boolean;
  gust: boolean;
  sky: boolean;
  calm: boolean;
  temp: boolean;
  dewp: boolean;
  visibility: boolean;
  pressure: boolean;
  stationName: boolean;
}

export type TempUnit = "F" | "C";
export type WindUnit = "kt" | "mph" | "ms";
export type PresUnit = "mb" | "inHg";
export type VisUnit = "mi" | "km";

/** 0 means "no age limit" -- every observation the feed returns is plotted. */
export const AGE_UNLIMITED = 0;

interface SurfaceObsState {
  displayMode: SurfaceDisplayMode;
  elements: StationElements;
  spacing: number; // min px between plotted stations (declutter)
  size: number; // plot scale multiplier

  tempUnits: TempUnit;
  windUnits: WindUnit;
  presUnits: PresUnit;
  visUnits: VisUnit;

  /** Hide observations older than this many minutes. AGE_UNLIMITED disables it.
   *  METAR arrives on its own cadence and a quiet station can sit for hours, so
   *  without this the map mixes fresh and stale readings with no way to tell. */
  maxAgeMin: number;
  /** Draw surviving-but-ageing observations dimmed rather than at full strength. */
  fadeStale: boolean;
  /** The instant the main timeline is parked on, in unix seconds, or null when
   *  it is live. The station popup reads it so one clock drives the whole app
   *  rather than each panel keeping its own scrubber. */
  timelineUnix: number | null;
  /** Layer fetch state for UI feedback in the Surface Obs panel. */
  layerBusy: boolean;
  layerError: string | null;
  layerLastUpdatedAt: number | null;

  setDisplayMode: (m: SurfaceDisplayMode) => void;
  toggleElement: (k: keyof StationElements) => void;
  setElementsPreset: (e: StationElements) => void;
  setSpacing: (px: number) => void;
  setSize: (s: number) => void;
  setTempUnits: (u: TempUnit) => void;
  setWindUnits: (u: WindUnit) => void;
  setPresUnits: (u: PresUnit) => void;
  setVisUnits: (u: VisUnit) => void;
  setMaxAgeMin: (m: number) => void;
  setFadeStale: (v: boolean) => void;
  setTimelineUnix: (t: number | null) => void;
  setLayerStatus: (next: { busy?: boolean; error?: string | null; lastUpdatedAt?: number | null }) => void;
}

/** Ready-made element combinations. A full station plot is dense; these are the
 *  groupings people actually switch between, one click instead of nine. */
export const ELEMENT_PRESETS: { id: string; label: string; hint: string; elements: StationElements }[] = [
  {
    id: "full",
    label: "Full plot",
    hint: "Every element",
    elements: { wind: true, gust: true, sky: true, calm: true, temp: true, dewp: true, visibility: true, pressure: true, stationName: true },
  },
  {
    id: "standard",
    label: "Standard",
    hint: "The classic six",
    elements: { wind: true, gust: true, sky: true, calm: true, temp: true, dewp: true, visibility: false, pressure: true, stationName: true },
  },
  {
    id: "wind",
    label: "Wind only",
    hint: "Barbs and gusts",
    elements: { wind: true, gust: true, sky: false, calm: true, temp: false, dewp: false, visibility: false, pressure: false, stationName: false },
  },
  {
    id: "thermo",
    label: "Thermo",
    hint: "Temp and dewpoint",
    elements: { wind: false, gust: false, sky: false, calm: false, temp: true, dewp: true, visibility: false, pressure: false, stationName: false },
  },
];

export const useSurfaceObsStore = create<SurfaceObsState>((set) => ({
  displayMode: "station",
  elements: {
    wind: true,
    gust: true,
    sky: true,
    calm: true,
    temp: true,
    dewp: true,
    visibility: false,
    pressure: true,
    stationName: true,
  },
  spacing: 70,
  size: 1,

  tempUnits: "F",
  windUnits: "kt",
  presUnits: "mb",
  visUnits: "mi",

  maxAgeMin: 180,
  fadeStale: true,
  timelineUnix: null,
  layerBusy: false,
  layerError: null,
  layerLastUpdatedAt: null,

  setDisplayMode: (displayMode) => set({ displayMode }),
  toggleElement: (k) => set((s) => ({ elements: { ...s.elements, [k]: !s.elements[k] } })),
  setElementsPreset: (elements) => set({ elements }),
  setSpacing: (spacing) => set({ spacing }),
  setSize: (size) => set({ size }),
  setTempUnits: (tempUnits) => set({ tempUnits }),
  setWindUnits: (windUnits) => set({ windUnits }),
  setPresUnits: (presUnits) => set({ presUnits }),
  setVisUnits: (visUnits) => set({ visUnits }),
  setMaxAgeMin: (maxAgeMin) => set({ maxAgeMin }),
  setFadeStale: (fadeStale) => set({ fadeStale }),
  setTimelineUnix: (timelineUnix) => set({ timelineUnix }),
  setLayerStatus: (next) =>
    set((s) => ({
      layerBusy: "busy" in next ? Boolean(next.busy) : s.layerBusy,
      layerError: "error" in next ? (next.error ?? null) : s.layerError,
      layerLastUpdatedAt: "lastUpdatedAt" in next ? (next.lastUpdatedAt ?? null) : s.layerLastUpdatedAt,
    })),
}));
