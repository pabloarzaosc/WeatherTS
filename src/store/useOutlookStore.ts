import { create } from "zustand";

import type { OutlookWhen } from "../lib/outlooks";
import { useAppStore } from "./useAppStore";

export interface OutlookLegendItem {
  label: string;
  color: string;
  section?: string;
}

export interface OutlookMeta {
  id: string;
  name: string;
  source: string;
  stale: boolean;
  error: string | null;
  valid: string | null;
  expire: string | null;
  issued?: string | null;
  forecaster?: string | null;
  run?: string | null;
  /** Why nothing is drawn, when nothing is: the source's words, or ours. */
  note?: string | null;
  legend: OutlookLegendItem[];
}

interface OutlookState {
  metas: Record<string, OutlookMeta>;
  setMeta: (id: string, meta: OutlookMeta) => void;
  clearMeta: (id: string) => void;
  /**
   * The issuance shown, for the outlooks that keep an archive (SPC's
   * convective outlooks): null for the newest of each, or a date and time.
   */
  when: OutlookWhen | null;
  setWhen: (when: OutlookWhen | null) => void;
  /** Draw the issuance before the one shown, as an outline: what changed. */
  compare: boolean;
  setCompare: (on: boolean) => void;
  /** Each shown outlook's polygons, for the risk at a clicked point. */
  data: Record<string, GeoJSON.FeatureCollection>;
  setData: (id: string, fc: GeoJSON.FeatureCollection | null) => void;
  /** Bumped to open the Outlooks panel in the Catalog (the top-bar picker's link). */
  panelRequest: number;
  openPanel: () => void;
}

export const useOutlookStore = create<OutlookState>((set) => ({
  metas: {},
  setMeta: (id, meta) => set((s) => ({ metas: { ...s.metas, [id]: meta } })),
  clearMeta: (id) =>
    set((s) => {
      const metas = { ...s.metas };
      delete metas[id];
      return { metas };
    }),
  when: null,
  setWhen: (when) =>
    set((s) => (s.when?.date === when?.date && s.when?.time === when?.time ? s : { when })),
  compare: false,
  setCompare: (compare) => set({ compare }),
  panelRequest: 0,
  openPanel: () => {
    set((s) => ({ panelRequest: s.panelRequest + 1 }));
    const app = useAppStore.getState();
    app.setCatalogTab("default");
    app.setDataView("catalog");
  },
  data: {},
  setData: (id, fc) =>
    set((s) => {
      const data = { ...s.data };
      if (fc) data[id] = fc;
      else delete data[id];
      return { data };
    }),
}));
