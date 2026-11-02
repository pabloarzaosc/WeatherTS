import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  AppWindow,
  ArrowLeftRight,
  Columns2,
  Ellipsis,
  Layers2,
  Maximize2,
  Minimize2,
  PanelRight,
  PanelsTopLeft,
  SquareSplitHorizontal,
  X,
} from "lucide-react";

import { getActivePaneId, subscribeMaps } from "../map/mapInstance";
import { beginPaneDrag } from "../lib/paneDrag";
import { closePane, paneIds } from "../lib/paneOps";
import { startCompare, stopCompare, swapSides } from "../lib/paneCompare";
import {
  ANALYSIS_LABEL,
  TITLE_H,
  backToOverlay,
  canFloat,
  closeAnalysis,
  dockBack,
  isFloat,
  placeInChosen,
  placeInPane,
  popOut,
  raise,
  setRect,
  toggleFull,
  windowTitle,
} from "../lib/paneWindows";
import { useAppStore } from "../store/useAppStore";
import { ExportMenuItem } from "./ExportPage";
import { useCompareStore } from "../store/useCompareStore";
import { useNexradStore } from "../store/useNexradStore";
import { paneLetter, usePaneStore, type AnalysisKind, type PaneFloat } from "../store/usePaneStore";

/** True inside an analysis view that sits in a pane (its panel then fits the
 *  pane instead of covering the map, and drops its own placement button). */
export const InPaneContext = createContext(false);
export const useInPane = () => useContext(InPaneContext);

// ---------------------------------------------------------------- pane menu

/**
 * The pane's actions, for its ⋯ menu and for the map's right-click menu:
 * Compare (and, while comparing, Change product / Swap sides / Stop
 * comparing), Window / Back to a pane, Fullscreen for a window.
 */
export function PaneMenuItems({ id, onDone, itemClass }: { id: string; onDone: () => void; itemClass: string }) {
  const comparing = useCompareStore((s) => !!s.slots[id]);
  const floating = usePaneStore((s) => isFloat(s.floats[id]));
  const full = usePaneStore((s) => !!s.floats[id]?.full);
  const view = usePaneStore((s) => s.analysis[id]);
  const host = useNexradStore((s) => s.paneRadar[id]);
  const site = useNexradStore((s) => s.site);
  const count = useAppStore((s) => s.paneCount);
  const radarOn = useAppStore((s) => !!s.layers.nexrad?.visible);
  // Nothing to compare with until the radar has said what it publishes.
  const listed = useNexradStore((s) => s.grids.some((f) => !f.checking && !f.unavailable));
  const canCompare = !view && radarOn && !!site && !!host && !host.empty && listed;
  const act = (fn: () => void) => () => {
    fn();
    onDone();
  };
  return (
    <>
      {!view && !comparing && (
        <button
          type="button"
          className={itemClass}
          disabled={!canCompare}
          onClick={act(() => startCompare(id))}
          title={canCompare ? "Split this pane between two products with a divider" : site && !listed ? "Reading this radar's products…" : "Show a radar product in this pane first"}
        >
          <Columns2 size={15} />
          Compare two products
        </button>
      )}
      {!view && comparing && (
        <>
          <button type="button" className={itemClass} onClick={act(() => useCompareStore.getState().setPicking(id))}>
            <SquareSplitHorizontal size={15} />
            Change compared product
          </button>
          <button type="button" className={itemClass} onClick={act(() => swapSides(id))} title="The right product goes left and the other way round">
            <ArrowLeftRight size={15} />
            Swap sides
          </button>
          <button type="button" className={itemClass} onClick={act(() => stopCompare(id))}>
            <X size={15} />
            Stop comparing
          </button>
        </>
      )}
      {floating ? (
        <>
          <button type="button" className={itemClass} onClick={act(() => dockBack(id))}>
            <PanelsTopLeft size={15} />
            Back to a pane
          </button>
          <button type="button" className={itemClass} onClick={act(() => toggleFull(id))}>
            {full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            {full ? "Exit fullscreen" : "Fullscreen"}
          </button>
        </>
      ) : (
        <button
          type="button"
          className={itemClass}
          disabled={!canFloat(id)}
          onClick={act(() => popOut(id))}
          title={count > 1 ? "Float this pane over the map as a window" : "Add a pane first: a window floats over the others"}
        >
          <AppWindow size={15} />
          Window
        </button>
      )}
      {view && (
        <>
          <button type="button" className={itemClass} onClick={act(() => backToOverlay(view))}>
            <Layers2 size={15} />
            {ANALYSIS_LABEL[view]} over the map
          </button>
          <button type="button" className={itemClass} onClick={act(() => closeAnalysis(view))}>
            <X size={15} />
            Close the {ANALYSIS_LABEL[view].toLowerCase()}
          </button>
        </>
      )}
    </>
  );
}

/** The ⋯ button in a pane's top-right tools. */
export function PaneMenuButton({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The list lives on <body>, fixed under the button: a pane clips what it
  // holds, and the product picker floats over its top-right corner.
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const r = ref.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !listRef.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <span className="pmenu" ref={ref}>
      <button
        type="button"
        className={`panetools__btn${open ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={`Pane ${paneLetter(id)}: compare, window`}
      >
        <Ellipsis size={13} />
      </button>
      {open &&
        at &&
        createPortal(
          <div className="pmenu__list" role="menu" ref={listRef} style={{ top: at.top, right: at.right }}>
            <div className="pmenu__head">Pane {paneLetter(id)}</div>
            <PaneMenuItems id={id} onDone={() => setOpen(false)} itemClass="pmenu__item" />
            {/* export step: this pane's Export page */}
            <ExportMenuItem paneId={id} onDone={() => setOpen(false)} itemClass="pmenu__item" />
          </div>,
          document.body,
        )}
    </span>
  );
}

// ---------------------------------------------------------- floating frames

function useWindowTitle(id: string): string {
  // Re-read on the changes that rename it.
  useNexradStore((s) => s.paneRadar[id]?.family);
  useNexradStore((s) => s.site);
  useNexradStore((s) => s.sites.length);
  useCompareStore((s) => s.slots[id]?.family);
  usePaneStore((s) => s.analysis[id]);
  return windowTitle(id);
}

/** Where each floating pane stacks: 10 + its rank (above the grid's dividers,
 *  under the app's panels and pickers). */
export function floatRanks(floats: Record<string, PaneFloat>): Record<string, number> {
  const list = Object.entries(floats)
    .filter(([, f]) => isFloat(f))
    .sort((a, b) => a[1].z - b[1].z);
  const out: Record<string, number> = {};
  list.forEach(([id], i) => (out[id] = 10 + i));
  return out;
}

export function floatBox(f: PaneFloat): { x: number; y: number; w: number; h: number } {
  return f.full ? { x: 0, y: 0, w: 1, h: 1 } : f;
}

/** The title bars and resize edges of the floating panes (MapView). */
export function FloatFrames({ canvas }: { canvas: RefObject<HTMLDivElement | null> }) {
  const floats = usePaneStore((s) => s.floats);
  const count = useAppStore((s) => s.paneCount);
  const ranks = floatRanks(floats);
  const ids = paneIds(count).filter((id) => isFloat(floats[id]));
  return (
    <>
      {ids.map((id) => (
        <FloatFrame key={id} id={id} f={floats[id]} z={ranks[id] ?? 10} canvas={canvas} top={ranks[id] === 9 + ids.length} />
      ))}
    </>
  );
}

type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const EDGES: Edge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

function FloatFrame({ id, f, z, canvas, top }: { id: string; f: PaneFloat; z: number; canvas: RefObject<HTMLDivElement | null>; top: boolean }) {
  const title = useWindowTitle(id);
  const focused = useSyncExternalStore(subscribeMaps, getActivePaneId) === id;
  const view = usePaneStore((s) => s.analysis[id]);
  const box = floatBox(f);

  /** Drag the title bar (move) or an edge (resize), in shares of the map area. */
  const drag = (edge: Edge | null) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const host = canvas.current;
    if (!host) return;
    e.preventDefault();
    raise(id);
    const r = host.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY };
    const b0 = floatBox(usePaneStore.getState().floats[id] ?? f);
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add("is-pwin-drag");
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / r.width;
      const dy = (ev.clientY - start.y) / r.height;
      if (!edge) {
        setRect(id, { x: b0.x + dx, y: b0.y + dy, w: b0.w, h: b0.h });
        return;
      }
      let { x, y, w, h } = b0;
      if (edge.includes("e")) w = Math.min(1 - x, b0.w + dx);
      if (edge.includes("s")) h = Math.min(1 - y, b0.h + dy);
      if (edge.includes("w")) {
        const nx = Math.max(0, Math.min(b0.x + b0.w - 0.16, b0.x + dx));
        w = b0.w + (b0.x - nx);
        x = nx;
      }
      if (edge.includes("n")) {
        const ny = Math.max(0, Math.min(b0.y + b0.h - 0.2, b0.y + dy));
        h = b0.h + (b0.y - ny);
        y = ny;
      }
      setRect(id, { x, y, w, h });
    };
    const up = () => {
      document.body.classList.remove("is-pwin-drag");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <div
      className={`pwin${focused ? " is-focused" : ""}${top ? " is-top" : ""}${f.full ? " is-full" : ""}`}
      style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%`, zIndex: z }}
      data-pwin={id}
    >
      <div
        className="pwin__bar"
        style={{ height: TITLE_H }}
        onPointerDown={drag(null)}
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).closest("button")) toggleFull(id);
        }}
        title="Drag to move · double-click for fullscreen"
      >
        <span className="pwin__title">{title}</span>
        <span className="pwin__btns">
          <button type="button" onClick={() => toggleFull(id)} title={f.full ? "Exit fullscreen" : "Fullscreen"} aria-label="Fullscreen">
            {f.full ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button type="button" onClick={() => dockBack(id)} title="Back to a pane" aria-label="Back to a pane">
            <PanelsTopLeft size={13} />
          </button>
          <button
            type="button"
            onClick={() => (view ? closeAnalysis(view) : closePane(id))}
            title={view ? `Close the ${ANALYSIS_LABEL[view].toLowerCase()}` : "Close this pane"}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </span>
      </div>
      {!f.full && EDGES.map((edge) => <span key={edge} className={`pwin__edge pwin__edge--${edge}`} onPointerDown={drag(edge)} />)}
    </div>
  );
}

// ------------------------------------------------------- analysis in a pane

/**
 * Where an analysis view draws: over the map as before, or -- when a pane
 * holds it -- inside that pane (a portal, so it moves with the pane, floats
 * with it as a window, and is clipped by it).
 */
export function AnalysisHost({ kind, children }: { kind: AnalysisKind; children: ReactNode }) {
  const paneId = usePaneStore((s) => {
    for (const [id, k] of Object.entries(s.analysis)) if (k === kind) return id;
    return null;
  });
  const count = useAppStore((s) => s.paneCount);
  const [el, setEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setEl(null);
    if (!paneId) return;
    let raf = 0;
    let tries = 0;
    const find = () => {
      const e = document.querySelector<HTMLElement>(`.mappane[data-pane="${paneId}"]`);
      if (e) setEl(e);
      else if (tries++ < 120) raf = requestAnimationFrame(find);
    };
    find();
    return () => cancelAnimationFrame(raf);
  }, [paneId, count]);
  if (!paneId) return <>{children}</>;
  if (!el || !el.isConnected) return null;
  return createPortal(
    <AnalysisInPane id={paneId} kind={kind}>
      {children}
    </AnalysisInPane>,
    el,
  );
}

function AnalysisInPane({ id, kind, children }: { id: string; kind: AnalysisKind; children: ReactNode }) {
  const floating = usePaneStore((s) => isFloat(s.floats[id]));
  const count = useAppStore((s) => s.paneCount);
  const label = ANALYSIS_LABEL[kind];
  return (
    <div
      className="apane"
      data-kind={kind}
      // The map under the view is not the one the tools act on: a click here
      // must not focus this pane (MapPane focuses on mousedown).
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={() => raise(id)}
    >
      {!floating && (
        <div className="apane__bar">
          <span
            className="apane__chip"
            onPointerDown={(e) => count > 1 && beginPaneDrag(e, { kind: "analysis", from: id, view: kind, label })}
            title={count > 1 ? "Drag onto another pane to move the view there" : undefined}
          >
            {count > 1 && <b>{paneLetter(id)}</b>}
            {label}
          </span>
          <span className="apane__btns">
            <button type="button" onClick={() => popOut(id)} disabled={!canFloat(id)} title="Window: float the view over the map">
              <AppWindow size={13} />
            </button>
            <button type="button" onClick={() => backToOverlay(kind)} title="Over the map again (as a panel)">
              <Layers2 size={13} />
            </button>
            <button type="button" onClick={() => closeAnalysis(kind)} title="Close" aria-label="Close">
              <X size={14} />
            </button>
          </span>
        </div>
      )}
      <div className="apane__body">
        <InPaneContext.Provider value={true}>{children}</InPaneContext.Provider>
      </div>
    </div>
  );
}

/** The panels' header button: open the view in a pane of its own. */
export function AnalysisPlaceButton({ kind }: { kind: AnalysisKind }) {
  const inPane = useInPane();
  if (inPane) return null;
  return (
    <button type="button" onClick={() => placeInPane(kind)} title="Open in a pane of its own, beside the map">
      <PanelRight size={15} />
    </button>
  );
}

/** "Where should it open?" -- every pane is in use. */
export function AnalysisChooser() {
  const chooser = usePaneStore((s) => s.chooser);
  const count = useAppStore((s) => s.paneCount);
  useEffect(() => {
    if (!chooser) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        usePaneStore.setState({ chooser: null });
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [chooser]);
  if (!chooser) return null;
  const kind = chooser.kind;
  const ids = paneIds(count);
  const label = (id: string) => {
    const t = windowTitle(id);
    return t.replace(/^Pane [A-F] · /, "");
  };
  // On <body>, over the app's panels (the map area is a layer under them).
  return createPortal(
    <div className="pchoose" role="dialog" aria-label={`Where should the ${ANALYSIS_LABEL[kind].toLowerCase()} open?`}>
      <div className="pchoose__head">
        <strong>Where should the {ANALYSIS_LABEL[kind].toLowerCase()} open?</strong>
        <span>Every pane is in use. The pane you pick shows the view while it is open, then its map again.</span>
      </div>
      <div className="pchoose__grid">
        {ids.map((id) => (
          <button key={id} type="button" className="pchoose__pane" onClick={() => placeInChosen(kind, id)}>
            <b>{paneLetter(id)}</b>
            <span>{label(id)}</span>
          </button>
        ))}
      </div>
      <div className="pchoose__foot">
        <button
          type="button"
          onClick={() => {
            usePaneStore.setState({ chooser: null });
            backToOverlay(kind);
          }}
        >
          Over the map
        </button>
        <button type="button" onClick={() => usePaneStore.setState({ chooser: null })}>
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
}

