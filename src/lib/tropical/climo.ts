/**
 * Season arithmetic over the IBTrACS record (public/data/tropical-climo.json)
 * and the live season: cumulative ACE by day, the 1991-2020 normal to date,
 * where a season ranks.
 */
import type { BasinClimo, Climo, Season } from "./data";

export const NORMAL = [1991, 2020] as const;

/** The app's basins in the record: the Central Pacific is part of the East Pacific's. */
export const climoBasin = (b: string) => (b === "cp" ? "ep" : b);

/** Day 0 of a season: 1 January, or 1 July of the year before in the south. */
export function seasonStart(year: number, south: boolean): number {
  return south ? Date.UTC(year - 1, 6, 1) : Date.UTC(year, 0, 1);
}

export const DAY = 86_400_000;
export const SEASON_DAYS = 366;

/** Cumulative ACE for each day of a season, from its sparse daily list. */
export function cumulative(daily: [number, number][], days = SEASON_DAYS): Float64Array {
  const out = new Float64Array(days);
  let acc = 0;
  let i = 0;
  const sorted = [...daily].sort((a, b) => a[0] - b[0]);
  for (let d = 0; d < days; d++) {
    while (i < sorted.length && sorted[i][0] <= d) acc += sorted[i++][1];
    out[d] = acc;
  }
  return out;
}

/** The live season's daily ACE, keyed by day of season. */
export function liveDaily(season: Season, south: boolean): [number, number][] {
  const start = seasonStart(season.year, south);
  return season.daily.map(([d, a]) => [Math.round((Date.parse(`${d}T00:00:00Z`) - start) / DAY), a]);
}

/** The 1991-2020 mean of cumulative ACE, day by day. */
export function normalCurve(b: BasinClimo): Float64Array {
  const out = new Float64Array(SEASON_DAYS);
  let n = 0;
  for (let y = NORMAL[0]; y <= NORMAL[1]; y++) {
    const yr = b.years[String(y)];
    if (!yr) continue;
    const c = cumulative(yr.daily);
    for (let d = 0; d < SEASON_DAYS; d++) out[d] += c[d];
    n++;
  }
  if (n) for (let d = 0; d < SEASON_DAYS; d++) out[d] /= n;
  return out;
}

/** Today's day of the season (or the last day, for a finished one). */
export function dayOfSeason(year: number, south: boolean, now = Date.now()): number {
  const d = Math.floor((now - seasonStart(year, south)) / DAY);
  return Math.max(0, Math.min(SEASON_DAYS - 1, d));
}

export interface YearRow {
  year: number;
  ytd: number;
  total: number;
  named: number;
  hurr: number;
  major: number;
}

/** Every season in the record with its ACE to this day of the season and in all. */
export function yearTable(b: BasinClimo, day: number): YearRow[] {
  return Object.entries(b.years).map(([y, v]) => ({
    year: Number(y),
    ytd: cumulative(v.daily)[day],
    total: v.ace,
    named: v.named,
    hurr: v.hurr,
    major: v.major,
  }));
}

/** Where a value falls among others, 1 = highest. */
export function rankOf(value: number, others: number[]): number {
  return others.filter((v) => v > value).length + 1;
}

export interface SeasonStanding {
  ace: number;
  normalYtd: number;
  normalTotal: number;
  pct: number | null;
  rank: number;
  of: number;
  record: YearRow | null;
  quietest: YearRow | null;
}

/** How the live season stands against the record, to the same day. */
export function standing(climo: Climo, basin: string, season: Season): SeasonStanding | null {
  const b = climo.basins[climoBasin(basin)];
  if (!b) return null;
  const day = dayOfSeason(season.year, b.south);
  const normal = normalCurve(b);
  // From 1950: earlier seasons are missing too many storms to rank against.
  const rows = yearTable(b, day).filter((r) => r.year >= 1950 && r.year !== season.year);
  const ytds = rows.map((r) => r.ytd);
  const sorted = [...rows].sort((a, z) => z.ytd - a.ytd);
  return {
    ace: season.ace,
    normalYtd: normal[day],
    normalTotal: normal[SEASON_DAYS - 1],
    pct: normal[day] > 0.5 ? (season.ace / normal[day]) * 100 : null,
    rank: rankOf(season.ace, ytds),
    of: rows.length + 1,
    record: sorted[0] ?? null,
    quietest: sorted[sorted.length - 1] ?? null,
  };
}
