import type { GeoJSONSource, ImageSource, Map as MapLibreMap, MapStyleImageMissingEvent } from "maplibre-gl";

import type { LayerModule } from "../types";
import {
  fetchObsMeta,
  fetchObsVectors,
  obsImageUrl,
  obsViewUrl,
  type ObsBarbs,
  type ObsRender,
  type ObsVectors,
} from "../../lib/observations";
import { useObsStore } from "../../store/useObsStore";

const SRC = "obs-src";
const DETAIL_SRC = "obs-detail-src";
const LINES_SRC = "obs-lines-src";
const EDGE_SRC = "obs-edge-src";
const BARBS_SRC = "obs-barbs-src";
const LAYER = "obs-raster";
const DETAIL = "obs-detail";
const LINE = "obs-line";
const LABEL = "obs-line-label";
const EDGE = "obs-edge";

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

const ALL = [LAYER, DETAIL, EDGE, LINE, ...BARB_IDS, LABEL];

/**
 * From this zoom the whole-domain picture (about 6 km a pixel) shows its
 * pixels as squares, so a second picture of just what is on screen is drawn
 * over it -- the field interpolated by the server before it is coloured.
 */
const DETAIL_MIN_ZOOM = 4.5;
const DETAIL_SETTLE_MS = 220;

const DEFAULT_OPACITY = 0.75;

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
  moveTimer: number | null;
}
const state = new WeakMap<MapLibreMap, PaneState>();

/**
 * One request per frame however many panes draw it. With the screen split,
 * every pane asked for the same picture and lines at once -- twice the server
 * threads for one answer, and the second pane's request was the one a slow
 * hour kept waiting.
 */
const inflight = new Map<string, Promise<[Pick<ObsRender, "coordinates" | "meta">, ObsVectors]>>();
function frameData(args: { source: string; field: string; key: string }) {
  const k = `${args.source}|${args.field}|${args.key}`;
  let p = inflight.get(k);
  if (!p) {
    p = Promise.all([fetchObsMeta(args), fetchObsVectors(args)]);
    inflight.set(k, p);
    const drop = () => inflight.delete(k);
    p.then(drop, drop);
  }
  return p;
}

function hideDetail(map: MapLibreMap, st: PaneState): void {
  st.detailSeq += 1;
  st.detailKey = "";
  if (map.getLayer(DETAIL)) map.setLayoutProperty(DETAIL, "visibility", "none");
}

async function refreshDetail(map: MapLibreMap): Promise<void> {
  const st = state.get(map);
  const src = map.getSource(DETAIL_SRC) as ImageSource | undefined;
  if (!st || !src || !map.getLayer(DETAIL)) return;
  const { source, field, frames, index } = useObsStore.getState();
  const frame = frames[index];
  const want = frame ? `${source}|${field}|${frame.key}` : "";
  // Only over a frame that is already drawn, and only once zoomed in.
  if (!frame || st.shown !== want || map.getZoom() < DETAIL_MIN_ZOOM) {
    hideDetail(map, st);
    return;
  }
  const b = map.getBounds();
  let west = b.getWest();
  let east = b.getEast();
  let north = Math.min(b.getNorth(), 85);
  let south = Math.max(b.getSouth(), -85);
  // A view across the antimeridian, or wider than the analyses, keeps the
  // whole-domain picture: at that scale it is sharp enough already.
  if (west < -180 || east > 180 || east - west > 120) {
    hideDetail(map, st);
    return;
  }
  // A margin, so a small pan does not uncover the edge before the next picture.
  const padX = (east - west) * 0.12;
  const padY = (north - south) * 0.12;
  west = Math.max(-180, west - padX);
  east = Math.min(180, east + padX);
  north = Math.min(85, north + padY);
  south = Math.max(-85, south - padY);

  const canvas = map.getCanvas();
  const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
  const width = Math.min(2048, Math.max(64, canvas.clientWidth * 1.24 * ratio));
  const height = Math.min(2048, Math.max(64, canvas.clientHeight * 1.24 * ratio));
  const key = `${want}|${west.toFixed(2)},${south.toFixed(2)},${east.toFixed(2)},${north.toFixed(2)}|${Math.round(width)}x${Math.round(height)}`;
  if (key === st.detailKey) return;

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
    map.setLayoutProperty(DETAIL, "visibility", "visible");
  } catch {
    // The whole-domain picture is still underneath; a missed detail is not an error.
    if (seq === st.detailSeq) hideDetail(map, st);
  }
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
  const image = map.getSource(SRC) as ImageSource | undefined;
  const lines = map.getSource(LINES_SRC) as GeoJSONSource | undefined;
  const edge = map.getSource(EDGE_SRC) as GeoJSONSource | undefined;
  const barbs = map.getSource(BARBS_SRC) as GeoJSONSource | undefined;
  if (!image || !lines || !edge || !barbs) return;

  const { source, field, frames, index } = useObsStore.getState();
  const frame = frames[index];
  if (!frame) return;
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
    const [picture, vectors] = await frameData(args);
    // A slower earlier frame must not paint over a newer one that already landed.
    if (seq !== st.seq || !map.getSource(SRC)) return;
    // The meta call made the PNG; this URL is served straight from that cache.
    image.updateImage({ url: obsImageUrl(args), coordinates: picture.coordinates as never });
    lines.setData(vectors.contours);
    edge.setData(vectors.edge);
    barbs.setData(barbFeatures(vectors.barbs));
    st.shown = want;
    void refreshDetail(map);
    useObsStore.getState().setStatus({
      busy: false,
      error: null,
      valid: picture.meta.valid,
      bar: picture.meta.bar,
      interval: vectors.interval,
      linesUnit: vectors.linesUnit,
    });
  } catch (err) {
    if (seq !== st.seq) return;
    st.shown = "";
    lines.setData(EMPTY);
    edge.setData(EMPTY);
    barbs.setData(EMPTY);
    useObsStore.getState().setStatus({
      busy: false,
      error: err instanceof Error ? err.message : String(err),
      valid: null,
      interval: null,
    });
  }
}

function applyVisibility(map: MapLibreMap): void {
  const { showLines, showEdge, showBarbs } = useObsStore.getState();
  const want: [string, boolean][] = [
    [LINE, showLines],
    [LABEL, showLines],
    [EDGE, showEdge],
    ...BARB_IDS.map((id): [string, boolean] => [id, showBarbs]),
  ];
  for (const [id, on] of want) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  }
}

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
  name: "Observations (analysis)",
  description:
    "Surface, upper-air and severe-weather analyses on the hour — temperature, CAPE, helicity, the STP, 500 mb flow — scrubbable back through three days.",
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
    if (!map.getSource(LINES_SRC)) map.addSource(LINES_SRC, { type: "geojson", data: EMPTY });
    if (!map.getSource(EDGE_SRC)) map.addSource(EDGE_SRC, { type: "geojson", data: EMPTY });
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
    if (!map.getLayer(LINE)) {
      map.addLayer({
        id: LINE,
        type: "line",
        source: LINES_SRC,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          // Ink, not colour: the field underneath is already saying the value,
          // and a second hue here would fight it.
          "line-color": "rgba(10, 16, 24, 0.7)",
          "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.8, 7, 1.5, 11, 2.1],
        },
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
    if (!map.getLayer(LABEL)) {
      map.addLayer({
        id: LABEL,
        type: "symbol",
        source: LINES_SRC,
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 170,
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 11,
          "text-rotation-alignment": "map",
          "text-pitch-alignment": "viewport",
          "text-allow-overlap": false,
          "text-padding": 3,
        },
        paint: {
          "text-color": "#0c121a",
          // The halo is what lets a number sit ON its own line without the
          // line striking through it.
          "text-halo-color": "rgba(255, 255, 255, 0.92)",
          "text-halo-width": 1.8,
        },
      });
    }
    applyVisibility(map);

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
      if (s.source !== prev.source || s.field !== prev.field || s.index !== prev.index || s.frames !== prev.frames) {
        void draw(map);
      }
      if (s.showLines !== prev.showLines || s.showEdge !== prev.showEdge || s.showBarbs !== prev.showBarbs) {
        applyVisibility(map);
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
    state.set(map, {
      seq: 0,
      shown: "",
      unsub,
      onMissing,
      onMove,
      detailSeq: 0,
      detailKey: "",
      detailUrl: null,
      moveTimer: null,
    });

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
      if (st.moveTimer != null) window.clearTimeout(st.moveTimer);
      if (st.detailUrl) URL.revokeObjectURL(st.detailUrl);
      state.delete(map);
    }
    for (const id of ALL) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of [SRC, DETAIL_SRC, LINES_SRC, EDGE_SRC, BARBS_SRC]) if (map.getSource(id)) map.removeSource(id);
    useObsStore.getState().setStatus({ busy: false, error: null, valid: null, interval: null });
  },

  setOpacity(map, opacity) {
    if (map.getLayer(LAYER)) map.setPaintProperty(LAYER, "raster-opacity", opacity);
    if (map.getLayer(DETAIL)) map.setPaintProperty(DETAIL, "raster-opacity", opacity);
    // The lines and barbs stay readable as the field is faded back: they are
    // the part you are meant to read when the colours are turned down.
    const ink = Math.min(1, 0.35 + opacity * 0.5);
    if (map.getLayer(LINE)) map.setPaintProperty(LINE, "line-opacity", ink);
    if (map.getLayer(LABEL)) map.setPaintProperty(LABEL, "text-opacity", ink);
    for (const id of BARB_IDS) if (map.getLayer(id)) map.setPaintProperty(id, "icon-opacity", Math.min(1, ink + 0.1));
  },

  getLayerIds() {
    return ALL;
  },
};
