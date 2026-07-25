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

interface SurfaceObsState {
  displayMode: SurfaceDisplayMode;
  elements: StationElements;
  spacing: number; // min px between plotted stations (declutter)
  size: number; // plot scale multiplier
  units: "F" | "C";

  setDisplayMode: (m: SurfaceDisplayMode) => void;
  toggleElement: (k: keyof StationElements) => void;
  setSpacing: (px: number) => void;
  setSize: (s: number) => void;
  setUnits: (u: "F" | "C") => void;
}

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
  units: "F",

  setDisplayMode: (displayMode) => set({ displayMode }),
  toggleElement: (k) => set((s) => ({ elements: { ...s.elements, [k]: !s.elements[k] } })),
  setSpacing: (spacing) => set({ spacing }),
  setSize: (size) => set({ size }),
  setUnits: (units) => set({ units }),
}));
