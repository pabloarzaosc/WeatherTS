import type { ImageSource, Map as MapLibreMap } from "maplibre-gl";

import type { LayerModule } from "../types";
import { prefetchSatLoop, satImageUrl, type SatBox } from "../../lib/satellite";
import { holdBasemapLabels } from "../../map/basemapLabels";
import { useAppStore } from "../../store/useAppStore";
import { useObsStore } from "../../store/useObsStore";
import { selectSatProduct, useSatStore } from "../../store/useSatStore";
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
 */

const SRC = "sat-img-src";
const LAYER = "sat-img";
const LABEL_PREFIX = "sat";
const ALL = [LAYER, ...refLabelIds(LABEL_PREFIX)];

const DEFAULT_OPACITY = 1;
/** Pictures pulled from the backend at once: the browser's own limit per host. */
const PARALLEL = 6;
/** Margin around the view, as a share of its width and height, each side. */
const MARGIN = 0.15;
/** A day at 1280 px measured 9.5 s (17 MB); larger pictures grew the bytes, and
 *  the bytes are what bound a loop's time. */
const MAX_SIDE = 1280;
/**
 * Loop pictures are made a little coarser than the screen. Bandwidth bounds a
 * day's loop, not the servers: at full screen resolution with a wider margin a
 * day of GOES-East was 30 MB and 26 s; at 85% with this margin it was 137 frames
 * in 6 s. The map stretches the picture smoothly rather than into squares.
 */
const LOOP_SCALE = 0.85;
const MOVE_SETTLE_MS = 380;
const FAIL_RETRIES = 2;
const FAIL_RETRY_MS = 4000;
const REFRESH_MS = 60_000;

const BLANK =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

interface Loop {
  key: string;
  product: string;
  box: SatBox;
  coords: [number, number][];
  /** time -> object URL, or "empty" for a time the provider has not filled in yet. */
  urls: Map<string, string>;
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
}

const state = new WeakMap<MapLibreMap, PaneState>();
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
  const scale = Math.min(window.devicePixelRatio || 1, 1.25) * LOOP_SCALE;
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
  const scale = Math.min(window.devicePixelRatio || 1, 1.25) * LOOP_SCALE;
  const viewDegPerPx = (b.getEast() - b.getWest()) / Math.max(1, canvas.clientWidth * scale);
  const loopDegPerPx = (box.east - box.west) / box.width;
  const ratio = loopDegPerPx / viewDegPerPx;
  // ratio > 1: each picture pixel covers more than a screen pixel (blurry).
  return ratio < 1.7 && ratio > 0.35;
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
  for (const [time, ctrl] of loop.inflight) if (time !== keep) ctrl.abort();
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
function fail(map: MapLibreMap, loop: Loop, time: string): void {
  loop.failed.add(time);
  const tries = (loop.tries.get(time) ?? 0) + 1;
  loop.tries.set(time, tries);
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

function pump(map: MapLibreMap, loop: Loop): void {
  const s = useSatStore.getState();
  // Not playing: only the frame someone is looking at.
  const only = s.loopArmed ? undefined : s.frames[s.index]?.time;
  while (loop.alive && loop.inflight.size < PARALLEL && loop.queue.length > 0) {
    const time = loop.queue.shift()!;
    if (loop.urls.has(time) || loop.inflight.has(time)) continue;
    if (!s.loopArmed && time !== only) continue;
    const ctrl = new AbortController();
    loop.inflight.set(time, ctrl);
    loop.failed.delete(time);
    void (async () => {
      try {
        const res = await fetch(satImageUrl(loop.product, time, loop.box), { signal: ctrl.signal });
        if (res.status === 204) {
          loop.urls.set(time, "empty");
        } else if (res.ok) {
          const blob = await res.blob();
          if (!loop.alive) return;
          loop.urls.set(time, URL.createObjectURL(blob));
        } else {
          fail(map, loop, time);
        }
      } catch {
        // Dropped on purpose is not a failure.
        if (!ctrl.signal.aborted) fail(map, loop, time);
      } finally {
        if (loop.inflight.get(time) === ctrl) loop.inflight.delete(time);
        if (loop.alive) {
          reportProgress(loop);
          show(map);
          pump(map, loop);
        }
      }
    })();
  }
}

function buildLoop(map: MapLibreMap, st: PaneState, product: string, box: SatBox): Loop {
  const key = `${product}|${box.west},${box.south},${box.east},${box.north}|${box.width}x${box.height}`;
  // A new area with nothing playing waits for play: a zoom is not a request
  // for a day of pictures.
  const before = useSatStore.getState();
  if (before.loopArmed && !before.playing) before.disarmLoop();
  const armed = useSatStore.getState().loopArmed;
  const order = armed ? playOrder(() => true) : nearestFirst(() => true);
  const loop: Loop = {
    key,
    product,
    box,
    coords: [
      [box.west, box.north],
      [box.east, box.north],
      [box.east, box.south],
      [box.west, box.south],
    ],
    urls: new Map(),
    failed: new Set(),
    tries: new Map(),
    queue: order,
    inflight: new Map(),
    alive: true,
  };
  replace(st, loop);
  if (armed) {
    void prefetchSatLoop(product, order, box).catch(() => {
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
  const product = selectSatProduct(s);
  // Another product: the old loop's frames are no use to anyone, so it stops
  // now rather than once the new product's frame list lands.
  if (st.loop && st.loop.product !== product?.id) replace(st, null);
  if (!product || s.frames.length === 0) {
    reportProgress(st.loop);
    return;
  }
  let loop = st.loop;
  if (rebuild || !loop || !fits(map, loop)) {
    const box = viewBox(map);
    if (!box) return;
    loop = buildLoop(map, st, product.id, box);
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
  const missing = playOrder((f) => !loop.urls.has(f.time));
  loop.queue = missing.filter((t) => !loop.inflight.has(t));
  void prefetchSatLoop(loop.product, missing, loop.box).catch(() => undefined);
  pump(map, loop);
  reportProgress(loop);
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
    const shown = `${loop.key}|${frame.time}`;
    if (st.shown !== shown) {
      src.updateImage({ url, coordinates: loop.coords as never });
      st.shown = shown;
      if (st.retiring) {
        retire(st.retiring);
        st.retiring = null;
      }
    }
    if (s.busy) s.setStatus({ busy: false });
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
 * Geostationary and polar-orbiting satellite imagery: GOES-East, GOES-West,
 * Himawari, Meteosat MTG and MSG, Metop, VIIRS, MODIS and Sentinel-3, looped on
 * the app's timeline.
 */
export const satelliteLayer: LayerModule = {
  id: "satellite",
  name: "Satellite",
  description:
    "Geostationary loops from GOES, Himawari and Meteosat, and polar passes from Metop, VIIRS, MODIS and Sentinel-3.",
  category: "weather",
  source: "NASA GIBS, NOAA nowCOAST, EUMETSAT EUMETView",
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
      if (s.product !== prev.product || s.frames !== prev.frames || s.catalog !== prev.catalog) sync(map);
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

    state.set(map, {
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
    });

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
      state.delete(map);
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
