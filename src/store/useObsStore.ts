import { create } from "zustand";

import {
  cancelObsLoop,
  fetchObsCatalog,
  fetchObsFrames,
  fetchObsRuns,
  type ObsBar,
  type ObsCatalog,
  type ObsFrame,
  type ObsProduct,
  type ObsRun,
  type ObsSource,
  type ObsView,
  type ObsWindow,
} from "../lib/observations";
import { describe, retrying, within } from "../lib/patience";

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
const K_EDGE = "weatherts.obs.edge";
const K_BARBS = "weatherts.obs.barbs";
const K_PLACES = "weatherts.obs.places";
const K_ROADS = "weatherts.obs.roads";
const K_OPEN = "weatherts.obs.groups";
const K_HOURS = "weatherts.obs.hours";
const K_WINDOWS = "weatherts.obs.windows";
const K_ARCHIVE = "weatherts.obs.archiveAt";

/** How far back the timeline goes. A loop keeps every frame up to 240 of them
 *  (a week of hourly analyses is all 168); past that the backend keeps every
 *  k-th. */
export const OBS_LOOP_HOURS = [6, 12, 24, 48, 72, 168] as const;

const CATALOG_TIMEOUT_MS = 10_000;
const FRAMES_TIMEOUT_MS = 45_000;
const CATALOG_TRIES = 6;

interface ObsState {
  catalog: ObsCatalog | null;
  source: string;
  field: string;
  frames: ObsFrame[];
  /** Index into `frames`; -1 until the first list lands. */
  index: number;
  /** A forecast model's run picked by hand; null follows the newest. */
  run: string | null;
  /** The runs the picker offers, newest first. */
  runs: ObsRun[];
  /** One map, or a compare grid of runs or of models at the same valid time. */
  view: ObsView;
  /** The mesoanalysis archive's picked moment (unix s): its day is the frames,
   *  and the map opens on its hour. Null opens the newest whole day. */
  archiveAt: number | null;
  /** The Compare models grid: a model and a product per window, remembered. */
  windows: ObsWindow[];

  busy: boolean;
  /** The catalogue or the frame list failing, or the image failing. */
  error: string | null;
  /** What the drawn frame is, for the panel readout. */
  valid: string | null;
  /** The frame on the main map, as "source|field|key" once it is drawn. */
  drawn: string | null;
  /** The same, once the frame is final: its sharp on-screen picture drawn over
   *  it, or none needed at this zoom. What an animation export waits for. */
  detailed: string | null;
  bar: ObsBar | null;
  /** Labelled lines drawn over the colours. */
  /** The outline of the area that was analysed at all. */
  showEdge: boolean;
  /** Wind barbs, on the products that carry them. */
  showBarbs: boolean;
  /** State, city and town names over the field, each with its value. */
  showPlaces: boolean;
  /** Roads and built-up areas over the field, as the map is zoomed in. */
  showRoads: boolean;
  /** How far apart the lines are, once one is drawn, and in what. */
  /** Picker groups the user has opened, remembered across restarts. */
  openGroups: string[];
  /** The timeline is playing the analyses: no zoom detail, frames made ahead. */
  playing: boolean;
  /** How many hours back the timeline goes. */
  hours: number;
  /** The frames of the loop being made ahead, and how many are ready on this machine. */
  loopKeys: string[];
  /** Which product and hours `loopKeys` belongs to. */
  loopId: string;
  /** Play was pressed: the whole loop downloads. Until then only the hour on
   *  screen is made. Another product or length with nothing playing waits for
   *  play again, and so does a stop from the loading card. */
  loopArmed: boolean;
  loopLoaded: number;
  loopTotal: number;
  /** Counts stops, so the timeline can pause on each one. */
  loopStops: number;

  load: () => Promise<void>;
  setShowEdge: (on: boolean) => void;
  setShowBarbs: (on: boolean) => void;
  setShowPlaces: (on: boolean) => void;
  setShowRoads: (on: boolean) => void;
  toggleGroup: (group: string) => void;
  /** Fetch the frame list. `keepPlace` keeps a scrubbed-back hour. */
  loadFrames: (keepPlace?: boolean) => Promise<void>;
  /** Fetch the forecast model's runs for the picker. */
  loadRuns: () => Promise<void>;
  /** Open another run (null: the newest), on the same valid time where it has it. */
  /** Another run, on the same valid time -- or on `at`, when given. */
  setRun: (run: string | null, at?: number) => void;
  /** Open the archive on another moment: that day's hours, landing on it. */
  setArchiveAt: (unix: number | null) => void;
  setView: (view: ObsView) => void;
  setWindows: (windows: ObsWindow[]) => void;
  setHours: (h: number) => void;
  armLoop: () => void;
  /** Let go of the loop without it counting as a stop: the product changed, or
   *  the layer went away. `disarm` also waits for play again. */
  dropLoop: (disarm?: boolean) => void;
  setSource: (id: string) => void;
  /** The product on source `id` over the last `hours`: a forecast model's
   *  Replay, which opens its analysis twin on the past. */
  replay: (id: string, hours: number) => void;
  setField: (id: string) => void;
  setIndex: (i: number) => void;
  /** Park on the frame nearest an instant — how another product's clock drives it. */
  goToUnix: (unix: number | null) => void;
  setStatus: (
    s: Partial<Pick<ObsState, "busy" | "error" | "valid" | "drawn" | "detailed" | "bar" | "loopLoaded" | "loopTotal">>,
  ) => void;
  setPlaying: (on: boolean) => void;
  /** Start making these frames ahead, for a loop about to play. */
  prepareLoop: (keys: string[]) => void;
  /** Stop making the loop: what is loaded stays, the rest is not fetched. */
  stopLoop: () => void;
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
let runsCtrl: AbortController | null = null;
let catalogLoad: Promise<void> | null = null;
/** The valid time to land on when a run switch's frames arrive: comparing runs
 *  means the same moment, forecast from different starts. */
let landOn: number | null = null;
/** The run on screen when Compare runs opened: closing it goes back there. */
let runBeforeStrip: string | null | undefined;

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

function isArchive(catalog: ObsCatalog | null, source: string): boolean {
  return !!catalog?.sources.find((s) => s.id === source)?.archive;
}

/** The view a newly picked model keeps: an analysis has no runs to compare
 *  (a models grid needs none), and tracks are drawn on the one map. */
function viewFor(catalog: ObsCatalog | null, id: string, view: ObsView): ObsView {
  const src = catalog?.sources.find((s) => s.id === id);
  if (!src || src.tracks) return "single";
  return src.forecast || view === "models" ? view : "single";
}

function readWindows(): ObsWindow[] {
  try {
    const out = JSON.parse(read(K_WINDOWS) ?? "[]");
    return Array.isArray(out)
      ? out.filter((w) => w && typeof w.source === "string" && typeof w.field === "string").slice(0, 16)
      : [];
  } catch {
    return [];
  }
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
  run: null,
  runs: [],
  view: "single",
  archiveAt: Number(read(K_ARCHIVE)) || null,
  windows: readWindows(),
  busy: false,
  error: null,
  valid: null,
  drawn: null,
  detailed: null,
  bar: null,
  showEdge: read(K_EDGE) !== "0",
  showBarbs: read(K_BARBS) !== "0",
  showPlaces: read(K_PLACES) !== "0",
  showRoads: read(K_ROADS) !== "0",
  playing: false,
  hours: Number(read(K_HOURS)) || 24,
  loopKeys: [],
  loopId: "",
  loopArmed: false,
  loopLoaded: 0,
  loopTotal: 0,
  loopStops: 0,
  openGroups: readGroups(),

  setShowEdge: (on) => {
    write(K_EDGE, on ? "1" : "0");
    set({ showEdge: on });
  },
  setShowBarbs: (on) => {
    write(K_BARBS, on ? "1" : "0");
    set({ showBarbs: on });
  },
  setShowPlaces: (on) => {
    write(K_PLACES, on ? "1" : "0");
    set({ showPlaces: on });
  },
  setShowRoads: (on) => {
    write(K_ROADS, on ? "1" : "0");
    set({ showRoads: on });
  },
  toggleGroup: (group) => {
    const open = get().openGroups;
    const next = open.includes(group) ? open.filter((g) => g !== group) : [...open, group];
    write(K_OPEN, JSON.stringify(next));
    set({ openGroups: next });
  },

  load: async () => {
    if (!get().catalog) {
      catalogLoad ??= (async () => {
        try {
          const catalog = await retrying(() => fetchObsCatalog(within(CATALOG_TIMEOUT_MS)), {
            tries: CATALOG_TRIES,
            firstWaitMs: 1_000,
            maxWaitMs: 15_000,
            onRetry: () => set({ error: "The analysis service is not answering yet, trying again…" }),
          });
          const source = catalog.sources.some((s) => s.id === get().source) ? get().source : catalog.defaultSource;
          set({ catalog, source, field: fieldFor(catalog, source, get().field), error: null });
        } catch (err) {
          set({ error: describe(err, "The analysis service") });
        }
      })().finally(() => {
        catalogLoad = null;
      });
      await catalogLoad;
    }
    if (get().catalog && get().frames.length === 0) await get().loadFrames();
  },

  loadFrames: async (keepPlace = false) => {
    framesCtrl?.abort();
    const mine = new AbortController();
    framesCtrl = mine;
    const before = get();
    const atNewest = before.index < 0 || before.index >= before.frames.length - 1;
    const pinned = before.frames[before.index]?.key;
    if (!keepPlace) set({ busy: true, error: null });
    const archive = isArchive(before.catalog, before.source);
    // The archive opens on its picked hour, not on the day's last one.
    if (archive && !keepPlace && landOn == null && before.archiveAt != null) landOn = before.archiveAt;
    try {
      const frames = await fetchObsFrames(
        before.source,
        within(FRAMES_TIMEOUT_MS, mine.signal),
        before.field,
        before.hours,
        before.run ?? undefined,
        archive ? (before.archiveAt ?? undefined) : undefined,
      );
      if (mine.signal.aborted) return;
      const unchanged =
        frames.length === before.frames.length && frames.every((f, i) => f.key === before.frames[i]?.key);
      if (unchanged) {
        // The same frames (a run picked that was already on screen): only the
        // instant to land on can have moved.
        if (landOn != null && frames.length) {
          const at = landOn;
          landOn = null;
          const i = frames.reduce((best, f, k) => (Math.abs(f.unix - at) < Math.abs(frames[best].unix - at) ? k : best), 0);
          if (i !== before.index) set({ index: i });
        }
        if (!keepPlace) set({ busy: false });
        return;
      }
      // The newest hour is where a chase day starts; scrub back from there.
      // A forecast opens on the hour nearest now -- a run's present, the way a
      // model viewer lands -- rather than on its last day.
      const forecast = before.catalog?.sources.find((s) => s.id === before.source)?.forecast ?? false;
      let index = frames.length - 1;
      if (forecast && frames.length) {
        const now = Date.now() / 1000;
        index = frames.reduce((best, f, i) => (Math.abs(f.unix - now) < Math.abs(frames[best].unix - now) ? i : best), 0);
      }
      if (keepPlace && !atNewest && pinned) {
        const same = frames.findIndex((f) => f.key === pinned);
        if (same >= 0) index = same;
      }
      if (landOn != null && frames.length) {
        const at = landOn;
        index = frames.reduce((best, f, i) => (Math.abs(f.unix - at) < Math.abs(frames[best].unix - at) ? i : best), 0);
        landOn = null;
      }
      set({ frames, index, ...(keepPlace ? {} : { busy: false }) });
    } catch (err) {
      if (mine.signal.aborted) return;
      if (keepPlace && before.frames.length) return;
      set({ busy: false, frames: [], index: -1, error: describe(err, "The analysis service") });
    }
  },

  loadRuns: async () => {
    runsCtrl?.abort();
    const mine = new AbortController();
    runsCtrl = mine;
    const { source } = get();
    try {
      const runs = await fetchObsRuns(source, within(FRAMES_TIMEOUT_MS, mine.signal));
      if (!mine.signal.aborted && get().source === source) set({ runs });
    } catch {
      /* the picker keeps whatever it had; the newest run still shows */
    }
  },

  setRun: (run, at) => {
    const { frames, index } = get();
    if (run === get().run) {
      if (at == null) return;
      const i = frames.findIndex((f) => f.unix === at);
      if (i >= 0 && i !== index) set({ index: i });
      return;
    }
    landOn = at ?? frames[index]?.unix ?? null;
    // The status stays until the new run's frame is drawn: picking the run
    // already on screen changes no frame, and nothing would write it again.
    set({ run, loopArmed: get().playing && get().loopArmed });
    void get().loadFrames();
  },

  setArchiveAt: (unix) => {
    write(K_ARCHIVE, unix == null ? "" : String(Math.floor(unix)));
    set({ archiveAt: unix, loopArmed: get().playing && get().loopArmed });
    if (!isArchive(get().catalog, get().source)) return;
    const { frames } = get();
    // Another hour of the day on screen: only the frame moves.
    if (unix != null && frames.length && unix >= frames[0].unix && unix <= frames[frames.length - 1].unix) {
      get().goToUnix(unix);
      return;
    }
    landOn = unix;
    set({ frames: [], index: -1, valid: null });
    void get().loadFrames();
  },

  setView: (view) => {
    const before = get().view;
    if (view === before) return;
    if (view === "runs") runBeforeStrip = get().run;
    set({ view });
    // Flipping through runs is a look back, not a move: closing the strip
    // returns to the run that was open, on the valid time now on screen.
    if (before === "runs" && runBeforeStrip !== undefined) {
      const back = runBeforeStrip;
      runBeforeStrip = undefined;
      get().setRun(back);
    }
  },
  setWindows: (windows) => {
    write(K_WINDOWS, JSON.stringify(windows));
    set({ windows });
  },

  setHours: (h) => {
    if (h === get().hours) return;
    write(K_HOURS, String(h));
    set({ hours: h, loopArmed: get().playing && get().loopArmed });
    void get().loadFrames();
  },

  setSource: (id) => {
    if (id === get().source) return;
    write(K_SOURCE, id);
    const field = fieldFor(get().catalog, id, get().field);
    write(K_FIELD, field);
    set({ source: id, field, frames: [], index: -1, run: null, runs: [], valid: null,
      view: viewFor(get().catalog, id, get().view), loopArmed: get().playing && get().loopArmed });
    void get().loadFrames();
  },

  replay: (id, hours) => {
    const { catalog } = get();
    const field = fieldFor(catalog, id, get().field);
    write(K_SOURCE, id);
    write(K_FIELD, field);
    write(K_HOURS, String(hours));
    // Picked mid-play, the replay's loop is made ahead like any other.
    set({ source: id, field, hours, frames: [], index: -1, run: null, runs: [], valid: null,
      view: viewFor(catalog, id, get().view), loopArmed: get().playing && get().loopArmed });
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
        set({ source: other, field: id, frames: [], index: -1, run: null, runs: [], valid: null,
          view: viewFor(catalog, other, get().view), loopArmed: get().playing && get().loopArmed });
        void get().loadFrames();
        return;
      }
    }
    set({ field: id, valid: null, loopArmed: get().playing && get().loopArmed });
  },

  setIndex: (i) => {
    const n = get().frames.length;
    if (n === 0) return;
    set({ index: Math.max(0, Math.min(i, n - 1)) });
  },

  goToUnix: (unix) => {
    const { frames, catalog, source } = get();
    if (!frames.length) return;
    // Live radar beside the archive is years away from it: the archive stays
    // on its own hour rather than jumping to the end of its day.
    if (unix != null && isArchive(catalog, source) &&
        (unix < frames[0].unix - 3 * 3600 || unix > frames[frames.length - 1].unix + 3 * 3600)) return;
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
  setPlaying: (on) => {
    if (on !== get().playing) set({ playing: on });
  },
  prepareLoop: (keys) => {
    const { source, field } = get();
    const id = `${source}|${field}|${keys.join(",")}`;
    if (id === get().loopId) return;
    set({ loopKeys: keys, loopId: id, loopLoaded: 0, loopTotal: keys.length });
  },
  stopLoop: () => {
    set({ loopKeys: [], loopId: "", loopLoaded: 0, loopTotal: 0, loopArmed: false, loopStops: get().loopStops + 1 });
    void cancelObsLoop().catch(() => undefined);
  },
  armLoop: () => {
    if (!get().loopArmed) set({ loopArmed: true });
  },
  dropLoop: (disarm = false) => {
    if (disarm && get().loopArmed) set({ loopArmed: false });
    if (!get().loopKeys.length) return;
    set({ loopKeys: [], loopId: "", loopLoaded: 0, loopTotal: 0 });
    void cancelObsLoop().catch(() => undefined);
  },
}));

/** The frames whose picture and lines are on this machine, as
 *  "source|field|key": what a playing timeline can show at once. Kept by the
 *  layer (obsLayer's frame cache); not state, so filling it re-renders nothing. */
export const obsFramesHere = new Set<string>();
/** Frames of the loop that failed to come: play steps past them. */
export const obsFramesFailed = new Set<string>();

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

// The archive's moment follows the hour on screen, so a reload or a restart
// reopens the same hour of the same day.
useObsStore.subscribe((s, prev) => {
  if (s.index === prev.index && s.frames === prev.frames) return;
  if (!isArchive(s.catalog, s.source)) return;
  const f = s.frames[s.index];
  if (!f || f.unix === s.archiveAt) return;
  write(K_ARCHIVE, String(f.unix));
  useObsStore.setState({ archiveAt: f.unix });
});
