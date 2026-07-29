import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";

/**
 * Drawing options for the pressure field. The *what* (which model, which hour)
 * lives in useModelStore because every model product shares it; this is only
 * the *how* for isobars and centres.
 */
interface MslpState {
  /** Isobar spacing in hPa. 4 is the surface-chart convention. */
  interval: number;
  /** H / L markers at the pressure centres. */
  centres: boolean;
  /** The hPa value repeated along each isobar. */
  labels: boolean;
  lineWidth: number;

  busy: boolean;
  error: string | null;
  /** Run and valid time of what is currently drawn, for the panel readout. */
  run: string | null;
  valid: string | null;
  /** Machine-readable run time — the map timeline turns forecast hours into
   *  real clock times with it. */
  runIso: string | null;
  counts: { isobars: number; centres: number };

  setInterval: (hPa: number) => void;
  setCentres: (on: boolean) => void;
  setLabels: (on: boolean) => void;
  setLineWidth: (w: number) => void;
  /** Blur applied before contouring: lower keeps more of the wave detail. */
  smoothing: number;
  setSmoothing: (v: number) => void;

  setStatus: (
    s: Partial<Pick<MslpState, "busy" | "error" | "run" | "valid" | "runIso" | "counts">>,
  ) => void;
}

export const INTERVALS = [2, 4, 5, 8, 10] as const;

/** Detail presets. 0 is deliberately absent: with no blur at all the contour
 *  engine frays on grid noise and turns one system into a thousand slivers. */
export const SMOOTHING = [
  { value: 0.5, label: "Sharp" },
  { value: 1, label: "Normal" },
  { value: 2, label: "Smooth" },
] as const;

export const useMslpStore = create<MslpState>()(
  subscribeWithSelector(
    persist(
      (set) => ({
        interval: 4,
        centres: true,
        labels: true,
        lineWidth: 1,
        smoothing: 1,

        busy: false,
        error: null,
        run: null,
        valid: null,
        runIso: null,
        counts: { isobars: 0, centres: 0 },

        setInterval: (interval) => set({ interval }),
        setCentres: (centres) => set({ centres }),
        setLabels: (labels) => set({ labels }),
        setLineWidth: (lineWidth) => set({ lineWidth }),
        setSmoothing: (smoothing) => set({ smoothing }),
        setStatus: (s) => set(s),
      }),
      {
        name: "weatherts.mslp",
        partialize: (s) => ({
          interval: s.interval,
          centres: s.centres,
          labels: s.labels,
          lineWidth: s.lineWidth,
          smoothing: s.smoothing,
        }),
      },
    ),
  ),
);
