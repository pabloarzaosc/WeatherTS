import { create } from "zustand";

import type { SurfaceObsHistory } from "../lib/surfaceObs";

/**
 * The station whose full report is open.
 *
 * Separate from the map popup on purpose: the popup is a compact card that
 * MapLibre positions over a point, and the full report needs room for cards, a
 * chart and the raw text. Clicking through moves the reading from one to the
 * other rather than cramming both into the popup.
 */

export interface OpenStation {
  id: string;
  name: string | null;
  lat: number;
  lon: number;
  /** The observation the user clicked, kept so the panel has something to show
   *  before the history request comes back. */
  current: SurfaceObsHistory | Record<string, unknown>;
}

interface StationState {
  station: OpenStation | null;
  /** Hours of history the panel is showing, remembered between stations. */
  hours: number;
  /** Which reading is charted, likewise remembered. */
  metric: string;
  open: (s: OpenStation) => void;
  close: () => void;
  setHours: (h: number) => void;
  setMetric: (m: string) => void;
}

export const useStationStore = create<StationState>((set) => ({
  station: null,
  hours: 24,
  metric: "temp",
  open: (station) => set({ station }),
  close: () => set({ station: null }),
  setHours: (hours) => set({ hours }),
  setMetric: (metric) => set({ metric }),
}));
