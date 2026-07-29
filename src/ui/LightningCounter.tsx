import { useEffect, useState } from "react";
import { Zap } from "lucide-react";

import { useAppStore } from "../store/useAppStore";
import { useLightningStore } from "../store/useLightningStore";
import { lagLabel } from "../lib/lightning";
import { useDragOffset } from "../lib/useDragOffset";

/** Per-minute counts as a bar strip — the shape says "building" or "dying". */
function Spark({ series }: { series: number[] }) {
  if (series.length < 2) return null;
  const max = Math.max(...series, 1);
  return (
    <div className="litc__spark" aria-hidden>
      {series.map((v, i) => (
        <span
          key={i}
          style={{ height: `${Math.max(6, (v / max) * 100)}%`, opacity: 0.35 + (i / series.length) * 0.65 }}
        />
      ))}
    </div>
  );
}

/**
 * The strike counter, floated over the map.
 *
 * Total alone is a number without a trend, so this also carries the rate, the
 * per-minute shape and how far behind real time the feed is — with a satellite
 * feed the lag is the difference between "quiet" and "not in yet".
 */
export function LightningCounter() {
  const on = useAppStore((s) => s.layers.lightning?.visible ?? false);
  const show = useLightningStore((s) => s.counter);
  const count = useLightningStore((s) => s.count);
  const perMinute = useLightningStore((s) => s.perMinute);
  const series = useLightningStore((s) => s.rateSeries);
  const newestUnix = useLightningStore((s) => s.newestUnix);
  const minutes = useLightningStore((s) => s.minutes);
  const error = useLightningStore((s) => s.error);
  const drag = useDragOffset("lightning", { boundsSelector: ".mappane" });

  // The lag is wall-clock, so it has to re-render on its own or it freezes at
  // whatever it was when the last poll landed.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!on || !show) return;
    const id = window.setInterval(() => tick((n) => n + 1), 5_000);
    return () => window.clearInterval(id);
  }, [on, show]);

  if (!on || !show || error) return null;

  return (
    <div
      ref={drag.ref}
      className={`litc hud-grip${drag.dragging ? " is-dragging" : ""}`}
      style={drag.style}
      title="Drag to move"
      {...drag.handle}
    >
      <div className="litc__head">
        <Zap size={12} />
        <span>Lightning</span>
        <i>{minutes} min</i>
      </div>
      <div className="litc__total">{count.toLocaleString()}</div>
      <div className="litc__rate">
        <b>{perMinute.toLocaleString()}</b> per minute
      </div>
      <Spark series={series} />
      <div className="litc__lag">{lagLabel(newestUnix)} behind live</div>
    </div>
  );
}
