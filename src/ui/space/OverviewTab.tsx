import { useMemo } from "react";
import { Bell, ChevronRight } from "lucide-react";

import { loadAlerts, loadFlareOdds, loadKp3h, loadProtons, loadScales, loadSdoLatest, loadSolarWind, loadXrays, flareClass, loadFlares } from "../../lib/space/data";
import { useSpaceStore } from "../../store/useSpaceStore";
import { TimeStack, fmtUtc, type ChartPanel } from "./TimeStack";
import { Card, SCALE_NAMES, ScaleBadge, useSwpc } from "./common";
import { kpPanel, protonPanel, windPanels, xrayPanel } from "./panels";

const DAY = 86_400_000;

/** The last whole minute: chart ranges end there and move on once a minute. */
export function useNowDomain(ms: number, at: number | null, ahead = 0): [number, number] {
  return useMemo(() => {
    const end = Math.ceil((at ?? Date.now()) / 60_000) * 60_000;
    return [end - ms, end + ahead];
  }, [ms, at, ahead]);
}

export function ScalesCard() {
  const { data: s } = useSwpc("scales", loadScales);
  const dayName = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <Card title="NOAA space weather scales" extra={s && <span className="spc-card__meta">{fmtUtc(s.issued)}</span>}>
      <div className="spc-scales">
        <div className="spc-scales__row spc-scales__row--head">
          <span />
          <span>Radio blackouts</span>
          <span>Radiation storms</span>
          <span>Geomagnetic storms</span>
        </div>
        <div className="spc-scales__row">
          <span>Last 24 h max</span>
          <span><ScaleBadge k="R" level={s?.past24.R ?? 0} /> {SCALE_NAMES[s?.past24.R ?? 0]}</span>
          <span><ScaleBadge k="S" level={s?.past24.S ?? 0} /> {SCALE_NAMES[s?.past24.S ?? 0]}</span>
          <span><ScaleBadge k="G" level={s?.past24.G ?? 0} /> {SCALE_NAMES[s?.past24.G ?? 0]}</span>
        </div>
        <div className="spc-scales__row spc-scales__row--now">
          <span>Now</span>
          <span><ScaleBadge k="R" level={s?.now.R ?? 0} big /> {SCALE_NAMES[s?.now.R ?? 0]}</span>
          <span><ScaleBadge k="S" level={s?.now.S ?? 0} big /> {SCALE_NAMES[s?.now.S ?? 0]}</span>
          <span><ScaleBadge k="G" level={s?.now.G ?? 0} big /> {SCALE_NAMES[s?.now.G ?? 0]}</span>
        </div>
        {s?.days.map((d) => (
          <div className="spc-scales__row" key={d.date}>
            <span>{dayName(d.date)}</span>
            <span>
              R1-R2 <b>{d.rMinor ?? "--"}%</b> · R3+ <b>{d.rMajor ?? "--"}%</b>
            </span>
            <span>
              S1+ <b>{d.sProb ?? "--"}%</b>
            </span>
            <span>
              <ScaleBadge k="G" level={d.G} /> {SCALE_NAMES[d.G]}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function FlareOddsCard() {
  const { data: o } = useSwpc("odds", loadFlareOdds, 600);
  const { data: flares } = useSwpc("flares", loadFlares);
  const big = flares?.find((f) => /^[MX]/.test(f.cls));
  return (
    <Card title="Flare odds, whole disk" extra={o && <span className="spc-card__meta">{o.date}</span>}>
      {o ? (
        <table className="spc-table spc-table--odds">
          <thead>
            <tr>
              <th />
              <th>Day 1</th>
              <th>Day 2</th>
              <th>Day 3</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["C-class", o.c],
                ["M-class", o.m],
                ["X-class", o.x],
                ["Proton (S1+)", o.proton],
              ] as [string, number[]][]
            ).map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                {v.map((p, i) => (
                  <td key={i}>
                    <span className="spc-pct" style={{ ["--p" as string]: `${p}%` }}>
                      {p}%
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="spc-msg">Reading…</div>
      )}
      {flares && (
        <div className="spc-card__foot">
          Last 7 days: {flares.length} flares, {flares.filter((f) => f.cls.startsWith("M")).length} M, {flares.filter((f) => f.cls.startsWith("X")).length} X.
          {big && ` Largest recent: ${big.cls} at ${fmtUtc(big.max)}.`}
        </div>
      )}
    </Card>
  );
}

export function AlertsCard({ max = 6 }: { max?: number }) {
  const { data } = useSwpc("alerts", loadAlerts);
  const setTab = useSpaceStore((s) => s.setTab);
  return (
    <Card
      title="Latest SWPC alerts"
      extra={
        <button type="button" className="spc-link" onClick={() => setTab("alerts")}>
          All <ChevronRight size={12} />
        </button>
      }
    >
      <ul className="spc-alerts">
        {(data ?? []).slice(0, max).map((a) => (
          <li key={a.id} className={`is-${a.kind}`}>
            <button type="button" onClick={() => useSpaceStore.getState().pickAlert(a.id)}>
              <Bell size={12} />
              <span>
                <b>{a.title}</b>
                <small>
                  {a.code} · {fmtUtc(a.issued)}
                </small>
              </span>
            </button>
          </li>
        ))}
        {!data && <li className="spc-msg">Reading…</li>}
      </ul>
    </Card>
  );
}

export function OverviewTab() {
  const sw = useSwpc("sw-1d", () => loadSolarWind("1d"));
  const xr = useSwpc("xr-1d", () => loadXrays("1d"));
  const pr = useSwpc("pr-1d", () => loadProtons("1d"));
  const kp = useSwpc("kp3h", loadKp3h, 300);
  const domain = useNowDomain(DAY, sw.at);
  const kpDomain = useMemo<[number, number]>(() => {
    if (!kp.data?.length) return [Date.now() - 7 * DAY, Date.now() + 3 * DAY];
    return [kp.data[0].t, kp.data[kp.data.length - 1].t + 3 * 3_600_000];
  }, [kp.data]);
  const dayPanels = useMemo<ChartPanel[]>(() => {
    const [field, speed] = windPanels(sw.data, true);
    const p = protonPanel(pr.data ?? null);
    p.series = p.series.filter((s) => s.label === "≥10 MeV");
    return [{ ...xrayPanel(xr.data?.short ?? null, xr.data?.long ?? null), weight: 1.2 }, field, speed, { ...p, weight: 0.9 }];
  }, [sw.data, xr.data, pr.data]);
  const kpPanels = useMemo(() => [kpPanel(kp.data, [], 1)], [kp.data]);
  const xFlare = latestClass(xr.data?.long ?? null);

  return (
    <div className="spc-grid spc-grid--overview">
      <div className="spc-col spc-col--main">
        <Card
          title="Last 24 hours"
          extra={
            <span className="spc-card__meta">
              {sw.data?.source ? `Solar wind: ${sw.data.source}` : ""}
              {xFlare ? ` · X-ray now ${xFlare}` : ""}
            </span>
          }
          className="spc-card--fill"
        >
          <TimeStack panels={dayPanels} domain={domain} />
        </Card>
        <Card title="Kp: the last week and SWPC's 3-day forecast" className="spc-card--kp">
          <TimeStack panels={kpPanels} domain={kpDomain} />
        </Card>
      </div>
      <div className="spc-col spc-col--side">
        <ScalesCard />
        <SunNowCard />
        <FlareOddsCard />
        <AlertsCard />
      </div>
    </div>
  );
}

function latestClass(s: { v: Float64Array } | null): string | null {
  if (!s) return null;
  for (let i = s.v.length - 1; i >= 0; i--) if (Number.isFinite(s.v[i])) return flareClass(s.v[i]);
  return null;
}

/** Three suns side by side: the corona, the chromosphere, the field. */
function SunNowCard() {
  const setTab = useSpaceStore((s) => s.setTab);
  const { data } = useSwpc("sdo-512", () => loadSdoLatest(512), 300);
  const imgs = [
    { id: "0193", label: "AIA 193" },
    { id: "0304", label: "AIA 304" },
    { id: "211193171", label: "AIA 211/193/171" },
  ];
  return (
    <Card
      title="The Sun now"
      extra={
        <button type="button" className="spc-link" onClick={() => setTab("sun")}>
          Sun <ChevronRight size={12} />
        </button>
      }
    >
      <div className="spc-suns">
        {imgs.map((i) => (
          <button key={i.id} type="button" onClick={() => setTab("sun")} title={`SDO ${i.label}`}>
            {data?.[i.id] ? <img src={data[i.id].url} alt={i.label} loading="lazy" /> : <i className="spc-pick__ph" />}
            <span>{i.label}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}
