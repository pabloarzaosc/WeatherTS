import { create } from "zustand";

import {
  fetchSatCatalog,
  fetchSatFrames,
  type SatCatalog,
  type SatFrame,
  type SatProduct,
  type SatSatellite,
} from "../lib/satellite";

/**
 * The satellite layer's state: which product, how long a loop, which frame.
 *
 * The frames ARE the timeline's axis while satellite drives it, as radar's
 * scans are. The layer module draws and reports back through setStatus, so a
 * second map pane never starts its own copy of the same tiles.
 */

const K_PRODUCT = "weatherts.sat.product";
const K_HOURS = "weatherts.sat.hours";

export const LOOP_HOURS = [1, 2, 3, 6, 12, 24] as const;

interface SatState {
  catalog: SatCatalog | null;
  product: string;
  hours: number;
  frames: SatFrame[];
  /** Index into `frames`; -1 until the first list lands. */
  index: number;
  stale: boolean;

  busy: boolean;
  error: string | null;

  load: () => Promise<void>;
  /** Fetch the frame list. `keepPlace` keeps a scrubbed-back position; at the
   *  newest frame the loop follows the new one in. */
  loadFrames: (keepPlace?: boolean) => Promise<void>;
  setProduct: (id: string) => void;
  setHours: (h: number) => void;
  setIndex: (i: number) => void;
  goToUnix: (unix: number | null) => void;
  setStatus: (s: Partial<Pick<SatState, "busy" | "error">>) => void;
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* not remembered across restarts, which is harmless */
  }
}

let framesCtrl: AbortController | null = null;

export const useSatStore = create<SatState>((set, get) => ({
  catalog: null,
  product: read(K_PRODUCT) || "goes-blend-vis",
  hours: Number(read(K_HOURS)) || 3,
  frames: [],
  index: -1,
  stale: false,
  busy: false,
  error: null,

  load: async () => {
    if (get().catalog) return;
    try {
      const catalog = await fetchSatCatalog();
      const product = catalog.products.some((p) => p.id === get().product) ? get().product : catalog.defaultProduct;
      set({ catalog, product, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    await get().loadFrames();
  },

  loadFrames: async (keepPlace = false) => {
    framesCtrl?.abort();
    const mine = new AbortController();
    framesCtrl = mine;
    const before = get();
    const atNewest = before.index < 0 || before.index >= before.frames.length - 1;
    const pinned = before.frames[before.index]?.unix;
    try {
      const out = await fetchSatFrames(before.product, before.hours, mine.signal);
      if (mine.signal.aborted) return;
      let index = out.frames.length - 1;
      if (keepPlace && !atNewest && pinned != null) {
        const same = out.frames.findIndex((f) => f.unix === pinned);
        if (same >= 0) index = same;
      }
      // Same frames as before: keep the array, so nothing downstream redraws.
      const unchanged =
        out.frames.length === before.frames.length &&
        out.frames.every((f, i) => f.time === before.frames[i]?.time);
      set({
        frames: unchanged ? before.frames : out.frames,
        index: unchanged ? before.index : index,
        stale: out.stale,
        error: out.frames.length ? null : "No images from this product right now",
      });
    } catch (err) {
      if (mine.signal.aborted) return;
      if (!keepPlace) set({ frames: [], index: -1, error: err instanceof Error ? err.message : String(err) });
    }
  },

  setProduct: (id) => {
    if (id === get().product) return;
    write(K_PRODUCT, id);
    set({ product: id, frames: [], index: -1, stale: false, error: null });
    void get().loadFrames();
  },

  setHours: (h) => {
    if (h === get().hours) return;
    write(K_HOURS, String(h));
    set({ hours: h });
    void get().loadFrames();
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
      if (get().index !== frames.length - 1) set({ index: frames.length - 1 });
      return;
    }
    let best = 0;
    let diff = Infinity;
    frames.forEach((f, i) => {
      const d = Math.abs(f.unix - unix);
      if (d < diff) {
        diff = d;
        best = i;
      }
    });
    if (best !== get().index) set({ index: best });
  },

  setStatus: (s) => set(s),
}));

export const selectSatProduct = (s: SatState): SatProduct | null =>
  s.catalog?.products.find((p) => p.id === s.product) ?? null;

export const selectSatSatellite = (s: SatState): SatSatellite | null => {
  const product = selectSatProduct(s);
  return product ? s.catalog?.satellites.find((x) => x.id === product.sat) ?? null : null;
};

export const selectSatFrame = (s: SatState): SatFrame | null => s.frames[s.index] ?? null;
