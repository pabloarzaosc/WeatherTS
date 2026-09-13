import type { Map as MapLibreMap, MapSourceDataEvent } from "maplibre-gl";

import type { LayerModule } from "../types";
import { satTiles, type SatFrame, type SatProduct } from "../../lib/satellite";
import { selectSatProduct, useSatStore } from "../../store/useSatStore";

/**
 * Satellite loops as a pool of raster sources, one per frame.
 *
 * Swapping one source's tile URL for each frame blanks the map while the new
 * tiles arrive, which reads as a flicker on every step of a loop. Instead the
 * frame on screen and its neighbours each have their own source, drawn at zero
 * opacity so MapLibre fetches their tiles in advance; stepping is then a change
 * of opacity, and the next frame is shown only once its tiles are in.
 *
 * Every frame layer goes in just under a fixed, empty anchor layer, so the
 * whole pool keeps the module's place in the layer order however many frames
 * come and go.
 */

const ANCHOR = "sat-anchor";
const ANCHOR_SRC = "sat-anchor-src";
const DEFAULT_OPACITY = 0.9;
/** Frames either side of the one on screen to have loaded before they are needed. */
const AHEAD = 3;
const BEHIND = 2;
/** Shown anyway after this long: a tile server that never answers one tile
 *  must not freeze the loop. */
const GIVE_UP_MS = 6000;
/** How often a waiting frame is checked. MapLibre's sourcedata event for the
 *  last tile fires before the source counts as loaded, so the event alone
 *  left every frame waiting for the give-up timer. */
const POLL_MS = 80;
const REFRESH_MS = 60_000;

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

interface Entry {
  src: string;
  layer: string;
}

interface PaneState {
  pool: Map<string, Entry>;
  /** The frame whose layer is visible. */
  shown: string | null;
  /** The frame waiting for its tiles before it is shown. */
  wanted: string | null;
  opacity: number;
  giveUp: number | null;
  poll: number | null;
  /** Sources that have had a tile arrive. A source added a moment ago counts as
   *  "loaded" before it has asked for anything, which would show a blank frame. */
  tiled: Set<string>;
  unsub: () => void;
  onData: (e: MapSourceDataEvent) => void;
}
const state = new WeakMap<MapLibreMap, PaneState>();
/** Every frame layer on any map, for the manager's z-ordering. */
const liveIds = new Set<string>();

let refreshTimer: number | null = null;
let panes = 0;

function keyOf(product: SatProduct, frame: SatFrame): string {
  return `${product.id}|${frame.time}`;
}

let serial = 0;
const idOf = new Map<string, number>();
function entryFor(key: string): Entry {
  let n = idOf.get(key);
  if (n == null) {
    n = ++serial;
    idOf.set(key, n);
  }
  return { src: `sat-src-${n}`, layer: `sat-frame-${n}` };
}

function ensure(map: MapLibreMap, st: PaneState, product: SatProduct, frame: SatFrame): Entry {
  const key = keyOf(product, frame);
  const have = st.pool.get(key);
  if (have && map.getLayer(have.layer)) return have;
  const entry = entryFor(key);
  if (!map.getSource(entry.src)) {
    map.addSource(entry.src, {
      type: "raster",
      tiles: [satTiles(product, frame)],
      tileSize: product.tileSize,
      maxzoom: product.maxzoom,
      attribution: product.attribution,
    });
  }
  if (!map.getLayer(entry.layer)) {
    map.addLayer(
      {
        id: entry.layer,
        type: "raster",
        source: entry.src,
        paint: {
          "raster-opacity": 0,
          "raster-fade-duration": 0,
          "raster-resampling": "linear",
        },
      },
      map.getLayer(ANCHOR) ? ANCHOR : undefined,
    );
  }
  st.pool.set(key, entry);
  liveIds.add(entry.layer);
  return entry;
}

function drop(map: MapLibreMap, st: PaneState, key: string): void {
  const entry = st.pool.get(key);
  if (!entry) return;
  if (map.getLayer(entry.layer)) map.removeLayer(entry.layer);
  if (map.getSource(entry.src)) map.removeSource(entry.src);
  st.pool.delete(key);
  st.tiled.delete(entry.src);
  liveIds.delete(entry.layer);
}

function ready(map: MapLibreMap, st: PaneState, entry: Entry): boolean {
  return st.tiled.has(entry.src) && map.isSourceLoaded(entry.src);
}

function stopWaiting(st: PaneState): void {
  if (st.giveUp != null) window.clearTimeout(st.giveUp);
  if (st.poll != null) window.clearInterval(st.poll);
  st.giveUp = null;
  st.poll = null;
}

function show(map: MapLibreMap, st: PaneState, key: string): void {
  stopWaiting(st);
  for (const [k, entry] of st.pool) {
    if (map.getLayer(entry.layer)) {
      map.setPaintProperty(entry.layer, "raster-opacity", k === key ? st.opacity : 0);
    }
  }
  st.shown = key;
  st.wanted = null;
  useSatStore.getState().setStatus({ busy: false });
}

function sync(map: MapLibreMap): void {
  const st = state.get(map);
  if (!st || !map.getLayer(ANCHOR)) return;
  const s = useSatStore.getState();
  const product = selectSatProduct(s);
  const frame = s.frames[s.index];
  if (!product || !frame) return;

  const want = keyOf(product, frame);
  const keep = new Set<string>([want]);
  ensure(map, st, product, frame);
  // Neighbours only once the frame asked for is on screen. Loading six frames
  // at once made the one someone is waiting for share the browser's handful of
  // connections per tile server with five nobody is looking at yet -- measured
  // 6.5 s to the first picture, against about 2 s for the frame alone.
  const settled = st.shown === want || ready(map, st, st.pool.get(want)!);
  for (let d = 1; settled && d <= AHEAD; d++) {
    const next = s.frames[s.index + d] ?? (s.index + d >= s.frames.length ? s.frames[s.index + d - s.frames.length] : undefined);
    if (next) {
      ensure(map, st, product, next);
      keep.add(keyOf(product, next));
    }
    if (d <= BEHIND && s.frames[s.index - d]) {
      ensure(map, st, product, s.frames[s.index - d]);
      keep.add(keyOf(product, s.frames[s.index - d]));
    }
  }
  // What is on screen stays until its replacement is ready, even from another product.
  if (st.shown) keep.add(st.shown);
  for (const key of [...st.pool.keys()]) if (!keep.has(key)) drop(map, st, key);

  if (st.shown === want) {
    show(map, st, want);
    return;
  }
  const entry = st.pool.get(want)!;
  if (ready(map, st, entry)) {
    show(map, st, want);
    sync(map); // now that it is shown, the frame it replaced can go
    return;
  }
  if (st.wanted === want && st.poll != null) return; // already waiting for it
  stopWaiting(st);
  st.wanted = want;
  useSatStore.getState().setStatus({ busy: true });
  const reveal = () => {
    if (st.wanted !== want) return;
    show(map, st, want);
    sync(map); // the neighbours, and letting the old frame go
  };
  st.poll = window.setInterval(() => {
    const e = st.pool.get(want);
    if (!e || !map.getSource(e.src)) return stopWaiting(st);
    if (ready(map, st, e)) reveal();
  }, POLL_MS);
  st.giveUp = window.setTimeout(reveal, GIVE_UP_MS);
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
  defaultOpacity: DEFAULT_OPACITY,

  async addTo(map) {
    if (!map.getSource(ANCHOR_SRC)) map.addSource(ANCHOR_SRC, { type: "geojson", data: EMPTY });
    if (!map.getLayer(ANCHOR)) map.addLayer({ id: ANCHOR, type: "line", source: ANCHOR_SRC });

    const onData = (e: MapSourceDataEvent) => {
      const st = state.get(map);
      if (!st || !e.sourceId?.startsWith("sat-src-")) return;
      if (e.tile) st.tiled.add(e.sourceId);
    };
    map.on("sourcedata", onData);

    const unsub = useSatStore.subscribe((s, prev) => {
      if (s.product !== prev.product || s.index !== prev.index || s.frames !== prev.frames || s.catalog !== prev.catalog) {
        sync(map);
      }
    });
    state.set(map, {
      pool: new Map(),
      shown: null,
      wanted: null,
      opacity: DEFAULT_OPACITY,
      giveUp: null,
      poll: null,
      tiled: new Set(),
      unsub,
      onData,
    });

    // New images arrive every five to fifteen minutes; a loop left open should
    // grow with them rather than go stale.
    panes += 1;
    if (refreshTimer == null) {
      refreshTimer = window.setInterval(() => void useSatStore.getState().loadFrames(true), REFRESH_MS);
    }

    await useSatStore.getState().load();
    sync(map);
  },

  removeFrom(map) {
    const st = state.get(map);
    if (st) {
      st.unsub();
      map.off("sourcedata", st.onData);
      stopWaiting(st);
      for (const key of [...st.pool.keys()]) drop(map, st, key);
      state.delete(map);
      panes = Math.max(0, panes - 1);
    }
    if (map.getLayer(ANCHOR)) map.removeLayer(ANCHOR);
    if (map.getSource(ANCHOR_SRC)) map.removeSource(ANCHOR_SRC);
    if (panes === 0 && refreshTimer != null) {
      window.clearInterval(refreshTimer);
      refreshTimer = null;
    }
    useSatStore.getState().setStatus({ busy: false });
  },

  setOpacity(map, opacity) {
    const st = state.get(map);
    if (!st) return;
    st.opacity = opacity;
    const entry = st.shown ? st.pool.get(st.shown) : undefined;
    if (entry && map.getLayer(entry.layer)) map.setPaintProperty(entry.layer, "raster-opacity", opacity);
  },

  getLayerIds() {
    return [...liveIds, ANCHOR];
  },
};
