import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  bestEnd,
  densityAltitude,
  fmtFt,
  fmtVis,
  fmtWind,
  hpaToInHg,
  windComponents,
  type AloftProfile,
  type AvnMetar,
  type AvnTaf,
  type Runway,
  type TafState,
  type TafTemporary,
} from "../../lib/aviation";
import { CATEGORY_COLOR, describeWx, type FlightCategory } from "../../lib/metar";

/**
 * The airport's weather on one time axis: what was observed (the METARs, left
 * of the now line) and what is forecast (the TAF, right of it), panel under
 * panel, with one crosshair that reads both.
 *
 * Hand-drawn SVG like the station meteograms, for the same reasons: shared
 * axis, shared crosshair, the app's own tokens.
 */

const PAD_L = 50;
const PAD_R = 46;
const PAD_T = 14;
const PAD_B = 6;
const COVER_FILL: Record<string, number> = { FEW: 0.45, SCT: 0.62, BKN: 0.82, OVC: 1, OVX: 1, VV: 1 };
const CLOUD_TOP = 12000;
const OBS = "var(--text)";
const FCST = "var(--accent)";
const MODEL = "var(--text-faint)";

const catColor = (c: FlightCategory | null | undefined) => (c ? CATEGORY_COLOR[c] : "var(--border-strong)");

function useWidth<T extends HTMLElement>(ref: React.RefObject<T | null>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function niceScale(lo: number, hi: number, want = 4) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1, step: 1 };
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const raw = (hi - lo) / want;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
}

/** Visibility drawn so the low end has room: 0-1-3-5-10 SM evenly spaced. */
const VIS_KNOTS = [0, 1, 3, 5, 10];
function visFrac(v: number): number {
  const x = Math.min(Math.max(v, 0), 10);
  for (let i = 1; i < VIS_KNOTS.length; i++) {
    if (x <= VIS_KNOTS[i]) {
      const a = VIS_KNOTS[i - 1];
      const b = VIS_KNOTS[i];
      return (i - 1 + (x - a) / (b - a)) / (VIS_KNOTS.length - 1);
    }
  }
  return 1;
}

/** Cloud heights on a square-root axis: 500 ft and 1000 ft apart near the
 *  ground, where they decide the category, and still 12,000 ft on top. */
const cloudFrac = (ft: number) => Math.sqrt(Math.min(Math.max(ft, 0), CLOUD_TOP) / CLOUD_TOP);

function timeTicks(t0: number, t1: number, utc: boolean): number[] {
  const span = (t1 - t0) / 3600;
  const every = span <= 18 ? 2 : span <= 36 ? 3 : span <= 72 ? 6 : span <= 170 ? 12 : 24;
  const out: number[] = [];
  const d = new Date(t0 * 1000);
  d.setUTCMinutes(0, 0, 0);
  const hourOf = (x: Date) => (utc ? x.getUTCHours() : x.getHours());
  while (hourOf(d) % every !== 0) d.setTime(d.getTime() + 3600_000);
  for (let t = d.getTime() / 1000; t <= t1; t += every * 3600) if (t >= t0) out.push(t);
  return out;
}

export interface ChartUnits {
  temp: "C" | "F";
  pres: "inHg" | "hPa";
}

interface Props {
  metars: AvnMetar[];
  taf: AvnTaf | null;
  runways: Runway[];
  elevFt: number | null;
  hours: number;
  utc: boolean;
  units: ChartUnits;
  /** The model's surface forecast, drawn faintly past the now line: what an
   *  airport without a TAF has, and a second opinion where there is one. */
  profile?: AloftProfile | null;
}

interface Scale {
  x: (t: number) => number;
  t0: number;
  t1: number;
  now: number;
  w: number;
}

export function AirportChart({ metars, taf, runways, elevFt, hours, utc, units, profile }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useWidth(wrapRef);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const now = Math.floor(Date.now() / 1000);

  const t0 = now - hours * 3600;
  // To the TAF's end; a day ahead on the model where there is no TAF.
  const t1 = Math.max(now + 1800, taf?.to ?? (profile ? now + 24 * 3600 : now + 1800));
  const scale: Scale = useMemo(() => {
    const span = Math.max(t1 - t0, 1);
    const inner = Math.max(width - PAD_L - PAD_R, 1);
    return { x: (t: number) => PAD_L + ((t - t0) / span) * inner, t0, t1, now, w: width };
  }, [t0, t1, now, width]);

  const obs = useMemo(() => metars.filter((m) => m.t >= t0 - 3600), [metars, t0]);
  /** One model surface series from now to the chart's end. */
  const model = useCallback(
    (key: string, f: (v: number) => number = (v) => v): [number, number | null][] => {
      if (!profile) return [];
      const vals = profile.surface[key] ?? [];
      const out: [number, number | null][] = [];
      profile.times.forEach((t, k) => {
        if (t < now - 1800 || t > t1) return;
        const v = vals[k];
        out.push([t, v == null ? null : f(v)]);
      });
      return out;
    },
    [profile, now, t1],
  );
  const segs = taf?.segments ?? [];
  const temps = taf?.temporary ?? [];

  const onMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (width <= 0) return;
      const box = e.currentTarget.getBoundingClientRect();
      const frac = (e.clientX - box.left - PAD_L) / Math.max(width - PAD_L - PAD_R, 1);
      if (frac < 0 || frac > 1) {
        setHoverT(null);
        return;
      }
      setHoverT(t0 + frac * (t1 - t0));
    },
    [width, t0, t1],
  );

  const toTemp = (c: number) => (units.temp === "F" ? (c * 9) / 5 + 32 : c);
  const toPres = (hpa: number) => (units.pres === "inHg" ? hpaToInHg(hpa) : hpa);

  // The observation and the forecast under the crosshair.
  const hoverObs = hoverT == null || hoverT > now + 900 ? null : nearest(obs, hoverT);
  const hoverSeg = hoverT == null ? null : (segs.find((s) => s.from <= hoverT && hoverT < s.to) ?? null);
  const hoverTemps = hoverT == null ? [] : temps.filter((s) => s.from <= hoverT && hoverT < s.to);

  const clock = (t: number) =>
    utc
      ? `${new Date(t * 1000).toISOString().slice(11, 16)}Z`
      : new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = (t: number) =>
    new Date(t * 1000).toLocaleDateString([], { weekday: "short", day: "numeric", ...(utc ? { timeZone: "UTC" } : {}) });

  if (!obs.length && !segs.length) return <div className="stn__loading">No METARs or TAF in this window.</div>;

  const ticks = timeTicks(t0, t1, utc);
  const hx = hoverT != null ? scale.x(hoverT) : 0;
  const tipRight = hoverT != null && hx > width * 0.58;

  // Crosswind on whichever runway end faces most into each wind.
  const xwind = (wdir: unknown, spd: number | null) => {
    const d = typeof wdir === "number" ? wdir : Number(wdir);
    if (!runways.length || spd == null || !Number.isFinite(d)) return null;
    const end = bestEnd(runways, d, spd);
    return end ? Math.abs(windComponents(d, spd, end.true).cross) : null;
  };

  const common = { scale, ticks, hoverT, utc, last: false };

  return (
    <div className="aptc" ref={wrapRef} onPointerMove={onMove} onPointerLeave={() => setHoverT(null)}>
      {width > 0 && (
        <>
          <CategoryPanel {...common} obs={obs} segs={segs} temps={temps} />
          <CloudPanel {...common} obs={obs} segs={segs} temps={temps} />
          <VisPanel {...common} obs={obs} segs={segs} temps={temps} model={profile ? model("visibility", (m) => m / 1609.344) : []}
            modelLabel={profile?.modelLabel} />
          <LinePanel
            {...common}
            title="Wind (kt)"
            height={128}
            zero
            series={[
              { label: "Wind", color: OBS, pts: obs.map((m) => [m.t, m.wspd]) },
              { label: "Gust", color: "#f59e0b", dots: true, pts: obs.map((m) => [m.t, m.wgst]) },
              { label: "Forecast wind", color: FCST, dashed: true, steps: segs.map((s) => [s.from, s.to, s.wspd]) },
              { label: "Forecast gust", color: "#f59e0b", dashed: true, steps: segs.map((s) => [s.from, s.to, s.wgst]) },
              ...(profile
                ? [
                    { label: `${profile.modelLabel} wind`, color: MODEL, dashed: true, pts: model("wind_speed_10m") },
                    { label: `${profile.modelLabel} gust`, color: "rgba(245,158,11,0.5)", dashed: true, pts: model("wind_gusts_10m") },
                  ]
                : []),
              ...(runways.length
                ? [{ label: "Crosswind, best runway", color: "#ec4899", pts: obs.map((m) => [m.t, xwind(m.wdir, m.wspd)]) as [number, number | null][] }]
                : []),
            ]}
            arrows={[
              ...obs.map((m) => ({ t: m.t, dir: m.wdir, spd: m.wspd, fc: false })),
              ...segs.map((s) => ({ t: (s.from + s.to) / 2, dir: s.wdir, spd: s.wspd, fc: true })),
            ]}
          />
          <LinePanel
            {...common}
            title={`Temperature & dew point (°${units.temp})`}
            height={112}
            spreadFill
            series={[
              { label: "Temperature", color: "#ef4444", pts: obs.map((m) => [m.t, m.temp == null ? null : toTemp(m.temp)]) },
              { label: "Dew point", color: "#22c55e", pts: obs.map((m) => [m.t, m.dewp == null ? null : toTemp(m.dewp)]) },
              ...(profile
                ? [
                    { label: `${profile.modelLabel} temp`, color: "rgba(239,68,68,0.5)", dashed: true, pts: model("temperature_2m", toTemp) },
                    { label: `${profile.modelLabel} dew`, color: "rgba(34,197,94,0.5)", dashed: true, pts: model("dew_point_2m", toTemp) },
                  ]
                : []),
              ...(taf?.temps?.length
                ? [{ label: "TAF max / min", color: "#f472b6", dots: true, pts: taf.temps.map((x) => [x.t, x.temp == null ? null : toTemp(x.temp)]) as [number, number | null][] }]
                : []),
            ]}
          />
          <LinePanel
            {...common}
            title={units.pres === "inHg" ? "Altimeter (inHg)" : "QNH (hPa)"}
            height={92}
            dec={units.pres === "inHg" ? 2 : 0}
            series={[
              { label: "Altimeter", color: "#38bdf8", pts: obs.map((m) => [m.t, m.altim == null ? null : toPres(m.altim)]) },
              ...(segs.some((x) => x.altim != null)
                ? [{ label: "TAF QNH", color: FCST, dashed: true, steps: segs.map((x) => [x.from, x.to, x.altim == null ? null : toPres(x.altim)]) as [number, number, number | null][] }]
                : []),
              ...(profile ? [{ label: `${profile.modelLabel} sea-level pressure`, color: MODEL, dashed: true, pts: model("pressure_msl", toPres) }] : []),
            ]}
          />
          {elevFt != null && (
            <LinePanel
              {...common}
              title="Density altitude (ft)"
              height={92}
              series={[
                {
                  label: "Density altitude",
                  color: "#a78bfa",
                  pts: obs.map((m) => [m.t, m.altim != null && m.temp != null ? densityAltitude(elevFt, m.altim, m.temp) : null]),
                },
                { label: "Field elevation", color: "var(--text-faint)", dashed: true, pts: [[t0, elevFt], [t1, elevFt]] },
              ]}
            />
          )}
          <WxPanel {...common} last obs={obs} segs={segs} temps={temps} clock={clock} day={day} />

          {hoverT != null && (
            <div
              className={`aptc__tip${tipRight ? " is-right" : ""}`}
              style={{ left: tipRight ? undefined : hx + 12, right: tipRight ? width - hx + 12 : undefined }}
            >
              <b>{clock(hoverT)}</b>
              <span>{day(hoverT)}</span>
              {hoverObs && (
                <div className="aptc__tipsec">
                  <em>METAR {clock(hoverObs.t)}</em>
                  <TipRows m={hoverObs} toTemp={toTemp} toPres={toPres} units={units} xwind={xwind(hoverObs.wdir, hoverObs.wspd)} />
                </div>
              )}
              {hoverSeg && (
                <div className="aptc__tipsec">
                  <em>TAF</em>
                  <StateRows s={hoverSeg} />
                </div>
              )}
              {hoverTemps.map((p, i) => (
                <div key={`${i}-${p.kind}-${p.from}`} className="aptc__tipsec">
                  <em>
                    {p.kind} {clock(p.from)}–{clock(p.to)}
                  </em>
                  <StateRows s={p} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function nearest(rows: AvnMetar[], t: number): AvnMetar | null {
  let best: AvnMetar | null = null;
  let d = Infinity;
  for (const r of rows) {
    const x = Math.abs(r.t - t);
    if (x < d) {
      d = x;
      best = r;
    }
  }
  return d <= 2 * 3600 ? best : null;
}

function cloudText(clouds: { cover: string; base: number | null; type?: string | null }[], vv?: number | null): string {
  const parts = clouds.map((c) => `${c.cover}${c.base != null ? String(Math.round(c.base / 100)).padStart(3, "0") : ""}${c.type ?? ""}`);
  if (vv != null) parts.push(`VV${String(Math.round(vv / 100)).padStart(3, "0")}`);
  return parts.join(" ") || "—";
}

function TipRows({
  m,
  toTemp,
  toPres,
  units,
  xwind,
}: {
  m: AvnMetar;
  toTemp: (c: number) => number;
  toPres: (h: number) => number;
  units: ChartUnits;
  xwind: number | null;
}) {
  return (
    <>
      <div className="aptc__tiprow">
        <i style={{ background: catColor(m.cat) }} />
        <span>Category</span>
        <b>{m.cat ?? "—"}</b>
      </div>
      <div className="aptc__tiprow">
        <span>Wind</span>
        <b>{fmtWind(m.wdir, m.wspd, m.wgst)}</b>
      </div>
      {xwind != null && (
        <div className="aptc__tiprow">
          <span>Crosswind</span>
          <b>{Math.round(xwind)} kt</b>
        </div>
      )}
      <div className="aptc__tiprow">
        <span>Visibility</span>
        <b>{fmtVis(m.vis, m.visRaw)}</b>
      </div>
      <div className="aptc__tiprow">
        <span>Ceiling</span>
        <b>{fmtFt(m.ceil)}</b>
      </div>
      <div className="aptc__tiprow">
        <span>Clouds</span>
        <b>{cloudText(m.clouds)}</b>
      </div>
      {m.temp != null && (
        <div className="aptc__tiprow">
          <span>Temp / dew</span>
          <b>
            {toTemp(m.temp).toFixed(0)}° / {m.dewp != null ? `${toTemp(m.dewp).toFixed(0)}°` : "—"}
          </b>
        </div>
      )}
      {m.altim != null && (
        <div className="aptc__tiprow">
          <span>Altimeter</span>
          <b>
            {toPres(m.altim).toFixed(units.pres === "inHg" ? 2 : 0)} {units.pres}
          </b>
        </div>
      )}
      {m.wx && (
        <div className="aptc__tiprow">
          <span>Weather</span>
          <b>{describeWx(m.wx).join(", ") || m.wx}</b>
        </div>
      )}
    </>
  );
}

function StateRows({ s }: { s: TafState }) {
  return (
    <>
      <div className="aptc__tiprow">
        <i style={{ background: catColor(s.cat) }} />
        <span>Category</span>
        <b>{s.cat ?? "—"}</b>
      </div>
      {s.wspd != null && (
        <div className="aptc__tiprow">
          <span>Wind</span>
          <b>{fmtWind(s.wdir, s.wspd, s.wgst)}</b>
        </div>
      )}
      {s.vis != null && (
        <div className="aptc__tiprow">
          <span>Visibility</span>
          <b>{fmtVis(s.vis, s.visRaw)}</b>
        </div>
      )}
      {(s.clouds?.length || s.vv != null) && (
        <div className="aptc__tiprow">
          <span>Clouds</span>
          <b>{cloudText(s.clouds ?? [], s.vv)}</b>
        </div>
      )}
      {s.wx && (
        <div className="aptc__tiprow">
          <span>Weather</span>
          <b>{describeWx(s.wx).join(", ") || s.wx}</b>
        </div>
      )}
      {s.shear?.hgt != null && (
        <div className="aptc__tiprow">
          <span>Wind shear</span>
          <b>
            {fmtFt(s.shear.hgt)} {fmtWind(s.shear.dir, s.shear.spd)}
          </b>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The frame every panel shares: title, grid, now line, crosshair, time labels
// ---------------------------------------------------------------------------
interface FrameProps {
  scale: Scale;
  ticks: number[];
  hoverT: number | null;
  utc: boolean;
  last: boolean;
}

function Frame({
  title,
  height,
  scale,
  ticks,
  hoverT,
  utc,
  children,
  yGrid,
  legend,
}: FrameProps & {
  title: string;
  height: number;
  children: ReactNode;
  yGrid?: { y: number; label: string; strong?: boolean; right?: string; color?: string }[];
  legend?: { label: string; color: string; dashed?: boolean }[];
}) {
  const plotB = height - PAD_B;
  const midnight = (t: number) => (utc ? new Date(t * 1000).getUTCHours() : new Date(t * 1000).getHours()) === 0;
  return (
    <div className="aptc__panel" style={{ height }}>
      <span className="aptc__title">{title}</span>
      {legend && (
        <span className="aptc__legend">
          {legend.map((l) => (
            <span key={l.label}>
              <i style={{ background: l.color, opacity: l.dashed ? 0.7 : 1 }} className={l.dashed ? "is-dashed" : undefined} />
              {l.label}
            </span>
          ))}
        </span>
      )}
      <svg width={scale.w} height={height}>
        {ticks.map((t) => (
          <line
            key={t}
            x1={scale.x(t)}
            x2={scale.x(t)}
            y1={PAD_T}
            y2={plotB}
            className={midnight(t) ? "aptc__grid aptc__grid--day" : "aptc__grid"}
          />
        ))}
        {yGrid?.map((g) => (
          <g key={`${g.label}-${g.y}`}>
            <line x1={PAD_L} x2={scale.w - PAD_R} y1={g.y} y2={g.y} className={g.strong ? "aptc__thresh" : "aptc__grid"}
              style={g.color ? { stroke: g.color } : undefined} />
            <text x={PAD_L - 6} y={g.y + 3} className="aptc__ylab">
              {g.label}
            </text>
            {g.right && (
              <text x={scale.w - PAD_R + 5} y={g.y + 3} className="aptc__rlab" style={g.color ? { fill: g.color } : undefined}>
                {g.right}
              </text>
            )}
          </g>
        ))}
        {/* The forecast side, faintly shaded so past and future read apart. */}
        <rect x={scale.x(scale.now)} y={PAD_T} width={Math.max(scale.w - PAD_R - scale.x(scale.now), 0)} height={plotB - PAD_T}
          className="aptc__future" />
        {children}
        <line x1={scale.x(scale.now)} x2={scale.x(scale.now)} y1={PAD_T - 4} y2={plotB} className="aptc__now" />
        {hoverT != null && <line x1={scale.x(hoverT)} x2={scale.x(hoverT)} y1={PAD_T} y2={plotB} className="aptc__cross" />}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flight category: observed, forecast, and the TEMPO/PROB groups
// ---------------------------------------------------------------------------
function CategoryPanel(props: FrameProps & { obs: AvnMetar[]; segs: TafState[]; temps: TafTemporary[] }) {
  const { scale, obs, segs, temps } = props;
  const rows = { obs: 18, taf: 34, tmp: 50 };
  const h = 13;
  const right = scale.w - PAD_R;
  return (
    <Frame {...props} title="Flight category" height={70}>
      <text x={PAD_L - 6} y={rows.obs + 9} className="aptc__ylab">METAR</text>
      <text x={PAD_L - 6} y={rows.taf + 9} className="aptc__ylab">TAF</text>
      <text x={PAD_L - 6} y={rows.tmp + 9} className="aptc__ylab">TEMPO</text>
      {obs.map((m, i) => {
        const x0 = Math.max(scale.x(m.t), PAD_L);
        const x1 = Math.min(i + 1 < obs.length ? scale.x(obs[i + 1].t) : scale.x(scale.now), right);
        if (x1 <= x0) return null;
        return <rect key={m.t} x={x0} y={rows.obs} width={x1 - x0} height={h} style={{ fill: catColor(m.cat) }} opacity={0.85} />;
      })}
      {segs.map((s) => {
        const x0 = Math.max(scale.x(s.from), PAD_L);
        const x1 = Math.min(scale.x(s.to), right);
        if (x1 <= x0) return null;
        return (
          <g key={s.from}>
            <rect x={x0} y={rows.taf} width={x1 - x0} height={h} style={{ fill: catColor(s.cat) }} opacity={0.7} />
            <line x1={x0} x2={x0} y1={rows.taf} y2={rows.taf + h} className="aptc__segedge" />
          </g>
        );
      })}
      {temps.map((p, i) => {
        const x0 = Math.max(scale.x(p.from), PAD_L);
        const x1 = Math.min(scale.x(p.to), right);
        if (x1 <= x0) return null;
        return (
          <g key={`${i}-${p.kind}-${p.from}`}>
            <rect x={x0} y={rows.tmp} width={x1 - x0} height={h} style={{ fill: catColor(p.cat), stroke: catColor(p.cat) }}
              className="aptc__tempo" />
            {x1 - x0 > 46 && (
              <text x={x0 + 4} y={rows.tmp + 10} className="aptc__seglab">
                {p.kind}
              </text>
            )}
          </g>
        );
      })}
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Clouds and ceiling
// ---------------------------------------------------------------------------
function CloudPanel(props: FrameProps & { obs: AvnMetar[]; segs: TafState[]; temps: TafTemporary[] }) {
  const { scale, obs, segs, temps } = props;
  const height = 168;
  const top = PAD_T;
  const bot = height - PAD_B;
  const y = (ft: number) => bot - cloudFrac(ft) * (bot - top);
  const right = scale.w - PAD_R;
  const grid = [
    { y: y(0), label: "0" },
    { y: y(500), label: "500", strong: true, right: "LIFR", color: CATEGORY_COLOR.LIFR },
    { y: y(1000), label: "1k", strong: true, right: "IFR", color: CATEGORY_COLOR.IFR },
    { y: y(3000), label: "3k", strong: true, right: "MVFR", color: CATEGORY_COLOR.MVFR },
    { y: y(6000), label: "6k" },
    { y: y(CLOUD_TOP), label: "12k+" },
  ];
  const band = (ft: number) => Math.max(5, Math.min(9, (bot - top) * 0.05 + (ft < 3000 ? 2 : 0)));
  const ceilPts: [number, number][] = obs.filter((m) => m.ceil != null).map((m) => [scale.x(m.t), y(m.ceil!)]);
  return (
    <Frame
      {...props}
      title="Clouds & ceiling (ft above ground)"
      height={height}
      yGrid={grid}
      legend={[
        { label: "Observed layers", color: "var(--text-dim)" },
        { label: "Ceiling", color: OBS },
        { label: "Forecast", color: FCST, dashed: true },
      ]}
    >
      {obs.map((m, i) => {
        const x0 = Math.max(scale.x(m.t), PAD_L);
        const x1 = Math.min(i + 1 < obs.length ? scale.x(obs[i + 1].t) : scale.x(scale.now), right);
        if (x1 <= x0) return null;
        return (
          <g key={m.t}>
            {m.clouds.map((c, k) =>
              c.base == null ? null : (
                <rect
                  key={k}
                  x={x0}
                  y={y(c.base) - band(c.base) / 2}
                  width={Math.max(x1 - x0 - 0.6, 0.6)}
                  height={band(c.base)}
                  className="aptc__cloud"
                  opacity={COVER_FILL[c.cover] ?? 0.4}
                />
              ),
            )}
          </g>
        );
      })}
      {segs.map((s) =>
        (s.clouds ?? []).map((c, k) => {
          if (c.base == null) return null;
          const x0 = Math.max(scale.x(s.from), PAD_L);
          const x1 = Math.min(scale.x(s.to), right);
          if (x1 <= x0) return null;
          return (
            <rect
              key={`${s.from}-${k}`}
              x={x0}
              y={y(c.base) - band(c.base) / 2}
              width={x1 - x0}
              height={band(c.base)}
              className="aptc__fcloud"
              opacity={0.25 + 0.6 * (COVER_FILL[c.cover] ?? 0.4)}
            />
          );
        }),
      )}
      {temps.map((p, i) =>
        (p.clouds ?? []).map((c, k) => {
          if (c.base == null) return null;
          const x0 = Math.max(scale.x(p.from), PAD_L);
          const x1 = Math.min(scale.x(p.to), right);
          if (x1 <= x0) return null;
          return (
            <rect key={`t${i}-${p.from}-${k}`} x={x0} y={y(c.base) - 3} width={x1 - x0} height={6} className="aptc__tcloud"
              style={{ stroke: catColor(p.cat) }} />
          );
        }),
      )}
      <StepPath pts={ceilPts} className="aptc__ceil" />
      {segs.map((s) =>
        s.ceil == null ? null : (
          <line key={`c${s.from}`} x1={Math.max(scale.x(s.from), PAD_L)} x2={Math.min(scale.x(s.to), right)} y1={y(s.ceil)}
            y2={y(s.ceil)} className="aptc__fline" />
        ),
      )}
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------
function VisPanel(props: FrameProps & { obs: AvnMetar[]; segs: TafState[]; temps: TafTemporary[]; model: [number, number | null][]; modelLabel?: string }) {
  const { scale, obs, segs, temps, model, modelLabel } = props;
  const height = 116;
  const top = PAD_T;
  const bot = height - PAD_B;
  const y = (v: number) => bot - visFrac(v) * (bot - top);
  const right = scale.w - PAD_R;
  const grid = [
    { y: y(0), label: "0" },
    { y: y(1), label: "1", strong: true, right: "LIFR", color: CATEGORY_COLOR.LIFR },
    { y: y(3), label: "3", strong: true, right: "IFR", color: CATEGORY_COLOR.IFR },
    { y: y(5), label: "5", strong: true, right: "MVFR", color: CATEGORY_COLOR.MVFR },
    { y: y(10), label: "10+" },
  ];
  const pts: [number, number][] = obs.filter((m) => m.vis != null).map((m) => [scale.x(m.t), y(m.vis!)]);
  return (
    <Frame
      {...props}
      title="Visibility (statute miles)"
      height={height}
      yGrid={grid}
      legend={[
        { label: "Observed", color: OBS },
        { label: "Forecast", color: FCST, dashed: true },
        ...(model.length ? [{ label: modelLabel ?? "Model", color: MODEL, dashed: true }] : []),
      ]}
    >
      {model.length > 0 && <Polyline pts={model.map(([t, v]) => (v == null ? null : [scale.x(t), y(v)]))} color={MODEL} dashed />}
      {temps.map((p, i) =>
        p.vis == null ? null : (
          <rect key={`t${i}-${p.from}`} x={Math.max(scale.x(p.from), PAD_L)} y={y(p.vis)} width={Math.max(Math.min(scale.x(p.to), right) - Math.max(scale.x(p.from), PAD_L), 0)}
            height={Math.max(bot - y(p.vis), 0)} className="aptc__tempo" style={{ fill: catColor(p.cat), stroke: catColor(p.cat) }} />
        ),
      )}
      <StepPath pts={pts} className="aptc__obsline" fill={{ base: bot, className: "aptc__obsfill" }} />
      {segs.map((s) =>
        s.vis == null ? null : (
          <line key={s.from} x1={Math.max(scale.x(s.from), PAD_L)} x2={Math.min(scale.x(s.to), right)} y1={y(s.vis)} y2={y(s.vis)}
            className="aptc__fline" />
        ),
      )}
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Ordinary lines: wind, temperature, altimeter, density altitude
// ---------------------------------------------------------------------------
interface Series {
  label: string;
  color: string;
  dashed?: boolean;
  dots?: boolean;
  pts?: [number, number | null][];
  steps?: [number, number, number | null][];
}

function LinePanel(
  props: FrameProps & {
    title: string;
    height: number;
    series: Series[];
    zero?: boolean;
    dec?: number;
    spreadFill?: boolean;
    arrows?: { t: number; dir: number | string | null; spd: number | null; fc: boolean }[];
  },
) {
  const { scale, series, height, zero, arrows, spreadFill } = props;
  const top = PAD_T + (arrows ? 14 : 0);
  const bot = height - PAD_B;
  const values: number[] = [];
  for (const s of series) {
    for (const p of s.pts ?? []) if (p[1] != null && p[0] >= scale.t0 - 3600) values.push(p[1]);
    for (const p of s.steps ?? []) if (p[2] != null) values.push(p[2]);
  }
  if (zero) values.push(0);
  const sc = values.length ? niceScale(Math.min(...values), Math.max(...values), 3) : { lo: 0, hi: 1, step: 1 };
  const y = (v: number) => bot - ((v - sc.lo) / Math.max(sc.hi - sc.lo, 1e-9)) * (bot - top);
  const dec = props.dec ?? (sc.step >= 1 ? 0 : Math.min(2, Math.ceil(-Math.log10(sc.step))));
  const grid = [];
  for (let v = sc.lo; v <= sc.hi + 1e-9; v += sc.step) grid.push({ y: y(v), label: v.toFixed(dec) });
  const right = scale.w - PAD_R;

  const temp = series[0];
  const dew = series[1];
  let spread: string | null = null;
  if (spreadFill && temp?.pts && dew?.pts) {
    const both = temp.pts
      .map((p, i) => [p[0], p[1], dew.pts![i]?.[1]] as const)
      .filter((p): p is readonly [number, number, number] => p[1] != null && p[2] != null);
    if (both.length > 1) {
      spread =
        both.map((p, i) => `${i ? "L" : "M"}${scale.x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("") +
        [...both].reverse().map((p) => `L${scale.x(p[0]).toFixed(1)},${y(p[2]).toFixed(1)}`).join("") +
        "Z";
    }
  }

  return (
    <Frame
      {...props}
      yGrid={grid}
      legend={series.filter((s) => s.label !== "Field elevation").map((s) => ({ label: s.label, color: s.color, dashed: s.dashed }))}
    >
      {spread && <path d={spread} className="aptc__spread" />}
      {series.map((s) => (
        <g key={s.label}>
          {s.pts &&
            (s.dots ? (
              s.pts.map((p) =>
                p[1] == null || p[0] < scale.t0 ? null : (
                  <circle key={p[0]} cx={scale.x(p[0])} cy={y(p[1])} r={2.2} style={{ fill: s.color }} />
                ),
              )
            ) : (
              <Polyline pts={s.pts.filter((p) => p[0] >= scale.t0 - 3600).map(([t, v]) => (v == null ? null : [scale.x(t), y(v)]))}
                color={s.color} dashed={s.dashed} />
            ))}
          {s.steps?.map(([a, b, v]) =>
            v == null ? null : (
              <line key={a} x1={Math.max(scale.x(a), PAD_L)} x2={Math.min(scale.x(b), right)} y1={y(v)} y2={y(v)}
                style={{ stroke: s.color }} strokeWidth={1.8} strokeDasharray={s.dashed ? "5 3" : undefined} opacity={0.9} />
            ),
          )}
        </g>
      ))}
      {arrows && <Arrows arrows={arrows} scale={scale} y={PAD_T + 6} />}
    </Frame>
  );
}

function Polyline({ pts, color, dashed }: { pts: ([number, number] | null)[]; color: string; dashed?: boolean }) {
  const runs: [number, number][][] = [[]];
  for (const p of pts) {
    if (p == null) {
      if (runs[runs.length - 1].length) runs.push([]);
      continue;
    }
    runs[runs.length - 1].push(p);
  }
  return (
    <>
      {runs
        .filter((r) => r.length > 0)
        .map((r, i) =>
          r.length === 1 ? (
            <circle key={i} cx={r[0][0]} cy={r[0][1]} r={1.8} style={{ fill: color }} />
          ) : (
            <path key={i} d={r.map((p, k) => `${k ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("")} fill="none"
              style={{ stroke: color }} strokeWidth={1.7} strokeDasharray={dashed ? "5 3" : undefined} strokeLinejoin="round" />
          ),
        )}
    </>
  );
}

/** A reading held until the next one: the way a METAR stands for its hour. */
function StepPath({ pts, className, fill }: { pts: [number, number][]; className: string; fill?: { base: number; className: string } }) {
  if (!pts.length) return null;
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) d += `H${pts[i][0].toFixed(1)}V${pts[i][1].toFixed(1)}`;
  const area = fill
    ? `${d}H${(pts[pts.length - 1][0] + 2).toFixed(1)}V${fill.base}H${pts[0][0].toFixed(1)}Z`
    : null;
  return (
    <>
      {area && <path d={area} className={fill!.className} />}
      <path d={d} className={className} />
    </>
  );
}

function Arrows({
  arrows,
  scale,
  y,
}: {
  arrows: { t: number; dir: number | string | null; spd: number | null; fc: boolean }[];
  scale: Scale;
  y: number;
}) {
  const keep: typeof arrows = [];
  let lastX = -Infinity;
  for (const a of [...arrows].sort((p, q) => p.t - q.t)) {
    const d = typeof a.dir === "number" ? a.dir : Number(a.dir);
    if (a.t < scale.t0 || !Number.isFinite(d) || !a.spd) continue;
    const x = scale.x(a.t);
    if (x - lastX < 20) continue;
    keep.push(a);
    lastX = x;
  }
  return (
    <g>
      {keep.map((a) => (
        <g key={`${a.fc}-${a.t}`} transform={`translate(${scale.x(a.t).toFixed(1)},${y}) rotate(${Number(a.dir) + 180})`}
          className={a.fc ? "aptc__arrow is-fc" : "aptc__arrow"}>
          <path d="M0,-5 L0,5 M0,5 L-2.6,1.4 M0,5 L2.6,1.4" />
        </g>
      ))}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Present weather, and the time axis
// ---------------------------------------------------------------------------
function WxPanel(
  props: FrameProps & {
    obs: AvnMetar[];
    segs: TafState[];
    temps: TafTemporary[];
    clock: (t: number) => string;
    day: (t: number) => string;
  },
) {
  const { scale, obs, segs, temps, ticks, utc } = props;
  const height = 62;
  const keep: { x: number; text: string; fc: boolean }[] = [];
  let lastX = -Infinity;
  const add = (t: number, text: string | null, fc: boolean) => {
    if (!text || t < scale.t0) return;
    const x = scale.x(t);
    if (x - lastX < 34) return;
    keep.push({ x, text, fc });
    lastX = x;
  };
  for (const m of obs) add(m.t, m.wx, false);
  lastX = -Infinity;
  const fcItems: { x: number; text: string; fc: boolean }[] = [];
  for (const s of [...segs, ...temps].sort((a, b) => a.from - b.from)) {
    if (!s.wx || s.wx === "NSW") continue;
    const x = scale.x(Math.max(s.from, scale.t0));
    if (x - lastX < 34) continue;
    fcItems.push({ x, text: s.wx, fc: true });
    lastX = x;
  }
  const midnight = (t: number) => (utc ? new Date(t * 1000).getUTCHours() : new Date(t * 1000).getHours()) === 0;
  return (
    <Frame {...props} title="Present weather" height={height}>
      <text x={PAD_L - 6} y={24} className="aptc__ylab">METAR</text>
      <text x={PAD_L - 6} y={40} className="aptc__ylab">TAF</text>
      {keep.map((k) => (
        <text key={`o${k.x}`} x={k.x} y={24} className="aptc__wx">
          {k.text}
        </text>
      ))}
      {fcItems.map((k) => (
        <text key={`f${k.x}`} x={k.x} y={40} className="aptc__wx is-fc">
          {k.text}
        </text>
      ))}
      {ticks.map((t) => (
        <text key={t} x={scale.x(t)} y={height - 2} className="aptc__xlab" textAnchor="middle">
          {midnight(t) ? props.day(t) : props.clock(t)}
        </text>
      ))}
    </Frame>
  );
}
