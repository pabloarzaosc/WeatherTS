import { useMemo, useState } from "react";

import { catOf, loadClimo, loadSeason } from "../../lib/tropical/data";
import { NORMAL, SEASON_DAYS, climoBasin, dayOfSeason, normalCurve, yearTable } from "../../lib/tropical/climo";
import { useTropicalStore } from "../../store/useTropicalStore";
import { TimeStack, type ChartPanel } from "../space/TimeStack";
import { Card, Loading, Seg, useSwpc } from "../space/common";
import { CatBadge } from "./common";
import { SEASON_BASINS } from "./SeasonTab";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SH_MONTHS = ["Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun"];

type Since = 1851 | 1950 | 1991;

export function ClimoTab() {
  const basin = useTropicalStore((s) => s.seasonBasin);
  const set = useTropicalStore((s) => s.set);
  const openTab = useTropicalStore((s) => s.openTab);
  const openSeason = (year: number) => {
    set({ seasonYear: year });
    openTab("season");
  };
  const climo = useSwpc("trp-climo", loadClimo, 86400);
  const b = climo.data?.basins[climoBasin(basin)];
  const [since, setSince] = useState<Since>(1950);
  const thisYear = new Date().getUTCFullYear() + (basin === "sh" && new Date().getUTCMonth() >= 6 ? 1 : 0);
  const live = useSwpc(`trp-season-${basin}-${thisYear}`, () => loadSeason(basin, thisYear), 600);

  const stats = useMemo(() => {
    if (!b) return null;
    const day = dayOfSeason(thisYear, b.south);
    const rows = yearTable(b, day).filter((r) => r.year >= Math.max(since, b.first));
    const normal = normalCurve(b);
    const named = b.storms.filter((s) => s[2] >= Math.max(since, b.first));
    const months = new Array(12).fill(0);
    for (const s of named) {
      const m = new Date(s[3]).getUTCMonth();
      months[b.south ? (m + 6) % 12 : m]++;
    }
    const top = (k: 5 | 6 | 7, asc = false) =>
      [...named].filter((s) => s[k] != null && (s[k] as number) > 0).sort((a, z) => (asc ? (a[k] as number) - (z[k] as number) : (z[k] as number) - (a[k] as number))).slice(0, 12);
    return { day, rows, normal, months, strongest: top(5), deepest: top(6, true), mostAce: top(7), named };
  }, [b, since, thisYear]);

  const panels = useMemo<ChartPanel[]>(() => {
    if (!stats || !b) return [];
    const rows = stats.rows;
    const t = Float64Array.from(rows.map((r) => Date.UTC(r.year, 0, 1)));
    const liveT = Date.UTC(thisYear, 0, 1);
    const normalTotal = stats.normal[SEASON_DAYS - 1];
    return [
      {
        id: "ace",
        title: "ACE each season",
        units: "ACE",
        include: [0],
        weight: 1.6,
        lines: [{ y: normalTotal, color: "rgba(200,200,200,0.7)", label: "Norm" }],
        series: [
          { label: "Season", color: "#ffc140", kind: "bars", barMs: 300 * 86_400_000, data: { t, v: Float64Array.from(rows.map((r) => r.total)) }, fmt: (v) => v.toFixed(1) },
          ...(live.data ? [{ label: `${thisYear} so far`, color: "#ff6b5e", kind: "bars" as const, barMs: 300 * 86_400_000, data: { t: Float64Array.of(liveT), v: Float64Array.of(live.data.ace) }, fmt: (v: number) => v.toFixed(1) }] : []),
        ],
      },
      {
        id: "count",
        title: "Storms each season",
        units: "n",
        include: [0],
        series: [
          { label: "Named", color: "#00faf4", data: { t, v: Float64Array.from(rows.map((r) => r.named)) }, kind: "step", fmt: (v) => String(Math.round(v)) },
          { label: basin === "wp" ? "Typhoons" : "Hurricanes", color: "#ffc140", data: { t, v: Float64Array.from(rows.map((r) => r.hurr)) }, kind: "step", fmt: (v) => String(Math.round(v)) },
          { label: "Major", color: "#ff6060", data: { t, v: Float64Array.from(rows.map((r) => r.major)) }, kind: "step", fmt: (v) => String(Math.round(v)) },
        ],
      },
    ];
  }, [stats, b, live.data, thisYear, basin]);

  if (!climo.data) return <Loading error={climo.error} what="the record" />;
  if (!b || !stats) return <div className="spc-msg">No record for this basin.</div>;
  const domain: [number, number] = [Date.UTC(Math.max(since, b.first) - 1, 6, 1), Date.UTC(thisYear + 1, 6, 1)];
  const ranked = [...stats.rows].sort((a, z) => z.total - a.total);
  const ytdRanked = [...stats.rows].sort((a, z) => z.ytd - a.ytd);
  const maxMonth = Math.max(...stats.months, 1);
  const name = (s: (typeof stats.named)[number]) => `${s[1] || "Unnamed"} ${s[2]}`;
  return (
    <div className="spc-grid spc-grid--overview">
      <div className="spc-col spc-col--main">
        <Card
          className="spc-card--fill trp-card--climo"
          title="The record"
          extra={
            <div className="spc-card__tools">
              <select className="trp-select" value={basin} onChange={(e) => set({ seasonBasin: e.target.value })}>
                {SEASON_BASINS.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </select>
              <Seg value={since} onChange={setSince} options={[{ id: 1851 as Since, label: "All" }, { id: 1950 as Since, label: "Since 1950" }, { id: 1991 as Since, label: "Since 1991" }]} />
            </div>
          }
        >
          <TimeStack panels={panels} domain={domain} now={false} />
          <p className="spc-note">
            IBTrACS v04r01 with the US agencies' one-minute winds; ACE sums v²/10⁴ over six-hourly fixes at 34 kt or more. Normal is {NORMAL[0]}-{NORMAL[1]}:{" "}
            {stats.normal[SEASON_DAYS - 1].toFixed(1)} a season. Early decades miss storms that never came near ships or land.
          </p>
        </Card>
        <Card title="Storms forming each month">
          <div className="trp-months">
            {stats.months.map((n, i) => (
              <div key={i} title={`${n} storms`}>
                <i style={{ height: `${(n / maxMonth) * 100}%` }} />
                <b>{n}</b>
                <span>{(b.south ? SH_MONTHS : MONTHS)[i]}</span>
              </div>
            ))}
          </div>
        </Card>
        <div className="trp-records">
          {(
            [
              ["Strongest", stats.strongest, (s: (typeof stats.named)[number]) => `${Math.round(s[5])} kt`],
              ["Lowest pressure", stats.deepest, (s: (typeof stats.named)[number]) => `${Math.round(s[6] as number)} mb`],
              ["Most ACE", stats.mostAce, (s: (typeof stats.named)[number]) => s[7].toFixed(1)],
            ] as const
          ).map(([title, list, val]) => (
            <Card key={title} title={title}>
              <ol className="trp-rank trp-rank--click">
                {list.map((s) => (
                  <li key={s[0]} onClick={() => openTab("storm", s[0])} title="Open its page">
                    <CatBadge cat={catOf(s[5])} />
                    <span>{name(s)}</span>
                    <b>{val(s)}</b>
                  </li>
                ))}
              </ol>
            </Card>
          ))}
        </div>
      </div>
      <div className="spc-col spc-col--side">
        <Card title="Most active seasons" extra={<span className="spc-card__meta">by ACE</span>}>
          <ol className="trp-rank trp-rank--click">
            {ranked.slice(0, 15).map((r) => (
              <li key={r.year} onClick={() => openSeason(r.year)} title="Open this season">
                <span>{basin === "sh" ? `${r.year - 1}-${String(r.year).slice(2)}` : r.year}</span>
                <small>
                  {r.named}/{r.hurr}/{r.major}
                </small>
                <b>{r.total.toFixed(1)}</b>
              </li>
            ))}
          </ol>
        </Card>
        <Card title="To this date of the season" extra={<span className="spc-card__meta">ACE so far, day {stats.day + 1}</span>}>
          <ol className="trp-rank trp-rank--click">
            {live.data && (
              <li className="is-hot" onClick={() => openSeason(thisYear)}>
                <span>{thisYear}</span>
                <small>this season</small>
                <b>{live.data.ace.toFixed(1)}</b>
              </li>
            )}
            {ytdRanked.slice(0, 12).map((r) => (
              <li key={r.year} onClick={() => openSeason(r.year)} title="Open this season">
                <span>{r.year}</span>
                <small>
                  final {r.total.toFixed(0)}
                </small>
                <b>{r.ytd.toFixed(1)}</b>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </div>
  );
}
