import { create } from "zustand";

import type { SurfaceObsHistory } from "../lib/surfaceObs";
import type { StationInfo } from "../lib/stations";

/**
 * The station whose full report is open.
 *
 * Separate from the map popup on purpose: the popup is a compact card that
 * MapLibre positions over a point, and the full report needs room for cards,
 * meteograms and the reports themselves. Clicking through moves the reading
 * from one to the other rather than cramming both into the popup.
 */

/** Which meteogram the station page is showing. */
export type StationProduct = "overview" | "temp" | "wind" | "pressure" | "sky" | "precip";

export const STATION_RANGES = [12, 24, 48, 72] as const;

export interface OpenStation {
  /** What the station is called on screen: the ICAO where there is one. */
  id: string;
  name: string | null;
  lat: number;
  lon: number;
  /** The directory entry, once we have matched one -- it carries the IEM id
   *  the history is fetched by, plus state, county, WFO and elevation. */
  info?: StationInfo | null;
  /** The observation the user clicked, kept so the panel has something to show
   *  before the history request comes back. */
  current: SurfaceObsHistory | Record<string, unknown>;
}

const RECENT_KEY = "wts.stations.recent";
const RECENT_MAX = 8;

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((v) => typeof v === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function writeRecent(list: string[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* private mode, blocked storage -- the list is a convenience, not state */
  }
}

interface StationState {
  station: OpenStation | null;
  /** Hours of history the panel is showing, remembered between stations. */
  hours: number;
  /** Which meteogram is showing, likewise remembered. */
  product: StationProduct;
  /** Which reading the single-metric chart draws (the Temperature tab and so on
   *  pick this for you; it stays for when you come back). */
  metric: string;
  /** Stations opened lately, by id, newest first. */
  recent: string[];
  open: (s: OpenStation) => void;
  close: () => void;
  setHours: (h: number) => void;
  setProduct: (p: StationProduct) => void;
  setMetric: (m: string) => void;
}

export const useStationStore = create<StationState>((set) => ({
  station: null,
  hours: 24,
  product: "overview",
  metric: "temp",
  recent: readRecent(),
  open: (station) =>
    set((s) => {
      const key = station.info?.icao || station.id;
      const recent = key ? [key, ...s.recent.filter((r) => r !== key)].slice(0, RECENT_MAX) : s.recent;
      if (recent !== s.recent) writeRecent(recent);
      return { station, recent };
    }),
  close: () => set({ station: null }),
  setHours: (hours) => set({ hours }),
  setProduct: (product) => set({ product }),
  setMetric: (metric) => set({ metric }),
}));
