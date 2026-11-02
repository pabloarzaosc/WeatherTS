import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type MapLayerMouseEvent } from "maplibre-gl";

import type { LayerModule } from "../types";
import { markerUnderPoint, registerMarkerLayers, unregisterMarkerLayers } from "../clickPriority";
import {
  fetchAvn,
  fmtFt,
  fmtLevel,
  fmtWind,
  HAZARD_COLOR,
  HAZARD_FALLBACK,
  hazardColorExpr,
  hazardLabel,
  INTENSITY_COLOR,
  INTENSITY_LABEL,
  zDayClock,
} from "../../lib/aviation";
import { CATEGORY_COLOR } from "../../lib/metar";
import { barbKey, registerStationIcons } from "../../lib/stationPlot";
import { mapInk } from "../../map/mapInk";
import { useAirportStore } from "../../store/useAirportStore";
import { useAlertStore } from "../../store/useAlertStore";
import { useAviationStore } from "../../store/useAviationStore";

/**
 * The aviation layers: flight categories from the METARs and TAFs, the
 * advisories (SIGMETs, G-AIRMETs, CWAs, the convective forecast, TFRs), pilot
 * reports, winds aloft (the GFS anywhere, the FB in the US), the world's FIRs
 * and the US airspace.
 *
 * They share one shape -- a GeoJSON source refreshed on a timer, filtered by
 * what the Aviation panel asks for, and a card when one is clicked -- so each
 * is a spec handed to `avnLayer` rather than a module written out in full.
 */

type Props = Record<string, unknown>;
type AvnState = ReturnType<typeof useAviationStore.getState>;

interface Spec {
  id: string;
  name: string;
  description: string;
  source: string;
  defaultOpacity?: number;
  /** What to fetch, read at every load: the filters may have changed it. */
  url: () => { path: string; params?: Record<string, string | number> };
  refreshMs: number;
  /** Add the map layers over the source; their ids, bottom to top. */
  add: (map: MapLibreMap, src: string) => void;
  ids: string[];
  /** The layers a click or a hover acts on. */
  hit: string[];
  /** Small markers that win a click over the area layers under them. */
  markers?: boolean;
  /** Apply the panel's filters (on add, and whenever they change). */
  filter?: (map: MapLibreMap, s: AvnState) => void;
  /** Whether a change in the panel's settings needs a new download. */
  reload?: (s: AvnState, prev: AvnState) => boolean;
  /** Whether a change needs the filters applied again. */
  refilter?: (s: AvnState, prev: AvnState) => boolean;
  /** The data as it arrived, made ready for the map (derived properties). */
  prepare?: (fc: GeoJSON.FeatureCollection) => GeoJSON.FeatureCollection;
  /** A click: the card's HTML, or an action of its own. */
  card?: (p: Props, f: GeoJSON.Feature) => string | null;
  click?: (p: Props) => void;
  /** Follow the timeline's instant, the way warnings do. */
  timed?: boolean;
  opacity: (map: MapLibreMap, o: number) => void;
  images?: (map: MapLibreMap) => void;
  top?: string[];
  topPriority?: number;
}

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** MapLibre stringifies nested properties; read them back. */
function parse<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return (v as T) ?? fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

const popups = new WeakMap<MapLibreMap, maplibregl.Popup>();

function showCard(map: MapLibreMap, at: maplibregl.LngLatLike, html: string) {
  let p = popups.get(map);
  if (!p) {
    p = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: "380px", className: "avnpopwrap", offset: 10 });
    popups.set(map, p);
  }
  p.setLngLat(at).setHTML(`<div class="avnpop">${html}</div>`).addTo(map);
}

function head(title: string, sub: string, colour?: string) {
  return `<div class="avnpop__head">${colour ? `<i style="background:${esc(colour)}"></i>` : ""}<div><b>${esc(title)}</b><span>${esc(sub)}</span></div></div>`;
}

const row = (k: string, v: string) => `<div class="avnpop__row"><span>${esc(k)}</span><b>${v}</b></div>`;
const raw = (t: unknown) => (t ? `<pre class="avnpop__raw">${esc(t)}</pre>` : "");
const validity = (from: unknown, to: unknown) =>
  from || to ? `${from ? zDayClock(Number(from)) : "?"} to ${to ? zDayClock(Number(to)) : "?"}` : "—";

/** Shown at the instant on screen: what warnings follow, MapTimeline sets. */
const instant = () => useAlertStore.getState().timeFilter ?? Date.now() / 1000;

function avnLayer(spec: Spec): LayerModule {
  const SRC = `${spec.id}-src`;
  let last: GeoJSON.FeatureCollection = EMPTY;
  const timers = new WeakMap<MapLibreMap, ReturnType<typeof setInterval>>();
  const unsubs = new WeakMap<MapLibreMap, () => void>();
  const handlers = new WeakMap<MapLibreMap, { click: (e: MapLayerMouseEvent) => void; enter: () => void; leave: () => void }>();
  let gen = 0;

  const applyTime = (map: MapLibreMap) => {
    if (!spec.timed) return;
    const t = instant();
    const timeF = [
      "all",
      ["<=", ["coalesce", ["get", "from"], 0], t],
      [">=", ["coalesce", ["get", "to"], 9e12], t],
    ];
    for (const id of spec.ids) {
      if (!map.getLayer(id)) continue;
      const own = ownFilters.get(map)?.get(id);
      map.setFilter(id, (own ? ["all", own, timeF] : timeF) as never);
    }
  };

  const refilter = (map: MapLibreMap) => {
    spec.filter?.(map, useAviationStore.getState());
    applyTime(map);
  };

  const load = async (map: MapLibreMap) => {
    const mine = ++gen;
    const { path, params } = spec.url();
    try {
      const fc = await fetchAvn(path, params);
      if (mine !== gen) return;
      last = spec.prepare ? spec.prepare(fc) : fc;
      (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(last);
      // Filters that count back from now (a PIREP's age) move with each load.
      refilter(map);
      useAviationStore.getState().report(spec.id, last.features.length, null);
    } catch (err) {
      if (mine !== gen) return;
      useAviationStore.getState().report(spec.id, null, err instanceof Error ? err.message : String(err));
    }
  };

  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    category: "aviation",
    source: spec.source,
    defaultVisible: false,
    defaultOpacity: spec.defaultOpacity ?? 0.9,

    addTo(map) {
      unsubs.get(map)?.();
      const stale = timers.get(map);
      if (stale) clearInterval(stale);
      spec.images?.(map);
      if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: last });
      spec.add(map, SRC);
      refilter(map);
      if (spec.markers) registerMarkerLayers(spec.hit);

      const click = (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
        // An area under a marker leaves the click to the marker.
        if (!spec.markers && markerUnderPoint(map, e.point)) return;
        const p = (f.properties ?? {}) as Props;
        if (spec.click) {
          spec.click(p);
          return;
        }
        const html = spec.card?.(p, f as unknown as GeoJSON.Feature);
        if (html) showCard(map, e.lngLat, html);
      };
      const enter = () => {
        map.getCanvas().style.cursor = "pointer";
      };
      const leave = () => {
        map.getCanvas().style.cursor = "";
      };
      map.on("click", spec.hit, click);
      map.on("mouseenter", spec.hit, enter);
      map.on("mouseleave", spec.hit, leave);
      handlers.set(map, { click, enter, leave });

      void load(map);
      timers.set(map, setInterval(() => void load(map), spec.refreshMs));
      const unsubStore = useAviationStore.subscribe((s, prev) => {
        if (spec.reload?.(s, prev)) void load(map);
        if (spec.refilter?.(s, prev)) refilter(map);
      });
      const unsubTime = spec.timed ? useAlertStore.subscribe((s) => s.timeFilter, () => applyTime(map)) : () => {};
      unsubs.set(map, () => {
        unsubStore();
        unsubTime();
      });
    },

    removeFrom(map) {
      const t = timers.get(map);
      if (t) clearInterval(t);
      timers.delete(map);
      unsubs.get(map)?.();
      unsubs.delete(map);
      const h = handlers.get(map);
      if (h) {
        map.off("click", spec.hit, h.click);
        map.off("mouseenter", spec.hit, h.enter);
        map.off("mouseleave", spec.hit, h.leave);
        handlers.delete(map);
      }
      if (spec.markers) unregisterMarkerLayers(spec.hit);
      popups.get(map)?.remove();
      for (const id of [...spec.ids].reverse()) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SRC)) map.removeSource(SRC);
    },

    setOpacity(map, o) {
      spec.opacity(map, o);
    },
    getLayerIds() {
      return spec.ids;
    },
    topLayerIds: spec.top ? () => spec.top! : undefined,
    topPriority: spec.topPriority,
  };
}

/** Each layer's own filter, kept so the time filter can be added to it. */
const ownFilters = new WeakMap<MapLibreMap, Map<string, unknown>>();

function setOwnFilter(map: MapLibreMap, id: string, f: unknown | null) {
  if (!map.getLayer(id)) return;
  let mine = ownFilters.get(map);
  if (!mine) ownFilters.set(map, (mine = new Map()));
  if (f == null) mine.delete(id);
  else mine.set(id, f);
  map.setFilter(id, (f ?? null) as never);
}

const CAT_EXPR = [
  "match",
  ["coalesce", ["get", "cat"], ""],
  "VFR", CATEGORY_COLOR.VFR,
  "MVFR", CATEGORY_COLOR.MVFR,
  "IFR", CATEGORY_COLOR.IFR,
  "LIFR", CATEGORY_COLOR.LIFR,
  "#8b95a3",
] as never;

const halo = () => mapInk().halo;
const ink = () => mapInk().text;

// ---------------------------------------------------------------------------
// METARs: flight category
// ---------------------------------------------------------------------------
const MET_DOT = "avn-metars-dot";
const MET_LABEL = "avn-metars-label";

export const avnMetarLayer = avnLayer({
  id: "avn-metars",
  name: "Flight Categories (METAR)",
  description: "Every airport's latest METAR worldwide, coloured VFR, MVFR, IFR or LIFR. Click one for its page.",
  source: "NOAA Aviation Weather Center",
  url: () => ({ path: "metars" }),
  refreshMs: 120_000,
  markers: true,
  ids: [MET_DOT, MET_LABEL],
  hit: [MET_DOT],
  add(map, src) {
    if (!map.getLayer(MET_DOT)) {
      map.addLayer({
        id: MET_DOT,
        type: "circle",
        source: src,
        paint: {
          "circle-color": CAT_EXPR,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 2.6, 6, 4.2, 9, 6.5],
          "circle-stroke-color": halo(),
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 3, 0.6, 8, 1.4],
        },
      });
    }
    if (!map.getLayer(MET_LABEL)) {
      map.addLayer({
        id: MET_LABEL,
        type: "symbol",
        source: src,
        minzoom: 5.5,
        layout: {
          "text-field": ["get", "id"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 10.5,
          "text-offset": [0, 1.15],
          "text-anchor": "top",
          "text-optional": true,
        },
        paint: { "text-color": ink(), "text-halo-color": halo(), "text-halo-width": 1.5 },
      });
    }
  },
  filter(map, s) {
    if (map.getLayer(MET_LABEL)) map.setLayoutProperty(MET_LABEL, "visibility", s.metarLabels ? "visible" : "none");
  },
  refilter: (s, p) => s.metarLabels !== p.metarLabels,
  click: (p) => useAirportStore.getState().open(String(p.id)),
  opacity(map, o) {
    if (map.getLayer(MET_DOT)) {
      map.setPaintProperty(MET_DOT, "circle-opacity", o);
      map.setPaintProperty(MET_DOT, "circle-stroke-opacity", o);
    }
    if (map.getLayer(MET_LABEL)) map.setPaintProperty(MET_LABEL, "text-opacity", o);
  },
  top: [MET_DOT, MET_LABEL],
  topPriority: 25,
});

// ---------------------------------------------------------------------------
// TAFs: the forecast category at a moment ahead
// ---------------------------------------------------------------------------
const TAF_RING = "avn-tafs-ring";
const TAF_LABEL = "avn-tafs-label";

export const avnTafLayer = avnLayer({
  id: "avn-tafs",
  name: "TAF Forecast Categories",
  description: "What each TAF forecasts at a moment ahead (set in the Aviation panel): a ring in the category's colour.",
  source: "NOAA Aviation Weather Center",
  url: () => {
    const s = useAviationStore.getState();
    return { path: "tafs", params: { at: Math.floor(Date.now() / 1000 + s.tafHours * 3600) } };
  },
  refreshMs: 600_000,
  markers: true,
  ids: [TAF_RING, TAF_LABEL],
  hit: [TAF_RING],
  add(map, src) {
    const by = useAviationStore.getState().tafWorst ? "worst" : "cat";
    const colour = ["match", ["coalesce", ["get", by], ""], "VFR", CATEGORY_COLOR.VFR, "MVFR", CATEGORY_COLOR.MVFR,
      "IFR", CATEGORY_COLOR.IFR, "LIFR", CATEGORY_COLOR.LIFR, "#8b95a3"] as never;
    if (!map.getLayer(TAF_RING)) {
      map.addLayer({
        id: TAF_RING,
        type: "circle",
        source: src,
        paint: {
          "circle-color": "rgba(0,0,0,0)",
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 4.5, 6, 6.5, 9, 9],
          "circle-stroke-color": colour,
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 3, 1.4, 8, 2.4],
        },
      });
    }
    if (!map.getLayer(TAF_LABEL)) {
      map.addLayer({
        id: TAF_LABEL,
        type: "symbol",
        source: src,
        minzoom: 6.5,
        layout: {
          "text-field": ["case", ["to-boolean", ["coalesce", ["get", "temp"], ""]], ["concat", ["get", "id"], " · ", ["get", "temp"]], ["get", "id"]],
          "text-font": ["Noto Sans Regular"],
          "text-size": 10,
          "text-offset": [0, -1.35],
          "text-anchor": "bottom",
          "text-optional": true,
        },
        paint: { "text-color": ink(), "text-halo-color": halo(), "text-halo-width": 1.4 },
      });
    }
  },
  filter(map, s) {
    if (!map.getLayer(TAF_RING)) return;
    const by = s.tafWorst ? "worst" : "cat";
    map.setPaintProperty(TAF_RING, "circle-stroke-color", ["match", ["coalesce", ["get", by], ""], "VFR",
      CATEGORY_COLOR.VFR, "MVFR", CATEGORY_COLOR.MVFR, "IFR", CATEGORY_COLOR.IFR, "LIFR", CATEGORY_COLOR.LIFR,
      "#8b95a3"] as never);
  },
  reload: (s, p) => s.tafHours !== p.tafHours,
  refilter: (s, p) => s.tafWorst !== p.tafWorst,
  click: (p) => useAirportStore.getState().open(String(p.id)),
  opacity(map, o) {
    if (map.getLayer(TAF_RING)) map.setPaintProperty(TAF_RING, "circle-stroke-opacity", o);
    if (map.getLayer(TAF_LABEL)) map.setPaintProperty(TAF_LABEL, "text-opacity", o);
  },
  top: [TAF_RING, TAF_LABEL],
  topPriority: 24,
});

// ---------------------------------------------------------------------------
// SIGMETs
// ---------------------------------------------------------------------------
const SIG_FILL = "avn-sigmets-fill";
const SIG_LINE = "avn-sigmets-line";
const SIG_LABEL = "avn-sigmets-label";

function levels(lo: unknown, hi: unknown): string {
  const l = lo == null || lo === "" || Number(lo) === 0 ? "SFC" : fmtLevel(lo);
  return hi == null || hi === "" ? `${l} and up` : `${l} to ${fmtLevel(hi)}`;
}

export const avnSigmetLayer = avnLayer({
  id: "avn-sigmets",
  name: "SIGMETs",
  description: "US SIGMETs and convective SIGMETs, and international SIGMETs: thunderstorms, turbulence, icing, volcanic ash, tropical cyclones.",
  source: "NOAA Aviation Weather Center",
  url: () => ({ path: "sigmets" }),
  refreshMs: 180_000,
  timed: true,
  ids: [SIG_FILL, SIG_LINE, SIG_LABEL],
  hit: [SIG_LINE, SIG_LABEL, SIG_FILL],
  add(map, src) {
    const colour = hazardColorExpr() as never;
    if (!map.getLayer(SIG_FILL)) {
      map.addLayer({ id: SIG_FILL, type: "fill", source: src, paint: { "fill-color": colour, "fill-opacity": 0.12 } });
    }
    if (!map.getLayer(SIG_LINE)) {
      map.addLayer({
        id: SIG_LINE,
        type: "line",
        source: src,
        layout: { "line-join": "round" },
        paint: {
          "line-color": colour,
          "line-width": ["case", ["==", ["get", "kind"], "convective"], 2.4, 1.8],
          "line-dasharray": ["case", ["==", ["get", "kind"], "intl"], ["literal", [3, 2]], ["literal", [1, 0]]] as never,
        },
      });
    }
    if (!map.getLayer(SIG_LABEL)) {
      map.addLayer({
        id: SIG_LABEL,
        type: "symbol",
        source: src,
        layout: {
          "text-field": ["concat", ["get", "hazard"], " ", ["coalesce", ["get", "series"], ""]],
          "text-font": ["Noto Sans Bold"],
          "text-size": 11,
          "symbol-placement": "point",
          "text-optional": true,
        },
        paint: { "text-color": colour, "text-halo-color": halo(), "text-halo-width": 1.6 },
      });
    }
  },
  filter(map, s) {
    const f = ["in", ["get", "kind"], ["literal", s.sigmetKinds]];
    for (const id of [SIG_FILL, SIG_LINE, SIG_LABEL]) setOwnFilter(map, id, f);
  },
  refilter: (s, p) => s.sigmetKinds !== p.sigmetKinds,
  card(p) {
    const kind = { convective: "Convective SIGMET", sigmet: "SIGMET", airmet: "AIRMET", intl: "International SIGMET" }[
      String(p.kind)
    ] ?? "SIGMET";
    const h = String(p.hazard ?? "");
    return (
      head(`${hazardLabel(h)}${p.qualifier ? ` (${String(p.qualifier).toLowerCase()})` : ""}`,
        `${kind} ${p.series ?? ""} · ${p.fir ?? p.issuer ?? ""}`, HAZARD_COLOR[h] ?? HAZARD_FALLBACK) +
      row("Valid", esc(validity(p.from, p.to))) +
      row("Levels", esc(levels(p.lo, p.hi))) +
      (p.dir || p.spd ? row("Moving", esc(`${p.dir ?? ""}${typeof p.dir === "number" ? "°" : ""} ${p.spd ?? ""} kt`)) : "") +
      raw(p.raw)
    );
  },
  opacity(map, o) {
    if (map.getLayer(SIG_FILL)) map.setPaintProperty(SIG_FILL, "fill-opacity", 0.12 * o);
    if (map.getLayer(SIG_LINE)) map.setPaintProperty(SIG_LINE, "line-opacity", o);
    if (map.getLayer(SIG_LABEL)) map.setPaintProperty(SIG_LABEL, "text-opacity", o);
  },
  top: [SIG_LINE, SIG_LABEL],
  topPriority: 12,
});

// ---------------------------------------------------------------------------
// G-AIRMETs
// ---------------------------------------------------------------------------
const GA_FILL = "avn-gairmets-fill";
const GA_LINE = "avn-gairmets-line";
const GA_LABEL = "avn-gairmets-label";

export const avnGairmetLayer = avnLayer({
  id: "avn-gairmets",
  name: "G-AIRMETs",
  description: "Graphical AIRMETs over the US: IFR, mountain obscuration, turbulence, icing, freezing levels, low-level wind shear, surface wind -- each forecast hour 0 to 12.",
  source: "NOAA Aviation Weather Center",
  url: () => ({ path: "gairmets" }),
  refreshMs: 600_000,
  ids: [GA_FILL, GA_LINE, GA_LABEL],
  hit: [GA_LINE, GA_LABEL, GA_FILL],
  add(map, src) {
    const colour = hazardColorExpr() as never;
    if (!map.getLayer(GA_FILL)) {
      map.addLayer({
        id: GA_FILL,
        type: "fill",
        source: src,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": colour, "fill-opacity": 0.1 },
      });
    }
    if (!map.getLayer(GA_LINE)) {
      map.addLayer({
        id: GA_LINE,
        type: "line",
        source: src,
        layout: { "line-join": "round" },
        paint: {
          "line-color": colour,
          "line-width": ["case", ["==", ["geometry-type"], "LineString"], 1.6, 1.4],
          "line-dasharray": ["case", ["==", ["geometry-type"], "LineString"], ["literal", [4, 2]], ["literal", [1, 0]]] as never,
        },
      });
    }
    if (!map.getLayer(GA_LABEL)) {
      map.addLayer({
        id: GA_LABEL,
        type: "symbol",
        source: src,
        layout: {
          "text-field": [
            "case",
            ["==", ["get", "hazard"], "FZLVL"],
            ["concat", ["coalesce", ["get", "level"], ""], ""],
            ["get", "hazard"],
          ],
          "text-font": ["Noto Sans Bold"],
          "text-size": 10,
          "symbol-placement": "line",
          "text-optional": true,
        },
        paint: { "text-color": colour, "text-halo-color": halo(), "text-halo-width": 1.5 },
      });
    }
  },
  filter(map, s) {
    const f = ["all", ["==", ["get", "fore"], s.gairmetFore], ["in", ["get", "hazard"], ["literal", s.gairmetHazards]]];
    setOwnFilter(map, GA_FILL, ["all", ["==", ["geometry-type"], "Polygon"], f]);
    setOwnFilter(map, GA_LINE, f);
    setOwnFilter(map, GA_LABEL, f);
  },
  refilter: (s, p) => s.gairmetFore !== p.gairmetFore || s.gairmetHazards !== p.gairmetHazards,
  card(p) {
    const h = String(p.hazard ?? "");
    const lv = h === "FZLVL" || h === "M_FZLVL" ? (p.level ? fmtLevel(p.level) : "—") : levels(p.base === "SFC" ? 0 : p.base, p.top);
    return (
      head(hazardLabel(h), `G-AIRMET ${String(p.product ?? "").toUpperCase()} · +${p.fore} h`, HAZARD_COLOR[h] ?? HAZARD_FALLBACK) +
      row("Valid", esc(p.valid ? zDayClock(Number(p.valid)) : "—")) +
      row(h.endsWith("FZLVL") ? "Freezing level" : "Levels", esc(lv)) +
      (p.severity ? row("Severity", esc(p.severity)) : "") +
      (p.dueTo ? row("Due to", esc(p.dueTo)) : "") +
      row("Issued", esc(p.issue ? zDayClock(Number(p.issue)) : "—"))
    );
  },
  opacity(map, o) {
    if (map.getLayer(GA_FILL)) map.setPaintProperty(GA_FILL, "fill-opacity", 0.1 * o);
    if (map.getLayer(GA_LINE)) map.setPaintProperty(GA_LINE, "line-opacity", o);
    if (map.getLayer(GA_LABEL)) map.setPaintProperty(GA_LABEL, "text-opacity", o);
  },
  top: [GA_LINE, GA_LABEL],
  topPriority: 11,
});

// ---------------------------------------------------------------------------
// CWAs
// ---------------------------------------------------------------------------
const CWA_FILL = "avn-cwas-fill";
const CWA_LINE = "avn-cwas-line";

export const avnCwaLayer = avnLayer({
  id: "avn-cwas",
  name: "Center Weather Advisories",
  description: "The ARTCC weather units' own short-fuse advisories: thunderstorms, turbulence, icing, IFR.",
  source: "NOAA Aviation Weather Center (CWSUs)",
  url: () => ({ path: "cwas" }),
  refreshMs: 180_000,
  timed: true,
  ids: [CWA_FILL, CWA_LINE],
  hit: [CWA_LINE, CWA_FILL],
  add(map, src) {
    const colour = hazardColorExpr() as never;
    if (!map.getLayer(CWA_FILL)) {
      map.addLayer({ id: CWA_FILL, type: "fill", source: src, paint: { "fill-color": colour, "fill-opacity": 0.1 } });
    }
    if (!map.getLayer(CWA_LINE)) {
      map.addLayer({
        id: CWA_LINE,
        type: "line",
        source: src,
        paint: { "line-color": colour, "line-width": 2, "line-dasharray": [1, 1.5] },
      });
    }
  },
  card(p) {
    const h = String(p.hazard ?? "");
    return (
      head(`${hazardLabel(h)}${p.qualifier ? ` (${String(p.qualifier).toLowerCase()})` : ""}`,
        `CWA ${p.series ?? ""} · ${p.name ?? p.cwsu ?? ""} (${p.cwsu ?? ""})`, HAZARD_COLOR[h] ?? HAZARD_FALLBACK) +
      row("Valid", esc(validity(p.from, p.to))) +
      row("Levels", esc(levels(p.lo, p.hi))) +
      raw(p.raw)
    );
  },
  opacity(map, o) {
    if (map.getLayer(CWA_FILL)) map.setPaintProperty(CWA_FILL, "fill-opacity", 0.1 * o);
    if (map.getLayer(CWA_LINE)) map.setPaintProperty(CWA_LINE, "line-opacity", o);
  },
  top: [CWA_LINE],
  topPriority: 11,
});

// ---------------------------------------------------------------------------
// TCF: the TFM convective forecast
// ---------------------------------------------------------------------------
const TCF_FILL = "avn-tcf-fill";
const TCF_LINE = "avn-tcf-line";
const TCF_LABEL = "avn-tcf-label";

export const avnTcfLayer = avnLayer({
  id: "avn-tcf",
  name: "TFM Convective Forecast",
  description: "Where thunderstorms will affect air traffic in the next 4 to 8 hours, with coverage, confidence and tops (the earliest forecast shown).",
  source: "NOAA Aviation Weather Center",
  url: () => ({ path: "tcf" }),
  refreshMs: 600_000,
  ids: [TCF_FILL, TCF_LINE, TCF_LABEL],
  hit: [TCF_LINE, TCF_FILL],
  prepare(fc) {
    // The earliest forecast still ahead: the three valid times overlap.
    const now = Date.now() / 1000;
    const times = [...new Set(fc.features.map((f) => Number(f.properties?.valid)).filter((t) => t >= now - 3600))].sort();
    const keep = times[0];
    return { ...fc, features: fc.features.filter((f) => keep == null || Number(f.properties?.valid) === keep) };
  },
  add(map, src) {
    const colour = ["match", ["get", "coverage"], "SOLID", "#1d4ed8", "MEDIUM", "#3b82f6", "#93c5fd"] as never;
    if (!map.getLayer(TCF_FILL)) {
      map.addLayer({ id: TCF_FILL, type: "fill", source: src, paint: { "fill-color": colour, "fill-opacity": 0.28 } });
    }
    if (!map.getLayer(TCF_LINE)) {
      map.addLayer({ id: TCF_LINE, type: "line", source: src, paint: { "line-color": colour, "line-width": 1.6 } });
    }
    if (!map.getLayer(TCF_LABEL)) {
      map.addLayer({
        id: TCF_LABEL,
        type: "symbol",
        source: src,
        layout: {
          "text-field": ["concat", ["coalesce", ["get", "tops"], ""], "\n", ["coalesce", ["get", "coverage"], ""]],
          "text-font": ["Noto Sans Bold"],
          "text-size": 10,
          "text-optional": true,
        },
        paint: { "text-color": ink(), "text-halo-color": halo(), "text-halo-width": 1.4 },
      });
    }
  },
  card(p) {
    return (
      head("TFM Convective Forecast", `valid ${p.valid ? zDayClock(Number(p.valid)) : "—"}`, "#3b82f6") +
      row("Coverage", esc(String(p.coverage ?? "—").toLowerCase())) +
      row("Confidence", esc(String(p.confidence ?? "—").toLowerCase())) +
      row("Tops", esc(p.tops ?? "—")) +
      row("Issued", esc(p.issue ? zDayClock(Number(p.issue)) : "—"))
    );
  },
  opacity(map, o) {
    if (map.getLayer(TCF_FILL)) map.setPaintProperty(TCF_FILL, "fill-opacity", 0.28 * o);
    if (map.getLayer(TCF_LINE)) map.setPaintProperty(TCF_LINE, "line-opacity", o);
    if (map.getLayer(TCF_LABEL)) map.setPaintProperty(TCF_LABEL, "text-opacity", o);
  },
});

// ---------------------------------------------------------------------------
// TFRs
// ---------------------------------------------------------------------------
const TFR_FILL = "avn-tfrs-fill";
const TFR_LINE = "avn-tfrs-line";

export const avnTfrLayer = avnLayer({
  id: "avn-tfrs",
  name: "TFRs",
  description: "The FAA's temporary flight restrictions: VIP movements, stadiums, wildfires, hazards, space operations.",
  source: "FAA",
  url: () => ({ path: "tfrs" }),
  refreshMs: 900_000,
  ids: [TFR_FILL, TFR_LINE],
  hit: [TFR_LINE, TFR_FILL],
  add(map, src) {
    if (!map.getLayer(TFR_FILL)) {
      map.addLayer({ id: TFR_FILL, type: "fill", source: src, paint: { "fill-color": "#ef4444", "fill-opacity": 0.14 } });
    }
    if (!map.getLayer(TFR_LINE)) {
      map.addLayer({ id: TFR_LINE, type: "line", source: src, paint: { "line-color": "#ef4444", "line-width": 1.8 } });
    }
  },
  card(p) {
    return (
      head(String(p.type ?? "TFR"), `NOTAM ${p.id ?? ""} · ${p.facility ?? ""} ${p.state ?? ""}`, "#ef4444") +
      `<div class="avnpop__text">${esc(p.description ?? p.title ?? "")}</div>` +
      row("Legal", esc(p.legal ?? "—"))
    );
  },
  opacity(map, o) {
    if (map.getLayer(TFR_FILL)) map.setPaintProperty(TFR_FILL, "fill-opacity", 0.14 * o);
    if (map.getLayer(TFR_LINE)) map.setPaintProperty(TFR_LINE, "line-opacity", o);
  },
  top: [TFR_LINE],
  topPriority: 11,
});

// ---------------------------------------------------------------------------
// PIREPs
// ---------------------------------------------------------------------------
const PIREP_ICON = "avn-pireps-icon";

/** The standard chart symbols: turbulence a pair of peaks, icing the
 *  ice-crystal glyph, anything else a dot; coloured by intensity. */
function pirepImages(map: MapLibreMap) {
  const R = 2;
  const S = 22;
  for (const kind of ["turb", "ice", "other"] as const) {
    for (let lvl = 0; lvl <= 4; lvl++) {
      const id = `avn-pirep-${kind}-${lvl}`;
      if (map.hasImage(id)) continue;
      const cv = document.createElement("canvas");
      cv.width = cv.height = S * R;
      const ctx = cv.getContext("2d")!;
      ctx.scale(R, R);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const colour = kind === "other" ? "#cbd5e1" : INTENSITY_COLOR[lvl];
      const draw = (w: number, c: string) => {
        ctx.strokeStyle = c;
        ctx.lineWidth = w;
        ctx.beginPath();
        if (kind === "turb") {
          ctx.moveTo(3, 15);
          ctx.lineTo(7.5, 7);
          ctx.lineTo(11, 13);
          ctx.lineTo(14.5, 7);
          ctx.lineTo(19, 15);
        } else if (kind === "ice") {
          ctx.moveTo(4, 7);
          ctx.quadraticCurveTo(11, 17, 18, 7);
          ctx.moveTo(11, 4);
          ctx.lineTo(11, 17);
          ctx.moveTo(7.5, 6);
          ctx.lineTo(7.5, 10);
          ctx.moveTo(14.5, 6);
          ctx.lineTo(14.5, 10);
        } else {
          ctx.arc(11, 11, 3.2, 0, Math.PI * 2);
        }
        ctx.stroke();
      };
      draw(5, "rgba(8,12,18,0.85)");
      draw(2.4, colour);
      if (kind === "other") {
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.arc(11, 11, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      map.addImage(id, ctx.getImageData(0, 0, cv.width, cv.height), { pixelRatio: R });
    }
  }
}

const turbWords = (t: { int: string; type: string; base: number | null; top: number | null; freq: string }) =>
  `${t.int}${t.type ? ` ${t.type}` : ""}${t.freq ? ` ${t.freq.toLowerCase()}` : ""}${t.base != null ? ` ${fmtFt(t.base)}${t.top != null ? `–${fmtFt(t.top)}` : ""}` : ""}`;

export const avnPirepLayer = avnLayer({
  id: "avn-pireps",
  name: "PIREPs & AIREPs",
  description: "Pilot reports of turbulence, icing, clouds and winds from the last hours, worldwide, by intensity.",
  source: "NOAA Aviation Weather Center",
  url: () => ({ path: "pireps" }),
  refreshMs: 120_000,
  markers: true,
  images: pirepImages,
  ids: [PIREP_ICON],
  hit: [PIREP_ICON],
  add(map, src) {
    if (!map.getLayer(PIREP_ICON)) {
      map.addLayer({
        id: PIREP_ICON,
        type: "symbol",
        source: src,
        layout: {
          "icon-image": ["concat", "avn-pirep-", ["get", "kind"], "-", ["to-string", ["max", ["get", "level"], 0]]],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.75, 8, 1.05],
          "icon-allow-overlap": true,
          "symbol-sort-key": ["get", "level"],
        },
      });
    }
  },
  filter(map, s) {
    const now = Date.now() / 1000;
    const kinds = [s.pirepTurb && "turb", s.pirepIce && "ice", s.pirepOther && "other"].filter(Boolean);
    setOwnFilter(map, PIREP_ICON, [
      "all",
      [">=", ["coalesce", ["get", "t"], 0], now - s.pirepAge * 3600],
      ["in", ["get", "kind"], ["literal", kinds]],
      [">=", ["get", "level"], s.pirepMin === 0 ? -1 : s.pirepMin],
      [">=", ["coalesce", ["get", "alt"], 0], s.pirepLow],
      ["<=", ["coalesce", ["get", "alt"], 0], s.pirepHigh],
    ]);
  },
  refilter: (s, p) =>
    s.pirepAge !== p.pirepAge || s.pirepTurb !== p.pirepTurb || s.pirepIce !== p.pirepIce ||
    s.pirepOther !== p.pirepOther || s.pirepMin !== p.pirepMin || s.pirepLow !== p.pirepLow || s.pirepHigh !== p.pirepHigh,
  card(p) {
    const turbs = parse<{ int: string; type: string; base: number | null; top: number | null; freq: string }[]>(p.turbs, []);
    const ices = parse<{ int: string; type: string; base: number | null; top: number | null; freq: string }[]>(p.ices, []);
    const skies = parse<{ cover: string; base: number | null; top: number | null }[]>(p.skies, []);
    const lvl = Math.max(Number(p.level), 0);
    const title =
      p.kind === "turb"
        ? lvl === 0 ? "No turbulence (NEG)" : `${INTENSITY_LABEL[lvl]} turbulence`
        : p.kind === "ice"
          ? lvl === 0 ? "No icing (NEG)" : `${INTENSITY_LABEL[lvl]} icing`
          : "Pilot report";
    return (
      head(`${p.urgent ? "URGENT · " : ""}${title}`, `${p.type} · ${p.ac ?? ""} · ${p.t ? zDayClock(Number(p.t)) : ""}`,
        p.kind === "other" ? "#cbd5e1" : INTENSITY_COLOR[lvl]) +
      row("Altitude", esc(p.alt != null ? fmtLevel(Number(p.alt)) : "—")) +
      (turbs.length ? row("Turbulence", esc(turbs.map(turbWords).join("; "))) : "") +
      (ices.length ? row("Icing", esc(ices.map(turbWords).join("; "))) : "") +
      (skies.length ? row("Sky", esc(skies.map((k) => `${k.cover}${k.base != null ? ` ${fmtFt(k.base)}` : ""}${k.top != null ? ` tops ${fmtFt(k.top)}` : ""}`).join("; "))) : "") +
      (p.temp != null ? row("Temperature", `${esc(p.temp)}&deg;C`) : "") +
      (p.wspd != null ? row("Wind", esc(fmtWind(p.wdir as number, Number(p.wspd)))) : "") +
      (p.wx ? row("Weather", esc(p.wx)) : "") +
      raw(p.raw)
    );
  },
  opacity(map, o) {
    if (map.getLayer(PIREP_ICON)) map.setPaintProperty(PIREP_ICON, "icon-opacity", o);
  },
  top: [PIREP_ICON],
  topPriority: 26,
});

// ---------------------------------------------------------------------------
// Winds aloft (FB)
// ---------------------------------------------------------------------------
// One symbol layer for the barb and its temperature, so that where the GFS
// grid is too dense to show every point the two make room together.
const FB_BARB = "avn-winds-barb";

let windsMeta: { use?: string; source?: string } = {};

export const avnWindsLayer = avnLayer({
  id: "avn-winds",
  name: "Winds & Temperatures Aloft",
  description: "Wind barbs and temperatures at a flight level: the GFS on a 2.5° grid over the whole world, or NOAA's FB forecasts at their US stations.",
  source: "NOAA GFS (AWS) · Aviation Weather Center (FB)",
  url: () => {
    const s = useAviationStore.getState();
    const params: Record<string, string | number> =
      s.windsSource === "gfs" ? { source: "gfs", height: s.windsHeight, lead: s.windsLead } : { level: s.windsLevel, fcst: s.windsFcst };
    return { path: "winds", params };
  },
  refreshMs: 1_800_000,
  markers: true,
  images: (map) => registerStationIcons(map),
  ids: [FB_BARB],
  hit: [FB_BARB],
  prepare(fc) {
    const meta = fc as GeoJSON.FeatureCollection & { use?: string; source?: string };
    windsMeta = { use: meta.use, source: meta.source };
    // Flatten each station's levels onto plain properties MapLibre can read.
    return {
      ...fc,
      features: fc.features.map((f) => {
        const lv = parse<Record<string, { dir: number | null; spd: number; temp: number | null; lv: boolean }>>(
          f.properties?.levels,
          {},
        );
        const flat: Record<string, unknown> = {};
        for (const [h, v] of Object.entries(lv)) {
          flat[`d${h}`] = v.dir;
          flat[`s${h}`] = v.spd;
          flat[`b${h}`] = barbKey(v.spd);
          if (v.temp != null) flat[`t${h}`] = v.temp;
        }
        return { ...f, properties: { ...f.properties, ...flat } };
      }),
    };
  },
  add(map, src) {
    const h = useAviationStore.getState().windsHeight;
    if (!map.getLayer(FB_BARB)) {
      map.addLayer({
        id: FB_BARB,
        type: "symbol",
        source: src,
        layout: {
          "icon-image": ["concat", "sfc-barb-", ["to-string", ["coalesce", ["get", `b${h}`], 0]]],
          "icon-rotate": ["coalesce", ["get", `d${h}`], 0],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-size": 1,
          "icon-padding": 0,
          "text-field": ["case", ["has", `t${h}`], ["concat", ["to-string", ["get", `t${h}`]], "°"], ""],
          "text-font": ["Noto Sans Bold"],
          "text-size": 10.5,
          "text-offset": [-1.2, -0.9],
          "text-allow-overlap": true,
          "text-optional": true,
        },
        paint: { "text-color": "#f87171", "text-halo-color": halo(), "text-halo-width": 1.4 },
      });
    }
  },
  filter(map, s) {
    const h = s.windsHeight;
    if (!map.getLayer(FB_BARB)) return;
    // The GFS grid is dense: the barbs make room for one another.
    const crowd = s.windsSource === "gfs";
    map.setLayoutProperty(FB_BARB, "icon-allow-overlap", !crowd);
    map.setLayoutProperty(FB_BARB, "text-allow-overlap", !crowd);
    map.setLayoutProperty(FB_BARB, "icon-image", ["concat", "sfc-barb-", ["to-string", ["coalesce", ["get", `b${h}`], 0]]]);
    map.setLayoutProperty(FB_BARB, "icon-rotate", ["coalesce", ["get", `d${h}`], 0]);
    map.setLayoutProperty(FB_BARB, "text-field", ["case", ["has", `t${h}`], ["concat", ["to-string", ["get", `t${h}`]], "°"], ""]);
    setOwnFilter(map, FB_BARB, ["has", `s${h}`]);
  },
  reload: (s, p) =>
    s.windsSource !== p.windsSource ||
    (s.windsSource === "fb" ? s.windsLevel !== p.windsLevel || s.windsFcst !== p.windsFcst : s.windsHeight !== p.windsHeight || s.windsLead !== p.windsLead),
  refilter: (s, p) => s.windsHeight !== p.windsHeight || s.windsSource !== p.windsSource,
  card(p, f) {
    const lv = parse<Record<string, { dir: number | null; spd: number; temp: number | null; lv: boolean }>>(p.levels, {});
    const rows = Object.entries(lv)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([h, v]) =>
        row(fmtLevel(Number(h)), esc(`${v.lv ? "Light & variable" : fmtWind(v.dir, v.spd)}${v.temp != null ? `  ${v.temp > 0 ? "+" : ""}${v.temp}°C` : ""}`)),
      )
      .join("");
    if (windsMeta.source === "gfs") {
      const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
      return (
        head("Winds aloft · GFS", `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? "E" : "W"}`, "#60a5fa") +
        rows +
        row("Forecast", esc(windsMeta.use ?? "—"))
      );
    }
    return head(`Winds aloft · ${p.id}`, `${String(p.name ?? "")} · FB ${windsMeta.use ?? ""}`, "#60a5fa") + rows;
  },
  opacity(map, o) {
    if (map.getLayer(FB_BARB)) {
      map.setPaintProperty(FB_BARB, "icon-opacity", o);
      map.setPaintProperty(FB_BARB, "text-opacity", o);
    }
  },
  top: [FB_BARB],
  topPriority: 23,
});

// ---------------------------------------------------------------------------
// Airspace
// ---------------------------------------------------------------------------
function limits(p: Props): string {
  const v = (val: unknown, code: unknown) => {
    const n = Number(val);
    if (val == null || n === -9998) return "—";
    if (String(code).toUpperCase() === "SFC" || n === 0) return "SFC";
    return `${fmtLevel(n)}${code && String(code) !== "MSL" ? ` ${code}` : ""}`;
  };
  return `${v(p.lower_val, p.lower_code)} to ${v(p.upper_val, p.upper_code)}`;
}

const CLS_LINE = "avn-class-line";
const CLS_LABEL = "avn-class-label";
const CLASS_COLOR = ["match", ["get", "class"], "B", "#3b82f6", "C", "#c026d3", "D", "#60a5fa", "#94a3b8"] as never;

export const avnClassLayer = avnLayer({
  id: "avn-class",
  name: "Class B, C, D Airspace",
  description: "The controlled airspace around US airports, with each shelf's floor and ceiling.",
  source: "FAA Aeronautical Data Delivery Service",
  url: () => ({ path: "airspace", params: { kind: "class" } }),
  refreshMs: 86_400_000,
  ids: [CLS_LINE, CLS_LABEL],
  hit: [CLS_LINE],
  add(map, src) {
    if (!map.getLayer(CLS_LINE)) {
      map.addLayer({
        id: CLS_LINE,
        type: "line",
        source: src,
        paint: {
          "line-color": CLASS_COLOR,
          "line-width": ["match", ["get", "class"], "B", 1.8, "C", 1.6, 1.2],
          "line-dasharray": ["case", ["==", ["get", "class"], "D"], ["literal", [3, 2]], ["literal", [1, 0]]] as never,
        },
      });
    }
    if (!map.getLayer(CLS_LABEL)) {
      map.addLayer({
        id: CLS_LABEL,
        type: "symbol",
        source: src,
        minzoom: 8,
        layout: {
          "text-field": [
            "concat",
            ["case", [">", ["coalesce", ["to-number", ["get", "upper_val"]], 0], 0], ["to-string", ["round", ["/", ["to-number", ["get", "upper_val"]], 100]]], ""],
            "/",
            ["case", ["==", ["coalesce", ["to-number", ["get", "lower_val"]], 0], 0], "SFC", ["to-string", ["round", ["/", ["to-number", ["get", "lower_val"]], 100]]]],
          ],
          "text-font": ["Noto Sans Bold"],
          "text-size": 10,
          "symbol-placement": "line",
          "text-optional": true,
        },
        paint: { "text-color": CLASS_COLOR, "text-halo-color": halo(), "text-halo-width": 1.4 },
      });
    }
  },
  filter(map, s) {
    const f = ["in", ["get", "class"], ["literal", s.airspaceClasses]];
    setOwnFilter(map, CLS_LINE, f);
    setOwnFilter(map, CLS_LABEL, f);
  },
  refilter: (s, p) => s.airspaceClasses !== p.airspaceClasses,
  card(p) {
    return (
      head(String(p.name ?? "Airspace"), `Class ${p.class ?? ""} · ${p.icao_id ?? p.ident ?? ""}`, "#3b82f6") +
      row("Limits", esc(limits(p)))
    );
  },
  opacity(map, o) {
    if (map.getLayer(CLS_LINE)) map.setPaintProperty(CLS_LINE, "line-opacity", o);
    if (map.getLayer(CLS_LABEL)) map.setPaintProperty(CLS_LABEL, "text-opacity", o);
  },
});

const SUA_FILL = "avn-sua-fill";
const SUA_LINE = "avn-sua-line";
const SUA_COLOR = ["match", ["get", "type_code"], "P", "#b91c1c", "R", "#ef4444", "MOA", "#a855f7", "W", "#0ea5e9",
  "A", "#f59e0b", "#64748b"] as never;
const SUA_NAME: Record<string, string> = {
  P: "Prohibited area", R: "Restricted area", MOA: "Military operations area", W: "Warning area", A: "Alert area",
  D: "Danger area",
};

export const avnSuaLayer = avnLayer({
  id: "avn-sua",
  name: "Special Use Airspace",
  description: "Prohibited, restricted, warning and alert areas and MOAs over the US, with their limits and times of use.",
  source: "FAA Aeronautical Data Delivery Service",
  url: () => ({ path: "airspace", params: { kind: "sua" } }),
  refreshMs: 86_400_000,
  ids: [SUA_FILL, SUA_LINE],
  hit: [SUA_LINE, SUA_FILL],
  add(map, src) {
    if (!map.getLayer(SUA_FILL)) {
      map.addLayer({ id: SUA_FILL, type: "fill", source: src, paint: { "fill-color": SUA_COLOR, "fill-opacity": 0.06 } });
    }
    if (!map.getLayer(SUA_LINE)) {
      map.addLayer({
        id: SUA_LINE,
        type: "line",
        source: src,
        paint: {
          "line-color": SUA_COLOR,
          "line-width": 1.3,
          "line-dasharray": ["case", ["==", ["get", "type_code"], "MOA"], ["literal", [4, 2]], ["literal", [1, 0]]] as never,
        },
      });
    }
  },
  filter(map, s) {
    const f = ["in", ["get", "type_code"], ["literal", s.suaTypes]];
    setOwnFilter(map, SUA_FILL, f);
    setOwnFilter(map, SUA_LINE, f);
  },
  refilter: (s, p) => s.suaTypes !== p.suaTypes,
  card(p) {
    return (
      head(String(p.name ?? "Special use airspace"), SUA_NAME[String(p.type_code)] ?? String(p.type_code ?? ""), "#a855f7") +
      row("Limits", esc(limits(p))) +
      (p.timesofuse ? row("In use", esc(p.timesofuse)) : "") +
      (p.cont_agent ? row("Controlled by", esc(p.cont_agent)) : "") +
      (p.city ? row("Near", esc(`${p.city}${p.state ? `, ${p.state}` : ""}`)) : "")
    );
  },
  opacity(map, o) {
    if (map.getLayer(SUA_FILL)) map.setPaintProperty(SUA_FILL, "fill-opacity", 0.06 * o);
    if (map.getLayer(SUA_LINE)) map.setPaintProperty(SUA_LINE, "line-opacity", o);
  },
});

const ARTCC_LINE = "avn-artcc-line";
const ARTCC_LABEL = "avn-artcc-label";

export const avnArtccLayer = avnLayer({
  id: "avn-artcc",
  name: "ARTCC Boundaries",
  description: "The US air route traffic control centers (low altitude), the regions SIGMETs and CWAs are written for.",
  source: "FAA Aeronautical Data Delivery Service",
  url: () => ({ path: "airspace", params: { kind: "artcc" } }),
  refreshMs: 86_400_000,
  ids: [ARTCC_LINE, ARTCC_LABEL],
  hit: [ARTCC_LINE],
  add(map, src) {
    if (!map.getLayer(ARTCC_LINE)) {
      map.addLayer({
        id: ARTCC_LINE,
        type: "line",
        source: src,
        paint: { "line-color": "#94a3b8", "line-width": 1.2, "line-dasharray": [5, 3] },
      });
    }
    if (!map.getLayer(ARTCC_LABEL)) {
      map.addLayer({
        id: ARTCC_LABEL,
        type: "symbol",
        source: src,
        layout: {
          "text-field": ["get", "ident"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 12,
          "symbol-placement": "point",
        },
        paint: { "text-color": "#94a3b8", "text-halo-color": halo(), "text-halo-width": 1.4 },
      });
    }
  },
  card(p) {
    return head(`${p.ident ?? ""} ${String(p.name ?? "").trim()} Center`, "Air route traffic control center", "#94a3b8");
  },
  opacity(map, o) {
    if (map.getLayer(ARTCC_LINE)) map.setPaintProperty(ARTCC_LINE, "line-opacity", o);
    if (map.getLayer(ARTCC_LABEL)) map.setPaintProperty(ARTCC_LABEL, "text-opacity", o);
  },
});

// ---------------------------------------------------------------------------
// FIRs: the world's flight information regions
// ---------------------------------------------------------------------------
const FIR_LINE = "avn-firs-line";
const FIR_LABEL = "avn-firs-label";

export const avnFirLayer = avnLayer({
  id: "avn-firs",
  name: "FIR Boundaries",
  description: "The world's flight information regions -- who gives the flight information and issues the SIGMETs over each part of the globe -- with their ICAO ids, oceanic ones dashed.",
  source: "VATSpy data project (CC BY-SA 4.0)",
  url: () => ({ path: "firs" }),
  refreshMs: 86_400_000,
  ids: [FIR_LINE, FIR_LABEL],
  hit: [FIR_LINE],
  add(map, src) {
    if (!map.getLayer(FIR_LINE)) {
      map.addLayer({
        id: FIR_LINE,
        type: "line",
        source: src,
        paint: {
          "line-color": "#a3b1c6",
          "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.7, 6, 1.3],
          "line-dasharray": ["case", ["get", "oceanic"], ["literal", [2, 2]], ["literal", [6, 3]]] as never,
        },
      });
    }
    if (!map.getLayer(FIR_LABEL)) {
      map.addLayer({
        id: FIR_LABEL,
        type: "symbol",
        source: src,
        minzoom: 2.5,
        layout: {
          "text-field": ["step", ["zoom"], ["get", "id"], 4.5, ["concat", ["get", "id"], "\n", ["get", "name"]]],
          "text-font": ["Noto Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 3, 10, 7, 12],
          "symbol-placement": "point",
          "text-optional": true,
        },
        paint: { "text-color": "#a3b1c6", "text-halo-color": halo(), "text-halo-width": 1.4 },
      });
    }
  },
  filter(map, s) {
    if (map.getLayer(FIR_LABEL)) map.setLayoutProperty(FIR_LABEL, "visibility", s.firLabels ? "visible" : "none");
  },
  refilter: (s, p) => s.firLabels !== p.firLabels,
  card(p) {
    return (
      head(`${p.id} · ${p.name ?? ""}`, `Flight information region${p.oceanic ? " (oceanic)" : ""}`, "#a3b1c6") +
      `<div class="avnpop__text">SIGMETs over this region are issued for ${esc(p.id)}; the SIGMET layer shows them.</div>`
    );
  },
  opacity(map, o) {
    if (map.getLayer(FIR_LINE)) map.setPaintProperty(FIR_LINE, "line-opacity", o);
    if (map.getLayer(FIR_LABEL)) map.setPaintProperty(FIR_LABEL, "text-opacity", o);
  },
});

/** Bottom to top: airspace under the advisories, the reports and stations above. */
export const aviationLayers: LayerModule[] = [
  avnFirLayer,
  avnArtccLayer,
  avnSuaLayer,
  avnClassLayer,
  avnTcfLayer,
  avnGairmetLayer,
  avnSigmetLayer,
  avnCwaLayer,
  avnTfrLayer,
  avnWindsLayer,
  avnTafLayer,
  avnMetarLayer,
  avnPirepLayer,
];
