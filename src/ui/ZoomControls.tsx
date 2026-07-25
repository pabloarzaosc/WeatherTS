import { GripHorizontal, Plus, Minus, LocateFixed } from "lucide-react";

import { getMap } from "../map/mapInstance";
import { flyToMyLocation } from "../lib/geolocate";
import { useDragOffset } from "../lib/useDragOffset";

export function ZoomControls() {
  const drag = useDragOffset("zoom");
  return (
    <div
      ref={drag.ref}
      className={`zoom${drag.dragging ? " is-dragging" : ""}`}
      style={drag.style}
      aria-label="Zoom controls"
    >
      {/* The buttons are all targets, so the grip is its own strip. */}
      <div className="zoom__grip hud-grip" title="Drag to move" {...drag.handle}>
        <GripHorizontal size={13} />
      </div>
      <button
        type="button"
        className="zoom__btn"
        aria-label="Zoom in"
        onClick={() => getMap()?.zoomIn()}
      >
        <Plus size={18} />
      </button>
      <button
        type="button"
        className="zoom__btn"
        aria-label="Zoom out"
        onClick={() => getMap()?.zoomOut()}
      >
        <Minus size={18} />
      </button>
      {/* Reset-view lives in the top bar (and "Home"); the map's own corner is
          where a locate button is expected, so that is what sits here. */}
      <button
        type="button"
        className="zoom__btn"
        aria-label="My location"
        title="Go to my location"
        onClick={() => void flyToMyLocation().catch(() => {})}
      >
        <LocateFixed size={16} />
      </button>
    </div>
  );
}
