/**
 * The 3D view's colour bar with its opacity-curve editor (Radar style), and
 * the cut-plane controls.
 *
 * The curve is drawn over the palette: the area under it filled with the
 * palette's colours. Editing: drag a point, double-click to add one,
 * right-click a point to remove it. A curve can be kept under a name, saved
 * to a JSON file and read back (Import, or drop the file on the bar).
 */
import { useMemo, useRef, useState } from "react";
import { ChartSpline, FileDown, FileUp, RotateCcw, Save, Trash2, X } from "lucide-react";

import { downloadBlob } from "../lib/gifExport";
import { cleanPoints, curveAt, CURVE_FORMAT, isPreset, presetPoints, type CurveId, type CurvePoint, type OpacityPreset, type SavedCurve } from "../lib/radar3d/lut";
import type { Volume3DHeader } from "../lib/radar3d/volume";
import { useRadar3DStore, type Cut3D } from "../store/useRadar3DStore";

type Hdr = Pick<Volume3DHeader, "kind" | "vmin" | "vmax" | "units" | "productLabel">;

/** The points of the curve on show for this moment. */
export function activePoints(
  h: Pick<Volume3DHeader, "kind" | "vmin" | "vmax">,
  curve: CurveId,
  custom: Record<string, CurvePoint[]>,
  saved: SavedCurve[],
): CurvePoint[] {
  if (isPreset(curve)) return presetPoints(h, curve);
  if (curve === "custom") return custom[h.kind] ?? presetPoints(h, "soft");
  const name = curve.slice(6);
  return saved.find((c) => c.name === name && c.kind === h.kind)?.points ?? presetPoints(h, "soft");
}

/** What buildLut3D takes: the preset itself (exact) or the points. */
export function lutCurve(
  h: Pick<Volume3DHeader, "kind" | "vmin" | "vmax">,
  curve: CurveId,
  custom: Record<string, CurvePoint[]>,
  saved: SavedCurve[],
): OpacityPreset | CurvePoint[] {
  return isPreset(curve) ? curve : activePoints(h, curve, custom, saved);
}

const PLOT_H = 46;
const PLOT_H_SMALL = 22;

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a < 1e-6) return "0";
  if (Number.isInteger(Number(v.toFixed(6)))) return v.toFixed(0);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(0) : a >= 1 ? v.toFixed(1) : v.toFixed(2);
}

function ticks(lo: number, hi: number, n = 6): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

export function Radar3DColorBar({ h, lut }: { h: Hdr; lut: Uint8Array | null }) {
  const st = useRadar3DStore();
  const [editing, setEditing] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [width, setWidth] = useState(300);
  const plotRef = useRef<SVGSVGElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const drag = useRef<number | null>(null);
  const pts = activePoints(h, st.curve, st.customCurves, st.savedCurves);
  const span = h.vmax - h.vmin || 1;
  const H = editing ? PLOT_H : PLOT_H_SMALL;
  const W = width;
  const x = (v: number) => ((v - h.vmin) / span) * W;
  const y = (a: number) => H - 2 - a * (H - 4);

  // The palette as gradient stops (row 1 of the table: the colours as they are).
  const stops = useMemo(() => {
    if (!lut) return [] as { o: number; c: string }[];
    const out: { o: number; c: string }[] = [];
    for (let i = 0; i <= 32; i++) {
      const code = 1 + Math.round((i / 32) * 253);
      const o = (256 + code) * 4;
      out.push({ o: i / 32, c: `rgb(${lut[o]},${lut[o + 1]},${lut[o + 2]})` });
    }
    return out;
  }, [lut]);

  const area = useMemo(() => {
    const steps = 64;
    let d = `M0 ${H}`;
    for (let i = 0; i <= steps; i++) {
      const v = h.vmin + (span * i) / steps;
      d += ` L${((i / steps) * W).toFixed(1)} ${y(curveAt(pts, v)).toFixed(1)}`;
    }
    return `${d} L${W} ${H} Z`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, W, H, h.vmin, span]);

  const line = pts.map(([v, a]) => `${x(v).toFixed(1)},${y(a).toFixed(1)}`).join(" ");
  const edit = (next: CurvePoint[]) => st.setCurvePoints(h.kind, next);

  const toValue = (e: React.PointerEvent | React.MouseEvent): [number, number] => {
    const r = plotRef.current!.getBoundingClientRect();
    const fx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const fy = Math.max(0, Math.min(1, (H - 2 - (e.clientY - r.top)) / (H - 4)));
    return [h.vmin + fx * span, fy];
  };
  const onDown = (i: number) => (e: React.PointerEvent) => {
    if (!editing || e.button !== 0) return;
    e.stopPropagation();
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      /* a pointer the browser no longer tracks: the drag still follows moves over the plot */
    }
    drag.current = i;
  };
  const onMove = (e: React.PointerEvent) => {
    const i = drag.current;
    if (i == null) return;
    const [v, a] = toValue(e);
    const lo = i > 0 ? pts[i - 1][0] + span * 0.002 : h.vmin - span;
    const hi = i < pts.length - 1 ? pts[i + 1][0] - span * 0.002 : h.vmax + span;
    const next = pts.map((p) => [p[0], p[1]] as CurvePoint);
    next[i] = [Math.round(Math.max(lo, Math.min(hi, v)) * 1000) / 1000, Math.round(a * 1000) / 1000];
    edit(next);
  };
  const onUp = () => {
    drag.current = null;
  };
  const addPoint = (e: React.MouseEvent) => {
    if (!editing || pts.length >= 32) return;
    const [v, a] = toValue(e);
    edit([...pts, [Math.round(v * 1000) / 1000, Math.round(a * 1000) / 1000] as CurvePoint].sort((p, q) => p[0] - q[0]));
  };
  const removePoint = (i: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    if (!editing || pts.length <= 2) return;
    edit(pts.filter((_, k) => k !== i));
  };

  const savedName = st.curve.startsWith("saved:") ? st.curve.slice(6) : null;
  const exportCurve = () => {
    const name = savedName ?? (isPreset(st.curve) ? st.curve : `${h.kind}-custom`);
    const body = { format: CURVE_FORMAT, version: 1, name, moment: h.kind, product: h.productLabel, units: h.units, points: pts };
    downloadBlob(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }), `${name.replace(/[^\w.-]+/g, "_")}.opacity.json`);
  };
  const importText = (text: string, fileName: string) => {
    try {
      const raw = JSON.parse(text) as { format?: string; name?: string; moment?: string; points?: unknown };
      const p = cleanPoints(raw.points);
      if (!p) {
        setNote(`${fileName}: no curve in it (2 to 32 points of [value, opacity]).`);
        return;
      }
      const kind = typeof raw.moment === "string" && raw.moment ? raw.moment : h.kind;
      const name = (typeof raw.name === "string" && raw.name.trim()) || fileName.replace(/\.(opacity\.)?json$/i, "");
      if (kind !== h.kind) {
        useRadar3DStore.setState((s) => ({ savedCurves: [...s.savedCurves.filter((c) => !(c.name === name && c.kind === kind)), { name, kind, points: p }] }));
        st.setCurve(st.curve);
        setNote(`"${name}" is a ${kind.toUpperCase()} curve: kept for when that moment is on show.`);
        return;
      }
      st.saveCurve(name, kind, p);
      setNote(`Read "${name}".`);
    } catch {
      setNote(`${fileName} is not a curve file.`);
    }
  };
  const onFiles = (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    void f.text().then((t) => importText(t, f.name));
  };

  return (
    <div
      className={`r3d-cbar${editing ? " is-editing" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onFiles(e.dataTransfer.files);
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="r3d-cbar__head">
        <span>
          {h.productLabel}
          {h.units ? ` · ${h.units}` : ""}
        </span>
        <button
          type="button"
          className={editing ? "is-on" : ""}
          onClick={() => {
            setEditing((v) => !v);
            setNaming(null);
            setNote(null);
          }}
          title={editing ? "Done editing" : "Edit the opacity curve"}
          aria-pressed={editing}
        >
          {editing ? <X size={13} /> : <ChartSpline size={13} />}
        </button>
      </div>
      <svg
        ref={(el) => {
          plotRef.current = el;
          if (el) {
            const w = Math.round(el.getBoundingClientRect().width);
            if (w > 40 && Math.abs(w - width) > 1) setWidth(w);
          }
        }}
        className="r3d-cbar__plot"
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={addPoint}
        onContextMenu={(e) => e.preventDefault()}
        role="img"
        aria-label="Opacity curve over the colour scale"
      >
        <defs>
          <linearGradient id={`r3d-pal-${h.kind}`} x1="0" x2="1" y1="0" y2="0">
            {stops.map((s) => (
              <stop key={s.o} offset={s.o} stopColor={s.c} />
            ))}
          </linearGradient>
        </defs>
        <rect x={0} y={0} width={W} height={H} className="r3d-cbar__bed" />
        <path d={area} fill={`url(#r3d-pal-${h.kind})`} />
        <polyline points={line} className="r3d-cbar__line" />
        {editing &&
          pts.map(([v, a], i) => (
            <circle
              key={i}
              cx={x(v)}
              cy={y(a)}
              r={4.5}
              className="r3d-cbar__pt"
              onPointerDown={onDown(i)}
              onContextMenu={removePoint(i)}
            >
              <title>{`${fmt(v)} ${h.units}: ${(a * 100).toFixed(0)}%`}</title>
            </circle>
          ))}
      </svg>
      <div className="r3d-cbar__strip" style={{ background: `linear-gradient(to right, ${stops.map((s) => `${s.c} ${(s.o * 100).toFixed(1)}%`).join(", ")})` }} />
      <div className="r3d-cbar__ticks">
        {ticks(h.vmin, h.vmax).map((v) => (
          <span key={v} style={{ left: `${(((v - h.vmin) / span) * 100).toFixed(2)}%` }}>
            {fmt(v)}
          </span>
        ))}
      </div>
      {editing && (
        <div className="r3d-cbar__tools">
          {naming != null ? (
            <form
              className="r3d-cbar__name"
              onSubmit={(e) => {
                e.preventDefault();
                const n = naming.trim();
                if (!n) return;
                st.saveCurve(n, h.kind, pts);
                setNaming(null);
                setNote(`Kept as "${n}".`);
              }}
            >
              <input autoFocus value={naming} maxLength={40} placeholder="Curve name" onChange={(e) => setNaming(e.target.value)} />
              <button type="submit" disabled={!naming.trim()}>
                Save
              </button>
              <button type="button" onClick={() => setNaming(null)}>
                Cancel
              </button>
            </form>
          ) : (
            <>
              <button type="button" onClick={() => setNaming(savedName ?? "")} title="Keep this curve under a name">
                <Save size={12} />
                Save as
              </button>
              <button type="button" onClick={exportCurve} title="Save the curve to a JSON file">
                <FileDown size={12} />
                Export
              </button>
              <button type="button" onClick={() => fileRef.current?.click()} title="Read a curve file (or drop one on the bar)">
                <FileUp size={12} />
                Import
              </button>
              <button type="button" onClick={() => st.setCurve("soft")} title="Back to the Soft preset">
                <RotateCcw size={12} />
                Reset
              </button>
              {savedName && (
                <button type="button" onClick={() => st.deleteCurve(savedName, h.kind)} title={`Forget "${savedName}"`}>
                  <Trash2 size={12} />
                </button>
              )}
            </>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              onFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      )}
      {editing && <div className="r3d-cbar__note">{note ?? "Drag a point · double-click to add · right-click to remove"}</div>}
    </div>
  );
}

/** Where a segment (box km) crosses the box, or null when it misses. */
export function lineInBox(a: [number, number], b: [number, number], hx: number, hy: number): [[number, number], [number, number]] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const edges: [number, number][] = [
    [-dx, a[0] + hx],
    [dx, hx - a[0]],
    [-dy, a[1] + hy],
    [dy, hy - a[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return null;
  }
  return [
    [a[0] + dx * t0, a[1] + dy * t0],
    [a[0] + dx * t1, a[1] + dy * t1],
  ];
}

/** The plane of a drawn line (box km): its direction and offset. */
export function planeOfLine(a: [number, number], b: [number, number]): { dir: number; pos: number } {
  let dir = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
  dir = ((dir % 180) + 180) % 180;
  const r = (dir * Math.PI) / 180;
  return { dir, pos: a[0] * Math.cos(r) - a[1] * Math.sin(r) };
}

export function Radar3DCutBar({ cut, reach, line, onClose }: { cut: Cut3D; reach: number; line: boolean; onClose: () => void }) {
  const setCut = useRadar3DStore((s) => s.setCut);
  const follow = cut.follow && line;
  return (
    <div className="r3d-cut" onPointerDown={(e) => e.stopPropagation()}>
      <div className="r3d-cut__head">
        <strong>Cut</strong>
        <button type="button" onClick={onClose} title="No cut">
          <X size={13} />
        </button>
      </div>
      <label className="r3d__slider">
        <span>Direction {cut.dir.toFixed(0)}°</span>
        <input type="range" min={0} max={179} step={1} value={Math.round(cut.dir)} disabled={follow} onChange={(e) => setCut({ dir: Number(e.target.value) })} />
      </label>
      <label className="r3d__slider">
        <span>Position {cut.pos >= 0 ? "+" : ""}{cut.pos.toFixed(1)} km</span>
        <input type="range" min={-reach} max={reach} step={0.5} value={Math.max(-reach, Math.min(reach, cut.pos))} disabled={follow} onChange={(e) => setCut({ pos: Number(e.target.value) })} />
      </label>
      <label className="r3d__slider">
        <span>Opacity {(cut.opacity * 100).toFixed(0)}%</span>
        <input type="range" min={0} max={1} step={0.05} value={cut.opacity} onChange={(e) => setCut({ opacity: Number(e.target.value) })} />
      </label>
      <label className="r3d__check">
        <input type="checkbox" checked={cut.away} onChange={(e) => setCut({ away: e.target.checked })} />
        Cut away the near side
      </label>
      <label className="r3d__check" title={line ? "Lie along the cross-section line on the map" : "Draw a cross-section line across the box on the map first"}>
        <input type="checkbox" checked={cut.follow} disabled={!line && !cut.follow} onChange={(e) => setCut({ follow: e.target.checked })} />
        Follow the drawn line
      </label>
      {cut.follow && !line && <span className="r3d-cut__note">No cross-section line crosses the box.</span>}
    </div>
  );
}
