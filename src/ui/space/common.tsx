import { useEffect, useRef, useState, type ReactNode } from "react";

import type { Series } from "../../lib/space/data";

/**
 * A SWPC read that keeps itself current: it runs again every `refreshS` while
 * the component is up (SWPC's files turn over every minute), and on a change
 * of key. A failed refresh keeps the last good answer.
 */
export function useSwpc<T>(key: string, fn: () => Promise<T>, refreshS = 60) {
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null; at: number | null }>({
    key,
    data: null,
    error: null,
    at: null,
  });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    const run = () =>
      fnRef
        .current()
        .then((data) => alive && setState({ key, data, error: null, at: Date.now() }))
        .catch((e: unknown) => alive && setState((s) => ({ ...s, key, error: e instanceof Error ? e.message : String(e) })));
    setState((s) => (s.key === key ? s : { key, data: null, error: null, at: null }));
    run();
    const id = window.setInterval(run, refreshS * 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [key, refreshS]);
  const fresh = state.key === key;
  return { data: fresh ? state.data : null, error: fresh ? state.error : null, at: state.at };
}

/** NOAA's own colours for the five levels of each scale, and none. */
export const SCALE_COLORS = ["#4caf50", "#f6eb14", "#ffc800", "#ff9600", "#ff0000", "#c80000"];
/** Text on each of those: the yellows need dark ink. */
export const SCALE_INK = ["#0d1a0d", "#1a1a00", "#1a1400", "#1a0e00", "#fff", "#fff"];

export const SCALE_NAMES = ["None", "Minor", "Moderate", "Strong", "Severe", "Extreme"];

export function ScaleBadge({ k, level, big }: { k: "R" | "S" | "G"; level: number; big?: boolean }) {
  const l = Math.max(0, Math.min(5, level));
  return (
    <span className={`spc-scale${big ? " spc-scale--big" : ""}`} style={{ background: SCALE_COLORS[l], color: SCALE_INK[l] }} title={`${k}${l}: ${SCALE_NAMES[l]}`}>
      {k}
      {l}
    </span>
  );
}

/** The G level a Kp reaches: Kp 5- (4.67) already counts as G1. */
export function gOfKp(kp: number): number {
  const k = Math.round(kp);
  return k >= 9 ? 5 : k >= 8 ? 4 : k >= 7 ? 3 : k >= 6 ? 2 : k >= 5 ? 1 : 0;
}

export function kpColor(kp: number): string {
  const g = gOfKp(kp);
  if (g > 0) return SCALE_COLORS[g];
  return Math.round(kp) >= 4 ? "#c9c23a" : "#4caf50";
}

/** "4+" for 4.33, "5-" for 4.67: Kp as SWPC writes it. */
export function kpText(kp: number): string {
  const whole = Math.round(kp);
  const frac = kp - whole;
  return `${whole}${frac > 0.15 ? "+" : frac < -0.15 ? "-" : ""}`;
}

/** The newest finite value in a series. */
export function latest(s: Series | null | undefined): { t: number; v: number } | null {
  if (!s) return null;
  for (let i = s.v.length - 1; i >= 0; i--) if (Number.isFinite(s.v[i])) return { t: s.t[i], v: s.v[i] };
  return null;
}

/** The series cut to its last `ms`. */
export function tail(s: Series, ms: number, end = Date.now()): Series {
  const from = end - ms;
  let i = 0;
  while (i < s.t.length && s.t[i] < from) i++;
  return { t: s.t.subarray(i), v: s.v.subarray(i) };
}

export function Card({ title, extra, children, className }: { title?: ReactNode; extra?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`spc-card${className ? ` ${className}` : ""}`}>
      {(title || extra) && (
        <header className="spc-card__head">
          {title && <h3>{title}</h3>}
          {extra}
        </header>
      )}
      {children}
    </section>
  );
}

export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; label: string; title?: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="xsect__seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.id)} type="button" className={value === o.id ? "is-on" : ""} onClick={() => onChange(o.id)} title={o.title} disabled={o.disabled}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Loading({ error, what }: { error?: string | null; what?: string }) {
  return <div className="spc-msg">{error ? `Could not read ${what ?? "this"}: ${error}` : `Reading ${what ?? "SWPC"}…`}</div>;
}

/** Plain colours for chart lines, picked to stay apart on both themes. */
export const C = {
  bt: "var(--sx-wind)",
  bz: "#ff5a4f",
  by: "#4ade80",
  bx: "#5aa9ff",
  phi: "#d08cff",
  speed: "#f6b93b",
  density: "#38bdf8",
  temp: "#ff7ab6",
  xlong: "#ff6b5e",
  xshort: "#6c9dff",
  p10: "#ff6b5e",
  dst: "#38bdf8",
  model: "#d08cff",
  north: "#4ade80",
  south: "#38bdf8",
};

/** A palette for many channels at once (protons, EPAM). */
export const RAMP = ["#ff5a4f", "#ff9a3c", "#f6d743", "#8fd14f", "#36c5a0", "#38bdf8", "#6c8cff", "#a879ff", "#e26cff", "#ff7ab6", "#c8c8c8", "#9aa4b2", "#ffd0a0"];
