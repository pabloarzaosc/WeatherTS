import { create } from "zustand";

import {
  DEFAULT_FRONTS_MODEL,
  DEFAULT_FRONT_REGIONS,
  FRONT_KINDS,
  FRONT_REGIONS,
  clipFeatures,
  fetchFronts,
  type FrontFeature,
  type FrontFrame,
  type FrontKind,
  type FrontRegion,
  type FrontSource,
  type FrontsResponse,
} from "../lib/fronts";

/**
 * Surface-analysis state.
 *
 * The analyses come as a series of frames -- past charts plus progs -- so the
 * fronts obey the ONE TIMELINE rule: the layer shows whichever frame the bottom
 * timeline is parked on, instead of being pinned to "latest" with a slider of
 * its own.
 *
 * Which parts of the world are drawn is a set of regions, and each region has
 * a source (see lib/fronts): North America WPC's analysis or a model's, the
 * rest a model's. With both sources on, the timeline steps through the WPC
 * series -- 3-hourly, the finer of the two -- and the automatic regions show
 * whichever of their frames is nearest in time.
 */

const REFRESH_MS = 10 * 60 * 1000; // the WPC analysis is 3-hourly, models 6-hourly
export const FRONT_HISTORY = 6;
const K_REGIONS = "weatherts.fronts.regions";
const K_SOURCES = "weatherts.fronts.sources";
const K_MODEL = "weatherts.fronts.model";

const controllers: Partial<Record<FrontSource, AbortController>> = {};
let timer: number | null = null;

/** What the user clicked on the chart, for the detail card. */
export interface FrontPick {
  kind: string;
  label: string;
  strength: string;
  pressure: number | null;
  lngLat: [number, number];
  /** The analysis the clicked feature belongs to. With several regions on it
   *  need not be the timeline's frame, so the card reads it from here. */
  source?: FrontSource;
  chart?: string;
  validUnix?: number | null;
  model?: string;
}

interface SourceData {
  frames: FrontFrame[];
  meta: FrontsResponse["meta"] | null;
  busy: boolean;
  error: string | null;
}

type RegionSources = Record<string, FrontSource>;

interface FrontsState {
  /** Region ids that are switched on. */
  regions: string[];
  /** The source picked for a region that has a choice; the rest use their default. */
  regionSources: RegionSources;
  /** The model the automatic regions' fronts are found in. */
  autoModel: string;
  bySource: Record<FrontSource, SourceData>;
  /** The source whose frames the timeline steps through. */
  axis: FrontSource;
  /** The axis source's frames -- what the timeline and the chart picker read. */
  frames: FrontFrame[];
  /** Index into `frames`; -1 until the first load lands. */
  index: number;
  selected: FrontPick | null;
  kinds: Record<FrontKind, boolean>;
  showCentres: boolean;
  /** Across the sources the switched-on regions need. */
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
  toggleRegion: (id: string) => void;
  /** Every region on (the whole world), or every region off. */
  setWorld: (on: boolean) => void;
  setRegionSource: (id: string, source: FrontSource) => void;
  setAutoModel: (id: string) => void;
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

const emptySource = (): SourceData => ({ frames: [], meta: null, busy: false, error: null });

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

function readRegions(): string[] {
  const raw = read(K_REGIONS);
  if (raw) {
    try {
      return (JSON.parse(raw) as unknown[]).filter(
        (id): id is string => typeof id === "string" && FRONT_REGIONS.some((r) => r.id === id),
      );
    } catch {
      /* unreadable: fall back to the default */
    }
  }
  return [...DEFAULT_FRONT_REGIONS];
}

function readSources(): RegionSources {
  const out: RegionSources = {};
  const raw = read(K_SOURCES);
  if (!raw) return out;
  try {
    const saved = JSON.parse(raw) as Record<string, unknown>;
    for (const r of FRONT_REGIONS) {
      const v = saved[r.id];
      if (typeof v === "string" && (r.sources as string[]).includes(v)) out[r.id] = v as FrontSource;
    }
  } catch {
    /* unreadable: every region on its default */
  }
  return out;
}

/** Where a region's fronts come from: the pick, or else its default. */
export const sourceOf = (region: FrontRegion, chosen: RegionSources): FrontSource =>
  chosen[region.id] ?? region.sources[0];

/** The sources the switched-on regions draw from. */
export function sourcesFor(regions: string[], chosen: RegionSources): FrontSource[] {
  const out = new Set<FrontSource>();
  for (const r of FRONT_REGIONS) if (regions.includes(r.id)) out.add(sourceOf(r, chosen));
  return [...out];
}

const axisFor = (regions: string[], chosen: RegionSources): FrontSource => {
  const used = sourcesFor(regions, chosen);
  return used.includes("wpc") || used.length === 0 ? "wpc" : "gfs";
};

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

/** "Now" is the newest ANALYSIS, not the newest frame -- the 24 h prog is the
 *  newest frame and is emphatically not now. */
const latestAnalysis = (frames: FrontFrame[]) =>
  frames.reduce((b, f, i) => (f.kind === "analysis" ? i : b), frames.length ? 0 : -1);

export const useFrontsStore = create<FrontsState>((set, get) => {
  /** Recompute everything that follows from the regions and the loaded data,
   *  keeping the timeline on the instant it was showing. */
  const derive = (keepUnix: number | null) => {
    const s = get();
    const needed = sourcesFor(s.regions, s.regionSources);
    const axis = axisFor(s.regions, s.regionSources);
    const frames = needed.length ? s.bySource[axis].frames : [];
    let index = latestAnalysis(frames);
    if (keepUnix != null) {
      const near = nearestIndex(frames, keepUnix);
      if (near >= 0) index = near;
    }
    const errors = needed.map((src) => s.bySource[src].error).filter(Boolean);
    set({
      axis,
      frames,
      index,
      busy: needed.some((src) => s.bySource[src].busy),
      error: errors.length ? errors.join(" · ") : null,
      meta: s.bySource[axis].meta,
    });
  };

  const currentUnix = () => {
    const s = get();
    return s.frames[s.index]?.validUnix ?? null;
  };

  const patch = (src: FrontSource, part: Partial<SourceData>) => {
    const keep = currentUnix();
    set((s) => ({ bySource: { ...s.bySource, [src]: { ...s.bySource[src], ...part } } }));
    derive(keep);
  };

  const loadSource = async (src: FrontSource) => {
    controllers[src]?.abort();
    const mine = new AbortController();
    controllers[src] = mine;
    patch(src, { busy: true, error: null });
    try {
      const res = await fetchFronts(FRONT_HISTORY, src, mine.signal, src === "gfs" ? get().autoModel : undefined);
      if (mine.signal.aborted) return;
      patch(src, { frames: res.frames, meta: res.meta, busy: false, error: null });
    } catch (err) {
      if (mine.signal.aborted) return;
      patch(src, { busy: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  /** Switching a region on that needs a source nobody has fetched yet. Only
   *  while the layer is on: a region picked with it off is fetched when the
   *  layer comes on, not in the background -- NOMADS limits how often it can
   *  be asked. */
  const fetchMissing = () => {
    if (timer === null) return;
    const s = get();
    for (const src of sourcesFor(s.regions, s.regionSources)) {
      const d = s.bySource[src];
      if (!d.frames.length && !d.busy) void loadSource(src);
    }
  };

  const setRegions = (regions: string[]) => {
    const keep = currentUnix();
    write(K_REGIONS, JSON.stringify(regions));
    set({ regions });
    derive(keep);
    fetchMissing();
  };

  return {
    regions: readRegions(),
    regionSources: readSources(),
    autoModel: read(K_MODEL) || DEFAULT_FRONTS_MODEL,
    bySource: { wpc: emptySource(), gfs: emptySource() },
    axis: "wpc",
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
      const s = get();
      await Promise.all(sourcesFor(s.regions, s.regionSources).map((src) => loadSource(src)));
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
        set({ index: latestAnalysis(frames) });
        return;
      }
      const i = nearestIndex(frames, unix);
      if (i >= 0 && i !== get().index) set({ index: i });
    },

    toggleKind: (k) => set((s) => ({ kinds: { ...s.kinds, [k]: !s.kinds[k] } })),
    setShowCentres: (showCentres) => set({ showCentres }),

    toggleRegion: (id) => {
      const on = get().regions;
      setRegions(on.includes(id) ? on.filter((r) => r !== id) : [...on, id]);
    },
    setWorld: (on) => setRegions(on ? FRONT_REGIONS.map((r) => r.id) : []),

    setRegionSource: (id, source) => {
      const region = FRONT_REGIONS.find((r) => r.id === id);
      if (!region || !region.sources.includes(source) || sourceOf(region, get().regionSources) === source) return;
      const keep = currentUnix();
      const regionSources = { ...get().regionSources, [id]: source };
      write(K_SOURCES, JSON.stringify(regionSources));
      set({ regionSources, selected: null });
      derive(keep);
      fetchMissing();
    },

    setAutoModel: (id) => {
      if (id === get().autoModel) return;
      write(K_MODEL, id);
      controllers.gfs?.abort();
      set({ autoModel: id, selected: null });
      // The old model's frames would otherwise stay on screen, labelled as the
      // new one, until its analysis lands.
      patch("gfs", { frames: [], meta: null, busy: false, error: null });
      const s = get();
      if (timer !== null && sourcesFor(s.regions, s.regionSources).includes("gfs")) void loadSource("gfs");
    },

    start: () => {
      get().stop();
      timer = window.setInterval(() => void get().load(), REFRESH_MS);
      // Regions or a model picked while the layer was off.
      fetchMissing();
    },
    stop: () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    },
  };
});

/* ---------------------------------------------------------------- selectors */

type ViewInput = Pick<
  FrontsState,
  "frames" | "index" | "kinds" | "showCentres" | "regions" | "regionSources" | "bySource" | "axis"
>;

interface FrontView {
  features: FrontFeature[];
  /** Per kind, counting a feature once however many tiles it was cut into. */
  counts: Record<string, number>;
}

let memoIn: ViewInput | null = null;
let memoOut: FrontView = { features: [], counts: {} };

/**
 * What the map should draw: for every switched-on region, its source's frame
 * for the instant on the timeline, cut to the region's tiles and minus the
 * filtered kinds. Memoised on its inputs, because the layer and the panel both
 * ask on every change and cutting lines is the one real cost here.
 */
export function selectFrontView(s: ViewInput): FrontView {
  if (
    memoIn &&
    memoIn.frames === s.frames &&
    memoIn.index === s.index &&
    memoIn.kinds === s.kinds &&
    memoIn.showCentres === s.showCentres &&
    memoIn.regions === s.regions &&
    memoIn.regionSources === s.regionSources &&
    memoIn.bySource === s.bySource &&
    memoIn.axis === s.axis
  ) {
    return memoOut;
  }
  const features: FrontFeature[] = [];
  const counts: Record<string, number> = {};
  const axisFrame = s.frames[s.index];
  if (axisFrame) {
    for (const region of FRONT_REGIONS) {
      if (!s.regions.includes(region.id)) continue;
      const source = sourceOf(region, s.regionSources);
      const own = s.bySource[source].frames;
      const frame =
        source === s.axis
          ? axisFrame
          : axisFrame.validUnix != null
            ? own[nearestIndex(own, axisFrame.validUnix)]
            : undefined;
      if (!frame) continue;
      const chart = frame.kind === "forecast" ? frame.label : "Analysis";
      const model = source === "gfs" ? s.bySource.gfs.meta?.modelLabel : undefined;
      for (const f of frame.features) {
        const kind = (f.properties as { kind: string }).kind;
        if (kind === "high" || kind === "low" ? !s.showCentres : s.kinds[kind as FrontKind] === false) continue;
        const pieces = clipFeatures([f], region.boxes);
        if (!pieces.length) continue;
        counts[kind] = (counts[kind] ?? 0) + 1;
        for (const p of pieces) {
          features.push({
            ...p,
            properties: { ...p.properties, source, chart, validUnix: frame.validUnix, model },
          });
        }
      }
    }
  }
  memoIn = s;
  memoOut = { features, counts };
  return memoOut;
}

export const selectFrontFeatures = (s: ViewInput) => selectFrontView(s).features;
