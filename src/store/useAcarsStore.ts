import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

/** How far back to ask MADIS for profiles. Aircraft ascents are sparse away
 *  from the hubs, so a longer window trades currency for coverage. */
export const ACARS_WINDOWS = [3, 6, 12, 24] as const;
export type AcarsWindow = (typeof ACARS_WINDOWS)[number];

interface AcarsState {
  /** Hours of history requested from the feed. */
  windowH: AcarsWindow;
  /** Hide profiles older than this many minutes; null keeps the whole window. */
  maxAgeMin: number | null;
  /** Hide profiles thinner than this many levels -- a six-level ascent is a
   *  climb-out that stopped, not a sounding worth opening. */
  minLevels: number;
  /** Airport identifier under each dot. */
  showLabels: boolean;

  /** Feed status, so the panel can say why the map is empty. */
  busy: boolean;
  error: string | null;
  /** Airports in the last response, and how many survive the filters. */
  total: number;
  shown: number;
  lastUpdatedAt: number | null;

  setWindowH: (h: AcarsWindow) => void;
  setMaxAgeMin: (m: number | null) => void;
  setMinLevels: (n: number) => void;
  setShowLabels: (v: boolean) => void;
  setStatus: (s: Partial<Pick<AcarsState, "busy" | "error" | "total" | "shown" | "lastUpdatedAt">>) => void;
}

export const useAcarsStore = create<AcarsState>()(
  subscribeWithSelector((set) => ({
    windowH: 12,
    maxAgeMin: null,
    minLevels: 0,
    showLabels: true,

    busy: false,
    error: null,
    total: 0,
    shown: 0,
    lastUpdatedAt: null,

    setWindowH: (windowH) => set({ windowH }),
    setMaxAgeMin: (maxAgeMin) => set({ maxAgeMin }),
    setMinLevels: (minLevels) => set({ minLevels }),
    setShowLabels: (showLabels) => set({ showLabels }),
    setStatus: (s) => set(s),
  })),
);
