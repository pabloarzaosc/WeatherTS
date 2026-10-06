import { useMemo, useState } from "react";

import { RANGES, loadAceMonth, loadSolarWind, rangeMs, type Series, type SolarWind } from "../../lib/space/data";
import { useSpaceStore } from "../../store/useSpaceStore";
import { useNowDomain } from "./OverviewTab";
import { TimeStack } from "./TimeStack";
import { Card, Seg, latest, useSwpc } from "./common";
import { windPanels } from "./panels";

const MONTH = 30 * 86_400_000;

export function WindTab() {
  const range = useSpaceStore((s) => s.range);
  const setRange = useSpaceStore((s) => s.setRange);
  const [month, setMonth] = useState(false);
  const [atEarth, setAtEarth] = useState(false);
  const sw = useSwpc(`sw-${range}-${atEarth}`, () => loadSolarWind(range, atEarth));
  const ace = useSwpc(month ? "ace-month" : "ace-off", () => (month ? loadAceMonth() : Promise.resolve(null)), 600);

  const domain = useNowDomain(month ? MONTH : rangeMs(range), sw.at, atEarth ? 90 * 60_000 : 0);
  const data: SolarWind | null = useMemo(() => {
    if (!month) return sw.data;
    if (!ace.data) return null;
    const e: Series = { t: new Float64Array(), v: new Float64Array() };
    return { ...ace.data, bx: e, by: e, phi: e, source: "ACE, hourly", arrival: null, propagated: false };
  }, [month, sw.data, ace.data]);
  const panels = useMemo(() => {
    const p = windPanels(data);
    return month ? p.filter((x) => x.id !== "phi") : p;
  }, [data, month]);

  const v = latest(sw.data?.speed);
  const lead = sw.data?.arrival != null ? Math.round((sw.data.arrival - Date.now()) / 60_000) : null;

  return (
    <div className="spc-grid">
      <Card
        className="spc-card--fill"
        title="Solar wind at L1"
        extra={
          <div className="spc-card__tools">
            <span className="spc-card__meta">
              {data?.source}
              {!month && lead != null && lead > 0 && v ? ` · reaches Earth in about ${lead} min at ${v.v.toFixed(0)} km/s` : ""}
            </span>
            <Seg
              label="Time base"
              value={atEarth ? "earth" : "l1"}
              onChange={(x) => setAtEarth(x === "earth")}
              options={[
                { id: "l1", label: "At L1", title: "When it was measured, 1.5 million km sunward" },
                { id: "earth", label: "At Earth", title: "When it reaches Earth's bow shock (SWPC's propagated solar wind)" },
              ]}
            />
            <Seg
              label="Range"
              value={month ? "30d" : range}
              onChange={(r) => {
                if (r === "30d") setMonth(true);
                else {
                  setMonth(false);
                  setRange(r as typeof range);
                }
              }}
              options={[...RANGES.map((r) => ({ id: r.id as string, label: r.label })), { id: "30d", label: "30D", title: "ACE hourly, the last month" }]}
            />
          </div>
        }
      >
        {(month ? ace.error : sw.error) && <div className="spc-msg">Could not read the solar wind: {month ? ace.error : sw.error}</div>}
        <TimeStack panels={panels} domain={domain} />
        <p className="spc-note">
          A southward field (Bz below zero) held for hours, with fast dense wind, is what drives geomagnetic storms. The 1-day range and shorter
          read SWPC's real-time feed from whichever spacecraft it has active; 3 and 7 days read the propagated week, and 30 days ACE's hourly averages.
        </p>
      </Card>
    </div>
  );
}
