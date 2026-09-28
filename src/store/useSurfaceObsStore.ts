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
  | "precip"
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
  /** Present weather (-RA, TSGR...) beside the station, where a plot puts it. */
  weather: boolean;
  /** The last hour's rain, where any fell. */
  rain: boolean;
}

export type TempUnit = "F" | "C";
export type WindUnit = "kt" | "mph" | "ms";
export type PresUnit = "mb" | "inHg";
export type VisUnit = "mi" | "km";

/** Which station networks are plotted. */
export interface StationNetworks {
  /** Airports (METAR). */
  metar: boolean;
  /** Official networks: WMO synoptic stations, and INMET's with a token. */
  synop: boolean;
  /** Mesonets and personal stations (NOAA MADIS: state networks, CWOP...). */
  mesonet: boolean;
}

/** 0 means "no age limit" -- every observation the feed returns is plotted. */
export const AGE_UNLIMITED = 0;

interface SurfaceObsState {
  displayMode: SurfaceDisplayMode;
  networks: StationNetworks;
  toggleNetwork: (k: keyof StationNetworks) => void;
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
  /** Layer fetch state for UI feedback in the Surface Obs panel. */
  layerBusy: boolean;
  layerError: string | null;
  layerLastUpdatedAt: number | null;
  /**
   * The instant the plots show (unix s), set by the timeline while a radar,
   * satellite or analysis frame from the past is on screen; null is now. The
   * plots showed the newest reports whatever the frame, so a storm on a radar
   * scan from an hour ago sat over stations reporting now.
   */
  atUnix: number | null;
  /** Networks with nothing for `atUnix` (their data are not kept that long). */
  unavailable: string[];

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
  setLayerStatus: (next: { busy?: boolean; error?: string | null; lastUpdatedAt?: number | null }) => void;
  setAtUnix: (t: number | null) => void;
  setUnavailable: (nets: string[]) => void;
}

/** Ready-made element combinations. A full station plot is dense; these are the
 *  groupings people actually switch between, one click instead of nine. */
export const ELEMENT_PRESETS: { id: string; label: string; hint: string; elements: StationElements }[] = [
  {
    id: "full",
    label: "Full plot",
    hint: "Every element",
    elements: { wind: true, gust: true, sky: true, calm: true, temp: true, dewp: true, visibility: true, pressure: true, stationName: true, weather: true, rain: true },
  },
  {
    id: "standard",
    label: "Standard",
    hint: "The classic six",
    elements: { wind: true, gust: true, sky: true, calm: true, temp: true, dewp: true, visibility: false, pressure: true, stationName: true, weather: true, rain: true },
  },
  {
    id: "wind",
    label: "Wind only",
    hint: "Barbs and gusts",
    elements: { wind: true, gust: true, sky: false, calm: true, temp: false, dewp: false, visibility: false, pressure: false, stationName: false, weather: false, rain: false },
  },
  {
    id: "thermo",
    label: "Thermo",
    hint: "Temp and dewpoint",
    elements: { wind: false, gust: false, sky: false, calm: false, temp: true, dewp: true, visibility: false, pressure: false, stationName: false, weather: false, rain: false },
  },
];

export const useSurfaceObsStore = create<SurfaceObsState>((set) => ({
  displayMode: "station",
  networks: { metar: true, synop: true, mesonet: true },
  toggleNetwork: (k) => set((s) => ({ networks: { ...s.networks, [k]: !s.networks[k] } })),
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
    weather: true,
    rain: true,
  },
  // Denser than a textbook plot (70): with the synoptic and mesonet stations
  // there is far more to show, and the slider goes either way.
  spacing: 55,
  size: 1,

  tempUnits: "F",
  windUnits: "kt",
  presUnits: "mb",
  visUnits: "mi",

  maxAgeMin: 180,
  fadeStale: true,
  layerBusy: false,
  layerError: null,
  layerLastUpdatedAt: null,
  atUnix: null,
  unavailable: [],

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
  setAtUnix: (atUnix) => set((s) => (s.atUnix === atUnix ? s : { atUnix })),
  setUnavailable: (unavailable) =>
    set((s) => (s.unavailable.join() === unavailable.join() ? s : { unavailable })),
  setLayerStatus: (next) =>
    set((s) => ({
      layerBusy: "busy" in next ? Boolean(next.busy) : s.layerBusy,
      layerError: "error" in next ? (next.error ?? null) : s.layerError,
      layerLastUpdatedAt: "lastUpdatedAt" in next ? (next.lastUpdatedAt ?? null) : s.layerLastUpdatedAt,
    })),
}));
