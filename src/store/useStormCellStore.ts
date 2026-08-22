import { create } from "zustand";

/**
 * The storm cell whose full report is open.
 *
 * Same split as the station report (see useStationStore): the map popup is a
 * compact card anchored to the cell, and the full report needs room for the
 * trend charts. Clicking through moves the reading from one to the other.
 *
 * Only the id is held, not a copy of the cell: the radar keeps polling, and the
 * panel should follow the live cell rather than freeze the one that was clicked.
 */
interface StormCellState {
  cellId: string | null;
  /** Which attribute the chart is plotting, remembered between cells. */
  metric: string;
  /** How many recent volumes the trend chart requests, remembered between
   *  cells the same way `metric` is. The backend clamps this to [2, 40]. */
  volumes: number;
  open: (cellId: string) => void;
  close: () => void;
  setMetric: (m: string) => void;
  setVolumes: (n: number) => void;
}

/** Matches storm_attributes.DEFAULT_HISTORY_VOLUMES on the backend. */
export const DEFAULT_HISTORY_VOLUMES = 14;

export const useStormCellStore = create<StormCellState>((set) => ({
  cellId: null,
  metric: "vilKgM2",
  volumes: DEFAULT_HISTORY_VOLUMES,
  open: (cellId) => set({ cellId }),
  close: () => set({ cellId: null }),
  setMetric: (metric) => set({ metric }),
  setVolumes: (volumes) => set({ volumes }),
}));
