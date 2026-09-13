import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";

/**
 * Drawing options for the 1000-500 hPa thickness. As with the isobars, the
 * *what* (model, hour) lives in useModelStore -- every model product shares it;
 * this is only the *how*.
 */
interface ThicknessState {
  /** Contour spacing in decametres. 6 is the chart convention. */
  interval: number;
  /** The dam value repeated along each line. */
  labels: boolean;
  lineWidth: number;

  busy: boolean;
  error: string | null;
  run: string | null;
  valid: string | null;
  counts: { lines: number };

  setInterval: (dam: number) => void;
  setLabels: (on: boolean) => void;
  setLineWidth: (w: number) => void;
  setStatus: (
    s: Partial<Pick<ThicknessState, "busy" | "error" | "run" | "valid" | "counts">>,
  ) => void;
}

export const THICK_INTERVALS = [3, 6, 12] as const;

/** Where the chart's two families of line meet: below it the layer is cold
 *  enough that precipitation usually falls as snow. */
export const THICK_DIVIDER = 540;

export const useThicknessStore = create<ThicknessState>()(
  subscribeWithSelector(
    persist(
      (set) => ({
        interval: 6,
        labels: true,
        lineWidth: 1,

        busy: false,
        error: null,
        run: null,
        valid: null,
        counts: { lines: 0 },

        setInterval: (interval) => set({ interval }),
        setLabels: (labels) => set({ labels }),
        setLineWidth: (lineWidth) => set({ lineWidth }),
        setStatus: (s) => set(s),
      }),
      {
        name: "weatherts.thickness",
        partialize: (s) => ({ interval: s.interval, labels: s.labels, lineWidth: s.lineWidth }),
      },
    ),
  ),
);
