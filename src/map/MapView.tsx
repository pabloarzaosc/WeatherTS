import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import { useAppStore } from "../store/useAppStore";
import { useNexradStore } from "../store/useNexradStore";
import { layoutOf, usePaneStore, type PaneLayoutId, type PaneSizes } from "../store/usePaneStore";
import { PaneDragGhost } from "../ui/PaneChrome";
import { AnalysisChooser, FloatFrames, floatBox, floatRanks } from "../ui/PaneWindows";
import { isFloat, TITLE_H } from "../lib/paneWindows";
import { MapPane, type PanePlace } from "./MapPane";
import { PRIMARY_PANE } from "./mapInstance";

/**
 * The map area. One pane is the normal case; split screen tiles 2 (side by
 * side or stacked), 3 (two over one), 4 or 6 panes, each a full map with the
 * whole layer stack. The dividers between them drag, and each layout keeps
 * where they were left (usePaneStore). Panes share the camera and the
 * timeline unless a pane's own switches say otherwise (PaneChrome).
 *
 * The per-map lifecycle lives in MapPane; this component only decides how many
 * there are and how they're laid out.
 */
export function MapView() {
  const paneCount = useAppStore((s) => s.paneCount);
  const stacked = usePaneStore((s) => s.stacked);
  const saved = usePaneStore((s) => s.sizes);
  const floats = usePaneStore((s) => s.floats);
  const ids = Array.from({ length: paneCount }, (_, i) => (i === 0 ? PRIMARY_PANE : `pane-${i}`));
  // Floating windows (panes-compare) leave the grid: it tiles the others.
  const tiled = ids.filter((id) => !isFloat(floats[id]));
  const tiles = Math.max(1, tiled.length);
  const layout = layoutOf(tiles, stacked);
  const sizes = usePaneStore.getState().sizesFor(layout);
  void saved; // re-render when sizes change
  const canvas = useRef<HTMLDivElement>(null);
  const ranks = floatRanks(floats);
  const place = (id: string): PanePlace | undefined => {
    const f = floats[id];
    if (isFloat(f)) {
      const b = floatBox(f);
      return {
        floating: true,
        style: {
          position: "absolute",
          left: `${b.x * 100}%`,
          top: `calc(${b.y * 100}% + ${TITLE_H}px)`,
          width: `${b.w * 100}%`,
          height: `calc(${b.h * 100}% - ${TITLE_H}px)`,
          zIndex: ranks[id] ?? 10,
        },
      };
    }
    // With windows out of the grid, the third tile of "two over one" spans
    // the bottom row (app.css counts DOM children, which windows still are).
    if (tiled.length === ids.length) return undefined;
    const k = tiled.indexOf(id);
    return { style: { gridColumn: layout === "3" && k === 2 ? "1 / -1" : "auto" } };
  };

  useClearHiddenOnShow();

  const style = {
    "--pane-cols": sizes.cols.map((f) => `minmax(0, ${f}fr)`).join(" "),
    "--pane-rows": sizes.rows.map((f) => `minmax(0, ${f}fr)`).join(" "),
  } as CSSProperties;

  return (
    <div
      ref={canvas}
      className={`map-canvas map-canvas--panes-${tiles} map-canvas--l-${layout}${paneCount > 1 ? " map-canvas--multi" : ""}`}
      style={style}
    >
      {ids.map((id) => (
        <MapPane key={id} id={id} place={place(id)} />
      ))}
      <Dividers layout={layout} sizes={sizes} canvas={canvas} />
      <FloatFrames canvas={canvas} />
      <AnalysisChooser />
      <PaneDragGhost />
    </div>
  );
}

/** A layer or storm tracks switched on again shows on every pane again. */
function useClearHiddenOnShow() {
  useEffect(() => {
    const clear = (overlay: string) => {
      const ps = usePaneStore.getState();
      const hidden: Record<string, string[]> = {};
      let changed = false;
      for (const [pid, list] of Object.entries(ps.hidden)) {
        hidden[pid] = list.filter((x) => x !== overlay);
        if (hidden[pid].length !== list.length) changed = true;
      }
      if (changed) usePaneStore.setState({ hidden });
    };
    const offLayers = useAppStore.subscribe((s, p) => {
      if (s.layers === p.layers) return;
      for (const [id, st] of Object.entries(s.layers)) if (st.visible && !p.layers[id]?.visible) clear(id);
    });
    const offTracks = useNexradStore.subscribe((s, p) => {
      if (s.showTracks && !p.showTracks) clear("storms");
    });
    return () => {
      offLayers();
      offTracks();
    };
  }, []);
}

const GAP = 2; // .map-canvas gap, px
const MIN_SHARE = 0.15;

interface Divider {
  axis: "x" | "y";
  /** Index of the boundary: between cols[i] and cols[i+1] (or rows). */
  i: number;
  /** The part of the other axis it spans, as a share range [from, to]. */
  span: [number, number];
}

function dividersFor(layout: PaneLayoutId, sizes: PaneSizes): Divider[] {
  switch (layout) {
    case "2":
      return [{ axis: "x", i: 0, span: [0, 1] }];
    case "2h":
      return [{ axis: "y", i: 0, span: [0, 1] }];
    case "3":
      // Two over one: the upright divider runs down the top row only.
      return [
        { axis: "x", i: 0, span: [0, sizes.rows[0]] },
        { axis: "y", i: 0, span: [0, 1] },
      ];
    case "4":
      return [
        { axis: "x", i: 0, span: [0, 1] },
        { axis: "y", i: 0, span: [0, 1] },
      ];
    case "6":
      return [
        { axis: "x", i: 0, span: [0, 1] },
        { axis: "x", i: 1, span: [0, 1] },
        { axis: "y", i: 0, span: [0, 1] },
      ];
    default:
      return [];
  }
}

/** Where boundary i sits, as a CSS length along its axis. */
function edgeAt(shares: number[], i: number): string {
  const n = shares.length;
  const before = shares.slice(0, i + 1).reduce((a, b) => a + b, 0);
  return `calc((100% - ${(n - 1) * GAP}px) * ${before} + ${i * GAP + GAP / 2}px)`;
}

function spanCss(shares: number[], span: [number, number]): { start: string; size: string } {
  const n = shares.length;
  const whole = span[0] === 0 && span[1] === 1;
  if (whole) return { start: "0px", size: "100%" };
  // Only "from the start to the end of track 0" is used (layout 3).
  return { start: "0px", size: `calc((100% - ${(n - 1) * GAP}px) * ${span[1]})` };
}

function Dividers({ layout, sizes, canvas }: { layout: PaneLayoutId; sizes: PaneSizes; canvas: RefObject<HTMLDivElement | null> }) {
  const list = dividersFor(layout, sizes);
  if (!list.length) return null;

  const start = (d: Divider) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = canvas.current;
    if (!el) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("is-dragging");
    const rect = el.getBoundingClientRect();
    const key = d.axis === "x" ? "cols" : "rows";
    const base = usePaneStore.getState().sizesFor(layout);
    const shares = base[key];
    const n = shares.length;
    const len = (d.axis === "x" ? rect.width : rect.height) - (n - 1) * GAP;
    const before = shares.slice(0, d.i).reduce((a, b) => a + b, 0);
    const pair = shares[d.i] + shares[d.i + 1];
    const move = (ev: PointerEvent) => {
      const pos = d.axis === "x" ? ev.clientX - rect.left : ev.clientY - rect.top;
      const at = (pos - d.i * GAP - GAP / 2) / len;
      const mine = Math.max(MIN_SHARE, Math.min(pair - MIN_SHARE, at - before));
      const next = [...shares];
      next[d.i] = mine;
      next[d.i + 1] = pair - mine;
      usePaneStore.getState().setSizes(layout, { ...base, [key]: next });
    };
    const up = () => {
      handle.classList.remove("is-dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  return (
    <>
      {list.map((d) => {
        const along = d.axis === "x" ? sizes.cols : sizes.rows;
        const across = d.axis === "x" ? sizes.rows : sizes.cols;
        const pos = edgeAt(along, d.i);
        const sp = spanCss(across, d.span);
        const st: CSSProperties =
          d.axis === "x"
            ? { left: pos, top: sp.start, height: sp.size }
            : { top: pos, left: sp.start, width: sp.size };
        return (
          <div
            key={`${d.axis}${d.i}`}
            className={`panediv panediv--${d.axis}`}
            style={st}
            role="separator"
            aria-orientation={d.axis === "x" ? "vertical" : "horizontal"}
            title="Drag to resize the panes · double-click to even them out"
            onPointerDown={start(d)}
            onDoubleClick={() => usePaneStore.getState().resetSizes(layout)}
          />
        );
      })}
    </>
  );
}
