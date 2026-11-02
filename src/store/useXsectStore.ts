import { create } from "zustand";

import { fetchXsect, type XsectData } from "../lib/xsect";
import { TDWR_VOLUME_NOTE } from "../lib/nexrad";
import { isTdwrId } from "./useNexradStore";
import { describe } from "../lib/patience";
import { onRadarOptionsChange } from "../lib/radarOptions";

/**
 * The radar cross-section: the line drawn on the map, the moment shown, and
 * the section itself. It follows the radar frame on screen (`at`, or the
 * frame's own Level II `key`), so stepping a loop slices each volume in turn.
 */

export type XsectUnits = "imperial" | "metric";
type LngLat = [number, number];

const UNITS_KEY = "weatherts.xsect.units";
const TOP_KEY = "weatherts.xsect.topKm";

function stored<T>(key: string, fallback: T, ok: (v: unknown) => boolean): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const v = JSON.parse(raw);
    return ok(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function keep(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode: the choice lasts the session */
  }
}

let controller: AbortController | null = null;
let inFlight = false;
let again = false;
let debounce: number | null = null;

interface XsectState {
  /** Picking the line's two ends on the map. */
  drawing: boolean;
  a: LngLat | null;
  b: LngLat | null;
  site: string | null;
  fam: string;
  topKm: number;
  units: XsectUnits;
  /** The frame on screen: its time, and its Level II key when it has one. */
  at: number | null;
  key: string;
  data: XsectData | null;
  busy: boolean;
  error: string | null;
  /** Where the pointer is over the section, 0 (A) to 1 (B): marked on the map. */
  hover: number | null;

  setHover: (t: number | null) => void;
  startDrawing: () => void;
  cancelDrawing: () => void;
  setLine: (a: LngLat, b: LngLat) => void;
  setFam: (fam: string) => void;
  setTopKm: (km: number) => void;
  setUnits: (u: XsectUnits) => void;
  setFrame: (site: string | null, at: number | null, key: string) => void;
  close: () => void;
  load: () => Promise<void>;
  reload: () => void;
}

export const useXsectStore = create<XsectState>((set, get) => ({
  drawing: false,
  a: null,
  b: null,
  site: null,
  fam: "B",
  topKm: stored(TOP_KEY, 16, (v) => typeof v === "number" && v >= 4 && v <= 25),
  units: stored(UNITS_KEY, "imperial" as XsectUnits, (v) => v === "imperial" || v === "metric"),
  at: null,
  key: "",
  data: null,
  busy: false,
  error: null,
  hover: null,

  setHover: (hover) => set({ hover }),
  startDrawing: () => set({ drawing: true }),
  cancelDrawing: () => set({ drawing: false }),
  setLine: (a, b) => {
    set({ a, b, drawing: false });
    get().reload();
  },
  setFam: (fam) => {
    if (fam === get().fam) return;
    set({ fam });
    get().reload();
  },
  setTopKm: (topKm) => {
    keep(TOP_KEY, topKm);
    set({ topKm });
    get().reload();
  },
  setUnits: (units) => {
    keep(UNITS_KEY, units);
    set({ units });
  },
  setFrame: (site, at, key) => {
    const s = get();
    if (site === s.site && at === s.at && key === s.key) return;
    set({ site, at, key });
    if (s.a && s.b) get().reload();
  },
  close: () => {
    controller?.abort();
    controller = null;
    inFlight = false;
    again = false;
    set({ a: null, b: null, drawing: false, data: null, busy: false, error: null });
  },

  load: async () => {
    const { a, b, site, fam, at, key, topKm } = get();
    if (!a || !b || !site) return;
    // The panel stays, and says why: the radar moved to an airport radar.
    if (isTdwrId(site)) {
      controller?.abort();
      set({ data: null, busy: false, error: TDWR_VOLUME_NOTE });
      return;
    }
    // One at a time: a loop stepping through volumes must not cancel each
    // section before it arrives; the newest frame's follows the one in flight.
    if (inFlight) {
      again = true;
      return;
    }
    const ctrl = new AbortController();
    controller = ctrl;
    inFlight = true;
    again = false;
    set({ busy: true });
    try {
      const data = await fetchXsect({ site, a, b, fam, at, key, topKm }, ctrl.signal);
      if (ctrl.signal.aborted) return;
      set({ data, busy: false, error: null });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      set({ busy: false, error: describe(err, "The radar service") });
    } finally {
      if (controller === ctrl) {
        inFlight = false;
        if (again) void get().load();
      }
    }
  },

  reload: () => {
    if (debounce != null) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      debounce = null;
      void get().load();
    }, 80);
  },
}));

// The velocity options (Settings > Radar > Velocity) change what velocity and
// SRV show: an open section of either is asked again.
onRadarOptionsChange(() => {
  const s = useXsectStore.getState();
  if (s.a && s.b && (s.fam === "G" || s.fam === "S")) s.reload();
});
