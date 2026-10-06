import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TropicalTab =
  | "active"
  | "storm"
  | "outlooks"
  | "recon"
  | "season"
  | "climo"
  | "ocean"
  | "enso"
  | "satellite"
  | "products";

export type ReconColor = "fl" | "sfmr" | "xsp" | "alt";

interface TropicalState {
  /** The full-screen dashboard is up. */
  open: boolean;
  tab: TropicalTab;
  /** The storm the Storm tab, the guidance layer and the map follow. */
  storm: string | null;
  /** Every model on the map, not only the main guidance. */
  guidanceAll: boolean;
  /** Which NHC wind speed probability the map draws. */
  wspKt: 34 | 50 | 64;
  sst: "sst" | "anomaly";
  /** The day the SST map shows ("YYYY-MM-DD"); null is the newest. */
  sstDate: string | null;
  /** The season on the map and in the Season tab. */
  seasonBasin: string;
  seasonYear: number;
  /** Hurricane Hunter flights. */
  reconBasin: string;
  reconHours: number;
  /** An archive span instead of the last hours: ISO times. */
  reconSpan: { start: string; end: string } | null;
  /** The missions drawn on the map; empty draws them all. */
  reconPicked: string[];
  reconColor: ReconColor;
  /** The time under a chart's cursor, marked on the map. */
  hoverT: number | null;
  openTab: (tab?: TropicalTab, storm?: string | null) => void;
  close: () => void;
  setTab: (tab: TropicalTab) => void;
  setStorm: (id: string | null) => void;
  set: (p: Partial<TropicalState>) => void;
}

export const useTropicalStore = create<TropicalState>()(
  persist(
    (set) => ({
      open: false,
      tab: "active",
      storm: null,
      guidanceAll: false,
      wspKt: 34,
      sst: "anomaly",
      sstDate: null,
      seasonBasin: "al",
      seasonYear: new Date().getUTCFullYear(),
      reconBasin: "al",
      reconHours: 24,
      reconSpan: null,
      reconPicked: [],
      reconColor: "fl",
      hoverT: null,
      openTab: (tab, storm) => set((s) => ({ open: true, tab: tab ?? s.tab, storm: storm === undefined ? s.storm : storm })),
      close: () => set({ open: false, hoverT: null }),
      setTab: (tab) => set({ tab }),
      setStorm: (storm) => set({ storm }),
      set: (p) => set(p),
    }),
    {
      name: "weatherts-tropical",
      version: 1,
      partialize: (s) => ({
        tab: s.tab,
        guidanceAll: s.guidanceAll,
        wspKt: s.wspKt,
        sst: s.sst,
        seasonBasin: s.seasonBasin,
        reconBasin: s.reconBasin,
        reconHours: s.reconHours,
        reconColor: s.reconColor,
      }),
    },
  ),
);
