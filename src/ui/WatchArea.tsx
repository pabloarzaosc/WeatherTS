import { useEffect } from "react";
import type { GeoJSONSource } from "maplibre-gl";

import { allMaps, getMap, subscribeMaps } from "../map/mapInstance";
import { useWatchStore } from "../store/useWatchStore";

const SRC = "watch-area";
const L_FILL = "watch-area-fill";
const L_LINE = "watch-area-line";
const L_DOT = "watch-area-dot";

/** Circle as a polygon. 96 points is smooth at any zoom this is looked at. */
function circle(center: [number, number], radiusKm: number, steps = 96): GeoJSON.Feature {
  const [lon, lat] = center;
  const latR = radiusKm / 111.32;
  // Longitude degrees shrink with latitude; without this the circle reads as an
  // ellipse anywhere away from the equator.
  const lonR = radiusKm / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  const ring: GeoJSON.Position[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    ring.push([lon + lonR * Math.cos(t), lat + latR * Math.sin(t)]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
}

function data(center: [number, number] | null, radiusKm: number): GeoJSON.FeatureCollection {
  if (!center) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [
      circle(center, radiusKm),
      { type: "Feature", properties: { dot: true }, geometry: { type: "Point", coordinates: center } },
    ],
  };
}

/**
 * Draws the watch circle on every pane and, while picking, turns the next map
 * click into its centre. Renders nothing of its own.
 */
export function WatchArea() {
  const enabled = useWatchStore((s) => s.enabled);
  const center = useWatchStore((s) => s.center);
  const radiusKm = useWatchStore((s) => s.radiusKm);
  const picking = useWatchStore((s) => s.picking);

  // Draw on every pane, not just the focused one: a split view showing the same
  // storm from two angles should show the area in both.
  useEffect(() => {
    const paint = () => {
      for (const map of allMaps()) {
        if (!map.isStyleLoaded()) continue;
        if (!map.getSource(SRC)) {
          map.addSource(SRC, { type: "geojson", data: data(center, radiusKm) });
          map.addLayer({
            id: L_FILL,
            type: "fill",
            source: SRC,
            filter: ["==", ["geometry-type"], "Polygon"],
            paint: { "fill-color": "#3b82f6", "fill-opacity": 0.06 },
          });
          map.addLayer({
            id: L_LINE,
            type: "line",
            source: SRC,
            filter: ["==", ["geometry-type"], "Polygon"],
            paint: { "line-color": "#3b82f6", "line-width": 1.4, "line-dasharray": [3, 2], "line-opacity": 0.85 },
          });
          map.addLayer({
            id: L_DOT,
            type: "circle",
            source: SRC,
            filter: ["==", ["geometry-type"], "Point"],
            paint: {
              "circle-radius": 4,
              "circle-color": "#3b82f6",
              "circle-stroke-width": 1.5,
              "circle-stroke-color": "#0c0f13",
            },
          });
        } else {
          (map.getSource(SRC) as GeoJSONSource).setData(data(center, radiusKm));
        }
        const vis = enabled && center ? "visible" : "none";
        for (const id of [L_FILL, L_LINE, L_DOT]) {
          if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
        }
      }
    };

    paint();
    // A pane can appear later (split view) or still be loading its style.
    const unsub = subscribeMaps(paint);
    const t = window.setInterval(paint, 1000);
    return () => {
      unsub();
      window.clearInterval(t);
    };
  }, [enabled, center, radiusKm]);

  // Picking mode: one click sets the centre and ends the mode.
  useEffect(() => {
    if (!picking) return;
    const map = getMap();
    if (!map) return;
    const prevCursor = map.getCanvas().style.cursor;
    map.getCanvas().style.cursor = "crosshair";

    const onClick = (e: { lngLat: { lng: number; lat: number } }) => {
      useWatchStore.getState().setCenter([e.lngLat.lng, e.lngLat.lat]);
      useWatchStore.getState().setPicking(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useWatchStore.getState().setPicking(false);
    };
    map.once("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      map.off("click", onClick);
      window.removeEventListener("keydown", onKey);
      map.getCanvas().style.cursor = prevCursor;
    };
  }, [picking]);

  return null;
}
