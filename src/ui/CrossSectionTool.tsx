import { useEffect, useRef } from "react";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type MapMouseEvent, type Marker } from "maplibre-gl";

import { getMap } from "../map/mapInstance";
import { volumeKey } from "../lib/radarFrames";
import { useNexradStore } from "../store/useNexradStore";
import { useXsectStore } from "../store/useXsectStore";
import { CrossSectionPanel } from "./CrossSectionPanel";
import { AnalysisHost } from "./PaneWindows";

const SRC = "xsect-src";
const LINE = "xsect-line";
const HOVER = "xsect-hover";

type LngLat = [number, number];
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** The theme's accent: the line is a tool, drawn in the app's colour. */
function accent(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#6c9dff";
}

function ensureLayers(map: MapLibreMap) {
  if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: EMPTY });
  if (!map.getLayer(LINE)) {
    map.addLayer({
      id: LINE,
      type: "line",
      source: SRC,
      filter: ["==", ["get", "kind"], "line"],
      layout: { "line-cap": "round" },
      paint: { "line-color": accent(), "line-width": 2.4, "line-dasharray": [2, 1.4] },
    });
  }
  if (!map.getLayer(HOVER)) {
    map.addLayer({
      id: HOVER,
      type: "circle",
      source: SRC,
      filter: ["==", ["get", "kind"], "hover"],
      paint: {
        "circle-radius": 5,
        "circle-color": "#ffffff",
        "circle-stroke-color": accent(),
        "circle-stroke-width": 2,
      },
    });
  }
}

function removeLayers(map: MapLibreMap) {
  for (const id of [HOVER, LINE]) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(SRC)) map.removeSource(SRC);
}

/** A point a fraction t of the way from a to b, along the straight map line. */
function along(a: LngLat, b: LngLat, t: number): LngLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function draw(map: MapLibreMap, a: LngLat | null, b: LngLat | null, hover: number | null) {
  ensureLayers(map);
  const feats: GeoJSON.Feature[] = [];
  if (a && b) {
    feats.push({ type: "Feature", properties: { kind: "line" }, geometry: { type: "LineString", coordinates: [a, b] } });
    if (hover != null) {
      feats.push({ type: "Feature", properties: { kind: "hover" }, geometry: { type: "Point", coordinates: along(a, b, hover) } });
    }
  }
  (map.getSource(SRC) as GeoJSONSource).setData({ type: "FeatureCollection", features: feats });
}

function endMarker(label: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "xsect-end";
  el.textContent = label;
  return el;
}

/**
 * The cross-section's map side: picking the line (click A, click B), its two
 * ends as draggable markers afterwards, the dot that follows the pointer over
 * the section -- and the section following the radar frame on screen.
 */
export function CrossSectionTool() {
  const drawing = useXsectStore((s) => s.drawing);
  const a = useXsectStore((s) => s.a);
  const b = useXsectStore((s) => s.b);
  const hover = useXsectStore((s) => s.hover);
  const markers = useRef<{ a: Marker; b: Marker } | null>(null);
  const first = useRef<LngLat | null>(null);

  // The frame on screen: the section slices the volume it came from.
  const site = useNexradStore((s) => s.site);
  const scan = useNexradStore((s) => s.scans[s.index] ?? null);
  useEffect(() => {
    // A SAILS rescan frame slices its volume; the volume still being written
    // is not whole yet, so the section takes the newest whole one.
    if (scan?.partial) {
      useXsectStore.getState().setFrame(site, null, "");
      return;
    }
    const key = scan?.key?.startsWith("L2") ? volumeKey(scan.key) : "";
    useXsectStore.getState().setFrame(site, scan?.time ?? null, key);
  }, [site, scan]);

  // Picking the two ends.
  useEffect(() => {
    if (!drawing) return;
    const map = getMap();
    if (!map) return;
    ensureLayers(map);
    first.current = null;
    const onClick = (e: MapMouseEvent) => {
      const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
      if (!first.current) {
        first.current = p;
        draw(map, p, p, null);
        return;
      }
      useXsectStore.getState().setLine(first.current, p);
      first.current = null;
    };
    const onMove = (e: MapMouseEvent) => {
      if (first.current) draw(map, first.current, [e.lngLat.lng, e.lngLat.lat], null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") useXsectStore.getState().cancelDrawing();
    };
    map.on("click", onClick);
    map.on("mousemove", onMove);
    window.addEventListener("keydown", onKey);
    map.doubleClickZoom.disable();
    map.getCanvas().style.cursor = "crosshair";
    return () => {
      map.off("click", onClick);
      map.off("mousemove", onMove);
      window.removeEventListener("keydown", onKey);
      map.doubleClickZoom.enable();
      map.getCanvas().style.cursor = "";
      // Cancelled half way: the half line goes.
      const s = useXsectStore.getState();
      if (!s.a) draw(map, null, null, null);
      else draw(map, s.a, s.b, s.hover);
    };
  }, [drawing]);

  // The line and its ends while there is a section.
  useEffect(() => {
    const map = getMap();
    if (!map) return;
    if (!a || !b) {
      markers.current?.a.remove();
      markers.current?.b.remove();
      markers.current = null;
      if (!drawing) removeLayers(map);
      return;
    }
    draw(map, a, b, hover);
    if (!markers.current) {
      const ma = new maplibregl.Marker({ element: endMarker("A"), draggable: true }).setLngLat(a).addTo(map);
      const mb = new maplibregl.Marker({ element: endMarker("B"), draggable: true }).setLngLat(b).addTo(map);
      const moved = () => {
        const pa = ma.getLngLat();
        const pb = mb.getLngLat();
        draw(map, [pa.lng, pa.lat], [pb.lng, pb.lat], null);
      };
      const dropped = () => {
        const pa = ma.getLngLat();
        const pb = mb.getLngLat();
        useXsectStore.getState().setLine([pa.lng, pa.lat], [pb.lng, pb.lat]);
      };
      for (const m of [ma, mb]) {
        m.on("drag", moved);
        m.on("dragend", dropped);
      }
      markers.current = { a: ma, b: mb };
    } else {
      markers.current.a.setLngLat(a);
      markers.current.b.setLngLat(b);
    }
  }, [a, b, hover, drawing]);

  useEffect(
    () => () => {
      markers.current?.a.remove();
      markers.current?.b.remove();
      const map = getMap();
      if (map) removeLayers(map);
    },
    [],
  );

  // The section covers the map, so it steps aside while a new line is drawn.
  // In a pane of its own when one holds it (panes-compare), else over the map.
  return a && b && !drawing ? (
    <AnalysisHost kind="xsect">
      <CrossSectionPanel />
    </AnalysisHost>
  ) : null;
}
