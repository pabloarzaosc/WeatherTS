import type { ImageSource, Map as MapLibreMap } from "maplibre-gl";
import type { LayerModule } from "../types";
import { BACKEND_BASE } from "../../lib/apiConfig";
import { useMrmsStore } from "../../store/useMrmsStore";

/**
 * MRMS — the national mosaic, as a single image layer.
 *
 * Every radar in the country merged onto one 0.01 degree grid: the layer that
 * answers "where is the hail swath across three states" rather than "what is
 * this one radar seeing". A hundred products share this one layer, because the
 * map only ever draws one grid at a time.
 *
 * An image source rather than a mesh or tiles. The backend hands over a PNG
 * already warped into Mercator (see mrms_core._mercator_rows), so the four
 * corners MapLibre stretches it between are exact -- a grid drawn in even
 * degrees would be out by a couple of hundred kilometres in the middle of
 * CONUS, which is the whole reason the warp happens server-side.
 */

const SRC = "mrms-src";
const LAYER = "mrms-layer";

// A transparent 1x1, so the source exists before the first frame lands. An
// image source cannot be created without an image, and creating it late means
// racing the layer order pass. (The previous one inflated to 3 bytes where an
// RGBA pixel needs 5, so every add logged "The source image could not be
// decoded"; this one was built with its row and checksums computed.)
const BLANK =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

const CONUS: [[number, number], [number, number], [number, number], [number, number]] = [
  [-130, 55],
  [-60, 55],
  [-60, 20],
  [-130, 20],
];

let token = 0;
let opacityNow = 0.85;
/** The window the image on screen was cut for, so a small pan does not refetch. */
let servedFor: { w: number; s: number; e: number; n: number; zoom: number } | null = null;
let moveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The window to ask the backend for.
 *
 * Padded by a third of the view so a nudge of the map does not fall off the
 * edge of the image before the next request lands, and clamped to the domain
 * so a view over the Atlantic does not ask for a crop that is all ocean.
 */
function viewBox(map: MapLibreMap): { w: number; s: number; e: number; n: number } {
  const b = map.getBounds();
  const padX = (b.getEast() - b.getWest()) / 3;
  const padY = (b.getNorth() - b.getSouth()) / 3;
  const dom = useMrmsStore.getState().meta?.domain;
  const box = {
    w: b.getWest() - padX,
    s: b.getSouth() - padY,
    e: b.getEast() + padX,
    n: b.getNorth() + padY,
  };
  if (dom) {
    box.w = Math.max(box.w, dom[0]);
    box.s = Math.max(box.s, dom[1]);
    box.e = Math.min(box.e, dom[2]);
    box.n = Math.min(box.n, dom[3]);
  }
  return box;
}

/** Whether the view has moved far enough out of the served window to be worth
 *  cutting a new one. A pan inside the padding is already covered. */
function needsRecut(map: MapLibreMap): boolean {
  if (!servedFor) return true;
  const b = map.getBounds();
  if (
    b.getWest() < servedFor.w ||
    b.getEast() > servedFor.e ||
    b.getSouth() < servedFor.s ||
    b.getNorth() > servedFor.n
  ) {
    return true;
  }
  // Zooming in without panning stays inside the window but wants more detail.
  return map.getZoom() - servedFor.zoom >= 1;
}

async function load(map: MapLibreMap): Promise<void> {
  const store = useMrmsStore.getState();
  const mine = ++token;

  store.setLoading(true);
  store.setError(null);
  try {
    const box = viewBox(map);
    const params = new URLSearchParams({
      product: store.product,
      region: store.region,
      bbox: `${box.w.toFixed(3)},${box.s.toFixed(3)},${box.e.toFixed(3)},${box.n.toFixed(3)}`,
      // Enough to cover a large screen at 2x without exceeding the texture
      // size a browser is guaranteed to accept.
      width: "2600",
    });
    if (store.frameKey) params.set("key", store.frameKey);
    const res = await fetch(`${BACKEND_BASE}/api/mrms/render?${params}`);
    if (!res.ok) throw new Error(`MRMS HTTP ${res.status}`);
    const json = (await res.json()) as {
      image: string;
      coordinates: [number, number][];
      meta: Parameters<typeof store.setMeta>[0];
    };
    // A product switched while this was in flight would otherwise paint the
    // old grid over the new one, and the colour bar would disagree with it.
    if (mine !== token) return;

    const src = map.getSource(SRC) as ImageSource | undefined;
    if (!src) return;
    src.updateImage({
      url: `data:image/png;base64,${json.image}`,
      coordinates: json.coordinates as never,
    });
    servedFor = { ...box, zoom: map.getZoom() };
    useMrmsStore.getState().setMeta(json.meta);
  } catch (err) {
    if (mine === token) useMrmsStore.getState().setError((err as Error).message);
  } finally {
    if (mine === token) useMrmsStore.getState().setLoading(false);
  }
}

async function loadFrames(): Promise<void> {
  const store = useMrmsStore.getState();
  try {
    const res = await fetch(
      `${BACKEND_BASE}/api/mrms/frames?product=${encodeURIComponent(store.product)}` +
        `&region=${encodeURIComponent(store.region)}&limit=60`,
    );
    if (!res.ok) return;
    const json = (await res.json()) as { frames: { key: string; unix: number }[] };
    const now = useMrmsStore.getState();
    if (now.product === store.product && now.region === store.region) store.setFrames(json.frames);
  } catch {
    /* the newest frame still renders without a frame list */
  }
}

let unsub: (() => void) | null = null;
let onMove: (() => void) | null = null;

export const mrmsLayer: LayerModule = {
  id: "mrms",
  name: "MRMS mosaic",
  description:
    "The national multi-radar mosaic — reflectivity, hail, rotation tracks, QPE and flash-flood guidance on one 1 km grid.",
  category: "weather",
  source: "NOAA MRMS",
  defaultVisible: false,
  defaultOpacity: 0.85,

  async addTo(map) {
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: "image", url: BLANK, coordinates: CONUS as never });
    }
    if (!map.getLayer(LAYER)) {
      map.addLayer({
        id: LAYER,
        type: "raster",
        source: SRC,
        paint: { "raster-opacity": opacityNow, "raster-resampling": "linear" },
      });
    }

    void useMrmsStore.getState().loadCatalog();
    servedFor = null;
    void load(map);
    void loadFrames();

    // Re-cut on move, but only once the map has settled and only when the view
    // has actually left what is already drawn -- otherwise every frame of a
    // drag would queue a render of 24 million points.
    onMove = () => {
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        if (map.getLayer(LAYER) && needsRecut(map)) void load(map);
      }, 250);
    };
    map.on("moveend", onMove);

    // Product and frame both come from the picker, and both mean "replace what
    // is on screen". Subscribing here rather than in the UI keeps the fetch
    // with the layer that owns the image.
    unsub?.();
    const sig = (s: { product: string; region: string; frameKey: string }) =>
      `${s.product}|${s.region}|${s.frameKey}`;
    let last = sig(useMrmsStore.getState());
    unsub = useMrmsStore.subscribe((s) => {
      const now = sig(s);
      if (now === last) return;
      // The frame list belongs to a product AND a region; either moving means
      // the old list is filenames from a directory nobody is reading now.
      const listChanged = now.split("|").slice(0, 2).join("|") !== last.split("|").slice(0, 2).join("|");
      last = now;
      if (!map.getLayer(LAYER)) return;
      servedFor = null;
      void load(map);
      if (listChanged) void loadFrames();
    });
  },

  removeFrom(map) {
    token++; // orphan anything still in flight
    unsub?.();
    unsub = null;
    if (onMove) map.off("moveend", onMove);
    onMove = null;
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = null;
    servedFor = null;
    if (map.getLayer(LAYER)) map.removeLayer(LAYER);
    if (map.getSource(SRC)) map.removeSource(SRC);
    useMrmsStore.getState().setMeta(null);
  },

  setOpacity(map, opacity) {
    opacityNow = opacity;
    if (map.getLayer(LAYER)) map.setPaintProperty(LAYER, "raster-opacity", opacity);
  },

  getLayerIds() {
    return [LAYER];
  },
};
