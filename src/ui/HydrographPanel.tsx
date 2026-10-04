import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ExternalLink, Loader2, Maximize2, Minimize2, Minus, TrendingDown, TrendingUp, Waves, X } from "lucide-react";

import {
  RIVER_COLORS,
  gaugeId,
  levelLabel,
  riverRank,
  statusLabel,
  type ChainNode,
  type Hydrograph,
  type HydroPoint,
  type RiverContext,
  type RiverStatus,
} from "../lib/rivers";
import { useElementSize } from "../lib/useElementSize";
import { getMap } from "../map/mapInstance";
import { useRiverStore } from "../store/useRiverStore";

/** Every chart's margins are the same, so their time axes line up and one
 *  cursor runs down all of them. */
const M = { left: 54, right: 96, top: 8 };
const LABELS_H = 22;
const DAYS = [3, 7, 30] as const;
type LevelKey = "action" | "minor" | "moderate" | "major";
type Panel = "flow" | "rain" | "chain";

/** The category levels, low to high, with the colour each band above it takes. */
const LEVELS: { key: LevelKey; status: RiverStatus }[] = [
  { key: "action", status: "action" },
  { key: "minor", status: "minor" },
  { key: "moderate", status: "moderate" },
  { key: "major", status: "major" },
];

const OBS_COLOR = "#3d8bfd";
const FC_COLOR = "#b46cff";
const RAIN_COLOR = "#2bb3c0";

/** USGS WaterWatch's classes of flow against the record for the date. */
const FLOW_CLASSES = {
  record_low: { label: "Lowest for the date", color: "#8b1a1a" },
  much_below: { label: "Much below normal", color: "#d62728" },
  below: { label: "Below normal", color: "#ff9900" },
  normal: { label: "Normal", color: "#1ec94c" },
  above: { label: "Above normal", color: "#2fc6c6" },
  much_above: { label: "Much above normal", color: "#2b5ce6" },
  record_high: { label: "Highest for the date", color: "#111827" },
} as const;
type FlowClass = keyof typeof FLOW_CLASSES;

/** Text in a category's colour: the action yellow is a fill colour, too light
 *  to read as type on the light theme, so its words take a deeper gold. */
function ink(status: RiverStatus): string {
  return status === "action" ? "#c9a400" : RIVER_COLORS[status];
}

function themeVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

const isBrazil = (h: Hydrograph) => h.net === "sgb" || h.net === "ana";

/** Brazil's stations in Brasília time, the way SGB and ANA show them; the
 *  NWS's in UTC. */
function clockOf(h: Hydrograph) {
  return isBrazil(h) ? { off: -3 * 3600, tz: "BRT", dmy: true } : { off: 0, tz: "Z", dmy: false };
}
type Clock = ReturnType<typeof clockOf>;

const pad = (n: number) => String(n).padStart(2, "0");

function dayLabel(unix: number, c: Clock): string {
  const d = new Date((unix + c.off) * 1000);
  return c.dmy ? `${d.getUTCDate()}/${d.getUTCMonth() + 1}` : `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function timeLabel(unix: number, c: Clock): string {
  const d = new Date((unix + c.off) * 1000);
  return `${dayLabel(unix, c)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${c.tz === "Z" ? "Z" : ` ${c.tz}`}`;
}

/** The category a value is in, from the gauge's own levels. */
function categoryOf(levels: Record<LevelKey, number | null>, v: number | null | undefined): RiverStatus | null {
  if (v == null) return null;
  if (levels.major != null && v >= levels.major) return "major";
  if (levels.moderate != null && v >= levels.moderate) return "moderate";
  if (levels.minor != null && v >= levels.minor) return "minor";
  if (levels.action != null && v >= levels.action) return "action";
  return levels.minor != null || levels.action != null || levels.moderate != null ? "no_flooding" : null;
}

function niceStep(span: number, n: number): number {
  const raw = span / n;
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}

/** 12.74, 11.5, 10 -- no trailing zeros; whole numbers past 100 and in cm. */
function fmtNum(v: number, units: string): string {
  if (Math.abs(v) >= 100 || units === "cm") return v.toFixed(0);
  return v.toFixed(2).replace(/\.?0+$/, "");
}

/** The point nearest a time, by bisection over a time-sorted series, if one
 *  lies within `tol` seconds. */
function nearest(pts: HydroPoint[], t: number, tol = 3 * 3600): HydroPoint | null {
  if (!pts.length) return null;
  let a = 0;
  let b = pts.length - 1;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (pts[m][0] < t) a = m;
    else b = m;
  }
  const p = Math.abs(pts[a][0] - t) <= Math.abs(pts[b][0] - t) ? pts[a] : pts[b];
  return Math.abs(p[0] - t) <= tol ? p : null;
}

/** "10-04" for the normals of a day. */
function mdKey(unix: number): string {
  const d = new Date(unix * 1000);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function flowClass(v: number, n: (number | null)[] | undefined): FlowClass | null {
  if (!n) return null;
  const [mn, p10, p25, , p75, p90, mx] = n;
  if (mx != null && v > mx) return "record_high";
  if (mn != null && v < mn) return "record_low";
  if (p90 != null && v > p90) return "much_above";
  if (p75 != null && v > p75) return "above";
  if (p25 != null && v >= p25) return "normal";
  if (p10 != null && v >= p10) return "below";
  return p10 != null ? "much_below" : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "OND" -> "Oct–Dec": the LRO's interval is three months' initials. */
function months(interval: string): string {
  const letters = "JFMAMJJASOND";
  for (let i = 0; i < 12; i++) {
    const s = [0, 1, 2].map((k) => letters[(i + k) % 12]).join("");
    if (s === interval.toUpperCase()) return `${MONTHS[i]}–${MONTHS[(i + 2) % 12]}`;
  }
  return interval;
}

// --- drawing ----------------------------------------------------------------

interface Axis {
  t0: number;
  t1: number;
  now: number;
  c: Clock;
}

interface Theme {
  text: string;
  faint: string;
  mono: string;
}

function themeNow(): Theme {
  return {
    text: themeVar("--text-dim", "#9aa4b2"),
    faint: themeVar("--border-strong", "rgba(140,150,165,0.5)"),
    mono: themeVar("--mono", "ui-monospace, monospace"),
  };
}

function prep(canvas: HTMLCanvasElement, w: number, hh: number): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(hh * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${hh}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx || w < 200 || hh < 40) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hh);
  return ctx;
}

function xScale(a: Axis, w: number) {
  const pw = w - M.left - M.right;
  return (t: number) => M.left + ((t - a.t0) / (a.t1 - a.t0)) * pw;
}

/** Day lines (as many as there is room to label), now, the frame, and under
 *  the bottom chart the dates. */
function timeGrid(ctx: CanvasRenderingContext2D, a: Axis, w: number, ph: number, labels: boolean, th: Theme) {
  const x = xScale(a, w);
  const pw = w - M.left - M.right;
  const first = Math.ceil((a.t0 + a.c.off) / 86400) * 86400 - a.c.off;
  const dayPx = (86400 / (a.t1 - a.t0)) * pw;
  const step = [1, 2, 3, 5, 7, 10].find((n) => n * dayPx >= 46) ?? 14;
  ctx.fillStyle = th.faint;
  ctx.globalAlpha = 0.3;
  for (let t = first, i = 0; t <= a.t1; t += 86400, i++) if (i % step === 0) ctx.fillRect(Math.round(x(t)), M.top, 1, ph);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = th.faint;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(x(a.now), M.top);
  ctx.lineTo(x(a.now), M.top + ph);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  ctx.strokeRect(M.left + 0.5, M.top + 0.5, pw - 1, ph - 1);
  if (!labels) return;
  ctx.fillStyle = th.text;
  ctx.font = `10.5px ${th.mono}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let t = first, i = 0; t <= a.t1; t += 86400, i++) {
    if (i % step) continue;
    ctx.fillText(dayLabel(t, a.c), x(t), M.top + ph + 6);
    ctx.fillRect(x(t), M.top + ph - 4, 1, 4);
  }
}

/** The value axis down the left, and its name turned up the side. */
function valueAxis(ctx: CanvasRenderingContext2D, lo: number, hi: number, ph: number, title: string, th: Theme) {
  const y = (v: number) => M.top + (1 - (v - lo) / (hi - lo)) * ph;
  ctx.fillStyle = th.text;
  ctx.font = `10.5px ${th.mono}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const step = niceStep(hi - lo, Math.max(2, Math.round(ph / 48)));
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    ctx.fillText(step < 1 ? v.toFixed(step < 0.1 ? 2 : 1) : v.toFixed(0), M.left - 6, y(v));
    ctx.fillRect(M.left, y(v), 4, 1);
  }
  ctx.save();
  ctx.translate(12, M.top + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText(title, 0, 0);
  ctx.restore();
}

/** Where the axis runs on past now for the rain forecast and the river has
 *  no forecast of its own, say so rather than leave the space blank. */
function noForecast(ctx: CanvasRenderingContext2D, a: Axis, w: number, ph: number, th: Theme) {
  if (a.t1 - a.now < 86400) return;
  const x = xScale(a, w);
  ctx.fillStyle = th.text;
  ctx.globalAlpha = 0.6;
  ctx.font = `10.5px ${th.mono}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("no river forecast", (x(a.now) + x(a.t1)) / 2, M.top + ph / 2);
  ctx.globalAlpha = 1;
}

/** Right-margin labels, nudged apart when two sit close. */
function marginLabels(ctx: CanvasRenderingContext2D, w: number, labels: { y: number; text: string; color: string }[]) {
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  let lastY = Infinity;
  for (const lb of [...labels].sort((p, q) => q.y - p.y)) {
    const ly = Math.min(lb.y, lastY - 12);
    ctx.fillStyle = lb.color;
    ctx.fillText(lb.text, w - M.right + 6, ly);
    lastY = ly;
  }
}

function strokeSeries(
  ctx: CanvasRenderingContext2D,
  pts: HydroPoint[],
  idx: 1 | 2,
  x: (t: number) => number,
  y: (v: number) => number,
  color: string,
  dash: number[],
  gap: number,
) {
  if (!pts.length) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.setLineDash(dash);
  ctx.beginPath();
  pts.forEach((p, i) => {
    const px = x(p[0]);
    const py = y(p[idx] as number);
    if (i && p[0] - pts[i - 1][0] <= gap) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  });
  ctx.stroke();
  ctx.setLineDash([]);
}

/** The stage the NWS way: the flood levels as coloured bands and lines, the
 *  observed stage, the forecast on from it, the record. */
function paintStage(canvas: HTMLCanvasElement, h: Hydrograph, a: Axis, w: number, hh: number, labels: boolean) {
  const ctx = prep(canvas, w, hh);
  if (!ctx) return;
  const th = themeNow();
  const ph = hh - M.top - (labels ? LABELS_H : 6);
  const x = xScale(a, w);
  const pw = w - M.left - M.right;
  const units = h.units;
  const levels = h.stages;
  const obs = h.observed.filter((p) => p[1] != null && p[0] >= a.t0);
  const fc = h.forecast.filter((p) => p[1] != null);
  const vals = [...obs, ...fc].map((p) => p[1] as number);
  const lv = LEVELS.map((l) => levels[l.key]).filter((v): v is number => v != null);
  let lo = Math.min(...vals, ...(lv.length ? [lv[0]] : []));
  let hi = Math.max(...vals, ...lv);
  const record = h.record;
  if (record && record.stage <= hi + (hi - lo) * 0.6) hi = Math.max(hi, record.stage);
  ctx.font = `10.5px ${th.mono}`;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    ctx.fillStyle = th.text;
    ctx.textAlign = "center";
    ctx.fillText("No readings in this period.", w / 2, hh / 2);
    return;
  }
  const padV = (hi - lo || 1) * 0.08;
  lo -= padV;
  hi += padV;
  const y = (v: number) => M.top + (1 - (v - lo) / (hi - lo)) * ph;
  const yc = (v: number) => Math.max(M.top, Math.min(M.top + ph, y(v)));

  ctx.save();
  ctx.beginPath();
  ctx.rect(M.left, M.top, pw, ph);
  ctx.clip();
  const bands: { from: number; to: number; color: string }[] = [];
  if (lv.length) bands.push({ from: lo, to: lv[0], color: RIVER_COLORS.no_flooding });
  LEVELS.forEach((l, i) => {
    const from = levels[l.key];
    if (from == null) return;
    const next = LEVELS.slice(i + 1).map((n) => levels[n.key]).find((v): v is number => v != null);
    bands.push({ from, to: next ?? hi, color: RIVER_COLORS[l.status] });
  });
  ctx.globalAlpha = 0.12;
  for (const b of bands) {
    ctx.fillStyle = b.color;
    ctx.fillRect(M.left, yc(b.to), pw, yc(b.from) - yc(b.to));
  }
  ctx.globalAlpha = 1;
  for (const l of LEVELS) {
    const v = levels[l.key];
    if (v == null || v < lo || v > hi) continue;
    ctx.strokeStyle = RIVER_COLORS[l.status];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(M.left, y(v));
    ctx.lineTo(M.left + pw, y(v));
    ctx.stroke();
  }
  if (record && record.stage >= lo && record.stage <= hi) {
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = th.text;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(M.left, y(record.stage));
    ctx.lineTo(M.left + pw, y(record.stage));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
  timeGrid(ctx, a, w, ph, labels, th);
  ctx.save();
  ctx.beginPath();
  ctx.rect(M.left, M.top, pw, ph);
  ctx.clip();
  strokeSeries(ctx, obs, 1, x, y, OBS_COLOR, [], 6 * 3600);
  const lastO = obs[obs.length - 1];
  strokeSeries(ctx, lastO && fc.length ? [lastO, ...fc] : fc, 1, x, y, FC_COLOR, [6, 4], Infinity);
  ctx.restore();

  if (!fc.length) noForecast(ctx, a, w, ph, th);
  valueAxis(ctx, lo, hi, ph, `${h.observedMeta.primaryName ?? "Stage"} (${units})`, th);
  const labelsR: { y: number; text: string; color: string }[] = [];
  for (const l of LEVELS) {
    const v = levels[l.key];
    if (v == null || v < lo || v > hi) continue;
    labelsR.push({ y: y(v), text: `${levelLabel(l.key, h.net)} ${fmtNum(v, units)}`, color: ink(l.status) });
  }
  if (record && record.stage >= lo && record.stage <= hi) {
    labelsR.push({ y: y(record.stage), text: `Record ${fmtNum(record.stage, units)}`, color: th.text });
  }
  ctx.font = `10.5px ${th.mono}`;
  marginLabels(ctx, w, labelsR);
}

/** The flow, over the normal range for each date where USGS keeps the site's
 *  statistics: the 10th-90th percentiles light, the 25th-75th darker, the
 *  median dashed. */
function paintFlow(
  canvas: HTMLCanvasElement,
  h: Hydrograph,
  normals: RiverContext["normals"],
  a: Axis,
  w: number,
  hh: number,
  labels: boolean,
) {
  const ctx = prep(canvas, w, hh);
  if (!ctx) return;
  const th = themeNow();
  const ph = hh - M.top - (labels ? LABELS_H : 6);
  const x = xScale(a, w);
  const pw = w - M.left - M.right;
  const units = h.flowUnits;
  const levels = h.flows ?? { action: null, minor: null, moderate: null, major: null };
  const obs = h.observed.filter((p) => p[2] != null && p[0] >= a.t0);
  const fc = h.forecast.filter((p) => p[2] != null);
  const days: { t: number; n: (number | null)[] }[] = [];
  if (normals) {
    for (let t = Math.floor(a.t0 / 86400) * 86400; t < a.t1; t += 86400) {
      const n = normals.days[mdKey(t)];
      if (n) days.push({ t, n });
    }
  }
  const vals = [...obs, ...fc].map((p) => p[2] as number);
  const bandVals = days.flatMap((d) => [d.n[1], d.n[5]]).filter((v): v is number => v != null);
  const lv = LEVELS.map((l) => levels[l.key]).filter((v): v is number => v != null);
  let lo = Math.min(...vals, ...bandVals);
  let hi = Math.max(...vals, ...bandVals, ...(lv.length ? [lv[0]] : []));
  ctx.font = `10.5px ${th.mono}`;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    ctx.fillStyle = th.text;
    ctx.textAlign = "center";
    ctx.fillText("No flow in this period.", w / 2, hh / 2);
    return;
  }
  if (lo < hi * 0.35) lo = 0;
  const padV = (hi - lo || 1) * 0.08;
  lo = Math.max(0, lo - (lo ? padV : 0));
  hi += padV;
  const y = (v: number) => M.top + (1 - (v - lo) / (hi - lo)) * ph;
  const yc = (v: number) => Math.max(M.top, Math.min(M.top + ph, y(v)));

  ctx.save();
  ctx.beginPath();
  ctx.rect(M.left, M.top, pw, ph);
  ctx.clip();
  for (const d of days) {
    const [, p10, p25, p50, p75, p90] = d.n;
    const x0 = x(d.t);
    const x1 = x(d.t + 86400);
    ctx.fillStyle = th.text;
    if (p10 != null && p90 != null) {
      ctx.globalAlpha = 0.1;
      ctx.fillRect(x0, yc(p90), x1 - x0, yc(p10) - yc(p90));
    }
    if (p25 != null && p75 != null) {
      ctx.globalAlpha = 0.14;
      ctx.fillRect(x0, yc(p75), x1 - x0, yc(p25) - yc(p75));
    }
    ctx.globalAlpha = 0.7;
    if (p50 != null) ctx.fillRect(x0, yc(p50), Math.max(1, (x1 - x0) * 0.6), 1);
  }
  ctx.globalAlpha = 1;
  for (const l of LEVELS) {
    const v = levels[l.key];
    if (v == null || v < lo || v > hi) continue;
    ctx.strokeStyle = RIVER_COLORS[l.status];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(M.left, y(v));
    ctx.lineTo(M.left + pw, y(v));
    ctx.stroke();
  }
  ctx.restore();
  timeGrid(ctx, a, w, ph, labels, th);
  ctx.save();
  ctx.beginPath();
  ctx.rect(M.left, M.top, pw, ph);
  ctx.clip();
  strokeSeries(ctx, obs, 2, x, y, OBS_COLOR, [], 6 * 3600);
  const lastO = obs[obs.length - 1];
  strokeSeries(ctx, lastO && fc.length ? [lastO, ...fc] : fc, 2, x, y, FC_COLOR, [6, 4], Infinity);
  ctx.restore();

  if (!fc.length) noForecast(ctx, a, w, ph, th);
  valueAxis(ctx, lo, hi, ph, `${h.observedMeta.secondaryName ?? "Flow"} (${units})`, th);
  const labelsR: { y: number; text: string; color: string }[] = [];
  for (const l of LEVELS) {
    const v = levels[l.key];
    if (v == null || v < lo || v > hi) continue;
    labelsR.push({ y: y(v), text: `${levelLabel(l.key, h.net)} ${fmtNum(v, units)}`, color: ink(l.status) });
  }
  const today = days.find((d) => d.t <= a.now && a.now < d.t + 86400);
  if (today?.n[3] != null) labelsR.push({ y: y(today.n[3] as number), text: `Median ${fmtNum(today.n[3] as number, units)}`, color: th.text });
  ctx.font = `10.5px ${th.mono}`;
  marginLabels(ctx, w, labelsR);
}

interface RainBars {
  bin: number;
  past: [number, number][];
  future: [number, number][];
  pastTotal: number;
  futureTotal: number;
  gauge: boolean;
}

/** Rain as bars, measured or analysed up to now and forecast after, and the
 *  total piling up over the window. */
function paintRain(canvas: HTMLCanvasElement, r: RainBars, a: Axis, w: number, hh: number, labels: boolean) {
  const ctx = prep(canvas, w, hh);
  if (!ctx) return;
  const th = themeNow();
  const ph = hh - M.top - (labels ? LABELS_H : 6);
  const x = xScale(a, w);
  const pw = w - M.left - M.right;
  const all = [...r.past, ...r.future];
  const max = Math.max(1, ...all.map((b) => b[1]));
  const step = niceStep(max, 2);
  const top = Math.ceil(max / step) * step;
  const y = (mm: number) => M.top + ph - (mm / top) * ph;

  ctx.save();
  ctx.beginPath();
  ctx.rect(M.left, M.top, pw, ph);
  ctx.clip();
  const bw = Math.max(1, (r.bin / (a.t1 - a.t0)) * pw - 1);
  ctx.fillStyle = RAIN_COLOR;
  for (const [t, mm] of r.past) if (mm > 0) ctx.fillRect(x(t) + 0.5, y(mm), bw, M.top + ph - y(mm));
  ctx.globalAlpha = 0.45;
  for (const [t, mm] of r.future) if (mm > 0) ctx.fillRect(x(t) + 0.5, y(mm), bw, M.top + ph - y(mm));
  ctx.globalAlpha = 1;

  // The running total, on its own scale.
  const total = r.pastTotal + r.futureTotal;
  if (total > 0) {
    const yt = (v: number) => M.top + ph - (v / (total * 1.08)) * ph;
    ctx.strokeStyle = th.text;
    ctx.lineWidth = 1.3;
    let acc = 0;
    ctx.beginPath();
    ctx.moveTo(x(a.t0), yt(0));
    for (const [t, mm] of r.past) {
      acc += mm;
      ctx.lineTo(x(t + r.bin), yt(acc));
    }
    ctx.stroke();
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x(r.past.length ? r.past[r.past.length - 1][0] + r.bin : a.now), yt(acc));
    for (const [t, mm] of r.future) {
      acc += mm;
      ctx.lineTo(x(t + r.bin), yt(acc));
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    ctx.font = `10.5px ${th.mono}`;
    ctx.fillStyle = th.text;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(`Σ ${total.toFixed(0)} mm`, w - M.right + 6, Math.max(M.top + 6, yt(total)));
  } else {
    ctx.restore();
  }
  timeGrid(ctx, a, w, ph, labels, th);
  valueAxis(ctx, 0, top, ph, r.bin === 3600 ? "mm/h" : r.bin === 86400 ? "mm/day" : "mm/3 h", th);
}

// --- pieces of the screen -------------------------------------------------------

function Chip({ status, net }: { status: RiverStatus; net: Hydrograph["net"] }) {
  return (
    <i className="hydro__chip" style={{ background: RIVER_COLORS[status], color: riverRank(status) >= 3 ? "#fff" : "#111" }}>
      {statusLabel(status, net === "ana" ? "sgb" : net)}
    </i>
  );
}

function FlowChip({ cls }: { cls: FlowClass }) {
  const c = FLOW_CLASSES[cls];
  const dark = cls === "record_high" || cls === "much_above" || cls === "much_below" || cls === "record_low";
  return (
    <i className="hydro__chip" style={{ background: c.color, color: dark ? "#fff" : "#111" }}>
      {c.label}
    </i>
  );
}

/** The river's gauges in a line, source to mouth, each in its category's
 *  colour: where the water is now, and where it is going. */
function Chain({ nodes, net, onPick }: { nodes: ChainNode[]; net: Hydrograph["net"]; onPick: (lid: string) => void }) {
  return (
    <div className="hydro__chain" role="list" aria-label="Gauges along the river">
      <span className="hydro__chainend">upstream</span>
      <div className="hydro__chainline">
        {nodes.map((n) => (
          <button
            key={n.lid}
            type="button"
            role="listitem"
            className={`hydro__node${n.self ? " is-self" : ""}`}
            onClick={() => !n.self && onPick(n.lid)}
            title={`${n.river ? `${n.river} · ` : ""}${n.place} (${gaugeId(n.lid)}): ${statusLabel(n.status, net === "ana" ? "sgb" : net)}`}
          >
            <i
              style={{
                background: RIVER_COLORS[n.status] ?? RIVER_COLORS.not_defined,
                boxShadow: n.fstatus && riverRank(n.fstatus) > riverRank(n.status) ? `0 0 0 2px ${RIVER_COLORS[n.fstatus]}` : undefined,
              }}
            />
            <span>{n.place}</span>
            <small>{n.stage != null ? `${fmtNum(n.stage, n.units)} ${n.units}` : statusLabel(n.status, net === "ana" ? "sgb" : net)}</small>
          </button>
        ))}
      </div>
      <span className="hydro__chainend">
        downstream <ArrowRight size={11} />
      </span>
    </div>
  );
}

/** A gauge's screen, full like the sounding viewer: stage, flow against its
 *  normal for the date, and rain, one above the other on one time axis with
 *  one cursor; the gauges up and down the river; beside it the numbers --
 *  the trend, the levels, the forecast, the outlook, what floods. */
export function HydrographPanel() {
  const selected = useRiverStore((s) => s.selected);
  const h = useRiverStore((s) => s.hydro);
  const busy = useRiverStore((s) => s.hydroBusy);
  const error = useRiverStore((s) => s.hydroError);
  const context = useRiverStore((s) => s.context);
  const all = useRiverStore((s) => s.all);
  const [expanded, setExpanded] = useState(false);
  const [days, setDays] = useState<(typeof DAYS)[number]>(7);
  const [shown, setShown] = useState<Record<Panel, boolean>>({ flow: true, rain: true, chain: true });
  const [stageRef, stageSize] = useElementSize<HTMLDivElement>();
  const [flowRef, flowSize] = useElementSize<HTMLDivElement>();
  const [rainRef, rainSize] = useElementSize<HTMLDivElement>();
  const stageCv = useRef<HTMLCanvasElement>(null);
  const flowCv = useRef<HTMLCanvasElement>(null);
  const rainCv = useRef<HTMLCanvasElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [zoomImg, setZoomImg] = useState<{ src: string; title: string } | null>(null);
  const [badImgs, setBadImgs] = useState<Set<string>>(new Set());

  const ready = !!h && h.lid === selected;
  const ctx = context && context.lid === selected ? context : null;
  const hasFlow = ready && h.observed.some((p) => p[2] != null);
  const c = useMemo(() => (ready && h ? clockOf(h) : null), [ready, h]);
  const stageObs = useMemo(() => (h ? h.observed.filter((p) => p[1] != null) : []), [h]);
  const flowObs = useMemo(() => (h ? h.observed.filter((p) => p[2] != null) : []), [h]);

  // One time axis for every chart: the period asked for, and ahead as far as
  // the NWS forecast or a week of forecast rain reaches.
  const axis = useMemo<Axis | null>(() => {
    if (!h || !c) return null;
    const now = Date.now() / 1000;
    const lastObs = stageObs.length ? stageObs[stageObs.length - 1][0] : now;
    const fcEnd = h.forecast.length ? h.forecast[h.forecast.length - 1][0] : now;
    const rainAhead = ctx?.rain?.hourly.length ? Math.min(days, 7) * 86400 : 3 * 3600;
    return { t0: Math.min(now, lastObs) - days * 86400, t1: Math.max(fcEnd, now + rainAhead), now, c };
  }, [h, c, ctx, days, stageObs]);

  const rain = useMemo<RainBars | null>(() => {
    if (!axis || !c) return null;
    const gauge = h?.rain ?? [];
    const model = ctx?.rain?.hourly ?? [];
    if (!gauge.length && !model.length) return null;
    const bin = days <= 3 ? 3600 : days <= 7 ? 3 * 3600 : 86400;
    const binOf = (t: number) => Math.floor((t - 1 + c.off) / bin) * bin - c.off;
    const sum = (src: [number, number][], keep: (t: number) => boolean) => {
      const m = new Map<number, number>();
      for (const [t, mm] of src) {
        if (!keep(t)) continue;
        const b = binOf(t);
        if (b + bin <= axis.t0 || b >= axis.t1) continue;
        m.set(b, (m.get(b) ?? 0) + mm);
      }
      return [...m.entries()].sort((p, q) => p[0] - q[0]);
    };
    const usesGauge = gauge.length > 0;
    const past = sum(usesGauge ? gauge : model, (t) => t <= axis.now);
    const future = sum(model, (t) => t > axis.now);
    return {
      bin,
      past,
      future,
      pastTotal: past.reduce((s, b) => s + b[1], 0),
      futureTotal: future.reduce((s, b) => s + b[1], 0),
      gauge: usesGauge,
    };
  }, [axis, c, h, ctx, days]);

  const showFlow = shown.flow && hasFlow;
  const showRain = shown.rain && !!rain;
  const bottom: "stage" | "flow" | "rain" = showRain ? "rain" : showFlow ? "flow" : "stage";

  useEffect(() => {
    if (ready && h && axis && stageCv.current) paintStage(stageCv.current, h, axis, stageSize.w, stageSize.h, bottom === "stage");
  }, [ready, h, axis, stageSize.w, stageSize.h, bottom]);
  useEffect(() => {
    if (ready && h && axis && showFlow && flowCv.current)
      paintFlow(flowCv.current, h, ctx?.normals ?? null, axis, flowSize.w, flowSize.h, bottom === "flow");
  }, [ready, h, ctx, axis, showFlow, flowSize.w, flowSize.h, bottom]);
  useEffect(() => {
    if (axis && rain && showRain && rainCv.current) paintRain(rainCv.current, rain, axis, rainSize.w, rainSize.h, true);
  }, [axis, rain, showRain, rainSize.w, rainSize.h]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (zoomImg) setZoomImg(null);
      else useRiverStore.getState().select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, zoomImg]);

  useEffect(() => {
    setHoverT(null);
    setZoomImg(null);
  }, [selected]);

  const nowPt = stageObs.length ? stageObs[stageObs.length - 1] : null;
  const nowFlow = flowObs.length ? flowObs[flowObs.length - 1] : null;
  const crest = useMemo(() => {
    if (!h || !h.forecast.length) return null;
    return h.forecast.reduce<HydroPoint | null>((best, p) => (p[1] != null && (best == null || (p[1] as number) > (best[1] as number)) ? p : best), null);
  }, [h]);
  // The impacts that matter now: up to a little above the higher of the stage
  // now and the forecast crest.
  const near = useMemo(() => {
    if (!h || !h.impacts.length) return [];
    const top = Math.max(nowPt?.[1] ?? -Infinity, (crest?.[1] as number) ?? -Infinity);
    const upto = h.impacts.filter((i) => i.stage <= top + Math.max(1, (h.stages.major ?? top) * 0.05));
    return (upto.length ? upto : h.impacts.slice(0, 1)).slice(-6).reverse();
  }, [h, nowPt, crest]);
  // How fast the river is moving: the change over the last hour, 6 and 24.
  const trend = useMemo(() => {
    if (!nowPt) return null;
    const back = (sec: number) => {
      const p = nearest(stageObs, nowPt[0] - sec, sec * 0.4);
      return p ? (nowPt[1] as number) - (p[1] as number) : null;
    };
    const d1 = back(3600);
    const d6 = back(6 * 3600);
    const d24 = back(24 * 3600);
    const ref = d6 ?? d24 ?? d1;
    const units = h?.units ?? "";
    const still = units === "cm" ? 2 : 0.05;
    const dir = ref == null ? null : ref > still ? "rising" : ref < -still ? "falling" : "steady";
    return { d1, d6, d24, dir };
  }, [stageObs, nowPt, h]);
  // Rain over the last day, 3 and 7 (the station's gauge where it has one),
  // and the forecast over the next.
  const rainTotals = useMemo(() => {
    const gauge = h?.rain ?? [];
    const model = ctx?.rain?.hourly ?? [];
    if (!gauge.length && !model.length) return null;
    const now = Date.now() / 1000;
    const sum = (src: [number, number][], from: number, to: number) =>
      src.reduce((s, [t, mm]) => (t > from && t <= to ? s + mm : s), 0);
    const hours = [24, 72, 168];
    const past = gauge.length ? gauge : model;
    return {
      gauge: gauge.length > 0,
      past: hours.map((n) => sum(past, now - n * 3600, now)),
      next: model.length ? hours.map((n) => sum(model, now, now + n * 3600)) : null,
    };
  }, [h, ctx]);
  // The forecast every 6 hours, crest included.
  const fcRows = useMemo(() => {
    if (!h || !h.forecast.length) return [];
    const rows: HydroPoint[] = [];
    for (const p of h.forecast) {
      if (p[1] == null) continue;
      if (!rows.length || p[0] - rows[rows.length - 1][0] >= 6 * 3600 || p === crest) rows.push(p);
    }
    return rows.slice(0, 16);
  }, [h, crest]);

  if (!selected) return null;

  const net = h?.net ?? (selected.startsWith("BR:") ? "sgb" : "nws");
  const br = net === "sgb" || net === "ana";
  const units = h?.units ?? "";
  const normalsToday = ctx?.normals?.days[mdKey(Date.now() / 1000)];
  const flowNowCls = nowFlow ? flowClass(nowFlow[2] as number, normalsToday) : null;
  const nowCat = h && nowPt ? categoryOf(h.stages, nowPt[1]) : null;
  const crestCat = h && crest ? categoryOf(h.stages, crest[1]) : null;
  const source = net === "nws" ? "NWS · NWPS" : net === "sgb" ? "SGB · SACE" : "ANA · Hidro-Telemetria";
  const link = net === "nws" ? `https://water.noaa.gov/gauges/${selected.toLowerCase()}` : (h?.links?.sace ?? h?.links?.hidroweb ?? null);
  const levelRows = h ? LEVELS.filter((l) => h.stages[l.key] != null).map((l) => ({ ...l, v: h.stages[l.key] as number })) : [];
  const images: { src: string; title: string }[] = [];
  if (h?.images) {
    const charts: [keyof NonNullable<Hydrograph["images"]>, string][] = [
      ["shortrange", "Ensemble forecast (HEFS), next days"],
      ["weekly", "Chance of exceeding each stage, by week"],
      ["season", "Chance of exceeding each stage, next 90 days"],
    ];
    for (const [k, title] of charts) {
      const src = h.images[k];
      if (src && !badImgs.has(src)) images.push({ src, title });
    }
  }

  const go = (lid: string) => {
    const g = all.find((x) => x.lid === lid);
    if (g) getMap()?.easeTo({ center: [g.lon, g.lat], duration: 600 });
    useRiverStore.getState().select(lid);
  };

  // The cursor: a time from the pointer over any chart, shown on all of them.
  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const box = stackRef.current;
    if (!box || !axis) return;
    const r = box.getBoundingClientRect();
    const pw = r.width - M.left - M.right;
    const px = e.clientX - r.left - M.left;
    if (px < 0 || px > pw) {
      setHoverT(null);
      return;
    }
    setHoverT(axis.t0 + (px / pw) * (axis.t1 - axis.t0));
  };
  const cursorX =
    hoverT != null && axis && stackRef.current
      ? M.left + ((hoverT - axis.t0) / (axis.t1 - axis.t0)) * (stackRef.current.clientWidth - M.left - M.right)
      : null;

  // What each chart's header reads: at the cursor, or now.
  const at = hoverT;
  const inFc = (t: number) => !!nowPt && t > nowPt[0];
  const stageAt = at != null && h ? (inFc(at) ? nearest(h.forecast.filter((p) => p[1] != null), at) : nearest(stageObs, at)) : nowPt;
  const flowAt = at != null && h ? (inFc(at) ? nearest(h.forecast.filter((p) => p[2] != null), at) : nearest(flowObs, at)) : nowFlow;
  const rainAt = (() => {
    if (!rain) return null;
    if (at == null) return null;
    const b = [...rain.past, ...rain.future].find(([t]) => at >= t && at < t + rain.bin);
    return b ?? null;
  })();
  const binName = rain ? (rain.bin === 3600 ? "hour" : rain.bin === 86400 ? "day" : "3 h") : "";

  return (
    <div className={`sv hydro-screen${expanded ? " is-expanded" : ""}`} role="dialog" aria-label="Hydrograph">
      <header className="sv__head">
        <div className="sv__title">
          <Waves size={16} />
          <div>
            <strong>{h?.name ?? gaugeId(selected)}</strong>
            <span>
              {gaugeId(selected)}
              {h?.state ? ` / ${h.state}` : ""}
              {h?.county ? ` / ${h.county} County` : ""}
              {h?.wfo ? ` / NWS ${h.wfo}` : ""}
              {h?.basin ? ` / ${h.basin} basin` : ""}
              {h?.town && br ? ` / ${h.town}` : ""}
            </span>
          </div>
        </div>
        <div className="sv__brand">{source}</div>
        <div className="sv__headbtns">
          {link && (
            <a className="hydro__headlink" href={link} target="_blank" rel="noopener" title="This station on its source's site">
              <ExternalLink size={14} />
            </a>
          )}
          <button type="button" onClick={() => setExpanded((v) => !v)} title={expanded ? "Restore" : "Expand"}>
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button type="button" onClick={() => useRiverStore.getState().select(null)} title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="sv__controls hydro__controls">
        <div className="sv__ctl">
          <span>PERIOD</span>
          <div className="xsect__seg" role="group" aria-label="Days shown">
            {DAYS.map((d) => (
              <button key={d} type="button" className={days === d ? "is-on" : ""} onClick={() => setDays(d)}>
                {d} days
              </button>
            ))}
          </div>
        </div>
        <div className="sv__ctl">
          <span>PANELS</span>
          <div className="xsect__seg" role="group" aria-label="Panels shown">
            {(
              [
                ["flow", "Flow", hasFlow, "No flow is measured at this station"],
                ["rain", "Rain", !!rain, "No rain for this spot yet"],
                ["chain", "Along the river", !!ctx?.chain.length, "No gauges linked up or down the river"],
              ] as [Panel, string, boolean, string][]
            ).map(([k, label, avail, why]) => (
              <button
                key={k}
                type="button"
                className={shown[k] && avail ? "is-on" : ""}
                onClick={() => setShown((s) => ({ ...s, [k]: !s[k] }))}
                disabled={!avail}
                aria-pressed={shown[k] && avail}
                title={avail ? undefined : why}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {busy && <Loader2 size={15} className="sv__busy spin" />}
      </div>

      <div className="sv__body hydro__body">
        {!ready && (
          <div className="sv__state">
            {error ? (
              <span>{error}</span>
            ) : (
              <>
                <Loader2 size={24} className="spin" />
                <span>{selected.startsWith("BR:") ? "Reading the station from SGB and ANA…" : "Reading the gauge from the NWS…"}</span>
              </>
            )}
          </div>
        )}

        {ready && h && c && (
          <>
            <div className="hydro__main">
              <div className="hydro__stack" ref={stackRef} onMouseMove={onMove} onMouseLeave={() => setHoverT(null)}>
                <section className="hydro__panel hydro__panel--stage">
                  <div className="hydro__panelhead">
                    <b>Stage</b>
                    <span>
                      {stageAt?.[1] != null
                        ? `${fmtNum(stageAt[1], units)} ${units}${at != null && inFc(stageAt[0]) ? " forecast" : ""} · ${timeLabel(stageAt[0], c)}`
                        : at != null
                          ? "no reading here"
                          : ""}
                    </span>
                  </div>
                  <div className="hydro__plotbox" ref={stageRef}>
                    <canvas ref={stageCv} />
                  </div>
                </section>

                {showFlow && (
                  <section className="hydro__panel hydro__panel--flow">
                    <div className="hydro__panelhead">
                      <b>Flow</b>
                      <span>
                        {flowAt?.[2] != null
                          ? `${fmtNum(flowAt[2], h.flowUnits)} ${h.flowUnits}${at != null && inFc(flowAt[0]) ? " forecast" : ""}`
                          : at != null
                            ? "no reading here"
                            : ""}
                      </span>
                      {flowAt?.[2] != null && ctx?.normals && (() => {
                        const cls = flowClass(flowAt[2] as number, ctx.normals.days[mdKey(flowAt[0])]);
                        return cls ? <FlowChip cls={cls} /> : null;
                      })()}
                      <em>
                        {ctx?.normals
                          ? `shaded: normal for the date, USGS ${ctx.normals.years[0]}–${ctx.normals.years[1]}`
                          : br
                            ? "ANA telemetry"
                            : ""}
                      </em>
                    </div>
                    <div className="hydro__plotbox" ref={flowRef}>
                      <canvas ref={flowCv} />
                    </div>
                  </section>
                )}

                {showRain && rain && (
                  <section className="hydro__panel hydro__panel--rain">
                    <div className="hydro__panelhead">
                      <b>Rain</b>
                      <span>
                        {rainAt
                          ? `${rainAt[1].toFixed(1)} mm in the ${binName} · ${timeLabel(rainAt[0], c)}${rainAt[0] >= (axis?.now ?? 0) ? " forecast" : ""}`
                          : `${rain.pastTotal.toFixed(0)} mm in ${days} d · next ${axis ? Math.round((axis.t1 - axis.now) / 86400) : 0} d ${rain.futureTotal.toFixed(0)} mm forecast`}
                      </span>
                      <em>
                        {rain.gauge ? "bars: the station's gauge; " : "bars: model analysis; "}
                        faded: forecast · Open-Meteo
                      </em>
                    </div>
                    <div className="hydro__plotbox" ref={rainRef}>
                      <canvas ref={rainCv} />
                    </div>
                  </section>
                )}

                {cursorX != null && <div className="hydro__cursor" style={{ left: cursorX }} />}
              </div>

              <div className="hydro__key">
                <span><i className="hydro__line" style={{ background: OBS_COLOR }} /> observed</span>
                {h.forecast.length > 0 && (
                  <span><i className="hydro__line hydro__line--dash" style={{ borderColor: FC_COLOR }} /> NWS forecast</span>
                )}
                {LEVELS.map((l) =>
                  h.stages[l.key] != null ? (
                    <span key={l.key}>
                      <i className="hydro__swatch" style={{ background: RIVER_COLORS[l.status] }} /> {levelLabel(l.key, h.net)}
                    </span>
                  ) : null,
                )}
                <span className="hydro__tz">times in {c.tz === "Z" ? "UTC" : "Brasília time (UTC−3)"}</span>
              </div>

              {shown.chain && ctx && ctx.chain.length > 1 && <Chain nodes={ctx.chain} net={h.net} onPick={go} />}
            </div>

            <aside className="hydro__side">
              <div className="hydro__facts">
                <div className="hydro__fact">
                  <span>Stage now</span>
                  <b>{nowPt?.[1] != null ? `${fmtNum(nowPt[1], units)} ${units}` : "–"}</b>
                  {nowCat && <Chip status={nowCat} net={h.net} />}
                  {nowPt && <small>{timeLabel(nowPt[0], c)}</small>}
                </div>
                {nowFlow && (
                  <div className="hydro__fact">
                    <span>Flow now</span>
                    <b>{`${fmtNum(nowFlow[2] as number, h.flowUnits)} ${h.flowUnits}`}</b>
                    {flowNowCls && <FlowChip cls={flowNowCls} />}
                    <small>{timeLabel(nowFlow[0], c)}</small>
                  </div>
                )}
                {h.net === "nws" && (
                  <div className="hydro__fact">
                    <span>Forecast crest</span>
                    <b>{crest?.[1] != null ? `${fmtNum(crest[1], units)} ${units}` : "no forecast"}</b>
                    {crestCat && <Chip status={crestCat} net={h.net} />}
                    {crest && <small>{timeLabel(crest[0], c)}</small>}
                  </div>
                )}
                {h.record && (
                  <div className="hydro__fact">
                    <span>Record</span>
                    <b>{`${fmtNum(h.record.stage, units)} ${units}`}</b>
                    <small>{h.record.time.slice(0, 10)}</small>
                  </div>
                )}
              </div>

              {trend && trend.dir && (
                <div className="hydro__section">
                  <div className="hydro__subhead">Trend</div>
                  <div className={`hydro__trend is-${trend.dir}`}>
                    {trend.dir === "rising" ? <TrendingUp size={16} /> : trend.dir === "falling" ? <TrendingDown size={16} /> : <Minus size={16} />}
                    <b>{trend.dir === "rising" ? "Rising" : trend.dir === "falling" ? "Falling" : "Steady"}</b>
                    {(
                      [
                        ["1 h", trend.d1],
                        ["6 h", trend.d6],
                        ["24 h", trend.d24],
                      ] as [string, number | null][]
                    ).map(([k, v]) =>
                      v != null ? (
                        <span key={k}>
                          {v > 0 ? "+" : v < 0 ? "−" : "±"}
                          {fmtNum(Math.abs(v), units)} <em>{k}</em>
                        </span>
                      ) : null,
                    )}
                  </div>
                </div>
              )}

              {rainTotals && (
                <div className="hydro__section">
                  <div className="hydro__subhead">Rain at the gauge</div>
                  <div className="hydro__raintable">
                    <span />
                    <em>24 h</em>
                    <em>3 days</em>
                    <em>7 days</em>
                    <span>{rainTotals.gauge ? "Past (gauge)" : "Past (model)"}</span>
                    {rainTotals.past.map((v, i) => (
                      <b key={`p${i}`}>{v.toFixed(v < 10 ? 1 : 0)} mm</b>
                    ))}
                    {rainTotals.next && (
                      <>
                        <span>Next (forecast)</span>
                        {rainTotals.next.map((v, i) => (
                          <b key={`n${i}`}>{v.toFixed(v < 10 ? 1 : 0)} mm</b>
                        ))}
                      </>
                    )}
                  </div>
                </div>
              )}

              {h.situation && (
                <div className="hydro__section">
                  <div className="hydro__subhead">SGB status</div>
                  <div className="hydro__situation">{h.situation}</div>
                </div>
              )}

              {levelRows.length > 0 && (
                <div className="hydro__section">
                  <div className="hydro__subhead">{br ? "SGB alert levels" : "Flood categories"}</div>
                  {levelRows.map((l) => {
                    const diff = nowPt?.[1] != null ? (nowPt[1] as number) - l.v : null;
                    return (
                      <div key={l.key} className="hydro__level">
                        <i className="hydro__swatch" style={{ background: RIVER_COLORS[l.status] }} />
                        <span>{levelLabel(l.key, h.net)}</span>
                        <b>{`${fmtNum(l.v, units)} ${units}`}</b>
                        {diff != null && (
                          <em className={diff >= 0 ? "is-over" : ""}>
                            {diff >= 0 ? `${fmtNum(diff, units)} above` : `${fmtNum(-diff, units)} to go`}
                          </em>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {fcRows.length > 0 && (
                <div className="hydro__section">
                  <div className="hydro__subhead">
                    NWS forecast{h.forecastMeta.issued ? `, issued ${timeLabel(Date.parse(h.forecastMeta.issued) / 1000, c)}` : ""}
                  </div>
                  <div className="hydro__fctable">
                    {fcRows.map((p) => {
                      const cat = categoryOf(h.stages, p[1]);
                      return (
                        <div key={p[0]} className={`hydro__fcrow${p === crest ? " is-crest" : ""}`}>
                          <span>{timeLabel(p[0], c)}</span>
                          <b>{`${fmtNum(p[1] as number, units)} ${units}`}</b>
                          {cat ? <i className="hydro__swatch" style={{ background: RIVER_COLORS[cat] }} title={statusLabel(cat, "nws")} /> : <i />}
                          <em>{p === crest ? "crest" : p[2] != null ? `${fmtNum(p[2], h.flowUnits)} ${h.flowUnits}` : ""}</em>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {h.outlook && (
                <div className="hydro__section">
                  <div className="hydro__subhead">Chance of flooding, {months(h.outlook.interval)}</div>
                  <div className="hydro__outlook">
                    {(["minor", "moderate", "major"] as const).map((k) =>
                      h.outlook?.[k] != null ? (
                        <span key={k}>
                          <i className="hydro__swatch" style={{ background: RIVER_COLORS[k] }} />
                          {levelLabel(k, "nws")} <b>{Math.round((h.outlook[k] as number) * 100)}%</b>
                        </span>
                      ) : null,
                    )}
                  </div>
                  <p className="hydro__note">The river forecast centre's long-range outlook, from the snowpack, soil moisture and climate.</p>
                </div>
              )}

              {near.length > 0 && (
                <div className="hydro__section">
                  <div className="hydro__subhead">What floods at these stages</div>
                  {near.map((i) => {
                    const cat = categoryOf(h.stages, i.stage);
                    return (
                      <div key={`${i.stage}-${i.statement.slice(0, 12)}`} className="hydro__impact">
                        <b style={{ color: cat ? ink(cat) : undefined }}>{`${fmtNum(i.stage, units)} ${units}`}</b>
                        <span>{i.statement}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {h.crests.length > 1 && (
                <div className="hydro__section">
                  <div className="hydro__subhead">Highest crests</div>
                  <div className="hydro__crestrow">
                    {h.crests.slice(0, 6).map((cr) => (
                      <span key={cr.time}>
                        <b>{fmtNum(cr.stage, units)}</b> {cr.time.slice(0, 4)}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {images.length > 0 && (
                <div className="hydro__section">
                  <div className="hydro__subhead">Chances (NWS)</div>
                  <div className="hydro__thumbs">
                    {images.map((im) => (
                      <button key={im.src} type="button" onClick={() => setZoomImg(im)} title={im.title}>
                        <img src={im.src} alt={im.title} loading="lazy" onError={() => setBadImgs((s) => new Set(s).add(im.src))} />
                        <span>{im.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {(h.operator || h.origin) && (
                <div className="hydro__section hydro__note">
                  {h.operator ? `Operated by ${h.operator}. ` : ""}
                  {h.origin ? `ANA network: ${h.origin}. ` : ""}
                  {h.levelSource === "sgb" && h.flowUnits ? "Level from SGB's alert system, flow from ANA's telemetry." : ""}
                </div>
              )}
              {h.notes && h.notes.length > 0 && <div className="hydro__section hydro__note">{h.notes.join(" ")}</div>}
              {h.warnings && h.warnings.length > 0 && <div className="hydro__section hydro__warn">{h.warnings.join(" ")}</div>}
            </aside>
          </>
        )}

        {zoomImg && (
          <div className="hydro__lightbox" onClick={() => setZoomImg(null)} role="presentation">
            <figure onClick={(e) => e.stopPropagation()}>
              <figcaption>
                {zoomImg.title}
                <button type="button" onClick={() => setZoomImg(null)} title="Close">
                  <X size={14} />
                </button>
              </figcaption>
              <img src={zoomImg.src} alt={zoomImg.title} />
            </figure>
          </div>
        )}
      </div>
    </div>
  );
}
