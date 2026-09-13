import { create } from "zustand";

import {
  fetchObsCatalog,
  fetchObsFrames,
  type ObsBar,
  type ObsCatalog,
  type ObsFrame,
  type ObsProduct,
  type ObsSource,
} from "../lib/observations";

/**
 * The analysis layer's state: which source, which product, and which hour.
 *
 * The hours are the last three days of each analysis -- NOMADS for the recent
 * ones, NOAA's AWS copy for the rest -- and they ARE the timeline's axis while
 * this layer drives it, the same arrangement radar and fronts use. Nothing here
 * fetches the image; the layer module does that and reports back, so a second
 * map pane cannot start a second download of the same frame.
 */

const K_SOURCE = "weatherts.obs.source";
const K_FIELD = "weatherts.obs.field";
const K_LINES = "weatherts.obs.lines";
const K_EDGE = "weatherts.obs.edge";
const K_BARBS = "weatherts.obs.barbs";
const K_OPEN = "weatherts.obs.groups";

interface ObsState {
  catalog: ObsCatalog | null;
  source: string;
  field: string;
  frames: ObsFrame[];
  /** Index into `frames`; -1 until the first list lands. */
  index: number;

  busy: boolean;
  /** The catalogue or the frame list failing, or the image failing. */
  error: string | null;
  /** What the drawn frame is, for the panel readout. */
  valid: string | null;
  bar: ObsBar | null;
  /** Labelled lines drawn over the colours. */
  showLines: boolean;
  /** The outline of the area that was analysed at all. */
  showEdge: boolean;
  /** Wind barbs, on the products that carry them. */
  showBarbs: boolean;
  /** How far apart the lines are, once one is drawn, and in what. */
  interval: number | null;
  linesUnit: string | null;
  /** Picker groups the user has opened, remembered across restarts. */
  openGroups: string[];

  load: () => Promise<void>;
  setShowLines: (on: boolean) => void;
  setShowEdge: (on: boolean) => void;
  setShowBarbs: (on: boolean) => void;
  toggleGroup: (group: string) => void;
  loadFrames: () => Promise<void>;
  setSource: (id: string) => void;
  setField: (id: string) => void;
  setIndex: (i: number) => void;
  /** Park on the frame nearest an instant — how another product's clock drives it. */
  goToUnix: (unix: number | null) => void;
  setStatus: (s: Partial<Pick<ObsState, "busy" | "error" | "valid" | "bar" | "interval" | "linesUnit">>) => void;
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

/** The product stays put across a source change when the new source has it --
 *  swapping RTMA for the HRRR analysis should not throw away "dew point". */
function fieldFor(catalog: ObsCatalog | null, source: string, wanted: string): string {
  const src: ObsSource | undefined = catalog?.sources.find((s) => s.id === source);
  if (!src || !src.products.length) return wanted;
  return src.products.includes(wanted) ? wanted : src.products[0];
}

/** Where a product the current source cannot draw is drawn instead: the HRRR
 *  analysis when it has it -- the one a chase day is read from -- else the
 *  first source that does. */
function sourceFor(catalog: ObsCatalog | null, product: string): string | null {
  const p = catalog?.products.find((x) => x.id === product);
  if (!p || !p.sources.length) return null;
  return p.sources.includes("hrrr-anl") ? "hrrr-anl" : p.sources[0];
}

function readGroups(): string[] {
  const raw = read(K_OPEN);
  if (raw == null) return ["Surface"];
  try {
    const out = JSON.parse(raw);
    return Array.isArray(out) ? out.filter((g) => typeof g === "string") : ["Surface"];
  } catch {
    return ["Surface"];
  }
}

export const useObsStore = create<ObsState>((set, get) => ({
  catalog: null,
  source: read(K_SOURCE) || "hrrr-anl",
  field: read(K_FIELD) || "t2m",
  frames: [],
  index: -1,
  busy: false,
  error: null,
  valid: null,
  bar: null,
  showLines: read(K_LINES) !== "0",
  showEdge: read(K_EDGE) !== "0",
  showBarbs: read(K_BARBS) !== "0",
  interval: null,
  linesUnit: null,
  openGroups: readGroups(),

  setShowLines: (on) => {
    write(K_LINES, on ? "1" : "0");
    set({ showLines: on });
  },
  setShowEdge: (on) => {
    write(K_EDGE, on ? "1" : "0");
    set({ showEdge: on });
  },
  setShowBarbs: (on) => {
    write(K_BARBS, on ? "1" : "0");
    set({ showBarbs: on });
  },
  toggleGroup: (group) => {
    const open = get().openGroups;
    const next = open.includes(group) ? open.filter((g) => g !== group) : [...open, group];
    write(K_OPEN, JSON.stringify(next));
    set({ openGroups: next });
  },

  load: async () => {
    if (get().catalog) return;
    try {
      const catalog = await fetchObsCatalog();
      const source = catalog.sources.some((s) => s.id === get().source) ? get().source : catalog.defaultSource;
      set({ catalog, source, field: fieldFor(catalog, source, get().field), error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    await get().loadFrames();
  },

  loadFrames: async () => {
    framesCtrl?.abort();
    const mine = new AbortController();
    framesCtrl = mine;
    set({ busy: true, error: null });
    try {
      const frames = await fetchObsFrames(get().source, mine.signal, get().field);
      if (mine.signal.aborted) return;
      // The newest hour is where a chase day starts; scrub back from there.
      set({ frames, index: frames.length - 1, busy: false });
    } catch (err) {
      if (mine.signal.aborted) return;
      set({ busy: false, frames: [], index: -1, error: err instanceof Error ? err.message : String(err) });
    }
  },

  setSource: (id) => {
    if (id === get().source) return;
    write(K_SOURCE, id);
    const field = fieldFor(get().catalog, id, get().field);
    write(K_FIELD, field);
    set({ source: id, field, frames: [], index: -1, valid: null });
    void get().loadFrames();
  },

  setField: (id) => {
    if (id === get().field) return;
    const { catalog, source } = get();
    const here = catalog?.sources.find((s) => s.id === source);
    write(K_FIELD, id);
    // Picking CAPE while on RTMA is asking for CAPE, not for an error: move to
    // a source that has it, and the hours move with it.
    if (here && !here.products.includes(id)) {
      const other = sourceFor(catalog, id);
      if (other && other !== source) {
        write(K_SOURCE, other);
        set({ source: other, field: id, frames: [], index: -1, valid: null });
        void get().loadFrames();
        return;
      }
    }
    set({ field: id, valid: null });
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
      set({ index: frames.length - 1 });
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

/** One empty list, not a new one per render: a selector that mints an array
 *  every time makes React re-render forever ("getSnapshot should be cached"). */
const NO_PRODUCTS: ObsProduct[] = [];

/** The frame the map should be drawing, or null before the list lands. */
export const selectObsFrame = (s: ObsState): ObsFrame | null => s.frames[s.index] ?? null;

/** Every product in the catalogue, in picker order. */
export const selectObsProducts = (s: ObsState) => s.catalog?.products ?? NO_PRODUCTS;

/** The product being drawn, or null before the catalogue lands. */
export const selectObsProduct = (s: ObsState): ObsProduct | null =>
  s.catalog?.products.find((p) => p.id === s.field) ?? null;
