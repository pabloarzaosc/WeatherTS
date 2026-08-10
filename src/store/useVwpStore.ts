import { create } from "zustand";

import { fetchNexradVwp, type VwpReport } from "../lib/nexrad";

/**
 * VAD Wind Profile viewer state.
 *
 * The profile always belongs to the radar site the radar layer is pointed at,
 * so there is no site picker here — opening the VWP for a different radar means
 * selecting that radar, which keeps one source of truth for "which site".
 */

const REFRESH_MS = 2 * 60 * 1000;

let controller: AbortController | null = null;
let timer: number | null = null;

interface VwpState {
  open: boolean;
  site: string | null;
  columns: number;
  data: VwpReport | null;
  busy: boolean;
  error: string | null;

  setOpen: (open: boolean, site?: string | null) => void;
  setColumns: (n: number) => void;
  load: (site?: string | null) => Promise<void>;
  stop: () => void;
}

export const VWP_COLUMN_CHOICES = [6, 12, 18, 24] as const;

export const useVwpStore = create<VwpState>((set, get) => ({
  open: false,
  site: null,
  columns: 12,
  data: null,
  busy: false,
  error: null,

  setOpen: (open, site) => {
    if (!open) {
      get().stop();
      set({ open: false, error: null });
      return;
    }
    const next = site ?? get().site;
    set({ open: true, site: next ?? null, data: next === get().site ? get().data : null });
    if (next) void get().load(next);
  },

  setColumns: (columns) => {
    if (columns === get().columns) return;
    set({ columns });
    if (get().open && get().site) void get().load();
  },

  load: async (site) => {
    const target = site ?? get().site;
    if (!target) return;
    controller?.abort();
    controller = new AbortController();
    const mine = controller;
    set({ busy: true, error: null, site: target });
    try {
      const data = await fetchNexradVwp(target, get().columns, mine.signal);
      if (mine.signal.aborted) return;
      set({ data, busy: false, error: null });
      // Keep it live: a new volume every ~4-6 minutes adds a column.
      if (timer !== null) window.clearInterval(timer);
      timer = window.setInterval(() => {
        if (get().open && get().site) void get().load();
      }, REFRESH_MS);
    } catch (err) {
      if (mine.signal.aborted) return;
      set({ error: err instanceof Error ? err.message : String(err), busy: false, data: null });
    }
  },

  stop: () => {
    controller?.abort();
    controller = null;
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  },
}));
