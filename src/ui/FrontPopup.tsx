import { useEffect, useState } from "react";
import { Waves, X } from "lucide-react";

import { getMap, subscribeMaps } from "../map/mapInstance";
import { FRONT_COLORS, FRONT_DESCRIPTIONS, FRONT_LABELS, type FrontKind } from "../lib/fronts";
import { useFrontsStore } from "../store/useFrontsStore";

function fmtValid(unix: number | null): string {
  if (!unix) return "--";
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

const CENTRE_TITLE: Record<string, string> = {
  high: "High pressure centre",
  low: "Low pressure centre",
};

/**
 * The card that opens when a front or a pressure centre is clicked. Anchored by
 * projecting the clicked position on every map move, so it stays on the feature
 * while panning instead of drifting off it.
 */
export function FrontPopup() {
  const pick = useFrontsStore((s) => s.selected);
  const select = useFrontsStore((s) => s.select);
  const frames = useFrontsStore((s) => s.frames);
  const index = useFrontsStore((s) => s.index);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!pick) {
      setPos(null);
      return;
    }
    const update = () => {
      const map = getMap();
      if (!map) return;
      const p = map.project(pick.lngLat);
      setPos({ x: p.x, y: p.y });
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
    let unbind = bind(getMap());
    const unsubPanes = subscribeMaps(() => {
      unbind();
      unbind = bind(getMap());
      update();
    });
    return () => {
      unbind();
      unsubPanes();
    };
  }, [pick]);

  if (!pick || !pos) return null;

  const frame = frames[index];
  const isCentre = pick.kind === "high" || pick.kind === "low";
  const title = isCentre
    ? CENTRE_TITLE[pick.kind]
    : FRONT_LABELS[pick.kind as FrontKind] ?? pick.label ?? "Feature";
  const color = isCentre
    ? pick.kind === "high"
      ? FRONT_COLORS.cold
      : FRONT_COLORS.warm
    : FRONT_COLORS[pick.kind as FrontKind] ?? "#9aa7b5";

  const W = 268;
  const left = Math.max(8, Math.min(pos.x + 16, window.innerWidth - W - 10));
  const top = Math.max(8, Math.min(pos.y - 10, window.innerHeight - 210));

  return (
    <div className="frontpop" style={{ left, top, width: W }}>
      <header className="frontpop__head">
        <Waves size={13} />
        <span>Surface fronts</span>
        <button type="button" onClick={() => select(null)} title="Close">
          <X size={14} />
        </button>
      </header>

      <strong className="frontpop__title" style={{ color }}>
        {title}
      </strong>

      <dl className="frontpop__rows">
        {isCentre && (
          <div>
            <dt>Pressure</dt>
            <dd>{pick.pressure != null ? `${pick.pressure} mb` : "--"}</dd>
          </div>
        )}
        {!isCentre && pick.strength && (
          <div>
            <dt>Strength</dt>
            <dd>{pick.strength}</dd>
          </div>
        )}
        <div>
          <dt>Chart</dt>
          <dd>{frame ? (frame.kind === "forecast" ? frame.label : "Analysis") : "--"}</dd>
        </div>
        <div>
          <dt>Valid at</dt>
          <dd>{fmtValid(frame?.validUnix ?? null)}</dd>
        </div>
      </dl>

      {!isCentre && FRONT_DESCRIPTIONS[pick.kind as FrontKind] && (
        <p className="frontpop__desc">{FRONT_DESCRIPTIONS[pick.kind as FrontKind]}</p>
      )}
    </div>
  );
}
