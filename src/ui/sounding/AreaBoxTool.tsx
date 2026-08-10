import { useEffect, useState } from "react";
import { Square, X } from "lucide-react";
import type { Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";

import { getActivePaneId, getMap, subscribeMaps } from "../../map/mapInstance";
import { useSoundingViewerStore } from "../../store/useSoundingViewerStore";

/**
 * Drag-to-draw the rectangle an area sounding averages over.
 *
 * Three things this has to get right, all of which bite in practice:
 *
 * 1. The drag ENDS on window, not on the map. MapLibre only emits `mouseup`
 *    when the release lands on its canvas, so releasing over the hint pill,
 *    the sounding panel, the top bar or outside the browser would leave the
 *    drag running forever — the rectangle kept rubber-banding with no button
 *    held and the tool never disarmed. The release point is unprojected from
 *    the canvas's own coordinate space so a drag can finish anywhere.
 * 2. Every camera handler that reads a drag has to be off while armed —
 *    dragPan, boxZoom, dragRotate, doubleClickZoom — or a shift-drag zooms the
 *    map AND opens a sounding, and a right-drag rotates it AND opens one.
 *    Their previous enabled state is restored, not blindly re-enabled, so this
 *    cannot clobber another tool that disabled them first.
 * 3. It follows the focused pane. `getMap()` answers with whichever pane has
 *    focus, so the effect re-binds when that changes; otherwise the listeners
 *    stay on the old pane while the outline is drawn against the new one.
 */

const KM_PER_DEG_LAT = 111.32;
/** Below this the box is a mis-drag, not an area. Mirrors the backend's gate,
 *  in kilometres — an angular gate is unusable at city zoom, where the whole
 *  visible map can be a fraction of a degree. */
const MIN_SIDE_KM = 2;

function boxSizeKm(south: number, west: number, north: number, east: number) {
  const midLat = (south + north) / 2;
  return {
    widthKm: Math.abs(east - west) * KM_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180),
    heightKm: Math.abs(north - south) * KM_PER_DEG_LAT,
  };
}

export function AreaBoxTool() {
  const selecting = useSoundingViewerStore((s) => s.areaSelecting);
  const setSelecting = useSoundingViewerStore((s) => s.setAreaSelecting);
  const openArea = useSoundingViewerStore((s) => s.openArea);

  // Re-run the effect when the focused pane changes, so the listeners and the
  // disabled handlers move with it.
  const [paneId, setPaneId] = useState(() => getActivePaneId());
  useEffect(() => subscribeMaps(() => setPaneId(getActivePaneId())), []);

  const [rect, setRect] = useState<
    { x0: number; y0: number; x1: number; y1: number; ox: number; oy: number } | null
  >(null);
  const [tooSmall, setTooSmall] = useState(false);

  useEffect(() => {
    const map: MapLibreMap | null = getMap();
    if (!map || !selecting) return;

    const canvas = map.getCanvas();
    const prevCursor = canvas.style.cursor;
    canvas.style.cursor = "crosshair";

    // Remember what was on before touching it: another tool may already have
    // disabled some of these, and blindly enabling them on exit would undo it.
    const handlers = [map.dragPan, map.boxZoom, map.dragRotate, map.doubleClickZoom];
    const wasEnabled = handlers.map((h) => h.isEnabled());
    handlers.forEach((h) => h.disable());

    let start: { lng: number; lat: number; x: number; y: number } | null = null;

    /** Window coords -> the map's lngLat, valid outside the canvas too. */
    const lngLatAt = (clientX: number, clientY: number) => {
      const b = canvas.getBoundingClientRect();
      return map.unproject([clientX - b.left, clientY - b.top]);
    };

    const onDown = (e: MapMouseEvent) => {
      if (e.originalEvent.button !== 0) return; // left button only
      start = { lng: e.lngLat.lng, lat: e.lngLat.lat, x: e.point.x, y: e.point.y };
      setTooSmall(false);
      const b = canvas.getBoundingClientRect();
      setRect({
        x0: e.point.x, y0: e.point.y, x1: e.point.x, y1: e.point.y,
        ox: b.left, oy: b.top,
      });
    };

    const onWinMove = (ev: MouseEvent) => {
      if (!start) return;
      const b = canvas.getBoundingClientRect();
      const x = ev.clientX - b.left;
      const y = ev.clientY - b.top;
      setRect((prev) => (prev ? { ...prev, x1: x, y1: y } : prev));
    };

    const onWinUp = (ev: MouseEvent) => {
      if (!start) return;
      const s = start;
      start = null;
      setRect(null);
      const end = lngLatAt(ev.clientX, ev.clientY);
      const south = Math.min(s.lat, end.lat);
      const north = Math.max(s.lat, end.lat);
      const west = Math.min(s.lng, end.lng);
      const east = Math.max(s.lng, end.lng);
      const { widthKm, heightKm } = boxSizeKm(south, west, north, east);
      // Say so rather than silently doing nothing: a drag that produced no
      // sounding and no message reads as a broken tool.
      if (widthKm < MIN_SIDE_KM || heightKm < MIN_SIDE_KM) {
        setTooSmall(true);
        return;
      }
      setSelecting(false);
      openArea([south, west, north, east]);
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        start = null;
        setRect(null);
        setSelecting(false);
      }
    };

    map.on("mousedown", onDown);
    window.addEventListener("mousemove", onWinMove);
    window.addEventListener("mouseup", onWinUp);
    window.addEventListener("keydown", onKey);

    return () => {
      map.off("mousedown", onDown);
      window.removeEventListener("mousemove", onWinMove);
      window.removeEventListener("mouseup", onWinUp);
      window.removeEventListener("keydown", onKey);
      canvas.style.cursor = prevCursor;
      handlers.forEach((h, i) => {
        if (wasEnabled[i]) h.enable();
      });
      setRect(null);
      setTooSmall(false);
    };
  }, [selecting, paneId, setSelecting, openArea]);

  if (!selecting) return null;

  const box = rect
    ? {
        left: rect.ox + Math.min(rect.x0, rect.x1),
        top: rect.oy + Math.min(rect.y0, rect.y1),
        width: Math.abs(rect.x1 - rect.x0),
        height: Math.abs(rect.y1 - rect.y0),
      }
    : null;

  return (
    <>
      {box && (
        <div
          className="areabox__rect"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      )}
      <div className={`areabox__hint${tooSmall ? " is-warn" : ""}`}>
        <Square size={13} />
        <span>
          {tooSmall
            ? `That box is under ${MIN_SIDE_KM} km across — drag a larger one`
            : "Drag a box to average the sounding over it"}
        </span>
        <button type="button" onClick={() => setSelecting(false)} title="Cancel (Esc)">
          <X size={13} />
        </button>
      </div>
    </>
  );
}
