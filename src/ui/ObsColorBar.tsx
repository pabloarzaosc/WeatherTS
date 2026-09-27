import { useMemo } from "react";

import { useAppStore } from "../store/useAppStore";
import { useObsStore } from "../store/useObsStore";
import { useDragOffset } from "../lib/useDragOffset";

// The analysis scale, along the bottom of the map beside the radar's own.
// It used to sit in the side panel, where reading a colour off the map meant
// looking away from it -- and where it was gone entirely once the panel was
// closed.

/** Trailing zeros help nobody on a scale: 0.25 stays, 70.0 becomes 70. */
function tick(v: number): string {
  const s = Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(Math.abs(v) < 10 ? 1 : 0);
  return s.replace(/\.0$/, "");
}

export function ObsColorBar() {
  // A scale for a layer that is not drawn describes nothing.
  const on = useAppStore((s) => s.layers.observations?.visible ?? false);
  const bar = useObsStore((s) => s.bar);
  const valid = useObsStore((s) => s.valid);
  const field = useObsStore((s) => s.field);
  const catalog = useObsStore((s) => s.catalog);
  // The Compare models grid shows each window's scale in the window.
  const perWindow = useObsStore((s) => s.view === "models");
  // Its own offset, so moving it does not drag the radar's bar with it.
  const drag = useDragOffset("obsColorbar", { boundsSelector: ".mappane" });

  const product = useMemo(
    () => catalog?.products.find((p) => p.id === field)?.label ?? field,
    [catalog, field],
  );

  // After the hooks, never before them.
  if (!on || !bar || !valid || perWindow) return null;
  const span = bar.max - bar.min || 1;
  const pct = (v: number) => ((v - bar.min) / span) * 100;

  return (
    <div
      ref={drag.ref}
      className={`cbar cbar--obs hud-grip${drag.dragging ? " is-dragging" : ""}`}
      style={drag.style}
      aria-label={`Analysis scale: ${product}`}
      title="Drag to move"
      {...drag.handle}
    >
      <div className="cbar__head">
        <span className="cbar__product">{product}</span>
        {bar.unit && <span className="cbar__units">{bar.unit}</span>}
      </div>
      <div className="cbar__bar" style={{ background: `linear-gradient(to right, ${bar.colors.join(", ")})` }} />
      <div className="cbar__ticks">
        {bar.labels
          ? bar.labels.map((l) => (
              <span key={l.t} className="cbar__tick" style={{ left: `${pct(l.v)}%` }}>
                {l.t}
              </span>
            ))
          : bar.ticks.map((t) => (
              <span key={t} className="cbar__tick" style={{ left: `${pct(t)}%` }}>
                {tick(t)}
              </span>
            ))}
      </div>
    </div>
  );
}
