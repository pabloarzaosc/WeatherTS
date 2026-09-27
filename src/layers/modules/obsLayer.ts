import type {
  ExpressionSpecification,
  FilterSpecification,
  GeoJSONSource,
  ImageSource,
  Map as MapLibreMap,
  MapStyleImageMissingEvent,
} from "maplibre-gl";

import type { LayerModule } from "../types";
import {
  fetchObsMeta,
  fetchObsVectors,
  obsDensity,
  obsImageUrl,
  obsViewUrl,
  fetchObsLoopStatus,
  prefetchObsLoop,
  type ObsBarbs,
  type ObsRender,
  type ObsVectors,
  fetchObsTracks,
  isTrackSource,
  type ObsTracks,
} from "../../lib/observations";
import { allMaps, getMap } from "../../map/mapInstance";
import { VECTOR_SOURCE } from "../../map/basemaps";
import { obsFramesFailed, obsFramesHere, useObsStore } from "../../store/useObsStore";
import { spreadOrder } from "../../lib/loopOrder";
import { attachPlaces, PLACE_LAYER_IDS, placesFor } from "./obsPlaces";

const SRC = "obs-src";
const DETAIL_SRC = "obs-detail-src";
const EDGE_SRC = "obs-edge-src";
const BARBS_SRC = "obs-barbs-src";
const LAYER = "obs-raster";
const DETAIL = "obs-detail";
const EDGE = "obs-edge";
/**
 * The pressure map, for the products that carry sea-level pressure: isobars
 * and the highs and lows a surface chart is read by. It was a category of its
 * own; it belongs on the products that have the field.
 */
/** Black lines where a second variable crosses a level: the UH > 75 swaths
 *  over reflectivity. */
const OUTLINE_SRC = "obs-outline-src";
const OUTLINE = "obs-outline";
/** The ATCF guidance: each model's track, its positions, where each is at the
 *  timeline's hour, and the storm's own path so far. */
const TRACK_SRC = "obs-track-src";
const TRACK_PT_SRC = "obs-trackpt-src";
const TRACK_BEST_SRC = "obs-trackbest-src";
const TRACK = "obs-track";
const TRACK_PT = "obs-trackpt";
const TRACK_NOW = "obs-tracknow";
const TRACK_LABEL = "obs-tracklabel";
const TRACK_BEST = "obs-trackbest";
const TRACK_IDS = [TRACK_BEST, TRACK, TRACK_PT, TRACK_NOW, TRACK_LABEL];
const TRACK_SRCS = [TRACK_SRC, TRACK_PT_SRC, TRACK_BEST_SRC];
/** Saffir-Simpson colours, for the intensity view (the same as the scale). */
const SS_COLOUR: ExpressionSpecification = [
  "match", ["get", "cat"],
  "TD", "#9ed1f0", "TS", "#5cbf5c", "C1", "#f2d23c", "C2", "#f0a83c", "C3", "#e4552e", "C4", "#c02a5a",
  "#8e2a9e",
];
const ISO_SRC = "obs-iso-src";
const CENTRE_SRC = "obs-centre-src";
const ISO = "obs-isobar";
const ISO_LABEL = "obs-isobar-label";
const CENTRE = "obs-centre";
// Lows one colour, highs the other, either side of 1013.
const ISO_LOW = "#8ab4ff";
const ISO_HIGH = "#f0f3f8";
const CENTRE_H = "#6ea8ff";
const CENTRE_L = "#ff6b6b";
/**
 * The borders, drawn again by this layer rather than by the boundary module.
 * Over an analysis a border has to be black and solid to be read at all, but
 * only where the picture is: black lines over bare ground mark nothing. This
 * layer is the one that knows both -- where its picture sits and when it
 * changes -- so it owns them, and they slot in below its own numbers and
 * barbs, which stay on top.
 */
const BORDER_SRC = "obs-borders-src";
const BORDER_CNTY = "obs-border-county";
const BORDER_COAST = "obs-border-coast";
const BORDER_STATE = "obs-border-state";
const BORDER_COUNTRY = "obs-border-country";
/** Bottom to top: the finer the division, the lighter the line. */
const BORDER_IDS = [BORDER_CNTY, BORDER_COAST, BORDER_STATE, BORDER_COUNTRY];
const BORDER_INK = "#000000";
/**
 * Bundled outlines rather than the basemap's own tiles: those carry no state
 * line below about zoom five and none at all for much of the world, so whole
 * stretches of a border simply were not there. Natural Earth, cut into short
 * segments -- the map's `within` test takes a whole feature or nothing, and an
 * unbroken coastline would fail it everywhere.
 */
const BORDER_DATA = `${import.meta.env.BASE_URL}data/borders.geojson`;

/**
 * Barbs thinned by zoom into an even lattice: every 4 degrees zoomed out, every
 * half degree zoomed in. Each band is its own layer, filtered on the lattice
 * rank the server gave each barb, because letting symbol collision thin them
 * leaves a ragged pattern that reads as data.
 */
const BARB_BANDS = [
  { id: "obs-barb-0", rank: 0, minzoom: 0, maxzoom: 4 },
  { id: "obs-barb-1", rank: 1, minzoom: 4, maxzoom: 5 },
  { id: "obs-barb-2", rank: 2, minzoom: 5, maxzoom: 6 },
  { id: "obs-barb-3", rank: 3, minzoom: 6, maxzoom: 24 },
] as const;
const BARB_IDS = BARB_BANDS.map((b) => b.id);
const BARB_IMAGE = "obsbarb-";

// Place names last: they are read over everything else this layer draws.
/**
 * Roads and towns over the field. The picture covers the basemap, and with it
 * every road and town the basemap draws, so zoomed to a county the analysis had
 * no reference but its borders and names. Drawn from the basemap's own tiles,
 * in a thin dark ink that reads over any colour; towns as a faint shade, so the
 * value under them still shows. Each class from the zoom it starts to matter.
 */
const TOWN = "obs-town";
const ROADS = [
  { id: "obs-road-minor", classes: ["minor"], minzoom: 12.5, opacity: 0.32, widths: [12.5, 0.4, 15, 1.2, 17, 2.4] },
  { id: "obs-road-tertiary", classes: ["tertiary"], minzoom: 10.5, opacity: 0.36, widths: [10.5, 0.4, 13, 0.9, 16, 2.2] },
  { id: "obs-road-secondary", classes: ["secondary"], minzoom: 9, opacity: 0.46, widths: [9, 0.4, 12, 0.9, 16, 2.6] },
  { id: "obs-road-primary", classes: ["primary"], minzoom: 7, opacity: 0.56, widths: [7, 0.45, 10, 0.9, 14, 2, 17, 3.6] },
  { id: "obs-road-trunk", classes: ["trunk"], minzoom: 6, opacity: 0.66, widths: [6, 0.45, 10, 1.1, 14, 2.4, 17, 4] },
  { id: "obs-road-motorway", classes: ["motorway"], minzoom: 5, opacity: 0.78, widths: [5, 0.5, 8, 1.1, 12, 2, 16, 4] },
] as const;
const ROAD_IDS = ROADS.map((r) => r.id);
const ROAD_INK = "#141414";

const ALL = [LAYER, DETAIL, TOWN, ...ROAD_IDS, ...BORDER_IDS, EDGE, OUTLINE, ISO, ISO_LABEL, ...BARB_IDS, CENTRE,
  ...TRACK_IDS, ...PLACE_LAYER_IDS];

/**
 * From this zoom the whole-domain picture (about 6 km a pixel) shows its
 * pixels as squares, so a second picture of just what is on screen is drawn
 * over it -- the field interpolated by the server before it is coloured.
 */
// From a continent's view in: the whole-domain picture is 1600 pixels across
// its domain, which for a global model is four a degree -- stretched five times
// over the US at the zoom the app opens on.
const DETAIL_MIN_ZOOM = 2.5;
const DETAIL_SETTLE_MS = 220;

// Near opaque: a model's colours washed out over the basemap at three quarters.
const DEFAULT_OPACITY = 0.9;

/** A 1x1 transparent PNG: an image source needs a picture before it has one. */
const BLANK =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

/** Where the blank sits until the first frame lands: CONUS, roughly. */
const HOME: [number, number][] = [
  [-127, 51],
  [-65, 51],
  [-65, 23],
  [-127, 23],
];

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** What each GeoJSON source was last given, to tell when new data is the same. */
const lastData = new WeakMap<GeoJSONSource, unknown>();

/**
 * setData, skipped when the source already holds that: each call has the map's
 * worker cut the source into tiles again, which between hours was most of a
 * frame step -- the domain's outline, the same every hour, and the empty layers
 * the product does not use. `same` is how to tell (the data itself by default).
 */
function put(src: GeoJSONSource, data: GeoJSON.FeatureCollection, same: unknown = data): void {
  const key = data.features.length === 0 ? EMPTY : same;
  if (lastData.get(src) === key) return;
  lastData.set(src, key);
  src.setData(data);
}

interface PaneState {
  unsub: () => void;
  onMissing: (e: MapStyleImageMissingEvent) => void;
  onMove: () => void;
  seq: number;
  /** What is drawn, so a redraw of the same frame is skipped. */
  shown: string;
  detailSeq: number;
  /** The box and frame the detail picture on the map was made for. */
  detailKey: string;
  detailUrl: string | null;
  /** Where the detail picture on the map lies, while it is shown. */
  detailBox: DetailBox | null;
  /** The box whose sharp pictures the playing loop shows: kept through a zoom
   *  or pan until the new box's pictures come (see refreshDetail). */
  playBox: DetailBox | null;
  /** Hides or shows the whole-domain picture as the view moves (syncBase). */
  onPan: () => void;
  moveTimer: number | null;
}
const state = new WeakMap<MapLibreMap, PaneState>();

/**
 * One request per frame however many panes draw it. With the screen split,
 * every pane asked for the same picture and lines at once -- twice the server
 * threads for one answer, and the second pane's request was the one a slow
 * hour kept waiting.
 */
interface FrameEntry {
  picture: Pick<ObsRender, "coordinates" | "meta">;
  vectors: ObsVectors;
  /** The picture already on this machine, so showing the frame needs no request. */
  url: string;
}

/**
 * Frames already made, kept in memory: stepping back through a loop that has
 * played once is a swap of picture and lines, not three requests a frame.
 * Kept to about three days of hourly frames of one product; the oldest go.
 */
const FRAME_CACHE_MAX = 260;
const frames = new Map<string, Promise<FrameEntry>>();

/**
 * Show the black borders across the picture, and nowhere else.
 *
 * `within` asks whether a line lies *entirely* inside the polygon, so the ring
 * is grown a little: a border crossing the edge of the picture would otherwise
 * fail the test and leave a gap well inside the data. The overshoot falls on
 * bare ground, where the line marks nothing anyway.
 */
function markBorders(map: MapLibreMap, corners: [number, number][] | null): void {
  let area: GeoJSON.Polygon | null = null;
  if (corners && corners.length >= 4) {
    const lngs = corners.map(([lng]) => lng);
    const lats = corners.map(([, lat]) => lat);
    const padX = (Math.max(...lngs) - Math.min(...lngs)) * 0.04;
    const padY = (Math.max(...lats) - Math.min(...lats)) * 0.04;
    const w = Math.max(-180, Math.min(...lngs) - padX);
    const e = Math.min(180, Math.max(...lngs) + padX);
    const n = Math.min(85, Math.max(...lats) + padY);
    const s = Math.max(-85, Math.min(...lats) - padY);
    area = { type: "Polygon", coordinates: [[[w, n], [e, n], [e, s], [w, s], [w, n]]] };
  }
  for (const [id, kind] of [[BORDER_CNTY, "county"], [BORDER_COAST, "coast"],
                            [BORDER_STATE, "state"], [BORDER_COUNTRY, "country"]] as const) {
    if (!map.getLayer(id)) continue;
    map.setFilter(id, area
      ? ["all", ["==", ["get", "kind"], kind], ["within", area]] as never
      : ["==", ["get", "kind"], "-"] as never);
  }
  // The roads too: outside the picture the basemap draws its own.
  for (const r of ROADS) {
    if (!map.getLayer(r.id)) continue;
    map.setFilter(r.id, roadFilter(r.classes, area));
  }
}

function roadFilter(classes: readonly string[], area: GeoJSON.Polygon | null): never {
  const cls = ["in", ["get", "class"], ["literal", [...classes]]];
  return (area ? ["all", cls, ["within", area]] : ["==", ["get", "class"], "-"]) as never;
}

/** Roads and towns from the basemap's tiles, over the picture and under the
 *  borders. A basemap with no tiles (Blank) has none to draw. */
function addRoads(map: MapLibreMap): void {
  if (!map.getSource(VECTOR_SOURCE)) return;
  const on = useObsStore.getState().showRoads ? "visible" : "none";
  if (!map.getLayer(TOWN)) {
    map.addLayer({
      id: TOWN,
      type: "fill",
      source: VECTOR_SOURCE,
      "source-layer": "landuse",
      minzoom: 7,
      filter: ["in", ["get", "class"], ["literal", ["residential", "suburb", "neighbourhood", "quarter", "commercial", "industrial", "retail"]]],
      layout: { visibility: on },
      paint: {
        "fill-color": ROAD_INK,
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0, 8.5, 0.1, 12, 0.14],
      },
    });
  }
  for (const r of ROADS) {
    if (map.getLayer(r.id)) continue;
    map.addLayer({
      id: r.id,
      type: "line",
      source: VECTOR_SOURCE,
      "source-layer": "transportation",
      minzoom: r.minzoom,
      filter: roadFilter(r.classes, null),
      layout: { visibility: on, "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ROAD_INK,
        "line-opacity": r.opacity,
        "line-width": ["interpolate", ["linear"], ["zoom"], ...r.widths] as never,
      },
    });
  }
}

function frameData(args: { source: string; field: string; key: string }): Promise<FrameEntry> {
  const k = `${args.source}|${args.field}|${args.key}`;
  const hit = frames.get(k);
  if (hit) {
    frames.delete(k);
    frames.set(k, hit); // most recently used last
    return hit;
  }
  const p = (async () => {
    const [picture, vectors] = await Promise.all([fetchObsMeta(args), fetchObsVectors(args)]);
    const res = await fetch(obsImageUrl(args));
    if (!res.ok) throw new Error(`picture ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    return { picture, vectors, url };
  })();
  frames.set(k, p);
  p.then(
    () => {
      // Here now: a playing timeline may step onto it.
      if (frames.get(k) === p) obsFramesHere.add(k);
      obsFramesFailed.delete(k);
    },
    () => {
      frames.delete(k);
      obsFramesFailed.add(k);
    },
  );
  while (frames.size > FRAME_CACHE_MAX) {
    const oldest = frames.keys().next().value as string;
    const gone = frames.get(oldest);
    frames.delete(oldest);
    obsFramesHere.delete(oldest);
    // Revoked later: a pane may be about to show it.
    void gone?.then((e) => window.setTimeout(() => URL.revokeObjectURL(e.url), 10_000)).catch(() => undefined);
  }
  return p;
}

/**
 * Loops: when the timeline starts playing the analyses, every frame of the loop
 * is made ahead on the server, and each is pulled onto this machine as soon as
 * it is finished -- so the play steps through pictures that are already here.
 *
 * Pulling only finished frames matters: a request for a frame still being made
 * waits as long as its download, and the browser allows six connections to the
 * backend, so four of those at once left the rest of the app queuing.
 * One preloader for all panes: they show the same frames.
 */
const PULL_PARALLEL = 2;
const POLL_MS = 250;
/** A cold week of a many-field product is several hundred MB to download. */
const LOOP_GIVE_UP_MS = 30 * 60_000;
/** New analysis hours land about hourly; the list is looked at this often. */
const REFRESH_MS = 5 * 60_000;
/** For a source that publishes every few minutes (the MRMS mosaic). */
const FAST_REFRESH_MS = 60_000;
let loopGeneration = 0;
let panes = 0;
let refreshTimer: number | null = null;

/**
 * The timeline's loop, made ahead once play is pressed -- not when the layer
 * comes on or the product changes: an hour of HRRR is a megabyte or more per
 * field, and nobody asked for a week of it by picking a product.
 */
function ensureLoop(): void {
  const s = useObsStore.getState();
  if (panes === 0 || !s.loopArmed || s.frames.length < 2 || isTrackSource(s.catalog, s.source)) return;
  s.prepareLoop(s.frames.map((f) => f.key));
}

function preloadLoop(loop: string[]): void {
  const generation = ++loopGeneration;
  const { source, field, index } = useObsStore.getState();
  if (loop.length === 0) return;
  // From the frame on screen onward, then round from the start -- spread over
  // the loop's span (every eighth frame first, then the ones between: see
  // lib/loopOrder), so a play started while it downloads runs over all of it,
  // coarser in time until the rest is in, instead of stopping at the gap.
  const keys = spreadOrder(index > 0 && index < loop.length ? [...loop.slice(index), ...loop.slice(0, index)] : loop);
  const alive = () => generation === loopGeneration;
  const waiting = new Set(keys);
  const pull: string[] = [];
  let loaded = 0;
  let running = 0;

  const done = () => {
    loaded += 1;
    if (alive()) useObsStore.getState().setStatus({ loopLoaded: loaded });
  };
  const next = () => {
    while (alive() && running < PULL_PARALLEL && pull.length > 0) {
      const key = pull.shift()!;
      running += 1;
      frameData({ source, field, key })
        .catch(() => undefined)
        .finally(() => {
          running -= 1;
          done();
          next();
        });
    }
  };

  void (async () => {
    // Frames this machine already holds need nothing from the server.
    for (const key of keys) {
      if (frames.has(`${source}|${field}|${key}`)) {
        waiting.delete(key);
        pull.push(key);
      }
    }
    next();
    // Zoomed in, the server makes each frame's sharp picture of the view too,
    // while its field is in memory: what the play shows (see sharpViews). Then
    // it is asked for every frame, those this machine holds included -- their
    // pictures of this view may not be made yet; the rest are a cache hit.
    const front = getMap();
    const map = front && state.get(front) ? front : allMaps().find((m) => state.has(m));
    const view = map && needsSharp(map) ? detailBox(map) : null;
    if (waiting.size === 0 && !view) return;
    try {
      if (view) loopViewKey = `${source}|${field}|${boxKey("", view)}`;
      await prefetchObsLoop(source, field, view ? keys : [...waiting], view);
    } catch {
      return; // the timeline still fetches each frame as it reaches it
    }
    const started = performance.now();
    while (alive() && waiting.size > 0 && performance.now() - started < LOOP_GIVE_UP_MS) {
      try {
        const st = await fetchObsLoopStatus(source, field, [...waiting]);
        if (!alive()) return;
        // In loop order, so the frames about to play arrive first.
        const ready = new Set(st.ready);
        for (const key of keys) {
          if (ready.has(key) && waiting.delete(key)) pull.push(key);
        }
        for (const key of st.failed) {
          if (waiting.delete(key)) {
            obsFramesFailed.add(`${source}|${field}|${key}`);
            done();
          }
        }
        next();
      } catch {
        /* the backend restarting: try again */
      }
      if (waiting.size > 0) await new Promise((r) => window.setTimeout(r, POLL_MS));
    }
  })();
}

function hideDetail(map: MapLibreMap, st: PaneState): void {
  st.detailSeq += 1;
  st.detailKey = "";
  st.detailBox = null;
  if (map.getLayer(DETAIL)) map.setLayoutProperty(DETAIL, "visibility", "none");
  syncBase(map, st);
}

/** The detail picture on the map, over `box`. */
function showDetail(map: MapLibreMap, st: PaneState, box: DetailBox): void {
  st.detailBox = box;
  map.setLayoutProperty(DETAIL, "visibility", "visible");
  syncBase(map, st);
}

/**
 * The whole-domain picture is hidden while the detail picture covers the whole
 * view. Left under it, its stretched pixels showed as blurred squares wherever
 * the detail is transparent (the "no echo" part of reflectivity), and faintly
 * through the rest, both layers being 0.9 opaque -- a smear of big soft blocks
 * around sharp echoes. It comes back when there is no detail, and when a pan or
 * a zoom out reaches past the detail's box, to fill the edge until the next
 * detail picture lands.
 */
function syncBase(map: MapLibreMap, st: PaneState): void {
  if (!map.getLayer(LAYER)) return;
  const box = st.detailBox;
  let covered = false;
  if (box) {
    const b = map.getBounds();
    covered = b.getWest() >= box.west && b.getEast() <= box.east &&
      Math.max(b.getSouth(), -85) >= box.south && Math.min(b.getNorth(), 85) <= box.north;
  }
  const want = covered ? "none" : "visible";
  if (map.getLayoutProperty(LAYER, "visibility") !== want) map.setLayoutProperty(LAYER, "visibility", want);
}

/** The detail picture a moment after a frame lands, and never while playing:
 *  swapping between a sharp picture and the plain one on every step of a loop
 *  read as a flicker. */
function scheduleDetail(map: MapLibreMap): void {
  const st = state.get(map);
  if (!st) return;
  if (useObsStore.getState().playing) {
    if (st.moveTimer != null) window.clearTimeout(st.moveTimer);
    st.moveTimer = null;
    void refreshDetail(map);
    return;
  }
  if (st.moveTimer != null) window.clearTimeout(st.moveTimer);
  st.moveTimer = window.setTimeout(() => {
    st.moveTimer = null;
    void refreshDetail(map);
  }, DETAIL_SETTLE_MS);
}

/** The box and pixel size of the detail picture for the map's view -- null
 *  where the whole-domain picture stays (a view of most of the world, or one
 *  across the antimeridian). Shared by refreshDetail and the export's preload,
 *  so both ask for the very same URL. */
interface DetailBox {
  west: number;
  south: number;
  east: number;
  north: number;
  width: number;
  height: number;
}

function detailBox(map: MapLibreMap): DetailBox | null {
  const b = map.getBounds();
  let west = b.getWest();
  let east = b.getEast();
  let north = Math.min(b.getNorth(), 85);
  let south = Math.max(b.getSouth(), -85);
  // A view across the antimeridian, or of most of the world, keeps the
  // whole-domain picture: at that scale it is sharp enough already.
  if (west < -180 || east > 180 || east - west > 180) return null;
  // A margin, so a small pan does not uncover the edge before the next picture.
  const padX = (east - west) * 0.12;
  const padY = (north - south) * 0.12;
  west = Math.max(-180, west - padX);
  east = Math.min(180, east + padX);
  north = Math.min(85, north + padY);
  south = Math.max(-85, south - padY);
  const canvas = map.getCanvas();
  const ratio = obsDensity();
  const width = Math.min(3072, Math.max(64, canvas.clientWidth * 1.24 * ratio));
  const height = Math.min(3072, Math.max(64, canvas.clientHeight * 1.24 * ratio));
  return { west, south, east, north, width, height };
}

// ---------------------------------------------------------------------------
// Sharp pictures while playing
//
// The whole-domain picture is about 1600 px across a model's domain, drawn
// smoothed and stretched by the map: softer than the detail picture made for
// the view even at a country's zoom, and a blur of squares at a state's. A
// playing loop showed only that one -- "the whole play in low quality" -- so
// while a loop plays, wherever the paused map would show a detail picture,
// each frame's detail picture for the view is shown instead. The server makes
// them with the loop (prefetchObsLoop's view), and here they are asked for a
// few frames ahead, kept decoded, and swapped in with their frame; the
// timeline waits for one as it waits for the frame itself.
// ---------------------------------------------------------------------------
// A whole loop (MAX_LOOP_FRAMES on the server is 240), so the second time round
// nothing is asked for again -- within a memory budget: lossless WebP, a day of
// simulated IR at a desktop's size is ~220 MB, of radar a few tens.
const SHARP_MAX = 260;
const SHARP_BYTES = 480 * 1024 * 1024;
const SHARP_AHEAD = 10;
const SHARP_PARALLEL = 3;
// Made on demand after a pan, a cold MRMS field takes seconds to load.
const SHARP_TIMEOUT_MS = 45_000;
/** "source|field|key|box|WxH" -> object URL of the decoded picture. */
const sharpViews = new Map<string, string>();
const sharpSizes = new Map<string, number>();
let sharpBytes = 0;
const sharpPending = new Set<string>();
/** When each picture still coming was asked for. */
const sharpSince = new Map<string, number>();
const sharpFailed = new Set<string>();
/** The longest a playing loop waits on a frame's sharp picture before stepping
 *  on with what it has: a picture late by a second is better than a loop that
 *  stops -- "it freezes and takes long to go on" when zoomed out mid-play. */
const SHARP_GRACE_MS = 1200;
/** When the map last moved; while it moves the box changes every instant, and
 *  a picture asked for it would be for a view already gone. */
let movedAt = 0;
/** "source|field|box" the server was last asked to make the loop's pictures for. */
let loopViewKey = "";
const sharpQueue: { key: string; want: string; frameKey: string; box: DetailBox }[] = [];
let sharpRunning = 0;

function boxKey(want: string, box: DetailBox): string {
  const { west, south, east, north, width, height } = box;
  return `${want}|${west.toFixed(2)},${south.toFixed(2)},${east.toFixed(2)},${north.toFixed(2)}|${Math.round(width)}x${Math.round(height)}`;
}

/** Whether a playing loop shows each frame's detail picture: wherever the
 *  paused map would (detailBox says where not -- most of the world at once). */
function needsSharp(map: MapLibreMap): boolean {
  return map.getZoom() >= DETAIL_MIN_ZOOM;
}

/** Whether the map is moving, or has just stopped. */
function settling(map: MapLibreMap): boolean {
  return map.isMoving() || performance.now() - movedAt < 150;
}

function askSharp(key: string, want: string, box: DetailBox): void {
  sharpPending.add(key);
  sharpSince.set(key, performance.now());
  sharpQueue.push({ key, want, frameKey: want.split("|")[2], box });
}

function pumpSharp(): void {
  while (sharpRunning < SHARP_PARALLEL && sharpQueue.length > 0) {
    const job = sharpQueue.shift()!;
    if (sharpViews.has(job.key) || sharpFailed.has(job.key)) {
      sharpPending.delete(job.key);
      sharpSince.delete(job.key);
      continue;
    }
    sharpRunning += 1;
    const [source, field] = job.want.split("|");
    void (async () => {
      try {
        const ctrl = new AbortController();
        const timer = window.setTimeout(() => ctrl.abort(), SHARP_TIMEOUT_MS);
        const res = await fetch(obsViewUrl({ source, field, key: job.frameKey, ...job.box }), { signal: ctrl.signal });
        window.clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.src = url;
        await img.decode();
        sharpViews.set(job.key, url);
        sharpSizes.set(job.key, blob.size);
        sharpBytes += blob.size;
        while (sharpViews.size > SHARP_MAX || (sharpBytes > SHARP_BYTES && sharpViews.size > 1)) {
          const [oldest, gone] = sharpViews.entries().next().value as [string, string];
          sharpViews.delete(oldest);
          sharpBytes -= sharpSizes.get(oldest) ?? 0;
          sharpSizes.delete(oldest);
          window.setTimeout(() => URL.revokeObjectURL(gone), 10_000);
        }
      } catch {
        sharpFailed.add(job.key);
      } finally {
        sharpPending.delete(job.key);
        sharpSince.delete(job.key);
        sharpRunning -= 1;
        pumpSharp();
      }
    })();
  }
}

/** Ask for the sharp pictures of the frames about to play, for this view. */
function sharpAhead(map: MapLibreMap): void {
  const s = useObsStore.getState();
  if (!s.playing || !needsSharp(map) || settling(map)) return;
  const box = detailBox(map);
  if (!box || s.frames.length === 0) return;
  const here = boxKey("", box);
  for (let i = sharpQueue.length - 1; i >= 0; i--) {
    if (boxKey("", sharpQueue[i].box) !== here) {
      sharpPending.delete(sharpQueue[i].key);
      sharpSince.delete(sharpQueue[i].key);
      sharpQueue.splice(i, 1);
    }
  }
  // A new view mid-play (a zoom, a pan): the server makes every frame's
  // picture of it, a dozen at a time, next to the few asked for below.
  const loopView = `${s.source}|${s.field}|${here}`;
  if (loopView !== loopViewKey && s.loopKeys.length > 0) {
    loopViewKey = loopView;
    const at = Math.max(0, s.loopKeys.indexOf(s.frames[s.index]?.key ?? ""));
    const order = [...s.loopKeys.slice(at), ...s.loopKeys.slice(0, at)];
    void prefetchObsLoop(s.source, s.field, order, box).catch(() => undefined);
  }
  for (let k = 0; k < SHARP_AHEAD && k < s.frames.length; k++) {
    const f = s.frames[(s.index + k) % s.frames.length];
    const want = `${s.source}|${s.field}|${f.key}`;
    // Only frames already made: their detail is then a crop of what the server holds.
    if (!obsFramesHere.has(want)) continue;
    const key = boxKey(want, box);
    if (sharpViews.has(key) || sharpPending.has(key) || sharpFailed.has(key)) continue;
    askSharp(key, want, box);
  }
  pumpSharp();
}

/** For the timeline: whether frame `want` ("source|field|key") can be shown
 *  now. Yes once its sharp picture is here -- or one made for the view before
 *  a zoom or pan, which still sits right on the map while the new one is made
 *  -- or it needs none. While the map moves the loop never waits; otherwise it
 *  waits for a picture on the way at most SHARP_GRACE_MS. */
export function obsSharpReady(want: string): boolean {
  // The pane in front; the timeline plays every pane's layer together.
  const front = getMap();
  const map = front && state.get(front) ? front : allMaps().find((m) => state.has(m));
  if (!map || !needsSharp(map) || settling(map)) return true;
  const box = detailBox(map);
  if (!box) return true;
  const key = boxKey(want, box);
  if (sharpViews.has(key) || sharpFailed.has(key)) return true;
  if (!sharpPending.has(key) && obsFramesHere.has(want)) {
    askSharp(key, want, box);
    pumpSharp();
  }
  const playBox = state.get(map)?.playBox;
  if (playBox && sharpViews.has(boxKey(want, playBox))) return true;
  const since = sharpSince.get(key);
  return since == null || performance.now() - since > SHARP_GRACE_MS;
}

/** What the sharp pictures are doing: for the console, and the app probe. */
export function obsSharpState(): Record<string, unknown> {
  const map = getMap();
  const st = map ? state.get(map) : undefined;
  const box = map ? detailBox(map) : null;
  return {
    views: sharpViews.size, mb: Math.round(sharpBytes / 1e6), pending: sharpPending.size, queued: sharpQueue.length,
    running: sharpRunning, failed: sharpFailed.size, settling: map ? settling(map) : null,
    box: box ? boxKey("", box) : null, playBox: st?.playBox ? boxKey("", st.playBox) : null,
  };
}

/** Whether sharp pictures are still being made: the timeline keeps waiting. */
export function obsSharpBusy(): boolean {
  return sharpPending.size > 0;
}

async function refreshDetail(map: MapLibreMap): Promise<void> {
  const st = state.get(map);
  const src = map.getSource(DETAIL_SRC) as ImageSource | undefined;
  if (!st || !src || !map.getLayer(DETAIL)) return;
  const { source, field, frames: list, index, playing, catalog, view } = useObsStore.getState();
  if (isTrackSource(catalog, source) || view === "models") {
    hideDetail(map, st);
    return;
  }
  const frame = list[index];
  const want = frame ? `${source}|${field}|${frame.key}` : "";
  /** This frame is as it will stay: nothing more is coming for it. */
  const final = () => useObsStore.getState().setStatus({ detailed: want });
  // Only over a frame that is already drawn, only once zoomed in, never mid-play.
  if (!frame || st.shown !== want) {
    hideDetail(map, st);
    return;
  }
  if (playing) {
    // Its sharp picture if it has been made; the whole-domain one otherwise
    // (and the next frames' asked for).
    // The view's own picture of this frame; failing that, the one made for the
    // view before a zoom or pan (still right on the map, just not all of it),
    // until the new ones come; the whole-domain picture only when neither is.
    const box = needsSharp(map) ? detailBox(map) : null;
    let url = box ? sharpViews.get(boxKey(want, box)) : undefined;
    let at: DetailBox | null = url ? box : null;
    if (url && box) st.playBox = box;
    if (!url && st.playBox) {
      url = sharpViews.get(boxKey(want, st.playBox));
      if (url) at = st.playBox;
    }
    if (box && !url && st.detailKey === boxKey(want, box)) {
      // Play pressed on a frame whose paused detail is up: it stays.
    } else if (url && at) {
      src.updateImage({
        url,
        coordinates: [
          [at.west, at.north],
          [at.east, at.north],
          [at.east, at.south],
          [at.west, at.south],
        ] as never,
      });
      // Owned by the sharp cache, not revoked with the paused detail.
      if (st.detailUrl) {
        const owned = st.detailUrl;
        window.setTimeout(() => URL.revokeObjectURL(owned), 2000);
      }
      st.detailUrl = null;
      st.detailKey = boxKey(want, at);
      showDetail(map, st, at);
    } else {
      hideDetail(map, st);
    }
    final();
    sharpAhead(map);
    return;
  }
  if (map.getZoom() < DETAIL_MIN_ZOOM) {
    hideDetail(map, st);
    final();
    return;
  }
  const box = detailBox(map);
  if (!box) {
    hideDetail(map, st);
    final();
    return;
  }
  const { west, south, east, north, width, height } = box;
  const key = `${want}|${west.toFixed(2)},${south.toFixed(2)},${east.toFixed(2)},${north.toFixed(2)}|${Math.round(width)}x${Math.round(height)}`;
  if (key === st.detailKey) {
    final();
    return;
  }
  const made = sharpViews.get(key);
  if (made) {
    st.detailSeq += 1;
    src.updateImage({ url: made, coordinates: [[west, north], [east, north], [east, south], [west, south]] as never });
    if (st.detailUrl) {
      const owned = st.detailUrl;
      window.setTimeout(() => URL.revokeObjectURL(owned), 2000);
    }
    st.detailUrl = null;
    st.detailKey = key;
    showDetail(map, st, box);
    final();
    return;
  }

  const seq = ++st.detailSeq;
  try {
    const res = await fetch(obsViewUrl({ source, field, key: frame.key, west, south, east, north, width, height }));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (seq !== st.detailSeq || !map.getSource(DETAIL_SRC)) return;
    const url = URL.createObjectURL(blob);
    // Decoded before it goes on the map, so the swap never shows a blank box.
    await new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("detail image did not decode"));
      img.src = url;
    });
    if (seq !== st.detailSeq || !map.getSource(DETAIL_SRC)) {
      URL.revokeObjectURL(url);
      return;
    }
    src.updateImage({
      url,
      coordinates: [
        [west, north],
        [east, north],
        [east, south],
        [west, south],
      ] as never,
    });
    const previous = st.detailUrl;
    st.detailUrl = url;
    st.detailKey = key;
    if (previous) window.setTimeout(() => URL.revokeObjectURL(previous), 2000);
    showDetail(map, st, box);
    final();
  } catch {
    // The whole-domain picture is still underneath; a missed detail is not an error.
    if (seq === st.detailSeq) {
      hideDetail(map, st);
      final();
    }
  }
}

/** The image sources a frame of the models is drawn from: an export waits
 *  for both to have their pictures before it takes the frame. */
export const OBS_IMAGE_SOURCES = [SRC, DETAIL_SRC];

/** The detail picture and the city values now, on every pane, rather than
 *  after their settle timers -- which a hidden window stretches to a second or
 *  more per frame. */
export function obsDetailNow(): void {
  for (const map of allMaps()) {
    const st = state.get(map);
    if (!st) continue;
    if (st.moveTimer != null) window.clearTimeout(st.moveTimer);
    st.moveTimer = null;
    void refreshDetail(map);
    placesFor(map)?.now();
  }
}

/** Whether the frame `want` ("source|field|key") is final on `map`: drawn, its
 *  detail picture over it (or none needed), and the city values its own. */
export function obsFrameFinal(map: MapLibreMap, want: string): boolean {
  const s = useObsStore.getState();
  return s.drawn === want && s.detailed === want && !s.busy && (placesFor(map)?.readyFor(want) ?? true);
}

/**
 * Bring these frames onto this machine ahead of an export: their pictures and
 * lines, and the detail picture each will want for the map's view as it is,
 * a few at a time. The export then steps through frames that are already
 * here instead of fetching each as it reaches it.
 */
export async function obsPreload(
  map: MapLibreMap,
  source: string,
  field: string,
  keys: string[],
  stop: () => boolean,
): Promise<void> {
  const box = map.getZoom() >= DETAIL_MIN_ZOOM ? detailBox(map) : null;
  const values = placesFor(map)?.prefetch(keys, stop);
  let next = 0;
  const worker = async () => {
    while (!stop() && next < keys.length) {
      const key = keys[next++];
      try {
        await frameData({ source, field, key });
        // Into the browser's cache (the server says it keeps an hour): the
        // detail refresh then asks for the same URL and has it at once.
        if (box) await fetch(obsViewUrl({ source, field, key, ...box }));
      } catch {
        /* fetched as it is reached instead */
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), values]);
}

// ---------------------------------------------------------------------------
// Barb pictures
// ---------------------------------------------------------------------------
const BARB_RATIO = 2;
const BARB_SIZE = 44; // CSS pixels; the station is the centre

/**
 * One wind barb, drawn pointing north so the map's rotation turns it to where
 * the wind comes from. Pennants for 50 kt, full feathers for 10, a half for 5,
 * on the side a northern-hemisphere chart puts them (clockwise of the staff),
 * each leaning toward the wind. A ring for calm. White under dark ink, so it
 * reads over a red field and a pale one alike.
 */
function barbImage(knots: number): ImageData {
  const px = BARB_SIZE * BARB_RATIO;
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(BARB_RATIO, BARB_RATIO);
  const c = BARB_SIZE / 2;

  const paths: Path2D[] = [];
  const fills: Path2D[] = [];
  if (knots < 5) {
    const ring = new Path2D();
    ring.arc(c, c, 3.2, 0, Math.PI * 2);
    paths.push(ring);
  } else {
    const L = 19; // staff
    const F = 8.5; // feather
    const gap = 3.1;
    const lean = { x: Math.sin((60 * Math.PI) / 180), y: Math.cos((60 * Math.PI) / 180) };
    const top = c - L;
    const staff = new Path2D();
    staff.moveTo(c, c);
    staff.lineTo(c, top);
    paths.push(staff);

    let rest = knots;
    let y = top;
    const pennants = Math.floor(rest / 50);
    rest -= pennants * 50;
    for (let i = 0; i < pennants; i++) {
      const flag = new Path2D();
      flag.moveTo(c, y);
      flag.lineTo(c + F * lean.x, y - F * lean.y + 3.6);
      flag.lineTo(c, y + 4.2);
      flag.closePath();
      fills.push(flag);
      y += 5.4;
    }
    if (pennants) y += 1;
    const full = Math.floor(rest / 10);
    rest -= full * 10;
    for (let i = 0; i < full; i++) {
      const f = new Path2D();
      f.moveTo(c, y);
      f.lineTo(c + F * lean.x, y - F * lean.y);
      paths.push(f);
      y += gap;
    }
    if (rest >= 5) {
      // A lone half feather sits a step in from the tip, so it is not misread as a full one.
      if (!pennants && !full) y += gap;
      const h = new Path2D();
      h.moveTo(c, y);
      h.lineTo(c + F * 0.5 * lean.x, y - F * 0.5 * lean.y);
      paths.push(h);
    }
  }

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = 3.4;
  for (const p of paths) ctx.stroke(p);
  for (const p of fills) {
    ctx.stroke(p);
    ctx.fill(p);
  }
  ctx.strokeStyle = "#0c121a";
  ctx.fillStyle = "#0c121a";
  ctx.lineWidth = 1.35;
  for (const p of paths) ctx.stroke(p);
  for (const p of fills) ctx.fill(p);
  return ctx.getImageData(0, 0, px, px);
}

function barbFeatures(barbs: ObsBarbs | null): GeoJSON.FeatureCollection {
  if (!barbs) return EMPTY;
  const features: GeoJSON.Feature[] = new Array(barbs.s.length);
  for (let i = 0; i < barbs.s.length; i++) {
    features[i] = {
      type: "Feature",
      properties: { s: barbs.s[i], d: barbs.d[i], r: barbs.r[i] },
      geometry: { type: "Point", coordinates: [barbs.lon[i], barbs.lat[i]] },
    };
  }
  return { type: "FeatureCollection", features };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
async function draw(map: MapLibreMap): Promise<void> {
  const st = state.get(map);
  if (!st) return;
  // Under the models grid the map stays as it was: nothing of it shows, and its
  // downloads would only queue ahead of the grid's. It catches up on closing.
  // (Compare runs is this map itself, flipping between runs.)
  if (useObsStore.getState().view === "models") return;
  const image = map.getSource(SRC) as ImageSource | undefined;
  const edge = map.getSource(EDGE_SRC) as GeoJSONSource | undefined;
  const iso = map.getSource(ISO_SRC) as GeoJSONSource | undefined;
  const centres = map.getSource(CENTRE_SRC) as GeoJSONSource | undefined;
  const barbs = map.getSource(BARBS_SRC) as GeoJSONSource | undefined;
  const outline = map.getSource(OUTLINE_SRC) as GeoJSONSource | undefined;
  if (!image || !edge || !barbs || !iso || !centres || !outline) return;

  const { source, field, frames, index, catalog } = useObsStore.getState();
  const frame = frames[index];
  if (!frame) return;
  if (isTrackSource(catalog, source)) {
    await drawTracks(map, st, source, field, frame.key, frame.fh ?? 0);
    return;
  }
  clearTracks(map);
  const want = `${source}|${field}|${frame.key}`;
  if (want === st.shown) return;

  const seq = ++st.seq;
  // The detail picture belongs to the frame being replaced: left up, it would
  // show the old hour over the new one while the new one loads.
  hideDetail(map, st);
  useObsStore.getState().setStatus({ busy: true, error: null });

  const args = { source, field, key: frame.key };
  try {
    // The picture and the numbers over it come from the same cached variables
    // on the server, so asking for both at once costs one download, not two.
    const { picture, vectors, url } = await frameData(args);
    // A slower earlier frame must not paint over a newer one that already landed.
    if (seq !== st.seq || !map.getSource(SRC)) return;
    image.updateImage({ url, coordinates: picture.coordinates as never });
    markBorders(map, picture.coordinates as [number, number][]);
    put(edge, vectors.edge, JSON.stringify(vectors.edge));
    put(outline, vectors.outline ?? EMPTY);
    put(iso, vectors.isobars);
    put(centres, vectors.centres);
    put(barbs, barbFeatures(vectors.barbs));
    st.shown = want;
    scheduleDetail(map);
    placesFor(map)?.refresh();
    useObsStore.getState().setStatus({
      busy: false,
      error: null,
      valid: picture.meta.valid,
      drawn: want,
      bar: picture.meta.bar,
    });
  } catch (err) {
    if (seq !== st.seq) return;
    st.shown = "";
    for (const src of [edge, outline, barbs, iso, centres]) put(src, EMPTY);
    markBorders(map, null);
    useObsStore.getState().setStatus({
      busy: false,
      error: err instanceof Error ? err.message : String(err),
      valid: null,
    });
  }
}

/** The tracks of one storm and cycle: fetched once per product, then only the
 *  hour moves -- each model's marker steps along its own track. */
const trackCache = new Map<string, ObsTracks>();

async function drawTracks(map: MapLibreMap, st: PaneState, source: string, field: string, key: string, fh: number) {
  const run = key.split("_f")[0];
  const want = `${source}|${field}|${run}`;
  const lines = map.getSource(TRACK_SRC) as GeoJSONSource | undefined;
  const points = map.getSource(TRACK_PT_SRC) as GeoJSONSource | undefined;
  const best = map.getSource(TRACK_BEST_SRC) as GeoJSONSource | undefined;
  const image = map.getSource(SRC) as ImageSource | undefined;
  if (!lines || !points || !best || !image) return;
  const seq = ++st.seq;
  const hourFilter: FilterSpecification = ["==", ["get", "tau"], fh];
  if (map.getLayer(TRACK_NOW)) map.setFilter(TRACK_NOW, hourFilter);
  if (map.getLayer(TRACK_LABEL)) map.setFilter(TRACK_LABEL, hourFilter);
  if (st.shown === want) return;

  // Nothing shaded under the tracks.
  hideDetail(map, st);
  image.updateImage({ url: BLANK, coordinates: HOME as never });
  for (const id of [EDGE_SRC, OUTLINE_SRC, ISO_SRC, CENTRE_SRC, BARBS_SRC]) {
    const src = map.getSource(id) as GeoJSONSource | undefined;
    if (src) put(src, EMPTY);
  }
  markBorders(map, null);
  useObsStore.getState().setStatus({ busy: true, error: null });
  try {
    let data = trackCache.get(want);
    if (!data) {
      data = await fetchObsTracks({ source, field, key });
      trackCache.set(want, data);
      while (trackCache.size > 16) trackCache.delete(trackCache.keys().next().value as string);
    }
    if (seq !== st.seq) return;
    put(lines, data.lines);
    put(points, data.points);
    put(best, data.best);
    const colour: ExpressionSpecification = data.intensity ? SS_COLOUR : ["get", "colour"];
    for (const id of [TRACK, TRACK_PT, TRACK_NOW]) {
      if (!map.getLayer(id)) continue;
      map.setPaintProperty(id, id === TRACK ? "line-color" : "circle-color", colour);
    }
    st.shown = want;
    useObsStore.getState().setStatus({
      busy: false,
      error: null,
      valid: `${data.storm} · ${data.legend.length} tracks · ${data.cycle.slice(8)}Z cycle`,
      bar: data.bar,
    });
  } catch (err) {
    if (seq !== st.seq) return;
    st.shown = "";
    clearTracks(map);
    useObsStore.getState().setStatus({ busy: false, error: err instanceof Error ? err.message : String(err), valid: null });
  }
}

function clearTracks(map: MapLibreMap): void {
  for (const id of TRACK_SRCS) {
    const src = map.getSource(id) as GeoJSONSource | undefined;
    if (src) put(src, EMPTY);
  }
}

function applyVisibility(map: MapLibreMap): void {
  const { showEdge, showBarbs, showRoads } = useObsStore.getState();
  const want: [string, boolean][] = [
    [EDGE, showEdge],
    ...BARB_IDS.map((id): [string, boolean] => [id, showBarbs]),
    ...[TOWN, ...ROAD_IDS].map((id): [string, boolean] => [id, showRoads]),
  ];
  for (const [id, on] of want) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  }
}

useObsStore.subscribe((s, prev) => {
  if (s.loopKeys !== prev.loopKeys) preloadLoop(s.loopKeys);
  // A different product or source makes the loop being made useless -- now, not
  // once the new source's hours have been listed.
  if ((s.field !== prev.field || s.source !== prev.source) && !s.loopId.startsWith(`${s.source}|${s.field}|`)) {
    s.dropLoop();
  }
  // A new hour in the list joins a loop that is playing; a paused one waits.
  if ((s.frames !== prev.frames && s.playing) || s.field !== prev.field || s.loopArmed !== prev.loopArmed) {
    ensureLoop();
  }
});

/**
 * The hourly analyses as a filled field, with the numbers and the wind over it.
 *
 * An image, not vectors, for the colours: two million coloured points is a
 * picture, and the backend warps it onto a Mercator axis so MapLibre's
 * four-corner placement is exact. The contours, the barbs and the domain
 * outline ARE vectors, because they are read rather than looked at.
 */
export const obsLayer: LayerModule = {
  id: "observations",
  name: "Models",
  description:
    "Surface, upper-air and severe-weather analyses on the hour — temperature, CAPE, helicity, the STP, 500 mb flow — scrubbable and looped back through a week.",
  category: "weather",
  source: "NOAA/NCEP RTMA, HRRR and RAP analyses",
  defaultVisible: false,
  defaultOpacity: DEFAULT_OPACITY,

  async addTo(map) {
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: "image", url: BLANK, coordinates: HOME as never });
    }
    if (!map.getSource(DETAIL_SRC)) {
      map.addSource(DETAIL_SRC, { type: "image", url: BLANK, coordinates: HOME as never });
    }
    if (!map.getSource(EDGE_SRC)) map.addSource(EDGE_SRC, { type: "geojson", data: EMPTY });
    if (!map.getSource(OUTLINE_SRC)) map.addSource(OUTLINE_SRC, { type: "geojson", data: EMPTY });
    for (const id of TRACK_SRCS) if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: EMPTY });
    if (!map.getSource(BARBS_SRC)) map.addSource(BARBS_SRC, { type: "geojson", data: EMPTY });

    if (!map.getLayer(LAYER)) {
      map.addLayer({
        id: LAYER,
        type: "raster",
        source: SRC,
        paint: {
          "raster-opacity": DEFAULT_OPACITY,
          // The field is a backdrop for everything drawn over it; a hard edge
          // between neighbouring cells would read as data it is not.
          "raster-resampling": "linear",
          "raster-fade-duration": 0,
        },
      });
    }
    if (!map.getLayer(DETAIL)) {
      map.addLayer({
        id: DETAIL,
        type: "raster",
        source: DETAIL_SRC,
        layout: { visibility: "none" },
        paint: {
          "raster-opacity": DEFAULT_OPACITY,
          "raster-resampling": "linear",
          "raster-fade-duration": 0,
        },
      });
    }
    addRoads(map);
    if (!map.getSource(ISO_SRC)) map.addSource(ISO_SRC, { type: "geojson", data: EMPTY });
    if (!map.getSource(CENTRE_SRC)) map.addSource(CENTRE_SRC, { type: "geojson", data: EMPTY });
    if (!map.getSource(BORDER_SRC)) {
      map.addSource(BORDER_SRC, { type: "geojson", data: BORDER_DATA });
    }
    for (const [id, w, from] of [
      // Counties only once there is room for them: drawn across a continent
      // they are a grey wash, not a boundary.
      [BORDER_CNTY, [0.5, 0.8, 1.3], 4.2],
      [BORDER_COAST, [0.9, 1.7, 2.6], 0],
      [BORDER_STATE, [1.0, 1.9, 2.9], 0],
      [BORDER_COUNTRY, [1.5, 2.8, 4.2], 0],
    ] as const) {
      if (map.getLayer(id)) continue;
      map.addLayer({
        id,
        type: "line",
        source: BORDER_SRC,
        ...(from ? { minzoom: from } : {}),
        // Nothing until a picture says where it is.
        filter: ["==", ["get", "kind"], "-"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": BORDER_INK,
          "line-width": ["interpolate", ["linear"], ["zoom"], 2, w[0], 6, w[1], 10, w[2]],
          ...(id === BORDER_CNTY ? { "line-opacity": 0.55 } : {}),
        },
      });
    }
    if (!map.getLayer(OUTLINE)) {
      map.addLayer({
        id: OUTLINE,
        type: "line",
        source: OUTLINE_SRC,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#050607",
          "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1.1, 7, 1.8, 11, 2.6],
        },
      });
    }
    if (!map.getLayer(ISO)) {
      map.addLayer({
        id: ISO,
        type: "line",
        source: ISO_SRC,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ["case", ["==", ["get", "band"], "low"], ISO_LOW, ISO_HIGH],
          "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.9, 7, 1.5, 11, 2.1],
          "line-opacity": 0.9,
        },
      });
    }
    if (!map.getLayer(ISO_LABEL)) {
      map.addLayer({
        id: ISO_LABEL,
        type: "symbol",
        source: ISO_SRC,
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 320,
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 10,
          "text-letter-spacing": 0.04,
          "text-rotation-alignment": "map",
          "text-pitch-alignment": "viewport",
          "text-padding": 4,
        },
        paint: {
          "text-color": ["case", ["==", ["get", "band"], "low"], ISO_LOW, ISO_HIGH],
          // The halo is what lets a number sit *on* its own line.
          "text-halo-color": "#0b0f14",
          "text-halo-width": 1.6,
          "text-opacity": 0.9,
        },
      });
    }
    if (!map.getLayer(CENTRE)) {
      map.addLayer({
        id: CENTRE,
        type: "symbol",
        source: CENTRE_SRC,
        layout: {
          // The letter and its value are ONE symbol, the way a surface chart
          // writes them: two layers over the same point fight in the collision
          // index and the H/L glyph is the one that loses.
          "text-field": [
            "format",
            ["get", "kind"], { "font-scale": 1.6 },
            "\n", {},
            ["get", "label"], { "font-scale": 0.92 },
          ],
          "text-font": ["Noto Sans Bold"],
          "text-size": 11,
          "text-line-height": 1.05,
          "text-justify": "center",
          "text-padding": 3,
        },
        paint: {
          "text-color": ["case", ["==", ["get", "kind"], "H"], CENTRE_H, CENTRE_L],
          "text-halo-color": "#0b0f14",
          "text-halo-width": 1.8,
        },
      });
    }
    if (!map.getLayer(EDGE)) {
      map.addLayer({
        id: EDGE,
        type: "line",
        source: EDGE_SRC,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#8fb4ff",
          "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1.2, 8, 2.2],
          "line-dasharray": [4, 2],
          "line-opacity": 0.9,
        },
      });
    }
    if (!map.getLayer(TRACK_BEST)) {
      map.addLayer({
        id: TRACK_BEST,
        type: "line",
        source: TRACK_BEST_SRC,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#050607", "line-width": 3, "line-dasharray": [2, 1.2] },
      });
    }
    if (!map.getLayer(TRACK)) {
      map.addLayer({
        id: TRACK,
        type: "line",
        source: TRACK_SRC,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ["get", "colour"],
          // NHC's own forecast reads first.
          "line-width": ["case", ["get", "official"], 3.2, 1.8],
          "line-opacity": 0.95,
        },
      });
    }
    if (!map.getLayer(TRACK_PT)) {
      map.addLayer({
        id: TRACK_PT,
        type: "circle",
        source: TRACK_PT_SRC,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 1.6, 7, 2.6],
          "circle-color": ["get", "colour"],
          "circle-stroke-color": "#050607",
          "circle-stroke-width": 0.6,
        },
      });
    }
    if (!map.getLayer(TRACK_NOW)) {
      map.addLayer({
        id: TRACK_NOW,
        type: "circle",
        source: TRACK_PT_SRC,
        filter: ["==", ["get", "tau"], 0],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 4.5, 7, 6.5],
          "circle-color": ["get", "colour"],
          "circle-stroke-color": "#050607",
          "circle-stroke-width": 1.4,
        },
      });
    }
    if (!map.getLayer(TRACK_LABEL)) {
      map.addLayer({
        id: TRACK_LABEL,
        type: "symbol",
        source: TRACK_PT_SRC,
        filter: ["==", ["get", "tau"], 0],
        layout: {
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 10.5,
          "text-offset": [0.8, 0],
          "text-anchor": "left",
          "text-padding": 2,
        },
        paint: { "text-color": "#f0f3f8", "text-halo-color": "#0b0f14", "text-halo-width": 1.6 },
      });
    }
    for (const band of BARB_BANDS) {
      if (map.getLayer(band.id)) continue;
      map.addLayer({
        id: band.id,
        type: "symbol",
        source: BARBS_SRC,
        minzoom: band.minzoom,
        maxzoom: band.maxzoom,
        filter: ["<=", ["get", "r"], band.rank],
        layout: {
          "icon-image": ["concat", BARB_IMAGE, ["to-string", ["get", "s"]]],
          "icon-rotate": ["get", "d"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.8, 7, 1],
        },
      });
    }
    applyVisibility(map);
    attachPlaces(map);

    // The barb pictures are made when the map first asks for one: forty speeds
    // is forty canvases nobody needs until a product with wind is drawn.
    const onMissing = (e: MapStyleImageMissingEvent) => {
      if (!e.id.startsWith(BARB_IMAGE) || map.hasImage(e.id)) return;
      const knots = Number(e.id.slice(BARB_IMAGE.length));
      if (!Number.isFinite(knots)) return;
      map.addImage(e.id, barbImage(knots), { pixelRatio: BARB_RATIO });
    };
    map.on("styleimagemissing", onMissing);

    const unsub = useObsStore.subscribe((s, prev) => {
      if (s.source !== prev.source || s.field !== prev.field || s.index !== prev.index || s.frames !== prev.frames ||
          (s.view !== "models" && prev.view === "models")) {
        void draw(map);
      }
      if (s.showEdge !== prev.showEdge || s.showBarbs !== prev.showBarbs || s.showRoads !== prev.showRoads) {
        applyVisibility(map);
      }
      if (s.showPlaces !== prev.showPlaces) placesFor(map)?.applyVisibility();
      if (s.playing !== prev.playing) {
        if (s.playing) void refreshDetail(map);
        else scheduleDetail(map);
      }
    });
    const onMove = () => {
      const st = state.get(map);
      if (!st) return;
      if (st.moveTimer != null) window.clearTimeout(st.moveTimer);
      st.moveTimer = window.setTimeout(() => {
        st.moveTimer = null;
        void refreshDetail(map);
      }, DETAIL_SETTLE_MS);
    };
    map.on("moveend", onMove);
    // A panel opening or closing resizes the map without moving it, and the
    // uncovered strip would otherwise keep the blocky whole-domain picture.
    map.on("resize", onMove);
    const onPan = () => {
      movedAt = performance.now();
      const st = state.get(map);
      if (st) syncBase(map, st);
    };
    map.on("move", onPan);
    map.on("resize", onPan);
    state.set(map, {
      seq: 0,
      shown: "",
      unsub,
      onMissing,
      onMove,
      detailSeq: 0,
      detailKey: "",
      detailUrl: null,
      detailBox: null,
      playBox: null,
      onPan,
      moveTimer: null,
    });

    panes += 1;
    if (refreshTimer == null) {
      // Every minute, but a source only as often as it has something new: the
      // radar mosaic every two minutes, the hourly analyses every five.
      let last = Date.now();
      refreshTimer = window.setInterval(() => {
        const s = useObsStore.getState();
        const cadence = s.catalog?.sources.find((x) => x.id === s.source)?.cadence ?? 60;
        const every = cadence <= 10 ? FAST_REFRESH_MS : REFRESH_MS;
        if (Date.now() - last < every - 1000) return;
        last = Date.now();
        if (!s.catalog || s.frames.length === 0) void s.load();
        else void s.loadFrames(true);
      }, FAST_REFRESH_MS);
    }

    // The catalogue and the frame list may not be loaded yet -- the panel need
    // never have been opened.
    await useObsStore.getState().load();
    await draw(map);
  },

  removeFrom(map) {
    const st = state.get(map);
    if (st) {
      st.seq += 1;
      st.detailSeq += 1;
      st.unsub();
      map.off("styleimagemissing", st.onMissing);
      map.off("moveend", st.onMove);
      map.off("resize", st.onMove);
      map.off("move", st.onPan);
      map.off("resize", st.onPan);
      if (st.moveTimer != null) window.clearTimeout(st.moveTimer);
      if (st.detailUrl) URL.revokeObjectURL(st.detailUrl);
      state.delete(map);
      panes = Math.max(0, panes - 1);
    }
    if (panes === 0) {
      if (refreshTimer != null) window.clearInterval(refreshTimer);
      refreshTimer = null;
      useObsStore.getState().dropLoop(true);
    }
    // Before the layers go: it also puts the basemap's own place names back.
    placesFor(map)?.detach();
    for (const id of ALL) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of [SRC, DETAIL_SRC, EDGE_SRC, OUTLINE_SRC, BARBS_SRC, BORDER_SRC, ISO_SRC, CENTRE_SRC, ...TRACK_SRCS]) {
      if (map.getSource(id)) map.removeSource(id);
    }
    useObsStore.getState().setStatus({ busy: false, error: null, valid: null });
  },

  setOpacity(map, opacity) {
    if (map.getLayer(LAYER)) map.setPaintProperty(LAYER, "raster-opacity", opacity);
    if (map.getLayer(DETAIL)) map.setPaintProperty(DETAIL, "raster-opacity", opacity);
    // The lines and barbs stay readable as the field is faded back: they are
    // the part you are meant to read when the colours are turned down.
    const ink = Math.min(1, 0.35 + opacity * 0.5);
    for (const id of BARB_IDS) if (map.getLayer(id)) map.setPaintProperty(id, "icon-opacity", Math.min(1, ink + 0.1));
  },

  getLayerIds() {
    return ALL;
  },

  /**
   * Everything read off the analysis stays above the borders drawn over it:
   * the contour labels, the barbs and the place names are the point of the
   * picture, and a border crossing a temperature reading hides the reading.
   * The colours themselves stay below, which is what the borders sit on.
   */
  topLayerIds() {
    return [EDGE, OUTLINE, ISO, ISO_LABEL, ...BARB_IDS, CENTRE, ...TRACK_IDS, ...PLACE_LAYER_IDS];
  },
  topPriority: 8,
};
