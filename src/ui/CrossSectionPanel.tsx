import { useEffect, useMemo, useRef, useState } from "react";
import { Layers, Loader2, Maximize2, Minimize2, PenLine, X } from "lucide-react";

import { buildLut, lookup, parsePal, type PalLut } from "../lib/pal";
import { beamHeightKm, XSECT_MOMENTS, type XsectData } from "../lib/xsect";
import { useElementSize } from "../lib/useElementSize";
import { useNexradStore } from "../store/useNexradStore";
import { useXsectStore, type XsectUnits } from "../store/useXsectStore";

const KM_TO_MI = 0.621371;
const KM_TO_KFT = 3.28084;

/** Tops offered, in the units shown, and the km asked for. */
const TOPS: Record<XsectUnits, { label: string; km: number }[]> = {
  imperial: [
    { label: "30 kft", km: 9.144 },
    { label: "50 kft", km: 15.24 },
    { label: "65 kft", km: 19.812 },
  ],
  metric: [
    { label: "10 km", km: 10 },
    { label: "15 km", km: 15 },
    { label: "20 km", km: 20 },
  ],
};

const M = { left: 50, right: 14, top: 10, bottom: 30 };

function hm(unix: number): string {
  const d = new Date(unix * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}Z`;
}

/** A round step giving about `n` ticks over `span`. */
function step(span: number, n: number): number {
  const raw = span / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}

function themeVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** The section drawn: the slice in the radar's palette, the beam centres over
 *  it, the ground, and the axes in the units chosen. */
function paint(canvas: HTMLCanvasElement, data: XsectData, pal: PalLut | null, units: XsectUnits, w: number, h: number) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const PLOT_W = w - M.left - M.right;
  const PLOT_H = h - M.top - M.bottom;
  const ctx = canvas.getContext("2d");
  if (!ctx || PLOT_W < 100 || PLOT_H < 60) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { meta, codes } = data;
  const { rows, cols, topKm, lengthKm } = meta;
  const text = themeVar("--text-dim", "#9aa4b2");
  const faint = themeVar("--border-strong", "rgba(140,150,165,0.5)");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // The slice, coloured cell by cell with the radar's own table.
  const img = new ImageData(cols, rows);
  const px = new Uint8Array(4);
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) continue;
    const v = meta.lut[c];
    if (v == null) continue;
    if (pal) lookup(pal, v, px);
    else {
      // No table for this moment: a grey ramp still shows the structure.
      px[0] = px[1] = px[2] = c;
      px[3] = 255;
    }
    const o = i * 4;
    img.data[o] = px[0];
    img.data[o + 1] = px[1];
    img.data[o + 2] = px[2];
    img.data[o + 3] = px[3];
  }
  const off = document.createElement("canvas");
  off.width = cols;
  off.height = rows;
  off.getContext("2d")!.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, M.left, M.top, PLOT_W, PLOT_H);

  const xOf = (col: number) => M.left + (col / (cols - 1)) * PLOT_W;
  const yOf = (km: number) => M.top + (1 - km / topKm) * PLOT_H;

  // Beam centres: where each tilt actually looks, so a gap reads as a gap.
  ctx.lineWidth = 0.7;
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  for (const e of meta.elevations) {
    ctx.beginPath();
    let started = false;
    for (let c = 0; c < cols; c += 4) {
      const h = beamHeightKm(meta.rangeKm[c], e, meta.radarHeightKm);
      if (h > topKm) {
        started = false;
        continue;
      }
      if (!started) ctx.moveTo(xOf(c), yOf(h));
      else ctx.lineTo(xOf(c), yOf(h));
      started = true;
    }
    ctx.stroke();
  }

  // The ground at the radar's height.
  ctx.fillStyle = faint;
  ctx.fillRect(M.left, yOf(meta.groundKm), PLOT_W, 1);

  // Axes.
  ctx.strokeStyle = faint;
  ctx.lineWidth = 1;
  ctx.strokeRect(M.left + 0.5, M.top + 0.5, PLOT_W - 1, PLOT_H - 1);
  ctx.fillStyle = text;
  // A canvas font cannot read a CSS variable: resolve the app's mono first.
  ctx.font = `10.5px ${themeVar("--mono", "ui-monospace, monospace")}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  const hScale = units === "imperial" ? KM_TO_KFT : 1;
  const hTop = topKm * hScale;
  const hStep = step(hTop, Math.max(4, Math.round(PLOT_H / 60)));
  for (let h = 0; h <= hTop + 1e-6; h += hStep) {
    const y = yOf(h / hScale);
    ctx.fillText(`${Math.round(h)}`, M.left - 5, y);
    ctx.fillRect(M.left, y, 3, 1);
  }
  ctx.save();
  ctx.translate(10, M.top + PLOT_H / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText(units === "imperial" ? "kft MSL" : "km MSL", 0, 0);
  ctx.restore();

  const dScale = units === "imperial" ? KM_TO_MI : 1;
  const dLen = lengthKm * dScale;
  const dStep = step(dLen, Math.max(5, Math.round(PLOT_W / 110)));
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let d = 0; d <= dLen + 1e-6; d += dStep) {
    const x = M.left + (d / dLen) * PLOT_W;
    ctx.fillText(`${Math.round(d)}`, x, M.top + PLOT_H + 5);
    ctx.fillRect(x, M.top + PLOT_H - 3, 1, 3);
  }
  ctx.textAlign = "center";
  ctx.fillText(units === "imperial" ? "mi from A" : "km from A", M.left + PLOT_W / 2, M.top + PLOT_H + 17);
  ctx.font = `bold 12px ${themeVar("--mono", "ui-monospace, monospace")}`;
  ctx.textAlign = "left";
  ctx.fillText("A", M.left + 5, M.top + 5);
  ctx.textAlign = "right";
  ctx.fillText("B", M.left + PLOT_W - 5, M.top + 5);
}

/** The cross-section, full screen like the sounding viewer: the slice, what
 *  it shows, and its controls. */
export function CrossSectionPanel() {
  const data = useXsectStore((s) => s.data);
  const busy = useXsectStore((s) => s.busy);
  const error = useXsectStore((s) => s.error);
  const fam = useXsectStore((s) => s.fam);
  const topKm = useXsectStore((s) => s.topKm);
  const units = useXsectStore((s) => s.units);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [plotRef, size] = useElementSize<HTMLDivElement>();
  const [expanded, setExpanded] = useState(false);
  const [probe, setProbe] = useState<{ x: number; text: string } | null>(null);

  // The radar's own palette for the moment, custom tables included.
  const palText = useNexradStore((s) => (data ? s.resolvePal(data.meta.kind) : null));
  const pal = useMemo(() => {
    if (!palText) return null;
    try {
      return buildLut(parsePal(palText));
    } catch {
      return null;
    }
  }, [palText]);

  useEffect(() => {
    if (canvas.current && data) paint(canvas.current, data, pal, units, size.w, size.h);
  }, [data, pal, units, size.w, size.h]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useXsectStore.getState().close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const meta = data?.meta;
  const tops = TOPS[units];
  const topOn = tops.reduce((best, t) => (Math.abs(t.km - topKm) < Math.abs(best.km - topKm) ? t : best), tops[0]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!data || !meta) return;
    const r = e.currentTarget.getBoundingClientRect();
    const PLOT_W = r.width - M.left - M.right;
    const PLOT_H = r.height - M.top - M.bottom;
    const x = e.clientX - r.left - M.left;
    const y = e.clientY - r.top - M.top;
    if (x < 0 || x > PLOT_W || y < 0 || y > PLOT_H) {
      setProbe(null);
      useXsectStore.getState().setHover(null);
      return;
    }
    const t = x / PLOT_W;
    const col = Math.round(t * (meta.cols - 1));
    const row = Math.round((y / PLOT_H) * (meta.rows - 1));
    const code = data.codes[row * meta.cols + col];
    const v = code ? meta.lut[code] : null;
    const km = (1 - y / PLOT_H) * meta.topKm;
    const dist = t * meta.lengthKm;
    const dTxt = units === "imperial" ? `${(dist * KM_TO_MI).toFixed(1)} mi` : `${dist.toFixed(1)} km`;
    const hTxt = units === "imperial" ? `${(km * KM_TO_KFT).toFixed(1)} kft` : `${km.toFixed(1)} km`;
    const vTxt = v == null ? "no echo" : `${v.toFixed(meta.kind === "cc" ? 2 : 1)}${meta.units ? ` ${meta.units}` : ""}`;
    setProbe({ x: e.clientX - r.left, text: `${dTxt} from A · ${hTxt} · ${vTxt}` });
    useXsectStore.getState().setHover(t);
  };
  const onLeave = () => {
    setProbe(null);
    useXsectStore.getState().setHover(null);
  };

  return (
    <div className={`sv xsect-screen${expanded ? " is-expanded" : ""}`} role="dialog" aria-label="Radar cross section">
      <header className="sv__head">
        <div className="sv__title">
          <Layers size={16} />
          <div>
            <strong>Cross section{meta ? ` · ${meta.productLabel}` : ""}</strong>
            <span>
              {meta
                ? `${meta.site} / ${hm(meta.scanUnix)}${meta.vcp ? ` / VCP ${meta.vcp}` : ""} / ${
                    units === "imperial" ? `${(meta.lengthKm * KM_TO_MI).toFixed(0)} mi` : `${meta.lengthKm.toFixed(0)} km`
                  } long / ${meta.elevations.length} tilts`
                : "Reading the volume…"}
            </span>
          </div>
        </div>
        <div className="sv__brand">NEXRAD Level II</div>
        <div className="sv__headbtns">
          <button type="button" onClick={() => useXsectStore.getState().startDrawing()} title="Draw a new line on the map">
            <PenLine size={15} />
          </button>
          <button type="button" onClick={() => setExpanded((v) => !v)} title={expanded ? "Restore" : "Expand"}>
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button type="button" onClick={() => useXsectStore.getState().close()} title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="sv__controls">
        <div className="sv__ctl">
          <span>PRODUCT</span>
          <div className="xsect__seg" role="group" aria-label="Moment">
            {XSECT_MOMENTS.map((m) => (
              <button
                key={m.fam}
                type="button"
                className={fam === m.fam ? "is-on" : ""}
                onClick={() => useXsectStore.getState().setFam(m.fam)}
                title={m.label}
                aria-pressed={fam === m.fam}
              >
                {m.short}
              </button>
            ))}
          </div>
        </div>
        <div className="sv__ctl">
          <span>TOP</span>
          <div className="xsect__seg" role="group" aria-label="Top of the section">
            {tops.map((t) => (
              <button
                key={t.label}
                type="button"
                className={t === topOn ? "is-on" : ""}
                onClick={() => useXsectStore.getState().setTopKm(t.km)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="sv__ctl">
          <span>UNITS</span>
          <div className="xsect__seg" role="group" aria-label="Units">
            <button
              type="button"
              className={units === "imperial" ? "is-on" : ""}
              onClick={() => useXsectStore.getState().setUnits("imperial")}
            >
              mi·kft
            </button>
            <button
              type="button"
              className={units === "metric" ? "is-on" : ""}
              onClick={() => useXsectStore.getState().setUnits("metric")}
            >
              km
            </button>
          </div>
        </div>
        {busy && <Loader2 size={15} className="sv__busy spin" />}
      </div>

      <div className="sv__body xsect__body">
        <div className="xsect__plot" ref={plotRef}>
          {data ? (
            <canvas ref={canvas} className="xsect__canvas" onMouseMove={onMove} onMouseLeave={onLeave} />
          ) : (
            <div className="sv__state">
              {error ? (
                <span>{error}</span>
              ) : (
                <>
                  <Loader2 size={24} className="spin" />
                  <span>Reading every tilt of the volume…</span>
                </>
              )}
            </div>
          )}
          {probe && (
            <div className="xsect__probe" style={{ left: Math.min(Math.max(probe.x, 140), size.w - 140) }}>
              {probe.text}
            </div>
          )}
        </div>
        <div className="xsect__foot">
          {error && data ? (
            <span className="xsect__error">{error}</span>
          ) : meta ? (
            <span>
              {meta.productLabel} · Level II, every tilt · the faint lines are the beams' centres ({meta.elevations.length} cuts) ·
              the timeline steps the scan; the pen draws a new line
            </span>
          ) : (
            <span>A whole volume is read the first time (a few seconds); moving the line after that is instant.</span>
          )}
        </div>
      </div>
    </div>
  );
}
