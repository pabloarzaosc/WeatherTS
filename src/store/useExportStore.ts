import { create } from "zustand";
import { persist } from "zustand/middleware";

import { getActivePaneId } from "../map/mapInstance";

/**
 * The Export page (src/ui/ExportPage.tsx): what it exports -- one pane or all
 * of them -- its options, the run in progress and what was saved last.
 * The options are kept per viewer (localStorage); the rest is per session.
 */

export type ExportKind = "image" | "gif" | "video";
/** Output size for GIF and video: the long side in pixels, or the screen's. */
export type ExportSize = "640" | "960" | "1280" | "full";
export const EXPORT_SIZES: ExportSize[] = ["640", "960", "1280", "full"];
/** The longest side a GIF or video may have. */
export const MAX_ANIM_SIDE = 1920;
export const FPS_MIN = 2;
export const FPS_MAX = 20;

export interface ExportJob {
  kind: ExportKind;
  phase: "capturing" | "encoding" | "saving";
  done: number;
  total: number;
}

export interface ExportResult {
  kind: ExportKind;
  name: string;
  /** Where the desktop app saved it; null in the browser (a download). */
  path: string | null;
  /** "1 frame could not be loaded", the video's format... */
  note?: string;
}

interface ExportState {
  open: boolean;
  /** The pane the page was opened from (the focused one from the dock). */
  paneId: string;
  /** Every pane together, in place. */
  all: boolean;
  caption: boolean;
  size: ExportSize;
  /** The loop's own speed, or a fixed frame rate. */
  speed: "loop" | "fps";
  fps: number;

  job: ExportJob | null;
  result: ExportResult | null;
  error: { kind: ExportKind; message: string } | null;
  /** The toast after a save; `at` makes a second save show it again. */
  toast: (ExportResult & { at: number }) | null;

  openFor: (paneId: string, all?: boolean) => void;
  close: () => void;
  setAll: (all: boolean) => void;
  setCaption: (caption: boolean) => void;
  setSize: (size: ExportSize) => void;
  setSpeed: (speed: "loop" | "fps") => void;
  setFps: (fps: number) => void;
  setJob: (job: ExportJob | null) => void;
  finish: (result: ExportResult | null, error?: { kind: ExportKind; message: string } | null) => void;
  dismissToast: () => void;
}

const clampFps = (v: number) => Math.max(FPS_MIN, Math.min(FPS_MAX, Math.round(Number.isFinite(v) ? v : 10)));

export const useExportStore = create<ExportState>()(
  persist(
    (set) => ({
      open: false,
      paneId: "pane-0",
      all: false,
      caption: true,
      size: "960",
      speed: "loop",
      fps: 8,
      job: null,
      result: null,
      error: null,
      toast: null,

      openFor: (paneId, all) => set({ open: true, paneId, ...(all != null ? { all } : {}), result: null, error: null }),
      close: () => set({ open: false }),
      setAll: (all) => set({ all, result: null, error: null }),
      setCaption: (caption) => set({ caption }),
      setSize: (size) => set({ size }),
      setSpeed: (speed) => set({ speed }),
      setFps: (fps) => set({ fps: clampFps(fps) }),
      setJob: (job) => set({ job }),
      finish: (result, error = null) =>
        set({ job: null, result, error, ...(result ? { toast: { ...result, at: Date.now() } } : {}) }),
      dismissToast: () => set({ toast: null }),
    }),
    {
      name: "weatherts-export",
      version: 1,
      partialize: (s) => ({ caption: s.caption, size: s.size, speed: s.speed, fps: s.fps }),
    },
  ),
);

/** Open the Export page for a pane (the focused one when none is given);
 *  `all` picks every pane together. Here, not in ExportPage.tsx, so that file
 *  exports components only (a Fast Refresh boundary in development). */
export function openExport(paneId?: string | null, all?: boolean): void {
  useExportStore.getState().openFor(paneId ?? getActivePaneId() ?? "pane-0", all);
}
