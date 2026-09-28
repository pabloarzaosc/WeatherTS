import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { CATEGORY_COLOR, compassPoint } from "../../lib/metar";
import type { StationObs } from "../../lib/stations";

/**
 * The station meteograms.
 *
 * Drawn by hand in SVG rather than pulled from a chart library: a meteogram is
 * a stack of panels sharing one time axis, one crosshair and one readout, which
 * is the part libraries make hardest, and this way the whole thing inherits the
 * app's tokens instead of fighting a library's theme.
 */

export interface MeteoSeries {
  key: keyof StationObs | string;
  label: string;
  color: string;
  kind?: "line" | "bar" | "dots";
  dashed?: boolean;
  /** Native value to the unit on screen (IEM reports °F, kt, inches, miles). */
  to?: (v: number) => number;
  unit: string;
  dec?: number;
  /** Fill under the line. */
  fill?: boolean;
}

export interface MeteoPanel {
  id: string;
  title: string;
  height?: number;
  series: MeteoSeries[];
  /** Wind barbs' poor cousin: a row of arrows showing where the wind came from. */
  arrows?: boolean;
  /** Keep zero on the axis -- precipitation has no meaning floated off it. */
  zero?: boolean;
  /** The axis reaches at least this high (in the unit on screen). */
  minHi?: number;
  /** A band of flight-category colour under the panel. */
  ribbon?: boolean;
  /** Fixed axis, for readings with a natural range (wind direction). */
  domain?: [number, number];
  /** Axis labels at fixed values, again for direction. */
  ticks?: number[];
  tickLabel?: (v: number) => string;
}

const PAD_L = 42;
const PAD_R = 10;
const PAD_T = 12;
const PAD_B = 16;

const num = (v: unknown): number | null => {
  const n = Number(v);
  return v == null || v === "" || !Number.isFinite(n) ? null : n;
};

/** Axis bounds a person would have chosen, and the gap between the lines. */
function niceScale(lo: number, hi: number, want = 4): { lo: number; hi: number; step: number } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1, step: 1 };
  if (hi - lo < 1e-9) {
    lo -= 0.5;
    hi += 0.5;
  }
  const raw = (hi - lo) / want;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : norm >= 1 ? 1 : 0.5) * mag;
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
}

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

/** Hour marks at a spacing that suits the window, on the hour in local time. */
function timeTicks(t0: number, t1: number): number[] {
  const span = (t1 - t0) / 3600;
  const every = span <= 14 ? 2 : span <= 30 ? 3 : span <= 54 ? 6 : 12;
  const out: number[] = [];
  const d = new Date(t0 * 1000);
  d.setMinutes(0, 0, 0);
  while (d.getHours() % every !== 0) d.setHours(d.getHours() + 1);
  for (let t = d.getTime() / 1000; t <= t1; t += every * 3600) {
    if (t >= t0) out.push(t);
  }
  return out;
}

const hourLabel = (t: number) =>
  new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const dayLabel = (t: number) => new Date(t * 1000).toLocaleDateString([], { weekday: "short", day: "numeric" });

export function Meteogram({
  rows,
  panels,
  utc = false,
}: {
  rows: StationObs[];
  panels: MeteoPanel[];
  utc?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useWidth(wrapRef);
  const [hover, setHover] = useState<number | null>(null);

  const domain = useMemo<[number, number]>(() => {
    if (!rows.length) return [0, 1];
    return [rows[0].valid, rows[rows.length - 1].valid];
  }, [rows]);

  const xOf = useCallback(
    (t: number, w: number) => {
      const [t0, t1] = domain;
      const span = Math.max(t1 - t0, 1);
      return PAD_L + ((t - t0) / span) * Math.max(w - PAD_L - PAD_R, 1);
    },
    [domain],
  );

  const onMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!rows.length || width <= 0) return;
      const box = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - box.left;
      const [t0, t1] = domain;
      const frac = (x - PAD_L) / Math.max(width - PAD_L - PAD_R, 1);
      const t = t0 + frac * (t1 - t0);
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < rows.length; i++) {
        const d = Math.abs(rows[i].valid - t);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      setHover(best);
    },
    [rows, width, domain],
  );

  const fmtClock = (t: number) =>
    utc
      ? `${new Date(t * 1000).toISOString().slice(11, 16)}Z`
      : new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

  if (!rows.length) return <div className="mgm__empty">No observations in this window.</div>;

  const ticks = timeTicks(domain[0], domain[1]);
  const hovered = hover != null ? rows[hover] : null;
  const hoverX = hovered ? xOf(hovered.valid, width) : 0;
  const tipRight = width > 0 && hoverX > width * 0.62;

  return (
    <div
      className="mgm"
      ref={wrapRef}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
    >
      {panels.map((panel) => (
        <Panel
          key={panel.id}
          panel={panel}
          rows={rows}
          width={width}
          xOf={xOf}
          ticks={ticks}
          hover={hover}
          last={panel.id === panels[panels.length - 1].id}
        />
      ))}

      {hovered && width > 0 && (
        <div
          className={`mgm__tip${tipRight ? " is-right" : ""}`}
          style={{ left: tipRight ? undefined : hoverX + 10, right: tipRight ? width - hoverX + 10 : undefined }}
        >
          <b>{fmtClock(hovered.valid)}</b>
          <span>{dayLabel(hovered.valid)}</span>
          <div className="mgm__tiprows">
            {panels.flatMap((p) =>
              p.series.map((s) => {
                const v = num((hovered as unknown as Record<string, unknown>)[s.key as string]);
                if (v == null) return null;
                const shown = s.to ? s.to(v) : v;
                return (
                  <div key={`${p.id}-${String(s.key)}`} className="mgm__tiprow">
                    <i style={{ background: s.color }} />
                    <span>{s.label}</span>
                    <b>
                      {shown.toFixed(s.dec ?? 0)}
                      {s.unit}
                    </b>
                  </div>
                );
              }),
            )}
            {hovered.drct != null && hovered.sknt != null && (
              <div className="mgm__tiprow">
                <i style={{ background: "var(--text-faint)" }} />
                <span>Direction</span>
                <b>
                  {compassPoint(hovered.drct)} {Math.round(hovered.drct)}&deg;
                </b>
              </div>
            )}
            {hovered.wx && (
              <div className="mgm__tiprow mgm__tiprow--wx">
                <span>{hovered.wx}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Panel({
  panel,
  rows,
  width,
  xOf,
  ticks,
  hover,
  last,
}: {
  panel: MeteoPanel;
  rows: StationObs[];
  width: number;
  xOf: (t: number, w: number) => number;
  ticks: number[];
  hover: number | null;
  last: boolean;
}) {
  const height = panel.height ?? 108;
  const ribbonH = panel.ribbon ? 8 : 0;
  const plotH = height - PAD_T - PAD_B - ribbonH;

  const values: number[] = [];
  for (const s of panel.series) {
    for (const r of rows) {
      const v = num((r as unknown as Record<string, unknown>)[s.key as string]);
      if (v != null) values.push(s.to ? s.to(v) : v);
    }
  }
  if (panel.zero) values.push(0);

  let scale = panel.domain
    ? { lo: panel.domain[0], hi: panel.domain[1], step: (panel.domain[1] - panel.domain[0]) / 4 }
    : niceScale(Math.min(...values), Math.max(...values), 3);
  if (panel.zero && !panel.domain) {
    // Bars hang off the zero line, so the axis has to hold it: a dry day is a
    // flat row of nothing, not half-height bars floating on a -0.6 baseline.
    const hi = Math.max(scale.hi, values.length ? Math.max(...values) : 0, panel.minHi ?? 0);
    const nice = niceScale(0, hi > 0 ? hi : 1, 3);
    scale = { lo: 0, hi: nice.hi, step: nice.step };
  }
  const hasData = values.length > 0;

  const yOf = (v: number) => PAD_T + (1 - (v - scale.lo) / Math.max(scale.hi - scale.lo, 1e-9)) * plotH;
  const gridValues = panel.ticks ?? [];
  if (!gridValues.length) {
    for (let v = scale.lo; v <= scale.hi + 1e-9; v += scale.step) gridValues.push(Number(v.toFixed(6)));
  }
  // As many decimals as the step needs, so neighbouring lines never read alike.
  const dec = scale.step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(scale.step) - 1e-9));

  if (width <= 0) return <div className="mgm__panel" style={{ height }} />;

  const barW = Math.max(2, Math.min(10, ((width - PAD_L - PAD_R) / Math.max(rows.length, 1)) * 0.7));

  return (
    <div className="mgm__panel" style={{ height }}>
      <span className="mgm__title">{panel.title}</span>
      <svg width={width} height={height} role="img" aria-label={panel.title}>
        {gridValues.map((v) => (
          <g key={v}>
            <line x1={PAD_L} x2={width - PAD_R} y1={yOf(v)} y2={yOf(v)} className="mgm__grid" />
            <text x={PAD_L - 6} y={yOf(v) + 3} className="mgm__ylab">
              {panel.tickLabel ? panel.tickLabel(v) : v.toFixed(dec)}
            </text>
          </g>
        ))}
        {ticks.map((t) => {
          const x = xOf(t, width);
          const midnight = new Date(t * 1000).getHours() === 0;
          return (
            <g key={t}>
              <line
                x1={x}
                x2={x}
                y1={PAD_T}
                y2={PAD_T + plotH}
                className={midnight ? "mgm__grid mgm__grid--day" : "mgm__grid mgm__grid--v"}
              />
              {last && (
                <text x={x} y={height - 4} className="mgm__xlab" textAnchor="middle">
                  {midnight ? dayLabel(t) : hourLabel(t)}
                </text>
              )}
            </g>
          );
        })}

        {hasData &&
          panel.series.map((s) => (
            <SeriesShape
              key={String(s.key)}
              s={s}
              rows={rows}
              xOf={(t) => xOf(t, width)}
              yOf={yOf}
              base={PAD_T + plotH}
              barW={barW}
            />
          ))}

        {panel.arrows && <Arrows rows={rows} xOf={(t) => xOf(t, width)} y={PAD_T + 7} />}

        {panel.ribbon &&
          rows.map((r, i) => {
            const x0 = xOf(r.valid, width);
            const x1 = i + 1 < rows.length ? xOf(rows[i + 1].valid, width) : width - PAD_R;
            const colour = r.cat ? CATEGORY_COLOR[r.cat] : "transparent";
            return (
              <rect
                key={r.valid}
                x={x0}
                y={PAD_T + plotH + 4}
                width={Math.max(x1 - x0, 1)}
                height={ribbonH - 2}
                style={{ fill: colour }}
                opacity={0.75}
              />
            );
          })}

        {hover != null && rows[hover] && (
          <>
            <line
              x1={xOf(rows[hover].valid, width)}
              x2={xOf(rows[hover].valid, width)}
              y1={PAD_T}
              y2={PAD_T + plotH}
              className="mgm__cross"
            />
            {panel.series.map((s) => {
              const v = num((rows[hover] as unknown as Record<string, unknown>)[s.key as string]);
              if (v == null) return null;
              return (
                <circle
                  key={`dot-${String(s.key)}`}
                  cx={xOf(rows[hover].valid, width)}
                  cy={yOf(s.to ? s.to(v) : v)}
                  r={2.8}
                  style={{ fill: s.color, stroke: "var(--panel-solid)" }}
                  strokeWidth={1}
                />
              );
            })}
          </>
        )}
        {!hasData && (
          <text x={width / 2} y={PAD_T + plotH / 2} className="mgm__none" textAnchor="middle">
            not reported
          </text>
        )}
      </svg>
    </div>
  );
}

function SeriesShape({
  s,
  rows,
  xOf,
  yOf,
  base,
  barW,
}: {
  s: MeteoSeries;
  rows: StationObs[];
  xOf: (t: number) => number;
  yOf: (v: number) => number;
  base: number;
  barW: number;
}) {
  const pts = rows
    .map((r) => {
      const v = num((r as unknown as Record<string, unknown>)[s.key as string]);
      return v == null ? null : { t: r.valid, v: s.to ? s.to(v) : v };
    })
    .filter((p): p is { t: number; v: number } => p != null);
  if (!pts.length) return null;

  if (s.kind === "bar") {
    return (
      <g>
        {pts.map((p) => {
          const y = yOf(p.v);
          return (
            <rect
              key={p.t}
              x={xOf(p.t) - barW / 2}
              y={Math.min(y, base - 0.5)}
              width={barW}
              height={Math.max(base - y, p.v > 0 ? 1.5 : 0)}
              style={{ fill: s.color }}
              opacity={0.85}
            />
          );
        })}
      </g>
    );
  }
  if (s.kind === "dots") {
    return (
      <g>
        {pts.map((p) => (
          <circle key={p.t} cx={xOf(p.t)} cy={yOf(p.v)} r={1.9} style={{ fill: s.color }} opacity={0.9} />
        ))}
      </g>
    );
  }

  // A line, broken wherever the station stopped reporting for more than a
  // couple of hours -- joining across a gap invents readings that never were.
  const segments: { t: number; v: number }[][] = [[]];
  let prev: number | null = null;
  for (const p of pts) {
    if (prev != null && p.t - prev > 3 * 3600) segments.push([]);
    segments[segments.length - 1].push(p);
    prev = p.t;
  }
  const paths = segments
    .filter((seg) => seg.length > 0)
    .map((seg) => seg.map((p, i) => `${i ? "L" : "M"}${xOf(p.t).toFixed(1)},${yOf(p.v).toFixed(1)}`).join(""));

  return (
    <g>
      {s.fill &&
        segments
          .filter((seg) => seg.length > 1)
          .map((seg, i) => (
            <path
              key={`fill-${i}`}
              d={`${seg.map((p, k) => `${k ? "L" : "M"}${xOf(p.t).toFixed(1)},${yOf(p.v).toFixed(1)}`).join("")}L${xOf(
                seg[seg.length - 1].t,
              ).toFixed(1)},${base}L${xOf(seg[0].t).toFixed(1)},${base}Z`}
              style={{ fill: s.color }}
              opacity={0.1}
            />
          ))}
      {paths.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          style={{ stroke: s.color }}
          strokeWidth={1.7}
          strokeDasharray={s.dashed ? "3 3" : undefined}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
    </g>
  );
}

/** Where the wind came from, thinned to whatever fits without colliding. */
function Arrows({ rows, xOf, y }: { rows: StationObs[]; xOf: (t: number) => number; y: number }) {
  const withDir = rows.filter((r) => r.drct != null && (r.sknt ?? 0) > 0);
  if (!withDir.length) return null;
  const keep: StationObs[] = [];
  let lastX = -Infinity;
  for (const r of withDir) {
    const x = xOf(r.valid);
    if (x - lastX < 22) continue;
    keep.push(r);
    lastX = x;
  }
  return (
    <g className="mgm__arrows">
      {keep.map((r) => (
        <g key={r.valid} transform={`translate(${xOf(r.valid).toFixed(1)},${y}) rotate(${(r.drct ?? 0) + 180})`}>
          <path d="M0,-5 L0,5 M0,5 L-2.6,1.4 M0,5 L2.6,1.4" />
        </g>
      ))}
    </g>
  );
}
