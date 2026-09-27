import { useEffect, useState } from "react";

import { getMap, subscribeMaps } from "../map/mapInstance";
import { useAppStore } from "../store/useAppStore";
import { useNexradStore } from "../store/useNexradStore";
import { useObsStore } from "../store/useObsStore";
import { useObsSample } from "./useObsSample";

/**
 * The analysed value under the pointer, pinned to the pointer.
 *
 * Same card as the radar readout and the same reasoning: reading a field means
 * looking at the field, not down at a footer. It steps aside when radar has a
 * value to show at the same spot, because two cards on one crosshair is worse
 * than either.
 */
export function ObsReadout() {
  const sample = useObsSample();
  const radarVisible = useAppStore((s) => s.layers["nexrad"]?.visible ?? false);
  const radarReadout = useNexradStore((s) => s.showReadout);
  const cursor = useAppStore((s) => s.cursor);
  // The compare grid covers the map: a value pinned to a pointer it no longer
  // has would only float over the grid.
  const comparing = useObsStore((s) => s.view === "models");
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!cursor) {
      setPos(null);
      return;
    }
    const update = () => {
      const map = getMap();
      if (!map) return;
      const rect = map.getCanvas().getBoundingClientRect();
      const p = map.project([cursor.lng, cursor.lat]);
      setPos({ x: p.x + rect.left, y: p.y + rect.top });
    };
    update();
    return subscribeMaps(update);
  }, [cursor]);

  if (!sample || !pos || comparing || (radarVisible && radarReadout)) return null;

  const W = sample.extra ? 150 : 92;
  const GAP = 16;
  const flipX = pos.x + GAP + W > window.innerWidth - 8;
  const left = flipX ? pos.x - GAP - W : pos.x + GAP;
  const top = Math.min(pos.y + GAP, window.innerHeight - 70);

  return (
    <div className="rdxy" style={{ left, top, minWidth: W }} aria-hidden>
      <span className="rdxy__value">{sample.text}</span>
      {sample.extra && <span className="rdxy__height">{sample.extra}</span>}
      <span className="rdxy__height">{sample.label}</span>
    </div>
  );
}
