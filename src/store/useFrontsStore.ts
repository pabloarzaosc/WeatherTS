import { create } from "zustand";

import {
  FRONT_KINDS,
  fetchFronts,
  type FrontFrame,
  type FrontKind,
  type FrontsResponse,
} from "../lib/fronts";

/**
 * Surface-analysis state.
 *
 * The bulletins give a series of frames — past analyses every 3 h plus the 12 h
 * and 24 h progs — so the fronts obey the ONE TIMELINE rule: the layer shows
 * whichever frame the bottom timeline is parked on, instead of being pinned to
 * "latest" with a slider of its own.
 */

const REFRESH_MS = 10 * 60 * 1000; // the analysis is 3-hourly
export const FRONT_HISTORY = 6;

let controller: AbortController | null = null;
let timer: number | null = null;

/** What the user clicked on the chart, for the detail card. */
export interface FrontPick {
  kind: string;
  label: string;
  strength: string;
  pressure: number | null;
  lngLat: [number, number];
}

interface FrontsState {
  frames: FrontFrame[];
  selected: FrontPick | null;
  /** Index into `frames`; -1 until the first load lands. */
  index: number;
  kinds: Record<FrontKind, boolean>;
  showCentres: boolean;
  busy: boolean;
  error: string | null;
  meta: FrontsResponse["meta"] | null;

  select: (p: FrontPick | null) => void;
  load: () => Promise<void>;
  setIndex: (i: number) => void;
  /** Park on the frame nearest an instant — how the timeline drives it. */
  goToUnix: (unix: number | null) => void;
  toggleKind: (k: FrontKind) => void;
  setShowCentres: (v: boolean) => void;
  start: () => void;
  stop: () => void;
}

const allOn = () =>
  FRONT_KINDS.reduce(
    (acc, k) => {
      acc[k] = true;
      return acc;
    },
    {} as Record<FrontKind, boolean>,
  );

export const useFrontsStore = create<FrontsState>((set, get) => ({
  frames: [],
  selected: null,
  index: -1,
  kinds: allOn(),
  showCentres: true,
  busy: false,
  error: null,
  meta: null,

  select: (selected) => set({ selected }),

  load: async () => {
    controller?.abort();
    controller = new AbortController();
    const mine = controller;
    set({ busy: true, error: null });
    try {
      const res = await fetchFronts(FRONT_HISTORY, mine.signal);
      if (mine.signal.aborted) return;
      // Keep the user where they were in time across a refresh, rather than
      // yanking them to the newest analysis mid-read.
      const wasUnix = get().frames[get().index]?.validUnix ?? null;
      let index = res.frames.findIndex((f) => f.kind === "analysis");
      index = res.frames.reduce(
        (best, f, i) => (f.kind === "analysis" ? i : best),
        index < 0 ? 0 : index,
      );
      if (wasUnix != null) {
        const near = nearestIndex(res.frames, wasUnix);
        if (near >= 0) index = near;
      }
      set({ frames: res.frames, meta: res.meta, index, busy: false, error: null });
    } catch (err) {
      if (mine.signal.aborted) return;
      set({ error: err instanceof Error ? err.message : String(err), busy: false });
    }
  },

  setIndex: (i) => {
    const n = get().frames.length;
    if (n === 0) return;
    set({ index: Math.max(0, Math.min(i, n - 1)) });
  },

  goToUnix: (unix) => {
    const { frames } = get();
    if (!frames.length) return;
    if (unix == null) {
      // "live" means the newest ANALYSIS, not the newest frame — the 24 h prog
      // is the newest frame and is emphatically not now.
      const last = frames.reduce((b, f, i) => (f.kind === "analysis" ? i : b), 0);
      set({ index: last });
      return;
    }
    const i = nearestIndex(frames, unix);
    if (i >= 0 && i !== get().index) set({ index: i });
  },

  toggleKind: (k) => set((s) => ({ kinds: { ...s.kinds, [k]: !s.kinds[k] } })),
  setShowCentres: (showCentres) => set({ showCentres }),

  start: () => {
    get().stop();
    timer = window.setInterval(() => void get().load(), REFRESH_MS);
  },
  stop: () => {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  },
}));

function nearestIndex(frames: FrontFrame[], unix: number): number {
  let best = -1;
  let bestDiff = Infinity;
  frames.forEach((f, i) => {
    if (f.validUnix == null) return;
    const d = Math.abs(f.validUnix - unix);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  });
  return best;
}

/** The features the layer should draw: current frame, minus filtered kinds. */
export function selectFrontFeatures(s: {
  frames: FrontFrame[];
  index: number;
  kinds: Record<FrontKind, boolean>;
  showCentres: boolean;
}) {
  const frame = s.frames[s.index];
  if (!frame) return [];
  return frame.features.filter((f) => {
    const kind = (f.properties as { kind: string }).kind;
    if (kind === "high" || kind === "low") return s.showCentres;
    return s.kinds[kind as FrontKind] !== false;
  });
}
