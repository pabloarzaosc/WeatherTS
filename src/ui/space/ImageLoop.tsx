import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, ExternalLink, Loader2, Pause, Play } from "lucide-react";

import type { Frame } from "../../lib/space/data";
import { fmtUtc } from "./TimeStack";

/**
 * An image that zooms under the wheel about the pointer and pans when dragged:
 * an active region on a 1024-pixel Sun is a few dozen pixels across.
 */
export function ZoomImage({ src, alt, children }: { src: string; alt: string; children?: ReactNode }) {
  const [z, setZ] = useState({ s: 1, x: 0, y: 0 });
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onW = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left - r.width / 2;
      const py = e.clientY - r.top - r.height / 2;
      setZ((p) => {
        const s = Math.min(8, Math.max(1, p.s * (e.deltaY > 0 ? 0.8 : 1.25)));
        if (s === 1) return { s: 1, x: 0, y: 0 };
        const k = s / p.s;
        return { s, x: px - (px - p.x) * k, y: py - (py - p.y) * k };
      });
    };
    el.addEventListener("wheel", onW, { passive: false });
    return () => el.removeEventListener("wheel", onW);
  }, []);
  return (
    <div
      ref={box}
      className={`spc-zoom${z.s > 1 ? " is-zoomed" : ""}`}
      onPointerDown={(e) => {
        if (z.s === 1) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, ox: z.x, oy: z.y };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) setZ((p) => ({ ...p, x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }));
      }}
      onPointerUp={() => (drag.current = null)}
      // A double click (or a double tap: a finger has no wheel) zooms in on
      // that spot, and the next one goes back to the whole picture.
      onDoubleClick={(e) => {
        if (z.s > 1) {
          setZ({ s: 1, x: 0, y: 0 });
          return;
        }
        const r = e.currentTarget.getBoundingClientRect();
        const px = e.clientX - r.left - r.width / 2;
        const py = e.clientY - r.top - r.height / 2;
        setZ({ s: 3, x: -px * 2, y: -py * 2 });
      }}
    >
      <img src={src} alt={alt} draggable={false} style={{ transform: `translate(${z.x}px, ${z.y}px) scale(${z.s})` }} />
      {children}
      {z.s > 1 && <span className="spc-zoom__level">{z.s.toFixed(1)}x</span>}
    </div>
  );
}

const SPEEDS = [2, 4, 8, 15];
const COUNTS = [24, 48, 96, 0];

interface LoopProps {
  frames: Frame[] | null;
  error?: string | null;
  title?: string;
  /** How many of the newest frames to loop, at most (0 = all). */
  count?: number;
  /** Jump to the frame nearest this time (a chart's cursor). */
  syncT?: number | null;
  /** The source page, linked from the corner. */
  href?: string;
  /** Frames older than this are flagged: the product has stopped. */
  staleMs?: number;
  /** Open on the frame nearest this time instead of the newest (a model run that reaches into the future). */
  startAt?: number;
}

/** The newest `count` frames, evenly thinned when the list is longer: a day of
 *  SUVI is 360 pictures of 700 kB, and a loop wants a few dozen. */
function choose(frames: Frame[], count: number, span: number | null): Frame[] {
  let list = frames;
  if (span) {
    const last = frames[frames.length - 1]?.t;
    if (last != null) list = frames.filter((f) => f.t == null || f.t >= last - span);
  }
  if (!count || list.length <= count) return list;
  const out: Frame[] = [];
  const step = (list.length - 1) / (count - 1);
  for (let i = 0; i < count; i++) out.push(list[Math.round(i * step)]);
  return out;
}

function nearestFrame(list: Frame[], t: number): number | null {
  let best: number | null = null;
  let bd = Infinity;
  list.forEach((f, j) => {
    if (f.t == null) return;
    const d = Math.abs(f.t - t);
    if (d < bd) {
      bd = d;
      best = j;
    }
  });
  return best;
}

const SPANS: { label: string; ms: number | null }[] = [
  { label: "6H", ms: 6 * 3_600_000 },
  { label: "12H", ms: 12 * 3_600_000 },
  { label: "24H", ms: 24 * 3_600_000 },
  { label: "All", ms: null },
];

export function ImageLoop({ frames, error, title, count = 48, syncT, href, staleMs = 2 * 86_400_000, startAt }: LoopProps) {
  const [n, setN] = useState(count);
  const [span, setSpan] = useState<number | null>(null);
  const list = useMemo(() => (frames ? choose(frames, n, span) : []), [frames, n, span]);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(8);
  const [loaded, setLoaded] = useState<Set<string>>(new Set());
  const imgs = useRef(new Map<string, HTMLImageElement>());

  // A new list starts on its newest frame, paused: the latest picture first.
  useEffect(() => {
    setI(startAt != null ? nearestFrame(list, startAt) ?? Math.max(0, list.length - 1) : Math.max(0, list.length - 1));
    setPlaying(false);
  }, [list]);

  // Read the frames newest first, a few at a time, so the latest shows at once
  // and the loop fills in behind it.
  useEffect(() => {
    let alive = true;
    const order = [...list].reverse();
    let k = 0;
    const next = () => {
      if (!alive || k >= order.length) return;
      const f = order[k++];
      if (imgs.current.has(f.url) && imgs.current.get(f.url)!.complete) {
        setLoaded((s) => (s.has(f.url) ? s : new Set(s).add(f.url)));
        next();
        return;
      }
      const im = new Image();
      im.decoding = "async";
      im.onload = im.onerror = () => {
        if (!alive) return;
        setLoaded((s) => new Set(s).add(f.url));
        next();
      };
      im.src = f.url;
      imgs.current.set(f.url, im);
    };
    for (let c = 0; c < 4; c++) next();
    return () => {
      alive = false;
    };
  }, [list]);

  useEffect(() => {
    if (!playing || list.length < 2) return;
    const id = window.setInterval(() => {
      setI((cur) => {
        // Skip frames still on their way rather than stall on them.
        for (let s = 1; s <= list.length; s++) {
          const j = (cur + s) % list.length;
          if (loaded.has(list[j].url)) return j;
        }
        return cur;
      });
    }, 1000 / fps);
    return () => window.clearInterval(id);
  }, [playing, fps, list, loaded]);

  useEffect(() => {
    if (syncT == null || !list.length) return;
    const best = nearestFrame(list, syncT);
    if (best != null) {
      setPlaying(false);
      setI(best);
    }
  }, [syncT, list]);

  // The list can shrink under the index (fewer frames picked) a render before
  // the reset effect moves it: read it clamped, or the frame is undefined.
  const idx = list.length ? Math.min(Math.max(i, 0), list.length - 1) : 0;
  const cur = list[idx];
  const have = list.filter((f) => loaded.has(f.url)).length;
  const lastT = frames?.length ? frames[frames.length - 1].t : null;
  const stale = lastT != null && Date.now() - lastT > staleMs;

  if (error) return <div className="spc-loop spc-loop--msg">{error}</div>;
  if (!frames) return <div className="spc-loop spc-loop--msg"><Loader2 size={20} className="spin" /></div>;
  if (!list.length) return <div className="spc-loop spc-loop--msg">No frames right now.</div>;

  return (
    <div className="spc-loop">
      {/* The time goes under the picture, not on it: SWPC's own products carry
          their titles and keys in the corners an overlay would sit on. */}
      <ZoomImage src={cur.url} alt={title ?? "frame"} />
      {stale && lastT != null && <div className="spc-loop__stale">This product has not updated since {fmtUtc(lastT)}.</div>}
      <div className="spc-loop__bar">
        <span className="spc-loop__time" title={title}>
          {cur.t != null ? fmtUtc(cur.t) : cur.url.split("/").pop()}
        </span>
        <button type="button" onClick={() => { setPlaying(false); setI(0); }} title="First frame">
          <ChevronFirst size={14} />
        </button>
        <button type="button" onClick={() => { setPlaying(false); setI((v) => (v - 1 + list.length) % list.length); }} title="Previous frame">
          <ChevronLeft size={14} />
        </button>
        <button type="button" className="spc-loop__play" onClick={() => setPlaying((p) => !p)} title={playing ? "Pause" : "Play"}>
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button type="button" onClick={() => { setPlaying(false); setI((v) => (v + 1) % list.length); }} title="Next frame">
          <ChevronRight size={14} />
        </button>
        <button type="button" onClick={() => { setPlaying(false); setI(list.length - 1); }} title="Latest frame">
          <ChevronLast size={14} />
        </button>
        <input
          type="range"
          min={0}
          max={list.length - 1}
          value={idx}
          onChange={(e) => {
            setPlaying(false);
            setI(Number(e.target.value));
          }}
          className="spc-loop__scrub"
          style={{ ["--loaded" as string]: `${(have / list.length) * 100}%` }}
        />
        <span className="spc-loop__count">
          {idx + 1}/{list.length}
          {have < list.length && <Loader2 size={11} className="spin" />}
        </span>
        <select value={fps} onChange={(e) => setFps(Number(e.target.value))} title="Frames per second">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s} fps
            </option>
          ))}
        </select>
        <select value={span ?? 0} onChange={(e) => setSpan(Number(e.target.value) || null)} title="How far back the loop goes">
          {SPANS.map((s) => (
            <option key={s.label} value={s.ms ?? 0}>
              {s.label}
            </option>
          ))}
        </select>
        {href && (
          <a className="spc-loop__link" href={href} target="_blank" rel="noopener" title="About this product">
            <ExternalLink size={12} />
          </a>
        )}
        <select value={n} onChange={(e) => setN(Number(e.target.value))} title="Frames in the loop">
          {/* The count the loop was opened with (36 for a sector) joins the list. */}
          {[...new Set([...COUNTS.filter(Boolean), count].filter(Boolean))].sort((a, z) => a - z).concat(0).map((c) => (
            <option key={c} value={c}>
              {c ? `${c} frames` : "Every frame"}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
