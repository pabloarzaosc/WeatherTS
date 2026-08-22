import { create } from "zustand";

import { fetchNexradVwp, fetchVwpPanel, type VwpPanelReport, type VwpReport } from "../lib/nexrad";

/**
 * VAD Wind Profile viewer state.
 *
 * The profile always belongs to the radar site the radar layer is pointed at,
 * so there is no site picker here — opening the VWP for a different radar means
 * selecting that radar, which keeps one source of truth for "which site".
 */

const REFRESH_MS = 2 * 60 * 1000;

let controller: AbortController | null = null;
let panelController: AbortController | null = null;
let timer: number | null = null;

/** Which vector the storm-relative quantities are measured against. */
export type VwpMotion =
  | "right"
  | "left"
  | "mean"
  | "corfidi-up"
  | "corfidi-down"
  | "nixon-right"
  | "nixon-left"
  | "custom";

export const VWP_MOTION_LABELS: Record<VwpMotion, string> = {
  right: "Bunkers right",
  left: "Bunkers left",
  mean: "Mean wind",
  "corfidi-up": "Corfidi upshear",
  "corfidi-down": "Corfidi downshear",
  "nixon-right": "Nixon dev. right",
  "nixon-left": "Nixon dev. left",
  custom: "Custom",
};

interface VwpState {
  open: boolean;
  site: string | null;
  columns: number;
  data: VwpReport | null;
  busy: boolean;
  error: string | null;

  /** The SHARPpy-rendered hodograph panel for the newest volume. */
  panel: VwpPanelReport | null;
  panelBusy: boolean;
  panelError: string | null;

  /** Hodograph display and the storm motion every SR number is relative to. */
  motion: VwpMotion;
  customDir: number;
  customSpd: number;
  ringStepKt: number | null; // null = fit the profile
  showHeights: boolean;
  showMotions: boolean;

  setOpen: (open: boolean, site?: string | null) => void;
  setColumns: (n: number) => void;
  setMotion: (m: VwpMotion) => void;
  setCustomMotion: (dir: number, spd: number) => void;
  setRingStep: (kt: number | null) => void;
  setShowHeights: (v: boolean) => void;
  setShowMotions: (v: boolean) => void;
  load: (site?: string | null) => Promise<void>;
  loadPanel: (site?: string | null) => Promise<void>;
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

  panel: null,
  panelBusy: false,
  panelError: null,

  motion: "right",
  customDir: 240,
  customSpd: 30,
  ringStepKt: null,
  showHeights: true,
  showMotions: true,

  setMotion: (motion) => {
    if (motion === get().motion) return;
    set({ motion });
  },
  setCustomMotion: (customDir, customSpd) => {
    set({ customDir, customSpd, motion: "custom" });
  },
  setRingStep: (ringStepKt) => set({ ringStepKt }),
  setShowHeights: (showHeights) => set({ showHeights }),
  setShowMotions: (showMotions) => set({ showMotions }),

  setOpen: (open, site) => {
    if (!open) {
      get().stop();
      set({ open: false, error: null });
      return;
    }
    const next = site ?? get().site;
    const sameSite = next === get().site;
    set({
      open: true,
      site: next ?? null,
      data: sameSite ? get().data : null,
      panel: sameSite ? get().panel : null,
      panelError: null,
    });
    // Only the time-height display is fetched on open. loadPanel() renders the
    // SHARPpy hodograph sheet, which nothing shows any more -- an 8-second
    // server render per site change, thrown away. Left callable rather than
    // deleted; call it again the day that panel comes back.
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
        if (!get().open || !get().site) return;
        void get().load();
      }, REFRESH_MS);
    } catch (err) {
      if (mine.signal.aborted) return;
      set({ error: err instanceof Error ? err.message : String(err), busy: false, data: null });
    }
  },

  loadPanel: async (site) => {
    const target = site ?? get().site;
    if (!target) return;
    panelController?.abort();
    panelController = new AbortController();
    const mine = panelController;
    set({ panelBusy: true, panelError: null });
    try {
      const motion = get().motion;
      const custom = motion === "custom" ? { dir: get().customDir, spd: get().customSpd } : null;
      const panel = await fetchVwpPanel(target, motion, custom, mine.signal);
      if (mine.signal.aborted) return;
      set({ panel, panelBusy: false, panelError: null });
    } catch (err) {
      if (mine.signal.aborted) return;
      set({
        panelError: err instanceof Error ? err.message : String(err),
        panelBusy: false,
        panel: null,
      });
    }
  },

  stop: () => {
    controller?.abort();
    controller = null;
    panelController?.abort();
    panelController = null;
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  },
}));
