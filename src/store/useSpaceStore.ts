import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { RangeId } from "../lib/space/data";

export type SpaceTab =
  | "overview"
  | "wind"
  | "sun"
  | "flares"
  | "geomag"
  | "aurora"
  | "iono"
  | "cme"
  | "cycle"
  | "alerts"
  | "reports";

/** What the space weather map layer draws. */
export type SpaceField = "drap" | "tec" | "anomaly" | "efield";

export interface SpaceHover {
  x: number;
  y: number;
  text: string;
}

interface SpaceState {
  /** The full-screen dashboard is up. */
  open: boolean;
  tab: SpaceTab;
  range: RangeId;
  field: SpaceField;
  /** The map readout under the pointer, set by the aurora and field layers. */
  hover: SpaceHover | null;
  /** When each map layer's data is valid, for the legend. */
  auroraValid: number | null;
  fieldValid: number | null;
  /** The alert the Alerts tab opens on. */
  pickedAlert: string | null;
  pickAlert: (id: string | null) => void;
  openTab: (tab?: SpaceTab) => void;
  close: () => void;
  setTab: (tab: SpaceTab) => void;
  setRange: (r: RangeId) => void;
  setField: (f: SpaceField) => void;
  setHover: (h: SpaceHover | null) => void;
  setValid: (k: "auroraValid" | "fieldValid", t: number | null) => void;
}

export const useSpaceStore = create<SpaceState>()(
  persist(
    (set) => ({
      open: false,
      tab: "overview",
      range: "1d",
      field: "drap",
      hover: null,
      auroraValid: null,
      fieldValid: null,
      pickedAlert: null,
      pickAlert: (pickedAlert) => set(pickedAlert ? { pickedAlert, tab: "alerts" } : { pickedAlert }),
      openTab: (tab) => set((s) => ({ open: true, tab: tab ?? s.tab })),
      close: () => set({ open: false }),
      setTab: (tab) => set({ tab }),
      setRange: (range) => set({ range }),
      setField: (field) => set({ field }),
      setHover: (hover) => set({ hover }),
      setValid: (k, t) => set({ [k]: t } as Partial<SpaceState>),
    }),
    {
      name: "weatherts-space",
      version: 1,
      partialize: (s) => ({ tab: s.tab, range: s.range, field: s.field }),
    },
  ),
);
