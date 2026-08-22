import { useEffect, useMemo, useState } from "react";
import { Check, Clock, Cloud, Copy, FileText, X } from "lucide-react";

import {
  CATEGORY_COLOR,
  CATEGORY_LABEL,
  SKY_WORDS,
  ceilingFt,
  compassPoint,
  flightCategory,
  parseClouds,
  relativeTime,
} from "../lib/metar";
import { fetchSurfaceHistory, type SurfaceObsHistory } from "../lib/surfaceObs";
import { useStationStore } from "../store/useStationStore";

const RANGES = [6, 12, 24];

const METRICS = [
  { key: "temp", label: "Temperature", unit: "°C", color: "#ff6b5e" },
  { key: "dewp", label: "Dew point", unit: "°C", color: "#4ade80" },
  { key: "rh", label: "Humidity", unit: "%", color: "#38bdf8" },
  { key: "wspd", label: "Wind", unit: "kt", color: "#e8edf4" },
  { key: "altim", label: "Pressure", unit: "hPa", color: "#9fb4d6" },
  { key: "visib", label: "Visibility", unit: "SM", color: "#c7d2e4" },
] as const;

const num = (v: unknown): number | null => {
  const n = Number(v);
  return v == null || v === "" || !Number.isFinite(n) ? null : n;
};

const hhmm = (unix: unknown) => {
  const n = num(unix);
  if (n == null) return "";
  return new Date(n > 1e11 ? n : n * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/**
 * The chosen reading over the loaded window. Hand-drawn SVG rather than a chart
 * library: one line and six labels does not justify the dependency, and this way
 * it inherits the app's tokens instead of fighting a library's theme.
 */
function Chart({ rows, metricKey, color }: { rows: SurfaceObsHistory[]; metricKey: string; color: string }) {
  const pts = rows
    .map((r, i) => ({ i, v: num((r as unknown as Record<string, unknown>)[metricKey]) }))
    .filter((o): o is { i: number; v: number } => o.v != null);

  if (pts.length < 2) return <div className="stp__chart-empty">Not enough history to chart.</div>;

  const W = 320;
  const H = 128;
  const L = 38;
  const R = 8;
  const T = 10;
  const B = 20;
  const n = rows.length - 1 || 1;
  let lo = Math.min(...pts.map((o) => o.v));
  let hi = Math.max(...pts.map((o) => o.v));
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  // Round the axis outwards so the labels are numbers a person would choose.
  const step = Math.pow(10, Math.floor(Math.log10(hi - lo))) / 2 || 1;
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const X = (i: number) => L + (i / n) * (W - L - R);
  const Y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const line = pts.map((o, k) => `${k ? "L" : "M"}${X(o.i).toFixed(1)},${Y(o.v).toFixed(1)}`).join("");
  const area = `${line}L${X(pts[pts.length - 1].i).toFixed(1)},${H - B}L${X(pts[0].i).toFixed(1)},${H - B}Z`;
  const dec = step < 1 ? 1 : 0;
  // Deduped: with only two readings n is 1, so the "middle" tick collapses onto
  // the first and the two time labels render on top of each other.
  const marks = [...new Set([0, Math.floor(n / 2), n])];

  return (
    <svg className="stp__chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="History">
      {[hi, (hi + lo) / 2, lo].map((v) => (
        <g key={v}>
          <line x1={L} y1={Y(v)} x2={W - R} y2={Y(v)} className="stp__grid" />
          <text x={L - 6} y={Y(v) + 3} className="stp__ylab">
            {v.toFixed(dec)}
          </text>
        </g>
      ))}
      {marks.map((i, k) => (
        <text
          key={i}
          x={X(i)}
          y={H - 6}
          className="stp__xlab"
          textAnchor={k === 0 ? "start" : k === marks.length - 1 ? "end" : "middle"}
        >
          {hhmm(rows[i]?.obsTime)}
        </text>
      ))}
      <path d={area} fill={color} opacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.8} />
    </svg>
  );
}

/** The full METAR report for one station, opened from the map's compact card. */
export function StationPanel() {
  const station = useStationStore((s) => s.station);
  const hours = useStationStore((s) => s.hours);
  const metricKey = useStationStore((s) => s.metric);
  const close = useStationStore((s) => s.close);
  const setHours = useStationStore((s) => s.setHours);
  const setMetric = useStationStore((s) => s.setMetric);

  const [rows, setRows] = useState<SurfaceObsHistory[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!station?.id) return;
    let cancelled = false;
    fetchSurfaceHistory(station.id, hours)
      .then((list) => {
        if (cancelled) return;
        const sorted = [...list].sort((a, b) => Number(a.obsTime) - Number(b.obsTime));
        setRows(sorted);
      })
      .catch(() => {
        /* The clicked observation stays useful when history is unavailable. */
      });
    return () => {
      cancelled = true;
    };
  }, [station?.id, hours]);

  useEffect(() => {
    if (!station) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [station, close]);

  // Prefer the newest history record; fall back to the observation clicked on
  // the map so the panel is never blank while the request is in flight.
  const obs = useMemo(
    () => (rows.length ? (rows[rows.length - 1] as unknown as Record<string, unknown>) : (station?.current as Record<string, unknown> | undefined)),
    [rows, station],
  );

  if (!station || !obs) return null;

  const clouds = parseClouds(obs.clouds);
  const ceiling = ceilingFt(clouds);
  const visib = num(obs.visib);
  const cat = flightCategory(ceiling, visib);
  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0];
  const wdir = num(obs.wdir);
  const altim = num(obs.altim);
  const raw = typeof obs.raw === "string" ? obs.raw : null;

  const copy = () => {
    if (!raw) return;
    void navigator.clipboard
      ?.writeText(raw)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {});
  };

  return (
    <div className="stp" role="dialog" aria-modal="true" aria-label={`METAR ${station.id}`}>
      <div className="stp__scrim" onClick={close} />
      <div className="stp__panel">
        <header className="stp__top">
          <div>
            <h2>METAR {station.id}</h2>
            <span>
              <Clock size={11} /> {relativeTime(num(obs.obsTime))}
              {station.name ? ` · ${station.name}` : ""}
            </span>
          </div>
          <button type="button" className="stp__close" onClick={close} aria-label="Close">
            <X size={15} />
          </button>
        </header>

        <div className="stp__body">
          {cat && (
            <div className="stp__cat" style={{ ["--cat" as string]: CATEGORY_COLOR[cat] }}>
              <b>{cat}</b>
              <span>{CATEGORY_LABEL[cat]}</span>
            </div>
          )}

          <div className="stp__cards">
            {METRICS.map((m) => {
              const v = num(obs[m.key]);
              const sub =
                m.key === "wspd" && wdir != null
                  ? `${compassPoint(wdir)} ${wdir}°`
                  : m.key === "altim" && altim != null
                    ? `${(altim * 0.0295299830714).toFixed(2)} inHg`
                    : null;
              return (
                <button
                  key={m.key}
                  type="button"
                  className={`stp__card${m.key === metric.key ? " is-on" : ""}`}
                  onClick={() => setMetric(m.key)}
                >
                  <span>{m.label}</span>
                  <b>{v == null ? "—" : `${v}${m.unit === "%" ? "" : " "}${m.unit}`}</b>
                  {sub && <i>{sub}</i>}
                </button>
              );
            })}
          </div>

          <div className="stp__sec">
            <span>{metric.label} history</span>
            <div className="stp__ranges">
              {RANGES.map((h) => (
                <button
                  key={h}
                  type="button"
                  className={`stp__range${h === hours ? " is-on" : ""}`}
                  onClick={() => setHours(h)}
                >
                  {h}h
                </button>
              ))}
            </div>
          </div>
          <Chart rows={rows} metricKey={metric.key} color={metric.color} />

          <div className="stp__sec">
            <span>
              <Cloud size={11} /> Sky conditions
            </span>
          </div>
          <div className="stp__sky">
            {clouds.length === 0 && (
              <div className="stp__sky-row">
                <span>{SKY_WORDS[String(obs.cover)] ?? "No layers reported"}</span>
                <b />
              </div>
            )}
            {clouds.map((c, i) => (
              <div key={`${c.cover}-${c.base}-${i}`} className="stp__sky-row">
                <span>{SKY_WORDS[c.cover] ?? c.cover}</span>
                <b>{c.base == null ? "—" : `${Math.round(c.base).toLocaleString()} ft`}</b>
              </div>
            ))}
            {ceiling != null && (
              <div className="stp__sky-row stp__sky-row--ceiling">
                <span>Ceiling</span>
                <b>{Math.round(ceiling).toLocaleString()} ft</b>
              </div>
            )}
          </div>

          {raw && (
            <>
              <div className="stp__sec">
                <span>
                  <FileText size={11} /> Raw METAR
                </span>
                <button type="button" className="stp__copy" onClick={copy}>
                  {copied ? <Check size={11} /> : <Copy size={11} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="stp__raw">{raw}</pre>
            </>
          )}

          <div className="stp__foot">
            {station.lat.toFixed(3)}°, {station.lon.toFixed(3)}°
          </div>
        </div>
      </div>
    </div>
  );
}
