import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent } from "maplibre-gl";

import type { LayerModule } from "../types";
import { FRONT_COLORS } from "../../lib/fronts";
import { selectFrontFeatures, useFrontsStore } from "../../store/useFrontsStore";

const SRC = "fronts-src";
const L_TROUGH = "fronts-trough";
const L_LINE = "fronts-line";
const L_PIP_COLD = "fronts-pip-cold";
const L_PIP_WARM = "fronts-pip-warm";
const L_PIP_OCC = "fronts-pip-occ";
const L_CENTRE = "fronts-centre";
const L_CENTRE_P = "fronts-centre-pres";
const L_HIT = "fronts-hit";
const ALL = [L_HIT, L_TROUGH, L_LINE, L_PIP_COLD, L_PIP_WARM, L_PIP_OCC, L_CENTRE, L_CENTRE_P];

const DEFAULT_OPACITY = 0.95;
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

// Pip geometry, in icon pixels at 2x. `symbol-spacing` has to be read off these
// numbers, so they live together.
const R = 3;             // supersample; these carry the whole symbology
const PIP_W = 17 * R;
const PIP_H = 15 * R;
const OCC_W = 30 * R;
const SPACING_PIP = 52;
const SPACING_OCC = 72;

interface PaneState {
  unsub: () => void;
  onClick: (e: MapLayerMouseEvent) => void;
  onEnter: () => void;
  onLeave: () => void;
}
const state = new WeakMap<MapLibreMap, PaneState>();
let opacity = DEFAULT_OPACITY;

/**
 * The pips. With `symbol-placement: "line"` MapLibre rotates each icon to the
 * line's bearing, and the icon's -y axis ends up on the LEFT of the direction of
 * travel — so a triangle drawn pointing up sits on the left flank, and
 * `icon-rotate: 180` flips it to the right. That is the whole mechanism behind
 * a stationary front's opposed pips.
 */
function registerPips(map: MapLibreMap) {
  const make = (id: string, w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) => {
    if (map.hasImage(id)) return;
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h * 2; // the line runs through the middle; pips occupy one half
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.translate(0, h); // y=0 is now the line itself
    draw(ctx);
    map.addImage(id, ctx.getImageData(0, 0, cv.width, cv.height), { pixelRatio: R });
  };

  const triangle = (ctx: CanvasRenderingContext2D, x0: number, w: number, color: string) => {
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.lineTo(x0 + w, 0);
    ctx.lineTo(x0 + w / 2, -PIP_H + 1.5 * R);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  const bump = (ctx: CanvasRenderingContext2D, x0: number, w: number, color: string) => {
    ctx.beginPath();
    ctx.arc(x0 + w / 2, 0, w / 2, Math.PI, 0);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };

  make("front-pip-cold", PIP_W, PIP_H, (ctx) => triangle(ctx, 0, PIP_W, FRONT_COLORS.cold));
  make("front-pip-warm", PIP_W, PIP_H, (ctx) => bump(ctx, 0, PIP_W, FRONT_COLORS.warm));
  make("front-pip-stnry-cold", PIP_W, PIP_H, (ctx) =>
    triangle(ctx, 0, PIP_W, FRONT_COLORS.cold),
  );
  make("front-pip-stnry-warm", PIP_W, PIP_H, (ctx) => bump(ctx, 0, PIP_W, FRONT_COLORS.warm));
  // Occluded fronts alternate a triangle and a bump on the SAME side, which a
  // single repeating icon expresses directly -- MapLibre has no way to phase two
  // symbol layers against each other.
  make("front-pip-occ", OCC_W, PIP_H, (ctx) => {
    triangle(ctx, 0, OCC_W / 2 - 1 * R, FRONT_COLORS.occluded);
    bump(ctx, OCC_W / 2 + 1 * R, OCC_W / 2 - 2 * R, FRONT_COLORS.occluded);
  });
}

const isKind = (k: string) => ["all", ["==", ["geometry-type"], "LineString"], ["==", ["get", "kind"], k]];

export const frontsLayer: LayerModule = {
  id: "fronts",
  name: "Surface Fronts",
  description:
    "WPC surface analysis and progs: cold, warm, stationary and occluded fronts, "
    + "troughs and pressure centres. Scrubs on the timeline.",
  category: "weather",
  source: "NWS Weather Prediction Center — Coded Surface Bulletin",
  defaultVisible: false,
  defaultOpacity: DEFAULT_OPACITY,

  addTo(map) {
    registerPips(map);
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: "geojson", data: EMPTY });
    }

    if (!map.getLayer(L_TROUGH)) {
      map.addLayer({
        id: L_TROUGH,
        type: "line",
        source: SRC,
        filter: isKind("trough") as never,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": FRONT_COLORS.trough,
          "line-width": ["interpolate", ["linear"], ["zoom"], 2, 1.6, 5, 2.4, 8, 3],
          "line-dasharray": [2.5, 2],
          "line-opacity": opacity,
        },
      });
    }
    if (!map.getLayer(L_LINE)) {
      map.addLayer({
        id: L_LINE,
        type: "line",
        source: SRC,
        filter: [
          "all",
          ["==", ["geometry-type"], "LineString"],
          ["!=", ["get", "kind"], "trough"],
        ] as never,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": [
            "match",
            ["get", "kind"],
            "cold", FRONT_COLORS.cold,
            "warm", FRONT_COLORS.warm,
            "occluded", FRONT_COLORS.occluded,
            // A stationary front's line is drawn in the cold colour and its warm
            // half is carried entirely by the opposed bumps, as on a paper chart.
            "stationary", FRONT_COLORS.cold,
            "#9aa7b5",
          ],
          "line-width": ["interpolate", ["linear"], ["zoom"], 2, 2, 5, 3, 8, 4],
          "line-opacity": opacity,
        },
      });
    }

    const pip = (id: string, filter: unknown, image: string, rotate: number, spacing: number) => {
      if (map.getLayer(id)) return;
      map.addLayer({
        id,
        type: "symbol",
        source: SRC,
        filter: filter as never,
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": spacing,
          "icon-image": image,
          "icon-rotate": rotate,
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          // Centre anchor, NOT "bottom": the icon canvas is deliberately twice
          // the pip's height with the line running through its middle, so a
          // centred icon puts the pip's base exactly on the line and lets
          // `icon-rotate: 180` flip it to the other flank. Anchoring at the
          // bottom would push the whole canvas above the line and leave the pip
          // floating a pip-height clear of it.
          "icon-size": ["interpolate", ["linear"], ["zoom"], 2, 0.6, 5, 0.9, 8, 1.15],
        },
        paint: { "icon-opacity": opacity },
      });
    };

    pip(
      L_PIP_COLD,
      ["all", ["==", ["geometry-type"], "LineString"],
        ["any", ["==", ["get", "kind"], "cold"], ["==", ["get", "kind"], "stationary"]]],
      "front-pip-cold",
      0,
      SPACING_PIP,
    );
    pip(
      L_PIP_WARM,
      ["all", ["==", ["geometry-type"], "LineString"],
        ["any", ["==", ["get", "kind"], "warm"], ["==", ["get", "kind"], "stationary"]]],
      "front-pip-warm",
      // Stationary bumps go on the far side; a warm front's go on the same side
      // as a cold front's would, which is what 180 gives for both here.
      180,
      SPACING_PIP,
    );
    pip(L_PIP_OCC, isKind("occluded"), "front-pip-occ", 0, SPACING_OCC);

    if (!map.getLayer(L_CENTRE)) {
      map.addLayer({
        id: L_CENTRE,
        type: "symbol",
        source: SRC,
        filter: ["==", ["geometry-type"], "Point"] as never,
        layout: {
          "text-field": ["get", "symbol"],
          "text-font": ["Noto Sans Bold"],
          // Big enough to read as the chart symbol it is, not as a label.
          "text-size": ["interpolate", ["linear"], ["zoom"], 2, 19, 5, 26, 8, 32],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": ["match", ["get", "kind"], "high", FRONT_COLORS.cold, FRONT_COLORS.warm],
          "text-halo-color": "rgba(6,10,16,0.92)",
          "text-halo-width": 1.8,
          "text-opacity": opacity,
        },
      });
    }
    if (!map.getLayer(L_CENTRE_P)) {
      map.addLayer({
        id: L_CENTRE_P,
        type: "symbol",
        source: SRC,
        filter: ["==", ["geometry-type"], "Point"] as never,
        layout: {
          // "1019 mb", directly under the H or L and in its colour, the way a
          // surface chart annotates a centre.
          "text-field": ["concat", ["to-string", ["get", "pressure"]], " mb"],
          "text-font": ["Noto Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 2, 10, 5, 11.5, 8, 13],
          "text-offset": [0, 1.05],
          "text-anchor": "top",
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": ["match", ["get", "kind"], "high", FRONT_COLORS.cold, FRONT_COLORS.warm],
          "text-halo-color": "rgba(6,10,16,0.92)",
          "text-halo-width": 1.6,
          "text-opacity": opacity,
        },
      });
    }

    // A transparent fat line under the real one: a 3 px front is close to
    // unclickable, and widening the visible stroke to fix that would wreck the
    // chart. This is hit-testing only.
    if (!map.getLayer(L_HIT)) {
      map.addLayer({
        id: L_HIT,
        type: "line",
        source: SRC,
        filter: ["==", ["geometry-type"], "LineString"] as never,
        paint: { "line-color": "#000", "line-opacity": 0, "line-width": 16 },
      });
    }

    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const props = f.properties ?? {};
      useFrontsStore.getState().select({
        kind: String(props.kind ?? ""),
        label: String(props.label ?? ""),
        strength: props.strength ? String(props.strength) : "",
        pressure: props.pressure != null ? Number(props.pressure) : null,
        lngLat: [e.lngLat.lng, e.lngLat.lat],
      });
    };
    const onEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
    };
    for (const id of [L_HIT, L_CENTRE, L_CENTRE_P]) {
      map.on("click", id, onClick);
      map.on("mouseenter", id, onEnter);
      map.on("mouseleave", id, onLeave);
    }

    const push = () => {
      const feats = selectFrontFeatures(useFrontsStore.getState());
      (map.getSource(SRC) as GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: feats,
      } as GeoJSON.FeatureCollection);
    };

    // The frame on screen is chosen by the timeline, so redraw whenever the
    // selection, the frame list or the type filters change.
    const unsub = useFrontsStore.subscribe((s, prev) => {
      if (
        s.index !== prev.index ||
        s.frames !== prev.frames ||
        s.kinds !== prev.kinds ||
        s.showCentres !== prev.showCentres
      ) {
        push();
      }
    });

    state.set(map, { unsub, onClick, onEnter, onLeave });
    push();
    const st = useFrontsStore.getState();
    // A second pane must not restart the request the first is waiting on.
    if (!st.frames.length && !st.busy) void st.load();
    st.start();
  },

  removeFrom(map) {
    const st = state.get(map);
    if (st) {
      for (const id of [L_HIT, L_CENTRE, L_CENTRE_P]) {
        map.off("click", id, st.onClick);
        map.off("mouseenter", id, st.onEnter);
        map.off("mouseleave", id, st.onLeave);
      }
      st.unsub();
      state.delete(map);
    }
    useFrontsStore.getState().stop();
    useFrontsStore.getState().select(null);
    for (const id of ALL) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },

  setOpacity(map, o) {
    opacity = o;
    for (const id of [L_TROUGH, L_LINE]) {
      if (map.getLayer(id)) map.setPaintProperty(id, "line-opacity", o);
    }
    for (const id of [L_PIP_COLD, L_PIP_WARM, L_PIP_OCC]) {
      if (map.getLayer(id)) map.setPaintProperty(id, "icon-opacity", o);
    }
    for (const id of [L_CENTRE, L_CENTRE_P]) {
      if (map.getLayer(id)) map.setPaintProperty(id, "text-opacity", o);
    }
  },

  getLayerIds() {
    return ALL;
  },
};
