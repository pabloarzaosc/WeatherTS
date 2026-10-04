import type { ImageSource, Map as MapLibreMap } from "maplibre-gl";

import type { LayerModule } from "../types";
import { spreadOrder } from "../../lib/loopOrder";
import { upcomingFrames } from "../../lib/playAhead";
import { prefetchSatLoop, satImageUrl, type SatBox, type SatDetail, type SatSelection } from "../../lib/satellite";
import { holdBasemapLabels } from "../../map/basemapLabels";
import { useAppStore } from "../../store/useAppStore";
import { useObsStore } from "../../store/useObsStore";
import { useSatStore } from "../../store/useSatStore";
import { addRefLabels, refLabelIds, removeRefLabels, setRefLabelsVisible } from "./refLabels";

/**
 * Satellite loops as one picture per frame for the area on screen, downloaded
 * when play is pressed -- until then only the frame on screen is fetched.
 *
 * Tiles made a loop slow: a day of GOES is 144 frames of a dozen tiles each,
 * through the six connections a browser opens to a server. Here the backend
 * fetches one picture per frame, 32 at a time, and keeps them; this layer pulls
 * the finished pictures off the local machine, holds each as an object URL, and
 * steps by swapping the image source's URL -- no network in the loop at all
 * once it is in, and a loop already seen comes back from the disk cache.
 *
 * The pictures cover the view with a margin, so panning a little stays inside
 * them. Moving past the margin, or zooming far enough that they would be blurry
 * or needlessly fine, starts a new loop for the new view -- with the frame on
 * screen first, and the old pictures left up until the new one is in.
 *
 * Each frame comes twice: a quick picture from one tile level down (a quarter
 * of the bytes -- SLIDER gives this link about 14 Mbit/s, where WeatherWise's
 * own CDN gives 80), then the sharp one in its place. A loop runs as soon as
 * every frame has its quick picture, and sharpens while it plays.
 */

const SRC = "sat-img-src";
const LAYER = "sat-img";
const LABEL_PREFIX = "sat";
const ALL = [LAYER, ...refLabelIds(LABEL_PREFIX)];

const DEFAULT_OPACITY = 1;
/** Pictures pulled from the backend at once: the browser's own limit per host. */
const PARALLEL = 6;
/** Margin around the view, as a share of its width and height, each side. */
const MARGIN = 0.12;
/** The backend's largest picture side. */
const MAX_SIDE = 3072;
/**
 * Pictures are made at the screen's own density (up to 1.5 device pixels per
 * CSS pixel). They were 85% of it, on 1.25 at most, and with the margin and a
 * 1600 px cap a full-screen map got a picture of about three quarters of its
 * pixels, stretched again by up to 1.7x before a sharper one was asked for --
 * side by side with WeatherWise the cloud edges were visibly soft and stepped.
 */
const DENSITY_CAP = 1.5;
const MOVE_SETTLE_MS = 380;
const FAIL_RETRIES = 2;
const FAIL_RETRY_MS = 4000;
const REFRESH_MS = 60_000;

const BLANK =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

interface Loop {
  key: string;
  sel: SatSelection;
  /** sat|region|product: what the loop shows. */
  product: string;
  box: SatBox;
  coords: [number, number][];
  /** time -> object URL (the quick picture until the sharp one is in), or
   *  "empty" for a time the provider has not filled in yet. */
  urls: Map<string, string>;
  /** Times whose picture is the sharp one (or "empty"): nothing more to ask. */
  sharp: Set<string>;
  /** Times with a quick picture waiting for the sharp one, in the order to ask. */
  sharpen: string[];
  /** Times whose quick picture is being fetched: no sharp one is asked for
   *  meanwhile, or its bytes (four times as many) slow the loop's start. */
  quick: Set<string>;
  /** Frames that failed: counted as done for the progress, tried again later. */
  failed: Set<string>;
  tries: Map<string, number>;
  queue: string[];
  /** time -> the request fetching it, so a loop left behind can let go of them. */
  inflight: Map<string, AbortController>;
  alive: boolean;
}

interface PaneState {
  loop: Loop | null;
  /** A loop replaced but still on screen until the new one's first frame is in. */
  retiring: Loop | null;
  shown: string;
  unsub: () => void;
  onMove: () => void;
  moveTimer: number | null;
  opacity: number;
  /** The loop whose box the image source is laid over (see paint). */
  placed: string;
  /** The picture on the texture now: its bitmap is kept while it is. */
  shownUrl: string;
  /** Frames decoded ahead of the play, by object URL. */
  bitmaps: Map<string, ImageBitmap>;
  decoding: Map<string, Promise<ImageBitmap | null>>;
  /** What the decode window holds now; a bitmap decoded for anything else is let go. */
  wanted: Set<string>;
  retryTimer: number | null;
}

/** Frames decoded ahead of the one on screen (and one behind, for stepping back). */
const DECODE_AHEAD = 5;

/** The parts of MapLibre's ImageSource (5.x) that paint() swaps frames through. */
interface ImageSourceInside {
  image?: unknown;
  texture?: { size?: [number, number]; update(image: ImageBitmap, options?: { useMipmap?: boolean }): void } | null;
}

const state = new WeakMap<MapLibreMap, PaneState>();
/** Every pane's state, for the timeline's "is this frame here yet". */
const live = new Set<PaneState>();

/** Whether a frame can be shown at once (or has nothing to wait for). */
export function satFrameHere(time: string): boolean {
  for (const st of live) if (st.loop?.urls.has(time)) return true;
  return false;
}

/** What each pane's loop is doing, for diagnosis from the console. */
export function satLoopState(): object[] {
  return [...live].map((st) => ({
    key: st.loop?.key ?? null,
    alive: st.loop?.alive ?? null,
    queue: st.loop?.queue.length ?? 0,
    inflight: st.loop ? [...st.loop.inflight.keys()] : [],
    urls: st.loop?.urls.size ?? 0,
    sharp: st.loop?.sharp.size ?? 0,
    failed: st.loop ? [...st.loop.failed] : [],
    retiring: st.retiring?.key ?? null,
  }));
}

/** Whether a frame failed for good: a play steps past it. */
export function satFrameFailed(time: string): boolean {
  for (const st of live) {
    const loop = st.loop;
    if (loop && loop.failed.has(time) && (loop.tries.get(time) ?? 0) > FAIL_RETRIES) return true;
  }
  return false;
}

/** The satellite picture's source id, for an export waiting on it to load. */
export const SAT_IMAGE_SOURCE = SRC;

/**
 * For an export: whether this pane shows frame `time` as it will stay -- its
 * sharp picture on screen -- or "empty" when the provider has none to show.
 * `quickWillDo` accepts the quick picture (the sharp one never came).
 */
export function satFrameOnScreen(map: MapLibreMap, time: string, quickWillDo = false): "yes" | "no" | "empty" {
  const st = state.get(map);
  const loop = st?.loop;
  if (!st || !loop) return "no";
  const url = loop.urls.get(time);
  if (url === "empty" || (!url && loop.failed.has(time) && (loop.tries.get(time) ?? 0) > FAIL_RETRIES)) return "empty";
  if (!url || st.shown !== `${loop.key}|${time}|${url}`) return "no";
  return loop.sharp.has(time) || quickWillDo ? "yes" : "no";
}

let refreshTimer: number | null = null;
let panes = 0;

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/** The box and picture size for the view on screen, with its margin. */
function viewBox(map: MapLibreMap): SatBox | null {
  const b = map.getBounds();
  let west = b.getWest();
  let east = b.getEast();
  let south = Math.max(-85, b.getSouth());
  let north = Math.min(85, b.getNorth());
  const padX = (east - west) * MARGIN;
  const padY = (north - south) * MARGIN;
  west = Math.max(-180, west - padX);
  east = Math.min(180, east + padX);
  south = Math.max(-85, south - padY);
  north = Math.min(85, north + padY);
  if (!(east > west && north > south)) return null;

  const canvas = map.getCanvas();
  const scale = Math.min(window.devicePixelRatio || 1, DENSITY_CAP);
  const pxPerLon = (canvas.clientWidth * scale) / Math.max(1e-6, b.getEast() - b.getWest());
  let width = (east - west) * pxPerLon;
  // Height from the Mercator span, so a pixel is as tall as it is wide.
  let height = (width * (mercY(north) - mercY(south))) / (((east - west) * Math.PI) / 180);
  const shrink = Math.min(1, MAX_SIDE / Math.max(width, height));
  width = Math.max(64, Math.round(width * shrink));
  height = Math.max(64, Math.round(height * shrink));
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return { west: r(west), south: r(south), east: r(east), north: r(north), width, height };
}

/** Whether a loop's pictures still suit the view: they cover it, and are
 *  neither blurry at this zoom nor far finer than it can show. */
function fits(map: MapLibreMap, loop: Loop): boolean {
  const b = map.getBounds();
  const { box } = loop;
  const slackX = (box.east - box.west) * 0.02;
  const slackY = (box.north - box.south) * 0.02;
  const covered =
    b.getWest() >= box.west - slackX - (box.west <= -179.99 ? 1e9 : 0) &&
    b.getEast() <= box.east + slackX + (box.east >= 179.99 ? 1e9 : 0) &&
    b.getSouth() >= box.south - slackY - (box.south <= -84.99 ? 1e9 : 0) &&
    b.getNorth() <= box.north + slackY + (box.north >= 84.99 ? 1e9 : 0);
  if (!covered) return false;
  const canvas = map.getCanvas();
  const scale = Math.min(window.devicePixelRatio || 1, DENSITY_CAP);
  const viewDegPerPx = (b.getEast() - b.getWest()) / Math.max(1, canvas.clientWidth * scale);
  const loopDegPerPx = (box.east - box.west) / box.width;
  const ratio = loopDegPerPx / viewDegPerPx;
  // ratio > 1: each picture pixel covers more than a screen pixel (blurry).
  // A sharper picture is asked for as soon as a zoom stretches this one 20%.
  return ratio < 1.2 && ratio > 0.45;
}

/**
 * Stop a loop fetching: nothing more is asked for, and the requests under way
 * are dropped. They were left to finish before, and six of them per replaced
 * loop held every connection the browser allows to the backend -- after a few
 * moves or a product switch, even the new product's frame list waited behind
 * pictures nobody would see, and the layer sat on "Loading" for a minute.
 * `keep` spares the request for the frame on screen.
 */
function halt(loop: Loop, keep?: string): void {
  loop.queue = [];
  loop.sharpen = [];
  for (const [time, ctrl] of loop.inflight) if (time !== keep) ctrl.abort();
}

/** An object URL let go once the picture replacing it has had time to load. */
function revokeLater(url: string): void {
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function retire(loop: Loop | null): void {
  if (!loop) return;
  loop.alive = false;
  halt(loop);
  // After the swap has had time to load the new picture.
  window.setTimeout(() => {
    for (const url of loop.urls.values()) if (url !== "empty") URL.revokeObjectURL(url);
  }, 4000);
}

/** Swap a pane's loop out: it stops fetching now, and its picture stays up
 *  until the next loop's first frame replaces it. */
function replace(st: PaneState, next: Loop | null): void {
  if (st.loop) {
    retire(st.retiring);
    st.loop.alive = false;
    halt(st.loop);
    st.retiring = st.loop;
  }
  st.loop = next;
}

function reportProgress(loop: Loop | null): void {
  const s = useSatStore.getState();
  const total = loop ? s.frames.length : 0;
  const loaded = loop
    ? s.frames.reduce((n, f) => n + (loop.urls.has(f.time) || loop.failed.has(f.time) ? 1 : 0), 0)
    : 0;
  if (loaded !== s.loopLoaded || total !== s.loopTotal) s.setStatus({ loopLoaded: loaded, loopTotal: total });
}

/** The frame on screen first, then outward from it, so scrubbing nearby and
 *  the start of a play are ready soonest. */
function nearestFirst(times: (f: { time: string }) => boolean): string[] {
  const { frames, index } = useSatStore.getState();
  return frames
    .map((f, i) => ({ f, d: Math.abs(i - index) }))
    .filter((x) => times(x.f))
    .sort((a, b) => a.d - b.d)
    .map((x) => x.f.time);
}

/**
 * A frame that failed is tried again a little later, twice at most. It was
 * asked for again at once, and a frame the provider kept refusing became a
 * request loop as fast as the backend could answer.
 */
function fail(map: MapLibreMap, loop: Loop, time: string, detail: SatDetail): void {
  const tries = (loop.tries.get(time) ?? 0) + 1;
  loop.tries.set(time, tries);
  if (detail === "full" && loop.urls.has(time)) {
    // The quick picture stays up; the sharp one is asked for again later.
    if (tries > FAIL_RETRIES) {
      loop.sharp.add(time);
      return;
    }
    window.setTimeout(() => {
      if (!loop.alive) return;
      loop.sharpen.push(time);
      pump(map, loop);
    }, FAIL_RETRY_MS * tries);
    return;
  }
  loop.failed.add(time);
  if (tries > FAIL_RETRIES) return;
  window.setTimeout(() => {
    if (!loop.alive || !loop.failed.has(time)) return;
    loop.queue.push(time);
    pump(map, loop);
  }, FAIL_RETRY_MS * tries);
}

/** Frames in the order a play shows them: from where it starts -- the first
 *  frame when on the newest, else the one on screen -- to the end, then the rest. */
function playOrder(want: (f: { time: string }) => boolean): string[] {
  const { frames, index } = useSatStore.getState();
  const start = index < 0 || index >= frames.length - 1 ? 0 : index;
  return [...frames.slice(start), ...frames.slice(0, start)].filter(want).map((f) => f.time);
}

/**
 * The next frame to ask for: every frame's quick picture first (a loop runs on
 * them), then the sharp ones -- the frame on screen before the rest, unless a
 * play is moving it.
 */
function nextTime(loop: Loop): string | undefined {
  const s = useSatStore.getState();
  const current = s.frames[s.index]?.time;
  // Not playing: only the frame someone is looking at.
  const only = s.loopArmed ? undefined : current;
  while (loop.queue.length > 0) {
    const time = loop.queue.shift()!;
    if (loop.urls.has(time) || loop.inflight.has(time)) continue;
    if (only !== undefined && time !== only) continue;
    return time;
  }
  const blurry = (t: string | undefined): t is string =>
    t !== undefined && loop.urls.has(t) && !loop.sharp.has(t) && !loop.inflight.has(t);
  if (!s.playing && blurry(current)) {
    loop.sharpen = loop.sharpen.filter((t) => t !== current);
    return current;
  }
  if (!s.loopArmed || loop.quick.size > 0) return undefined;
  while (loop.sharpen.length > 0) {
    const time = loop.sharpen.shift()!;
    if (blurry(time)) return time;
  }
  return undefined;
}

function pump(map: MapLibreMap, loop: Loop): void {
  while (loop.alive && loop.inflight.size < PARALLEL) {
    const time = nextTime(loop);
    if (time === undefined) break;
    const detail: SatDetail = loop.urls.has(time) ? "full" : "coarse";
    const ctrl = new AbortController();
    loop.inflight.set(time, ctrl);
    if (detail === "coarse") {
      loop.failed.delete(time);
      loop.quick.add(time);
    }
    void (async () => {
      try {
        const res = await fetch(satImageUrl(loop.sel, time, loop.box, detail), { signal: ctrl.signal });
        if (res.status === 204) {
          // Nothing to be had: the quick picture, if any, stays.
          if (!loop.urls.has(time)) loop.urls.set(time, "empty");
          loop.sharp.add(time);
        } else if (res.ok) {
          const blob = await res.blob();
          if (!loop.alive) return;
          const before = loop.urls.get(time);
          loop.urls.set(time, URL.createObjectURL(blob));
          if (before && before !== "empty") revokeLater(before);
          if (res.headers.get("X-Sat-Detail") === "coarse") loop.sharpen.push(time);
          else loop.sharp.add(time);
        } else {
          fail(map, loop, time, detail);
        }
      } catch {
        // Dropped on purpose is not a failure.
        if (!ctrl.signal.aborted) fail(map, loop, time, detail);
      } finally {
        if (loop.inflight.get(time) === ctrl) loop.inflight.delete(time);
        if (detail === "coarse") loop.quick.delete(time);
        if (loop.alive) {
          reportProgress(loop);
          show(map);
          pump(map, loop);
        }
      }
    })();
  }
}

function selKey(sel: SatSelection): string {
  return `${sel.sat}|${sel.region}|${sel.product}`;
}

function buildLoop(map: MapLibreMap, st: PaneState, sel: SatSelection, box: SatBox): Loop {
  const product = selKey(sel);
  const key = `${product}|${box.west},${box.south},${box.east},${box.north}|${box.width}x${box.height}`;
  // A new area with nothing playing waits for play: a zoom is not a request
  // for a day of pictures.
  const before = useSatStore.getState();
  if (before.loopArmed && !before.playing) before.disarmLoop();
  const armed = useSatStore.getState().loopArmed;
  // A loop being played comes spread over its span (lib/loopOrder): the play
  // runs over all of it while the rest downloads.
  const order = armed ? spreadOrder(playOrder(() => true)) : nearestFirst(() => true);
  const loop: Loop = {
    key,
    sel,
    product,
    box,
    coords: [
      [box.west, box.north],
      [box.east, box.north],
      [box.east, box.south],
      [box.west, box.south],
    ],
    urls: new Map(),
    sharp: new Set(),
    sharpen: [],
    quick: new Set(),
    failed: new Set(),
    tries: new Map(),
    queue: order,
    inflight: new Map(),
    alive: true,
  };
  replace(st, loop);
  if (armed) {
    void prefetchSatLoop(sel, order, box).catch(() => {
      // The pictures are still fetched one by one as they are asked for.
    });
  }
  pump(map, loop);
  return loop;
}

/** Make sure there is a loop for this product and view, and draw the frame. */
function sync(map: MapLibreMap, rebuild = false): void {
  const st = state.get(map);
  if (!st || !map.getSource(SRC)) return;
  const s = useSatStore.getState();
  const sel: SatSelection = { sat: s.sat, region: s.region, product: s.product };
  const product = s.catalog ? selKey(sel) : null;
  // Another product: the old loop's frames are no use to anyone, so it stops
  // now rather than once the new product's frame list lands.
  if (st.loop && st.loop.product !== product) replace(st, null);
  if (!product || s.frames.length === 0) {
    reportProgress(st.loop);
    return;
  }
  let loop = st.loop;
  if (rebuild || !loop || !fits(map, loop)) {
    const box = viewBox(map);
    if (!box) return;
    loop = buildLoop(map, st, sel, box);
  } else {
    // New frames arriving at the head of the loop join the queue.
    const current = loop;
    for (const time of nearestFirst((f) => !current.urls.has(f.time) && !current.inflight.has(f.time))) {
      if (!current.queue.includes(time)) current.queue.push(time);
    }
    pump(map, loop);
  }
  reportProgress(loop);
  show(map);
}

/** Play pressed (the loop downloads), or the loading card stopped it. */
function applyArmed(map: MapLibreMap): void {
  const st = state.get(map);
  const loop = st?.loop;
  if (!st || !loop) return;
  const s = useSatStore.getState();
  if (!s.loopArmed) {
    halt(loop, s.frames[s.index]?.time);
    reportProgress(loop);
    return;
  }
  const missing = spreadOrder(playOrder((f) => !loop.urls.has(f.time)));
  loop.queue = missing.filter((t) => !loop.inflight.has(t));
  loop.sharpen = playOrder((f) => loop.urls.has(f.time) && !loop.sharp.has(f.time));
  void prefetchSatLoop(
    loop.sel,
    spreadOrder(playOrder((f) => !loop.sharp.has(f.time))),
    loop.box,
  ).catch(() => undefined);
  pump(map, loop);
  reportProgress(loop);
}

/** A frame decoded to a bitmap, off the main thread; one decode per URL. */
function decode(st: PaneState, url: string): Promise<ImageBitmap | null> {
  const have = st.bitmaps.get(url);
  if (have) return Promise.resolve(have);
  let pending = st.decoding.get(url);
  if (!pending) {
    pending = fetch(url)
      .then((res) => res.blob())
      .then((blob) => createImageBitmap(blob, { premultiplyAlpha: "premultiply" }))
      .then((bitmap) => {
        st.decoding.delete(url);
        // Left the window while decoding (or the pane went): not kept.
        if (!st.wanted.has(url) && url !== st.shownUrl) {
          bitmap.close();
          return null;
        }
        st.bitmaps.set(url, bitmap);
        return bitmap;
      })
      .catch(() => {
        st.decoding.delete(url);
        return null;
      });
    st.decoding.set(url, pending);
  }
  return pending;
}

/** Decode the frames a play reaches next; let go of the rest. */
function decodeAhead(st: PaneState, loop: Loop): void {
  const { frames, index } = useSatStore.getState();
  const n = frames.length;
  const want = new Set<string>();
  // The one before, this one, and the ones the play will show -- at high
  // speeds not the next in a row.
  const at = n > 0 ? [(index - 1 + n) % n, index, ...upcomingFrames("sat", index, n, DECODE_AHEAD)] : [];
  for (const i of at) {
    const f = frames[i];
    const url = f ? loop.urls.get(f.time) : undefined;
    if (url && url !== "empty") want.add(url);
  }
  st.wanted = want;
  for (const [url, bitmap] of st.bitmaps) {
    if (!want.has(url) && url !== st.shownUrl) {
      bitmap.close();
      st.bitmaps.delete(url);
    }
  }
  for (const url of want) void decode(st, url);
}

function dropBitmaps(st: PaneState): void {
  st.wanted = new Set();
  st.shownUrl = "";
  for (const bitmap of st.bitmaps.values()) bitmap.close();
  st.bitmaps.clear();
  if (st.retryTimer != null) window.clearTimeout(st.retryTimer);
  st.retryTimer = null;
}

/**
 * Put a frame on screen. The first frame of a loop (a new view or product)
 * goes through the image source as usual, which lays it over the loop's box.
 * After that each frame, decoded ahead off the main thread, is copied into
 * the picture's one texture in place. MapLibre's updateImage decoded every
 * frame on the main thread as it uploaded it and made a new 8-12 MB texture
 * each time, leaving the last one to the garbage collector: a play ran for a
 * few seconds, froze for a second and a half, and went on like that
 * (Pablo, 2026-09-26). Returns whether the frame is on screen.
 */
function paint(map: MapLibreMap, st: PaneState, loop: Loop, url: string): boolean {
  const src = map.getSource(SRC) as ImageSource | undefined;
  if (!src) return false;
  if (st.placed === loop.key) {
    if (!src.loaded()) {
      // The loop's first frame is still loading: this one follows it.
      later(map, st);
      return false;
    }
    const bitmap = st.bitmaps.get(url);
    if (!bitmap) {
      void decode(st, url).then((got) => {
        if (got && state.get(map) === st) show(map);
      });
      return false;
    }
    const inside = src as unknown as ImageSourceInside;
    const tex = inside.texture;
    if (!tex || (tex.size && tex.size[0] === bitmap.width && tex.size[1] === bitmap.height)) {
      // With no texture yet, the source makes one from this bitmap.
      inside.image = bitmap;
      if (tex) tex.update(bitmap, { useMipmap: false });
      st.shownUrl = url;
      map.triggerRepaint();
      return true;
    }
  }
  src.updateImage({ url, coordinates: loop.coords as never });
  st.placed = loop.key;
  st.shownUrl = url;
  return true;
}

/** Try the frame on screen again shortly (once, however often asked). */
function later(map: MapLibreMap, st: PaneState): void {
  if (st.retryTimer != null) return;
  st.retryTimer = window.setTimeout(() => {
    st.retryTimer = null;
    if (state.get(map) === st) show(map);
  }, 50);
}

function show(map: MapLibreMap): void {
  const st = state.get(map);
  const loop = st?.loop;
  const src = map.getSource(SRC) as ImageSource | undefined;
  if (!st || !loop || !src) return;
  const s = useSatStore.getState();
  const frame = s.frames[s.index];
  if (!frame) return;
  const url = loop.urls.get(frame.time);
  if (url && url !== "empty") {
    // The URL is part of it: the sharp picture replaces the quick one.
    const shown = `${loop.key}|${frame.time}|${url}`;
    if (st.shown !== shown && paint(map, st, loop, url)) {
      st.shown = shown;
      if (st.retiring) {
        retire(st.retiring);
        st.retiring = null;
      }
    }
    decodeAhead(st, loop);
    if (s.busy) s.setStatus({ busy: false });
    if (!loop.sharp.has(frame.time)) pump(map, loop);
    return;
  }
  if (url === "empty" || loop.failed.has(frame.time)) {
    // Listed but not published, or not to be had right now: the last picture
    // stays up rather than a blank, and a play does not wait on it.
    if (s.busy) s.setStatus({ busy: false });
    return;
  }
  // Not in yet: to the front of the queue.
  const at = loop.queue.indexOf(frame.time);
  if (at > 0) {
    loop.queue.splice(at, 1);
    loop.queue.unshift(frame.time);
  } else if (at < 0 && !loop.inflight.has(frame.time)) {
    loop.queue.unshift(frame.time);
  }
  if (!s.busy) s.setStatus({ busy: true });
  pump(map, loop);
}

function applyLabels(map: MapLibreMap): void {
  // The analyses draw their own names, with values; two sets would collide.
  const obsNames =
    (useAppStore.getState().layers["observations"]?.visible ?? false) && useObsStore.getState().showPlaces;
  setRefLabelsVisible(map, LABEL_PREFIX, !obsNames);
}

/**
 * Geostationary and polar-orbiting satellite imagery -- GOES-East and -West,
 * Himawari-9, Meteosat-12, -9 and -11, NOAA-20 and -21, Metop-B and -C -- by
 * region and product, looped on the app's timeline.
 */
export const satelliteLayer: LayerModule = {
  id: "satellite",
  name: "Satellite",
  description:
    "GOES, Himawari and Meteosat loops by region -- every band, the RGB composites and the GOES Level 2 products -- and NOAA-20/21 and Metop passes.",
  category: "weather",
  source: "NOAA (Google Cloud, AWS), RAMMB/CIRA SLIDER, EUMETSAT EUMETView, NASA GIBS",
  defaultVisible: false,
  // Opaque: at 90% the basemap's blue sea showed through and tinted the picture.
  defaultOpacity: DEFAULT_OPACITY,

  async addTo(map) {
    if (!map.getSource(SRC)) {
      map.addSource(SRC, {
        type: "image",
        url: BLANK,
        coordinates: [
          [-179, 80],
          [179, 80],
          [179, -80],
          [-179, -80],
        ] as never,
      });
    }
    if (!map.getLayer(LAYER)) {
      map.addLayer({
        id: LAYER,
        type: "raster",
        source: SRC,
        paint: { "raster-opacity": DEFAULT_OPACITY, "raster-fade-duration": 0, "raster-resampling": "linear" },
      });
    }
    // Names over the picture: opaque imagery otherwise hides the basemap's.
    addRefLabels(map, LABEL_PREFIX);
    holdBasemapLabels(map, "satellite", true);
    applyLabels(map);

    const unsubSat = useSatStore.subscribe((s, prev) => {
      if (
        s.sat !== prev.sat ||
        s.region !== prev.region ||
        s.product !== prev.product ||
        s.frames !== prev.frames ||
        s.catalog !== prev.catalog
      )
        sync(map);
      else if (s.index !== prev.index) show(map);
      if (s.loopArmed !== prev.loopArmed) applyArmed(map);
    });
    const unsubObs = useObsStore.subscribe((s, prev) => {
      if (s.showPlaces !== prev.showPlaces) applyLabels(map);
    });
    const unsubApp = useAppStore.subscribe((s, prev) => {
      if (s.layers["observations"]?.visible !== prev.layers["observations"]?.visible) applyLabels(map);
    });
    const onMove = () => {
      const st = state.get(map);
      if (!st) return;
      if (st.moveTimer != null) window.clearTimeout(st.moveTimer);
      st.moveTimer = window.setTimeout(() => {
        st.moveTimer = null;
        sync(map);
      }, MOVE_SETTLE_MS);
    };
    map.on("moveend", onMove);
    map.on("resize", onMove);

    const pane: PaneState = {
      loop: null,
      retiring: null,
      shown: "",
      unsub: () => {
        unsubSat();
        unsubObs();
        unsubApp();
      },
      onMove,
      moveTimer: null,
      opacity: DEFAULT_OPACITY,
      placed: "",
      shownUrl: "",
      bitmaps: new Map(),
      decoding: new Map(),
      wanted: new Set(),
      retryTimer: null,
    };
    state.set(map, pane);
    live.add(pane);

    // New images arrive every five to fifteen minutes; a loop left open grows
    // with them rather than going stale.
    panes += 1;
    if (refreshTimer == null) {
      refreshTimer = window.setInterval(() => {
        const s = useSatStore.getState();
        // With nothing loaded -- the backend was busy or starting -- start over.
        if (!s.catalog || s.frames.length === 0) void s.load();
        else void s.loadFrames(true);
      }, REFRESH_MS);
    }

    await useSatStore.getState().load();
    sync(map);
  },

  removeFrom(map) {
    const st = state.get(map);
    if (st) {
      st.unsub();
      map.off("moveend", st.onMove);
      map.off("resize", st.onMove);
      if (st.moveTimer != null) window.clearTimeout(st.moveTimer);
      retire(st.loop);
      retire(st.retiring);
      dropBitmaps(st);
      state.delete(map);
      live.delete(st);
      panes = Math.max(0, panes - 1);
    }
    removeRefLabels(map, LABEL_PREFIX);
    holdBasemapLabels(map, "satellite", false);
    if (map.getLayer(LAYER)) map.removeLayer(LAYER);
    if (map.getSource(SRC)) map.removeSource(SRC);
    if (panes === 0 && refreshTimer != null) {
      window.clearInterval(refreshTimer);
      refreshTimer = null;
    }
    useSatStore.getState().setStatus({ busy: false, loopLoaded: 0, loopTotal: 0 });
  },

  setOpacity(map, opacity) {
    const st = state.get(map);
    if (st) st.opacity = opacity;
    if (map.getLayer(LAYER)) map.setPaintProperty(LAYER, "raster-opacity", opacity);
  },

  getLayerIds() {
    return ALL;
  },
};
