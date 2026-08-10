import { useEffect } from "react";
import type { GeoJSONSource } from "maplibre-gl";

import { getMap } from "../../map/mapInstance";
import { useSoundingViewerStore } from "../../store/useSoundingViewerStore";

const SRC = "areasnd-src";
const RING = "areasnd-ring";
const FILL = "areasnd-fill";
const DOTS = "areasnd-dots";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** The drawn rectangle, as a closed polygon ring. */
function boxPolygon(south: number, west: number, north: number, east: number): GeoJSON.Feature {
  const ring: [number, number][] = [
    [west, south], [east, south], [east, north], [west, north], [west, south],
  ];
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: {} };
}

/**
 * Shows WHERE an area-averaged sounding came from: the rectangle the user drew
 * plus a dot on every grid point that actually contributed. Without it the
 * number in the viewer is unfalsifiable — you cannot tell a tight mean from a
 * sprawling one.
 *
 * Not a registered LayerModule on purpose: it has no independent existence, it
 * is the open sounding's own footprint, and it must not appear in the layer
 * panel as something to toggle.
 */
export function AreaSoundingOverlay() {
  const open = useSoundingViewerStore((s) => s.open);
  const mode = useSoundingViewerStore((s) => s.mode);
  const areaBox = useSoundingViewerStore((s) => s.areaBox);
  const points = useSoundingViewerStore((s) => s.data?.meta.area?.points);

  const active = open && mode === "area" && areaBox != null;

  useEffect(() => {
    const map = getMap();
    if (!map) return;

    const teardown = () => {
      for (const id of [DOTS, RING, FILL]) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SRC)) map.removeSource(SRC);
    };

    if (!active) {
      teardown();
      return;
    }

    const [south, west, north, east] = areaBox as [number, number, number, number];
    const features: GeoJSON.Feature[] = [boxPolygon(south, west, north, east)];
    for (const p of points ?? []) {
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: p },
        properties: {},
      });
    }
    const data: GeoJSON.FeatureCollection = { type: "FeatureCollection", features };

    const add = () => {
      if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: EMPTY });
      if (!map.getLayer(FILL)) {
        map.addLayer({
          id: FILL,
          type: "fill",
          source: SRC,
          filter: ["==", ["geometry-type"], "Polygon"],
          paint: { "fill-color": "#4ea1e8", "fill-opacity": 0.07 },
        });
      }
      if (!map.getLayer(RING)) {
        map.addLayer({
          id: RING,
          type: "line",
          source: SRC,
          filter: ["==", ["geometry-type"], "Polygon"],
          paint: {
            "line-color": "#4ea1e8",
            "line-width": 1.4,
            "line-dasharray": [3, 3],
            "line-opacity": 0.85,
          },
        });
      }
      if (!map.getLayer(DOTS)) {
        map.addLayer({
          id: DOTS,
          type: "circle",
          source: SRC,
          filter: ["==", ["geometry-type"], "Point"],
          paint: {
            "circle-radius": 2.6,
            "circle-color": "#9fd0f5",
            "circle-stroke-color": "rgba(10,15,22,0.8)",
            "circle-stroke-width": 0.8,
          },
        });
      }
      (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(data);
    };

    // A style swap (basemap change) drops every source; re-add on the next load.
    // `once("load")` has to be removable: if the viewer closes before the style
    // finishes loading, the deferred add() would install the rectangle on a map
    // that no longer has a sounding open, and nothing would ever tear it down.
    // A stale `once` also never fires on an already-loaded map, so each run
    // would leak a closure holding the whole FeatureCollection.
    let cancelled = false;
    const guarded = () => {
      if (!cancelled) add();
    };
    if (map.isStyleLoaded()) add();
    else map.once("load", guarded);
    map.on("styledata", guarded);

    return () => {
      cancelled = true;
      map.off("load", guarded);
      map.off("styledata", guarded);
      teardown();
    };
  }, [active, areaBox, points]);

  return null;
}
