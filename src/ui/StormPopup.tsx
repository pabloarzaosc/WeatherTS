import { useEffect, useState } from "react";
import { ArrowRight, X } from "lucide-react";

import { getMap, subscribeMaps } from "../map/mapInstance";
import { useNexradStore } from "../store/useNexradStore";
import { useStormCellStore } from "../store/useStormCellStore";

/**
 * The card anchored to a selected storm cell: its name, and the way into the
 * full report.
 *
 * Deliberately nothing else. Everything measurable about a cell -- hail,
 * structure, the towns in its path, the warnings over it, and how all of that
 * has trended across scans -- needs more room than a card floating over the
 * radar, and reading it here meant covering the storm being read about. It all
 * lives in StormCellPanel instead.
 *
 * Anchored by projecting the cell's lon/lat to screen pixels on every map move,
 * rather than by a MapLibre popup, so it can be a real React component with the
 * app's own styling.
 */
export function StormPopup() {
  const storms = useNexradStore((s) => s.storms);
  const selectedCellId = useNexradStore((s) => s.selectedCellId);
  const selectCell = useNexradStore((s) => s.selectCell);
  const openCellReport = useStormCellStore((s) => s.open);

  // Bounded by the window: the card is allowed to sit over the alert rail, so
  // a cell near the right edge keeps its card next to it rather than having it
  // thrown to the other side to dodge a panel this is drawn above anyway.
  const [pos, setPos] = useState<{ x: number; y: number; maxX: number } | null>(null);

  const cell = storms?.cells.find((c) => c.id === selectedCellId) ?? null;

  // Re-project on every move so the card tracks the cell while panning/zooming.
  useEffect(() => {
    if (!cell) {
      setPos(null);
      return;
    }
    let map = getMap();
    const update = () => {
      map = getMap();
      if (!map) return;
      // project() is relative to the map canvas, but this card is positioned
      // against the viewport -- without the canvas offset it lands short by the
      // side panel's width and the height of the top bars.
      const rect = map.getCanvas().getBoundingClientRect();
      const p = map.project([cell.lon, cell.lat]);
      setPos({ x: p.x + rect.left, y: p.y + rect.top, maxX: window.innerWidth });
    };
    update();
    const bind = (m: ReturnType<typeof getMap>) => {
      m?.on("move", update);
      m?.on("resize", update);
      return () => {
        m?.off("move", update);
        m?.off("resize", update);
      };
    };
    let unbind = bind(map);
    const unsubPanes = subscribeMaps(() => {
      unbind();
      unbind = bind(getMap());
      update();
    });
    return () => {
      unbind();
      unsubPanes();
    };
  }, [cell]);

  if (!cell || !pos) return null;

  const W = 170;
  const H = 78; // header + button; fixed now that the card has no variable content
  // Tucked right against the cell dot: it is anchored to that dot and nothing
  // else, so distance only makes it harder to tell which cell it belongs to.
  const GAP = 10;
  // Flip only to stay on screen; the alert rail is drawn under this card.
  const wouldOverrun = pos.x + GAP + W > pos.maxX - 8;
  const left = Math.max(8, wouldOverrun ? pos.x - GAP - W : pos.x + GAP);
  const top = Math.max(8, Math.min(pos.y - H / 2, window.innerHeight - H - 8));

  return (
    <div className="stormpop" style={{ left, top, width: W }}>
      <header className="stormpop__head">
        <b>Cell {cell.id}</b>
        <button type="button" onClick={() => selectCell(null)} title="Close" aria-label="Close">
          <X size={14} />
        </button>
      </header>

      <button type="button" className="stormpop__full" onClick={() => openCellReport(cell.id)}>
        Full report <ArrowRight size={13} />
      </button>
    </div>
  );
}
