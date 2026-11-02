import { useEffect, useState } from "react";

import { check, useConnectionStore } from "../store/useConnectionStore";
import { useNexradStore } from "../store/useNexradStore";
import { useAppStore } from "../store/useAppStore";

/** "for 2 min" from a start time, coarse on purpose (it re-renders every 10 s). */
function forHowLong(since: number, now: number): string {
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  return m < 60 ? `for ${m} min` : `for ${Math.floor(m / 60)} h ${m % 60} min`;
}

function useTick(ms: number, on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms, on]);
  return now;
}

/**
 * The status bar's "OFFLINE" / "WEAK CONNECTION" chip (useConnectionStore).
 * Nothing while the connection is fine; clicking it checks again now.
 */
export function ConnectionBadge() {
  const status = useConnectionStore((s) => s.status);
  const reason = useConnectionStore((s) => s.reason);
  const since = useConnectionStore((s) => s.since);
  const now = useTick(10_000, status !== "online");
  if (status === "online") return null;
  const offline = status === "offline";
  return (
    <button
      type="button"
      className={`connbadge connbadge--${status}`}
      onClick={() => void check(true)}
      title={
        `${reason} (${forHowLong(since, now)}). ` +
        (offline
          ? "The panes keep what they have and fetch the scans they missed when the connection is back. Click to check now."
          : "Updates may lag. Click to check now.")
      }
    >
      <span className="connbadge__dot" aria-hidden="true" />
      {offline ? "OFFLINE" : "WEAK CONNECTION"}
    </button>
  );
}

/** A pane's own line above its colour scale: "Offline · not updating". */
export function PaneConnNote({ paneId }: { paneId: string }) {
  const status = useConnectionStore((s) => s.status);
  const hasScan = useNexradStore((s) => !!s.paneRadar[paneId]?.scan);
  // A tilt or product picked while offline has nothing to draw yet: the loop
  // is kept (useNexradStore.loadScans) and the pane says why it is empty.
  const hasLoop = useNexradStore((s) => s.scans.length > 0);
  const radarOn = useAppStore((s) => s.layers.nexrad?.visible ?? false);
  if (status === "online" || (!hasScan && !hasLoop) || !radarOn) return null;
  return (
    <div className={`connnote connnote--${status}`} aria-live="polite">
      <span className="connbadge__dot" aria-hidden="true" />
      {status === "offline"
        ? hasScan
          ? "Offline · not updating"
          : "Offline · this product loads when the connection is back"
        : "Weak connection · updates may lag"}
    </div>
  );
}
