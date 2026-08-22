import { useEffect, useState } from "react";
import { ArrowRight, X } from "lucide-react";

import { getMap, subscribeMaps } from "../map/mapInstance";
import { useMesoscaleStore } from "../store/useMesoscaleStore";

/** Expiry as the products write it. Only SPC puts one in its index entry, so
 *  WPC's comes from the parsed valid window instead of reading as unknown. */
function zulu(unix: number | null): string | null {
  if (!unix) return null;
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

/**
 * The card anchored to a clicked mesoscale discussion: which MD it is, what it
 * covers, and the way into the whole product.
 *
 * Same two steps as a storm cell -- a small card on the map, and the card
 * itself opens the full report -- because reading a forecaster's prose over the
 * radar means covering the thing being discussed.
 */
export function MesoscalePopup() {
  const mds = useMesoscaleStore((s) => s.mds);
  const selectedId = useMesoscaleStore((s) => s.selectedId);
  const select = useMesoscaleStore((s) => s.select);
  const openReport = useMesoscaleStore((s) => s.openReport);

  const [pos, setPos] = useState<{ x: number; y: number; maxX: number } | null>(null);
  const md = mds.find((m) => m.id === selectedId) ?? null;

  useEffect(() => {
    if (!md) {
      setPos(null);
      return;
    }
    let map = getMap();
    const update = () => {
      map = getMap();
      if (!map) return;
      // project() is canvas-relative and this card is positioned against the
      // viewport, so the canvas offset has to be added.
      const rect = map.getCanvas().getBoundingClientRect();
      const p = map.project([md.lon, md.lat]);
      // Bounded by the window, not by the map: the card is allowed to sit over
      // the alert rail, and flipping it away from a polygon near the right edge
      // just to dodge the rail moved it off the thing it describes.
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
  }, [md]);

  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, select]);

  if (!md || !pos) return null;

  const W = 236;
  const H = 150;
  // Flip only to stay on screen; the alert rail is drawn under this card.
  const overruns = pos.x + 12 + W > pos.maxX - 8;
  const left = Math.max(8, overruns ? pos.x - 12 - W : pos.x + 12);
  const top = Math.max(8, Math.min(pos.y - H / 2, window.innerHeight - H - 8));

  return (
    <div className={`mdpop mdpop--${md.hazard}`} style={{ left, top, width: W }}>
      <header className="mdpop__head">
        <b>
          {md.kind === "mpd" ? "MPD" : "MD"} {md.number}
        </b>
        <span className="mdpop__tag">{md.hazard === "other" ? "SPC" : md.hazard}</span>
        <button type="button" onClick={() => select(null)} title="Close" aria-label="Close">
          <X size={13} />
        </button>
      </header>

      {md.areas && <p className="mdpop__areas">{md.areas}</p>}

      <dl className="mdpop__rows">
        {md.concerning && (
          <>
            <dt>Concerning</dt>
            <dd>{md.concerning}</dd>
          </>
        )}
        <dt>Valid until</dt>
        <dd>{md.validUntil ?? zulu(md.validEndUnix) ?? "—"}</dd>
      </dl>

      <button type="button" className="mdpop__full" onClick={() => openReport(md.id)}>
        Full discussion <ArrowRight size={13} />
      </button>
    </div>
  );
}
