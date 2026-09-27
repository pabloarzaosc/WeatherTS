import { create } from "zustand";

import {
  fetchLsr,
  LSR_CATEGORIES,
  lsrKey,
  lsrPlace,
  lsrSeverity,
  lsrStrength,
  type LsrCategory,
  type LsrCollection,
  type LsrFeature,
  type LsrSeverity,
} from "../lib/lsr";

/**
 * Local Storm Reports state.
 *
 * `endUnix` is what makes LSRs obey the ONE TIMELINE rule: the layer always
 * shows the window ENDING at the timeline's position, so scrubbing back over a
 * radar loop shows the reports that existed at that moment rather than every
 * report filed since.
 */

export const LSR_WINDOWS = [1, 3, 6, 12, 24, 48] as const;
export type LsrWindow = (typeof LSR_WINDOWS)[number];
/** A fixed length, or "day": the convective day, since the last 12Z -- the
 *  window SPC's own storm report pages use. */
export type LsrSpan = LsrWindow | "day";
export type LsrSort = "new" | "strong";

/** While live, the feed is asked again this often: offices file all through
 *  an event, and a report that came in five minutes ago is the one that matters. */
const POLL_MS = 2 * 60_000;
/** How long a report that arrived while watching stays marked as new. */
export const LSR_NEW_FOR_S = 20 * 60;

let controller: AbortController | null = null;
let debounce: number | null = null;
let pollTimer: number | null = null;

/** The last 12Z at or before `end` (unix seconds). */
export function convectiveDayStart(end: number): number {
  const d = new Date(end * 1000);
  const at12 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12) / 1000;
  return at12 <= end ? at12 : at12 - 86400;
}

interface LsrState {
  span: LsrSpan;
  /** null = live (window ends now). */
  endUnix: number | null;
  cats: Record<LsrCategory, boolean>;
  /** Hide what falls below this: 0 everything, 1 severe, 2 significant severe. */
  minSeverity: LsrSeverity;
  /** Draw a report's magnitude next to its icon. */
  showLabels: boolean;
  /** Older reports drawn fainter, so the newest stand out. */
  fadeOld: boolean;
  /** The list holds only the reports inside the map view. */
  inView: boolean;
  search: string;
  sort: LsrSort;
  data: LsrCollection | null;
  busy: boolean;
  error: string | null;
  updatedAt: number | null;
  /** When each report still in the window first came in, for those that
   *  arrived while the feed was being watched (not the first load's). */
  arrived: Record<string, number>;
  /** Report the user clicked, for the detail card. */
  selected: LsrFeature | null;
  /** Report under the pointer in the list, ringed on the map. */
  hovered: string | null;

  setSpan: (s: LsrSpan) => void;
  setEndUnix: (t: number | null) => void;
  toggleCat: (c: LsrCategory) => void;
  /** Only these categories on; the same set again turns everything back on. */
  soloCats: (cs: LsrCategory[]) => void;
  setAllCats: (on: boolean) => void;
  setMinSeverity: (v: LsrSeverity) => void;
  setShowLabels: (v: boolean) => void;
  setFadeOld: (v: boolean) => void;
  setInView: (v: boolean) => void;
  setSearch: (v: string) => void;
  setSort: (v: LsrSort) => void;
  select: (f: LsrFeature | null) => void;
  setHovered: (key: string | null) => void;
  load: () => Promise<void>;
  reload: () => void;
  startPolling: () => void;
  stopPolling: () => void;
}

const allCats = (on: boolean) =>
  LSR_CATEGORIES.reduce(
    (acc, c) => {
      acc[c] = on;
      return acc;
    },
    {} as Record<LsrCategory, boolean>,
  );

/** The window a load asks for: its start and end, unix seconds. */
export function lsrWindow(span: LsrSpan, endUnix: number | null): { start: number; end: number } {
  const end = endUnix ?? Date.now() / 1000;
  return { start: span === "day" ? convectiveDayStart(end) : end - span * 3600, end };
}

export const useLsrStore = create<LsrState>((set, get) => ({
  span: 6,
  endUnix: null,
  cats: allCats(true),
  minSeverity: 0,
  showLabels: true,
  fadeOld: false,
  inView: false,
  search: "",
  sort: "new",
  data: null,
  busy: false,
  error: null,
  updatedAt: null,
  arrived: {},
  selected: null,
  hovered: null,

  setSpan: (span) => {
    if (span === get().span) return;
    set({ span });
    get().reload();
  },
  setEndUnix: (endUnix) => {
    if (endUnix === get().endUnix) return;
    set({ endUnix });
    get().reload();
  },
  toggleCat: (c) => set((s) => ({ cats: { ...s.cats, [c]: !s.cats[c] } })),
  soloCats: (cs) =>
    set((s) => {
      const already = LSR_CATEGORIES.every((c) => s.cats[c] === cs.includes(c));
      if (already) return { cats: allCats(true) };
      const cats = allCats(false);
      for (const c of cs) cats[c] = true;
      return { cats };
    }),
  setAllCats: (on) => set({ cats: allCats(on) }),
  setMinSeverity: (minSeverity) => set({ minSeverity }),
  setShowLabels: (showLabels) => set({ showLabels }),
  setFadeOld: (fadeOld) => set({ fadeOld }),
  setInView: (inView) => set({ inView }),
  setSearch: (search) => set({ search }),
  setSort: (sort) => set({ sort }),
  select: (selected) => set({ selected }),
  setHovered: (hovered) => {
    if (hovered !== get().hovered) set({ hovered });
  },

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
    const { span, endUnix } = get();
    controller?.abort();
    controller = new AbortController();
    const mine = controller;
    set({ busy: true, error: null });
    try {
      const { start, end } = lsrWindow(span, endUnix);
      const hours = Math.max(1, Math.min(72, Math.round((end - start) / 3600)));
      const data = dedupe(await fetchLsr(hours, endUnix, mine.signal, span === "day" ? start : null));
      if (mine.signal.aborted) return;
      set({ data, busy: false, error: null, updatedAt: Date.now() / 1000, arrived: arrivals(get(), data) });
    } catch (err) {
      if (mine.signal.aborted) return;
      set({ error: err instanceof Error ? err.message : String(err), busy: false });
    }
  },

  startPolling: () => {
    if (pollTimer !== null) return;
    pollTimer = window.setInterval(() => {
      const s = get();
      // Only live: a window pinned to the timeline does not change.
      if (s.endUnix === null && !s.busy) void s.load();
    }, POLL_MS);
  },
  stopPolling: () => {
    if (pollTimer !== null) window.clearInterval(pollTimer);
    pollTimer = null;
  },
}));

/**
 * One copy of each report. The feed repeats a report an office sent twice --
 * in a correction, or again in its end-of-event summary -- at the same time,
 * place and type; the list showed both, and counted both. The newest issue wins.
 */
function dedupe(data: LsrCollection): LsrCollection {
  const by = new Map<string, LsrFeature>();
  for (const f of data.features) {
    const k = lsrKey(f);
    const had = by.get(k);
    if (!had || (f.properties.issuedUnix ?? 0) > (had.properties.issuedUnix ?? 0)) by.set(k, f);
  }
  if (by.size === data.features.length) return data;
  const features = data.features.filter((f) => by.get(lsrKey(f)) === f);
  return { ...data, features, meta: { ...data.meta, count: features.length } };
}

/**
 * Which reports of a fresh answer are new since the last one, carried along
 * with those that already were. Only a live refresh of the same window counts:
 * the first load, another window, or a scrub brings back reports that were
 * always there, and marking all of them new would mean nothing.
 */
function arrivals(prev: LsrState, next: LsrCollection): Record<string, number> {
  const before = prev.data;
  const now = Date.now() / 1000;
  if (!before || prev.endUnix !== null || before.meta.startUnix > next.meta.startUnix + 60 ||
      next.meta.endUnix < before.meta.endUnix) {
    return {};
  }
  const had = new Set(before.features.map(lsrKey));
  const out: Record<string, number> = {};
  for (const f of next.features) {
    const k = lsrKey(f);
    const when = prev.arrived[k] ?? (had.has(k) ? undefined : now);
    if (when !== undefined && now - when < LSR_NEW_FOR_S) out[k] = when;
  }
  return out;
}

/** Whether a report is marked new right now. */
export function isNewLsr(arrived: Record<string, number>, key: string): boolean {
  const at = arrived[key];
  return at !== undefined && Date.now() / 1000 - at < LSR_NEW_FOR_S;
}

/**
 * Reports left after the category and severity filters — what the layer
 * actually draws.
 *
 * Takes the fields it needs rather than the whole state, so React callers can
 * run it inside a useMemo. It must NEVER be passed to `useLsrStore()` as a
 * selector: zustand v5 compares results by identity and this builds a new
 * array every call, which loops the renderer forever.
 */
export function selectVisibleLsr(s: {
  data: LsrCollection | null;
  cats: Record<LsrCategory, boolean>;
  minSeverity: LsrSeverity;
}): LsrFeature[] {
  const feats = s.data?.features ?? [];
  return feats.filter(
    (f) => s.cats[f.properties.cat] !== false && (s.minSeverity === 0 || lsrSeverity(f.properties) >= s.minSeverity),
  );
}

/** [west, south, east, north]. */
export type LsrBounds = [number, number, number, number];

/**
 * The list as the panel shows it: the drawn reports, narrowed by the search
 * and the map view, in the chosen order. The card steps through the same list.
 */
export function lsrFeed(
  visible: LsrFeature[],
  opts: { search: string; sort: LsrSort; bounds: LsrBounds | null },
): LsrFeature[] {
  const q = opts.search.trim().toLowerCase();
  const b = opts.bounds;
  const out = visible.filter((f) => {
    if (b) {
      const [lon, lat] = f.geometry.coordinates;
      // A view across the antimeridian has west > east.
      const inLon = b[0] <= b[2] ? lon >= b[0] && lon <= b[2] : lon >= b[0] || lon <= b[2];
      if (!inLon || lat < b[1] || lat > b[3]) return false;
    }
    if (!q) return true;
    const p = f.properties;
    return [p.typeName, p.label, lsrPlace(p), p.wfo, p.source, p.remark, p.mag]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });
  return opts.sort === "strong"
    ? out.sort((a, b2) => lsrStrength(b2.properties) - lsrStrength(a.properties) || b2.properties.unix - a.properties.unix)
    : out.sort((a, b2) => b2.properties.unix - a.properties.unix);
}
