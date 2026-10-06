import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";

import type { Series } from "../../lib/space/data";
import { useElementSize } from "../../lib/useElementSize";
import { useThemeStore } from "../../store/useThemeStore";

/**
 * Charts stacked on one time axis, the way SWPC and every space weather
 * dashboard draws the solar wind: one cursor runs down all of them and reads
 * every series at that minute.
 *
 * Drag across any chart to zoom to that stretch, the wheel zooms about the
 * pointer, Shift-drag pans, a double click goes back to the whole range. The
 * legend under each title is the readout, and clicking a name hides that line.
 */

export interface ChartSeries {
  label: string;
  color: string;
  data: Series;
  width?: number;
  dash?: number[];
  kind?: "line" | "bars" | "dots" | "step";
  /** Bars: how long each bar lasts. */
  barMs?: number;
  /** Bars: a colour per value. */
  colorOf?: (v: number, i: number) => string;
  fmt?: (v: number) => string;
  /** Starts hidden; a click on its name brings it in. */
  off?: boolean;
  /** A gap longer than this breaks the line (default: 5 times the usual spacing). */
  gapMs?: number;
}

export interface ChartBand {
  from: number;
  to: number;
  color: string;
  label?: string;
}

export interface ChartLine {
  y: number;
  color: string;
  label?: string;
  dash?: number[];
}

export interface ChartPanel {
  id: string;
  title: string;
  units?: string;
  series: ChartSeries[];
  log?: boolean;
  /** A fixed value range; otherwise it follows the data in view. */
  y?: [number, number];
  /** Values the automatic range always takes in. */
  include?: number[];
  /** The automatic range is centred on zero (Bz). */
  symmetric?: boolean;
  /** Value-axis tick spacing, instead of a step picked to the height. */
  step?: number;
  /** Low values at the top: a rank, where 1 is best. */
  invert?: boolean;
  bands?: ChartBand[];
  lines?: ChartLine[];
  weight?: number;
  fmt?: (v: number) => string;
  tickFmt?: (v: number) => string;
  /** Text in the empty chart when there is nothing to draw. */
  empty?: string;
}

export interface XBand {
  from: number;
  to: number;
  color: string;
  label?: string;
}

interface Props {
  panels: ChartPanel[];
  /** The whole range, before any zoom. */
  domain: [number, number];
  xBands?: XBand[];
  /** Mark now with a dashed line (on by default). */
  now?: boolean;
  /** Follows the cursor: the time under it, or null when it leaves. */
  onHover?: (t: number | null) => void;
  /** Zoom to this stretch whenever it changes (a flare picked from a list). */
  focus?: [number, number] | null;
  className?: string;
}

/** Room for the value labels on the left and the threshold names on the
 *  right: less of it on a phone, where 100 px of margins is a third of the chart. */
function margins(w: number) {
  return w < 520 ? { left: 40, right: 30, top: 4, bottom: 4 } : { left: 58, right: 44, top: 4, bottom: 4 };
}
const AXIS_H = 18;

interface Theme {
  text: string;
  dim: string;
  faint: string;
  border: string;
  accent: string;
  mono: string;
}

function readTheme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, f: string) => cs.getPropertyValue(n).trim() || f;
  return {
    text: v("--text", "#ececec"),
    dim: v("--text-dim", "#b8b8b8"),
    faint: v("--text-faint", "#8e8e8e"),
    border: v("--border", "#353535"),
    accent: v("--accent", "#6c9dff"),
    mono: v("--mono", "monospace"),
  };
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

export function fmtUtc(t: number, withDate = true): string {
  const d = new Date(t);
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
  // The year only when it is not this one: a product that stopped in 2023 should say so.
  const y = d.getUTCFullYear() !== new Date().getUTCFullYear() ? ` ${d.getUTCFullYear()}` : "";
  return withDate ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${y} ${hm}` : hm;
}

/** 2.1e-6, 540, 12.3, 0.45 -- as many digits as the size of the number earns. */
export function fmtAuto(v: number): string {
  if (!Number.isFinite(v)) return "--";
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.01 || a >= 1e6)) return v.toExponential(1);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function niceStep(span: number, n: number): number {
  const raw = span / Math.max(1, n);
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}

/** Index of the last point at or before t. */
function bisect(t: Float64Array, x: number): number {
  let a = 0;
  let b = t.length - 1;
  if (b < 0 || x < t[0]) return -1;
  if (x >= t[b]) return b;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (t[m] <= x) a = m;
    else b = m;
  }
  return a;
}

/** The reading at a time: the nearest point, if it is close enough to count. */
function valueAt(s: ChartSeries, t: number): number | null {
  const { t: ts, v } = s.data;
  if (!ts.length) return null;
  if (s.kind === "bars") {
    const i = bisect(ts, t);
    if (i < 0) return null;
    return t < ts[i] + (s.barMs ?? HOUR) ? v[i] : null;
  }
  let i = bisect(ts, t);
  if (i < 0) i = 0;
  if (i < ts.length - 1 && Math.abs(ts[i + 1] - t) < Math.abs(ts[i] - t)) i++;
  const tol = Math.max(typicalStep(s.data) * 1.5, MIN);
  return Math.abs(ts[i] - t) <= tol && Number.isFinite(v[i]) ? v[i] : null;
}

const stepCache = new WeakMap<Series, number>();
function typicalStep(s: Series): number {
  const hit = stepCache.get(s);
  if (hit != null) return hit;
  const n = s.t.length;
  const d: number[] = [];
  for (let i = 1; i < n; i += Math.max(1, Math.floor(n / 200))) d.push(s.t[i] - s.t[i - 1]);
  d.sort((a, b) => a - b);
  const step = d.length ? d[d.length >> 1] || MIN : MIN;
  stepCache.set(s, step);
  return step;
}

interface YAxis {
  lo: number;
  hi: number;
  log: boolean;
  y: (v: number) => number;
  ticks: number[];
}

function yAxis(p: ChartPanel, hidden: Set<string>, view: [number, number], top: number, h: number): YAxis {
  let lo = Infinity;
  let hi = -Infinity;
  const log = !!p.log;
  if (p.y) {
    [lo, hi] = p.y;
  } else {
    for (const s of p.series) {
      if (hidden.has(s.label)) continue;
      const { t, v } = s.data;
      const i0 = Math.max(0, bisect(t, view[0]));
      const i1 = Math.min(t.length - 1, bisect(t, view[1]) + 1);
      for (let i = i0; i <= i1; i++) {
        const x = v[i];
        if (!Number.isFinite(x) || (log && x <= 0)) continue;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    }
    for (const x of p.include ?? []) {
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    if (!Number.isFinite(lo)) {
      lo = log ? 1e-9 : 0;
      hi = log ? 1e-3 : 1;
    }
    if (p.symmetric) {
      const m = Math.max(Math.abs(lo), Math.abs(hi), 1);
      lo = -m;
      hi = m;
    }
    if (log) {
      lo = 10 ** Math.floor(Math.log10(lo));
      hi = 10 ** Math.ceil(Math.log10(hi));
      if (hi / lo < 100) hi = lo * 100;
    } else {
      if (hi === lo) {
        hi += 1;
        lo -= 1;
      }
      const pad = (hi - lo) * 0.06;
      if (!(lo === 0 && (p.include ?? []).includes(0))) lo -= pad;
      hi += pad;
    }
  }
  if (log) {
    const a = Math.log10(lo);
    const b = Math.log10(hi);
    const y = (v: number) => top + (1 - (Math.log10(v) - a) / (b - a)) * h;
    const ticks: number[] = [];
    const every = Math.max(1, Math.ceil((b - a) / Math.max(2, h / 22)));
    for (let e = Math.ceil(a); e <= b + 1e-9; e += every) ticks.push(10 ** e);
    return { lo, hi, log, y, ticks };
  }
  const step = p.step ?? niceStep(hi - lo, Math.max(2, Math.round(h / 34)));
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  const y = p.invert ? (v: number) => top + ((v - lo) / (hi - lo)) * h : (v: number) => top + (1 - (v - lo) / (hi - lo)) * h;
  return { lo, hi, log, y, ticks };
}

/** Ticks for the time axis: minutes up to years, as many as fit. */
function timeTicks(a: number, b: number, w: number): { ticks: number[]; label: (t: number) => string } {
  const span = b - a;
  const fit = Math.max(2, Math.floor(w / 78));
  if (span > 3 * 365 * DAY) {
    const years = span / (365.25 * DAY);
    const step = [1, 2, 5, 10, 20, 25, 50, 100].find((s) => years / s <= fit) ?? 100;
    const y0 = Math.ceil(new Date(a).getUTCFullYear() / step) * step;
    const ticks: number[] = [];
    for (let y = y0; Date.UTC(y, 0, 1) <= b; y += step) ticks.push(Date.UTC(y, 0, 1));
    return { ticks, label: (t) => String(new Date(t).getUTCFullYear()) };
  }
  if (span > 75 * DAY) {
    const months = span / (30.4 * DAY);
    const step = [1, 2, 3, 6, 12].find((s) => months / s <= fit) ?? 12;
    const d = new Date(a);
    let y = d.getUTCFullYear();
    let m = Math.ceil((d.getUTCMonth() + 1) / step) * step;
    const ticks: number[] = [];
    for (;;) {
      while (m >= 12) {
        m -= 12;
        y++;
      }
      const t = Date.UTC(y, m, 1);
      if (t > b) break;
      if (t >= a) ticks.push(t);
      m += step;
    }
    return { ticks, label: (t) => { const x = new Date(t); return x.getUTCMonth() === 0 ? String(x.getUTCFullYear()) : `${MONTHS[x.getUTCMonth()]} ${String(x.getUTCFullYear()).slice(2)}`; } };
  }
  const steps = [MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY];
  const step = steps.find((s) => span / s <= fit) ?? 14 * DAY;
  const ticks: number[] = [];
  for (let t = Math.ceil(a / step) * step; t <= b; t += step) ticks.push(t);
  return {
    ticks,
    label: (t) => {
      const d = new Date(t);
      if (step >= DAY || (d.getUTCHours() === 0 && d.getUTCMinutes() === 0)) return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
      return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    },
  };
}

/** A series colour may be a theme variable ("var(--sx-wind)"): a line in the text colour has to flip with the theme. */
function resolveColor(c: string): string {
  if (!c.startsWith("var(")) return c;
  return getComputedStyle(document.documentElement).getPropertyValue(c.slice(4, -1)).trim() || "#888";
}

function drawSeries(ctx: CanvasRenderingContext2D, s: ChartSeries, view: [number, number], x: (t: number) => number, ya: YAxis, plotBottom: number) {
  const color = resolveColor(s.color);
  const { t, v } = s.data;
  if (!t.length) return;
  const i0 = Math.max(0, bisect(t, view[0]) - 1);
  const i1 = Math.min(t.length - 1, bisect(t, view[1]) + 1);
  if (s.kind === "bars") {
    const bw = s.barMs ?? HOUR;
    const base = ya.log ? plotBottom : ya.y(Math.max(ya.lo, 0));
    for (let i = Math.max(0, i0); i <= i1; i++) {
      const val = v[i];
      if (!Number.isFinite(val)) continue;
      const xa = x(t[i]);
      const xb = x(t[i] + bw);
      const yv = ya.y(Math.min(Math.max(val, ya.lo), ya.hi));
      ctx.fillStyle = s.colorOf ? s.colorOf(val, i) : color;
      ctx.fillRect(xa + 0.5, Math.min(yv, base), Math.max(1, xb - xa - 1), Math.abs(base - yv));
    }
    return;
  }
  if (s.kind === "dots") {
    ctx.fillStyle = color;
    for (let i = i0; i <= i1; i++) {
      const val = v[i];
      if (!Number.isFinite(val) || (ya.log && val <= 0)) continue;
      if (s.colorOf) ctx.fillStyle = s.colorOf(val, i);
      ctx.beginPath();
      ctx.arc(x(t[i]), ya.y(val), 2, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  const gap = s.gapMs ?? typicalStep(s.data) * 5;
  ctx.strokeStyle = color;
  ctx.lineWidth = s.width ?? 1.4;
  ctx.setLineDash(s.dash ?? []);
  ctx.lineJoin = "round";
  ctx.beginPath();
  let pen = false;
  let prevT = -Infinity;
  // Several points to a pixel column collapse to the column's low and high:
  // a week of minutes is ten thousand points across a few hundred pixels.
  let col = NaN;
  let cMin = 0;
  let cMax = 0;
  let cLast = 0;
  const flush = () => {
    if (Number.isNaN(col)) return;
    if (cMin !== cMax) {
      ctx.lineTo(col, cMin);
      ctx.lineTo(col, cMax);
    }
    ctx.lineTo(col, cLast);
  };
  for (let i = i0; i <= i1; i++) {
    const val = v[i];
    if (!Number.isFinite(val) || (ya.log && val <= 0) || t[i] - prevT > gap) {
      flush();
      col = NaN;
      pen = false;
      if (!Number.isFinite(val) || (ya.log && val <= 0)) {
        prevT = -Infinity;
        continue;
      }
    }
    const px = Math.round(x(t[i]));
    const py = ya.y(val);
    if (!pen) {
      ctx.moveTo(px, py);
      pen = true;
      col = px;
      cMin = cMax = cLast = py;
    } else if (px === col) {
      if (py < cMin) cMin = py;
      if (py > cMax) cMax = py;
      cLast = py;
    } else {
      flush();
      if (s.kind === "step") ctx.lineTo(px, cLast);
      col = px;
      cMin = cMax = cLast = py;
    }
    prevT = t[i];
  }
  flush();
  // A step line holds its last value for one more interval: a daily outlook's
  // last day is a day long, not a point.
  if (s.kind === "step" && pen) ctx.lineTo(x(prevT + typicalStep(s.data)), cLast);
  ctx.stroke();
  ctx.setLineDash([]);
}

interface PanelProps {
  panel: ChartPanel;
  view: [number, number];
  hoverT: number | null;
  showAxis: boolean;
  first: boolean;
  xBands?: XBand[];
  now: boolean;
  theme: Theme;
  themeKey: string;
  onPointer: (e: React.PointerEvent<HTMLCanvasElement>, kind: "down" | "move" | "up" | "leave", w: number, left: number) => void;
  onWheel: (t: number, factor: number) => void;
  onReset: () => void;
}

function PanelView({ panel, view, hoverT, showAxis, first, xBands, now, theme, themeKey, onPointer, onWheel, onReset }: PanelProps) {
  const [boxRef, size] = useElementSize<HTMLDivElement>();
  const base = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  // The names the user has clicked, kept apart from each series' own default:
  // a series that arrives with the data, after the first render, still starts
  // the way it asks to.
  const [flipped, setFlipped] = useState<Set<string>>(() => new Set());
  const hidden = useMemo(() => new Set(panel.series.filter((s) => !!s.off !== flipped.has(s.label)).map((s) => s.label)), [panel, flipped]);
  const M = margins(size.w);
  const plotH = Math.max(10, size.h - M.top - M.bottom - (showAxis ? AXIS_H : 0));
  const pw = Math.max(10, size.w - M.left - M.right);
  const x = useCallback((t: number) => M.left + ((t - view[0]) / (view[1] - view[0])) * pw, [view, pw, M.left]);
  const ya = useMemo(() => yAxis(panel, hidden, view, M.top, plotH), [panel, hidden, view, plotH]);
  const fmt = (s: ChartSeries, v: number) => (s.fmt ?? panel.fmt ?? fmtAuto)(v);

  useEffect(() => {
    const cv = base.current;
    if (!cv || size.w < 40 || size.h < 30) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(size.w * dpr);
    cv.height = Math.round(size.h * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const top = M.top;
    const bottom = M.top + plotH;
    // Bands of severity behind everything, named in the right margin.
    for (const b of panel.bands ?? []) {
      const ya0 = ya.y(Math.max(b.from, ya.lo));
      const ya1 = ya.y(Math.min(b.to, ya.hi));
      if (b.to <= ya.lo || b.from >= ya.hi) continue;
      ctx.fillStyle = b.color;
      ctx.fillRect(M.left, ya1, pw, ya0 - ya1);
      // Inside the plot's right edge: the margin belongs to the threshold lines.
      if (b.label && ya0 - ya1 > 9) {
        ctx.fillStyle = theme.faint;
        ctx.font = `800 10px ${theme.mono}`;
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(b.label, M.left + pw - 5, (ya0 + ya1) / 2);
      }
    }
    for (const b of xBands ?? []) {
      if (b.to < view[0] || b.from > view[1]) continue;
      const xa = Math.max(M.left, x(b.from));
      const xb = Math.min(M.left + pw, x(b.to));
      ctx.fillStyle = b.color;
      ctx.fillRect(xa, top, Math.max(1, xb - xa), plotH);
      if (b.label && first && xb - xa > 4) {
        ctx.fillStyle = theme.dim;
        ctx.font = `700 9.5px ${theme.mono}`;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(b.label, xa + 2, top + 2);
      }
    }
    // Grid.
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const v of ya.ticks) {
      const yy = Math.round(ya.y(v)) + 0.5;
      ctx.moveTo(M.left, yy);
      ctx.lineTo(M.left + pw, yy);
    }
    const tt = timeTicks(view[0], view[1], pw);
    for (const t of tt.ticks) {
      const xx = Math.round(x(t)) + 0.5;
      ctx.moveTo(xx, top);
      ctx.lineTo(xx, bottom);
    }
    ctx.stroke();
    // Thresholds, their names nudged apart where two sit close (R2 and R3).
    let lastLabel = Infinity;
    const lines = [...(panel.lines ?? [])].sort((a, b) => ya.y(b.y) - ya.y(a.y));
    for (const l of lines) {
      if (l.y < ya.lo || l.y > ya.hi) continue;
      const yy = Math.round(ya.y(l.y)) + 0.5;
      ctx.strokeStyle = l.color;
      ctx.setLineDash(l.dash ?? [4, 3]);
      ctx.beginPath();
      ctx.moveTo(M.left, yy);
      ctx.lineTo(M.left + pw, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      if (l.label) {
        ctx.fillStyle = l.color;
        ctx.font = `700 10px ${theme.mono}`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const ly = Math.min(yy, lastLabel - 10);
        ctx.fillText(l.label, M.left + pw + 6, ly);
        lastLabel = ly;
      }
    }
    // Data, clipped to the plot.
    ctx.save();
    ctx.beginPath();
    ctx.rect(M.left, top, pw, plotH);
    ctx.clip();
    for (const s of panel.series) if (!hidden.has(s.label)) drawSeries(ctx, s, view, x, ya, bottom);
    ctx.restore();
    // Now.
    const tn = Date.now();
    if (now && tn > view[0] && tn < view[1]) {
      const xx = Math.round(x(tn)) + 0.5;
      ctx.strokeStyle = theme.accent;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(xx, top);
      ctx.lineTo(xx, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Frame and axes.
    ctx.strokeStyle = theme.border;
    ctx.strokeRect(M.left + 0.5, top + 0.5, pw - 1, plotH - 1);
    ctx.fillStyle = theme.dim;
    ctx.font = `10px ${theme.mono}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    let lastY = -100;
    for (const v of ya.ticks) {
      const yy = ya.y(v);
      if (Math.abs(yy - lastY) < 11) continue;
      lastY = yy;
      const label = panel.tickFmt ? panel.tickFmt(v) : ya.log ? `1e${Math.round(Math.log10(v))}` : fmtAuto(v).replace(/\.0+$/, "");
      ctx.fillText(label, M.left - 6, Math.min(Math.max(yy, top + 5), bottom - 5));
    }
    if (panel.units) {
      ctx.save();
      ctx.translate(11, top + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillStyle = theme.faint;
      ctx.fillText(panel.units, 0, 0);
      ctx.restore();
    }
    if (showAxis) {
      ctx.fillStyle = theme.dim;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      let lastX = -100;
      for (const t of tt.ticks) {
        const xx = x(t);
        if (xx - lastX < 60) continue;
        lastX = xx;
        ctx.fillText(tt.label(t), Math.min(Math.max(xx, M.left + 20), M.left + pw - 20), bottom + 5);
      }
    }
    const anyData = panel.series.some((s) => s.data.t.length > 0);
    if (!anyData && panel.empty) {
      ctx.fillStyle = theme.faint;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(panel.empty, M.left + pw / 2, top + plotH / 2);
    }
  }, [panel, hidden, view, size.w, size.h, plotH, pw, x, ya, xBands, now, showAxis, first, theme, themeKey]);

  // The cursor and the points under it, on a layer of their own so following
  // the pointer never redraws a week of minutes.
  useEffect(() => {
    const cv = over.current;
    if (!cv || size.w < 40) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(size.w * dpr)) cv.width = Math.round(size.w * dpr);
    if (cv.height !== Math.round(size.h * dpr)) cv.height = Math.round(size.h * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    if (hoverT == null || hoverT < view[0] || hoverT > view[1]) return;
    const xx = Math.round(x(hoverT)) + 0.5;
    ctx.strokeStyle = theme.dim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xx, M.top);
    ctx.lineTo(xx, M.top + plotH);
    ctx.stroke();
    for (const s of panel.series) {
      if (hidden.has(s.label) || s.kind === "bars") continue;
      const v = valueAt(s, hoverT);
      if (v == null || (ya.log && v <= 0) || v < ya.lo || v > ya.hi) continue;
      ctx.fillStyle = resolveColor(s.color);
      ctx.beginPath();
      ctx.arc(xx, ya.y(v), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [hoverT, view, size.w, size.h, x, ya, panel, hidden, plotH, theme]);

  // The wheel has to be a listener of our own: React's is passive and cannot
  // stop the page from scrolling under the chart.
  useEffect(() => {
    const cv = over.current;
    if (!cv) return;
    const onW = (e: WheelEvent) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const t = view[0] + ((e.clientX - r.left - M.left) / pw) * (view[1] - view[0]);
      onWheel(t, e.deltaY > 0 ? 1.25 : 0.8);
    };
    cv.addEventListener("wheel", onW, { passive: false });
    return () => cv.removeEventListener("wheel", onW);
  }, [view, pw, onWheel, M.left]);

  const at = hoverT ?? null;
  return (
    <div className="spc-chart" style={{ flex: panel.weight ?? 1 }}>
      <div className="spc-chart__head" style={{ paddingLeft: M.left, paddingRight: M.right }}>
        <b>{panel.title}</b>
        <div className="spc-chart__legend">
          {panel.series.map((s) => {
            const off = hidden.has(s.label);
            let v: number | null = null;
            if (at != null) v = valueAt(s, at);
            else {
              for (let i = s.data.v.length - 1; i >= 0; i--)
                if (Number.isFinite(s.data.v[i]) && s.data.t[i] <= Date.now() + 60_000) {
                  v = s.data.v[i];
                  break;
                }
            }
            return (
              <button
                key={s.label}
                type="button"
                className={off ? "is-off" : ""}
                onClick={() =>
                  setFlipped((h) => {
                    const n = new Set(h);
                    if (n.has(s.label)) n.delete(s.label);
                    else n.add(s.label);
                    return n;
                  })
                }
                title={off ? `Show ${s.label}` : `Hide ${s.label}`}
              >
                <i style={{ background: s.color }} />
                {s.label}
                <span>{v == null ? "--" : fmt(s, v)}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="spc-chart__box" ref={boxRef}>
        <canvas ref={base} />
        <canvas
          ref={over}
          onPointerDown={(e) => onPointer(e, "down", pw, M.left)}
          onPointerMove={(e) => onPointer(e, "move", pw, M.left)}
          onPointerUp={(e) => onPointer(e, "up", pw, M.left)}
          onPointerLeave={(e) => onPointer(e, "leave", pw, M.left)}
          onDoubleClick={onReset}
        />
      </div>
    </div>
  );
}

export function TimeStack({ panels, domain, xBands, now = true, onHover, focus, className }: Props) {
  // The user's zoom, if any; otherwise the whole range. Kept apart from the
  // range so the minute-by-minute refresh, which moves the range on, does not
  // throw away a zoom.
  const [userView, setView] = useState<[number, number] | null>(null);
  const view: [number, number] = userView ?? domain;
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const drag = useRef<{ x0: number; t0: number; view: [number, number]; pan: boolean; w: number; left: number } | null>(null);
  const mode = useThemeStore((s) => s.mode);
  const theme = useMemo(readTheme, [mode, document.documentElement.dataset.theme]);
  const stackRef = useRef<HTMLDivElement>(null);

  const span = domain[1] - domain[0];
  const lastSpan = useRef(span);
  useEffect(() => {
    // A new range (1D to 7D) starts unzoomed; the same range moved on by a
    // refresh keeps the zoom.
    if (Math.abs(span - lastSpan.current) > lastSpan.current * 0.1) setView(null);
    lastSpan.current = span;
  }, [span]);
  useEffect(() => {
    if (focus) setView(focus);
  }, [focus?.[0], focus?.[1]]);

  const tAt = (clientX: number, rectLeft: number, pw: number, v: [number, number]) => v[0] + ((clientX - rectLeft) / pw) * (v[1] - v[0]);

  const onPointer = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>, kind: "down" | "move" | "up" | "leave", pw: number, left: number) => {
      const r = e.currentTarget.getBoundingClientRect();
      const t = tAt(e.clientX, r.left + left, pw, view);
      // A finger has no hover: a tap reads the charts at that time instead, and
      // a drag is left to scroll the page.
      if (e.pointerType === "touch") {
        if (kind === "down" || kind === "move") {
          setHoverT(t);
          onHover?.(t);
        }
        return;
      }
      if (kind === "down" && e.button === 0) {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x0: e.clientX, t0: t, view, pan: e.shiftKey, w: pw, left: r.left + left };
        return;
      }
      if (kind === "move") {
        const d = drag.current;
        if (d && d.pan) {
          const dt = ((e.clientX - d.x0) / d.w) * (d.view[1] - d.view[0]);
          setView([d.view[0] - dt, d.view[1] - dt]);
        } else if (d && Math.abs(e.clientX - d.x0) > 4) {
          setSel({ a: Math.min(d.t0, t), b: Math.max(d.t0, t) });
        }
        setHoverT(t);
        onHover?.(t);
        return;
      }
      if (kind === "up") {
        const d = drag.current;
        drag.current = null;
        if (d && !d.pan && Math.abs(e.clientX - d.x0) > 6) {
          const a = Math.min(d.t0, t);
          const b = Math.max(d.t0, t);
          if (b - a > 60_000) setView([a, b]);
        }
        setSel(null);
        return;
      }
      if (kind === "leave" && !drag.current) {
        setHoverT(null);
        onHover?.(null);
      }
    },
    [view, onHover],
  );

  const onWheel = useCallback(
    (t: number, f: number) => {
      setView((cur) => {
        const v = cur ?? domain;
        const span = Math.min((v[1] - v[0]) * f, (domain[1] - domain[0]) * 4);
        if (span < 5 * 60_000) return v;
        const k = (t - v[0]) / (v[1] - v[0]);
        return [t - k * span, t + (1 - k) * span];
      });
    },
    [domain],
  );

  const zoomed = userView != null;
  const selBox = (() => {
    if (!sel || !stackRef.current) return null;
    // The charts sit inside the stack's 4 px padding.
    const cw = stackRef.current.clientWidth - 8;
    const m = margins(cw);
    const w = cw - m.left - m.right;
    const xa = 4 + m.left + ((sel.a - view[0]) / (view[1] - view[0])) * w;
    const xb = 4 + m.left + ((sel.b - view[0]) / (view[1] - view[0])) * w;
    return { left: xa, width: xb - xa };
  })();

  return (
    <div className={`spc-stack${className ? ` ${className}` : ""}`} ref={stackRef}>
      <div className="spc-stack__time">
        {hoverT != null ? fmtUtc(hoverT) : `${fmtUtc(view[0])} to ${fmtUtc(view[1])}`}
        {zoomed && (
          <button type="button" onClick={() => setView(null)} title="Back to the whole range (double click)">
            <RotateCcw size={11} /> Reset zoom
          </button>
        )}
      </div>
      {panels.map((p, i) => (
        <PanelView
          key={p.id}
          panel={p}
          view={view}
          hoverT={hoverT}
          showAxis={i === panels.length - 1}
          first={i === 0}
          xBands={xBands}
          now={now}
          theme={theme}
          themeKey={mode}
          onPointer={onPointer}
          onWheel={onWheel}
          onReset={() => setView(null)}
        />
      ))}
      {selBox && <div className="spc-stack__sel" style={{ left: selBox.left, width: selBox.width }} />}
    </div>
  );
}
