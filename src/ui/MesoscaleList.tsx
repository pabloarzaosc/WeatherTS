import { useEffect, useMemo, useState } from "react";

import { getMap } from "../map/mapInstance";
import { useMesoscaleStore, type MesoscaleMD } from "../store/useMesoscaleStore";
import { useAlertStore } from "../store/useAlertStore";

/**
 * Every mesoscale discussion the backend is holding, as a list.
 *
 * The map deliberately draws only the ones in force at the instant on the
 * timeline -- a day is around thirty discussions written one after another over
 * the same ground, and stacking them turns the map into a pile of outlines.
 * That is right for the map and wrong as the only way to reach them, so the
 * whole day lives here instead: what is running now at the top, what has
 * lapsed underneath, each one a click away from its full report.
 */
function bucket(md: MesoscaleMD, now: number): "live" | "past" | "unknown" {
  if (md.validStartUnix == null || md.validEndUnix == null) return "unknown";
  if (md.validStartUnix <= now && now <= md.validEndUnix) return "live";
  return "past";
}

function zulu(unix: number | null): string {
  if (!unix) return "—";
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

export function MesoscaleList() {
  const mds = useMesoscaleStore((s) => s.mds);
  const select = useMesoscaleStore((s) => s.select);
  const openReport = useMesoscaleStore((s) => s.openReport);
  // The list follows the timeline for the same reason the map does: scrubbed
  // back, "in force" means in force at that frame.
  const timeFilter = useAlertStore((s) => s.timeFilter);

  // Date.now() read during render only advances when something else re-renders
  // this component, so the live/past split froze at whatever it was when the
  // list last changed -- a discussion that lapsed while you watched stayed
  // under "in force" until the next fetch, or until the page was reloaded.
  // Ticking on the same 30 s cadence the map's filter uses keeps the two
  // agreeing about which discussions are running.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    // Scrubbed to a frame, "now" is that frame and does not move.
    if (timeFilter !== null) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [timeFilter]);

  const now = timeFilter ?? Date.now() / 1000;
  const groups = useMemo(() => {
    const live: MesoscaleMD[] = [];
    const past: MesoscaleMD[] = [];
    for (const md of mds) (bucket(md, now) === "past" ? past : live).push(md);
    return { live, past };
  }, [mds, now, tick]);

  if (mds.length === 0) return null;

  const row = (md: MesoscaleMD, lapsed: boolean) => (
    <button
      key={md.id}
      type="button"
      className={`mdlist__row mdlist__row--${md.hazard}${lapsed ? " is-past" : ""}`}
      onClick={() => {
        select(md.id);
        openReport(md.id);
        // Frame it, since a lapsed one is not drawn and would otherwise open a
        // report about somewhere off screen.
        getMap()?.flyTo({ center: [md.lon, md.lat], zoom: 6, essential: true });
      }}
    >
      <span className="mdlist__id">
        {md.kind === "mpd" ? "MPD" : "MD"} {md.number}
      </span>
      <span className="mdlist__concerning">{md.concerning ?? md.areas ?? ""}</span>
      <span className="mdlist__time">
        {zulu(md.validStartUnix)}–{zulu(md.validEndUnix)}
      </span>
    </button>
  );

  return (
    <section className="mdlist">
      <h3 className="alert-list__group-title">
        Mesoscale discussions
        <span className="mdlist__count">
          {groups.live.length} in force · {mds.length} today
        </span>
      </h3>
      {groups.live.map((md) => row(md, false))}
      {groups.past.length > 0 && (
        <details className="mdlist__past">
          <summary>{groups.past.length} earlier today</summary>
          {groups.past.map((md) => row(md, true))}
        </details>
      )}
    </section>
  );
}
