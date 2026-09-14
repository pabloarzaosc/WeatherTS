import { create } from "zustand";

import {
  cancelSatLoop,
  fetchSatCatalog,
  fetchSatFrames,
  type SatCatalog,
  type SatFrame,
  type SatProduct,
  type SatSatellite,
} from "../lib/satellite";
import { describe, retrying, within } from "../lib/patience";

/**
 * The satellite layer's state: which product, how long a loop, which frame.
 *
 * The frames ARE the timeline's axis while satellite drives it, as radar's
 * scans are. The layer module draws and reports back through setStatus, so a
 * second map pane never starts its own copy of the same tiles.
 */

const K_PRODUCT = "weatherts.sat.product";
const K_HOURS = "weatherts.sat.hours";

/** Past a day the loop keeps every k-th frame (the backend picks k), so a week
 *  is still a loop of a hundred and fifty pictures rather than a thousand. */
export const LOOP_HOURS = [1, 2, 3, 6, 12, 24, 48, 72, 168] as const;

/** "6 h", "24 h", "3 d". */
export function spanLabel(hours: number): string {
  return hours > 24 && hours % 24 === 0 ? `${hours / 24} d` : `${hours} h`;
}

/** How far apart a loop's frames are, "10 min" or "3 h"; "" under three frames. */
export function stepLabel(unixes: number[]): string {
  if (unixes.length < 3) return "";
  const gaps = unixes
    .slice(1)
    .map((u, i) => u - unixes[i])
    .sort((a, b) => a - b);
  const gap = gaps[Math.floor(gaps.length / 2)];
  return gap >= 3600 && gap % 3600 === 0 ? `${gap / 3600} h` : `${Math.max(1, Math.round(gap / 60))} min`;
}

const CATALOG_TIMEOUT_MS = 10_000;
/** A first run reads every agency's list of times before it can answer. */
const FRAMES_TIMEOUT_MS = 45_000;
const CATALOG_TRIES = 6;
/** With nothing on screen a failed frame list is asked for again this soon,
 *  this many times, before it waits for the minute's refresh. */
const FRAMES_RETRY_MS = 5_000;
const FRAMES_RETRIES = 6;

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
  /** Frames of the loop already on this machine, and how many there are. */
  loopLoaded: number;
  loopTotal: number;
  /**
   * Play was pressed: the whole loop for the area on screen downloads. Until
   * then only the frame someone is looking at is fetched -- zooming around
   * does not start a day of pictures. A new area, product or length with
   * nothing playing waits for play again, and so does a stop from the card.
   */
  loopArmed: boolean;
  /** The timeline is playing satellite. */
  playing: boolean;
  /** Counts stops, so the timeline can pause on each one. */
  loopStops: number;

  load: () => Promise<void>;
  /** Fetch the frame list. `keepPlace` keeps a scrubbed-back position; at the
   *  newest frame the loop follows the new one in. */
  loadFrames: (keepPlace?: boolean) => Promise<void>;
  setProduct: (id: string) => void;
  setHours: (h: number) => void;
  setIndex: (i: number) => void;
  goToUnix: (unix: number | null) => void;
  setStatus: (s: Partial<Pick<SatState, "busy" | "error" | "loopLoaded" | "loopTotal">>) => void;
  stopLoop: () => void;
  armLoop: () => void;
  /** Back to fetching only the frame on screen, without it counting as a stop. */
  disarmLoop: () => void;
  setPlaying: (on: boolean) => void;
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
let catalogLoad: Promise<void> | null = null;
let framesRetry: number | null = null;
let framesFailures = 0;

/** Another product or length keeps downloading only while a loop is playing;
 *  otherwise what was still queued for the old one is dropped. */
function keepsLoop(s: { playing: boolean; loopArmed: boolean }): boolean {
  const keep = s.playing && s.loopArmed;
  if (s.loopArmed && !keep) void cancelSatLoop().catch(() => undefined);
  return keep;
}

export const useSatStore = create<SatState>((set, get) => ({
  catalog: null,
  product: read(K_PRODUCT) || "goes-blend-vis",
  hours: Number(read(K_HOURS)) || 3,
  frames: [],
  index: -1,
  stale: false,
  busy: false,
  error: null,
  loopLoaded: 0,
  loopTotal: 0,
  loopArmed: false,
  playing: false,
  loopStops: 0,

  load: async () => {
    if (!get().catalog) {
      // One load at a time: the panel and the layer both ask when they appear.
      catalogLoad ??= (async () => {
        try {
          const catalog = await retrying(() => fetchSatCatalog(within(CATALOG_TIMEOUT_MS)), {
            tries: CATALOG_TRIES,
            firstWaitMs: 1_000,
            maxWaitMs: 15_000,
            onRetry: () => set({ error: "The satellite service is not answering yet, trying again…" }),
          });
          const product = catalog.products.some((p) => p.id === get().product) ? get().product : catalog.defaultProduct;
          set({ catalog, product, error: null });
        } catch (err) {
          // The layer's refresh asks again in a minute.
          set({ error: describe(err, "The satellite service") });
        }
      })().finally(() => {
        catalogLoad = null;
      });
      await catalogLoad;
    }
    if (get().catalog && get().frames.length === 0) await get().loadFrames();
  },

  loadFrames: async (keepPlace = false) => {
    if (!get().catalog) return get().load();
    framesCtrl?.abort();
    const mine = new AbortController();
    framesCtrl = mine;
    if (framesRetry != null) {
      window.clearTimeout(framesRetry);
      framesRetry = null;
    }
    const before = get();
    const atNewest = before.index < 0 || before.index >= before.frames.length - 1;
    const pinned = before.frames[before.index]?.unix;
    try {
      const out = await fetchSatFrames(before.product, before.hours, within(FRAMES_TIMEOUT_MS, mine.signal));
      if (mine.signal.aborted) return;
      framesFailures = 0;
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
      // A loop already on screen keeps playing; the next refresh tries again.
      if (keepPlace && before.frames.length) return;
      set({ frames: [], index: -1, error: describe(err, "The satellite service") });
      framesFailures += 1;
      if (framesFailures <= FRAMES_RETRIES) {
        framesRetry = window.setTimeout(() => {
          framesRetry = null;
          void get().loadFrames();
        }, FRAMES_RETRY_MS);
      }
    }
  },

  setProduct: (id) => {
    if (id === get().product) return;
    write(K_PRODUCT, id);
    set({ product: id, frames: [], index: -1, stale: false, error: null, loopArmed: keepsLoop(get()) });
    void get().loadFrames();
  },

  setHours: (h) => {
    if (h === get().hours) return;
    write(K_HOURS, String(h));
    set({ hours: h, loopArmed: keepsLoop(get()) });
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

  stopLoop: () => {
    set({ loopArmed: false, loopStops: get().loopStops + 1 });
    void cancelSatLoop().catch(() => undefined);
  },

  armLoop: () => {
    if (!get().loopArmed) set({ loopArmed: true });
  },

  disarmLoop: () => {
    if (!get().loopArmed) return;
    set({ loopArmed: false });
    void cancelSatLoop().catch(() => undefined);
  },

  setPlaying: (on) => {
    if (on !== get().playing) set({ playing: on });
  },
}));

export const selectSatProduct = (s: SatState): SatProduct | null =>
  s.catalog?.products.find((p) => p.id === s.product) ?? null;

export const selectSatSatellite = (s: SatState): SatSatellite | null => {
  const product = selectSatProduct(s);
  return product ? s.catalog?.satellites.find((x) => x.id === product.sat) ?? null : null;
};

export const selectSatFrame = (s: SatState): SatFrame | null => s.frames[s.index] ?? null;
