import { isBrazilSite, isEuropeSite } from "../lib/brazilRadar";
import { create } from "zustand";

import {
  fetchNexradMeta,
  fetchNexradScans,
  fetchNexradSites,
  fetchNexradStorms,
  fetchPaletteTables,
  fetchScanData,
  fetchSiteAvailability,
  catalogueAvailability,
  isTdwrCode,
  tdwrAvailability,
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
import { decodeScan, recolor, type PolarScan, type RadarMesh } from "../lib/radarMesh";
import { buildMeshOffThread } from "../lib/radarMeshPool";
import { rangeFoldedPal, wireOptions } from "../lib/radarOptions";
import { composeFrames, composeLive, repKey, substituteTilt } from "../lib/radarFrames";
import { dropRetries, frameFailed, frameOk, frameState, noteFrameBytes, setFrameState } from "../lib/radarFrameStatus";
import { getSetting } from "../settings/useSettingsStore";
import { resolveTableText } from "../lib/colorTables";
// Frames panel + connection (frames-conn): live-check times, background/offline skips.
import { noteLiveCheck } from "./useFramesStore";
import { connectionDown, onReconnect } from "./useConnectionStore";
import { backgroundAllows } from "../lib/appActivity";
// Display options (display-opts): gate filter + maximum value trail per pane.
import { displayScan } from "../lib/radarDisplay";
import { trailOn } from "./useRadarDisplayStore";
import { usePaneStore } from "./usePaneStore";

// Single-site NEXRAD Level III radar. `date` picks a UTC day from the archive
// (which starts ~2022-03); "" means today/live. `scans` is that day's scan list
// (thinned) and doubles as the global timeline's time axis, so the radar frames
// can be scrubbed and animated.

let controller: AbortController | null = null;
/** panes-layout: the request of each pane on its own scrubber. */
const paneCtl = new Map<string, AbortController>();
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

/** panes-layout: the storm report of another frame than the loop's (a pane
 *  on its own scrubber) -- the cached one now, else null and fetched. */
export function stormReportAt(site: string, unix: number | null, then: () => void): StormReport | null {
  const hit = stormCache.get(stormKeyFor(site, unix));
  if (hit) return hit;
  void stormFor(site, unix).then((r) => r && then());
  return null;
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
/** How many Level II frames around the playhead are loaded ahead: a whole day
 *  is ~300 volumes, more than the scan cache keeps (archive-l2). */
const L2_WARM_MAX = 130;

/** Loop lengths, in minutes: the loop is a span of time (NUXRAD parity). */
export const LOOP_MINUTES = [30, 60, 120, 240, 480] as const;
export const DEFAULT_LOOP_MINUTES = 60;

/** The loop lengths a product can actually serve. */
export function frameChoicesFor(product: string): readonly number[] {
  return product.startsWith("L2") ? L2_FRAME_CHOICES : FRAME_CHOICES;
}

/** Clamp a loop length to what the product can serve. */
function clampFrames(product: string, frames: number): number {
  return product.startsWith("L2") ? Math.min(frames, L2_MAX_FRAMES) : frames;
}

/**
 * A pinned day survives a switch between Level III and Level II (archive-l2):
 * Level II's day comes out of the whole archive (back to 1991), its frames
 * load from the one on screen outward instead of all before play, so the day
 * is kept rather than dropped.
 */
function keepDay(_product: string, archiveDate: string | null): string | null {
  return archiveDate;
}

/** The day Level III's archive begins (nexrad_core.ARCHIVE_START): before it a
 *  day's frames are Level II's only. */
const LEVEL3_FIRST_DAY = "2022-03-01";

/** Whether `t` falls in one of the picked stretches of a day ([start, end) unix). */
function inPick(t: number, pick: Array<[number, number]>): boolean {
  return pick.some(([a, b]) => t >= a && t < b);
}

/** The instant archive playback stands at, for what the radar flew then: the
 *  window's start, or the day's first picked volume (else its noon). Stable
 *  while the frame moves, so a tilt check is not redone on every step. */
function archiveAnchor(s: { archiveTime: number | null; archiveDate: string | null; archivePick: Array<[number, number]> | null }): number | null {
  if (s.archiveTime !== null) return s.archiveTime;
  if (!s.archiveDate) return null;
  if (s.archivePick?.length) return s.archivePick[0][0];
  const [y, m, d] = s.archiveDate.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12) / 1000;
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
const WARM_CONCURRENCY_DERIVED = 2;
let warmToken = 0;
/** Stop the frames being warmed in the background (their option or product
 *  changed): only the requests already out finish. */
export function stopWarming(): void {
  warmToken++;
}
// The background (warm) requests still out, by scan id. A product or radar
// change cancels them: a cold derived product's frame on screen waited 18-23 s
// behind the last product's window of heavy requests (5 at a time).
const warmCtl = new Map<string, AbortController>();
function abortWarm(): void {
  for (const c of warmCtl.values()) c.abort();
  warmCtl.clear();
}
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
let listParams: { date: string; limit: number; start: number; minutes: number } = { date: "", limit: 0, start: 0, minutes: 0 };

function resetPaneLists(date: string, limit: number, start: number, minutes = 0): void {
  paneLists.clear();
  paneListInflight.clear();
  paneListFailed.clear();
  listParams = { date, limit, start, minutes };
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

  const p = fetchNexradScans(site, product, listParams.date, listParams.limit, listParams.start, listParams.minutes)
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

const meshKeyOf = (scanKey: string, pal: string, smooth: boolean, threshold: number | null) =>
  `${scanKey}|${smooth ? 1 : 0}|${threshold ?? ""}|${palHash(pal)}`;
/** Meshes being built, so a frame asked for while the warm-up builds it waits
 *  for that build instead of starting another. */
const meshInflight = new Map<string, Promise<RadarMesh>>();

/** Build a mesh -- on a worker -- or hand back the one already built for this
 *  exact frame+look. */
export function getMesh(
  scanKey: string,
  scan: PolarScan,
  pal: string,
  smooth: boolean,
  threshold: number | null,
): Promise<RadarMesh> {
  const key = meshKeyOf(scanKey, pal, smooth, threshold);
  const hit = meshCache.get(key);
  if (hit) {
    // Refresh recency: delete + re-set moves it to the end of the Map's order.
    meshCache.delete(key);
    meshCache.set(key, hit);
    return Promise.resolve(hit);
  }
  const pending = meshInflight.get(key);
  if (pending) return pending;
  setFrameState(scanKey, "decode");
  const p = buildMeshOffThread(scan, pal, { smooth, threshold })
    .then((mesh) => {
      setFrameState(scanKey, "ready");
      // A tilt the radar has not reached yet is an empty stand-in under the
      // frame's own key: kept, it was handed back once the tilt came in and
      // the in-progress frame stayed blank.
      if (scan.meta.pending) return mesh;
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
    })
    .finally(() => {
      meshInflight.delete(key);
      if (frameState(scanKey) === "decode") setFrameState(scanKey, "ready");
    });
  meshInflight.set(key, p);
  return p;
}

/** How many scans from the playhead on the warm-up builds meshes for. Few: a
 *  super-res reflectivity mesh with wide echoes is ~38 MB (96 bytes a gate), so
 *  the 220 MB cache holds five or six -- building twelve ahead threw out the
 *  first ones before they were shown. The workers keep this many ahead of a
 *  play at any speed the setting allows. */
const MESH_AHEAD = 4;

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
export async function paneKey(
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
  // The volume being written and a tilt's later scans (radarFrames.ts) are the
  // same frame for every per-tilt Level II moment; a whole-volume product
  // (CREF, ET, VIL) takes the nearest whole volume below.
  if (/^L2P:|:c\d+$/.test(frame.key) && product.startsWith("L2") && !/^L2(CREF|ET|VIL|DVIL)/.test(product)) {
    return frame.key;
  }

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

/**
 * "Add radar" (archive-l2): the key a pane on ANOTHER radar than the frame's
 * shows -- that radar's newest scan at or before the frame's time (30 s of
 * slack for clocks), or its first one when the frame is earlier than all.
 * `own` is the loop's own frames, used when the pane is the loop's radar on
 * the loop's product (no list to fetch).
 */
async function latestKey(site: string, product: string, frame: NexradScan | undefined, own: NexradScan[] | null): Promise<string> {
  if (!frame) return "";
  const list = own ?? (await paneList(site, product));
  if (!list.length) {
    const icao = useNexradStore.getState().sites.find((x) => x.id === site)?.icao ?? site;
    throw new Error(`${icao} has no scans in this stretch`);
  }
  let best: NexradScan | null = null;
  for (const s of list) if (s.time <= frame.time + 30 && (!best || s.time > best.time)) best = s;
  return (best ?? list[0]).key;
}

/** Radars added to the loop: each pane with its own site, once per site+product. */
function extraRadars(s: { site: string | null; paneRadar: Record<string, PaneRadar> }): Array<{ site: string; product: string }> {
  const seen = new Set<string>();
  const out: Array<{ site: string; product: string }> = [];
  for (const p of Object.values(s.paneRadar)) {
    if (!p.site || p.site === s.site) continue;
    const k = `${p.site}|${p.product}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ site: p.site, product: p.product });
  }
  return out;
}

/**
 * The loop's own frames with the added radars' scans over the same stretch
 * joined in, by time. A list not here yet is fetched and merged when it lands
 * (remergeScans), so the loop's own frames never wait on another radar.
 */
function mergeExtras(main: NexradScan[]): NexradScan[] {
  const s = useNexradStore.getState();
  const extras = extraRadars(s);
  if (!extras.length || !main.length) return main;
  const lo = main[0].time - 120;
  const hi = main[main.length - 1].time + 300;
  // A pick of a day: only the picked stretches (a few minutes of slack).
  const pick = s.archiveDate ? s.archivePick : null;
  const picked = (t: number) => !pick || pick.some(([a, b]) => t >= a - 150 && t < b + 150);
  const out = [...main];
  for (const x of extras) {
    const id = `${x.site}|${x.product}`;
    const list = paneLists.get(id);
    if (!list) {
      void paneList(x.site, x.product).then(() => {
        if (paneLists.has(id)) remergeScans();
      });
      continue;
    }
    for (const f of list) {
      if (f.time >= lo && f.time <= hi && picked(f.time)) out.push({ key: f.key, time: f.time, site: x.site, product: x.product });
    }
  }
  return out.sort((a, b) => a.time - b.time || (a.site ? 1 : 0) - (b.site ? 1 : 0));
}

/** Join (or drop) the added radars' frames into the loop on screen, keeping
 *  the frame shown. Returns whether the loop changed (and was shown again). */
export function remergeScans(): boolean {
  const s = useNexradStore.getState();
  if (!s.site) return false;
  const main = s.scans.filter((f) => !f.site);
  const next = mergeExtras(main);
  const cur = s.scans[s.index];
  if (next.length === s.scans.length && next.every((f, i) => f.key === s.scans[i].key && f.site === s.scans[i].site)) return false;
  let index = next.findIndex((f) => f.key === cur?.key && f.site === cur?.site);
  if (index < 0) index = nearestScan(next, cur?.time ?? null);
  useNexradStore.setState({ scans: next, index: Math.max(0, index) });
  void useNexradStore.getState().showIndex(Math.max(0, index));
  return true;
}

/** Panes about to open with a radar of their own (Add radar grew the layout),
 *  by pane id. Kept a few seconds, and put back when the pane is dropped in
 *  that time: React's dev double-mount drops and re-adds every new pane. */
const pendingPaneRadars = new Map<string, { site: string; at: number }>();
const PENDING_PANE_MS = 5000;

/** Apply a product change to the focused pane's slot. The top-level fields are
 *  the focused pane's mirror, so the two must move together or the picker and
 *  the pixels disagree. */
function withFocusedPane(
  s: { paneRadar: Record<string, PaneRadar> },
  patch: Partial<Pick<PaneRadar, "family" | "tilt" | "product">>,
): Record<string, PaneRadar> {
  // At start-up the map's pane is registered before it is marked active: a
  // restored Level II product then never reached the lone pane (it kept N0B).
  const ids = Object.keys(s.paneRadar);
  const id = getActivePaneId() ?? (ids.length === 1 ? ids[0] : null);
  const pane = id ? s.paneRadar[id] : undefined;
  if (!id || !pane) return s.paneRadar;
  return { ...s.paneRadar, [id]: { ...pane, ...patch, empty: false, scan: null, mesh: null, meshRev: pane.meshRev + 1 } };
}

/** Every family across both grids (plus the legacy flat catalog). */
function allFamilies(s: { grids: ProductGrids; catalog: ProductFamily[] }): ProductFamily[] {
  return [...s.grids, ...s.catalog];
}

/** Cache identity for a frame -- see loadScan for why product is part of it. */
export const scanId = (site: string, product: string, key: string) => `${site}|${wireOptions(site, product)}|${key}`;

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
export function loadScan(site: string, product: string, key: string, warm = false): Promise<PolarScan> {
  const id = scanId(site, product, key);
  const hit = scanCache.get(id);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(id);
  if (pending) {
    // Someone is waiting on this one now: it is no longer a background
    // request that a product change may cancel.
    if (!warm) warmCtl.delete(id);
    return pending;
  }
  // Dealias / storm-motion choices ride on the code (radarOptions.ts).
  // Each step is marked for the loop's status line (radarFrameStatus.ts).
  setFrameState(id, "down");
  const ctl = warm ? new AbortController() : null;
  if (ctl) warmCtl.set(id, ctl);
  const p = fetchScanData(site, wireOptions(site, product), key, ctl?.signal)
    .then(async (buf) => {
      setFrameState(id, "decode");
      noteFrameBytes(id, buf.byteLength);
      const scan = decodeScan(buf);
      cacheScan(id, scan);
      setFrameState(id, "ready");
      frameOk(id);
      return scan;
    })
    .catch((err: unknown) => {
      if (ctl?.signal.aborted) {
        // A background request cancelled by a product or radar change.
        setFrameState(id, "idle");
        throw err;
      }
      if ((err as { status?: number } | null)?.status === 400) {
        // Refused (a moment a TDWR does not have): the frame is fine, and asking
        // again gets the same answer.
        setFrameState(id, "failed");
        throw err;
      }
      if ((err as { status?: number } | null)?.status === 422) {
        // A damaged file (the backend could fetch it but not read it): it
        // never gets better, so no retries -- it leaves the loop instead.
        setFrameState(id, "failed");
        markDamaged(site, key);
        throw err;
      }
      // Tried again after 1 min, 5 min and on reconnect -- while the frame is
      // still in the loop.
      frameFailed(id, () => {
        const s = useNexradStore.getState();
        if (!s.scans.some((f) => f.key === key && (f.site ?? s.site) === site)) return;
        loadScan(site, product, key)
          .then(() => useNexradStore.setState({ warm: useNexradStore.getState().countWarm() }))
          .catch(() => undefined);
      });
      throw err;
    })
    .finally(() => {
      inflight.delete(id);
      if (ctl && warmCtl.get(id) === ctl) warmCtl.delete(id);
    });
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
  /** "Add radar": this pane's own radar (site id); unset = the loop's radar. */
  site?: string | null;
  /** "Add radar": why the pane is empty -- its radar has nothing in the loop's
   *  window (most radars were not archived in the 1990s), or its scan failed. */
  note?: string | null;
  /** panes-layout: the product was taken off this pane ("Select product"). */
  empty?: boolean;
  /** panes-layout: "Follow the animation" off -- the frame time this pane
   *  shows on its own scrubber (unix s); unset = the timeline's frame. */
  ownTime?: number | null;
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
  /** The loop's span in minutes (LOOP_MINUTES); the live list and an archive
   *  window are cut to it. */
  loopMinutes: number;
  /** With "Expand SAILS cuts" off: which scan of the tilt the badge on the
   *  tilt button has picked (1 = the volume's first). */
  sailsRep: number;
  /** Archive playback: unix seconds the loop starts at, or null for live. */
  archiveTime: number | null;
  /** The instant archive playback should open on, when not its first frame
   *  (a storm report's time: the loop starts a little before it). */
  archiveFocus: number | null;
  /** Whole-day playback: "YYYY-MM-DD" (UTC), every scan of that day. */
  archiveDate: string | null;
  /** The stretches of that day picked in the Archive panel ([start, end) unix
   *  per volume ticked); null = the whole day. */
  archivePick: Array<[number, number]> | null;
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
  /** The site list again: a Brazilian radar comes online when a volume of it is imported. */
  reloadSites: () => Promise<void>;
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
  setLoopMinutes: (m: number) => void;
  setSailsRep: (rep: number) => void;
  /** Jump the loop to a past instant (null = back to live). */
  setArchiveTime: (t: number | null) => void;
  /** This radar, looping from shortly before `unix`, opened on the scan at it. */
  openAt: (site: string, unix: number) => void;
  /** Load an entire UTC day (or the picked stretches of it). A Level III day
   *  is warmed before playback; a Level II day or a pick shows its first scan
   *  at once and loads the rest from there. `pick` undefined keeps the pick
   *  when the day is the same. */
  setArchiveDate: (date: string | null, pick?: Array<[number, number]> | null) => Promise<void>;
  /** Give a pane its own radar (null = back to the loop's). */
  setPaneRadar: (id: string, site: string | null) => void;
  /** Pane `id` takes this radar, now or as it opens (Add radar grows the layout). */
  queuePaneRadar: (id: string, site: string) => void;
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
  /** Whether scan `i` of the list is already cached (shows without a fetch). */
  isWarmAt: (i: number) => boolean;
  /** Whether scan `i`'s mesh is built too (shows without a build). */
  isMeshedAt: (i: number) => boolean;
  /** Show frame `i`. With `only`, that one pane shows frame i on its own
   *  scrubber (Follow the animation off) and the loop is left alone. */
  showIndex: (i: number, only?: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  startAutoRefresh: () => void;
  stopAutoRefresh: () => void;
  clear: () => void;
}

/** How far before a storm report's time "radar at this time" starts its loop. */
const OPEN_AT_LEAD_S = 20 * 60;

/** The scan closest to `unix`, or the first when there is no instant to aim at. */
function nearestScan(scans: NexradScan[], unix: number | null): number {
  if (unix == null || scans.length === 0) return 0;
  let best = 0;
  for (let i = 1; i < scans.length; i++) {
    if (Math.abs((scans[i].time ?? 0) - unix) < Math.abs((scans[best].time ?? 0) - unix)) best = i;
  }
  return best;
}

/** The catalog load in flight, if any. The radar layer calls loadCatalog from
 *  every addTo, and the panel's retry button can fire while one is running, so
 *  they share a single attempt instead of stampeding the backend. */
let catalogInFlight: Promise<void> | null = null;

/** VCPs change with the weather -- precipitation to clear air drops the 0.9
 *  and 1.8 cuts -- so a selected radar is checked again this often. */
const AVAILABILITY_REFRESH_MS = 5 * 60_000;
let availabilityTimer: number | null = null;
/** radar-sites: may this radar open now? Set by radarSitesInstall (the stores
 *  would import each other otherwise); it shows a down radar's reasons itself. */
let siteGate: ((id: string) => boolean) | null = null;
export function setSiteGate(gate: ((id: string) => boolean) | null): void {
  siteGate = gate;
}

/** The radars offered: Settings > Features can take the airport radars out. */
let siteFilter: ((sites: NexradSite[]) => NexradSite[]) | null = null;
export function setSiteFilter(filter: ((sites: NexradSite[]) => NexradSite[]) | null): void {
  siteFilter = filter;
}
const offeredSites = (sites: NexradSite[]) => (siteFilter ? siteFilter(sites) : sites);

/** Whether a radar id is one of the FAA's airport radars. */
export function isTdwrId(id: string | null | undefined): boolean {
  return !!id && useNexradStore.getState().sites.some((s) => s.id === id && s.type === "TDWR");
}

/**
 * The site list is read again on a schedule after the first load. The Brazilian
 * radars a relay serves come from the backend's relay client, whose first pass
 * can finish after the app has already read the list -- read once, a slow or
 * cold relay left its radars out of the picker for the whole session, and a
 * radar that cannot be picked is never followed. Soon after start, then every
 * two minutes.
 */
const SITES_RELOAD_FIRST_MS = [4_000, 15_000, 45_000];
const SITES_RELOAD_EVERY_MS = 2 * 60_000;
let sitesTimer: number | null = null;

function scheduleSiteReloads(reload: () => Promise<void>): void {
  if (sitesTimer !== null) return;
  for (const ms of SITES_RELOAD_FIRST_MS) window.setTimeout(() => void reload(), ms);
  sitesTimer = window.setInterval(() => void reload(), SITES_RELOAD_EVERY_MS);
}

/**
 * Each radar's last known tilts, kept across restarts. A radar's VCP rarely
 * changes between visits, so the buttons show the moment it is picked and the
 * check that follows only corrects them if it did. The same goes for its list of
 * products, which is why a week: a radar seen before opens on its own list, not
 * on a wait.
 */
const AVAIL_KEY = "weatherts.radar.availability.v1";
const AVAIL_KEEP_MS = 7 * 24 * 3600_000;
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

/** How long the product list waits on a radar's answer. It can queue behind that
 *  radar's downloads for seconds, but one that never comes must not leave nothing
 *  to pick. */
const AVAILABILITY_WAIT_MS = 20_000;

/** No answer: unknown is not "none". What is known stays, and what was waiting
 *  on the answer is listed as the catalogue has it. */
function stopWaiting(): void {
  const { grids, availabilityState } = useNexradStore.getState();
  useNexradStore.setState({
    availabilityState: availabilityState === "ready" ? "ready" : "failed",
    ...(grids.some((f) => f.checking) ? { grids: grids.map((f) => (f.checking ? { ...f, checking: false } : f)) } : {}),
  });
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
  // A whole day (archive-l2) asks for its picked stretch, or its noon.
  const at = archiveAnchor(store.getState());
  const current = () => store.getState().site === site && archiveAnchor(store.getState()) === at;
  const fresh = store.getState().availabilityState !== "ready";
  if (fresh) store.setState({ availabilityState: "loading" });
  const waiting = window.setTimeout(() => {
    if (current()) stopWaiting();
  }, AVAILABILITY_WAIT_MS);
  // Nothing known about this radar: its Level III tilts first, in about a
  // second, and only then Level II's. Asked for together, Level II's -- a
  // search of the chunk bucket, several seconds -- slowed the Level III answer
  // to three or ten seconds, and the tilt buttons waited on it.
  const first = fresh
    ? fetchSiteAvailability(site, true, at)
        .then((quick) => {
          // A second check overlapping this one has answered already: the
          // partial answer must not take back what the whole one listed.
          if (current() && store.getState().availabilityState !== "ready") applyAvailability(quick);
        })
        .catch(() => undefined)
    : Promise.resolve();
  void first
    .then(() => (current() ? fetchSiteAvailability(site, false, at) : Promise.reject(new Error("moved on"))))
    .then((avail) => {
      if (at === null) rememberAvailability(site, avail);
      if (!current()) return;
      // Unchanged since what is on screen: nothing to redo. Not so after a
      // partial answer, even an identical one (a radar with no Level II yet):
      // products are still waiting on this one to say so.
      const shown = store.getState().availability;
      if (shown && !shown.level2Pending && !shown.provisional && JSON.stringify(shown.families) === JSON.stringify(avail.families)) {
        store.setState({ availability: avail, availabilityState: "ready" });
        return;
      }
      applyAvailability(avail);
    })
    .catch(() => {
      if (current()) stopWaiting();
    })
    .finally(() => window.clearTimeout(waiting));
}

/** What a TDWR forced each pane off (CC, CREF, ... do not exist at one), to go
 *  back to on the next NEXRAD; `to` is where it went, so a pane since put on
 *  something else by hand stays there. */
const tdwrForced = new Map<string, { wanted: string; to: string }>();

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
  // The same tilt can change source: before Level III's archive begins (March
  // 2022) reflectivity and velocity come from Level II's, under its codes, and
  // back again for a later moment.
  const recoded = (family: string, tilt: string | null, product: string) => {
    const fam = grids.find((f) => f.id === family);
    const code = fam && !fam.unavailable && fam.tilts.length ? wireCode(fam, tilt) : null;
    return code !== null && code !== product;
  };
  const onTdwr = isTdwrId(store.getState().site);
  // Off a TDWR: each pane back on what it forced it off. A family not in this
  // answer waits for the next (the catalogue first, then the radar's own word).
  let restored = false;
  if (!onTdwr) {
    for (const [id, { wanted, to }] of [...tdwrForced]) {
      const s = store.getState();
      const focused = id === getActivePaneId();
      if ((focused ? s.family : s.paneRadar[id]?.family) !== to) {
        tdwrForced.delete(id);
        continue;
      }
      const fam = grids.find((f) => f.id === wanted);
      if (!fam || fam.unavailable) continue;
      tdwrForced.delete(id);
      if (focused) {
        s.setFamily(wanted);
        restored = store.getState().family === wanted || restored;
      } else s.setPaneFamily(id, wanted);
    }
  }
  const now = store.getState();
  for (const [id, pane] of Object.entries(now.paneRadar)) {
    if (id === getActivePaneId()) continue;
    const other = fallback(pane.family);
    if (other) {
      if (onTdwr) tdwrForced.set(id, { wanted: pane.family, to: other });
      now.setPaneFamily(id, other);
    }
    else if (nearest(pane.family, pane.tilt) !== undefined || recoded(pane.family, pane.tilt, pane.product)) {
      now.setPaneFamily(id, pane.family);
    }
  }
  const other = fallback(now.family);
  if (other) {
    const active = getActivePaneId();
    if (onTdwr && active) tdwrForced.set(active, { wanted: now.family, to: other });
    now.setFamily(other);
    return true;
  }
  const moveTo = nearest(now.family, now.tilt);
  if (moveTo !== undefined && moveTo !== null && wireCode(grids.find((f) => f.id === now.family)!, moveTo) !== now.product) {
    now.setTilt(moveTo);
    return true;
  }
  // (a whole-volume product can change code too: DVL at a NEXRAD is NVL at a TDWR)
  if (recoded(now.family, now.tilt, now.product)) {
    now.setTilt(now.tilt as string);
    return true;
  }
  return restored;
}

// ---------------------------------------------------------------------------
// The loop as the timeline shows it (src/lib/radarFrames.ts): the backend's
// list, with SAILS / MRLE rescans as frames and the Level II volume still
// being written at the end. `baseScans` is the list as fetched, for `baseFor`.
// ---------------------------------------------------------------------------
let baseScans: NexradScan[] = [];
let baseFor = "";

/**
 * Forget the list the loop was composed from: its radar or its window is being
 * left. Kept through the gap until the next list is read, a live status arriving
 * then composed the live frame onto the past window's frames: a loop from the
 * event to today, whose span sent the alerts reading every six hours in between.
 */
function dropListBase(): void {
  baseScans = [];
  baseFor = "";
}

/** Shown when a past moment has no frames (a radar not built yet, an archive
 *  that does not reach back that far). */
const NO_SCANS_NOTE = "No scans from this radar at that time";

/** Every pane with nothing to draw: no radar, or no scan at this moment. The
 *  layer draws the panes' meshes, so clearing only the top level left the last
 *  radar's echoes on the map with nothing selected. */
function blankPanes(panes: Record<string, PaneRadar>): Record<string, PaneRadar> {
  const out: Record<string, PaneRadar> = {};
  for (const [id, p] of Object.entries(panes)) {
    out[id] = { ...p, scan: null, mesh: null, note: null, meshRev: p.meshRev + 1 };
  }
  return out;
}

/** Stop the frames panes on their own scrubbers are loading. */
function abortPaneLoads(): void {
  for (const c of paneCtl.values()) c.abort();
  paneCtl.clear();
}

// Offline, a tilt or product change could not read its list: the loop on
// screen is kept (no empty loop, no blank radar, no timeline jump) and the
// list is read again once the connection is back.
let keptOffline = false;
let offReconnect: (() => void) | null = null;
function isNetworkFailure(err: unknown): boolean {
  if (connectionDown() || err instanceof TypeError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /failed to fetch|network|timed out|unreachable|ERR_/i.test(msg);
}
function reloadOnReconnect(): void {
  if (offReconnect) return;
  offReconnect = onReconnect(() => {
    offReconnect?.();
    offReconnect = null;
    if (keptOffline) void useNexradStore.getState().refresh();
  });
}

function wantsSails(site: string, product: string, archiveTime: number | null): boolean {
  return product.startsWith("L2") && !isBrazilSite(site) && archiveTime === null;
}

// ---------------------------------------------------------------------------
// Frames the user took out of the loop (Frames panel: Remove / Clear frames).
// Kept by key for the radar + product they were removed on, so a poll or a
// recompose does not bring them back; another radar, product or Restore resets it.
// ---------------------------------------------------------------------------
const removedKeys = new Set<string>();
let removedFor = "";

function removedNow(site: string | null, product: string): Set<string> {
  const k = `${site ?? ""}|${product}`;
  if (removedFor !== k) {
    removedKeys.clear();
    removedFor = k;
  }
  return removedKeys;
}

/** How many frames are out of the loop on this radar. */
export function removedFrameCount(): number {
  const s = useNexradStore.getState();
  return removedNow(s.site, s.product).size;
}

/** Take frames out of the loop (the frame on screen moves to its nearest). */
export function removeFrames(keys: string[]): void {
  const s = useNexradStore.getState();
  const gone = removedNow(s.site, s.product);
  for (const k of keys) gone.add(k);
  if (s.archiveDate) {
    // A whole day's list is not composed: filter it in place.
    const cur = s.scans[s.index];
    const next = s.scans.filter((f) => !gone.has(f.key));
    let index = next.findIndex((f) => f.key === cur?.key);
    if (index < 0) index = nearestScan(next, cur?.time ?? null);
    useNexradStore.setState({ scans: next, index: Math.max(0, index) });
    if (next[index]?.key !== cur?.key) void useNexradStore.getState().showIndex(index);
    return;
  }
  recomposeScans();
}

/** Put every removed frame back (they load again when played or shown). */
export function restoreFrames(): void {
  const s = useNexradStore.getState();
  if (!removedNow(s.site, s.product).size) return;
  removedKeys.clear();
  if (s.archiveDate) void s.setArchiveDate(s.archiveDate);
  else recomposeScans();
}

/**
 * Clear frames: unload every frame but the one on screen and the newest. They
 * leave the loop (new scans still join it) and their decoded scans and meshes
 * are freed; Restore brings the list back, to load again.
 */
export function clearFrames(): number {
  const s = useNexradStore.getState();
  if (!s.site || s.scans.length < 3) return 0;
  const keep = new Set([s.scans[s.index]?.key, s.scans[s.scans.length - 1]?.key].filter(Boolean) as string[]);
  const drop = s.scans.filter((f) => !keep.has(f.key)).map((f) => f.key);
  stopWarming();
  // Free what is cached, except what a pane is drawing right now.
  const shown = new Set<PolarScan>([s.scan, ...Object.values(s.paneRadar).map((p) => p.scan)].filter(Boolean) as PolarScan[]);
  for (const [id, scan] of [...scanCache]) {
    if (shown.has(scan) || [...keep].some((k) => id.endsWith(`|${k}`))) continue;
    scanCache.delete(id);
    setFrameState(id, "idle");
  }
  clearMeshCache(); // the meshes on screen are held by the panes, not the cache
  dropRetries((id) => [...keep].some((k) => id.endsWith(`|${k}`)));
  removeFrames(drop);
  useNexradStore.setState({ warm: useNexradStore.getState().countWarm() });
  return drop.length;
}

/** The decoded scan of a frame, when it is loaded (Frames panel details). */
export function cachedScan(site: string, product: string, key: string): PolarScan | undefined {
  return scanCache.get(scanId(site, product, key));
}

function composeNow(base: NexradScan[]): NexradScan[] {
  const s = useNexradStore.getState();
  const l2 = !!s.site && !isBrazilSite(s.site) && s.product.startsWith("L2");
  const gone = removedNow(s.site, s.product);
  // Added radars' scans join the composed loop (archive-l2).
  const out = gone.size
    ? mergeExtras(composeNow0(base, s, l2).filter((f) => !gone.has(f.key)))
    : mergeExtras(composeNow0(base, s, l2));
  return damagedKeys.size ? out.filter((f) => !isDamaged(f.site ?? s.site ?? "", f.key)) : out;
}

// ---------------------------------------------------------------------------
// Damaged files: fetched, but the backend cannot read them (HTTP 422 -- TBW
// N0B 2024-10-09 22:58:07 inside the Milton event). Out of every loop for the
// session, never retried.
// ---------------------------------------------------------------------------
const damagedKeys = new Set<string>();
const isDamaged = (site: string, key: string) => damagedKeys.has(`${site}|${key}`);

function markDamaged(site: string, key: string): void {
  const id = `${site}|${key}`;
  if (damagedKeys.has(id)) return;
  damagedKeys.add(id);
  // After the caller has seen its failure; then the loop closes over the gap.
  window.setTimeout(() => {
    const s = useNexradStore.getState();
    if (!s.scans.some((f) => f.key === key && (f.site ?? s.site) === site)) return;
    if (!s.archiveDate) {
      recomposeScans();
      return;
    }
    // A whole day's list is not composed: filter it in place.
    const cur = s.scans[s.index];
    const next = s.scans.filter((f) => !isDamaged(f.site ?? s.site ?? "", f.key));
    let index = next.findIndex((f) => f.key === cur?.key);
    if (index < 0) index = nearestScan(next, cur?.time ?? null);
    useNexradStore.setState({ scans: next, index: Math.max(0, index) });
    if (next[index]?.key !== cur?.key) void useNexradStore.getState().showIndex(Math.max(0, index));
  }, 0);
}

function composeNow0(base: NexradScan[], s: ReturnType<typeof useNexradStore.getState>, l2: boolean): NexradScan[] {
  return composeFrames(base, {
    slot: l2 ? s.tilt : null,
    expand: getSetting<boolean>("radar.expandSails"),
    inProgress: getSetting<boolean>("radar.inProgress") && s.autoUpdate,
    liveL2: l2 && s.archiveTime === null && !s.archiveDate,
    live: composeLive(s.site),
  });
}

function sameFrames(a: NexradScan[], b: NexradScan[]): boolean {
  return a.length === b.length && a.every((f, i) => f.key === b[i].key && f.time === b[i].time && f.of === b[i].of && f.site === b[i].site);
}

/** Compose the loop again (a setting, the live status or the tilt changed),
 *  keeping the frame on screen -- or the newest, when parked on it. */
export function recomposeScans(): void {
  const s = useNexradStore.getState();
  if (!s.site || s.archiveDate || baseFor !== `${s.site}|${s.product}`) return;
  const next = composeNow(baseScans);
  const prev = s.scans;
  if (sameFrames(prev, next)) return;
  const atLatest = s.index >= prev.length - 1;
  const cur = prev[s.index];
  let index = next.findIndex((f) => f.key === cur?.key);
  if (atLatest || index < 0) {
    index = atLatest ? next.length - 1 : nearestScan(next, cur?.time ?? null);
  }
  useNexradStore.setState({ scans: next, index: Math.max(0, index) });
  if (next[index]?.key !== cur?.key) void useNexradStore.getState().showIndex(index);
}

/** Frames of tilts that were not scanned yet are kept only until the live
 *  status moves on: then they are asked for again. */
export function dropPendingScans(): void {
  let dropped = false;
  for (const [id, scan] of scanCache) {
    if (!scan.meta.pending) continue;
    scanCache.delete(id);
    setFrameState(id, "idle");
    dropped = true;
  }
  if (!dropped) return;
  const s = useNexradStore.getState();
  const waiting = !!s.scan?.meta.pendingNote || Object.values(s.paneRadar).some((p) => !!p.scan?.meta.pendingNote);
  if (waiting) void s.showIndex(s.index);
}

/** A European frame's files keep landing for a while after it opens (meta.young,
 *  backend/opera_radar.py), so a copy read early can lack the newest sweeps: a new
 *  frame is the moment to read those copies again. */
function dropYoungScans(): void {
  for (const [id, scan] of [...scanCache]) {
    if (!scan.meta.young) continue;
    scanCache.delete(id);
    setFrameState(id, "idle");
    for (const [key, mesh] of [...meshCache]) {
      if (!key.startsWith(`${id}|`)) continue;
      meshCacheBytes -= meshBytes(mesh);
      meshCache.delete(key);
    }
  }
}

/** Check for a new volume now (the live status saw one complete). */
let pollNow: (() => Promise<void>) | null = null;
export function pollNexradNow(): Promise<void> {
  return pollNow?.() ?? Promise.resolve();
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
  loopMinutes: DEFAULT_LOOP_MINUTES,
  sailsRep: 1,
  archiveTime: null,
  archiveFocus: null,
  archiveDate: null,
  archivePick: null,
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
            sites: offeredSites(sites),
            products: meta.products,
            catalog: meta.catalog,
            // A check that failed before the catalogue came in has nothing to
            // wait for: the catalogue's list stands, as it does after one.
            grids: get().availabilityState === "failed" ? grids : withAvailability(grids, get().availability),
            baseGrids: grids,
            palettes: meta.palettes,
            palTables: pals.palettes,
            kindDefaults: pals.kindDefaults,
            family: fam?.id ?? get().family,
            product: resolved ?? get().product ?? meta.defaultProduct,
            frames: clampFrames(resolved ?? get().product, get().frames),
            error: null,
            // The pane made before the catalog came in holds the bootstrap N0B:
            // a restored Level II product (L2C0) has to reach it too.
            ...(resolved && fam
              ? { paneRadar: withFocusedPane(get(), { family: fam.id, tilt: get().tilt, product: resolved }) }
              : {}),
          });
          scheduleSiteReloads(() => get().reloadSites());
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

  reloadSites: async () => {
    try {
      const sites = await fetchNexradSites();
      set({ sites: offeredSites(sites) });
    } catch {
      /* the list on screen stays */
    }
  },

  selectSite: (site) => {
    const current = get().site;
    if (site === current) return;
    if (site) {
      // radar-sites: a live radar that is down stays closed; its reasons show.
      if (siteGate && !siteGate(site)) return;
      const candidate = get().sites.find((s) => s.id === site);
      // Gone quiet NOW (no scan since yesterday): nothing live to show. A past
      // moment is another matter -- the archive has that radar's old scans. A
      // European radar opens all the same and says since when it has been quiet.
      if (candidate?.online === false && archiveAnchor(get()) === null && !isEuropeSite(site)) return;
    }
    // A different site shares nothing with the cached meshes; free them so the
    // budget isn't spent holding geometry for a radar no longer on screen.
    clearMeshCache();
    lastStormKey = null;
    // The last radar's frames stop downloading now, not once this one's first
    // scan is up: they were queued ahead of everything this radar needs first.
    warmToken++;
    abortWarm();
    // Past scans loaded: the new radar loads over the same window, opening
    // near the moment on screen (archive-l2).
    const was = get().scans[get().index];
    const inArchive = get().archiveTime !== null || get().archiveDate !== null;
    set({
      site, scan: null, mesh: null, meshRev: get().meshRev + 1, scans: [], index: 0,
      error: null, storms: null, selectedCellId: null,
      ...(inArchive && was ? { archiveFocus: was.time } : {}),
      // Another radar keeps the last picture until its first frame is up; no
      // radar at all leaves nothing drawn.
      ...(site ? {} : { paneRadar: blankPanes(get().paneRadar) }),
    });
    if (availabilityTimer != null) window.clearInterval(availabilityTimer);
    availabilityTimer = null;
    if (site) {
      // What this radar was flying last time, if it has been seen: its buttons
      // show now, and the check below corrects them if the VCP changed.
      const remembered = archiveAnchor(get()) === null ? (knownAvailability.get(site) ?? null) : null;
      // What an airport radar can have is known before anything is asked: no
      // NEXRAD code (and no Level II) is ever requested of it. Its own list is
      // not: that waits for the check below.
      const known = remembered ?? (isTdwrId(site) ? tdwrAvailability(get().baseGrids) : null);
      let moved = applyAvailability(known);
      // Off an airport radar onto a NEXRAD nothing is known about: back to the
      // catalogue's codes now, the check below corrects the tilts.
      if (!known && (isTdwrCode(get().product) || Object.values(get().paneRadar).some((p) => isTdwrCode(p.product)))) {
        moved = applyAvailability(catalogueAvailability(get().baseGrids));
        applyAvailability(null);
      }
      // A low cut is the one tilt most radars do not have: with nothing known,
      // leave it rather than fetch a Level II volume that may not exist.
      if (!known && get().tilt === "L") {
        get().setTilt("0");
        moved = true;
      }
      // Moving the tilt already loads the scan; loading it again here was a
      // second fetch of every frame on every radar switch.
      if (!moved) void get().refresh();
      // No storms asked for here: the first frame asks for its own once it is
      // on the map. This one was for "now", a second answer nobody showed,
      // and it held up the frame and the tilts behind it.
      checkAvailability(site);
      availabilityTimer = window.setInterval(() => {
        if (get().site === site) checkAvailability(site);
      }, AVAILABILITY_REFRESH_MS);
    }
    else {
      applyAvailability(null);
      controller?.abort();
      controller = null;
      abortPaneLoads();
      dropListBase();
    }
  },

  setProduct: (product) => {
    if (product === get().product) return;
    warmToken++; // the last product's frames are no longer wanted
    abortWarm();
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
    warmToken++; // the last product's frames are no longer wanted
    abortWarm();
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
    warmToken++;
    abortWarm();
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
  // the whole point of colouring client-side. EVERY pane's mesh (colour-tables:
  // only the focused pane's was recoloured, so a second pane on the same
  // product kept the old table until its next frame).
  repaint: () => {
    const { mesh, scan, paneRadar } = get();
    const jobs: { m: RadarMesh; kind: string }[] = [];
    if (mesh && scan) jobs.push({ m: mesh, kind: scan.meta.kind });
    for (const p of Object.values(paneRadar)) if (p.mesh && p.scan) jobs.push({ m: p.mesh, kind: p.scan.meta.kind });
    // recolor mutates these meshes in place -- but they are references held by
    // the mesh cache under the OLD palette's key, so leaving them there would
    // hand a recoloured mesh back for the old palette later. Drop the cache;
    // the next view rebuilds cleanly under the new palette's key.
    clearMeshCache();
    const done = new Set<RadarMesh>();
    for (const { m, kind } of jobs) {
      if (done.has(m)) continue;
      done.add(m);
      const pal = get().resolvePal(kind);
      if (pal) recolor(m, pal, kind);
    }
    set({ colorRev: get().colorRev + 1 });
  },

  /** The .pal text for a product kind: its chosen table (built-in default, a
   *  built-in alternate or a saved palette), the colour table editor's draft
   *  while it is open, moved by the table's colour scale and offset
   *  (src/lib/colorTables.ts). */
  resolvePal: (kind) => {
    const pid = get().paletteIdFor(kind);
    // Velocity tables keep their RF colour only with "Show range folded" on.
    return rangeFoldedPal(kind, resolveTableText(pid, get().palTables));
  },

  /** Which built-in palette a product kind maps to. */
  paletteIdFor: (kind) => get().kindDefaults[kind] ?? "REF",

  setFrames: (frames) => {
    const clamped = clampFrames(get().product, frames);
    if (clamped === get().frames) return;
    set({ frames: clamped, error: null });
    if (get().site) void get().refresh();
  },

  setLoopMinutes: (loopMinutes) => {
    if (loopMinutes === get().loopMinutes || !(LOOP_MINUTES as readonly number[]).includes(loopMinutes)) return;
    set({ loopMinutes, error: null });
    if (get().site) void get().refresh();
  },

  setSailsRep: (sailsRep) => {
    if (sailsRep === get().sailsRep) return;
    set({ sailsRep });
    void get().showIndex(get().index);
  },

  // Whole-day playback. A Level III day pulls EVERY scan (~400) and warms them
  // all before handing over, so a finished day scrubs without stalling. A
  // Level II day (archive-l2: any day back to 1991) and a pick from the
  // Archive panel show the first scan at once and load the rest from there:
  // their frames are 2-16 MB volumes, a day of them gigabytes.
  setArchiveDate: async (archiveDate, pick) => {
    const { site } = get();
    dayToken += 1;
    const mine = dayToken;

    if (archiveDate === null) {
      // Leaving a day: its frames are not the live loop (see dropListBase).
      const leaving = get().archiveDate !== null;
      if (leaving) dropListBase();
      set({
        archiveDate: null, archivePick: null, dayLoad: null,
        ...(leaving
          ? { archiveFocus: null, error: null, scan: null, mesh: null, meshRev: get().meshRev + 1, scans: [], index: 0 }
          : {}),
      });
      if (site) void get().refresh();
      return;
    }

    dropListBase();
    get().stopAutoRefresh();
    // Re-loading the SAME day (a product, tilt or radar change) keeps the
    // moment on screen and the picked stretches; a new pick or another day
    // starts at its first frame.
    const sameDay = get().archiveDate === archiveDate;
    const archivePick = pick !== undefined ? pick : sameDay ? get().archivePick : null;
    const fresh = !sameDay || pick !== undefined;
    const held = fresh ? null : (get().scans[get().index]?.time ?? get().archiveFocus);
    set({
      archiveDate, archivePick, archiveTime: null, archiveFocus: held, error: null, dayLoad: null,
      ...(fresh ? { scans: [], index: 0 } : {}),
    });
    if (!site) return;

    try {
      // Before Level III's archive (March 2022) only Level II has the day:
      // what the radar flew then decides the codes (REF -> L2B0) first.
      if (!get().product.startsWith("L2") && archiveDate < LEVEL3_FIRST_DAY && !isBrazilSite(site)) {
        const avail = await fetchSiteAvailability(site, false, archiveAnchor(get())).catch(() => null);
        if (mine !== dayToken) return;
        if (avail && applyAvailability(avail)) return; // the move loads the day again
      }
      const product = get().product;
      const block = !product.startsWith("L2") && !archivePick;
      if (block) set({ dayLoad: { done: 0, total: 0 } });
      resetPaneLists(archiveDate, 0, 0);
      const res = await fetchNexradScans(site, product, archiveDate, 0);
      if (mine !== dayToken) return; // superseded or cancelled
      const gone = removedNow(site, product);
      const own = res.scans.filter((f) => (!archivePick || inPick(f.time, archivePick)) && !gone.has(f.key));
      if (!own.length) {
        set({
          dayLoad: null, scans: [], loading: false, scan: null, mesh: null, meshRev: get().meshRev + 1,
          paneRadar: blankPanes(get().paneRadar),
          error: archivePick ? `No ${product} scans in the picked part of ${archiveDate}.` : `No scans archived for ${archiveDate}.`,
        });
        return;
      }
      const scans = mergeExtras(own);
      const keep = held != null ? nearestScan(scans, held) : 0;
      // What the radar flew that day (the tilt buttons), unless done above.
      checkAvailability(site);
      if (!block) {
        set({ scans, index: keep, warm: 0 });
        await get().showIndex(keep);
        return;
      }
      set({ scans, index: keep, warm: 0, dayLoad: { done: 0, total: scans.length } });

      // Warm every frame, a few at a time, so play is instant afterwards.
      let next = 0;
      let done = 0;
      const pump = async (): Promise<void> => {
        while (next < scans.length) {
          if (mine !== dayToken) return;
          const f = scans[next++];
          try {
            await loadScan(f.site ?? site, f.product ?? product, f.key);
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
    set({ dayLoad: null, archiveDate: null, archivePick: null });
    if (get().site) void get().refresh();
  },

  setPaneRadar: (id, site) => {
    const pane = get().paneRadar[id];
    if (!pane) return;
    const own = site && site !== get().site ? site : null;
    if ((pane.site ?? null) === own) return;
    set({ paneRadar: { ...get().paneRadar, [id]: { ...pane, site: own, scan: null, mesh: null, meshRev: pane.meshRev + 1 } } });
    if (!remergeScans() && get().site) void get().showIndex(get().index);
  },

  queuePaneRadar: (id, site) => {
    if (get().paneRadar[id]) {
      get().setPaneRadar(id, site);
      return;
    }
    pendingPaneRadars.set(id, { site, at: Date.now() });
  },

  addPane: (id) => {
    if (get().paneRadar[id]) return;
    const { product, family, tilt } = get();
    // "Add radar" grew the layout for this pane: it opens on that radar.
    const wait = pendingPaneRadars.get(id);
    pendingPaneRadars.delete(id);
    const own = wait && Date.now() - wait.at < PENDING_PANE_MS ? wait.site : null;
    // panes-compare: a pane added to hold a cross-section or the 3D view shows
    // no product of its own behind it -- nothing to load or draw there.
    const forView = !own && !!usePaneStore.getState().analysis[id];
    set({
      paneRadar: {
        ...get().paneRadar,
        // a new pane opens on whatever the focused one is showing
        [id]: { product, family, tilt, scan: null, mesh: null, meshRev: 0, site: own, ...(forView ? { empty: true } : {}) },
      },
    });
    if (forView) return;
    if (own && remergeScans()) return;
    if (get().site) void get().showIndex(get().index);
  },

  dropPane: (id) => {
    const had = get().paneRadar[id]?.site;
    if (had) pendingPaneRadars.set(id, { site: had, at: Date.now() });
    const paneRadar = { ...get().paneRadar };
    delete paneRadar[id];
    set({ paneRadar });
    if (had) remergeScans();
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
        [id]: { ...pane, family, tilt: slot, product: code, scan: null, mesh: null, empty: false,
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
    // Another window shares no frames with this one: nothing of it stays, not
    // its list (see dropListBase), not the frames still loading. The panes keep
    // their picture until the new window's first frame is up.
    dropListBase();
    controller?.abort();
    controller = null;
    warmToken++;
    abortWarm();
    dayToken += 1;
    set({ archiveTime, archiveFocus: null, archiveDate: null, archivePick: null, dayLoad: null, error: null, scan: null, mesh: null,
          meshRev: get().meshRev + 1, scans: [], index: 0 });
    if (archiveTime !== null) get().stopAutoRefresh();
    const { site } = get();
    if (!site) return;
    // Another moment, other tilts: what the radar flew then, or back to what it
    // flies now. A tilt it did not have moves, and moving loads the scan.
    // Nothing remembered for that moment: the same radar's list stands until the
    // check below answers, rather than emptying on every jump through the archive.
    const known = archiveTime === null ? (knownAvailability.get(site) ?? null) : null;
    const moved = known ? applyAvailability(known) : false;
    if (!moved) void get().refresh();
    checkAvailability(site);
  },

  openAt: (site, unix) => {
    // A few scans of lead-in, so the loop shows the storm arriving.
    const start = Math.floor(unix - OPEN_AT_LEAD_S);
    // The window already open: only the frame moves.
    if (get().site === site && get().archiveTime === start && get().archiveDate === null && get().scans.length) {
      void get().showIndex(nearestScan(get().scans, unix));
      return;
    }
    if (get().site !== site) {
      // Archive first, then the radar: its first load is then the archive one,
      // not a live list that a second load would have to race.
      get().stopAutoRefresh();
      set({ archiveTime: start, archiveFocus: unix, archiveDate: null, archivePick: null });
      get().selectSite(site);
      // selectSite aims a radar change at the frame on screen; here the
      // instant asked for wins (its list is read after this, off the network).
      set({ archiveFocus: unix });
      return;
    }
    get().setArchiveTime(start);
    set({ archiveFocus: unix });
  },

  // Load the scan list for the current site/product. Live opens on the newest
  // frame; archive playback opens on the OLDEST of the requested window, so
  // pressing play runs forward from the moment the calendar picked.
  loadScans: async () => {
    const { site, product, frames, archiveTime, loopMinutes } = get();
    if (!site) return;
    // Another radar, product or window took over while this list was on its
    // way: NOW pressed during an event's load must not get the event's frames.
    const superseded = () => {
      const s = get();
      return s.site !== site || s.product !== product || s.archiveTime !== archiveTime || s.archiveDate !== null;
    };
    try {
      resetPaneLists("", frames, archiveTime ?? 0, loopMinutes);
      const res = await fetchNexradScans(site, product, "", frames, archiveTime ?? 0, loopMinutes,
                                         wantsSails(site, product, archiveTime));
      if (superseded()) return;
      keptOffline = false;
      baseScans = res.scans;
      baseFor = `${site}|${product}`;
      dropRetries();
      if (archiveTime === null) noteLiveCheck(site, false);
      const scans = composeNow(res.scans);
      // Where a past window opens: an instant asked for (an event, a link, the
      // frame on screen when the radar changed) wins, once. After that it stays
      // on the frame on screen, so a product or tilt change does not send the
      // loop back to where the window opened.
      const was = get();
      const aim = was.archiveFocus ?? was.scans[was.index]?.time ?? null;
      set({
        scans,
        archiveStart: res.archiveStart,
        index: archiveTime !== null ? nearestScan(scans, aim) : Math.max(0, scans.length - 1),
        warm: 0,
        ...(archiveTime !== null && scans.length ? { archiveFocus: null } : {}),
      });
    } catch (err) {
      if (superseded()) return;
      const msg = err instanceof Error ? err.message : String(err);
      // A window's list that could not be read comes back with the connection
      // too, even with no frame of it here yet.
      if ((get().scans.length > 0 || archiveTime !== null) && isNetworkFailure(err)) {
        keptOffline = true;
        set({ error: msg });
        reloadOnReconnect();
        return;
      }
      set({ error: msg, scans: [] });
    }
  },

  // Pull the whole scan list into the cache in the background, nearest-first
  // from `from`, so play/scrub is local instead of paying ~450 ms per frame.
  // Fire-and-forget: a failed frame just pays for itself when displayed.
  prefetch: (from) => {
    const { site, product, scans } = get();
    if (!site || !scans.length) return;
    const token = ++warmToken; // a new site/product/date supersedes this pass

    // nearest-first, forward-biased: playback usually runs forward from here.
    // Each frame on its own radar and product (an added radar's, archive-l2),
    // and a Level II day (up to ~300 volumes) only the stretch around here.
    const idOf = (f: NexradScan) => scanId(f.site ?? site, f.product ?? product, f.key);
    const order = scans
      .map((s, i) => ({ f: s, d: i < from ? (from - i) * 2 : i - from }))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.f)
      .slice(0, product.startsWith("L2") ? L2_WARM_MAX : scans.length);

    // The meshes of the scans just ahead of the playhead are built too, on the
    // workers, as each scan lands: a play then shows them without a build.
    const ahead = new Set<string>();
    for (let k = 0; k <= Math.min(MESH_AHEAD, scans.length - 1); k++) ahead.add(idOf(scans[(from + k) % scans.length]));
    const prebuild = (f: NexradScan) => {
      const id = idOf(f);
      if (!ahead.has(id) || token !== warmToken) return;
      const scan = scanCache.get(id);
      const pal = scan ? get().resolvePal(scan.meta.kind) : null;
      if (scan && pal) void getMesh(id, scan, pal, get().smooth, get().threshold).catch(() => undefined);
    };
    for (let k = 0; k <= Math.min(MESH_AHEAD, scans.length - 1); k++) prebuild(scans[(from + k) % scans.length]);

    let next = 0;
    const pump = async (): Promise<void> => {
      while (next < order.length) {
        if (token !== warmToken) return; // superseded
        const f = order[next++];
        if (scanCache.has(idOf(f))) continue;
        try {
          await loadScan(f.site ?? site, f.product ?? product, f.key, true);
          prebuild(f);
        } catch {
          /* skip -- it'll retry if displayed */
        }
        if (token === warmToken) set({ warm: get().countWarm() });
      }
    };
    // A derived product costs the backend a whole volume per frame (2-3 s, two
    // at a time): with five out, the next product's frame on screen queued
    // behind them there even after they were cancelled here.
    const derived = allFamilies(get()).find((f) => f.id === get().family)?.group === "derived";
    for (let i = 0; i < (derived ? WARM_CONCURRENCY_DERIVED : WARM_CONCURRENCY); i++) void pump();

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

  isWarmAt: (i) => {
    const { site, product, scans } = get();
    const s = scans[i];
    return !!site && !!s && scanCache.has(scanId(s.site ?? site, s.product ?? product, s.key));
  },

  isMeshedAt: (i) => {
    const { site, product, scans, smooth, threshold } = get();
    const s = scans[i];
    if (!site || !s) return false;
    const id = scanId(s.site ?? site, s.product ?? product, s.key);
    const scan = scanCache.get(id);
    if (!scan) return false;
    const pal = get().resolvePal(scan.meta.kind);
    return !pal || meshCache.has(meshKeyOf(id, pal, smooth, threshold));
  },

  countWarm: () => {
    const { site, product, scans } = get();
    if (!site) return 0;
    return scans.reduce((n, s) => n + (scanCache.has(scanId(s.site ?? site, s.product ?? product, s.key)) ? 1 : 0), 0);
  },

  // Show one scan by index, committing only once its mesh is ready.
  // Move EVERY pane to the same frame. Panes differ only by product, so one
  // scrub keeps them all on the same instant -- which is the point of split
  // screen. Panes load in parallel and share `scanCache` when products match.
  showIndex: async (i, only) => {
    const { site, product, scans, paneRadar } = get();
    if (!site) return false;
    // No frames at a past moment: nothing to show. An empty key asks for the
    // newest scan, which is today's, under the past moment's timeline.
    if (!scans.length && archiveAnchor(get()) !== null) {
      // A list still being read says so when it lands (refresh), and a pinned
      // day has its own words (setArchiveDate).
      if (get().archiveTime !== null && !get().loading) set({ error: get().error ?? NO_SCANS_NOTE });
      return false;
    }
    const idx = Math.max(0, Math.min(i, Math.max(scans.length - 1, 0)));
    const key = scans[idx]?.key ?? "";
    // A pane on its own scrubber loads alone: it must not cancel the loop's
    // frame, nor the loop cancel it.
    let mine: AbortController;
    if (only) {
      paneCtl.get(only)?.abort();
      mine = new AbortController();
      paneCtl.set(only, mine);
    } else {
      controller?.abort();
      controller = new AbortController();
      mine = controller;
    }

    // A cached scan still needs its mesh built (~100 ms), but no spinner: the
    // swap is fast enough that flashing "loading" just looks like a glitch.
    const frame = scans[idx];
    const cached = scanCache.has(scanId(frame?.site ?? site, frame?.product ?? product, key));
    if (!cached && !only) set({ loading: true, error: null });

    type Shown = { scan: PolarScan; mesh: RadarMesh };
    const build = async (prod: string, prev: { scan: PolarScan | null; mesh: RadarMesh | null },
                         paneSite?: string | null, paneId?: string | null, at = idx): Promise<Shown> => {
      // panes-layout: a pane on its own scrubber builds its own frame.
      const frame = scans[at];
      const idx = at;
      // "Add radar" (archive-l2): a pane on another radar than the frame's
      // shows that radar's newest scan at the frame's time.
      const useSite = paneSite || site;
      const frameSite = frame?.site ?? site;
      let k = useSite === frameSite
        ? await paneKey(useSite, prod, frame?.product ?? product, frame)
        : await latestKey(useSite, prod, frame, useSite === site && prod === product ? scans.filter((f) => !f.site) : null);
      // "Expand SAILS cuts" off: the scan of the tilt the badge has picked.
      const rk = repKey(frame, get().tilt, get().sailsRep);
      if (rk && k === frame?.key && frameSite === useSite) k = rk;
      let useProd = prod;
      let scan = await loadScan(useSite, prod, k);
      let note: { pendingNote?: string; holdNote?: string } = {};
      if (scan.meta.pending) {
        // The volume being written hasn't reached this tilt: the previous whole
        // volume, under the pane's note "1.3° isn't scanned yet".
        note = { pendingNote: scan.meta.note ?? "Not scanned yet" };
        // The newest whole volume that has the tilt: AVSET ends a volume early
        // when nothing is up there, so the one just before may not reach it.
        const before = scans.slice(0, idx).reverse().filter((f) => !f.partial && !f.site).slice(0, 4);
        if (!before.length) throw new Error(note.pendingNote);
        for (const f of before) {
          k = await paneKey(useSite, prod, product, f);
          scan = await loadScan(useSite, prod, k);
          if (scan.meta.elevation != null) break;
        }
      } else if (scan.meta.elevation == null && prod.startsWith("L2") && /^Not scanned/.test(scan.meta.note ?? "")) {
        // The scan strategy changed and has no such tilt: Hold elevation.
        const fam = allFamilies(get()).find((f) => f.tilts.some((t) => t.code === prod));
        const picked = fam?.tilts.find((t) => t.code === prod);
        const hold = getSetting<boolean>("radar.holdElevation");
        const alt = fam && picked?.elev != null ? substituteTilt(scan, picked.elev, fam.tilts, hold, prev.scan) : null;
        const altCode = fam && alt ? wireCode(fam, alt.tilt) : null;
        const altScan = altCode && altCode !== prod ? await loadScan(useSite, altCode, k).catch(() => null) : null;
        if (altCode && altScan && altScan.meta.elevation != null) {
          note = { holdNote: `${picked?.elev?.toFixed(1)}° isn't in this scan: showing ${altScan.meta.elevation.toFixed(1)}°` };
          useProd = altCode;
          scan = altScan;
        } else if (hold && prev.scan && prev.mesh && prev.scan.meta.elevation != null) {
          // Nothing within 1.5°: the previous picture stays.
          const was = prev.scan.meta;
          return {
            scan: { ...prev.scan, meta: { ...was, pendingNote: undefined, holdNote: `${picked?.elev?.toFixed(1) ?? ""}° isn't in this scan: showing the previous one` } },
            mesh: prev.mesh,
          };
        } else {
          // Nothing stands in: the empty frame, and why ("Not scanned at 19.5° ...").
          note = { holdNote: scan.meta.note };
        }
      }
      const pal = get().resolvePal(scan.meta.kind);
      if (!pal) throw new Error("palette tables not loaded");
      // Display options (radarDisplay.ts): the maximum value trail of this
      // pane, the reflectivity gate filter. "" tag = the frame as it is.
      const disp = await displayScan({
        paneId: paneId ?? null, site: useSite, product: useProd, key: k, scan,
        load: (p, key) => loadScan(useSite, p, key),
        refKey: (p) => paneKey(useSite, p, frame?.product ?? product, frame),
        trailKeys: trailOn(paneId) && useSite === frameSite
          ? async () => {
              const out: string[] = [];
              for (let j = 0; j <= idx; j++) {
                const f = scans[j];
                if (!f || f.site) continue;
                const fk = j === idx ? k : await paneKey(useSite, useProd, f.product ?? product, f).catch(() => "");
                if (fk && out[out.length - 1] !== fk) out.push(fk);
              }
              return out;
            }
          : null,
      });
      scan = disp.scan;
      const mesh = await getMesh(scanId(useSite, useProd, k) + disp.tag, scan, pal, get().smooth, get().threshold);
      return { scan: note.pendingNote || note.holdNote ? { ...scan, meta: { ...scan.meta, ...note } } : scan, mesh };
    };

    if (only) {
      // One pane at its own frame (panes-layout); the loop's index stays.
      const pane = paneRadar[only];
      if (!pane || pane.empty) return false;
      try {
        const r = await build(pane.product, pane, pane.site, only, idx);
        const cur = get().paneRadar[only];
        if (mine.signal.aborted || !cur || cur.ownTime == null) return false;
        set({
          paneRadar: { ...get().paneRadar, [only]: { ...cur, scan: r.scan, mesh: r.mesh, note: null, meshRev: cur.meshRev + 1, ownTime: frame?.time ?? cur.ownTime } },
          ...(getActivePaneId() === only ? { scan: r.scan, mesh: r.mesh, meshRev: get().meshRev + 1 } : {}),
        });
        return true;
      } catch {
        return false;
      }
    }

    try {
      const ids = Object.keys(paneRadar);
      const emptyPanes = new Map<string, string>();
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            const p = paneRadar[id];
            // panes-layout: an emptied pane draws nothing; a pane on its own
            // scrubber keeps its frame (built here only when it has none).
            if (p.empty) return [id, null] as const;
            if (p.ownTime != null) {
              if (p.scan && p.mesh) return [id, null] as const;
              return [id, await build(p.product, p, p.site, id, nearestScan(scans, p.ownTime))] as const;
            }
            return [id, await build(paneRadar[id].product, paneRadar[id], paneRadar[id].site, id)] as const;
          } catch (e) {
            // An added radar with nothing here says so in its pane (archive-l2).
            if (paneRadar[id].site) emptyPanes.set(id, e instanceof Error ? e.message : String(e));
            return [id, null] as const; // one pane failing must not blank the rest
          }
        }),
      );
      // the focused pane's product also drives the top-level view
      const focusId = getActivePaneId();
      const focused = results.find(([id]) => id === focusId)?.[1];
      // A focused pane that is empty or on its own frame mirrors itself.
      const fp = focusId ? paneRadar[focusId] : undefined;
      const own: { scan: PolarScan | null; mesh: RadarMesh | null } = focused
        ?? (fp && (fp.empty || fp.ownTime != null)
          ? { scan: fp.scan, mesh: fp.mesh }
          : await build(product, { scan: get().scan, mesh: get().mesh }, focusId ? paneRadar[focusId]?.site : null, focusId));
      if (mine.signal.aborted) return false;

      const nextPanes = { ...get().paneRadar };
      for (const [id, r] of results) {
        if (!nextPanes[id]) continue;
        const why = emptyPanes.get(id);
        if (!r && why) {
          nextPanes[id] = { ...nextPanes[id], scan: null, mesh: null, note: why, meshRev: nextPanes[id].meshRev + 1 };
          continue;
        }
        if (!r) continue;
        nextPanes[id] = { ...nextPanes[id], scan: r.scan, mesh: r.mesh, note: null,
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
      // Recoded while this frame loaded (what the radar flies now, after NOW):
      // the new product's list is on its way, and the frames here are not its.
      if (get().product === product) get().prefetch(idx);
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
    const { site, product, archiveTime } = get();
    // (this list decides that note again)
    set({ loading: true, ...(get().error === NO_SCANS_NOTE ? { error: null } : {}) });
    await get().loadScans();
    // Taken over while the list was read: the newer load shows its own frame.
    const after = get();
    if (after.site !== site || after.product !== product || after.archiveTime !== archiveTime || after.archiveDate !== null) return;
    if (keptOffline) {
      // The old loop stays on screen until the connection is back (see
      // reloadOnReconnect): showing its frames under the new product would
      // mislabel them, and fetching them fails anyway.
      set({ loading: false });
      if (get().archiveTime === null) get().startAutoRefresh();
      return;
    }
    // A past moment this radar has nothing for says so, and draws nothing.
    if (archiveTime !== null && !after.scans.length) {
      set({
        loading: false, scan: null, mesh: null, meshRev: after.meshRev + 1, storms: null, selectedCellId: null,
        paneRadar: blankPanes(after.paneRadar),
        error: after.error ?? NO_SCANS_NOTE,
      });
      return;
    }
    await get().showIndex(get().index);
    if (get().archiveTime === null) get().startAutoRefresh();
  },

  // Poll for a newer scan and slide onto it -- but only if the user is already
  // parked on the latest frame, so scrubbing back isn't yanked.
  startAutoRefresh: () => {
    get().stopAutoRefresh();
    const tick = async () => {
      const { site, product, frames, scans, index, loading, archiveTime, loopMinutes } = get();
      if (!site || loading || archiveTime !== null || get().archiveDate || !get().autoUpdate) return;
      // Hidden for over a minute, or offline: skip the round; the catch-up on
      // return / reconnect polls at once (backgroundMode.ts).
      if (!backgroundAllows("radar") || connectionDown()) return;
      try {
        const res = await fetchNexradScans(site, product, "", frames, 0, loopMinutes, wantsSails(site, product, null));
        // An event or a day opened while this was on its way: not its list.
        if (get().site !== site || get().product !== product || get().archiveTime !== null || get().archiveDate) return;
        const newest = res.scans[res.scans.length - 1];
        const before = baseFor === `${site}|${product}` ? baseScans[baseScans.length - 1] : undefined;
        noteLiveCheck(site, !!newest && newest.key !== before?.key);
        baseScans = res.scans;
        baseFor = `${site}|${product}`;
        if (!newest || newest.key === before?.key) return;
        const current = scans[scans.length - 1];
        const wasAtLatest = index >= scans.length - 1;
        // A new volume landed, so the other products have a new scan too: drop
        // the cached pane lists or they can never resolve this frame.
        resetPaneLists("", frames, 0, loopMinutes);
        const next = composeNow(res.scans);
        // The frame on screen keeps its place as the oldest ones leave the window.
        const kept = next.findIndex((f) => f.key === scans[index]?.key);
        set({ scans: next, ...(wasAtLatest || kept < 0 ? {} : { index: kept }) });
        // A relayed Brazilian radar is opened before its first volume is here:
        // its products read as unavailable until then, and the next check was
        // five minutes away. Its first volume -- and any new one, whose tilts
        // can differ -- asks again now.
        if (!current || isBrazilSite(site)) checkAvailability(site);
        dropYoungScans();
        if (wasAtLatest) void get().showIndex(next.length - 1);
        // A new volume also means new storm attributes.
        void get().loadStorms();
      } catch {
        /* transient -> try again next tick */
      }
    };
    pollNow = tick;
    pollTimer = window.setInterval(tick, POLL_MS);
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
    abortPaneLoads();
    warmToken++;
    abortWarm();
    dropListBase();
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
      // The layer draws these: left in place, the echoes stayed on the map.
      paneRadar: blankPanes(get().paneRadar),
      scans: [],
      index: 0,
      error: null,
      loading: false,
    });
  },
}));
