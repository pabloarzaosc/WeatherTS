import { create } from "zustand";

import {
  fetchLsr,
  LSR_CATEGORIES,
  type LsrCategory,
  type LsrCollection,
  type LsrProps,
} from "../lib/lsr";

/**
 * Local Storm Reports state.
 *
 * `endUnix` is what makes LSRs obey the ONE TIMELINE rule: the layer always
 * shows the `hours` window ENDING at the timeline's position, so scrubbing back
 * over a radar loop shows the reports that existed at that moment rather than
 * every report filed since.
 */

export const LSR_WINDOWS = [1, 3, 6, 12, 24, 48] as const;
export type LsrWindow = (typeof LSR_WINDOWS)[number];

let controller: AbortController | null = null;
let debounce: number | null = null;

interface LsrState {
  hours: LsrWindow;
  /** null = live (window ends now). */
  endUnix: number | null;
  cats: Record<LsrCategory, boolean>;
  /** Draw a report's magnitude next to its icon. */
  showLabels: boolean;
  data: LsrCollection | null;
  busy: boolean;
  error: string | null;
  updatedAt: number | null;
  /** Report the user clicked, for the detail card. */
  selected: GeoJSON.Feature<GeoJSON.Point, LsrProps> | null;

  setHours: (h: LsrWindow) => void;
  setEndUnix: (t: number | null) => void;
  toggleCat: (c: LsrCategory) => void;
  setAllCats: (on: boolean) => void;
  setShowLabels: (v: boolean) => void;
  select: (f: LsrState["selected"]) => void;
  load: () => Promise<void>;
  reload: () => void;
}

const allOn = () =>
  LSR_CATEGORIES.reduce(
    (acc, c) => {
      acc[c] = true;
      return acc;
    },
    {} as Record<LsrCategory, boolean>,
  );

export const useLsrStore = create<LsrState>((set, get) => ({
  hours: 6,
  endUnix: null,
  cats: allOn(),
  showLabels: true,
  data: null,
  busy: false,
  error: null,
  updatedAt: null,
  selected: null,

  setHours: (hours) => {
    if (hours === get().hours) return;
    set({ hours });
    get().reload();
  },
  setEndUnix: (endUnix) => {
    if (endUnix === get().endUnix) return;
    set({ endUnix });
    get().reload();
  },
  toggleCat: (c) => set((s) => ({ cats: { ...s.cats, [c]: !s.cats[c] } })),
  setAllCats: (on) =>
    set({
      cats: LSR_CATEGORIES.reduce(
        (acc, c) => {
          acc[c] = on;
          return acc;
        },
        {} as Record<LsrCategory, boolean>,
      ),
    }),
  setShowLabels: (showLabels) => set({ showLabels }),
  select: (selected) => set({ selected }),

  // Scrubbing fires this on every frame, so coalesce: only the position the
  // user settles on is worth a request.
  reload: () => {
    if (debounce !== null) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      debounce = null;
      void get().load();
    }, 160);
  },

  load: async () => {
    const { hours, endUnix } = get();
    controller?.abort();
    controller = new AbortController();
    const mine = controller;
    set({ busy: true, error: null });
    try {
      const data = await fetchLsr(hours, endUnix, mine.signal);
      if (mine.signal.aborted) return;
      set({ data, busy: false, error: null, updatedAt: Date.now() / 1000 });
    } catch (err) {
      if (mine.signal.aborted) return;
      set({ error: err instanceof Error ? err.message : String(err), busy: false });
    }
  },
}));

/**
 * Reports left after the category filters — what the layer actually draws.
 *
 * Takes the two fields it needs rather than the whole state, so React callers
 * can run it inside a useMemo. It must NEVER be passed to `useLsrStore()` as a
 * selector: zustand v5 compares results by identity and this builds a new
 * array every call, which loops the renderer forever.
 */
export function selectVisibleLsr(s: {
  data: LsrCollection | null;
  cats: Record<LsrCategory, boolean>;
}) {
  const feats = s.data?.features ?? [];
  return feats.filter((f) => s.cats[f.properties.cat] !== false);
}
