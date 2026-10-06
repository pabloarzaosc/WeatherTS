import type { ImageSource, Map as MapLibreMap } from "maplibre-gl";

import type { LayerModule } from "../types";
import { loadDrap, loadEfield, loadGlotec, loadOvation, type PointField } from "../../lib/space/data";
import { useSpaceStore, type SpaceField } from "../../store/useSpaceStore";

/**
 * Space weather on the map: SWPC's grids, drawn in the browser.
 *
 * Each grid comes as numbers, not a picture -- the OVATION aurora on a 1-degree
 * grid, D-RAP as a text table, GloTEC and the geoelectric field as GeoJSON
 * points -- so they are painted here into a Mercator image (rows spaced the
 * way the map spaces latitude, so MapLibre's four-corner placement is exact),
 * and the same grid answers the readout under the pointer.
 */

/** A regular grid: v[j * w + i] at lon0 + i * dlon, lat0 + j * dlat. */
export interface Grid {
  w: number;
  h: number;
  lon0: number;
  dlon: number;
  lat0: number;
  dlat: number;
  v: Float32Array;
  /** Longitude wraps around the globe. */
  wrap: boolean;
}

/** Bilinear inside the grid; where a corner is missing, the nearest value there is. */
export function sampleGrid(g: Grid, lat: number, lon: number): number {
  let fx = (lon - g.lon0) / g.dlon;
  if (g.wrap) fx = ((fx % g.w) + g.w) % g.w;
  const fy = (lat - g.lat0) / g.dlat;
  if (fy < -0.5 || fy > g.h - 0.5 || (!g.wrap && (fx < -0.5 || fx > g.w - 0.5))) return NaN;
  const x0 = Math.floor(fx);
  const y0 = Math.max(0, Math.min(g.h - 1, Math.floor(fy)));
  const y1 = Math.min(g.h - 1, y0 + 1);
  const x0i = g.wrap ? ((x0 % g.w) + g.w) % g.w : Math.max(0, Math.min(g.w - 1, x0));
  const x1i = g.wrap ? (x0i + 1) % g.w : Math.min(g.w - 1, x0i + 1);
  const tx = Math.min(1, Math.max(0, fx - x0));
  const ty = Math.min(1, Math.max(0, fy - y0));
  const a = g.v[y0 * g.w + x0i];
  const b = g.v[y0 * g.w + x1i];
  const c = g.v[y1 * g.w + x0i];
  const d = g.v[y1 * g.w + x1i];
  if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d)) {
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
  // At the edge of the data (the geoelectric field stops at the coast) the
  // nearest point decides, so the edge is the grid's own and not smeared.
  const n = tx < 0.5 ? (ty < 0.5 ? a : c) : ty < 0.5 ? b : d;
  return Number.isFinite(n) ? n : NaN;
}

function pointsGrid(f: PointField): Grid {
  let lonMin = Infinity;
  let lonMax = -Infinity;
  let latMin = Infinity;
  let latMax = -Infinity;
  for (const [lon, lat] of f.points) {
    if (lon < lonMin) lonMin = lon;
    if (lon > lonMax) lonMax = lon;
    if (lat < latMin) latMin = lat;
    if (lat > latMax) latMax = lat;
  }
  const w = Math.round((lonMax - lonMin) / f.dLon) + 1;
  const h = Math.round((latMax - latMin) / f.dLat) + 1;
  const v = new Float32Array(w * h).fill(NaN);
  for (const [lon, lat, x] of f.points) v[Math.round((lat - latMin) / f.dLat) * w + Math.round((lon - lonMin) / f.dLon)] = x;
  return { w, h, lon0: lonMin, dlon: f.dLon, lat0: latMin, dlat: f.dLat, v, wrap: w * f.dLon >= 359 };
}

// ------------------------------------------------------------------ colour

export interface Legend {
  title: string;
  units: string;
  /** value, colour -- drawn as a bar. */
  stops: [number, string][];
  log?: boolean;
  note: string;
}

type RGBA = [number, number, number, number];
const hex = (h: string, a = 255): RGBA => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
};

/** A ramp through colour stops, with alpha per stop, read from a table of
 *  1024 steps: a world picture is two million lookups. */
function ramp(stops: [number, RGBA][]): (v: number) => RGBA | null {
  const lo = stops[0][0];
  const hi = stops[stops.length - 1][0];
  const N = 1024;
  const lut: (RGBA | null)[] = [];
  for (let i = 0; i < N; i++) {
    const v = lo + ((hi - lo) * i) / (N - 1);
    let k = 1;
    while (k < stops.length - 1 && v > stops[k][0]) k++;
    const [a, ca] = stops[k - 1];
    const [b, cb] = stops[k];
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    const c = [0, 1, 2, 3].map((j) => Math.round(ca[j] + (cb[j] - ca[j]) * t)) as RGBA;
    lut.push(c[3] === 0 ? null : c);
  }
  return (v) => {
    if (!Number.isFinite(v)) return null;
    if (v <= lo) return stops[0][1][3] === 0 ? null : stops[0][1];
    if (v >= hi) return stops[stops.length - 1][1];
    return lut[Math.round(((v - lo) / (hi - lo)) * (N - 1))];
  };
}

function logRamp(stops: [number, RGBA][]): (v: number) => RGBA | null {
  const r = ramp(stops);
  return (v) => r(Math.log10(Math.max(1, v)));
}

interface Style {
  color: (v: number) => RGBA | null;
  legend: Legend;
  fmt: (v: number) => string;
  label: string;
}

const AURORA: Style = {
  color: ramp([
    [3, hex("#00ff4c", 0)],
    [10, hex("#2ee05a", 120)],
    [30, hex("#55e83a", 185)],
    [50, hex("#f5e52a", 215)],
    [70, hex("#ff8c1a", 230)],
    [90, hex("#ff2a1a", 240)],
  ]),
  legend: {
    title: "Aurora (OVATION)",
    units: "%",
    stops: [
      [5, "#2ee05a"],
      [30, "#55e83a"],
      [50, "#f5e52a"],
      [70, "#ff8c1a"],
      [90, "#ff2a1a"],
    ],
    note: "Chance of aurora overhead in the next 30-90 minutes",
  },
  fmt: (v) => `${Math.round(v)}%`,
  label: "Aurora",
};

const FIELDS: Record<SpaceField, Style> = {
  drap: {
    color: ramp([
      [0.3, hex("#2b1b6e", 0)],
      [1, hex("#3b2bb0", 150)],
      [5, hex("#2a7bff", 190)],
      [10, hex("#14c8c8", 205)],
      [15, hex("#3fd24a", 215)],
      [20, hex("#f2e33a", 225)],
      [25, hex("#ff9a1f", 235)],
      [35, hex("#e8261c", 245)],
    ]),
    legend: {
      title: "HF absorption (D-RAP)",
      units: "MHz",
      stops: [
        [1, "#3b2bb0"],
        [5, "#2a7bff"],
        [10, "#14c8c8"],
        [15, "#3fd24a"],
        [20, "#f2e33a"],
        [25, "#ff9a1f"],
        [35, "#e8261c"],
      ],
      note: "Highest frequency losing 1 dB: HF below it is degraded",
    },
    fmt: (v) => `${v.toFixed(1)} MHz`,
    label: "D-RAP",
  },
  tec: {
    color: ramp([
      [0, hex("#30123b", 170)],
      [10, hex("#4662d7", 175)],
      [20, hex("#36aaf9", 180)],
      [30, hex("#1ae4b6", 185)],
      [40, hex("#72fe5e", 190)],
      [55, hex("#c7ef34", 195)],
      [70, hex("#fbb938", 200)],
      [85, hex("#f56918", 205)],
      [100, hex("#c92903", 210)],
    ]),
    legend: {
      title: "Total electron content (GloTEC)",
      units: "TECU",
      stops: [
        [0, "#30123b"],
        [20, "#36aaf9"],
        [40, "#72fe5e"],
        [70, "#fbb938"],
        [100, "#c92903"],
      ],
      note: "1 TECU is about 16 cm of GPS L1 range error",
    },
    fmt: (v) => `${v.toFixed(1)} TECU`,
    label: "TEC",
  },
  anomaly: {
    color: ramp([
      [-15, hex("#1d4fd8", 210)],
      [-6, hex("#5b8cf0", 170)],
      [-1.5, hex("#c9d6f5", 40)],
      [0, hex("#ffffff", 0)],
      [1.5, hex("#f5d0c9", 40)],
      [6, hex("#f0785b", 170)],
      [15, hex("#d0251d", 210)],
    ]),
    legend: {
      title: "TEC anomaly (GloTEC)",
      units: "TECU",
      stops: [
        [-15, "#1d4fd8"],
        [-6, "#5b8cf0"],
        [0, "#e6e6e6"],
        [6, "#f0785b"],
        [15, "#d0251d"],
      ],
      note: "Against the 10-day median: storms push it far either way",
    },
    fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} TECU`,
    label: "TEC anomaly",
  },
  efield: {
    color: logRamp([
        [0, hex("#2b5ce6", 120)],
        [1, hex("#2bb3c0", 170)],
        [2, hex("#3fd24a", 195)],
        [2.7, hex("#f2e33a", 215)],
        [3.3, hex("#ff7a1a", 235)],
        [4, hex("#c80000", 245)],
      ]),
    legend: {
      title: "Geoelectric field",
      units: "mV/km",
      log: true,
      stops: [
        [1, "#2b5ce6"],
        [10, "#2bb3c0"],
        [100, "#3fd24a"],
        [500, "#f2e33a"],
        [2000, "#ff7a1a"],
        [10000, "#c80000"],
      ],
      note: "Ground field driving currents into long power lines",
    },
    fmt: (v) => `${v.toFixed(v < 10 ? 1 : 0)} mV/km`,
    label: "Geoelectric field",
  },
};

export function spaceLegend(kind: "aurora" | SpaceField): Legend {
  return kind === "aurora" ? AURORA.legend : FIELDS[kind].legend;
}

// ------------------------------------------------------------------ painting

const MERC_MAX = 85.0511;
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const latOfMerc = (y: number) => (Math.atan(Math.sinh(y)) * 180) / Math.PI;

type Box = [number, number, number, number]; // west, south, east, north

async function paint(g: Grid, box: Box, color: Style["color"], W: number, H: number): Promise<string> {
  const [west, south, east, north] = box;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const yN = mercY(north);
  const yS = mercY(south);
  const lons = new Float64Array(W);
  for (let x = 0; x < W; x++) lons[x] = west + ((x + 0.5) / W) * (east - west);
  for (let y = 0; y < H; y++) {
    const lat = latOfMerc(yN - ((y + 0.5) / H) * (yN - yS));
    for (let x = 0; x < W; x++) {
      const c = color(sampleGrid(g, lat, lons[x]));
      if (!c) continue;
      const k = (y * W + x) * 4;
      d[k] = c[0];
      d[k + 1] = c[1];
      d[k + 2] = c[2];
      d[k + 3] = c[3];
    }
  }
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, "image/png"));
  return blob ? URL.createObjectURL(blob) : cv.toDataURL("image/png");
}

const corners = ([w, s, e, n]: Box) => [
  [w, n],
  [e, n],
  [e, s],
  [w, s],
];

const BLANK = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const WORLD: Box = [-180, -MERC_MAX, 180, MERC_MAX];

// ------------------------------------------------------------------ the layers

interface Built {
  grid: Grid;
  box: Box;
  url: string;
  valid: number;
  style: Style;
}

/** The grids the readout reads, by layer. */
const current: { aurora: Built | null; field: Built | null } = { aurora: null, field: null };

export function spaceValueAt(kind: "aurora" | "field", lat: number, lon: number): { text: string; label: string } | null {
  const b = current[kind];
  if (!b) return null;
  const v = sampleGrid(b.grid, lat, lon);
  if (!Number.isFinite(v)) return null;
  if (kind === "aurora" && v < 1) return null;
  return { text: b.style.fmt(v), label: b.style.label };
}

interface Def {
  id: string;
  src: string;
  layer: string;
  refreshMs: number;
  slot: "aurora" | "field";
  build: () => Promise<Built>;
  /** Rebuild when the store says so (the field picker). */
  watch?: (cb: () => void) => () => void;
}

function makeLayer(def: Def, meta: Omit<LayerModule, "addTo" | "removeFrom" | "setOpacity" | "getLayerIds">): LayerModule {
  const maps = new Set<MapLibreMap>();
  let opacity = meta.defaultOpacity;
  let timer = 0;
  let unwatch: (() => void) | null = null;
  let seq = 0;

  const apply = (map: MapLibreMap, b: Built | null) => {
    const src = map.getSource(def.src) as ImageSource | undefined;
    if (!src) return;
    src.updateImage({ url: b ? b.url : BLANK, coordinates: corners(b ? b.box : WORLD) as never });
  };

  const refresh = async () => {
    const my = ++seq;
    try {
      const b = await def.build();
      if (my !== seq || !maps.size) {
        URL.revokeObjectURL(b.url);
        return;
      }
      const old = current[def.slot];
      current[def.slot] = b;
      for (const m of maps) apply(m, b);
      useSpaceStore.getState().setValid(def.slot === "aurora" ? "auroraValid" : "fieldValid", b.valid);
      if (old && old.url.startsWith("blob:")) window.setTimeout(() => URL.revokeObjectURL(old.url), 3000);
    } catch (e) {
      console.warn(`[${def.id}]`, e);
    }
  };

  return {
    ...meta,
    addTo(map) {
      if (!map.getSource(def.src)) {
        const b = current[def.slot];
        map.addSource(def.src, { type: "image", url: b ? b.url : BLANK, coordinates: corners(b ? b.box : WORLD) as never });
      }
      if (!map.getLayer(def.layer)) {
        map.addLayer({
          id: def.layer,
          type: "raster",
          source: def.src,
          paint: { "raster-opacity": opacity, "raster-fade-duration": 0, "raster-resampling": "linear" },
        });
      }
      maps.add(map);
      if (maps.size === 1) {
        void refresh();
        timer = window.setInterval(refresh, def.refreshMs);
        unwatch = def.watch?.(() => void refresh()) ?? null;
      } else if (current[def.slot]) apply(map, current[def.slot]);
    },
    removeFrom(map) {
      maps.delete(map);
      if (map.getLayer(def.layer)) map.removeLayer(def.layer);
      if (map.getSource(def.src)) map.removeSource(def.src);
      if (!maps.size) {
        window.clearInterval(timer);
        unwatch?.();
        unwatch = null;
        seq++;
        current[def.slot] = null;
        useSpaceStore.getState().setValid(def.slot === "aurora" ? "auroraValid" : "fieldValid", null);
      }
    },
    setOpacity(map, o) {
      opacity = o;
      if (map.getLayer(def.layer)) map.setPaintProperty(def.layer, "raster-opacity", o);
    },
    getLayerIds() {
      return [def.layer];
    },
  };
}

export const auroraLayer = makeLayer(
  {
    id: "space-aurora",
    src: "space-aurora-src",
    layer: "space-aurora-raster",
    refreshMs: 5 * 60_000,
    slot: "aurora",
    async build() {
      const o = await loadOvation();
      const v = new Float32Array(o.grid.length);
      for (let i = 0; i < v.length; i++) v[i] = o.grid[i];
      const grid: Grid = { w: 360, h: 181, lon0: 0, dlon: 1, lat0: -90, dlat: 1, v, wrap: true };
      return { grid, box: WORLD, url: await paint(grid, WORLD, AURORA.color, 1440, 1440), valid: o.forecast, style: AURORA };
    },
  },
  {
    id: "space-aurora",
    name: "Aurora forecast",
    description: "SWPC's OVATION model: the chance of aurora overhead in the next half hour to hour and a half, both hemispheres, updated every 5 minutes.",
    category: "weather",
    source: "NOAA SWPC OVATION Prime",
    defaultVisible: false,
    defaultOpacity: 0.85,
  },
);

async function buildField(): Promise<Built> {
  const kind = useSpaceStore.getState().field;
  const style = FIELDS[kind];
  if (kind === "drap") {
    const d = await loadDrap();
    // The table runs north to south; the grid wants south first.
    const h = d.lats.length;
    const w = d.lons.length;
    const v = new Float32Array(w * h);
    const order = d.lats.map((lat, i) => ({ lat, i })).sort((a, b) => a.lat - b.lat);
    order.forEach(({ i }, j) => {
      for (let x = 0; x < w; x++) v[j * w + x] = d.rows[i][x];
    });
    const grid: Grid = { w, h, lon0: d.lons[0], dlon: d.lons[1] - d.lons[0], lat0: order[0].lat, dlat: order[1].lat - order[0].lat, v, wrap: true };
    return { grid, box: WORLD, url: await paint(grid, WORLD, style.color, 1024, 1024), valid: d.valid, style };
  }
  if (kind === "tec" || kind === "anomaly") {
    const f = await loadGlotec(kind);
    const grid = pointsGrid(f);
    return { grid, box: WORLD, url: await paint(grid, WORLD, style.color, 1024, 1024), valid: f.valid, style };
  }
  const f = await loadEfield();
  const grid = pointsGrid(f);
  const box: Box = [grid.lon0 - grid.dlon / 2, grid.lat0 - grid.dlat / 2, grid.lon0 + (grid.w - 0.5) * grid.dlon, grid.lat0 + (grid.h - 0.5) * grid.dlat];
  return { grid, box, url: await paint(grid, box, style.color, grid.w * 4, grid.h * 6), valid: f.valid, style };
}

export const spaceFieldLayer = makeLayer(
  {
    id: "space-field",
    src: "space-field-src",
    layer: "space-field-raster",
    refreshMs: 2 * 60_000,
    slot: "field",
    build: buildField,
    watch: (cb) => useSpaceStore.subscribe((s, p) => s.field !== p.field && cb()),
  },
  {
    id: "space-field",
    name: "Ionosphere and ground field",
    description: "SWPC's D-RAP HF absorption, GloTEC total electron content and its anomaly, or the geoelectric field over the US and Canada. Pick it in the Space panel.",
    category: "weather",
    source: "NOAA SWPC D-RAP, GloTEC, Geoelectric Field",
    defaultVisible: false,
    defaultOpacity: 0.8,
  },
);
