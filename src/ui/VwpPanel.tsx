import { useMemo, useState } from "react";
import { AlertTriangle, Loader2, Wind, X } from "lucide-react";

import { hodoBandColor, hodoX, hodoY, uvOf, windBarb, type HodoGeom } from "../lib/skewt";
import type { VwpLevel } from "../lib/nexrad";
import { useNexradStore } from "../store/useNexradStore";
import { useVwpStore, VWP_COLUMN_CHOICES } from "../store/useVwpStore";

const M_PER_FT = 0.3048;
const COL_W = 44;
const PLOT_H = 300;
const LEFT = 44;
const TOP = 22;
const BOTTOM = 26;

function fmtHHMM(unix: number | null): string {
  if (!unix) return "--";
  const d = new Date(unix * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}Z`;
}

/** Speed colour ramp, the same one a VWP display uses: green -> yellow -> red. */
function speedColor(kt: number): string {
  if (kt < 20) return "#6fd08c";
  if (kt < 35) return "#d8e05a";
  if (kt < 50) return "#f0a63c";
  if (kt < 65) return "#ef5f4c";
  return "#d05be0";
}

/**
 * VAD Wind Profile — the radar's own wind profile, drawn as the classic
 * time-height display: one column per volume scan, height up the side, a barb
 * at every level the algorithm resolved.
 */
export function VwpPanel() {
  const open = useVwpStore((s) => s.open);
  const setOpen = useVwpStore((s) => s.setOpen);
  const data = useVwpStore((s) => s.data);
  const busy = useVwpStore((s) => s.busy);
  const error = useVwpStore((s) => s.error);
  const columns = useVwpStore((s) => s.columns);
  const setColumns = useVwpStore((s) => s.setColumns);
  const site = useNexradStore((s) => s.site);

  const [hover, setHover] = useState<{ col: number; level: VwpLevel } | null>(null);

  const maxFt = useMemo(() => {
    const hs = data?.meta.heightsFt ?? [];
    return hs.length ? Math.max(10000, Math.ceil(Math.max(...hs) / 5000) * 5000) : 20000;
  }, [data]);

  const cols = data?.columns ?? [];
  const width = LEFT + Math.max(cols.length, 1) * COL_W + 12;
  const height = TOP + PLOT_H + BOTTOM;

  const yOf = (ft: number) => TOP + PLOT_H - (ft / maxFt) * PLOT_H;

  // Hodograph of the newest column.
  const latest = cols[cols.length - 1];
  const hg: HodoGeom = useMemo(() => {
    let m = 40;
    for (const l of latest?.levels ?? []) m = Math.max(m, l.spdKt);
    return { size: 150, maxKt: Math.ceil((m + 8) / 10) * 10 };
  }, [latest]);

  if (!open) return null;

  return (
    <div className="vwp" role="dialog" aria-label="VAD Wind Profile">
      <header className="vwp__head">
        <div className="vwp__title">
          <Wind size={15} />
          <div>
            <strong>VAD Wind Profile</strong>
            <span>
              {data?.meta.site ?? (site ? `K${site}` : "no radar selected")}
              {data ? ` · ${fmtHHMM(data.meta.validUnix)} · ${data.meta.columns} volumes` : ""}
            </span>
          </div>
        </div>
        <div className="vwp__headbtns">
          <select
            value={columns}
            onChange={(e) => setColumns(Number(e.target.value))}
            title="How many volume scans the display covers"
          >
            {VWP_COLUMN_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n} vols
              </option>
            ))}
          </select>
          {busy && <Loader2 size={14} className="spin" />}
          <button type="button" onClick={() => setOpen(false)} title="Close">
            <X size={15} />
          </button>
        </div>
      </header>

      {error && (
        <div className="vwp__error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      {!error && !data && busy && (
        <div className="vwp__empty">
          <Loader2 size={20} className="spin" />
          <span>Reading the VAD algorithm output…</span>
        </div>
      )}

      {!error && !data && !busy && (
        <div className="vwp__empty">
          <span>Pick a radar site to read its wind profile.</span>
        </div>
      )}

      {data && (
        <div className="vwp__body">
          <div className="vwp__plotwrap">
            <svg
              className="vwp__svg"
              viewBox={`0 0 ${width} ${height}`}
              style={{ minWidth: width }}
              onMouseLeave={() => setHover(null)}
            >
              {/* height gridlines */}
              {Array.from({ length: Math.floor(maxFt / 5000) + 1 }, (_, i) => i * 5000).map((ft) => (
                <g key={ft}>
                  <line
                    x1={LEFT}
                    x2={width - 6}
                    y1={yOf(ft)}
                    y2={yOf(ft)}
                    className="vwp__grid"
                  />
                  <text x={LEFT - 6} y={yOf(ft) + 3.5} className="vwp__ytext">
                    {ft === 0 ? "0" : `${ft / 1000}k`}
                  </text>
                </g>
              ))}
              <text x={12} y={TOP - 8} className="vwp__axlabel">
                ft
              </text>

              {cols.map((c, ci) => {
                const cx = LEFT + ci * COL_W + COL_W / 2;
                return (
                  <g key={c.key}>
                    <rect
                      x={LEFT + ci * COL_W}
                      y={TOP}
                      width={COL_W}
                      height={PLOT_H}
                      className={`vwp__colbg${ci === cols.length - 1 ? " is-latest" : ""}`}
                    />
                    <text x={cx} y={height - 9} className="vwp__xtext">
                      {fmtHHMM(c.unix)}
                    </text>
                    {c.levels.map((l) => {
                      if (l.altFt > maxFt) return null;
                      const y = yOf(l.altFt);
                      const b = windBarb(l.spdKt, 17);
                      return (
                        <g
                          key={`${c.key}-${l.altFt}`}
                          transform={`translate(${cx} ${y})`}
                          onMouseEnter={() => setHover({ col: ci, level: l })}
                        >
                          <circle r={7} fill="transparent" />
                          <g transform={`rotate(${l.dirDeg})`}>
                            <path
                              d={b.d}
                              fill={b.calm ? "none" : speedColor(l.spdKt)}
                              stroke={speedColor(l.spdKt)}
                              strokeWidth={1.5}
                              strokeLinecap="round"
                            />
                          </g>
                          {hover?.col === ci && hover.level.altFt === l.altFt && (
                            <circle r={8} className="vwp__hoverdot" />
                          )}
                        </g>
                      );
                    })}
                  </g>
                );
              })}
            </svg>
          </div>

          <aside className="vwp__side">
            <div className="vwp__readout">
              <span className="vwp__rohead">{hover ? "CURSOR" : "PEAK WIND"}</span>
              {hover ? (
                <dl>
                  <dt>Height</dt>
                  <dd>
                    {hover.level.altFt.toLocaleString()} ft
                    <small> · {Math.round(hover.level.altFt * M_PER_FT)} m</small>
                  </dd>
                  <dt>Wind</dt>
                  <dd>
                    {hover.level.dirDeg}° / {hover.level.spdKt} kt
                  </dd>
                  <dt>RMS</dt>
                  <dd>{hover.level.rmsKt != null ? `${hover.level.rmsKt.toFixed(1)} kt` : "--"}</dd>
                  <dt>Elev cut</dt>
                  <dd>{hover.level.elevDeg != null ? `${hover.level.elevDeg.toFixed(1)}°` : "--"}</dd>
                  <dt>Time</dt>
                  <dd>{fmtHHMM(cols[hover.col]?.unix ?? null)}</dd>
                </dl>
              ) : (
                <dl>
                  <dt>Speed</dt>
                  <dd>{data.meta.maxKt != null ? `${data.meta.maxKt} kt` : "--"}</dd>
                  <dt>Height</dt>
                  <dd>
                    {data.meta.maxAltFt != null ? `${data.meta.maxAltFt.toLocaleString()} ft` : "--"}
                  </dd>
                  <dt>Direction</dt>
                  <dd>{data.meta.maxDirDeg != null ? `${data.meta.maxDirDeg}°` : "--"}</dd>
                </dl>
              )}
            </div>

            <div className="vwp__hodo">
              <span className="vwp__rohead">HODOGRAPH · latest</span>
              <svg viewBox={`0 0 ${hg.size} ${hg.size}`} aria-label="VAD hodograph">
                {[10, 20, 30, 40, 50, 60, 70, 80]
                  .filter((r) => r <= hg.maxKt)
                  .map((r) => (
                    <circle
                      key={r}
                      cx={hg.size / 2}
                      cy={hg.size / 2}
                      r={(r / hg.maxKt) * (hg.size / 2)}
                      className="vwp__hodoring"
                    />
                  ))}
                <line x1={0} x2={hg.size} y1={hg.size / 2} y2={hg.size / 2} className="vwp__hodoaxis" />
                <line x1={hg.size / 2} x2={hg.size / 2} y1={0} y2={hg.size} className="vwp__hodoaxis" />
                {(latest?.levels ?? []).slice(1).map((l, i) => {
                  const a = latest!.levels[i];
                  const [au, av] = uvOf(a.dirDeg, a.spdKt);
                  const [bu, bv] = uvOf(l.dirDeg, l.spdKt);
                  return (
                    <path
                      key={l.altFt}
                      d={`M${hodoX(hg, au)} ${hodoY(hg, av)}L${hodoX(hg, bu)} ${hodoY(hg, bv)}`}
                      stroke={hodoBandColor(a.altFt * M_PER_FT)}
                      className="vwp__hodoseg"
                    />
                  );
                })}
                {hover && (
                  <circle
                    cx={hodoX(hg, uvOf(hover.level.dirDeg, hover.level.spdKt)[0])}
                    cy={hodoY(hg, uvOf(hover.level.dirDeg, hover.level.spdKt)[1])}
                    r={3.5}
                    className="vwp__hodocur"
                  />
                )}
              </svg>
            </div>

            <div className="vwp__key">
              {[
                [0, "<20"],
                [20, "20-35"],
                [35, "35-50"],
                [50, "50-65"],
                [65, "65+"],
              ].map(([kt, label]) => (
                <span key={label as string}>
                  <i style={{ background: speedColor(kt as number) }} />
                  {label} kt
                </span>
              ))}
            </div>
            <p className="vwp__note">{data.meta.source}</p>
          </aside>
        </div>
      )}
    </div>
  );
}
