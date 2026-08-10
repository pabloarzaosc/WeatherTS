import { create } from "zustand";

import {
  fetchViewerModels,
  fetchViewerSounding,
  fetchRaobSounding,
  fetchAreaSounding,
  fetchAcarsSounding,
  type AreaBox,
  type ModelInfo,
  type RaobStation,
  type SoundingData,
} from "../lib/soundingViewer";

/** How the profile the viewer is showing was produced. */
export type SoundingMode = "model" | "raob" | "area" | "acars";

/** Sampling grid side for an area mean: 5 -> 25 points inside the rectangle. */
export const AREA_SIDE = 5;
export const ACARS_WINDOW_H = 12;

let controller: AbortController | null = null;
let loadTimer: number | null = null;

// Client-side frame cache for the current point. Scrubbing the timeline used
// to re-request (and the backend re-render) every hour from scratch; now each
// rendered frame is kept here and neighbouring hours are fetched ahead of time
// so stepping/playing pulls from memory instead of the network.
const frameCache = new Map<string, SoundingData>();
const prefetchControllers = new Map<number, AbortController>();

const DEBOUNCE_MS = 180; // settle time before a cold (uncached) hour is fetched
const PREFETCH_AHEAD = 2; // forecast usually plays forward, so bias ahead
const PREFETCH_BEHIND = 1;
const MAX_INFLIGHT_PREFETCH = 2; // one warm backend worker -> keep the queue short

function frameKey(model: string, hour: number): string {
  return `${model}:${hour}`;
}

function clearQueuedLoad() {
  if (loadTimer !== null) {
    window.clearTimeout(loadTimer);
    loadTimer = null;
  }
}

function abortPrefetch() {
  prefetchControllers.forEach((c) => c.abort());
  prefetchControllers.clear();
}

function resetFrames() {
  frameCache.clear();
  abortPrefetch();
}

// Decode a prefetched frame's PNG now so the browser has the bitmap ready by
// the time the user steps onto it (the <img> then paints instantly). Fire and
// forget: we don't retain the Image, so a full-res decoded bitmap isn't pinned
// in memory -- worst case the frame is cheaply re-decoded on display.
function warmImage(d: SoundingData) {
  if (!d.image || typeof Image === "undefined") return;
  try {
    const im = new Image();
    im.src = `data:image/png;base64,${d.image}`;
    void im.decode?.().catch(() => {});
  } catch {
    /* decoding is a best-effort warm-up */
  }
}

export const useSoundingViewerStore = create<SoundingViewerState>((set, get) => {
  // The cache dimension: which sounding source is active. In RAOB mode frames
  // are keyed per station; in model mode per model id. Everything below (cache,
  // prefetch, load) is source-agnostic and just uses this key + fetchFrame().
  function sourceKey(): string {
    const s = get();
    if (s.mode === "raob" && s.station) return `raob:${s.station.id}`;
    if (s.mode === "acars" && s.airport) return `acars:${s.airport}`;
    // The box is part of the identity: a different rectangle is a different
    // sounding, so its frames must not be served from the old one's cache.
    if (s.mode === "area") return `area:${(s.areaBox ?? []).join(",")}:${s.model}`;
    return s.model;
  }

  function fetchFrame(hour: number, signal: AbortSignal): Promise<SoundingData> {
    const s = get();
    if (s.mode === "raob" && s.station) return fetchRaobSounding(s.station, hour, signal);
    if (s.mode === "acars" && s.airport) {
      // The aircraft time axis is a list of actual ascent times, so an hour
      // index only means something once the first frame has told us the times.
      const unix = s.data?.meta.times?.[hour] ?? null;
      return fetchAcarsSounding(s.airport, unix, ACARS_WINDOW_H, signal);
    }
    if (s.mode === "area") {
      // Never fall through to the point fetch here: that would quietly return a
      // single-cell sounding while the viewer still says "area mean of N pts".
      if (!s.areaBox) return Promise.reject(new Error("No area selected — draw a box on the map."));
      return fetchAreaSounding(s.areaBox, s.model, hour, AREA_SIDE, signal);
    }
    return fetchViewerSounding(s.lat as number, s.lon as number, s.model, hour, signal);
  }

  // Fetch one hour into the cache in the background (no UI state changes).
  function prefetchOne(hour: number) {
    const key = sourceKey();
    const ctrl = new AbortController();
    prefetchControllers.set(hour, ctrl);
    fetchFrame(hour, ctrl.signal)
      .then((res) => {
        if (!ctrl.signal.aborted) {
          frameCache.set(frameKey(key, res.meta.hour), res);
          warmImage(res);
        }
      })
      .catch(() => {
        /* prefetch is best-effort */
      })
      .finally(() => {
        prefetchControllers.delete(hour);
        if (!ctrl.signal.aborted) schedulePrefetch();
      });
  }

  // Warm the hours immediately around the current one so the next step is
  // already in memory. Walks meta.validHours when available so we only ask for
  // hours the backend will actually return (max cache-hit rate).
  function schedulePrefetch() {
    const { lat, lon, data } = get();
    if (lat === null || lon === null || !data) return;
    const key = sourceKey();

    const valid = data.meta.validHours?.length ? data.meta.validHours : null;
    const hour = get().hour;
    const targets: number[] = [];
    if (valid) {
      const idx = valid.indexOf(data.meta.hour);
      if (idx >= 0) {
        for (let k = 1; k <= PREFETCH_AHEAD; k++) {
          const h = valid[idx + k];
          if (h !== undefined) targets.push(h);
        }
        for (let k = 1; k <= PREFETCH_BEHIND; k++) {
          const h = valid[idx - k];
          if (h !== undefined) targets.push(h);
        }
      }
    } else {
      const max = Math.max(data.meta.forecastMaxHour ?? data.meta.nTimes - 1, 0);
      if (hour + 1 <= max) targets.push(hour + 1);
      if (hour + 2 <= max) targets.push(hour + 2);
      if (hour - 1 >= 0) targets.push(hour - 1);
    }

    for (const h of targets) {
      if (prefetchControllers.size >= MAX_INFLIGHT_PREFETCH) break;
      if (frameCache.has(frameKey(key, h)) || prefetchControllers.has(h)) continue;
      prefetchOne(h);
    }
  }

  return {
    open: false,
    lat: null,
    lon: null,
    model: "auto",
    mode: "model",
    station: null,
    airport: null,
    areaBox: null,
    areaSelecting: false,
    hour: 0,
    autoHour: true,
    pendingHour: null,
    preselectHour: null,
    models: [],
    data: null,
    loading: false,
    busy: false,
    error: null,

    openAt: (lat, lon) => {
      clearQueuedLoad();
      resetFrames();
      // If a time was pre-selected on the global timeline, open there;
      // otherwise snap to "now".
      const pre = get().preselectHour;
      set({
        open: true, mode: "model", station: null, airport: null, lat, lon,
        areaSelecting: false,
        data: null, error: null,
        autoHour: pre == null, hour: pre ?? 0, preselectHour: null,
      });
      void get().load();
    },

    /** A sounding averaged over the rectangle dragged on the map. */
    openArea: (box) => {
      clearQueuedLoad();
      resetFrames();
      const pre = get().preselectHour;
      const [south, west, north, east] = box;
      set({
        open: true, mode: "area", station: null, airport: null,
        // The centre is what the model preflight and the header coordinate use.
        lat: (south + north) / 2, lon: (west + east) / 2,
        areaBox: box,
        data: null, error: null,
        autoHour: pre == null, hour: pre ?? 0, preselectHour: null,
      });
      void get().load();
    },

    /** An aircraft (ACARS/AMDAR) ascent or descent at an airport. */
    openAcars: (airport) => {
      clearQueuedLoad();
      resetFrames();
      set({
        open: true, mode: "acars", station: null, airport: airport.airport,
        lat: airport.lat, lon: airport.lon,
        data: null, error: null,
        // The aircraft axis is short and irregular; always land on the newest
        // ascent rather than whatever index the timeline happened to hold.
        autoHour: false, hour: 0, preselectHour: null,
      });
      void get().load();
    },

    /** Arm the map for a drag-to-draw area selection. */
    setAreaSelecting: (areaSelecting) => set({ areaSelecting }),

    // Open the viewer on an observed radiosonde (RAOB) station. Same viewer,
    // same timeline machinery -- the "time axis" is recent 00Z/12Z obs times.
    openRaob: (station) => {
      clearQueuedLoad();
      resetFrames();
      const pre = get().preselectHour;
      set({
        open: true,
        mode: "raob",
        station,
        airport: null,
        lat: station.lat,
        lon: station.lon,
        data: null,
        error: null,
        autoHour: pre == null,
        hour: pre ?? 0,
        preselectHour: null,
      });
      void get().load();
    },

    // Global timeline scrubbing while no sounding is open: remember the chosen
    // time index so the next opened sounding starts there.
    setPreselectHour: (hour) => {
      const h = Math.max(0, hour);
      set({ hour: h, preselectHour: h, autoHour: false });
    },

    setPendingHour: (hour) => set({ pendingHour: hour }),

    close: () => {
      clearQueuedLoad();
      controller?.abort();
      controller = null;
      resetFrames();
      set({ open: false });
    },

    setModel: (model) => {
      if (model === get().model) return;
      clearQueuedLoad();
      resetFrames();
      set({ model, data: null, error: null });
      void get().load();
    },

    setHour: (hour) => {
      const { data } = get();
      const max = data ? Math.max(data.meta.forecastMaxHour ?? data.meta.nTimes - 1, 0) : 384;
      const clamped = Math.max(0, Math.min(hour, max));
      if (clamped === get().hour) return;
      set({ hour: clamped, autoHour: false, error: null });
      clearQueuedLoad();
      // A cached frame can swap in immediately; only cold hours pay the debounce
      // (which coalesces a fast drag across many hours into one fetch).
      if (frameCache.has(frameKey(sourceKey(), clamped))) {
        void get().load();
        return;
      }
      loadTimer = window.setTimeout(() => {
        loadTimer = null;
        void get().load();
      }, DEBOUNCE_MS);
    },

    stepHour: (delta) => get().setHour(get().hour + delta),

    // Used by playback only: unlike setHour/stepHour, this does not move
    // `hour` (and therefore the timeline position + displayed image) until
    // the target frame has actually finished loading -- so autoplay never
    // shows the position advancing ahead of the frame it points to.
    gotoPlaybackHour: async (targetHour) => {
      const { lat, lon, data } = get();
      if (lat === null || lon === null || !data) return false;
      const max = Math.max(data.meta.forecastMaxHour ?? data.meta.nTimes - 1, 0);
      const target = Math.max(0, Math.min(targetHour, max));
      if (target === get().hour) return true;

      clearQueuedLoad();
      const key = sourceKey();

      const cached = frameCache.get(frameKey(key, target));
      if (cached) {
        controller?.abort();
        controller = null;
        set({ data: cached, hour: cached.meta.hour, loading: false, busy: false, error: null });
        schedulePrefetch();
        return true;
      }

      controller?.abort();
      controller = new AbortController();
      const mine = controller;
      set({ busy: true, error: null });
      try {
        const result = await fetchFrame(target, mine.signal);
        if (mine.signal.aborted) return false;
        frameCache.set(frameKey(key, result.meta.hour), result);
        set({ data: result, hour: result.meta.hour, busy: false, error: null });
        schedulePrefetch();
        return true;
      } catch (err) {
        if (mine.signal.aborted) return false;
        set({ error: err instanceof Error ? err.message : String(err), busy: false });
        return false;
      }
    },

    loadModels: async () => {
      try {
        const res = await fetchViewerModels();
        set({ models: res.models });
      } catch {
        /* backend may be offline; controls fall back to a static list */
      }
    },

    load: async () => {
      const { lat, lon, hour, data } = get();
      if (lat === null || lon === null) return;

      clearQueuedLoad();
      const key = sourceKey();

      // Instant path: serve a cached frame with no spinner and no network hit.
      const cached = frameCache.get(frameKey(key, hour));
      if (cached && !get().autoHour) {
        controller?.abort();
        controller = null;
        set({ data: cached, hour: cached.meta.hour, loading: false, busy: false, error: null });
        schedulePrefetch();
        return;
      }

      controller?.abort();
      controller = new AbortController();
      const mine = controller;

      set({ loading: data === null, busy: true, error: null });
      try {
        const result = await fetchFrame(hour, mine.signal);
        if (mine.signal.aborted) return;
        frameCache.set(frameKey(key, result.meta.hour), result);

        // On the first load, snap the forecast hour to the step nearest "now".
        let nextHour = hour;
        if (get().autoHour && result.meta.times.length > 1) {
          const now = Date.now() / 1000;
          let best = 0;
          let bestDiff = Infinity;
          result.meta.times.forEach((t, i) => {
            const d = Math.abs(t - now);
            if (d < bestDiff) {
              bestDiff = d;
              best = i;
            }
          });
          nextHour = best;
        }

        if (get().autoHour && nextHour !== hour) {
          // Re-fetch at the snapped hour (backend caches the raw profile, so cheap).
          set({ autoHour: false, hour: nextHour, data: result });
          void get().load();
          return;
        }

        set({ data: result, hour: result.meta.hour, loading: false, busy: false, autoHour: false });
        schedulePrefetch();
      } catch (err) {
        if (mine.signal.aborted) return;
        set({
          error: err instanceof Error ? err.message : String(err),
          loading: false,
          busy: false,
        });
      }
    },
  };
});

interface SoundingViewerState {
  open: boolean;
  lat: number | null;
  lon: number | null;
  model: string;
  mode: SoundingMode;
  station: RaobStation | null;
  /** ACARS mode: the airport whose ascent is showing. */
  airport: string | null;
  /** Area mode: the rectangle being averaged, [south, west, north, east]. */
  areaBox: AreaBox | null;
  /** True while the map is armed for a drag-to-draw area selection. */
  areaSelecting: boolean;
  hour: number;
  autoHour: boolean; // snap to "now" after the first load
  pendingHour: number | null; // frame being rendered during playback (for overlays)
  preselectHour: number | null; // time chosen on the global timeline while closed
  models: ModelInfo[];
  data: SoundingData | null;
  loading: boolean; // full-panel spinner (no data yet)
  busy: boolean; // background refetch (keep old plot visible)
  error: string | null;

  openAt: (lat: number, lon: number) => void;
  openRaob: (station: RaobStation) => void;
  openArea: (box: AreaBox) => void;
  setAreaSelecting: (v: boolean) => void;
  openAcars: (airport: { airport: string; lat: number; lon: number }) => void;
  close: () => void;
  setModel: (model: string) => void;
  setHour: (hour: number) => void;
  stepHour: (delta: number) => void;
  setPreselectHour: (hour: number) => void;
  setPendingHour: (hour: number | null) => void;
  gotoPlaybackHour: (hour: number) => Promise<boolean>;
  loadModels: () => Promise<void>;
  load: () => Promise<void>;
}
