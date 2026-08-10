import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent } from "maplibre-gl";

import type { LayerModule } from "../types";
import {
  LSR_CATEGORIES,
  LSR_COLORS,
  LSR_SHAPES,
  LSR_SHAPE_PATHS,
  type LsrProps,
} from "../../lib/lsr";
import { useLsrStore } from "../../store/useLsrStore";

const SRC = "lsr-src";
const ICONS = "lsr-icons";
const LABELS = "lsr-labels";
const DEFAULT_OPACITY = 1;

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

interface PaneState {
  unsub: () => void;
  onClick: (e: MapLayerMouseEvent) => void;
  onEnter: () => void;
  onLeave: () => void;
}
const state = new WeakMap<MapLibreMap, PaneState>();
let opacity = DEFAULT_OPACITY;

// ---------------------------------------------------------------------------
// Icons. Shape carries the category family, colour the category within it, the
// way a storm-report legend codes them. The path comes from LSR_SHAPE_PATHS so
// the map and the panel legend are drawn from one definition — Path2D takes the
// same `d` string an <svg> does.
// ---------------------------------------------------------------------------
const ICON_PREFIX = "lsr-";
const R = 3; // supersample: these are small on screen and get scaled up on zoom
const BOX = 24; // the shape paths are authored in a 24x24 box
const SIZE = BOX * R;

function registerIcons(map: MapLibreMap) {
  for (const cat of LSR_CATEGORIES) {
    const id = `${ICON_PREFIX}${cat}`;
    if (map.hasImage(id)) continue;
    const cv = document.createElement("canvas");
    cv.width = SIZE;
    cv.height = SIZE;
    const ctx = cv.getContext("2d");
    if (!ctx) continue;
    ctx.scale(R, R);

    const path = new Path2D(LSR_SHAPE_PATHS[LSR_SHAPES[cat]]);
    // Dark halo first, so a light marker still reads over a light basemap.
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(6,10,16,0.95)";
    ctx.lineWidth = 3;
    ctx.stroke(path);
    ctx.fillStyle = LSR_COLORS[cat];
    ctx.fill(path);
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 0.9;
    ctx.stroke(path);

    map.addImage(id, ctx.getImageData(0, 0, SIZE, SIZE), { pixelRatio: R });
  }
}

function push(map: MapLibreMap) {
  const src = map.getSource(SRC) as GeoJSONSource | undefined;
  if (!src) return;
  const s = useLsrStore.getState();
  const all = s.data?.features ?? [];
  // Carry each report's index INTO `data.features`, not into the filtered list,
  // so a click can find the original by position instead of by matching
  // coordinates. Coordinate matching looked fine and was not: MapLibre returns
  // a queried feature wrapped into the world copy on screen, so once the map is
  // panned across the antimeridian the longitude differs by 360 and the lookup
  // silently found nothing -- which is a click that does nothing at all.
  const features: GeoJSON.Feature[] = [];
  all.forEach((f, i) => {
    if (s.cats[f.properties.cat] === false) return;
    features.push({
      ...f,
      properties: {
        ...f.properties,
        idx: i,
        // symbol-sort-key wants "smaller draws first"; rank is severity, so flip
        // it -- a tornado report must survive a collision with a rain total.
        sort: 1000 - f.properties.rank,
      },
    });
  });
  src.setData({ type: "FeatureCollection", features } as GeoJSON.FeatureCollection);
}

/** NWS Local Storm Reports: what people on the ground actually observed. */
export const lsrLayer: LayerModule = {
  id: "lsr",
  name: "Local Storm Reports",
  description:
    "Tornado, hail, wind, flood and other reports filed by NWS offices. Click one for the full report.",
  category: "weather",
  source: "NWS Local Storm Reports via Iowa Environmental Mesonet",
  defaultVisible: false,
  defaultOpacity: DEFAULT_OPACITY,

  addTo(map) {
    registerIcons(map);
    if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: EMPTY });

    if (!map.getLayer(ICONS)) {
      map.addLayer({
        id: ICONS,
        type: "symbol",
        source: SRC,
        layout: {
          "icon-image": ["concat", ICON_PREFIX, ["get", "cat"]],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.55, 6, 0.7, 10, 0.9],
          // EVERY report is drawn. Decluttering hid reports at low zoom, and a
          // symbol MapLibre skipped is not hit-testable either — so the ones
          // that disappeared could not be clicked at all.
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "symbol-sort-key": ["get", "sort"],
        },
        paint: { "icon-opacity": opacity },
      });
    }
    if (!map.getLayer(LABELS)) {
      map.addLayer({
        id: LABELS,
        type: "symbol",
        source: SRC,
        minzoom: 5,
        layout: {
          "text-field": ["get", "mag"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 11,
          "text-offset": [0, 1.05],
          "text-anchor": "top",
          "text-optional": true,
          "text-allow-overlap": false,
          "symbol-sort-key": ["get", "sort"],
        },
        paint: {
          "text-color": "#f2f7ff",
          "text-halo-color": "rgba(8,12,18,0.92)",
          "text-halo-width": 1.3,
          "text-opacity": opacity,
        },
      });
    }

    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const store = useLsrStore.getState();
      const idx = Number(f.properties?.idx);
      const byIndex = Number.isInteger(idx) ? store.data?.features[idx] : undefined;
      if (byIndex) {
        store.select(byIndex);
        return;
      }
      // Fall back to the rendered feature itself rather than selecting nothing:
      // every field the card shows is already in its properties, and a click
      // that opens nothing is indistinguishable from a broken layer.
      if (f.geometry.type !== "Point") return;
      store.select({
        type: "Feature",
        geometry: { type: "Point", coordinates: f.geometry.coordinates as [number, number] },
        properties: f.properties as unknown as LsrProps,
      });
    };

    const onEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
    };
    // Bind BOTH layers: the magnitude label reads as part of the marker, so a
    // click on "58 mph" must open the same report as a click on the diamond.
    for (const id of [ICONS, LABELS]) {
      map.on("click", id, onClick);
      map.on("mouseenter", id, onEnter);
      map.on("mouseleave", id, onLeave);
    }

    const unsub = useLsrStore.subscribe((s, prev) => {
      if (s.data !== prev.data || s.cats !== prev.cats) push(map);
      if (s.showLabels !== prev.showLabels && map.getLayer(LABELS)) {
        map.setLayoutProperty(LABELS, "visibility", s.showLabels ? "visible" : "none");
      }
    });
    state.set(map, { unsub, onClick, onEnter, onLeave });

    if (map.getLayer(LABELS)) {
      map.setLayoutProperty(
        LABELS,
        "visibility",
        useLsrStore.getState().showLabels ? "visible" : "none",
      );
    }
    push(map);
    // Only fetch if nothing is loaded yet: a second pane must not restart the
    // request the first one is already waiting on.
    if (!useLsrStore.getState().data) void useLsrStore.getState().load();
  },

  removeFrom(map) {
    const st = state.get(map);
    if (st) {
      for (const id of [ICONS, LABELS]) {
        map.off("click", id, st.onClick);
        map.off("mouseenter", id, st.onEnter);
        map.off("mouseleave", id, st.onLeave);
      }
      st.unsub();
      state.delete(map);
    }
    for (const id of [LABELS, ICONS]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SRC)) map.removeSource(SRC);
    useLsrStore.getState().select(null);
  },

  setOpacity(map, o) {
    opacity = o;
    if (map.getLayer(ICONS)) map.setPaintProperty(ICONS, "icon-opacity", o);
    if (map.getLayer(LABELS)) map.setPaintProperty(LABELS, "text-opacity", o);
  },

  getLayerIds() {
    return [ICONS, LABELS];
  },

  topLayerIds() {
    // Reports are the ground truth over whatever product is being examined;
    // they must never be buried under radar or an alert fill.
    return [ICONS, LABELS];
  },
};
