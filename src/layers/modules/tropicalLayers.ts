import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type MapLayerMouseEvent, type RasterTileSource } from "maplibre-gl";

import type { LayerModule } from "../types";
import { registerMarkerLayers, unregisterMarkerLayers } from "../clickPriority";
import {
  CAT_COLORS,
  catOf,
  gibsSstTiles,
  loadGuidance,
  loadRecon,
  loadSeason,
  loadStorms,
  loadTrack,
  nhcBinGeo,
  nhcWindProb,
  typeName,
  type ActiveStorm,
  type ReconMission,
  type TrackPoint,
} from "../../lib/tropical/data";
import { useTropicalStore } from "../../store/useTropicalStore";
import { openStormCard } from "../../ui/tropical/StormCard";

/**
 * Tropical cyclones on the map.
 *
 * - Storms: every active system worldwide. NHC's own cone, forecast track and
 *   points and coastal watches and warnings for its storms (its GIS
 *   MapServer); for every storm, the best track so far coloured by category
 *   and the current wind radii from the best-track deck; JTWC's forecast
 *   track for the storms it advises on.
 * - Guidance: the model tracks for the storm picked in the Tropical screen.
 * - Wind speed probabilities: NHC's 34/50/64 kt chances over 5 days.
 * - Recon: Hurricane Hunter flights, coloured by what they measured.
 * - Season: every track of one season.
 * - SST: GHRSST MUR from GIBS.
 */

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
type FC = GeoJSON.FeatureCollection;

const CAT_EXPR: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "cat"],
  "TD", CAT_COLORS.TD,
  "TS", CAT_COLORS.TS,
  "C1", CAT_COLORS.C1,
  "C2", CAT_COLORS.C2,
  "C3", CAT_COLORS.C3,
  "C4", CAT_COLORS.C4,
  "C5", CAT_COLORS.C5,
  "#cccccc",
];

const LETTER: Record<string, string> = { TD: "D", TS: "S", C1: "H", C2: "H", C3: "M", C4: "M", C5: "M" };

/** Keep a line continuous across the antimeridian: 179E then 179W is 181E. */
function unwrap(coords: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [lon, lat] of coords) {
    if (!out.length) {
      out.push([lon, lat]);
      continue;
    }
    let x = lon;
    const prev = out[out.length - 1][0];
    while (x - prev > 180) x -= 360;
    while (prev - x > 180) x += 360;
    out.push([x, lat]);
  }
  return out;
}

/** A wind-radii polygon: a radius per quadrant (NE, SE, SW, NW), in nautical miles. */
function radiiPolygon(lat: number, lon: number, quads: [number, number, number, number]): GeoJSON.Polygon {
  const ring: [number, number][] = [];
  const cos = Math.cos((lat * Math.PI) / 180);
  for (let a = 0; a <= 360; a += 4) {
    const q = a === 360 ? 3 : Math.floor(a / 90);
    const km = quads[q] * 1.852;
    const th = (a * Math.PI) / 180;
    ring.push([lon + (km * Math.sin(th)) / (111.2 * Math.max(cos, 0.1)), lat + (km * Math.cos(th)) / 111.2]);
  }
  return { type: "Polygon", coordinates: [ring] };
}

const fmtTime = (t: number) => {
  const d = new Date(t);
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2, "0")}Z`;
};

// ---------------------------------------------------------------- a module that keeps GeoJSON sources fed

interface Spec {
  id: string;
  name: string;
  description: string;
  source: string;
  sources: string[];
  /** Layer specs in drawing order (bottom first). */
  layers: (maplibregl.LayerSpecification & { source: string })[];
  markers?: string[];
  /** Read the data: one FeatureCollection per source. */
  build: () => Promise<Record<string, FC>>;
  refreshMs: number;
  /** Store changes that call for a rebuild. */
  watch?: (cb: () => void) => () => void;
  hover?: { layers: string[]; html: (p: Record<string, unknown>) => string };
  click?: { layers: string[]; act: (p: Record<string, unknown>, map: MapLibreMap, f: maplibregl.MapGeoJSONFeature) => void };
  /** Paint properties that follow the opacity slider. */
  opacityProps: [string, string, number][];
  defaultOpacity?: number;
  /** After new data reaches a map, and when a map takes or drops the layer. */
  afterPush?: (map: MapLibreMap) => void;
  onAdd?: (map: MapLibreMap) => void;
  onRemove?: (map: MapLibreMap) => void;
}

function makeModule(spec: Spec): LayerModule {
  const maps = new Map<MapLibreMap, { popup: maplibregl.Popup; off: () => void }>();
  let data: Record<string, FC> = {};
  let timer = 0;
  let unwatch: (() => void) | null = null;
  let seq = 0;
  let opacity = spec.defaultOpacity ?? 1;

  const push = (map: MapLibreMap) => {
    for (const s of spec.sources) (map.getSource(s) as GeoJSONSource | undefined)?.setData(data[s] ?? EMPTY);
    spec.afterPush?.(map);
  };
  const refresh = async () => {
    const my = ++seq;
    try {
      const d = await spec.build();
      if (my !== seq) return;
      data = d;
      for (const m of maps.keys()) push(m);
    } catch (e) {
      console.warn(`[${spec.id}]`, e);
    }
  };
  const applyOpacity = (map: MapLibreMap) => {
    for (const [layer, prop, base] of spec.opacityProps) if (map.getLayer(layer)) map.setPaintProperty(layer, prop, base * opacity);
  };

  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    category: "weather",
    source: spec.source,
    defaultVisible: false,
    defaultOpacity: spec.defaultOpacity ?? 1,
    addTo(map) {
      for (const s of spec.sources) if (!map.getSource(s)) map.addSource(s, { type: "geojson", data: data[s] ?? EMPTY });
      for (const l of spec.layers) if (!map.getLayer(l.id)) map.addLayer(l);
      applyOpacity(map);
      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "trp-popup", maxWidth: "260px" });
      const offs: (() => void)[] = [];
      if (spec.hover) {
        const move = (e: MapLayerMouseEvent) => {
          const f = e.features?.[0];
          if (!f) return;
          map.getCanvas().style.cursor = spec.click ? "pointer" : "";
          popup.setLngLat(e.lngLat).setHTML(spec.hover!.html(f.properties as Record<string, unknown>)).addTo(map);
        };
        const leave = () => {
          map.getCanvas().style.cursor = "";
          popup.remove();
        };
        for (const l of spec.hover.layers) {
          map.on("mousemove", l, move);
          map.on("mouseleave", l, leave);
          offs.push(() => {
            map.off("mousemove", l, move);
            map.off("mouseleave", l, leave);
          });
        }
      }
      if (spec.click) {
        const click = (e: MapLayerMouseEvent) => {
          const f = e.features?.[0];
          if (f) spec.click!.act(f.properties as Record<string, unknown>, map, f);
        };
        const enter = () => (map.getCanvas().style.cursor = "pointer");
        const out = () => (map.getCanvas().style.cursor = "");
        for (const l of spec.click.layers) {
          map.on("click", l, click);
          map.on("mouseenter", l, enter);
          map.on("mouseleave", l, out);
          offs.push(() => {
            map.off("click", l, click);
            map.off("mouseenter", l, enter);
            map.off("mouseleave", l, out);
          });
        }
      }
      if (spec.markers) registerMarkerLayers(spec.markers);
      maps.set(map, { popup, off: () => offs.forEach((f) => f()) });
      spec.onAdd?.(map);
      if (maps.size === 1) {
        void refresh();
        timer = window.setInterval(refresh, spec.refreshMs);
        unwatch = spec.watch?.(() => void refresh()) ?? null;
      } else push(map);
    },
    removeFrom(map) {
      spec.onRemove?.(map);
      const st = maps.get(map);
      if (st) {
        st.off();
        st.popup.remove();
        maps.delete(map);
      }
      for (const l of [...spec.layers].reverse()) if (map.getLayer(l.id)) map.removeLayer(l.id);
      for (const s of spec.sources) if (map.getSource(s)) map.removeSource(s);
      if (!maps.size) {
        window.clearInterval(timer);
        unwatch?.();
        unwatch = null;
        seq++;
        if (spec.markers) unregisterMarkerLayers(spec.markers);
      }
    },
    setOpacity(map, o) {
      opacity = o;
      applyOpacity(map);
    },
    getLayerIds() {
      return spec.layers.map((l) => l.id);
    },
  };
}

/** A click on a storm: its card, with the way to its satellite picture and models. */
const openStorm = (p: Record<string, unknown>, map: MapLibreMap, f: maplibregl.MapGeoJSONFeature) => {
  if (typeof p.sid !== "string" || f.geometry.type !== "Point") return;
  openStormCard(map, p, f.geometry.coordinates as [number, number]);
};

// ---------------------------------------------------------------- active storms

const WW_COLORS: maplibregl.ExpressionSpecification = ["match", ["get", "tcww"], "HWR", "#ff1f1f", "HWA", "#ff8ad8", "TWR", "#1f6bff", "TWA", "#ffe14d", "#cccccc"];

async function buildStorms(): Promise<Record<string, FC>> {
  const { storms } = await loadStorms();
  const out: Record<string, GeoJSON.Feature[]> = { "trp-cone": [], "trp-ww": [], "trp-fline": [], "trp-fpts": [], "trp-pline": [], "trp-ppts": [], "trp-radii": [], "trp-now": [] };
  await Promise.all(
    storms.map(async (s: ActiveStorm) => {
      const label = s.invest ? s.name : `${typeName(s.type, s.vmax, s.basin)} ${s.name}`;
      // The best track so far, coloured by category.
      try {
        const tr = await loadTrack(s.id);
        const pts = tr.points;
        const coords = unwrap(pts.map((p) => [p.lon, p.lat]));
        for (let i = 1; i < pts.length; i++) {
          out["trp-pline"].push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: [coords[i - 1], coords[i]] },
            properties: { cat: pts[i - 1].cat, sid: s.id },
          });
        }
        pts.forEach((p: TrackPoint, i) => {
          if (new Date(p.t).getUTCHours() % 6) return;
          out["trp-ppts"].push({
            type: "Feature",
            geometry: { type: "Point", coordinates: coords[i] },
            properties: { cat: p.cat, sid: s.id, name: s.name, t: p.t, vmax: p.vmax, mslp: p.mslp, kind: "past", type: p.type },
          });
        });
        const last = pts[pts.length - 1];
        if (last) {
          for (const kt of ["34", "50", "64"] as const) {
            const q = last.radii[kt];
            if (q && q.some((v) => v > 0)) out["trp-radii"].push({ type: "Feature", geometry: radiiPolygon(s.lat, s.lon, q), properties: { kt: Number(kt), sid: s.id } });
          }
        }
      } catch {
        /* the storm still gets its marker */
      }
      out["trp-now"].push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties: { cat: s.cat, sid: s.id, name: s.name, label, letter: s.invest ? "" : LETTER[s.cat], vmax: s.vmax, mslp: s.mslp, t: s.t, invest: s.invest, kind: "now", agency: s.agency },
      });
      // The official forecast: NHC's GIS for its storms, JTWC's warning otherwise.
      if (s.nhc?.bin) {
        const bin = s.nhc.bin;
        const [cone, track, points, ww] = await Promise.all([
          nhcBinGeo(bin, "cone").catch(() => null),
          nhcBinGeo(bin, "track").catch(() => null),
          nhcBinGeo(bin, "points").catch(() => null),
          nhcBinGeo(bin, "ww").catch(() => null),
        ]);
        for (const f of cone?.features ?? []) out["trp-cone"].push({ ...f, properties: { ...f.properties, sid: s.id } });
        for (const f of track?.features ?? []) out["trp-fline"].push({ ...f, properties: { sid: s.id, official: true } });
        for (const f of ww?.features ?? []) out["trp-ww"].push({ ...f, properties: { tcww: (f.properties as { tcww?: string })?.tcww ?? "", sid: s.id } });
        for (const f of points?.features ?? []) {
          const p = f.properties as { maxwind?: number; dvlbl?: string; datelbl?: string; fldatelbl?: string; mslp?: number; tau?: number; fcstprd?: number };
          if (p.fcstprd === 0) continue;
          out["trp-fpts"].push({
            ...f,
            properties: { cat: catOf(p.maxwind), sid: s.id, name: s.name, letter: p.dvlbl ?? LETTER[catOf(p.maxwind)], vmax: p.maxwind, when: p.datelbl ?? "", full: p.fldatelbl ?? "", kind: "fcst" },
          });
        }
      } else if (!s.invest) {
        try {
          const g = await loadGuidance(s.id);
          const jt = g.models.find((m) => m.tech === "JTWC");
          if (jt) {
            const pts = jt.points.filter((p) => p.lat != null && p.lon != null);
            const coords = unwrap(pts.map((p) => [p.lon!, p.lat!]));
            out["trp-fline"].push({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: { sid: s.id, official: true } });
            pts.forEach((p, i) => {
              if (p.tau === 0) return;
              out["trp-fpts"].push({
                type: "Feature",
                geometry: { type: "Point", coordinates: coords[i] },
                properties: { cat: catOf(p.vmax), sid: s.id, name: s.name, letter: LETTER[catOf(p.vmax)], vmax: p.vmax, when: fmtTime(p.t), kind: "fcst" },
              });
            });
          }
        } catch {
          /* no forecast track */
        }
      }
    }),
  );
  const fc: Record<string, FC> = {};
  for (const [k, v] of Object.entries(out)) fc[k] = { type: "FeatureCollection", features: v };
  return fc;
}

const stormTip = (p: Record<string, unknown>) => {
  const w = p.vmax != null && p.vmax !== "null" ? `${Math.round(Number(p.vmax))} kt` : "";
  const pr = p.mslp != null && p.mslp !== "null" ? ` · ${Math.round(Number(p.mslp))} mb` : "";
  if (p.kind === "fcst") return `<b>${p.name}</b> forecast<br>${p.full || p.when} · ${w}`;
  return `<b>${p.name}</b><br>${new Date(Number(p.t)).toISOString().slice(5, 16).replace("T", " ")}Z · ${w}${pr}`;
};

export const tropicalStormsLayer = makeModule({
  id: "tropical-storms",
  name: "Tropical cyclones",
  description: "Every active tropical cyclone and invest worldwide: NHC's cone, forecast track and coastal watches and warnings, JTWC's forecast track, the track so far by category and the wind radii.",
  source: "NOAA NHC / CPHC GIS, JTWC, ATCF best tracks (UCAR)",
  sources: ["trp-cone", "trp-radii", "trp-ww", "trp-pline", "trp-fline", "trp-ppts", "trp-fpts", "trp-now"],
  layers: [
    { id: "trp-cone-fill", type: "fill", source: "trp-cone", paint: { "fill-color": "#ffffff", "fill-opacity": 0.14 } },
    { id: "trp-cone-line", type: "line", source: "trp-cone", paint: { "line-color": "#ffffff", "line-width": 1.2, "line-opacity": 0.8 } },
    {
      id: "trp-radii-fill",
      type: "fill",
      source: "trp-radii",
      paint: { "fill-color": ["match", ["get", "kt"], 64, "#ff4040", 50, "#ff9a1f", "#ffe14d"], "fill-opacity": 0.18 },
    },
    {
      id: "trp-radii-line",
      type: "line",
      source: "trp-radii",
      paint: { "line-color": ["match", ["get", "kt"], 64, "#ff4040", 50, "#ff9a1f", "#ffe14d"], "line-width": 1, "line-opacity": 0.8 },
    },
    { id: "trp-ww", type: "line", source: "trp-ww", layout: { "line-cap": "round" }, paint: { "line-color": WW_COLORS, "line-width": 5, "line-opacity": 0.95 } },
    // A dark casing under the track: the TS cyan and Category 1 cream vanish on a light basemap.
    { id: "trp-pline-case", type: "line", source: "trp-pline", layout: { "line-cap": "round" }, paint: { "line-color": "rgba(0,0,0,0.55)", "line-width": 4.6 } },
    { id: "trp-pline", type: "line", source: "trp-pline", layout: { "line-cap": "round" }, paint: { "line-color": CAT_EXPR, "line-width": 2.4 } },
    { id: "trp-fline", type: "line", source: "trp-fline", paint: { "line-color": "#ffffff", "line-width": 2, "line-dasharray": [2, 1.5] } },
    {
      id: "trp-ppts",
      type: "circle",
      source: "trp-ppts",
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 2, 6, 4], "circle-color": CAT_EXPR, "circle-stroke-color": "#111", "circle-stroke-width": 0.6 },
    },
    {
      id: "trp-fpts",
      type: "circle",
      source: "trp-fpts",
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 6, 6, 9], "circle-color": CAT_EXPR, "circle-stroke-color": "#111", "circle-stroke-width": 1.2 },
    },
    {
      id: "trp-fpts-text",
      type: "symbol",
      source: "trp-fpts",
      layout: {
        "text-field": ["get", "letter"],
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 2, 9, 6, 12],
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: { "text-color": "#111" },
    },
    {
      id: "trp-fpts-when",
      type: "symbol",
      source: "trp-fpts",
      minzoom: 4,
      layout: { "text-field": ["get", "when"], "text-font": ["Noto Sans Regular"], "text-size": 10, "text-offset": [0, 1.4], "text-allow-overlap": false },
      paint: { "text-color": "#ffffff", "text-halo-color": "#000", "text-halo-width": 1.2 },
    },
    {
      id: "trp-now",
      type: "circle",
      source: "trp-now",
      paint: {
        "circle-radius": ["case", ["get", "invest"], 7, 11],
        "circle-color": ["case", ["get", "invest"], "rgba(0,0,0,0)", CAT_EXPR],
        "circle-stroke-color": ["case", ["get", "invest"], "#ff6060", "#111"],
        "circle-stroke-width": ["case", ["get", "invest"], 2.4, 1.6],
      },
    },
    {
      id: "trp-now-text",
      type: "symbol",
      source: "trp-now",
      layout: {
        "text-field": ["get", "letter"],
        "text-font": ["Noto Sans Bold"],
        "text-size": 13,
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: { "text-color": "#111" },
    },
    {
      id: "trp-now-label",
      type: "symbol",
      source: "trp-now",
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Bold"],
        "text-size": 12,
        "text-anchor": "left",
        "text-offset": [1.3, 0],
        "text-allow-overlap": true,
      },
      paint: { "text-color": "#ffffff", "text-halo-color": "#000", "text-halo-width": 1.5 },
    },
  ],
  markers: ["trp-now", "trp-fpts", "trp-ppts"],
  build: buildStorms,
  refreshMs: 120_000,
  // The marker itself opens its card on a click; a tip on top would cover it.
  hover: { layers: ["trp-fpts", "trp-ppts"], html: stormTip },
  click: { layers: ["trp-now"], act: openStorm },
  opacityProps: [
    ["trp-cone-fill", "fill-opacity", 0.14],
    ["trp-radii-fill", "fill-opacity", 0.18],
    ["trp-pline", "line-opacity", 1],
    ["trp-pline-case", "line-opacity", 1],
    ["trp-fline", "line-opacity", 1],
  ],
});

// ---------------------------------------------------------------- guidance

export const tropicalGuidanceLayer = makeModule({
  id: "tropical-guidance",
  name: "Tropical model guidance",
  description: "The track models for the storm picked in the Tropical screen: NHC or JTWC's forecast, the consensus, the global and hurricane models.",
  source: "NHC ATCF a-decks, UCAR, JTWC",
  sources: ["trp-g-line", "trp-g-pts"],
  layers: [
    {
      id: "trp-g-line",
      type: "line",
      source: "trp-g-line",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "colour"], "line-width": ["case", ["get", "official"], 3, 1.6], "line-opacity": 0.95 },
    },
    {
      id: "trp-g-pts",
      type: "circle",
      source: "trp-g-pts",
      filter: ["==", ["%", ["get", "tau"], 24], 0],
      paint: { "circle-radius": 2.6, "circle-color": ["get", "colour"], "circle-stroke-color": "#000", "circle-stroke-width": 0.5 },
    },
    {
      id: "trp-g-label",
      type: "symbol",
      source: "trp-g-pts",
      filter: ["get", "end"],
      layout: { "text-field": ["get", "tech"], "text-font": ["Noto Sans Bold"], "text-size": 10, "text-offset": [0.6, 0], "text-anchor": "left" },
      paint: { "text-color": ["get", "colour"], "text-halo-color": "#000", "text-halo-width": 1.2 },
    },
  ],
  build: async () => {
    const { storm, guidanceAll } = useTropicalStore.getState();
    if (!storm) return { "trp-g-line": EMPTY, "trp-g-pts": EMPTY };
    const g = await loadGuidance(storm, undefined, guidanceAll);
    const lines: GeoJSON.Feature[] = [];
    const pts: GeoJSON.Feature[] = [];
    for (const m of g.models) {
      if (!m.track && !guidanceAll) continue;
      const p = m.points.filter((x) => x.lat != null && x.lon != null && x.tau <= 168);
      if (p.length < 2) continue;
      const coords = unwrap(p.map((x) => [x.lon!, x.lat!]));
      const colour = /^(AP|CP|EP|NP)\d\d$/.test(m.tech) ? "rgba(143,180,255,0.55)" : m.colour;
      lines.push({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: { tech: m.tech, colour, official: m.official } });
      p.forEach((x, i) =>
        pts.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: coords[i] },
          properties: { tech: m.tech, colour, tau: x.tau, vmax: x.vmax, t: x.t, end: i === p.length - 1 && !/^(AP|CP|EP|NP)\d\d$/.test(m.tech) },
        }),
      );
    }
    return { "trp-g-line": { type: "FeatureCollection", features: lines }, "trp-g-pts": { type: "FeatureCollection", features: pts } };
  },
  refreshMs: 600_000,
  watch: (cb) => useTropicalStore.subscribe((s, p) => (s.storm !== p.storm || s.guidanceAll !== p.guidanceAll) && cb()),
  hover: {
    layers: ["trp-g-pts"],
    html: (p) => `<b>${p.tech}</b> +${p.tau} h<br>${fmtTime(Number(p.t))}${p.vmax && p.vmax !== "null" ? ` · ${Math.round(Number(p.vmax))} kt` : ""}`,
  },
  opacityProps: [["trp-g-line", "line-opacity", 0.95]],
});

// ---------------------------------------------------------------- wind speed probabilities

const WSP_COLORS: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "percentage"],
  "<5%", "rgba(0,0,0,0)",
  "5-10%", "#1f7a1f",
  "10-20%", "#38a838",
  "20-30%", "#7acc3a",
  "30-40%", "#c7e02a",
  "40-50%", "#ffe14d",
  "50-60%", "#ffb52a",
  "60-70%", "#ff8a1f",
  "70-80%", "#ff4f1f",
  "80-90%", "#d91f1f",
  ">90%", "#9a1fb5",
  "#888888",
];

export const tropicalWspLayer = makeModule({
  id: "tropical-wsp",
  name: "Tropical wind speed probabilities",
  description: "NHC's chance of tropical-storm (34 kt), 50 kt or hurricane-force (64 kt) winds over the next 5 days, from all active storms. Pick the threshold in the Tropical panel.",
  source: "NOAA NHC GIS",
  sources: ["trp-wsp"],
  layers: [
    { id: "trp-wsp-fill", type: "fill", source: "trp-wsp", paint: { "fill-color": WSP_COLORS, "fill-opacity": 0.55 } },
    { id: "trp-wsp-line", type: "line", source: "trp-wsp", paint: { "line-color": WSP_COLORS, "line-width": 0.6, "line-opacity": 0.8 } },
  ],
  build: async () => ({ "trp-wsp": (await nhcWindProb(useTropicalStore.getState().wspKt)) ?? EMPTY }),
  refreshMs: 900_000,
  watch: (cb) => useTropicalStore.subscribe((s, p) => s.wspKt !== p.wspKt && cb()),
  opacityProps: [["trp-wsp-fill", "fill-opacity", 0.55]],
  defaultOpacity: 1,
});

// ---------------------------------------------------------------- recon

/** The colour of a recon observation for what the flight is coloured by. */
function reconValue(o: ReconMission["obs"][number], by: string): number | null {
  return by === "fl" ? o.wspd : by === "sfmr" ? o.sfmr : by === "xsp" ? o.xsp : o.gph;
}
const RECON_RAMP: Record<string, maplibregl.ExpressionSpecification> = {
  fl: ["interpolate", ["linear"], ["get", "v"], 0, "#5ebaff", 34, "#00faf4", 64, "#ffffcc", 83, "#ffe775", 96, "#ffc140", 113, "#ff8f20", 137, "#ff6060", 160, "#c53bff"],
  sfmr: ["interpolate", ["linear"], ["get", "v"], 0, "#5ebaff", 34, "#00faf4", 64, "#ffffcc", 83, "#ffe775", 96, "#ffc140", 113, "#ff8f20", 137, "#ff6060", 160, "#c53bff"],
  xsp: ["interpolate", ["linear"], ["get", "v"], 900, "#c53bff", 940, "#ff4040", 970, "#ff9a1f", 990, "#ffe14d", 1005, "#7acc3a", 1015, "#5ebaff"],
  alt: ["interpolate", ["linear"], ["get", "v"], 0, "#ff9a1f", 1500, "#ffe14d", 3000, "#7acc3a", 6000, "#5ebaff", 13000, "#a879ff"],
};

let reconCache: ReconMission[] = [];
const reconMapSet = new Set<MapLibreMap>();
/** A missing value (no SFMR at altitude) draws grey. */
const reconExpr = (by: string): maplibregl.ExpressionSpecification => ["case", ["<", ["get", "v"], 0], "#7d7d7d", RECON_RAMP[by]];

export const tropicalReconLayer = makeModule({
  id: "tropical-recon",
  name: "Hurricane Hunter flights",
  description: "Air Force Reserve and NOAA reconnaissance flights from their high-density observations, every 30 seconds, coloured by flight-level wind, SFMR surface wind, pressure or altitude.",
  source: "NOAA NHC recon archive (HDOB)",
  sources: ["trp-r-line", "trp-r-pts", "trp-r-mark"],
  layers: [
    { id: "trp-r-line", type: "line", source: "trp-r-line", layout: { "line-cap": "round" }, paint: { "line-color": reconExpr("fl"), "line-width": 3 } },
    {
      id: "trp-r-pts",
      type: "circle",
      source: "trp-r-pts",
      minzoom: 6,
      paint: { "circle-radius": 2.6, "circle-color": reconExpr("fl"), "circle-stroke-color": "#000", "circle-stroke-width": 0.4 },
    },
    {
      id: "trp-r-mark",
      type: "circle",
      source: "trp-r-mark",
      paint: { "circle-radius": 8, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2.5 },
    },
  ],
  markers: ["trp-r-pts"],
  build: async () => {
    const st = useTropicalStore.getState();
    const res = await loadRecon(st.reconBasin, st.reconSpan ? { start: st.reconSpan.start, end: st.reconSpan.end } : { hours: st.reconHours });
    reconCache = res.missions;
    const picked = st.reconPicked;
    const missions = res.missions.filter((m) => (picked.length ? picked.includes(m.id) : !m.training));
    const lines: GeoJSON.Feature[] = [];
    const pts: GeoJSON.Feature[] = [];
    for (const m of missions) {
      const coords = unwrap(m.obs.map((o) => [o.lon, o.lat]));
      for (let i = 1; i < m.obs.length; i++) {
        const v = reconValue(m.obs[i], st.reconColor);
        // A gap of more than five minutes is the aircraft out of contact: no line across it.
        if (m.obs[i].t - m.obs[i - 1].t > 5 * 60_000) continue;
        lines.push({ type: "Feature", geometry: { type: "LineString", coordinates: [coords[i - 1], coords[i]] }, properties: { v: v ?? -1, m: m.id } });
      }
      m.obs.forEach((o, i) =>
        pts.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: coords[i] },
          properties: { v: reconValue(o, st.reconColor) ?? -1, t: o.t, fl: o.wspd, dir: o.wdir, sfmr: o.sfmr, xsp: o.xsp, gph: o.gph, temp: o.temp, ac: m.aircraft, storm: m.storm },
        }),
      );
    }
    return {
      "trp-r-line": { type: "FeatureCollection", features: lines },
      "trp-r-pts": { type: "FeatureCollection", features: pts },
      "trp-r-mark": EMPTY,
    };
  },
  refreshMs: 120_000,
  watch: (cb) =>
    useTropicalStore.subscribe(
      (s, p) =>
        (s.reconBasin !== p.reconBasin || s.reconHours !== p.reconHours || s.reconSpan !== p.reconSpan || s.reconPicked !== p.reconPicked || s.reconColor !== p.reconColor) && cb(),
    ),
  hover: {
    layers: ["trp-r-pts"],
    html: (p) => {
      const n = (k: string, u: string, d = 0) => (p[k] != null && p[k] !== "null" ? `${Number(p[k]).toFixed(d)} ${u}` : "--");
      return `<b>${p.storm || "Recon"} · ${p.ac}</b><br>${new Date(Number(p.t)).toISOString().slice(11, 19)}Z<br>Flight level ${n("fl", "kt")} from ${n("dir", "°")}<br>SFMR ${n("sfmr", "kt")} · ${n("xsp", "mb", 1)}<br>${n("gph", "m")} · ${n("temp", "°C", 1)}`;
    },
  },
  opacityProps: [["trp-r-line", "line-opacity", 1]],
  afterPush: (map) => syncRecon(map),
  onAdd: (map) => reconMapSet.add(map),
  onRemove: (map) => reconMapSet.delete(map),
});

/** The time under a chart's cursor moves the marker over the flight. */
useTropicalStore.subscribe((s, p) => {
  if (s.reconColor !== p.reconColor || s.hoverT !== p.hoverT) for (const m of reconMapSet) syncRecon(m);
});

function syncRecon(map: MapLibreMap) {
  const st = useTropicalStore.getState();
  const expr = reconExpr(st.reconColor);
  if (map.getLayer("trp-r-line")) map.setPaintProperty("trp-r-line", "line-color", expr);
  if (map.getLayer("trp-r-pts")) map.setPaintProperty("trp-r-pts", "circle-color", expr);
  const src = map.getSource("trp-r-mark") as GeoJSONSource | undefined;
  if (!src) return;
  const t = st.hoverT;
  let at: [number, number] | null = null;
  if (t != null) {
    let best = Infinity;
    for (const m of reconCache)
      for (const o of m.obs) {
        const d = Math.abs(o.t - t);
        if (d < best && d < 120_000) {
          best = d;
          at = [o.lon, o.lat];
        }
      }
  }
  src.setData(at ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: at }, properties: {} }] } : EMPTY);
}

// ---------------------------------------------------------------- season tracks

export const tropicalSeasonLayer = makeModule({
  id: "tropical-season",
  name: "Tropical season tracks",
  description: "Every storm of one season, coloured by category: the season picked in the Tropical screen.",
  source: "ATCF best tracks (NHC, JTWC via UCAR), HURDAT2, IBTrACS",
  sources: ["trp-s-line", "trp-s-pts", "trp-s-label"],
  layers: [
    { id: "trp-s-line-case", type: "line", source: "trp-s-line", layout: { "line-cap": "round" }, paint: { "line-color": "rgba(0,0,0,0.5)", "line-width": 4 } },
    { id: "trp-s-line", type: "line", source: "trp-s-line", layout: { "line-cap": "round" }, paint: { "line-color": CAT_EXPR, "line-width": 2.2 } },
    {
      id: "trp-s-pts",
      type: "circle",
      source: "trp-s-pts",
      minzoom: 3,
      paint: { "circle-radius": 2.4, "circle-color": CAT_EXPR, "circle-stroke-color": "#000", "circle-stroke-width": 0.4 },
    },
    {
      id: "trp-s-label",
      type: "symbol",
      source: "trp-s-label",
      layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-anchor": "top", "text-offset": [0, 0.5] },
      paint: { "text-color": "#ffffff", "text-halo-color": "#000", "text-halo-width": 1.3 },
    },
  ],
  markers: ["trp-s-pts"],
  build: async () => {
    const { seasonBasin, seasonYear } = useTropicalStore.getState();
    // "all": every basin's season at once (the Southern Hemisphere's that
    // started this July counts as next year's).
    const basins = seasonBasin === "all" ? ["al", "ep", "wp", "io", "sh"] : [seasonBasin];
    const seasons = await Promise.all(
      basins.map((b) => loadSeason(b, b === "sh" && seasonBasin === "all" && new Date().getUTCMonth() >= 6 && seasonYear === new Date().getUTCFullYear() ? seasonYear + 1 : seasonYear).catch(() => null)),
    );
    const lines: GeoJSON.Feature[] = [];
    const pts: GeoJSON.Feature[] = [];
    const labels: GeoJSON.Feature[] = [];
    // A fix with no wind (an old season's other agencies' positions) is grey,
    // not a depression's blue.
    const cat = (v: number | null) => (v == null ? "NA" : catOf(v));
    for (const st of seasons.flatMap((x) => x?.storms ?? [])) {
      const p = st.points ?? [];
      if (p.length < 2) continue;
      const coords = unwrap(p.map((x) => [x[2], x[1]]));
      for (let i = 1; i < p.length; i++)
        lines.push({ type: "Feature", geometry: { type: "LineString", coordinates: [coords[i - 1], coords[i]] }, properties: { cat: cat(p[i - 1][3]) } });
      p.forEach((x, i) => {
        if (new Date(x[0]).getUTCHours() % 6) return;
        pts.push({ type: "Feature", geometry: { type: "Point", coordinates: coords[i] }, properties: { cat: cat(x[3]), name: st.name, t: x[0], vmax: x[3], mslp: x[4] } });
      });
      labels.push({ type: "Feature", geometry: { type: "Point", coordinates: coords[0] }, properties: { name: st.name } });
    }
    return {
      "trp-s-line": { type: "FeatureCollection", features: lines },
      "trp-s-pts": { type: "FeatureCollection", features: pts },
      "trp-s-label": { type: "FeatureCollection", features: labels },
    };
  },
  refreshMs: 900_000,
  watch: (cb) => useTropicalStore.subscribe((s, p) => (s.seasonBasin !== p.seasonBasin || s.seasonYear !== p.seasonYear) && cb()),
  hover: {
    layers: ["trp-s-pts"],
    html: (p) =>
      `<b>${p.name}</b><br>${new Date(Number(p.t)).toISOString().slice(0, 16).replace("T", " ")}Z<br>${p.vmax != null && p.vmax !== "null" ? `${Math.round(Number(p.vmax))} kt` : "--"}${p.mslp != null && p.mslp !== "null" ? ` · ${Math.round(Number(p.mslp))} mb` : ""}`,
  },
  opacityProps: [
    ["trp-s-line", "line-opacity", 1],
    ["trp-s-line-case", "line-opacity", 1],
  ],
});

// ---------------------------------------------------------------- sea surface temperature

const SST_SRC = "trp-sst-src";
const SST_LAYER = "trp-sst";
let sstOpacity = 0.85;
const sstState = new WeakMap<MapLibreMap, () => void>();

export const tropicalSstLayer: LayerModule = {
  id: "tropical-sst",
  name: "Sea surface temperature",
  description: "NASA's GHRSST MUR daily sea surface temperature at 1 km, or its anomaly: pick it in the Tropical panel.",
  category: "weather",
  source: "NASA GIBS, GHRSST MUR L4",
  defaultVisible: false,
  defaultOpacity: 0.85,
  addTo(map) {
    if (!map.getSource(SST_SRC)) {
      map.addSource(SST_SRC, { type: "raster", tiles: [gibsSstTiles(useTropicalStore.getState().sst, useTropicalStore.getState().sstDate)], tileSize: 256, maxzoom: 7, attribution: "NASA GIBS / GHRSST MUR" });
    }
    if (!map.getLayer(SST_LAYER)) map.addLayer({ id: SST_LAYER, type: "raster", source: SST_SRC, paint: { "raster-opacity": sstOpacity, "raster-fade-duration": 0 } });
    const unsub = useTropicalStore.subscribe((s, p) => {
      if (s.sst !== p.sst || s.sstDate !== p.sstDate) (map.getSource(SST_SRC) as RasterTileSource | undefined)?.setTiles([gibsSstTiles(s.sst, s.sstDate)]);
    });
    sstState.set(map, unsub);
  },
  removeFrom(map) {
    sstState.get(map)?.();
    sstState.delete(map);
    if (map.getLayer(SST_LAYER)) map.removeLayer(SST_LAYER);
    if (map.getSource(SST_SRC)) map.removeSource(SST_SRC);
  },
  setOpacity(map, o) {
    sstOpacity = o;
    if (map.getLayer(SST_LAYER)) map.setPaintProperty(SST_LAYER, "raster-opacity", o);
  },
  getLayerIds() {
    return [SST_LAYER];
  },
};
