import type { ExpressionSpecification, Map as MapLibreMap } from "maplibre-gl";

import { getLayerModules } from "../layers/registry";
import { holdBasemapLabels } from "../map/basemapLabels";
import { useAppStore } from "../store/useAppStore";
import { ALERT_COLOR_EVENTS, alertColorKey } from "./schema";
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
const layerOpacity = (id: string, fallback: number) => useAppStore.getState().layers[id]?.opacity ?? fallback;

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
  const border = color("map.borderColor");
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
      layers: ["ref-coastline"],
      paint: { "line-color": border, "line-width": zoomRamp(bw, 2, 0.35, 6, 0.8, 10, 1.3) },
      layout: { visibility: visibility("map.coastlines") },
    },
    {
      layers: ["ref-country-casing"],
      paint: { "line-width": zoomRamp(bw, 2, 1.4, 6, 2.4, 10, 3.4) },
      layout: { visibility: visibility("map.borderCasing") },
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
  const selected = color("storms.selectedColor");
  const forecast = color("storms.forecastColor");
  return [
    {
      layers: ["nexrad-sites-label"],
      layout: { visibility: visibility("radar.siteLabels"), "text-size": +(11 * ss).toFixed(2) },
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
      paint: { "line-color": color("storms.pastColor"), "line-opacity": 0.45, "line-width": +(1.2 * tw).toFixed(3) },
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
    { layers: ["nexrad-storm-dot"], paint: { "circle-stroke-color": ["case", ["get", "selected"], selected, "#ffffff"] } },
    { layers: ["nexrad-storm-label"], layout: { visibility: visibility("storms.labels") } },
  ];
}

/** Watches and advisories: drawn as colour only unless outlined in Settings. */
const NO_LINE_KINDS = ["watch", "advisory"];
const kindOf: ExpressionSpecification = ["coalesce", ["get", "kind"], "other"];
const priority: ExpressionSpecification = ["coalesce", ["get", "priority"], 0];

function alertRules(): Rule[] {
  const op = layerOpacity("nws-alerts", 0.86);
  const lw = num("alerts.lineWidth");
  const match: unknown[] = ["match", ["downcase", ["coalesce", ["get", "event"], ""]]];
  for (const e of ALERT_COLOR_EVENTS) match.push(e.event, color(alertColorKey(e.event)));
  match.push(["get", "color"]);
  const colorExpr = match as ExpressionSpecification;
  const outlineAll = on("alerts.outlineWatches");
  // Same ranking as the module draws, scaled.
  const strokeWidth: ExpressionSpecification = [
    "*",
    lw,
    ["case", ["get", "isEmergency"], 1.8, ["get", "isPDS"], 1.3, 1],
    ["case", ["coalesce", ["get", "convective"], false], 1.3, 1],
    ["interpolate", ["linear"], priority, 0, 0.5, 350, 0.65, 650, 0.85, 900, 1.1, 1200, 1.4],
  ];
  const areaFill = num("alerts.areaFill");
  const warningFill = num("alerts.warningFill");
  return [
    {
      layers: ["alerts-fill"],
      paint: {
        "fill-color": colorExpr,
        "fill-opacity": outlineAll
          ? +(warningFill * op).toFixed(4)
          : ["match", kindOf, NO_LINE_KINDS, +(areaFill * op).toFixed(4), +(warningFill * op).toFixed(4)],
      },
    },
    {
      layers: ["alerts-casing"],
      layout: { visibility: visibility("alerts.casing") },
      paint: { "line-width": ["+", strokeWidth, 1.6], "line-opacity": +(0.85 * op).toFixed(4) },
    },
    {
      layers: ["alerts-outline"],
      paint: {
        "line-color": ["case", ["get", "isEmergency"], color("alerts.emergencyColor"), colorExpr],
        "line-width": strokeWidth,
        "line-opacity": +(0.85 * op).toFixed(4),
      },
    },
  ];
}

function productRules(): Rule[] {
  const mdOp = layerOpacity("spc-md", 0.9);
  const hazard: ExpressionSpecification = [
    "match",
    ["get", "hazard"],
    "severe", color("md.severeColor"),
    "flood", color("md.floodColor"),
    color("md.otherColor"),
  ];
  const outlookRules = getLayerModules()
    .filter((m) => m.category === "outlooks")
    .map((m): Rule[] => {
      const op = layerOpacity(m.id, 0.72);
      return [
        { layers: [`${m.id}-fill`], paint: { "fill-opacity": +(num("outlooks.fill") * op).toFixed(4) } },
        { layers: [`${m.id}-hatch`], paint: { "fill-opacity": +(num("outlooks.hatch") * op).toFixed(4) } },
        { layers: [`${m.id}-line`], paint: { "line-width": num("outlooks.lineWidth") } },
      ];
    })
    .flat();
  const mslpBand = (low: string, high: string): ExpressionSpecification => ["case", ["==", ["get", "band"], "low"], low, high];
  const mslpSize = num("mslp.labelSize");
  const thickSize = num("thickness.labelSize");
  const li = num("lsr.iconScale");
  return [
    { layers: ["lsr-icons"], layout: { "icon-size": zoomRamp(li, 3, 0.55, 6, 0.7, 10, 0.9) } },
    { layers: ["lsr-labels"], layout: { visibility: visibility("lsr.labels") }, paint: { "text-color": color("lsr.labelColor") } },
    { layers: ["spc-md-fill"], paint: { "fill-color": hazard, "fill-opacity": +(num("md.fill") * mdOp).toFixed(4) } },
    { layers: ["spc-md-line"], paint: { "line-color": hazard, "line-width": num("md.lineWidth") } },
    { layers: ["spc-md-label"], layout: { visibility: visibility("md.labels") }, paint: { "text-color": hazard } },
    ...outlookRules,
    { layers: ["mslp-line"], paint: { "line-color": mslpBand(color("mslp.lowColor"), color("mslp.highColor")) } },
    {
      layers: ["mslp-label"],
      layout: { "text-size": mslpSize },
      paint: { "text-color": mslpBand(color("mslp.lowColor"), color("mslp.highColor")) },
    },
    {
      layers: ["mslp-centre"],
      layout: { "text-size": mslpSize + 1 },
      paint: { "text-color": ["case", ["==", ["get", "kind"], "H"], color("mslp.hColor"), color("mslp.lColor")] },
    },
    {
      layers: ["thickness-line"],
      paint: { "line-color": mslpBand(color("thickness.coldColor"), color("thickness.warmColor")) },
    },
    {
      layers: ["thickness-label"],
      layout: { "text-size": thickSize },
      paint: { "text-color": mslpBand(color("thickness.coldColor"), color("thickness.warmColor")) },
    },
    { layers: ["raob-dots"], paint: { "circle-radius": zoomRamp(num("markers.raobScale"), 1, 2.2, 4, 3.2, 8, 5.5) } },
    { layers: ["acars-dots"], paint: { "circle-radius": zoomRamp(num("markers.acarsScale"), 2, 3, 5, 5.5, 9, 8) } },
    { layers: ["acars-label"], layout: { visibility: visibility("markers.acarsLabels") } },
    { layers: ["vwp-dots"], paint: { "circle-radius": zoomRamp(num("markers.vwpScale"), 2, 3, 5, 5, 9, 7) } },
    { layers: ["vwp-label"], layout: { visibility: visibility("markers.vwpLabels") } },
    { layers: ["chasers-label"], layout: { visibility: visibility("chasers.labels") } },
    { layers: ["chaser-home-label"], layout: { visibility: visibility("chasers.homeLabels") } },
  ];
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function apply(map: MapLibreMap): void {
  // The basemap's own names have their holders (products that cover the map);
  // Settings is one more, so a hide from here and a hide from a product never
  // undo each other.
  holdBasemapLabels(map, "settings", !on("map.placeLabels"));

  for (const rule of [...mapRules(), ...radarRules(), ...alertRules(), ...productRules()]) {
    for (const id of rule.layers) {
      if (!map.getLayer(id)) continue;
      for (const [prop, value] of Object.entries(rule.paint ?? {})) {
        if (!same(map.getPaintProperty(id, prop), value)) map.setPaintProperty(id, prop, value as never);
      }
      for (const [prop, value] of Object.entries(rule.layout ?? {})) {
        const current = map.getLayoutProperty(id, prop);
        // An unset visibility reads as undefined and means visible.
        if (prop === "visibility" && value === "visible" && current === undefined) continue;
        if (!same(current, value)) map.setLayoutProperty(id, prop, value as never);
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
  const unsubLayers = useAppStore.subscribe((s) => s.layers, schedule);
  schedule();
  return () => {
    alive = false;
    if (frame) clearTimeout(frame);
    map.off("styledata", schedule);
    unsubSettings();
    unsubLayers();
  };
}
