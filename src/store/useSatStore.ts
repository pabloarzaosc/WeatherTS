import { create } from "zustand";

import {
  cancelSatLoop,
  fetchSatCatalog,
  fetchSatFrames,
  type SatCatalog,
  type SatFrame,
  type SatProduct,
  type SatRegion,
  type SatSatellite,
} from "../lib/satellite";
import { describe, retrying, within } from "../lib/patience";

/**
 * The satellite layer's state: which satellite, region and product, how many
 * frames, which frame.
 *
 * The frames ARE the timeline's axis while satellite drives it, as radar's
 * scans are. The layer module draws and reports back through setStatus, so a
 * second map pane never starts its own copy of the same pictures.
 */

const K_SEL = "weatherts.sat.selection";
const K_COUNT = "weatherts.sat.count";

/** Frames a loop can hold, like WeatherWise's "max frames" but longer: a
 *  replay of a whole day of CONUS scans is 288. */
export const FRAME_COUNTS = [6, 12, 24, 36, 48, 72, 100, 150, 200, 288] as const;
const DEFAULT_COUNT = 24;

const CATALOG_TIMEOUT_MS = 10_000;
/** A first list reads a day of AWS listings or SLIDER's time files. */
const FRAMES_TIMEOUT_MS = 45_000;
const CATALOG_TRIES = 6;
const FRAMES_RETRY_MS = 5_000;
const FRAMES_RETRIES = 6;

interface Selection {
  sat: string;
  region: string;
  product: string;
}

interface SatState {
  catalog: SatCatalog | null;
  sat: string;
  region: string;
  product: string;
  count: number;
  frames: SatFrame[];
  /** Index into `frames`; -1 until the first list lands. */
  index: number;
  /** Where the region is: the moving boxes (GOES mesoscale, Himawari target)
   *  come with each frame list. */
  bounds: [number, number, number, number] | null;
  /** Counts requests to fly the map to the region (a new region was picked). */
  flyRequest: number;

  busy: boolean;
  error: string | null;
  /** Frames of the loop already on this machine, and how many there are. */
  loopLoaded: number;
  loopTotal: number;
  /**
   * Play was pressed: the whole loop for the area on screen downloads. Until
   * then only the frame someone is looking at is fetched.
   */
  loopArmed: boolean;
  playing: boolean;
  loopStops: number;

  load: () => Promise<void>;
  loadFrames: (keepPlace?: boolean) => Promise<void>;
  /** Pick any of satellite / region / product; the rest follow sensibly. */
  select: (next: Partial<Selection>) => void;
  setCount: (n: number) => void;
  setIndex: (i: number) => void;
  goToUnix: (unix: number | null) => void;
  setStatus: (s: Partial<Pick<SatState, "busy" | "error" | "loopLoaded" | "loopTotal">>) => void;
  stopLoop: () => void;
  armLoop: () => void;
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

function savedSelection(): Selection | null {
  try {
    const v = JSON.parse(read(K_SEL) ?? "null");
    if (v && typeof v.sat === "string" && typeof v.region === "string" && typeof v.product === "string") return v;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Resolve a wish into a selection the catalogue has: a satellite, one of its
 * regions, and one of that region's products -- keeping the product (or at
 * least its kind) when the satellite or region changes, so IR stays IR.
 */
export function resolveSelection(cat: SatCatalog, want: Selection, before?: Selection): Selection {
  const sat = cat.satellites.find((s) => s.id === want.sat) ?? cat.satellites.find((s) => s.id === cat.default.sat)!;
  const region =
    sat.regions.find((r) => r.id === want.region) ??
    sat.regions.find((r) => r.id === before?.region) ??
    sat.regions[0];
  const prevProduct = before
    ? cat.satellites
        .find((s) => s.id === before.sat)
        ?.regions.find((r) => r.id === before.region)
        ?.products.find((p) => p.id === before.product)
    : undefined;
  const product =
    region.products.find((p) => p.id === want.product) ??
    (prevProduct && region.products.find((p) => p.label === prevProduct.label)) ??
    // Band 13-ish: the clean IR window is the one every imager has.
    (prevProduct && region.products.find((p) => p.group === prevProduct.group)) ??
    region.products.find((p) => /Clean|IR Window|10\.|Thermal/i.test(p.label)) ??
    region.products[0];
  return { sat: sat.id, region: region.id, product: product.id };
}

let framesCtrl: AbortController | null = null;
let catalogLoad: Promise<void> | null = null;
let framesRetry: number | null = null;
let framesFailures = 0;

function keepsLoop(s: { playing: boolean; loopArmed: boolean }): boolean {
  const keep = s.playing && s.loopArmed;
  if (s.loopArmed && !keep) void cancelSatLoop().catch(() => undefined);
  return keep;
}

const saved = savedSelection();

export const useSatStore = create<SatState>((set, get) => ({
  catalog: null,
  sat: saved?.sat ?? "goes19",
  region: saved?.region ?? "conus",
  product: saved?.product ?? "c13",
  count: Number(read(K_COUNT)) || DEFAULT_COUNT,
  frames: [],
  index: -1,
  bounds: null,
  flyRequest: 0,
  busy: false,
  error: null,
  loopLoaded: 0,
  loopTotal: 0,
  loopArmed: false,
  playing: false,
  loopStops: 0,

  load: async () => {
    if (!get().catalog) {
      catalogLoad ??= (async () => {
        try {
          const catalog = await retrying(() => fetchSatCatalog(within(CATALOG_TIMEOUT_MS)), {
            tries: CATALOG_TRIES,
            firstWaitMs: 1_000,
            maxWaitMs: 15_000,
            onRetry: () => set({ error: "The satellite service is not answering yet, trying again…" }),
          });
          const s = get();
          const sel = resolveSelection(catalog, { sat: s.sat, region: s.region, product: s.product });
          set({ catalog, ...sel, error: null });
        } catch (err) {
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
      const out = await fetchSatFrames(
        before.sat,
        before.region,
        before.product,
        before.count,
        within(FRAMES_TIMEOUT_MS, mine.signal),
      );
      if (mine.signal.aborted) return;
      const now = get();
      // The selection moved on while this list was on its way.
      if (now.sat !== before.sat || now.region !== before.region || now.product !== before.product) return;
      framesFailures = 0;
      let index = out.frames.length - 1;
      if (keepPlace && !atNewest && pinned != null) {
        const same = out.frames.findIndex((f) => f.unix === pinned);
        if (same >= 0) index = same;
      }
      const unchanged =
        out.frames.length === before.frames.length &&
        out.frames.every((f, i) => f.time === before.frames[i]?.time);
      const sameBounds = JSON.stringify(out.bounds) === JSON.stringify(before.bounds);
      set({
        frames: unchanged ? before.frames : out.frames,
        index: unchanged ? before.index : index,
        bounds: sameBounds ? before.bounds : out.bounds,
        error: out.frames.length ? null : "No images from this product right now",
      });
    } catch (err) {
      if (mine.signal.aborted) return;
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

  select: (next) => {
    const s = get();
    const want = { sat: next.sat ?? s.sat, region: next.region ?? s.region, product: next.product ?? s.product };
    // A new satellite starts on the region it was left on, not the old one's id.
    if (next.sat && next.sat !== s.sat && !next.region) want.region = "";
    const before = { sat: s.sat, region: s.region, product: s.product };
    const sel = s.catalog ? resolveSelection(s.catalog, want, before) : want;
    if (sel.sat === s.sat && sel.region === s.region && sel.product === s.product) return;
    write(K_SEL, JSON.stringify(sel));
    const moved = sel.sat !== s.sat || sel.region !== s.region;
    set({
      ...sel,
      frames: [],
      index: -1,
      error: null,
      bounds: moved ? null : s.bounds,
      flyRequest: moved ? s.flyRequest + 1 : s.flyRequest,
      loopArmed: keepsLoop(s),
    });
    void get().loadFrames();
  },

  setCount: (n) => {
    if (n === get().count) return;
    write(K_COUNT, String(n));
    set({ count: n, loopArmed: keepsLoop(get()) });
    void get().loadFrames(true);
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

export const selectSatSatellite = (s: SatState): SatSatellite | null =>
  s.catalog?.satellites.find((x) => x.id === s.sat) ?? null;

export const selectSatRegion = (s: SatState): SatRegion | null =>
  selectSatSatellite(s)?.regions.find((r) => r.id === s.region) ?? null;

export const selectSatProduct = (s: SatState): SatProduct | null =>
  selectSatRegion(s)?.products.find((p) => p.id === s.product) ?? null;

export const selectSatFrame = (s: SatState): SatFrame | null => s.frames[s.index] ?? null;
