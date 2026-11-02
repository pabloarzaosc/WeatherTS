import { useEffect, useState } from "react";

import { getMap, getMapById, subscribeMaps } from "../map/mapInstance";
import { useAppStore } from "../store/useAppStore";
import { useNexradStore } from "../store/useNexradStore";
import { useRadarSample } from "./useRadarSample";

/**
 * The gate value under the pointer, pinned to the pointer.
 *
 * The status bar carries the same number, but reading a radar means looking at
 * the echo, not down at the footer -- so the value comes to where you are
 * already looking. Height rides along with it because the same 46 dBZ at
 * 0.8 kft and at 25 kft are different weather.
 *
 * Offset down and to the right of the crosshair so it never covers the gate it
 * describes, and flipped near an edge so it stays on screen.
 */
export function RadarReadout() {
  const sample = useRadarSample();
  const showReadout = useNexradStore((s) => s.showReadout);
  const cursor = useAppStore((s) => s.cursor);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!cursor) {
      setPos(null);
      return;
    }
    const update = () => {
      const map = (cursor.pane ? getMapById(cursor.pane) : null) ?? getMap();
      if (!map) return;
      // project() is canvas-relative; this card is positioned against the
      // viewport, so the canvas offset has to be added.
      const rect = map.getCanvas().getBoundingClientRect();
      const p = map.project([cursor.lng, cursor.lat]);
      setPos({ x: p.x + rect.left, y: p.y + rect.top });
    };
    update();
    const unsub = subscribeMaps(update);
    return unsub;
  }, [cursor]);

  // The status bar keeps carrying the same reading either way, so switching
  // this off quiets the map without giving the number up.
  if (!showReadout || !sample || !pos) return null;

  const W = 92;
  const GAP = 16;
  const flipX = pos.x + GAP + W > window.innerWidth - 8;
  const left = flipX ? pos.x - GAP - W : pos.x + GAP;
  const top = Math.min(pos.y + GAP, window.innerHeight - 70);

  return (
    <div className="rdxy" style={{ left, top, minWidth: W }} aria-hidden>
      <span className="rdxy__value">{sample.text}</span>
      {/* Height on a tilt, the product's name otherwise. A derived product has
          no beam height, and "60.0 kft" on its own does not say whether that is
          an echo top or how high the beam was -- the label answers it. */}
      <span className="rdxy__height">{sample.height ?? sample.label}</span>
    </div>
  );
}
