import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * How the aviation layers are drawn: each layer's filters, kept across
 * restarts. The layers read these and redraw when they change; the counts and
 * errors are what they report back for the panel.
 */

export const GAIRMET_HAZARDS = ["IFR", "MT_OBSC", "TURB-HI", "TURB-LO", "ICE", "FZLVL", "M_FZLVL", "LLWS", "SFC_WND"] as const;
export const SIGMET_KINDS = ["convective", "sigmet", "intl"] as const;
export const AIRSPACE_CLASSES = ["B", "C", "D"] as const;
export const SUA_TYPES = ["R", "P", "MOA", "W", "A", "D"] as const;
/** The FB forecast's heights; the GFS gives every one of them anywhere. */
export const ALOFT_HEIGHTS = [3000, 6000, 9000, 12000, 15000, 18000, 21000, 24000, 27000, 30000, 34000, 39000, 45000, 53000] as const;
export const FB_HEIGHTS = [3000, 6000, 9000, 12000, 18000, 24000, 30000, 34000, 39000, 45000, 53000] as const;

export type SigmetKind = (typeof SIGMET_KINDS)[number];

interface AviationState {
  /** The TAF layer's moment: hours from now. */
  tafHours: number;
  /** What the TAF layer colours by: what prevails, or the worst a TEMPO/PROB allows. */
  tafWorst: boolean;
  pirepAge: number;
  pirepTurb: boolean;
  pirepIce: boolean;
  pirepOther: boolean;
  /** Lowest intensity drawn: 0 every report, 1 light and up, 2 moderate, 3 severe. */
  pirepMin: number;
  pirepLow: number;
  pirepHigh: number;
  gairmetFore: number;
  gairmetHazards: string[];
  sigmetKinds: SigmetKind[];
  /** Winds aloft from the GFS worldwide, or the FB forecast at US stations. */
  windsSource: "gfs" | "fb";
  /** The GFS winds' hour: hours from now. */
  windsLead: number;
  windsLevel: "low" | "high";
  windsFcst: "06" | "12" | "24";
  windsHeight: number;
  firLabels: boolean;
  airspaceClasses: string[];
  suaTypes: string[];
  metarLabels: boolean;
  /** What each layer last loaded: how many, and any error. Not kept. */
  counts: Record<string, number>;
  errors: Record<string, string | null>;
  set: (patch: Partial<Omit<AviationState, "set" | "report">>) => void;
  report: (layer: string, count: number | null, error?: string | null) => void;
}

export const useAviationStore = create<AviationState>()(
  persist(
    (set, get) => ({
      tafHours: 0,
      tafWorst: false,
      pirepAge: 3,
      pirepTurb: true,
      pirepIce: true,
      pirepOther: false,
      pirepMin: 0,
      pirepLow: 0,
      pirepHigh: 60000,
      gairmetFore: 0,
      gairmetHazards: [...GAIRMET_HAZARDS],
      sigmetKinds: [...SIGMET_KINDS],
      windsSource: "gfs",
      windsLead: 0,
      windsLevel: "low",
      windsFcst: "06",
      windsHeight: 9000,
      firLabels: true,
      airspaceClasses: ["B", "C", "D"],
      suaTypes: ["R", "P", "MOA", "W", "A", "D"],
      metarLabels: true,
      counts: {},
      errors: {},
      set: (patch) => set(patch),
      report: (layer, count, error = null) =>
        set({
          counts: count == null ? get().counts : { ...get().counts, [layer]: count },
          errors: { ...get().errors, [layer]: error },
        }),
    }),
    {
      name: "weatherts.aviation",
      partialize: ({ counts: _c, errors: _e, set: _s, report: _r, ...keep }) => keep,
    },
  ),
);
