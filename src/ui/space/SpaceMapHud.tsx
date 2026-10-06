import { useEffect, useRef, useState } from "react";
import { Sun } from "lucide-react";

import { spaceLegend, spaceValueAt, type Legend } from "../../layers/modules/spaceLayers";
import { useDragOffset } from "../../lib/useDragOffset";
import { getMap, subscribeMaps } from "../../map/mapInstance";
import { useAppStore } from "../../store/useAppStore";
import { useSpaceStore } from "../../store/useSpaceStore";
import { fmtUtc } from "./TimeStack";

function Bar({ l, valid }: { l: Legend; valid: number | null }) {
  const lo = l.log ? Math.log10(l.stops[0][0]) : l.stops[0][0];
  const hi = l.log ? Math.log10(l.stops[l.stops.length - 1][0]) : l.stops[l.stops.length - 1][0];
  const pos = (v: number) => (((l.log ? Math.log10(v) : v) - lo) / (hi - lo)) * 100;
  const grad = l.stops.map(([v, c]) => `${c} ${pos(v).toFixed(1)}%`).join(", ");
  return (
    <div className="spc-legend__item">
      <div className="spc-legend__head">
        <b>
          {l.title} <em>{l.units}</em>
        </b>
        <span>{valid ? fmtUtc(valid) : "loading…"}</span>
      </div>
      <div className="spc-legend__bar" style={{ background: `linear-gradient(90deg, ${grad})` }} />
      <div className="spc-legend__ticks">
        {l.stops.map(([v]) => (
          <span key={v} style={{ left: `${pos(v)}%` }}>
            {v}
          </span>
        ))}
      </div>
      <small>{l.note}</small>
    </div>
  );
}

/** The space weather layers' scales on the map, and their value under the pointer. */
export function SpaceMapHud() {
  const aurora = useAppStore((s) => s.layers["space-aurora"]?.visible ?? false);
  const field = useAppStore((s) => s.layers["space-field"]?.visible ?? false);
  const kind = useSpaceStore((s) => s.field);
  const auroraValid = useSpaceStore((s) => s.auroraValid);
  const fieldValid = useSpaceStore((s) => s.fieldValid);
  const cursor = useAppStore((s) => s.cursor);
  const drag = useDragOffset("spaceLegend", { boundsSelector: ".mappane" });
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // The map remembers the pointer's last spot (its centre, before any), so the
  // readout would float over the side panel until the mouse first crossed the
  // map. It shows only while the pointer is actually over the map.
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!aurora && !field) return;
    const map = getMap();
    if (!map) return;
    const el = map.getCanvasContainer();
    const enter = () => setOver(true);
    const leave = () => setOver(false);
    el.addEventListener("pointermove", enter);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", enter);
      el.removeEventListener("pointerleave", leave);
    };
  }, [aurora, field]);

  useEffect(() => {
    if (!cursor || (!aurora && !field)) {
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
  }, [cursor, aurora, field]);

  // The radar and analysis colour bars (and the outlook legend) sit along the
  // same bottom edge. Where one runs under the legend (a narrow map, a phone)
  // the legend steps up over it; only the horizontal spans are compared, so
  // the step cannot feed back.
  const [lift, setLift] = useState(0);
  // The radar's product list hangs down the same right-hand side: where it
  // reaches the legend, the legend moves left of it.
  const [shift, setShift] = useState(0);
  const shiftRef = useRef(0);
  useEffect(() => {
    if (!aurora && !field) return;
    const check = () => {
      const me = drag.ref.current?.getBoundingClientRect();
      if (!me) return;
      let up = 0;
      // The colour bars, and on a phone the outlook legend, which shares the bottom-left corner.
      for (const bar of document.querySelectorAll<HTMLElement>(".cbar, .outlook-legend")) {
        const r = bar.getBoundingClientRect();
        if (r.width > 0 && r.left < me.right && r.right > me.left) up += r.height + 8;
      }
      setLift((l) => (l === up ? l : up));
      // Where the legend would be with no shift, against the product list.
      let left = 0;
      const nat = { l: me.left + shiftRef.current, r: me.right + shiftRef.current };
      for (const p of document.querySelectorAll<HTMLElement>(".rpp")) {
        const r = p.getBoundingClientRect();
        if (r.width > 0 && r.bottom > me.top && r.top < me.bottom && r.left < nat.r && r.right > nat.l) left = Math.max(left, nat.r - r.left + 8);
      }
      shiftRef.current = left;
      setShift((v) => (v === left ? v : left));
    };
    check();
    const id = window.setInterval(check, 1500);
    window.addEventListener("resize", check);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("resize", check);
    };
  }, [aurora, field, drag.ref]);

  if (!aurora && !field) return null;
  const reads = cursor && over
    ? [aurora ? spaceValueAt("aurora", cursor.lat, cursor.lng) : null, field ? spaceValueAt("field", cursor.lat, cursor.lng) : null].filter(
        (x): x is { text: string; label: string } => !!x,
      )
    : [];

  return (
    <>
      <aside ref={drag.ref} className={`spc-legend hud-grip${drag.dragging ? " is-dragging" : ""}`} style={{ ...drag.style, marginBottom: lift, marginRight: shift }} aria-label="Space weather legend">
        <div className="spc-legend__title">
          <Sun size={12} /> Space weather
          <button type="button" onClick={() => useSpaceStore.getState().openTab(field && !aurora ? "iono" : "aurora")}>
            Dashboard
          </button>
        </div>
        {aurora && <Bar l={spaceLegend("aurora")} valid={auroraValid} />}
        {field && <Bar l={spaceLegend(kind)} valid={fieldValid} />}
      </aside>
      {pos && reads.length > 0 && (
        <div className="rdxy spc-readout" style={{ left: Math.min(pos.x + 16, window.innerWidth - 170), top: Math.min(pos.y + 16, window.innerHeight - 70) }} aria-hidden>
          {reads.map((r) => (
            <span key={r.label}>
              <span className="rdxy__value">{r.text}</span>
              <span className="rdxy__height">{r.label}</span>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
