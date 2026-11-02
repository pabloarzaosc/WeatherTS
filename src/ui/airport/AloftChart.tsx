import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { fmtWind, type AloftProfile, type AloftStation } from "../../lib/aviation";

/**
 * The air over the airport for three days, hour by hour and level by level:
 * the model's wind barbs and temperatures, its cloud, where it is cold and wet
 * enough to ice, where the shear is enough to shake, the freezing level and
 * the tropopause -- a time-height section, the way forecasters read a column.
 *
 * Under it the FB table: wind and temperature at the FB's own heights, now and
 * 6, 12 and 24 hours on, for any airport (and the official FB beside it in
 * the US).
 */

const PAD_L = 54;
const PAD_R = 30;
const PAD_T = 12;
const PAD_B = 30;

const ICE_FILL = ["", "rgba(96,165,250,0.30)", "rgba(59,130,246,0.48)", "rgba(124,58,237,0.58)"];
const TURB_FILL = ["", "rgba(250,204,21,0.55)", "rgba(245,158,11,0.75)", "rgba(239,68,68,0.85)"];
const TURB_OPACITY = [0, 0.5, 0.8, 1];
const ICE_WORD = ["None", "Light", "Moderate", "Severe"];
const TURB_WORD = ["None", "Light", "Moderate", "Severe"];

/** Barb colour by speed, the jet standing out. */
function barbColor(kt: number): string {
  if (kt < 20) return "var(--text-dim)";
  if (kt < 40) return "#38bdf8";
  if (kt < 60) return "#22c55e";
  if (kt < 80) return "#eab308";
  if (kt < 100) return "#f97316";
  if (kt < 130) return "#ef4444";
  return "#c026d3";
}

/** A wind barb pointing into the wind (north up), as an SVG path around 0,0. */
export function barbPath(kt: number, len = 15): string {
  if (kt < 2.5) return "";
  let d = `M0,0 L0,${-len}`;
  let rest = Math.round(kt / 5) * 5;
  let y = -len;
  const step = 3.2;
  while (rest >= 50) {
    d += ` M0,${y} L7,${y + 1.6} L0,${y + step} Z`;
    y += step + 1;
    rest -= 50;
  }
  while (rest >= 10) {
    d += ` M0,${y} L7,${y - 2.6}`;
    y += step;
    rest -= 10;
  }
  if (rest >= 5) {
    if (y === -len) y += step;
    d += ` M0,${y} L3.8,${y - 1.4}`;
  }
  return d;
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

const flLabel = (ft: number) => (ft >= 18000 ? `FL${Math.round(ft / 100)}` : ft === 0 ? "SFC" : `${(ft / 1000).toFixed(0)}k`);

interface Col {
  t: number;
  pts: { ft: number; t: number | null; rh: number | null; spd: number | null; dir: number | null; cc: number | null; p: number }[];
}

export function AloftChart({ profile, utc, top }: { profile: AloftProfile; utc: boolean; top: number }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useWidth(wrapRef);
  const [hover, setHover] = useState<{ k: number; ft: number } | null>(null);
  const height = 420;
  const now = Date.now() / 1000;

  const cols: Col[] = useMemo(() => {
    const out: Col[] = [];
    profile.times.forEach((t, k) => {
      if (t < now - 3 * 3600) return;
      const pts = profile.levels
        .map((L) => ({ ft: L.ft[k], t: L.t[k], rh: L.rh[k], spd: L.spd[k], dir: L.dir[k], cc: L.cc[k], p: L.p }))
        .filter((x): x is Col["pts"][number] => x.ft != null && x.ft >= profile.groundFt - 50)
        .sort((a, b) => a.ft - b.ft);
      out.push({ t, pts });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);
  const index = useMemo(() => new Map(profile.times.map((t, k) => [t, k])), [profile]);

  if (!cols.length) return <div className="apt__none">No model profile for this place.</div>;

  const t0 = cols[0].t;
  const t1 = cols[cols.length - 1].t;
  const inner = Math.max(width - PAD_L - PAD_R, 1);
  const x = (t: number) => PAD_L + ((t - t0) / Math.max(t1 - t0, 1)) * inner;
  const bot = height - PAD_B;
  const y = (ft: number) => bot - (Math.min(Math.max(ft, 0), top) / top) * (bot - PAD_T);
  const colW = inner / Math.max(cols.length - 1, 1);
  const ground = profile.groundFt;

  const clock = (t: number) =>
    utc
      ? `${new Date(t * 1000).toISOString().slice(11, 13)}Z`
      : new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", hour12: false });
  const day = (t: number) => new Date(t * 1000).toLocaleDateString([], { weekday: "short", day: "numeric", ...(utc ? { timeZone: "UTC" } : {}) });

  // Isotherms: where each column crosses a temperature, joined across hours.
  const isotherms = [10, 0, -10, -20, -30, -40, -50].map((iso) => {
    const pts: ([number, number] | null)[] = cols.map((c) => {
      for (let i = 0; i + 1 < c.pts.length; i++) {
        const a = c.pts[i];
        const b = c.pts[i + 1];
        if (a.t == null || b.t == null) continue;
        if ((a.t - iso) * (b.t - iso) <= 0 && a.t !== b.t) {
          const ft = a.ft + ((iso - a.t) / (b.t - a.t)) * (b.ft - a.ft);
          return [x(c.t), y(ft)];
        }
      }
      return null;
    });
    return { iso, pts };
  });

  const hourEvery = Math.max(1, Math.ceil(28 / Math.max(colW, 1)));
  const barbCols = cols.filter((_, i) => i % hourEvery === 0 || i === cols.length - 1);
  const ticks = cols.filter((c) => {
    const h = utc ? new Date(c.t * 1000).getUTCHours() : new Date(c.t * 1000).getHours();
    const every = colW * 6 >= 46 ? 6 : 12;
    return h % every === 0;
  });
  const yTicks: number[] = [];
  const yStep = top > 30000 ? 5000 : top > 15000 ? 3000 : 2000;
  for (let f = 0; f <= top; f += yStep) yTicks.push(f);

  const lineOf = (pts: ([number, number] | null)[]) => {
    let d = "";
    let pen = false;
    for (const p of pts) {
      if (!p) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  const frz = cols.map((c) => {
    const k = index.get(c.t) ?? -1;
    const v = k >= 0 ? profile.freezing[k] : null;
    return v == null || v > top ? null : ([x(c.t), y(v)] as [number, number]);
  });
  const trop = cols.map((c) => {
    const k = index.get(c.t) ?? -1;
    const v = k >= 0 ? profile.tropopause[k] : null;
    return v == null || v > top ? null : ([x(c.t), y(v)] as [number, number]);
  });

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    const py = e.clientY - box.top;
    if (px < PAD_L || px > width - PAD_R || py < PAD_T || py > bot) {
      setHover(null);
      return;
    }
    const i = Math.round(((px - PAD_L) / inner) * (cols.length - 1));
    const ft = ((bot - py) / (bot - PAD_T)) * top;
    setHover({ k: Math.min(Math.max(i, 0), cols.length - 1), ft });
  };

  const hc = hover ? cols[hover.k] : null;
  const hk = hc ? (index.get(hc.t) ?? -1) : -1;
  const hx = hc ? x(hc.t) : 0;
  const tipRight = hx > width * 0.6;

  return (
    <div className="aloft" ref={wrapRef} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height}>
          <defs>
            {[1, 2, 3].map((r) => (
              <pattern key={r} id={`turb${r}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill={TURB_FILL[r].replace(/[\d.]+\)$/, "0.16)")} />
                <line x1="0" y1="0" x2="0" y2="6" stroke={TURB_FILL[r]} strokeWidth={r === 1 ? 1.4 : 2.2} />
              </pattern>
            ))}
          </defs>
          {/* Cloud: each level's cover over the slice of the column it stands for. */}
          {cols.map((c, ci) =>
            c.pts.map((p, i) => {
              if (!p.cc || p.cc < 8) return null;
              const lo = i === 0 ? Math.max(ground, p.ft - 300) : (c.pts[i - 1].ft + p.ft) / 2;
              const hi = i + 1 < c.pts.length ? (p.ft + c.pts[i + 1].ft) / 2 : p.ft + 1000;
              if (lo > top) return null;
              return (
                <rect key={`${ci}-${p.p}`} x={x(c.t) - colW / 2} width={colW + 0.5} y={y(Math.min(hi, top))}
                  height={Math.max(y(lo) - y(Math.min(hi, top)), 0)} className="aloft__cloud" opacity={Math.min(p.cc / 100, 1) * 0.38} />
              );
            }),
          )}
          {/* Icing and turbulence layers. */}
          {cols.map((c, ci) => {
            const k = index.get(c.t) ?? -1;
            return (
              <g key={`hz${ci}`}>
                {(profile.icing[k] ?? []).map((L, j) =>
                  L.base > top ? null : (
                    <rect key={`i${j}`} x={x(c.t) - colW / 2} width={colW + 0.5} y={y(Math.min(L.top, top))}
                      height={Math.max(y(L.base) - y(Math.min(L.top, top)), 0)} fill={ICE_FILL[L.risk]} className="aloft__ice" />
                  ),
                )}
                {(profile.turbulence[k] ?? []).map((L, j) =>
                  L.base > top ? null : (
                    <rect key={`t${j}`} x={x(c.t) - colW / 2} width={colW + 0.5} y={y(Math.min(L.top, top))}
                      height={Math.max(y(L.base) - y(Math.min(L.top, top)), 0)} fill={`url(#turb${L.risk})`}
                      opacity={TURB_OPACITY[L.risk]} className="aloft__turb" />
                  ),
                )}
              </g>
            );
          })}
          {/* Grid. */}
          {yTicks.map((f) => (
            <g key={f}>
              <line x1={PAD_L} x2={width - PAD_R} y1={y(f)} y2={y(f)} className="aptc__grid" />
              <text x={PAD_L - 6} y={y(f) + 3} className="aptc__ylab">{flLabel(f)}</text>
            </g>
          ))}
          {ticks.map((c) => (
            <g key={c.t}>
              <line x1={x(c.t)} x2={x(c.t)} y1={PAD_T} y2={bot} className={(utc ? new Date(c.t * 1000).getUTCHours() : new Date(c.t * 1000).getHours()) === 0 ? "aptc__grid aptc__grid--day" : "aptc__grid"} />
              <text x={x(c.t)} y={bot + 13} textAnchor="middle" className="aptc__xlab">
                {(utc ? new Date(c.t * 1000).getUTCHours() : new Date(c.t * 1000).getHours()) === 0 ? day(c.t) : clock(c.t)}
              </text>
            </g>
          ))}
          {/* Isotherms, the freezing level, the tropopause. */}
          {isotherms.map(({ iso, pts }) => {
            const d = lineOf(pts);
            if (!d) return null;
            const last = [...pts].reverse().find(Boolean);
            return (
              <g key={iso}>
                <path d={d} className={iso === 0 ? "aloft__iso is-zero" : iso < 0 ? "aloft__iso is-cold" : "aloft__iso"} />
                {last && <text x={last[0] + 3} y={last[1] + 3} className="aloft__isolab">{iso > 0 ? `+${iso}` : iso}°</text>}
              </g>
            );
          })}
          <path d={lineOf(frz)} className="aloft__frz" />
          <path d={lineOf(trop)} className="aloft__trop" />
          {/* The ground under the model's column. */}
          {ground > 0 && <rect x={PAD_L} y={y(ground)} width={inner} height={Math.max(bot - y(ground), 0)} className="aloft__ground" />}
          {/* Barbs. */}
          {barbCols.map((c) =>
            c.pts.map((p) => {
              if (p.spd == null || p.dir == null || p.ft > top) return null;
              return (
                <g key={`${c.t}-${p.p}`} transform={`translate(${x(c.t).toFixed(1)},${y(p.ft).toFixed(1)}) rotate(${p.dir})`}>
                  {p.spd < 2.5 ? <circle r={2.2} className="aloft__calm" /> : <path d={barbPath(p.spd)} className="aloft__barb" style={{ stroke: barbColor(p.spd), fill: barbColor(p.spd) }} />}
                </g>
              );
            }),
          )}
          {now >= t0 && now <= t1 && <line x1={x(now)} x2={x(now)} y1={PAD_T - 4} y2={bot} className="aptc__now" />}
          {hc && <line x1={hx} x2={hx} y1={PAD_T} y2={bot} className="aptc__cross" />}
        </svg>
      )}
      {hc && hk >= 0 && (
        <div className={`aptc__tip aloft__tip${tipRight ? " is-right" : ""}`} style={{ left: tipRight ? undefined : hx + 12, right: tipRight ? width - hx + 12 : undefined }}>
          <b>{clock(hc.t)}</b>
          <span>{day(hc.t)} · +{Math.round((hc.t - now) / 3600)} h</span>
          <div className="aptc__tipsec">
            {[...hc.pts].reverse().filter((p) => p.ft <= top + 2000).map((p) => (
              <div key={p.p} className={`aptc__tiprow aloft__lvl${hover && Math.abs(p.ft - hover.ft) < 1500 ? " is-on" : ""}`}>
                <span>{flLabel(Math.round(p.ft / 100) * 100)} <em>{p.p}</em></span>
                <b>
                  {p.spd != null ? fmtWind(p.dir, p.spd) : "—"}
                  {p.t != null ? ` · ${p.t > 0 ? "+" : ""}${p.t.toFixed(0)}°` : ""}
                  {p.rh != null ? ` · ${Math.round(p.rh)}%` : ""}
                </b>
              </div>
            ))}
          </div>
          <div className="aptc__tipsec">
            <div className="aptc__tiprow"><span>Freezing level</span><b>{profile.freezing[hk] != null ? `${profile.freezing[hk]!.toLocaleString("en-US")} ft` : "—"}</b></div>
            <div className="aptc__tiprow"><span>Tropopause</span><b>{profile.tropopause[hk] != null ? flLabel(Math.round(profile.tropopause[hk]! / 100) * 100) : "above FL530"}</b></div>
            {(profile.icing[hk] ?? []).map((L, j) => (
              <div key={`i${j}`} className="aptc__tiprow"><i style={{ background: ICE_FILL[L.risk] }} /><span>{ICE_WORD[L.risk]} icing</span><b>{flLabel(Math.round(L.base / 100) * 100)}–{flLabel(Math.round(L.top / 100) * 100)}</b></div>
            ))}
            {(profile.turbulence[hk] ?? []).map((L, j) => (
              <div key={`t${j}`} className="aptc__tiprow"><i style={{ background: TURB_FILL[L.risk] }} /><span>{TURB_WORD[L.risk]} turbulence</span><b>{flLabel(Math.round(L.base / 100) * 100)}–{flLabel(Math.round(L.top / 100) * 100)} · {L.shear} kt/1000 ft{L.ri != null ? ` · Ri ${L.ri}` : ""}</b></div>
            ))}
          </div>
        </div>
      )}
      <div className="aloft__legend">
        <span><i className="aloft__sw is-cloud" />Cloud</span>
        <span><i className="aloft__sw" style={{ background: ICE_FILL[2] }} />Icing (light, moderate, severe)</span>
        <span><i className="aloft__sw is-turb" />Turbulence (shear, Richardson)</span>
        <span><i className="aloft__ln is-zero" />0 °C</span>
        <span><i className="aloft__ln is-frz" />Freezing level</span>
        <span><i className="aloft__ln is-trop" />Tropopause</span>
        <span>Barbs: <b style={{ color: "#38bdf8" }}>20</b> <b style={{ color: "#22c55e" }}>40</b> <b style={{ color: "#eab308" }}>60</b> <b style={{ color: "#f97316" }}>80</b> <b style={{ color: "#ef4444" }}>100</b> <b style={{ color: "#c026d3" }}>130</b> kt</span>
      </div>
    </div>
  );
}

/** The FB table at any airport: the model's wind and temperature at the FB's
 *  heights, now and 6, 12, 24 h on; and, in the US, the official FB beside it. */
export function AloftTable({ profile, official, utc }: { profile: AloftProfile | null; official: Record<string, AloftStation>; utc: boolean }) {
  const fb = profile?.fb ?? [];
  const station = official.low06 ?? official.low12 ?? official.low24 ?? null;
  const heights = useMemo(() => {
    const all = new Set<number>();
    for (const row of fb) for (const h of Object.keys(row.levels)) all.add(Number(h));
    for (const k of ["low06", "low12", "low24", "high06"]) for (const h of Object.keys(official[k]?.levels ?? {})) all.add(Number(h));
    return [...all].sort((a, b) => b - a);
  }, [fb, official]);
  const clock = (t: number) =>
    utc ? `${new Date(t * 1000).toISOString().slice(11, 13)}Z` : new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", hour12: false });
  const cell = (v: { dir: number | null; spd: number; temp: number | null; lv: boolean } | undefined) => (
    <>
      {v ? (v.lv ? "Lt & var" : fmtWind(v.dir, v.spd)) : "—"}
      {v?.temp != null ? <em className={v.temp < 0 ? "is-cold" : undefined}> {v.temp > 0 ? "+" : ""}{v.temp}°</em> : null}
    </>
  );
  if (!heights.length) return <div className="apt__none">No winds aloft for this airport.</div>;
  const officialCols = station ? (["low06", "low12", "low24"] as const).filter((k) => official[k]) : [];
  return (
    <div className="apt__table apt__table--aloft" style={{ ["--cols" as string]: fb.length + officialCols.length }}>
      <div className="apt__trow apt__trow--head">
        <span>Altitude</span>
        {fb.map((r) => (
          <span key={r.lead}>{profile?.modelLabel} {r.lead === 0 ? "now" : `+${r.lead} h`}<i>{clock(r.t)}</i></span>
        ))}
        {officialCols.map((k) => (
          <span key={k} className="is-fb">FB {Number(k.slice(3))} h<i>{station!.id}</i></span>
        ))}
      </div>
      {heights.map((h) => {
        const hi = official.high06?.levels[String(h)];
        return (
          <div key={h} className="apt__trow">
            <span>{h >= 18000 ? `FL${h / 100}` : `${h.toLocaleString("en-US")} ft`}</span>
            {fb.map((r) => (
              <span key={r.lead}>{cell(r.levels[String(h)])}</span>
            ))}
            {officialCols.map((k) => (
              <span key={k} className="is-fb">{cell(official[k]?.levels[String(h)] ?? (k === "low06" ? hi : undefined))}</span>
            ))}
          </div>
        );
      })}
      <div className="apt__note">
        {profile ? `${profile.modelLabel} at its grid point nearest the airport (${profile.lat.toFixed(2)}, ${profile.lon.toFixed(2)}), interpolated to each height; heights within 1,500 ft of the ground are left out, as the FB does.` : ""}
        {station ? ` FB: NOAA's official forecast for ${station.id}${station.name ? ` (${station.name})` : ""}, ${station.nm} nm away, based on ${official.low06?.valid ?? "—"}Z.` : ""}
      </div>
    </div>
  );
}
