import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * How the split-screen panes are arranged and tied together (panes-layout).
 *
 * The pane COUNT stays in useAppStore (links, "Add radar" and the dock read it
 * there); this keeps what goes with it:
 *   * whether two panes sit side by side or stacked,
 *   * where the dividers were dragged to, per layout,
 *   * per pane: camera sync, following the main animation, and the overlays
 *     taken off that pane (a mosaic, an outlook, storm tracks),
 *   * the chip being dragged between panes, for the drop hints.
 *
 * Pane ids are "pane-0".."pane-5" and keep their place on screen; closing a
 * pane moves the ones after it down a slot (paneOps.closePane), so everything
 * here is keyed by that id.
 */

export type PaneLayoutId = "1" | "2" | "2h" | "3" | "4" | "6";

export interface PaneSizes {
  /** Column shares, summing to 1 (left to right). */
  cols: number[];
  /** Row shares, summing to 1 (top to bottom). */
  rows: number[];
}

export interface PaneSync {
  /** Pan and zoom with the other panes that have this on. */
  camera: boolean;
  /** Show the main timeline's frame; off = this pane's own scrubber. */
  follow: boolean;
}

export interface OwnPlay {
  playing: boolean;
  /** Playback speed (PLAY_SPEEDS). */
  speed: number;
  /** Seconds the last frame is held before the loop starts again. */
  delay: number;
}

/** What is being dragged onto a pane. */
export type PaneDragItem =
  | { kind: "radar"; from: string; label: string }
  | { kind: "overlay"; from: string; overlay: string; label: string }
  | { kind: "family"; family: string; label: string }
  /** panes-compare: an analysis view's chip (cross-section, 3D). */
  | { kind: "analysis"; from: string; view: AnalysisKind; label: string };

export interface PaneDrag {
  item: PaneDragItem;
  x: number;
  y: number;
  /** The pane under the pointer, or null. */
  over: string | null;
}

export const DEFAULT_SYNC: PaneSync = { camera: true, follow: true };

/** A pane floating over the map area as a window: its box (title bar included)
 *  as shares of the map area, its place in the stack, and Fullscreen. */
export interface PaneFloat {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  full?: boolean;
  /** Back in the grid; the box is only remembered for the next Window. */
  docked?: boolean;
}

/** The analysis views that can take a pane: cross-section, 3D. */
export type AnalysisKind = "xsect" | "r3d";
export type AnalysisPlace = "overlay" | "pane" | "window";

export function equalSizes(layout: PaneLayoutId): PaneSizes {
  const even = (n: number) => Array.from({ length: n }, () => 1 / n);
  switch (layout) {
    case "2":
      return { cols: even(2), rows: [1] };
    case "2h":
      return { cols: [1], rows: even(2) };
    case "3":
    case "4":
      return { cols: even(2), rows: even(2) };
    case "6":
      return { cols: even(3), rows: even(2) };
    default:
      return { cols: [1], rows: [1] };
  }
}

export function layoutOf(count: number, stacked: boolean): PaneLayoutId {
  if (count <= 1) return "1";
  if (count === 2) return stacked ? "2h" : "2";
  if (count === 3) return "3";
  if (count === 4) return "4";
  return "6";
}

/** Pane letter for its id: pane-0 -> A. */
export function paneLetter(id: string): string {
  const n = Number(id.replace(/^pane-/, ""));
  return Number.isFinite(n) ? String.fromCharCode(65 + n) : "?";
}

/** A saved size list that fits the layout, else the even split. */
function validSizes(layout: PaneLayoutId, s: PaneSizes | undefined): PaneSizes {
  const want = equalSizes(layout);
  if (!s || s.cols.length !== want.cols.length || s.rows.length !== want.rows.length) return want;
  const ok = (a: number[]) => a.every((v) => Number.isFinite(v) && v > 0.05) && Math.abs(a.reduce((x, y) => x + y, 0) - 1) < 0.01;
  return ok(s.cols) && ok(s.rows) ? s : want;
}

interface PaneStoreState {
  stacked: boolean;
  sizes: Partial<Record<PaneLayoutId, PaneSizes>>;
  sync: Record<string, PaneSync>;
  hidden: Record<string, string[]>;
  own: Record<string, OwnPlay>;
  drag: PaneDrag | null;
  /** A chip asked for a catalog panel to open ("observations", "outlooks"). */
  panelRequest: { panel: string; at: number } | null;
  /** panes-compare: panes popped out into floating windows (lib/paneWindows). */
  floats: Record<string, PaneFloat>;
  /** panes-compare: the analysis view a pane shows instead of its map. */
  analysis: Record<string, AnalysisKind>;
  /** panes-compare: panes added to the layout for their analysis view. */
  added: Record<string, boolean>;
  /** panes-compare: where each analysis view opened last (it opens there again). */
  analysisPref: Partial<Record<AnalysisKind, AnalysisPlace>>;
  /** panes-compare: "where should it open" is being asked. */
  chooser: { kind: AnalysisKind; at: number } | null;

  setStacked: (v: boolean) => void;
  sizesFor: (layout: PaneLayoutId) => PaneSizes;
  setSizes: (layout: PaneLayoutId, s: PaneSizes) => void;
  resetSizes: (layout: PaneLayoutId) => void;
  syncOf: (id: string) => PaneSync;
  setSync: (id: string, patch: Partial<PaneSync>) => void;
  isHidden: (id: string, overlay: string) => boolean;
  setHidden: (id: string, overlay: string, hide: boolean) => void;
  ownOf: (id: string) => OwnPlay | undefined;
  setOwn: (id: string, patch: Partial<OwnPlay>) => void;
  setDrag: (d: PaneDrag | null) => void;
  requestPanel: (panel: string) => void;
}

export const usePaneStore = create<PaneStoreState>()(
  persist(
    (set, get) => ({
      stacked: false,
      sizes: {},
      sync: {},
      hidden: {},
      own: {},
      drag: null,
      panelRequest: null,
      floats: {},
      analysis: {},
      added: {},
      analysisPref: {},
      chooser: null,

      setStacked: (stacked) => set({ stacked }),
      sizesFor: (layout) => validSizes(layout, get().sizes[layout]),
      setSizes: (layout, s) => set({ sizes: { ...get().sizes, [layout]: s } }),
      resetSizes: (layout) => {
        const sizes = { ...get().sizes };
        delete sizes[layout];
        set({ sizes });
      },
      syncOf: (id) => get().sync[id] ?? DEFAULT_SYNC,
      setSync: (id, patch) => set({ sync: { ...get().sync, [id]: { ...get().syncOf(id), ...patch } } }),
      isHidden: (id, overlay) => !!get().hidden[id]?.includes(overlay),
      setHidden: (id, overlay, hide) => {
        const cur = get().hidden[id] ?? [];
        if (hide === cur.includes(overlay)) return;
        const next = hide ? [...cur, overlay] : cur.filter((x) => x !== overlay);
        set({ hidden: { ...get().hidden, [id]: next } });
      },
      ownOf: (id) => get().own[id],
      setOwn: (id, patch) => {
        const cur = get().own[id] ?? { playing: false, speed: 1, delay: 0 };
        set({ own: { ...get().own, [id]: { ...cur, ...patch } } });
      },
      setDrag: (drag) => set({ drag }),
      requestPanel: (panel) => set({ panelRequest: { panel, at: Date.now() } }),
    }),
    {
      name: "weatherts-panes",
      version: 1,
      // `added` is kept so the next start can take those panes away again
      // (the views they held do not come back after a reload).
      partialize: (s) => ({
        stacked: s.stacked,
        sizes: s.sizes,
        sync: s.sync,
        hidden: s.hidden,
        floats: s.floats,
        analysisPref: s.analysisPref,
        added: s.added,
        analysis: s.analysis,
      }),
    },
  ),
);

/** The layer state one pane draws: the app's, minus what that pane took off. */
export function paneLayerState<T extends { layers: Record<string, { visible: boolean; opacity: number }> }>(
  state: T,
  paneId: string,
): T {
  const off = usePaneStore.getState().hidden[paneId];
  if (!off?.length) return state;
  const layers = { ...state.layers };
  for (const id of off) if (layers[id]?.visible) layers[id] = { ...layers[id], visible: false };
  return { ...state, layers };
}
