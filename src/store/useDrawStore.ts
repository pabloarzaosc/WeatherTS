import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Drawings on the map: the shapes, the pen they are drawn with, and an undo
 * history.
 *
 * Shapes are kept in longitude/latitude, so a circle drawn around a storm stays
 * around that storm when the map is panned or zoomed, on every split-screen
 * pane, and after a restart. What is on the pen (tool, colour, width) is
 * remembered too, so reopening the tool picks up where it was left.
 */

export type DrawTool = "pen" | "line" | "arrow" | "circle" | "rect" | "text" | "eraser";
export type ShapeKind = Exclude<DrawTool, "eraser">;
export type LngLat = [number, number];

export interface Shape {
  id: string;
  kind: ShapeKind;
  /** pen: every point; line/arrow: start, end; circle: centre, edge; rect: corners; text: anchor. */
  points: LngLat[];
  color: string;
  /** Line width in screen pixels; for text, the size step. */
  width: number;
  dashed: boolean;
  /** Circles and rectangles only. */
  fill: boolean;
  text?: string;
}

const HISTORY_MAX = 100;

export const DRAW_COLORS = ["#ff2d2d", "#ff8c1a", "#ffd60a", "#3ddc5a", "#22d3ee", "#3b82f6", "#a855f7", "#ff4fb8", "#ffffff", "#111111"];
export const DRAW_WIDTHS = [2, 4, 6, 10, 14, 20];

interface DrawState {
  /** The toolbar is open. */
  active: boolean;
  /** While locked, dragging on the map draws; unlocked, it moves the map. */
  locked: boolean;
  tool: DrawTool;
  color: string;
  width: number;
  dashed: boolean;
  fill: boolean;
  shapes: Shape[];
  past: Shape[][];
  future: Shape[][];

  setActive: (on: boolean) => void;
  setLocked: (on: boolean) => void;
  setTool: (tool: DrawTool) => void;
  setColor: (color: string) => void;
  setWidth: (width: number) => void;
  setDashed: (on: boolean) => void;
  setFill: (on: boolean) => void;
  add: (shape: Omit<Shape, "id">) => void;
  remove: (ids: string[]) => void;
  clear: () => void;
  undo: () => void;
  redo: () => void;
}

const newId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Record the current shapes before a change, and drop the redo branch. */
const commit = (s: DrawState, shapes: Shape[]) => ({
  shapes,
  past: [...s.past, s.shapes].slice(-HISTORY_MAX),
  future: [],
});

export const useDrawStore = create<DrawState>()(
  persist(
    (set, get) => ({
      active: false,
      locked: true,
      tool: "pen",
      color: DRAW_COLORS[0],
      width: 6,
      dashed: false,
      fill: false,
      shapes: [],
      past: [],
      future: [],

      setActive: (active) => set({ active, locked: true }),
      setLocked: (locked) => set({ locked }),
      setTool: (tool) => set({ tool, locked: true }),
      setColor: (color) => set({ color }),
      setWidth: (width) => set({ width }),
      setDashed: (dashed) => set({ dashed }),
      setFill: (fill) => set({ fill }),

      add: (shape) => set(commit(get(), [...get().shapes, { ...shape, id: newId() }])),
      remove: (ids) => {
        const drop = new Set(ids);
        const shapes = get().shapes.filter((s) => !drop.has(s.id));
        if (shapes.length !== get().shapes.length) set(commit(get(), shapes));
      },
      clear: () => {
        if (get().shapes.length) set(commit(get(), []));
      },
      undo: () => {
        const { past, shapes, future } = get();
        if (!past.length) return;
        set({ shapes: past[past.length - 1], past: past.slice(0, -1), future: [shapes, ...future].slice(0, HISTORY_MAX) });
      },
      redo: () => {
        const { past, shapes, future } = get();
        if (!future.length) return;
        set({ shapes: future[0], future: future.slice(1), past: [...past, shapes].slice(-HISTORY_MAX) });
      },
    }),
    {
      name: "weatherts-drawings",
      version: 1,
      // The history is for this session; the drawings and the pen are kept.
      partialize: (s) => ({ tool: s.tool, color: s.color, width: s.width, dashed: s.dashed, fill: s.fill, shapes: s.shapes }),
    },
  ),
);
