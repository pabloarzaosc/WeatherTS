import { create } from "zustand";

import {
  fetchNexradMeta,
  fetchNexradScans,
  fetchNexradSites,
  fetchNexradStorms,
  fetchPaletteTables,
  fetchScanData,
  fetchSiteAvailability,
  withAvailability,
  type SiteAvailability,
  type StormReport,
  type NexradPalette,
  type NexradProduct,
  type NexradScan,
  type NexradSite,
  type PaletteDef,
  type ProductFamily,
  type ProductGrids,
} from "../lib/nexrad";
import { wireCode } from "../lib/nexrad";
import { getActivePaneId } from "../map/mapInstance";
import { buildMesh, decodeScan, recolor, type PolarScan, type RadarMesh } from "../lib/radarMesh";
import { usePaletteStore } from "./usePaletteStore";

// Single-site NEXRAD Level III radar. `date` picks a UTC day from the archive
// (which starts ~2022-03); "" means today/live. `scans` is that day's scan list
// (thinned) and doubles as the global timeline's time axis, so the radar frames
// can be scrubbed and animated.

let controller: AbortController | null = null;
let pollTimer: number | null = null;
// Which frame the storm scan on screen answers for, so replaying frames inside
// one volume doesn't reapply it every step.
let lastStormKey: string | null = null;

/**
 * Storm scans, kept per frame.
 *
 * Playback asks for a new one every few hundred milliseconds. The old code
 * aborted the in-flight request each time a frame advanced, so at 1x every
 * request was cancelled by the next one and nothing ever landed -- the tracks
 * sat frozen on whichever volume happened to load before playback started.
 * Requests are now left to finish and their answers kept; only the answer that
 * still matches the frame on screen is applied.
 */
const stormCache = new Map<string, StormReport>();
const stormInFlight = new Map<string, Promise<StormReport | null>>();
/** Roughly a day of frames. Small objects -- a few dozen cells each. */
const STORM_CACHE_MAX = 300;
/** How far ahead of the playhead to warm storm scans, and how hard. Bounded on
 *  purpose: a loop can be 240 frames, and the tracks are a garnish on the
 *  radar, not the picture. */
const STORM_WARM_AHEAD = 8;
const STORM_WARM_CONCURRENCY = 2;

const stormKeyFor = (site: string, unix: number | null) => `${site}:${unix ?? "latest"}`;

function stormFor(site: string, unix: number | null): Promise<StormReport | null> {
  const k = stormKeyFor(site, unix);
  const hit = stormCache.get(k);
  if (hit) return Promise.resolve(hit);
  const running = stormInFlight.get(k);
  if (running) return running;

  const p = fetchNexradStorms(site, unix)
    .then((report) => {
      if (stormCache.size >= STORM_CACHE_MAX) {
        // Map keeps insertion order, so the first key is the oldest.
        const oldest = stormCache.keys().next().value;
        if (oldest !== undefined) stormCache.delete(oldest);
      }
      stormCache.set(k, report);
      return report;
    })
    .catch(() => null)
    .finally(() => {
      stormInFlight.delete(k);
    });
  stormInFlight.set(k, p);
  return p;
}

// How many scans the loop covers. A day holds ~200-440 per product, so the list
// is thinned evenly to this many (newest always kept). Each frame is ~220 KB
// cached and ~65 ms to mesh, so long loops cost memory and warm time, not
// playback smoothness.
export const FRAME_CHOICES = [30, 60, 120, 240] as const;
export const DEFAULT_FRAMES = 60;
// Level II frames are whole ~7 MB volumes and the bucket keeps a couple of
// hours of them, so the long loops simply aren't on offer there -- showing 240
// would promise frames that can't be delivered.
export const L2_FRAME_CHOICES = [15, 30] as const;
export const L2_MAX_FRAMES = 30;

/** The loop lengths a product can actually serve. */
export function frameChoicesFor(product: string): readonly number[] {
  return product.startsWith("L2") ? L2_FRAME_CHOICES : FRAME_CHOICES;
}

/** Clamp a loop length to what the product can serve. */
function clampFrames(product: string, frames: number): number {
  return product.startsWith("L2") ? Math.min(frames, L2_MAX_FRAMES) : frames;
}

/**
 * A pinned whole day can't survive a switch to Level 2 -- a day of volumes is
 * ~2 GB and the source only keeps ~48 h -- so the day is dropped rather than
 * attempted.
 */
function keepDay(product: string, archiveDate: string | null): string | null {
  return product.startsWith("L2") ? null : archiveDate;
}
// Scans land every ~4-6 min. The visible lag is this interval PLUS the server's
// listing cache, so both are kept short -- a minute each stacked to ~2 min and
// the radar looked stuck next to sites that update promptly.
const POLL_MS = 20_000;

// Decoded scans, keyed by S3 key -- a scan never changes, so this only needs a
// bound. ~1.3 MB each (codes are 1 byte/gate), so a full 40-frame day is ~50 MB.
// Built meshes are cached separately (see meshCache) since the build, not the
// decode, is what blocks the main thread.
const scanCache = new Map<string, PolarScan>();
const SCAN_CACHE_MAX = 520; // a whole day is ~400 scans; below that it thrashes
// In-flight fetches, so a prefetch and a display never race for the same scan.
const inflight = new Map<string, Promise<PolarScan>>();
// Concurrent background fetches. A frame is ~450 ms cold and ~220 KB, so a few
// at a time warms a whole 40-frame day in a couple of seconds without starving
// the frame the user is actually waiting on.
const WARM_CONCURRENCY = 5;
let warmToken = 0;
// Supersedes an in-flight whole-day load (a new pick, or Cancel).
let dayToken = 0;

// Per-product scan lists for split screen.
//
// `scans` is the timeline, and it belongs to whichever product the FOCUSED pane
// is showing. Level III keys are per-product (DVN_N0B_... vs DVN_N0G_...), so a
// pane on a different product cannot reuse that key: asking for N0B with an N0G
// key returns the velocity file, and the pane then draws velocity data under a
// reflectivity label and palette. Each pane resolves its own key for the same
// instant instead, from its own product's list.
const paneLists = new Map<string, NexradScan[]>();
/** In-flight list fetches, so two panes on one product make a single request. */
const paneListInflight = new Map<string, Promise<NexradScan[]>>();
/** When a product's list last failed, so playback doesn't refetch every frame. */
const paneListFailed = new Map<string, number>();
/** How long a failed list stays failed before it is worth trying again. */
const LIST_RETRY_MS = 30_000;
/** The arguments the master list was fetched with, so pane lists match it. */
let listParams: { date: string; limit: number; start: number } = { date: "", limit: 0, start: 0 };

function resetPaneLists(date: string, limit: number, start: number): void {
  paneLists.clear();
  paneListInflight.clear();
  paneListFailed.clear();
  listParams = { date, limit, start };
}

/** A product's scan list, fetched at most once per product per list generation. */
function paneList(site: string, product: string): Promise<NexradScan[]> {
  const id = `${site}|${product}`;
  const hit = paneLists.get(id);
  if (hit) return Promise.resolve(hit);

  const failedAt = paneListFailed.get(id);
  if (failedAt !== undefined && Date.now() - failedAt < LIST_RETRY_MS) {
    // Recently failed: fall back to "" (the backend picks the newest) instead
    // of hammering a list endpoint that is currently down, once per frame.
    return Promise.resolve([]);
  }

  const pending = paneListInflight.get(id);
  if (pending) return pending;

  const p = fetchNexradScans(site, product, listParams.date, listParams.limit, listParams.start)
    .then((res) => {
      paneLists.set(id, res.scans);
      paneListFailed.delete(id);
      return res.scans;
    })
    .catch(() => {
      paneListFailed.set(id, Date.now());
      return [] as NexradScan[];
    })
    .finally(() => paneListInflight.delete(id));
  paneListInflight.set(id, p);
  return p;
}

// Built meshes, keyed by everything that changes the geometry or its colours.
//
// Building a mesh is the single most expensive thing the radar does -- a
// super-res sweep is ~1M gates and the build ran 250-600 ms, all of it blocking
// the main thread. Without this, every scrub and every lap of a playing loop
// rebuilt a mesh that was byte-for-byte what it built last time, so a 30-frame
// loop paid that cost 30 times per lap. Now a frame is built once and reused.
//
// Bounded by bytes, not entries: a mesh ranges from a few KB (clear air) to
// ~25 MB (a full super-res storm), so a fixed count could hold anywhere from
// nothing useful to gigabytes. Oldest-out once over budget.
const meshCache = new Map<string, RadarMesh>();
let meshCacheBytes = 0;
const MESH_CACHE_BUDGET = 220 * 1024 * 1024; // ~220 MB of GPU-bound geometry

function meshBytes(m: RadarMesh): number {
  return m.positions.byteLength + m.colors.byteLength + m.values.byteLength + m.lut.byteLength;
}

/** A cheap, stable identity for a palette's text, so a recolour misses the cache. */
function palHash(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return h;
}

/** Build a mesh, or hand back the one already built for this exact frame+look. */
function getMesh(
  scanKey: string,
  scan: PolarScan,
  pal: string,
  smooth: boolean,
  threshold: number | null,
): RadarMesh {
  const key = `${scanKey}|${smooth ? 1 : 0}|${threshold ?? ""}|${palHash(pal)}`;
  const hit = meshCache.get(key);
  if (hit) {
    // Refresh recency: delete + re-set moves it to the end of the Map's order.
    meshCache.delete(key);
    meshCache.set(key, hit);
    return hit;
  }
  const mesh = buildMesh(scan, pal, { smooth, threshold });
  meshCache.set(key, mesh);
  meshCacheBytes += meshBytes(mesh);
  while (meshCacheBytes > MESH_CACHE_BUDGET && meshCache.size > 1) {
    const oldest = meshCache.keys().next().value;
    if (oldest === undefined) break;
    const m = meshCache.get(oldest)!;
    meshCacheBytes -= meshBytes(m);
    meshCache.delete(oldest);
  }
  return mesh;
}

/** Drop the mesh cache -- geometry options changed, so every mesh is now stale. */
function clearMeshCache(): void {
  meshCache.clear();
  meshCacheBytes = 0;
}

/**
 * The S3 key a pane should load for the master timeline's `frame`.
 *
 * Same product as the timeline: the key is already right. Different product:
 * take the nearest scan in time from that product's own list -- velocity and
 * reflectivity come off the same volume, so "nearest" is the matching sweep.
 */
async function paneKey(
  site: string,
  product: string,
  masterProduct: string,
  frame: NexradScan | undefined,
): Promise<string> {
  if (!frame) return "";
  if (product === masterProduct) return frame.key;
  // Level II frames carry no per-product key -- the backend picks the volume
  // itself, so there is nothing to translate.
  if (!frame.key) return "";

  const list = await paneList(site, product);
  if (!list.length) return "";

  let best = list[0];
  let bestDiff = Math.abs(best.time - frame.time);
  for (const s of list) {
    const diff = Math.abs(s.time - frame.time);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  return best.key;
}

/** Apply a product change to the focused pane's slot. The top-level fields are
 *  the focused pane's mirror, so the two must move together or the picker and
 *  the pixels disagree. */
function withFocusedPane(
  s: { paneRadar: Record<string, PaneRadar> },
  patch: Partial<Pick<PaneRadar, "family" | "tilt" | "product">>,
): Record<string, PaneRadar> {
  const id = getActivePaneId();
  const pane = id ? s.paneRadar[id] : undefined;
  if (!id || !pane) return s.paneRadar;
  return { ...s.paneRadar, [id]: { ...pane, ...patch, scan: null, mesh: null, meshRev: pane.meshRev + 1 } };
}

/** Every family across both grids (plus the legacy flat catalog). */
function allFamilies(s: { grids: ProductGrids; catalog: ProductFamily[] }): ProductFamily[] {
  return [...s.grids, ...s.catalog];
}

/** Cache identity for a frame -- see loadScan for why product is part of it. */
const scanId = (site: string, product: string, key: string) => `${site}|${product}|${key}`;

function cacheScan(key: string, scan: PolarScan) {
  scanCache.set(key, scan);
  while (scanCache.size > SCAN_CACHE_MAX) {
    const oldest = scanCache.keys().next().value;
    if (oldest === undefined) break;
    scanCache.delete(oldest);
  }
}

/** Fetch+decode a scan once, sharing the work if it's already in flight.
 *
 * Cache identity is site+product+key, NOT the key alone. A Level III S3 key
 * already implies its product, but a Level II volume is one live snapshot with
 * no per-product key -- keying on the key alone made every Level II moment
 * collide on the same entry, so the first one loaded (CC) was handed back for
 * all of them.
 */
function loadScan(site: string, product: string, key: string): Promise<PolarScan> {
  const id = scanId(site, product, key);
  const hit = scanCache.get(id);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(id);
  if (pending) return pending;
  const p = fetchScanData(site, product, key)
    .then((buf) => {
      const scan = decodeScan(buf);
      cacheScan(id, scan);
      return scan;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/** One split-screen pane's radar view. The timeline, site and archive mode are
 *  global, so every pane always shows the SAME moment -- only the product
 *  differs. That's the whole point: compare REF against CC at one instant. */
export interface PaneRadar {
  product: string;
  family: string;
  tilt: string | null;
  scan: PolarScan | null;
  mesh: RadarMesh | null;
  meshRev: number;
}

interface NexradState {
  sites: NexradSite[];
  products: NexradProduct[];
  catalog: ProductFamily[]; // families + their tilt options, for the picker
  grids: ProductGrids; // the merged product list, each moment on its best source, with the site's low cut
  /** The list as the backend sends it, before the selected radar is checked. */
  baseGrids: ProductGrids;
  /** What the selected radar is publishing now; null until checked. */
  availability: SiteAvailability | null;
  /** "loading" while the selected radar is being checked; "failed" falls back
   *  to the catalogue's tilts. */
  availabilityState: "idle" | "loading" | "ready" | "failed";
  /** Per-pane radar, keyed by pane id. The top-level product/scan/mesh mirror
   *  whichever pane is focused, so every existing reader keeps working. */
  paneRadar: Record<string, PaneRadar>;
  palettes: NexradPalette[];
  archiveStart: string;

  site: string | null;
  product: string; // the wire code, e.g. "N0B" (family + tilt baked in)
  family: string; // "B", "G", ... or a flat code like "EET"
  tilt: string | null; // elevation slot ("0","A","1",...) held independent of the wire code
  frames: number; // how many scans the loop covers
  /** Archive playback: unix seconds the loop starts at, or null for live. */
  archiveTime: number | null;
  /** Whole-day playback: "YYYY-MM-DD" (UTC), every scan of that day. */
  archiveDate: string | null;
  /** Non-null while a day is being pulled down; drives the blocking overlay. */
  dayLoad: { done: number; total: number } | null;
  showRing: boolean; // draw the radar range ring
  storms: StormReport | null; // SCIT cells + mesocyclones for the current site
  showTracks: boolean; // draw storm cells and their past/forecast tracks
  selectedCellId: string | null; // cell whose popup is open
  smooth: boolean; // interpolate gate colours (off = raw gates)
  threshold: number | null; // hide gates below this value
  /** Follow the pointer with the gate value and beam height under it. */
  showReadout: boolean;
  autoUpdate: boolean; // poll for new scans while live

  scans: NexradScan[];
  index: number; // into scans
  palTables: Record<string, PaletteDef>;
  kindDefaults: Record<string, string>;
  scan: PolarScan | null; // decoded polar data for the current frame
  mesh: RadarMesh | null; // GPU-ready coloured mesh
  meshRev: number; // bumps on geometry change (layer re-uploads)
  colorRev: number; // bumps on palette-only change (layer re-uploads colours)
  warm: number; // scans of the current list already cached (for the UI)
  loading: boolean;
  error: string | null;

  loadCatalog: () => Promise<void>;
  selectSite: (id: string | null) => void;
  /** Pick a moment; keeps the current tilt when the new family offers it. */
  setFamily: (f: string) => void;
  /** Pick an elevation cut within the current family. */
  setTilt: (t: string) => void;
  setProduct: (p: string) => void;
  resolvePal: (kind: string) => string | null;
  paletteIdFor: (kind: string) => string;
  /** Re-colour the current mesh in place (after a palette override changes). */
  repaint: () => void;
  setFrames: (n: number) => void;
  /** Jump the loop to a past instant (null = back to live). */
  setArchiveTime: (t: number | null) => void;
  /** Load an entire UTC day, warming every frame before playback. */
  setArchiveDate: (date: string | null) => Promise<void>;
  cancelDayLoad: () => void;
  setShowRing: (v: boolean) => void;
  setShowTracks: (v: boolean) => void;
  selectCell: (id: string | null) => void;
  loadStorms: () => Promise<void>;
  /** Register/drop a pane's radar slot. */
  addPane: (id: string) => void;
  dropPane: (id: string) => void;
  /** Point a pane at a product family; mirrors to the top level if focused. */
  setPaneFamily: (id: string, family: string) => void;
  /** Focus a pane: the panel, colour bar and readout follow it. */
  focusPane: (id: string) => void;
  setSmooth: (v: boolean) => void;
  setThreshold: (v: number | null) => void;
  setShowReadout: (v: boolean) => void;
  setAutoUpdate: (v: boolean) => void;
  /** Rebuild the current mesh from the scan already in memory. */
  loadScans: () => Promise<void>;
  prefetch: (from: number) => void;
  countWarm: () => number;
  showIndex: (i: number) => Promise<boolean>;
  refresh: () => Promise<void>;
  startAutoRefresh: () => void;
  stopAutoRefresh: () => void;
  clear: () => void;
}

/** The catalog load in flight, if any. The radar layer calls loadCatalog from
 *  every addTo, and the panel's retry button can fire while one is running, so
 *  they share a single attempt instead of stampeding the backend. */
let catalogInFlight: Promise<void> | null = null;

/** VCPs change with the weather -- precipitation to clear air drops the 0.9
 *  and 1.8 cuts -- so a selected radar is checked again this often. */
const AVAILABILITY_REFRESH_MS = 5 * 60_000;
let availabilityTimer: number | null = null;

/**
 * Each radar's last known tilts, kept across restarts. A radar's VCP rarely
 * changes between visits, so the buttons show the moment it is picked and the
 * check that follows only corrects them if it did.
 */
const AVAIL_KEY = "weatherts.radar.availability.v1";
const AVAIL_KEEP_MS = 24 * 3600_000;
const AVAIL_MAX_SITES = 60;
const knownAvailability = new Map<string, SiteAvailability>(
  (() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(AVAIL_KEY) || "{}") as Record<string, SiteAvailability>;
      const cutoff = Date.now() - AVAIL_KEEP_MS;
      return Object.entries(saved).filter(([, a]) => a && a.checkedAt * 1000 > cutoff);
    } catch {
      return [];
    }
  })(),
);

function rememberAvailability(site: string, avail: SiteAvailability): void {
  knownAvailability.delete(site);
  knownAvailability.set(site, avail);
  while (knownAvailability.size > AVAIL_MAX_SITES) {
    const oldest = knownAvailability.keys().next().value;
    if (oldest === undefined) break;
    knownAvailability.delete(oldest);
  }
  try {
    window.localStorage.setItem(AVAIL_KEY, JSON.stringify(Object.fromEntries(knownAvailability)));
  } catch {
    /* only the next start is slower */
  }
}

/**
 * Check what the selected radar is flying and put it into the product list.
 * A tilt the radar does not have moves to the nearest one it does, on every
 * pane that was on it.
 */
function checkAvailability(site: string): void {
  const store = useNexradStore;
  // In archive playback, the tilts the radar flew then: a clear-air day stops
  // at 6.4 deg where a storm day goes to 19.5.
  const at = store.getState().archiveTime;
  const current = () => store.getState().site === site && store.getState().archiveTime === at;
  const fresh = store.getState().availabilityState !== "ready";
  if (fresh) store.setState({ availabilityState: "loading" });
  let full = false;
  if (fresh) {
    // Nothing known about this radar: its Level III tilts first, in well under
    // a second, and Level II's when that check finishes.
    void fetchSiteAvailability(site, true, at)
      .then((quick) => {
        if (!full && current()) applyAvailability(quick);
      })
      .catch(() => undefined);
  }
  void fetchSiteAvailability(site, false, at)
    .then((avail) => {
      full = true;
      if (at === null) rememberAvailability(site, avail);
      if (!current()) return;
      // Unchanged since what is on screen: nothing to redo.
      const shown = store.getState().availability;
      if (shown && JSON.stringify(shown.families) === JSON.stringify(avail.families)) {
        store.setState({ availability: avail, availabilityState: "ready" });
        return;
      }
      applyAvailability(avail);
    })
    .catch(() => {
      if (!current()) return;
      // Unknown is not "none": keep what is known, or the catalogue's list.
      if (store.getState().availabilityState !== "ready") store.setState({ availabilityState: "failed" });
    });
}

/** Returns whether it moved a pane to another tilt or product -- which loads
 *  that pane's scan, so the caller need not. */
function applyAvailability(avail: SiteAvailability | null): boolean {
  const store = useNexradStore;
  const before = store.getState();
  const grids = withAvailability(before.baseGrids, avail);
  store.setState({ availability: avail, grids, availabilityState: avail ? "ready" : "idle" });
  // Nothing moves on a partial answer: a tilt missing from it may be a Level II
  // one (0.3, or velocity at 2.4) the full answer is about to confirm.
  if (!avail || avail.level2Pending) return false;

  const nearest = (family: string, tilt: string | null): string | null | undefined => {
    const fam = grids.find((f) => f.id === family);
    if (!fam || fam.unavailable || fam.tilts.some((t) => t.tilt === tilt)) return undefined; // nothing to move
    const was = [...before.grids, ...before.baseGrids].find((f) => f.id === family)?.tilts.find((t) => t.tilt === tilt)?.elev;
    if (was == null) return fam.tilts[0]?.tilt ?? null;
    return [...fam.tilts].sort((a, b) => Math.abs((a.elev ?? 0) - was) - Math.abs((b.elev ?? 0) - was))[0]?.tilt ?? null;
  };
  // A product this radar is not publishing (Level II at a radar abroad): back
  // to reflectivity rather than a map that stays empty.
  const fallback = (family: string) =>
    grids.find((f) => f.id === family)?.unavailable
      ? (grids.find((f) => f.id === "B" && !f.unavailable) ?? grids.find((f) => !f.unavailable))?.id
      : undefined;
  const now = store.getState();
  for (const [id, pane] of Object.entries(now.paneRadar)) {
    if (id === getActivePaneId()) continue;
    const other = fallback(pane.family);
    if (other) now.setPaneFamily(id, other);
    else if (nearest(pane.family, pane.tilt) !== undefined) now.setPaneFamily(id, pane.family);
  }
  const other = fallback(now.family);
  if (other) {
    now.setFamily(other);
    return true;
  }
  const moveTo = nearest(now.family, now.tilt);
  if (moveTo !== undefined && moveTo !== null && wireCode(grids.find((f) => f.id === now.family)!, moveTo) !== now.product) {
    now.setTilt(moveTo);
    return true;
  }
  return false;
}

export const useNexradStore = create<NexradState>((set, get) => ({
  sites: [],
  products: [],
  catalog: [],
  grids: [],
  baseGrids: [],
  availability: null,
  availabilityState: "idle",
  paneRadar: {},
  palettes: [],
  archiveStart: "2022-03-01",
  site: null,
  product: "N0B",
  family: "B",
  tilt: "0",
  frames: DEFAULT_FRAMES,
  archiveTime: null,
  archiveDate: null,
  dayLoad: null,
  showRing: true,
  storms: null,
  showTracks: true,
  selectedCellId: null,
  smooth: false,
  threshold: null,
  showReadout: true,
  autoUpdate: true,
  scans: [],
  index: 0,
  palTables: {},
  kindDefaults: {},
  scan: null,
  mesh: null,
  meshRev: 0,
  colorRev: 0,
  warm: 0,
  loading: false,
  error: null,

  loadCatalog: async () => {
    if (get().sites.length && get().products.length) return;
    if (catalogInFlight) {
      await catalogInFlight;
      return;
    }

    catalogInFlight = (async () => {
      // The packaged app can race its own backend during startup, and the
      // backend can also go away mid-session. Retrying just once left the
      // catalog permanently empty on failure -- the panel showed
      // "Radar site (0)" with no route back short of restarting the app -- so
      // back off and keep trying for a few seconds before giving up.
      const backoffMs = [0, 800, 2500, 6000];
      let lastMessage = "";
      for (const wait of backoffMs) {
        if (wait) await new Promise((resolve) => window.setTimeout(resolve, wait));
        try {
          const [sites, meta, pals] = await Promise.all([
            fetchNexradSites(),
            fetchNexradMeta(),
            fetchPaletteTables(),
          ]);
          // Resolve the wire code from the freshly-loaded catalog rather than
          // trusting the bootstrap default: the catalog decides the source, so a
          // hardcoded "N0B" would silently pin reflectivity to Level III.
          const grids = meta.grids ?? [];
          const pool = [...grids, ...meta.catalog];
          const fam = pool.find((f) => f.id === get().family) ?? pool[0];
          const resolved = fam ? wireCode(fam, get().tilt) : null;
          set({
            sites,
            products: meta.products,
            catalog: meta.catalog,
            grids: withAvailability(grids, get().availability),
            baseGrids: grids,
            palettes: meta.palettes,
            palTables: pals.palettes,
            kindDefaults: pals.kindDefaults,
            family: fam?.id ?? get().family,
            product: resolved ?? get().product ?? meta.defaultProduct,
            frames: clampFrames(resolved ?? get().product, get().frames),
            error: null,
          });
          return;
        } catch (err) {
          lastMessage = err instanceof Error ? err.message : String(err);
        }
      }
      set({ error: `Radar catalog unavailable: ${lastMessage}` });
    })();

    try {
      await catalogInFlight;
    } finally {
      catalogInFlight = null;
    }
  },

  selectSite: (site) => {
    const current = get().site;
    if (site === current) return;
    if (site) {
      const candidate = get().sites.find((s) => s.id === site);
      if (candidate?.online === false) return;
    }
    // A different site shares nothing with the cached meshes; free them so the
    // budget isn't spent holding geometry for a radar no longer on screen.
    clearMeshCache();
    lastStormKey = null;
    set({
      site, scan: null, mesh: null, meshRev: get().meshRev + 1, scans: [], index: 0,
      error: null, storms: null, selectedCellId: null,
    });
    if (availabilityTimer != null) window.clearInterval(availabilityTimer);
    availabilityTimer = null;
    if (site) {
      // What this radar was flying last time, if it has been seen: its buttons
      // show now, and the check below corrects them if the VCP changed.
      const known = get().archiveTime === null ? (knownAvailability.get(site) ?? null) : null;
      let moved = applyAvailability(known);
      // A low cut is the one tilt most radars do not have: with nothing known,
      // leave it rather than fetch a Level II volume that may not exist.
      if (!known && get().tilt === "L") {
        get().setTilt("0");
        moved = true;
      }
      // Moving the tilt already loads the scan; loading it again here was a
      // second fetch of every frame on every radar switch.
      if (!moved) void get().refresh();
      void get().loadStorms();
      checkAvailability(site);
      availabilityTimer = window.setInterval(() => {
        if (get().site === site) checkAvailability(site);
      }, AVAILABILITY_REFRESH_MS);
    }
    else {
      applyAvailability(null);
      controller?.abort();
      controller = null;
    }
  },

  setProduct: (product) => {
    if (product === get().product) return;
    const fam = get().catalog.find((f) => f.tilts.some((t) => t.code === product));
    set({
      product,
      family: fam?.id ?? get().family,
      error: null,
      scan: null,
      mesh: null,
      meshRev: get().meshRev + 1,
    });
    if (get().site) void get().refresh();
  },

  // Switching moment keeps the elevation when the new one is cut at it -- going
  // reflectivity -> velocity at 1.3 should stay at 1.3, not snap back to 0.5.
  // The tilt is held as its own state, NOT reverse-engineered from the product
  // code: Level II codes (L2C0) don't match the Level III ones (N0C), so
  // deriving it broke every switch once super-res existed.
  setFamily: (family) => {
    if (family === get().family) return;
    const fam = allFamilies(get()).find((f) => f.id === family);
    if (!fam) return;
    const keep = fam.tilts.find((t) => t.tilt === get().tilt);
    const slot = (keep ?? fam.tilts[0])?.tilt ?? null;
    const next = wireCode(fam, slot);
    if (!next) return;
    set({
      family,
      tilt: slot,
      product: next,
      frames: clampFrames(next, get().frames),
      archiveDate: keepDay(next, get().archiveDate),
      error: null,
      scan: null,
      mesh: null,
      meshRev: get().meshRev + 1,
      // The focused pane is what the top-right picker is aiming at; the layer
      // draws paneRadar, so without this the pane keeps its old product.
      paneRadar: withFocusedPane(get(), { family, tilt: slot, product: next }),
    });
    if (get().site) void get().refresh();
  },

  setTilt: (tilt) => {
    const fam = allFamilies(get()).find((f) => f.id === get().family);
    if (!fam) return;
    const next = wireCode(fam, tilt);
    if (!next || next === get().product) return;
    set({
      tilt,
      product: next,
      frames: clampFrames(next, get().frames),
      archiveDate: keepDay(next, get().archiveDate),
      error: null,
      scan: null,
      mesh: null,
      meshRev: get().meshRev + 1,
      paneRadar: withFocusedPane(get(), { tilt, product: next }),
    });
    if (get().site) void get().refresh();
  },

  // Palette override changed: recolour in place. No refetch, no new geometry --
  // the whole point of colouring client-side.
  repaint: () => {
    const { mesh, scan } = get();
    if (!mesh || !scan) return;
    const pal = get().resolvePal(scan.meta.kind);
    if (!pal) return;
    // recolor mutates this mesh in place -- but it is a reference held by the
    // mesh cache under the OLD palette's key, so leaving it there would hand a
    // recoloured mesh back for the old palette later. Drop the cache; the next
    // view rebuilds cleanly under the new palette's key.
    clearMeshCache();
    recolor(mesh, pal);
    set({ colorRev: get().colorRev + 1 });
  },

  /** The .pal text for a product kind: the built-in, unless the user replaced it. */
  resolvePal: (kind) => {
    const pid = get().paletteIdFor(kind);
    const { overrides, custom } = usePaletteStore.getState();
    const mine = overrides[pid];
    if (mine) {
      const hit = custom.find((p) => p.id === mine);
      if (hit) return hit.pal;
    }
    return get().palTables[pid]?.pal ?? null;
  },

  /** Which built-in palette a product kind maps to. */
  paletteIdFor: (kind) => get().kindDefaults[kind] ?? "REF",

  setFrames: (frames) => {
    const clamped = clampFrames(get().product, frames);
    if (clamped === get().frames) return;
    set({ frames: clamped, error: null });
    if (get().site) void get().refresh();
  },

  // Whole-day playback. Unlike the live loop this pulls EVERY scan of the day
  // (~400) and warms them all before handing over, because the point is to
  // scrub/play a finished day without stalling on each frame.
  setArchiveDate: async (archiveDate) => {
    const { site, product } = get();
    dayToken += 1;
    const mine = dayToken;

    if (archiveDate === null) {
      set({ archiveDate: null, dayLoad: null });
      if (site) void get().refresh();
      return;
    }

    get().stopAutoRefresh();
    // Re-loading the SAME day (a product or tilt change) must keep the frame the
    // user is looking at; only a different day starts over at midnight.
    const sameDay = get().archiveDate === archiveDate;
    const held = sameDay ? get().index : 0;
    set({ archiveDate, archiveTime: null, error: null, dayLoad: { done: 0, total: 0 }, index: held });
    if (!site) return;

    try {
      resetPaneLists(archiveDate, 0, 0);
      const res = await fetchNexradScans(site, product, archiveDate, 0);
      if (mine !== dayToken) return; // superseded or cancelled
      const scans = res.scans;
      if (!scans.length) {
        set({ dayLoad: null, error: `No scans archived for ${archiveDate}.` });
        return;
      }
      // Times line up between products, so the same index is the same moment.
      const keep = Math.min(held, scans.length - 1);
      set({ scans, index: keep, warm: 0, dayLoad: { done: 0, total: scans.length } });

      // Warm every frame, a few at a time, so play is instant afterwards.
      let next = 0;
      let done = 0;
      const pump = async (): Promise<void> => {
        while (next < scans.length) {
          if (mine !== dayToken) return;
          const key = scans[next++].key;
          try {
            await loadScan(site, product, key);
          } catch {
            /* a bad frame just costs itself when displayed */
          }
          done += 1;
          if (mine === dayToken) set({ dayLoad: { done, total: scans.length } });
        }
      };
      await Promise.all(Array.from({ length: WARM_CONCURRENCY }, pump));
      if (mine !== dayToken) return;
      set({ dayLoad: null, warm: get().countWarm() });
      await get().showIndex(get().index);
    } catch (err) {
      if (mine !== dayToken) return;
      set({ dayLoad: null, error: err instanceof Error ? err.message : String(err) });
    }
  },

  // Abandon a day load; whatever already cached stays cached.
  cancelDayLoad: () => {
    dayToken += 1;
    set({ dayLoad: null, archiveDate: null });
    if (get().site) void get().refresh();
  },

  addPane: (id) => {
    if (get().paneRadar[id]) return;
    const { product, family, tilt } = get();
    set({
      paneRadar: {
        ...get().paneRadar,
        // a new pane opens on whatever the focused one is showing
        [id]: { product, family, tilt, scan: null, mesh: null, meshRev: 0 },
      },
    });
    if (get().site) void get().showIndex(get().index);
  },

  dropPane: (id) => {
    const paneRadar = { ...get().paneRadar };
    delete paneRadar[id];
    set({ paneRadar });
  },

  setPaneFamily: (id, family) => {
    const pane = get().paneRadar[id];
    const fam = allFamilies(get()).find((f) => f.id === family);
    if (!pane || !fam) return;
    const keep = fam.tilts.find((t) => t.tilt === pane.tilt);
    const slot = (keep ?? fam.tilts[0])?.tilt ?? null;
    const code = wireCode(fam, slot);
    if (!code) return;
    set({
      paneRadar: {
        ...get().paneRadar,
        [id]: { ...pane, family, tilt: slot, product: code, scan: null, mesh: null,
                meshRev: pane.meshRev + 1 },
      },
    });
    // the focused pane also drives the panel / colour bar / readout
    if (id === getActivePaneId()) set({ family, tilt: slot, product: code });
    if (get().site) void get().showIndex(get().index);
  },

  focusPane: (id) => {
    const pane = get().paneRadar[id];
    if (!pane) return;
    set({
      family: pane.family,
      tilt: pane.tilt,
      product: pane.product,
      scan: pane.scan,
      mesh: pane.mesh,
      meshRev: get().meshRev + 1,
    });
  },


  setShowRing: (showRing) => set({ showRing }),
  setShowReadout: (showReadout) => set({ showReadout }),
  setShowTracks: (showTracks) => {
    set({ showTracks, selectedCellId: showTracks ? get().selectedCellId : null });
    if (showTracks && !get().storms) void get().loadStorms();
  },
  selectCell: (selectedCellId) => set({ selectedCellId }),

  // Storm attributes follow the frame on screen. The backend picks the storm
  // scan nearest the requested instant, so playback shows each volume's own
  // cells and tracks instead of pinning "now" over a scrubbed-back loop.
  loadStorms: async () => {
    const { site, showTracks, scans, index } = get();
    if (!site || !showTracks) return;
    const k = stormKeyFor(site, scans[index]?.time ?? null);
    // Already showing this one -- frames inside a single volume all land here.
    if (lastStormKey === k && get().storms) return;

    const apply = (report: StormReport) => {
      // The playhead may have moved on while this was in flight. A late answer
      // for a frame nobody is looking at must not overwrite the one they are.
      const cur = get();
      if (!cur.site || stormKeyFor(cur.site, cur.scans[cur.index]?.time ?? null) !== k) return;
      lastStormKey = k;
      const stillThere = report.cells.some((c) => c.id === cur.selectedCellId);
      set({ storms: report, selectedCellId: stillThere ? cur.selectedCellId : null });
    };

    const cached = stormCache.get(k);
    if (cached) {
      apply(cached);
      return;
    }
    // Deliberately no abort and no clearing on failure: during playback the
    // tracks blinking off between volumes is worse than one frame's worth of
    // staleness, and the next frame's answer replaces them anyway.
    const report = await stormFor(site, scans[index]?.time ?? null);
    if (report) apply(report);
  },

  setSmooth: (smooth) => {
    if (smooth === get().smooth) return;
    // Every cached mesh was built with the old smoothing, so free them now
    // rather than let them age out while the new ones pile up beside them.
    clearMeshCache();
    set({ smooth });
    void get().showIndex(get().index);
  },

  setThreshold: (threshold) => {
    if (threshold === get().threshold) return;
    clearMeshCache();
    set({ threshold });
    void get().showIndex(get().index);
  },

  setAutoUpdate: (autoUpdate) => {
    if (autoUpdate === get().autoUpdate) return;
    set({ autoUpdate });
    if (autoUpdate && get().archiveTime === null && get().site) get().startAutoRefresh();
    else get().stopAutoRefresh();
  },

  // Archive playback. Live keeps polling for new scans; a pinned past window
  // must not, or the loop would yank itself back to the present.
  setArchiveTime: (archiveTime) => {
    if (archiveTime === get().archiveTime) return;
    set({ archiveTime, archiveDate: null, error: null, scan: null, mesh: null,
          meshRev: get().meshRev + 1, index: 0 });
    if (archiveTime !== null) get().stopAutoRefresh();
    const { site } = get();
    if (!site) return;
    // Another moment, other tilts: what the radar flew then, or back to what it
    // flies now. A tilt it did not have moves, and moving loads the scan.
    const moved = applyAvailability(archiveTime === null ? (knownAvailability.get(site) ?? null) : null);
    if (!moved) void get().refresh();
    checkAvailability(site);
  },

  // Load the scan list for the current site/product. Live opens on the newest
  // frame; archive playback opens on the OLDEST of the requested window, so
  // pressing play runs forward from the moment the calendar picked.
  loadScans: async () => {
    const { site, product, frames, archiveTime } = get();
    if (!site) return;
    try {
      resetPaneLists("", frames, archiveTime ?? 0);
      const res = await fetchNexradScans(site, product, "", frames, archiveTime ?? 0);
      set({
        scans: res.scans,
        archiveStart: res.archiveStart,
        index: archiveTime !== null ? 0 : Math.max(0, res.scans.length - 1),
        warm: 0,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), scans: [] });
    }
  },

  // Pull the whole scan list into the cache in the background, nearest-first
  // from `from`, so play/scrub is local instead of paying ~450 ms per frame.
  // Fire-and-forget: a failed frame just pays for itself when displayed.
  prefetch: (from) => {
    const { site, product, scans } = get();
    if (!site || !scans.length) return;
    const token = ++warmToken; // a new site/product/date supersedes this pass

    // nearest-first, forward-biased: playback usually runs forward from here
    const order = scans
      .map((s, i) => ({ key: s.key, d: i < from ? (from - i) * 2 : i - from }))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.key);

    let next = 0;
    const pump = async (): Promise<void> => {
      while (next < order.length) {
        if (token !== warmToken) return; // superseded
        const key = order[next++];
        if (scanCache.has(scanId(site, product, key))) continue;
        try {
          await loadScan(site, product, key);
        } catch {
          /* skip -- it'll retry if displayed */
        }
        if (token === warmToken) set({ warm: get().countWarm() });
      }
    };
    for (let i = 0; i < WARM_CONCURRENCY; i++) void pump();

    // Warm the storm scans just ahead of the playhead too, so pressing play
    // reads them out of the cache instead of waiting on a round trip at every
    // step. Many frames resolve to the same volume, which the backend caches,
    // so this is cheap after the first pass over a stretch of the loop.
    if (get().showTracks) {
      const ahead = scans.slice(from, from + STORM_WARM_AHEAD);
      let at = 0;
      const pumpStorms = async (): Promise<void> => {
        while (at < ahead.length) {
          if (token !== warmToken) return;
          const frame = ahead[at++];
          await stormFor(site, frame.time ?? null);
        }
      };
      for (let i = 0; i < STORM_WARM_CONCURRENCY; i++) void pumpStorms();
    }

    set({ warm: get().countWarm() });
  },

  countWarm: () => {
    const { site, product, scans } = get();
    if (!site) return 0;
    return scans.reduce((n, s) => n + (scanCache.has(scanId(site, product, s.key)) ? 1 : 0), 0);
  },

  // Show one scan by index, committing only once its mesh is ready.
  // Move EVERY pane to the same frame. Panes differ only by product, so one
  // scrub keeps them all on the same instant -- which is the point of split
  // screen. Panes load in parallel and share `scanCache` when products match.
  showIndex: async (i) => {
    const { site, product, scans, paneRadar } = get();
    if (!site) return false;
    const idx = Math.max(0, Math.min(i, Math.max(scans.length - 1, 0)));
    const key = scans[idx]?.key ?? "";
    controller?.abort();
    controller = new AbortController();
    const mine = controller;

    // A cached scan still needs its mesh built (~100 ms), but no spinner: the
    // swap is fast enough that flashing "loading" just looks like a glitch.
    const cached = scanCache.has(scanId(site, product, key));
    if (!cached) set({ loading: true, error: null });

    const build = async (prod: string) => {
      const k = await paneKey(site, prod, product, scans[idx]);
      const scan = await loadScan(site, prod, k);
      const pal = get().resolvePal(scan.meta.kind);
      if (!pal) throw new Error("palette tables not loaded");
      const mesh = getMesh(scanId(site, prod, k), scan, pal, get().smooth, get().threshold);
      return { scan, mesh };
    };

    try {
      const ids = Object.keys(paneRadar);
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            return [id, await build(paneRadar[id].product)] as const;
          } catch {
            return [id, null] as const; // one pane failing must not blank the rest
          }
        }),
      );
      // the focused pane's product also drives the top-level view
      const focusId = getActivePaneId();
      const focused = results.find(([id]) => id === focusId)?.[1];
      const own = focused ?? (await build(product));
      if (mine.signal.aborted) return false;

      const nextPanes = { ...get().paneRadar };
      for (const [id, r] of results) {
        if (!r || !nextPanes[id]) continue;
        nextPanes[id] = { ...nextPanes[id], scan: r.scan, mesh: r.mesh,
                          meshRev: nextPanes[id].meshRev + 1 };
      }
      set({
        paneRadar: nextPanes,
        scan: own.scan,
        mesh: own.mesh,
        index: idx,
        loading: false,
        error: null,
        meshRev: get().meshRev + 1,
      });
      // Storm attributes belong to the frame on screen, not to "now": scrubbing
      // back has to bring back the tracks that existed then, or the forecast
      // track points at a storm that has already moved on.
      void get().loadStorms();
      get().prefetch(idx);
      return true;
    } catch (err) {
      if (mine.signal.aborted) return false;
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
      return false;
    }
  },

  refresh: async () => {
    if (!get().site) return;
    // A pinned day owns the scan list. Without this, changing product (or tilt)
    // fell through to the live list and silently threw the loaded day away --
    // which is what "I keep losing the scans when I switch product" was.
    const { archiveDate } = get();
    if (archiveDate) {
      await get().setArchiveDate(archiveDate);
      return;
    }
    set({ loading: true });
    await get().loadScans();
    await get().showIndex(get().index);
    if (get().archiveTime === null) get().startAutoRefresh();
  },

  // Poll for a newer scan and slide onto it -- but only if the user is already
  // parked on the latest frame, so scrubbing back isn't yanked.
  startAutoRefresh: () => {
    get().stopAutoRefresh();
    pollTimer = window.setInterval(async () => {
      const { site, product, frames, scans, index, loading, archiveTime } = get();
      if (!site || loading || archiveTime !== null || get().archiveDate || !get().autoUpdate) return;
      try {
        const res = await fetchNexradScans(site, product, "", frames);
        const newest = res.scans[res.scans.length - 1];
        const current = scans[scans.length - 1];
        if (!newest || newest.key === current?.key) return;
        const wasAtLatest = index >= scans.length - 1;
        // A new volume landed, so the other products have a new scan too: drop
        // the cached pane lists or they can never resolve this frame.
        resetPaneLists("", frames, 0);
        set({ scans: res.scans });
        if (wasAtLatest) void get().showIndex(res.scans.length - 1);
        // A new volume also means new storm attributes.
        void get().loadStorms();
      } catch {
        /* transient -> try again next tick */
      }
    }, POLL_MS);
  },

  stopAutoRefresh: () => {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  },

  clear: () => {
    controller?.abort();
    controller = null;
    lastStormKey = null;
    get().stopAutoRefresh();
    clearMeshCache();
    set({
      storms: null,
      selectedCellId: null,
      site: null,
      scan: null,
      mesh: null,
      meshRev: get().meshRev + 1,
      scans: [],
      index: 0,
      error: null,
      loading: false,
    });
  },
}));
