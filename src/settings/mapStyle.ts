import type { ExpressionSpecification, Map as MapLibreMap } from "maplibre-gl";

import { getLayerModules } from "../layers/registry";
import { holdBasemapLabels } from "../map/basemapLabels";
import { chartInk } from "../map/basemaps";
import { mapInk } from "../map/mapInk";
import { useAppStore } from "../store/useAppStore";
import { useAcarsStore } from "../store/useAcarsStore";
import { useLsrStore } from "../store/useLsrStore";
import { getSetting, useSettingsStore } from "./useSettingsStore";

/**
 * Settings that restyle what is already on the map, applied to each pane.
 *
 * The layer modules keep drawing exactly as they did; this goes over the top
 * with setPaintProperty and setLayoutProperty for the layers that are there,
 * after every change to the style. Nothing here knows when a module adds its
 * layers -- a style change is the signal -- so a layer that appears later (a
 * storm track when the scan lands, a product switched on) is styled the moment
 * it exists, and a basemap switch that rebuilds everything is covered too.
 *
 * Each property is written only when it differs from what the layer already
 * has. That is also what ends the echo: writing a property fires another style
 * change, which finds nothing left to write.
 *
 * Never a property a module writes itself. Opacity belongs to the modules (the
 * layer manager pushes it on every reconcile, and a reconcile runs on every
 * style change), so a fill strength from Settings is read by the module inside
 * its own setOpacity. Writing it here as well made the two take turns forever.
 */

type Props = Record<string, unknown>;
interface Rule {
  layers: string[];
  paint?: Props;
  layout?: Props;
}

const num = (key: string) => getSetting<number>(key);
const on = (key: string) => getSetting<boolean>(key);
const color = (key: string) => getSetting<string>(key);
const visibility = (key: string) => (on(key) ? "visible" : "none");

/** A zoom ramp with every stop multiplied by k. */
const zoomRamp = (k: number, ...stops: number[]): ExpressionSpecification => {
  const out: unknown[] = ["interpolate", ["linear"], ["zoom"]];
  for (let i = 0; i < stops.length; i += 2) out.push(stops[i], +(stops[i + 1] * k).toFixed(3));
  return out as ExpressionSpecification;
};

const SAT_LABEL_PREFIX = "sat";

function mapRules(): Rule[] {
  const k = num("map.labelScale");
  const bw = num("map.borderWidth");
  // On a chart basemap the borders over the products are its ink, unless a
  // colour of one's own was picked in Settings.
  const ink = chartInk(useAppStore.getState().basemapId);
  const border = ink && !("map.borderColor" in useSettingsStore.getState().values) ? ink : color("map.borderColor");
  const names = on("map.placeLabels");
  const gw = num("map.graticuleWidth");
  const placeSizes: [string, number[]][] = [
    ["place-country", [2, 13, 5, 17]],
    ["place-state", [3, 11, 6, 15]],
    ["place-city", [5, 10, 8, 13, 12, 16]],
  ];
  return [
    ...placeSizes.map(([id, stops]): Rule => ({ layers: [id], layout: { "text-size": zoomRamp(k, ...stops) } })),
    ...placeSizes.map(([id, stops]): Rule => ({
      layers: [`${SAT_LABEL_PREFIX}-${id}`],
      layout: { "text-size": zoomRamp(k, ...stops) },
      paint: { "text-opacity": names ? 1 : 0 },
    })),
    { layers: ["ref-country-line"], paint: { "line-color": border, "line-width": zoomRamp(bw, 2, 0.5, 6, 1.1, 10, 1.9) } },
    {
      layers: ["ref-state-line"],
      paint: { "line-color": border, "line-width": zoomRamp(bw, 2, 0.3, 6, 0.6, 10, 1.1) },
      layout: { visibility: visibility("map.stateLines") },
    },
    {
      layers: ["ref-coastline", "ref-lakes"],
      paint: { "line-color": border, "line-width": zoomRamp(bw, 2, 0.35, 6, 0.8, 10, 1.3) },
      layout: { visibility: visibility("map.coastlines") },
    },
    {
      layers: ["ref-country-casing"],
      paint: { "line-width": zoomRamp(bw, 2, 1.4, 6, 2.4, 10, 3.4) },
      // The dark edge is for imagery; on a chart it is a smudge beside the line.
      layout: { visibility: ink ? "none" : visibility("map.borderCasing") },
    },
    { layers: ["ne-countries-line"], paint: { "line-color": border, "line-width": zoomRamp(bw, 1, 0.4, 5, 1, 9, 1.8) } },
    {
      layers: ["graticule-line"],
      paint: {
        "line-color": color("map.graticuleColor"),
        "line-width": ["case", ["get", "major"], +(1.2 * gw).toFixed(3), +(0.5 * gw).toFixed(3)],
      },
    },
    { layers: ["terminator-fill"], paint: { "fill-color": color("map.nightColor") } },
  ];
}

function radarRules(): Rule[] {
  const ss = num("radar.siteScale");
  const tw = num("storms.trackWidth");
  // The default white tracks vanish over a light basemap: dark ink there,
  // unless a colour of one's own was picked in Settings.
  const lightMap = mapInk().tone === "light";
  const own = useSettingsStore.getState().values;
  const trackInk = (key: string, onLight: string) => (lightMap && !(key in own) ? onLight : color(key));
  const selected = trackInk("storms.selectedColor", "#a86f00");
  const forecast = trackInk("storms.forecastColor", "#0d1218");
  const past = trackInk("storms.pastColor", "#1b2633");
  return [
    {
      layers: ["nexrad-sites-label"],
      // an airport radar's tag (TDWR) a size down from a NEXRAD's pill
      layout: { visibility: visibility("radar.siteLabels"), "text-size": ["case", ["==", ["get", "kind"], "tdwr"], +(10 * ss).toFixed(2), +(11 * ss).toFixed(2)] },
    },
    {
      layers: ["nexrad-ring-line"],
      paint: {
        "line-color": color("radar.ringColor"),
        "line-width": +(1.3 * num("radar.ringWidth")).toFixed(3),
        "line-dasharray": on("radar.ringDashed") ? [3, 3] : [1, 0],
      },
    },
    { layers: ["nexrad-storm-cone"], layout: { visibility: visibility("storms.cone") } },
    {
      layers: ["nexrad-storm-cone-edge"],
      layout: { visibility: visibility("storms.cone") },
      paint: {
        "line-color": ["case", ["get", "selected"], selected, forecast],
        "line-opacity": ["case", ["get", "selected"], 1, 0.8],
      },
    },
    {
      layers: ["nexrad-storm-past"],
      paint: { "line-color": past, "line-opacity": lightMap ? 0.55 : 0.45, "line-width": +(1.2 * tw).toFixed(3) },
    },
    {
      layers: ["nexrad-storm-fcst"],
      paint: { "line-color": forecast, "line-opacity": 0.92, "line-width": +(1.6 * tw).toFixed(3) },
    },
    {
      layers: ["nexrad-storm-tick"],
      paint: {
        "line-color": forecast,
        "line-opacity": 0.92,
        "line-width": ["case", [">=", ["get", "minutes"], 60], +(2.2 * tw).toFixed(3), +(1.5 * tw).toFixed(3)],
      },
    },
    {
      layers: ["nexrad-storm-dot"],
      paint: { "circle-stroke-color": ["case", ["get", "selected"], selected, lightMap ? "#0d1218" : "#ffffff"] },
    },
    { layers: ["nexrad-storm-label"], layout: { visibility: visibility("storms.labels") } },
  ];
}

const priority: ExpressionSpecification = ["coalesce", ["get", "priority"], 0];

/** "#060a10" -> "rgba(6,10,16,0.75)": the dark edge keeps its old see-through. */
function rgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function alertRules(): Rule[] {
  const lw = num("alerts.lineWidth");
  const edge = num("alerts.casingWidth");
  const edgeColor = rgba(color("alerts.casingColor"), 0.75);
  // Colours are baked onto each feature by alertStyle.alertMapData: the
  // type's colour from Settings, or its intensity tier's. A Settings edit
  // redraws the source (AlertController), so the layers just read it.
  const colorExpr: ExpressionSpecification = ["get", "color"];
  // Each type's own outline width (its Settings page), 1x by default.
  const typeMul: ExpressionSpecification = ["coalesce", ["get", "lineMul"], 1];
  // A type with no outline, or no dark edge, gets no casing.
  const edged: ExpressionSpecification = ["all", ["coalesce", ["get", "border"], true], [">", typeMul, 0]];
  // Same ranking as the module draws, scaled.
  const strokeWidth: ExpressionSpecification = [
    "*",
    lw,
    typeMul,
    ["case", ["get", "isEmergency"], 1.8, ["get", "isPDS"], 1.3, 1],
    ["case", ["coalesce", ["get", "convective"], false], 1.3, 1],
    ["interpolate", ["linear"], priority, 0, 0.5, 350, 0.65, 650, 0.85, 900, 1.1, 1200, 1.4],
  ];
  const watchW: ExpressionSpecification = ["*", lw, typeMul, 1.5];
  const advisoryW: ExpressionSpecification = ["*", lw, typeMul, 2.2];
  return [
    { layers: ["alerts-fill"], paint: { "fill-color": colorExpr } },
    {
      layers: ["alerts-casing"],
      layout: { visibility: visibility("alerts.casing") },
      paint: { "line-width": ["case", edged, ["+", strokeWidth, edge], 0], "line-color": edgeColor },
    },
    {
      layers: ["alerts-outline"],
      paint: { "line-color": colorExpr, "line-width": strokeWidth },
    },
    // The watches' dashes and the advisories' dots take the colours of their fill.
    { layers: ["alerts-watch-line"], paint: { "line-color": colorExpr, "line-width": watchW } },
    { layers: ["alerts-advisory-line"], paint: { "line-color": colorExpr, "line-width": advisoryW } },
    {
      // The module shows and hides these two (outlineWatches), so the switch
      // here works through the width rather than the visibility.
      layers: ["alerts-watch-casing"],
      paint: { "line-width": on("alerts.casing") ? ["case", edged, ["+", watchW, edge], 0] : 0, "line-color": edgeColor },
    },
    {
      layers: ["alerts-advisory-casing"],
      paint: { "line-width": on("alerts.casing") ? ["case", edged, ["*", lw, typeMul, 1.1], 0] : 0, "line-color": edgeColor },
    },
  ];
}

function productRules(): Rule[] {
  const hazard: ExpressionSpecification = [
    "match",
    ["get", "hazard"],
    "severe", color("md.severeColor"),
    "flood", color("md.floodColor"),
    color("md.otherColor"),
  ];
  const outlookRules = getLayerModules()
    .filter((m) => m.category === "outlooks")
    .flatMap((m): Rule[] => [
      { layers: [`${m.id}-line`], paint: { "line-width": num("outlooks.lineWidth") } },
      // The dark edge under it stays a little wider than the line.
      { layers: [`${m.id}-casing`], paint: { "line-width": num("outlooks.lineWidth") + 1.6 } },
    ]);
  const mslpBand = (low: string, high: string): ExpressionSpecification => ["case", ["==", ["get", "band"], "low"], low, high];
  const mslpSize = num("mslp.labelSize");
  const li = num("lsr.iconScale");
  return [
    { layers: ["lsr-icons"], layout: { "icon-size": zoomRamp(li, 3, 0.55, 6, 0.7, 10, 0.9) } },
    // The report panel has its own labels switch; shown only when both agree.
    {
      layers: ["lsr-labels"],
      layout: { visibility: on("lsr.labels") && useLsrStore.getState().showLabels ? "visible" : "none" },
      // Its default is the map's label ink; a colour picked in Settings wins.
      paint: { "text-color": "lsr.labelColor" in useSettingsStore.getState().values ? color("lsr.labelColor") : mapInk().text },
    },
    { layers: ["spc-md-fill"], paint: { "fill-color": hazard } },
    { layers: ["spc-md-line"], paint: { "line-color": hazard, "line-width": num("md.lineWidth") } },
    { layers: ["spc-md-label"], layout: { visibility: visibility("md.labels") }, paint: { "text-color": hazard } },
    ...outlookRules,
    // The isobar settings now dress the pressure map that rides on the MSLP
    // analysis products; the standalone pressure chart they were made for is gone.
    { layers: ["obs-isobar"], paint: { "line-color": mslpBand(color("mslp.lowColor"), color("mslp.highColor")) } },
    {
      layers: ["obs-isobar-label"],
      layout: { "text-size": mslpSize },
      paint: { "text-color": mslpBand(color("mslp.lowColor"), color("mslp.highColor")) },
    },
    {
      layers: ["obs-centre"],
      layout: { "text-size": mslpSize + 1 },
      paint: { "text-color": ["case", ["==", ["get", "kind"], "H"], color("mslp.hColor"), color("mslp.lColor")] },
    },
    { layers: ["raob-dots"], paint: { "circle-radius": zoomRamp(num("markers.raobScale"), 1, 2.2, 4, 3.2, 8, 5.5) } },
    { layers: ["acars-dots"], paint: { "circle-radius": zoomRamp(num("markers.acarsScale"), 2, 3, 5, 5.5, 9, 8) } },
    // Likewise the ACARS panel's labels switch.
    {
      layers: ["acars-label"],
      layout: { visibility: on("markers.acarsLabels") && useAcarsStore.getState().showLabels ? "visible" : "none" },
    },
    { layers: ["vwp-dots"], paint: { "circle-radius": zoomRamp(num("markers.vwpScale"), 2, 3, 5, 5, 9, 7) } },
    { layers: ["vwp-label"], layout: { visibility: visibility("markers.vwpLabels") } },
    { layers: ["chasers-label"], layout: { visibility: visibility("chasers.labels") } },
    { layers: ["chaser-home-label"], layout: { visibility: visibility("chasers.homeLabels") } },
  ];
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * The rules for the current settings, built once per change rather than on
 * every style change: the alert colours alone are a 27-way expression.
 */
let built: { values: unknown; lsrLabels: boolean; acarsLabels: boolean; basemap: string; rules: Rule[] } | null = null;
function currentRules(): Rule[] {
  const values = useSettingsStore.getState().values;
  const lsrLabels = useLsrStore.getState().showLabels;
  const acarsLabels = useAcarsStore.getState().showLabels;
  const basemap = useAppStore.getState().basemapId;
  if (!built || built.values !== values || built.lsrLabels !== lsrLabels || built.acarsLabels !== acarsLabels ||
      built.basemap !== basemap) {
    built = { values, lsrLabels, acarsLabels, basemap, rules: [...mapRules(), ...radarRules(), ...alertRules(), ...productRules()] };
  }
  return built.rules;
}

/**
 * Per map, what each property read as the last time it was found right.
 *
 * MapLibre hands back the same object until the property is written again, so
 * a property still holding that exact value needs no comparison at all, and a
 * pass over an unchanged map costs a lookup per property instead of turning
 * every expression into JSON. Dropped whenever the rules are rebuilt.
 */
const checked = new WeakMap<MapLibreMap, { rules: Rule[]; seen: Map<string, unknown> }>();

function apply(map: MapLibreMap): void {
  // The basemap's own names have their holders (products that cover the map);
  // Settings is one more, so a hide from here and a hide from a product never
  // undo each other.
  holdBasemapLabels(map, "settings", !on("map.placeLabels"));

  const rules = currentRules();
  let memo = checked.get(map);
  if (!memo || memo.rules !== rules) {
    memo = { rules, seen: new Map() };
    checked.set(map, memo);
  }
  const { seen } = memo;

  for (const rule of rules) {
    for (const id of rule.layers) {
      if (!map.getLayer(id)) continue;
      for (const [prop, value] of Object.entries(rule.paint ?? {})) {
        const key = `${id}|paint|${prop}`;
        const current = map.getPaintProperty(id, prop);
        if (current !== undefined && seen.get(key) === current) continue;
        if (!same(current, value)) map.setPaintProperty(id, prop, value as never);
        seen.set(key, map.getPaintProperty(id, prop));
      }
      for (const [prop, value] of Object.entries(rule.layout ?? {})) {
        const key = `${id}|layout|${prop}`;
        const current = map.getLayoutProperty(id, prop);
        if (current !== undefined && seen.get(key) === current) continue;
        // An unset visibility reads as undefined and means visible.
        if (prop === "visibility" && value === "visible" && current === undefined) continue;
        if (!same(current, value)) map.setLayoutProperty(id, prop, value as never);
        seen.set(key, map.getLayoutProperty(id, prop));
      }
    }
  }
}

/** Keep a pane's map styled by Settings. Returns the detach. */
export function attachSettings(map: MapLibreMap): () => void {
  // A timer, not an animation frame: frames stop in a window that is hidden,
  // and a burst of style changes still collapses into one pass either way.
  let frame: ReturnType<typeof setTimeout> | 0 = 0;
  let alive = true;
  const schedule = () => {
    if (frame || !alive) return;
    frame = setTimeout(() => {
      frame = 0;
      if (!alive) return;
      try {
        apply(map);
      } catch (err) {
        // A style mid-swap can refuse a write; the next style change retries.
        if (import.meta.env.DEV) console.debug("[settings] apply deferred", err);
      }
    }, 0);
  };
  map.on("styledata", schedule);
  const unsubSettings = useSettingsStore.subscribe((s) => s.values, schedule);
  // This store has no selector subscriptions; a pass with nothing changed is a
  // few lookups, and currentRules only rebuilds when the switch moved.
  const unsubLsr = useLsrStore.subscribe((s, prev) => {
    if (s.showLabels !== prev.showLabels) schedule();
  });
  const unsubAcars = useAcarsStore.subscribe((s) => s.showLabels, schedule);
  schedule();
  return () => {
    alive = false;
    if (frame) clearTimeout(frame);
    map.off("styledata", schedule);
    unsubSettings();
    unsubLsr();
    unsubAcars();
  };
}
