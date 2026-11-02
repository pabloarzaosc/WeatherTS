import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { PolarScan } from "../lib/radarMesh";
import type { RadarMesh } from "../lib/radarMesh";

/**
 * Compare two products in one pane (panes-compare).
 *
 * A pane that compares is split by a divider: left of it the pane's own
 * product (useNexradStore.paneRadar), right of it a second product kept here.
 * The second product follows its pane: the same radar, the same frame (the
 * timeline's, or the pane's own scrubber), and the pane's tilt when it has one.
 *
 * `slots` (which product, where the divider is) is kept across reloads; the
 * loaded scan and mesh are not (lib/paneCompare.ts loads them).
 */

export interface CompareSlot {
  /** Product family of the right half ("G", "L2G", "C", ...). */
  family: string;
  /** Where the divider sits, as a share of the pane's width (0.05..0.95). */
  split: number;
}

export interface CompareView {
  scan: PolarScan | null;
  mesh: RadarMesh | null;
  /** Bumps whenever the mesh to draw changes. */
  rev: number;
  loading: boolean;
  /** Why nothing is drawn ("Not scanned yet", a failed load). */
  note: string | null;
  /** The wire code the scan is of. */
  product: string | null;
}

export const SPLIT_MIN = 0.05;
export const SPLIT_MAX = 0.95;
export const clampSplit = (v: number) => Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, Number.isFinite(v) ? v : 0.5));

const EMPTY_VIEW: CompareView = { scan: null, mesh: null, rev: 0, loading: false, note: null, product: null };

interface CompareState {
  slots: Record<string, CompareSlot>;
  views: Record<string, CompareView>;
  /** The pane whose divider was clicked: the arrow keys move it. */
  selected: string | null;
  /** The pane whose "Change product" list is open. */
  picking: string | null;

  viewOf: (paneId: string) => CompareView;
  setSlot: (paneId: string, slot: CompareSlot | null) => void;
  setSplit: (paneId: string, split: number) => void;
  setView: (paneId: string, patch: Partial<CompareView>) => void;
  select: (paneId: string | null) => void;
  setPicking: (paneId: string | null) => void;
}

export const useCompareStore = create<CompareState>()(
  persist(
    (set, get) => ({
      slots: {},
      views: {},
      selected: null,
      picking: null,

      viewOf: (paneId) => get().views[paneId] ?? EMPTY_VIEW,
      setSlot: (paneId, slot) => {
        const slots = { ...get().slots };
        const views = { ...get().views };
        if (slot) slots[paneId] = { family: slot.family, split: clampSplit(slot.split) };
        else {
          delete slots[paneId];
          delete views[paneId];
        }
        set({
          slots,
          views,
          selected: !slot && get().selected === paneId ? null : get().selected,
          picking: !slot && get().picking === paneId ? null : get().picking,
        });
      },
      setSplit: (paneId, split) => {
        const cur = get().slots[paneId];
        if (!cur) return;
        const v = clampSplit(split);
        if (v === cur.split) return;
        set({ slots: { ...get().slots, [paneId]: { ...cur, split: v } } });
      },
      setView: (paneId, patch) => {
        const cur = get().views[paneId] ?? EMPTY_VIEW;
        set({ views: { ...get().views, [paneId]: { ...cur, ...patch } } });
      },
      select: (selected) => set({ selected }),
      setPicking: (picking) => set({ picking }),
    }),
    {
      name: "weatherts-compare",
      version: 1,
      partialize: (s) => ({ slots: s.slots }),
    },
  ),
);
