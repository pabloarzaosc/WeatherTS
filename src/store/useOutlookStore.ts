import { create } from "zustand";

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
  run?: string | null;
  legend: OutlookLegendItem[];
}

interface OutlookState {
  metas: Record<string, OutlookMeta>;
  setMeta: (id: string, meta: OutlookMeta) => void;
  clearMeta: (id: string) => void;
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
}));
