import { useEffect, useRef, useState } from "react";
import type { MapMouseEvent } from "maplibre-gl";
import { Ruler, Hexagon, Circle, Copy, Eraser, X } from "lucide-react";

import { useAppStore } from "../store/useAppStore";
import { getMap } from "../map/mapInstance";
import {
  ensureMeasureLayers,
  updateMeasureGeometry,
  clearMeasureGeometry,
  computeStats,
  computeLabels,
  haversine,
  MeasureLabels,
  type MeasureUnits,
  type Pt,
} from "../lib/measure";

const HINTS = {
  distance: "Click points along a path",
  area: "Click ≥ 3 points to close an area",
  diameter: "Click the center, then the edge",
} as const;

/** Interactive measuring overlay: distance (path), area (polygon) or radius
 *  (circle), with on-map labels, live stats and km/mi units. */
export function MeasureTool() {
  const mode = useAppStore((s) => s.measureMode);
  const setMode = useAppStore((s) => s.setMeasureMode);
  const [points, setPoints] = useState<Pt[]>([]);
  const [hover, setHover] = useState<Pt | null>(null);
  const [units, setUnits] = useState<MeasureUnits>("metric");
  const labelsRef = useRef<MeasureLabels | null>(null);

  // Reset whenever the mode changes (including turning off).
  useEffect(() => {
    setPoints([]);
    setHover(null);
    const map = getMap();
    if (map) {
      clearMeasureGeometry(map);
      labelsRef.current?.clear();
    }
  }, [mode]);

  // Attach map interaction while measuring.
  useEffect(() => {
    if (mode === "off") return;
    const map = getMap();
    if (!map) return;
    ensureMeasureLayers(map);
    if (!labelsRef.current) labelsRef.current = new MeasureLabels(map);

    const onClick = (e: MapMouseEvent) => {
      const p: Pt = [e.lngLat.lng, e.lngLat.lat];
      setPoints((prev) => {
        const last = prev[prev.length - 1];
        if (last && haversine(last, p) < 1) return prev; // ignore double-click dupes
        if (mode === "diameter") return prev.length >= 2 ? [p] : [...prev, p];
        return [...prev, p];
      });
    };
    const onMove = (e: MapMouseEvent) => setHover([e.lngLat.lng, e.lngLat.lat]);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setMode("off");
      else if (ev.key === "Backspace") {
        ev.preventDefault();
        setPoints((prev) => prev.slice(0, -1));
      }
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
    };
  }, [mode, setMode]);

  // Redraw geometry + labels on any change.
  useEffect(() => {
    const map = getMap();
    if (!map || mode === "off") return;
    updateMeasureGeometry(map, mode, points, hover);
    labelsRef.current?.sync(computeLabels(mode, points, hover, units));
  }, [points, hover, mode, units]);

  // Safety net for unmount.
  useEffect(() => () => labelsRef.current?.clear(), []);

  if (mode === "off") return null;

  const stats = computeStats(mode, points, hover, units);
  const hasResult = stats.primary !== "—";
  const copy = () => {
    if (hasResult && navigator.clipboard) navigator.clipboard.writeText(stats.primary).catch(() => {});
  };
  const clear = () => {
    setPoints([]);
    setHover(null);
  };

  return (
    <div className="measure">
      <div className="measure__modes">
        <button
          type="button"
          className={`measure__mode${mode === "distance" ? " is-active" : ""}`}
          onClick={() => setMode("distance")}
        >
          <Ruler size={14} /> Distance
        </button>
        <button
          type="button"
          className={`measure__mode${mode === "area" ? " is-active" : ""}`}
          onClick={() => setMode("area")}
        >
          <Hexagon size={14} /> Area
        </button>
        <button
          type="button"
          className={`measure__mode${mode === "diameter" ? " is-active" : ""}`}
          onClick={() => setMode("diameter")}
        >
          <Circle size={14} /> Radius
        </button>
      </div>

      <div className="measure__main">
        {hasResult ? (
          <>
            <div className="measure__value">{stats.primary}</div>
            <div className="measure__stats">
              {stats.secondary.map((s) => (
                <span key={s} className="measure__stat">
                  {s}
                </span>
              ))}
            </div>
          </>
        ) : (
          <div className="measure__hint">{HINTS[mode]} · Esc to exit</div>
        )}
      </div>

      <div className="measure__units">
        <button
          type="button"
          className={`measure__unit${units === "metric" ? " is-active" : ""}`}
          onClick={() => setUnits("metric")}
        >
          km
        </button>
        <button
          type="button"
          className={`measure__unit${units === "imperial" ? " is-active" : ""}`}
          onClick={() => setUnits("imperial")}
        >
          mi
        </button>
      </div>

      <div className="measure__actions">
        <button type="button" className="measure__btn" onClick={copy} title="Copy value" disabled={!hasResult}>
          <Copy size={15} />
        </button>
        <button type="button" className="measure__btn" onClick={clear} title="Clear (Backspace removes last)">
          <Eraser size={15} />
        </button>
        <button type="button" className="measure__btn" onClick={() => setMode("off")} title="Close (Esc)">
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
