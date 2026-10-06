import { useMemo } from "react";
import { Map as MapIcon } from "lucide-react";

import { CAT_COLORS, basinLabel, catOf, loadClimo, loadSeason, type Season, type SeasonStorm } from "../../lib/tropical/data";
import { DAY, NORMAL, SEASON_DAYS, climoBasin, cumulative, dayOfSeason, liveDaily, normalCurve, seasonStart, standing, yearTable } from "../../lib/tropical/climo";
import { useTropicalStore } from "../../store/useTropicalStore";
import { TimeStack, fmtUtc, type ChartPanel, type ChartSeries } from "../space/TimeStack";
import { Card, Loading, useSwpc } from "../space/common";
import { CatBadge } from "./common";
import { SEASON_LAYER, fitTo, showOnMap } from "./mapActions";

export const SEASON_BASINS = [
  { id: "al", label: "Atlantic" },
  { id: "ep", label: "East & Central Pacific" },
  { id: "wp", label: "West Pacific" },
  { id: "io", label: "North Indian" },
  { id: "sh", label: "Southern Hemisphere" },
];

export function BasinYear({ years }: { years: number[] }) {
  const basin = useTropicalStore((s) => s.seasonBasin);
  const year = useTropicalStore((s) => s.seasonYear);
  const set = useTropicalStore((s) => s.set);
  return (
    <div className="spc-card__tools">
      <select className="trp-select" value={basin} onChange={(e) => set({ seasonBasin: e.target.value })}>
        {SEASON_BASINS.map((b) => (
          <option key={b.id} value={b.id}>
            {b.label}
          </option>
        ))}
      </select>
      <select className="trp-select" value={year} onChange={(e) => set({ seasonYear: Number(e.target.value) })}>
        {years.map((y) => (
          <option key={y} value={y}>
            {basin === "sh" ? `${y - 1}-${String(y).slice(2)}` : y}
          </option>
        ))}
      </select>
    </div>
  );
}

const fromDays = (start: number, c: Float64Array, upto = SEASON_DAYS) => ({
  t: Float64Array.from({ length: upto }, (_, d) => start + d * DAY),
  v: c.subarray(0, upto),
});

function StormsTable({ storms, live }: { storms: SeasonStorm[]; live: boolean }) {
  const open = useTropicalStore((s) => s.openTab);
  const day = (t: number) => new Date(t).toISOString().slice(5, 10);
  return (
    <div className="trp-scrollx">
      <table className="spc-table">
        <thead>
          <tr>
            <th>Storm</th>
            <th>Dates</th>
            <th>Peak</th>
            <th>Min</th>
            <th>ACE</th>
            <th title="Landfalls in HURDAT2">Landfalls</th>
          </tr>
        </thead>
        <tbody>
          {storms.map((s) => (
            <tr key={s.id || s.name + s.start} className={s.id ? "is-click" : ""} onClick={() => s.id && open("storm", s.id)} title={s.id ? "Open its page" : undefined}>
              <td>
                <CatBadge cat={s.cat ?? catOf(s.peak)} /> <b>{s.name}</b> {live && Date.now() - s.end < 30 * 3600_000 && <small className="trp-live">active</small>}
              </td>
              <td className="mono">
                {day(s.start)} to {day(s.end)}
              </td>
              <td className="mono">{Math.round(s.peak)} kt</td>
              <td className="mono">{s.minp ? `${Math.round(s.minp)} mb` : "--"}</td>
              <td className="mono">{s.ace.toFixed(1)}</td>
              <td className="mono">{s.landfalls || "--"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SeasonTab() {
  // "all" is a map-only choice (every basin's tracks); the charts need one.
  const raw = useTropicalStore((s) => s.seasonBasin);
  const basin = raw === "all" ? "al" : raw;
  const year = useTropicalStore((s) => s.seasonYear);
  const climo = useSwpc("trp-climo", loadClimo, 86400);
  const live = year >= new Date().getUTCFullYear();
  const season = useSwpc(`trp-season-${basin}-${year}`, () => loadSeason(basin, year), live ? 600 : 86400);
  const b = climo.data?.basins[climoBasin(basin)];
  const now = new Date().getUTCFullYear() + (basin === "sh" && new Date().getUTCMonth() >= 6 ? 1 : 0);
  const years = useMemo(() => {
    const first = b?.first ?? 1950;
    const out: number[] = [];
    for (let y = now; y >= Math.max(first, 1842); y--) out.push(y);
    return out;
  }, [b, now]);

  // Past seasons with no decks (before 2011, outside HURDAT2's basins) still
  // have the record's storm list.
  const storms: SeasonStorm[] = useMemo(() => {
    if (season.data?.storms.length) return season.data.storms.filter((s) => s.peak >= 34 || s.ace > 0);
    if (!b) return [];
    return b.storms
      .filter((s) => s[2] === year)
      .map((s) => ({ id: s[0], name: s[1] || "Unnamed", start: s[3], end: s[4], peak: s[5], minp: s[6], cat: catOf(s[5]), ace: s[7], landfalls: 0 }));
  }, [season.data, b, year]);

  const st = useMemo(() => (climo.data && season.data && live ? standing(climo.data, basin, season.data) : null), [climo.data, season.data, basin, live]);

  const chart = useMemo(() => {
    if (!b) return null;
    const start = seasonStart(year, b.south);
    const normal = normalCurve(b);
    const daily: [number, number][] = season.data?.storms.length ? liveDaily(season.data as Season, b.south) : b.years[String(year)]?.daily ?? [];
    const mine = cumulative(daily);
    const upto = live ? dayOfSeason(year, b.south) + 1 : SEASON_DAYS;
    const rows = yearTable(b, SEASON_DAYS - 1).filter((r) => r.year >= 1950 && r.year !== year);
    const rec = rows.reduce((a, r) => (r.total > a.total ? r : a), rows[0]);
    const quiet = rows.reduce((a, r) => (r.total < a.total ? r : a), rows[0]);
    const prev = b.years[String(year - 1)];
    const series: ChartSeries[] = [
      { label: `${year}`, color: "#ff6b5e", data: fromDays(start, mine, upto), width: 2.6 },
      { label: `Normal ${NORMAL[0]}-${NORMAL[1]}`, color: "var(--sx-wind)", data: fromDays(start, normal), dash: [6, 3], width: 1.6 },
      ...(rec ? [{ label: `Most: ${rec.year}`, color: "#ffc140", data: fromDays(start, cumulative(b.years[String(rec.year)].daily)), width: 1.2 }] : []),
      ...(quiet ? [{ label: `Least: ${quiet.year}`, color: "#5ebaff", data: fromDays(start, cumulative(b.years[String(quiet.year)].daily)), width: 1.2 }] : []),
      ...(prev ? [{ label: `${year - 1}`, color: "#a879ff", data: fromDays(start, cumulative(prev.daily)), width: 1.1, off: true }] : []),
    ];
    const bars = daily.map(([d, a]) => ({ t: start + d * DAY, v: a })).sort((x, y) => x.t - y.t);
    // Where the season ranked, day by day, among every season since 1950.
    const others = yearTable(b, 0)
      .filter((r) => r.year >= 1950 && r.year !== year)
      .map((r) => cumulative(b.years[String(r.year)].daily));
    const rankT: number[] = [];
    const rankV: number[] = [];
    for (let d = 0; d < upto; d += 1) {
      if (mine[d] <= 0) continue;
      let r = 1;
      for (const c of others) if (c[d] > mine[d]) r++;
      rankT.push(start + d * DAY);
      rankV.push(r);
    }
    const panels: ChartPanel[] = [
      { id: "cum", title: "Cumulative ACE", units: "ACE", include: [0], weight: 2, series, fmt: (v) => v.toFixed(1) },
      {
        id: "rank",
        title: `Rank to date among ${others.length + 1} seasons since 1950`,
        units: "rank",
        invert: true,
        y: [1, others.length + 1],
        series: [{ label: "Rank", color: "#ff6b5e", kind: "step", data: { t: Float64Array.from(rankT), v: Float64Array.from(rankV) }, width: 1.8, fmt: (v) => `#${Math.round(v)}` }],
        fmt: (v) => `#${Math.round(v)}`,
      },
      {
        id: "daily",
        title: "ACE each day",
        units: "ACE",
        include: [0],
        series: [{ label: "Daily ACE", color: "#ff6b5e", kind: "bars", barMs: DAY, data: { t: Float64Array.from(bars.map((x) => x.t)), v: Float64Array.from(bars.map((x) => x.v)) }, fmt: (v) => v.toFixed(2) }],
      },
    ];
    return { panels, domain: [start, start + (SEASON_DAYS - 1) * DAY] as [number, number] };
  }, [b, season.data, year, live]);

  const ace = season.data?.storms.length ? season.data.ace : b?.years[String(year)]?.ace ?? null;
  const named = storms.filter((s) => s.peak >= 34).length;
  const hurr = storms.filter((s) => s.peak >= 64).length;
  const major = storms.filter((s) => s.peak >= 96).length;
  const hasTracks = !!season.data?.storms.some((s) => s.points?.length);

  return (
    <div className="spc-grid spc-grid--overview">
      <div className="spc-col spc-col--main">
        <Card className="spc-card--fill trp-card--season" title={`${basinLabel(basin === "ep" ? "ep" : basin)} season ${basin === "sh" ? `${year - 1}-${String(year).slice(2)}` : year}`} extra={<BasinYear years={years} />}>
          <div className="trp-kpis">
            <div>
              <span>ACE</span>
              <b>{ace != null ? ace.toFixed(1) : "--"}</b>
            </div>
            {st && (
              <div>
                <span>Of normal to date</span>
                <b>{st.pct != null ? `${Math.round(st.pct)}%` : "--"}</b>
              </div>
            )}
            {st && (
              <div>
                <span>Rank to date</span>
                <b>
                  {st.rank}
                  <small> of {st.of}</small>
                </b>
              </div>
            )}
            <div>
              <span>Named</span>
              <b>{named}</b>
            </div>
            <div>
              <span>{basin === "wp" ? "Typhoons" : basin === "al" || basin === "ep" ? "Hurricanes" : "Severe"}</span>
              <b>{hurr}</b>
            </div>
            <div>
              <span>Major</span>
              <b>{major}</b>
            </div>
          </div>
          {chart ? <TimeStack panels={chart.panels} domain={chart.domain} now={live} /> : <Loading error={climo.error} what="the record" />}
        </Card>
      </div>
      <div className="spc-col spc-col--side">
        <Card
          title={`Storms (${storms.length})`}
          extra={
            hasTracks && (
              <button
                type="button"
                className="spc-mapbtn"
                onClick={() =>
                  showOnMap(SEASON_LAYER, () => fitTo((season.data?.storms ?? []).flatMap((s) => (s.points ?? []).map((p) => [p[2], p[1]] as [number, number])), 5))
                }
              >
                <MapIcon size={13} /> Tracks on the map
              </button>
            )
          }
          className="spc-card--list"
        >
          {!season.data && !storms.length ? <Loading error={season.error} what="the season" /> : <StormsTable storms={storms} live={live} />}
          <p className="spc-note">
            {season.data?.storms.length
              ? `Best tracks from ${season.data.source === "IBTrACS" ? "IBTrACS" : season.data.source === "HURDAT2" ? "NHC's HURDAT2" : "the ATCF decks (NHC, JTWC via UCAR)"}; click a storm for its intensity and track.`
              : "From the IBTrACS record; click a storm for its intensity and track."}{" "}
            Updated {season.data?.live ? fmtUtc(Date.now()) : "at the season's end"}.
          </p>
        </Card>
        <Card title="Category colours">
          <div className="trp-catkey">
            {(Object.keys(CAT_COLORS) as (keyof typeof CAT_COLORS)[]).map((c) => (
              <span key={c}>
                <CatBadge cat={c} />
              </span>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
