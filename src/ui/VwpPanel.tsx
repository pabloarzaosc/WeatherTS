import { useMemo, useState } from "react";
import { AlertTriangle, Loader2, Maximize2, Minimize2, Wind, X } from "lucide-react";
import { Select } from "./Select";

import { windBarb } from "../lib/skewt";
import type { VwpLevel } from "../lib/nexrad";
import { useNexradStore } from "../store/useNexradStore";
import { useVwpStore, VWP_COLUMN_CHOICES } from "../store/useVwpStore";

const M_PER_FT = 0.3048;

/**
 * The altitude ladder the NEXRAD VWP product reports on: every 1000 ft to
 * 20 kft, then coarser as the returns thin out. Fixed, not derived from the
 * data -- a row the radar found nothing for is information ("ND"), and a plot
 * whose axis quietly shrinks to whatever came back hides exactly that.
 */
const LADDER = [
  50, 45, 40, 35, 30, 28, 26, 24, 22, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11,
  10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
];

const LABEL_W = 36;
const COL_W = 32;
const ROW_H = 14;
const HEAD_H = 17;
const TIME_H = 26;
const BARB_LEN = 17;

function fmtHHMM(unix: number | null): string {
  if (!unix) return "--";
  const d = new Date(unix * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}Z`;
}

/** 1638 — the four-digit UTC stamp the display's time axis uses. */
function fmtHHMMc(unix: number | null): string {
  if (!unix) return "----";
  const d = new Date(unix * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}`;
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
 * Bin one volume's levels onto the ladder.
 *
 * The VAD resolves winds at whatever heights its elevation cuts happened to
 * intersect -- 1700 ft, 3100 ft, 5900 ft -- so each level goes to its NEAREST
 * ladder row rather than into a fixed window. A window drops anything that
 * falls between two rows; nearest-row keeps every level and only ever has to
 * choose between two that describe the same layer, where the lower RMS wins.
 */
function binToLadder(levels: VwpLevel[]): Map<number, VwpLevel> {
  const out = new Map<number, VwpLevel>();
  for (const lv of levels) {
    let row = LADDER[0];
    let bestGap = Infinity;
    for (const kft of LADDER) {
      const gap = Math.abs(kft * 1000 - lv.altFt);
      if (gap < bestGap) {
        bestGap = gap;
        row = kft;
      }
    }
    const held = out.get(row);
    if (!held) {
      out.set(row, lv);
      continue;
    }
    const heldGap = Math.abs(row * 1000 - held.altFt);
    const better =
      bestGap < heldGap ||
      (bestGap === heldGap && (lv.rmsKt ?? 99) < (held.rmsKt ?? 99));
    if (better) out.set(row, lv);
  }
  return out;
}

/**
 * VAD Wind Profile — the radar's own wind profile as the classic time-height
 * display: altitude up the side in thousands of feet, one column per volume
 * scan, a barb wherever the algorithm resolved a wind and ND wherever it did
 * not.
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
  // Opens full screen, the way a sounding does. 29 rows of barbs across a dozen
  // volumes is a reading surface, not a status corner: at the docked size the
  // cells were ~12 px and the whole point of the display -- watching the profile
  // change column to column -- needed squinting. The toggle still docks it.
  const [expanded, setExpanded] = useState(true);

  const cols = data?.columns ?? [];
  const binned = useMemo(() => cols.map((c) => binToLadder(c.levels)), [cols]);

  const width = LABEL_W + Math.max(cols.length, 1) * COL_W;
  const timeY = HEAD_H + LADDER.length * ROW_H;
  const height = timeY + TIME_H;

  if (!open) return null;

  return (
    <div className={`vwp${expanded ? " is-expanded" : ""}`} role="dialog" aria-label="VAD Wind Profile">
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
          <Select
            className="vwp__cols"
            value={String(columns)}
            onChange={(value) => setColumns(Number(value))}
            aria-label="How many volume scans the display covers"
            options={VWP_COLUMN_CHOICES.map((n) => ({ value: String(n), label: `${n} vols` }))}
          />
          {busy && <Loader2 size={14} className="spin" />}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Restore" : "Full screen"}
            aria-pressed={expanded}
          >
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
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
              preserveAspectRatio="xMidYMin meet"
              onMouseLeave={() => setHover(null)}
              role="img"
              aria-label="VAD wind profile time-height display"
            >
              <rect x={0} y={0} width={width} height={height} className="vwpc__bg" />

              <text x={4} y={12} className="vwpc__corner">
                ALT KFT
              </text>
              <line x1={0} y1={HEAD_H} x2={width} y2={HEAD_H} className="vwpc__rule" />

              {LADDER.map((kft, ri) => {
                const top = HEAD_H + ri * ROW_H;
                const mid = top + ROW_H / 2;
                return (
                  <g key={kft}>
                    <line
                      x1={0}
                      x2={width}
                      y1={top + ROW_H}
                      y2={top + ROW_H}
                      className="vwpc__grid"
                    />
                    <text x={LABEL_W - 7} y={mid + 3.2} className="vwpc__alt">
                      {kft}
                    </text>
                    {cols.map((c, ci) => {
                      const lv = binned[ci]?.get(kft);
                      const cx = LABEL_W + ci * COL_W + COL_W / 2;
                      if (!lv) {
                        return (
                          <text key={c.key} x={cx} y={mid + 3.2} className="vwpc__nd">
                            ND
                          </text>
                        );
                      }
                      const b = windBarb(lv.spdKt, BARB_LEN);
                      const hot = hover?.col === ci && hover.level.altFt === lv.altFt;
                      return (
                        <g
                          key={c.key}
                          transform={`translate(${cx} ${mid})`}
                          onMouseEnter={() => setHover({ col: ci, level: lv })}
                        >
                          <rect
                            x={-COL_W / 2}
                            y={-ROW_H / 2}
                            width={COL_W}
                            height={ROW_H}
                            fill="transparent"
                          />
                          <g transform={`rotate(${lv.dirDeg})`}>
                            <path
                              d={b.d}
                              fill={b.calm ? "none" : speedColor(lv.spdKt)}
                              stroke={speedColor(lv.spdKt)}
                              strokeWidth={1.2}
                              strokeLinecap="round"
                            />
                          </g>
                          {hot && <circle r={6} className="vwp__hoverdot" />}
                        </g>
                      );
                    })}
                  </g>
                );
              })}

              <line x1={0} y1={timeY} x2={width} y2={timeY} className="vwpc__rule" />
              <text x={4} y={timeY + 17} className="vwpc__corner">
                TIME
              </text>
              {cols.map((c, ci) => {
                const cx = LABEL_W + ci * COL_W + COL_W / 2;
                return (
                  <g key={c.key}>
                    <line x1={cx} x2={cx} y1={timeY} y2={timeY + 5} className="vwpc__tick" />
                    <text x={cx} y={timeY + 17} className="vwpc__time">
                      {fmtHHMMc(c.unix)}
                    </text>
                  </g>
                );
              })}

              <rect
                x={0.5}
                y={0.5}
                width={width - 1}
                height={height - 1}
                className="vwpc__frame"
              />
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
