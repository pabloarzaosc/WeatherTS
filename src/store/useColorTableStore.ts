import { create } from "zustand";

import { cloneEntries, type PalEntry, type RGBA } from "../lib/pal";

// The colour table editor docked in a pane, the colour scale and offset
// dialog, the bulk .pal import dialog and the ] / [ note. Nothing here is
// persisted: an editor's unsaved changes are dropped when it closes, and
// what is saved lives in usePaletteStore.

export type TableSource = "default" | "builtin" | "custom";

export interface EditorState {
  paneId: string;
  /** The product's palette id (FILE_DR, ...) and a kind that draws with it. */
  pid: string;
  kind: string;
  /** The table being edited: where Save writes and Reset returns to. */
  baseId: string;
  baseLabel: string;
  baseSource: TableSource;
  header: { product: string | null; units: string | null; step: number | null; rf: RGBA | null };
  baseEntries: PalEntry[];
  entries: PalEntry[];
  /** Selected stop (index into entries) and whether its popup is open. */
  sel: number | null;
  popup: boolean;
  undo: PalEntry[][];
  redo: PalEntry[][];
  dirty: boolean;
  /** Save as: the name field is showing. */
  naming: boolean;
}

export interface ImportItem {
  key: string;
  name: string;
  /** What will be saved (after Fix Scale, the converted table). */
  text: string;
  /** The file as read: a product picked by hand is checked from it again. */
  orig: string;
  pid: string | null;
  /** How the product was found. */
  how: "product" | "name" | "guess" | "picked" | null;
  hint: string;
  group: "check" | "pick" | "sorted" | "bad";
  warnings: string[];
  /** A unit conversion the importer can do: stops times factor. */
  fix: { factor: number; from: string; to: string; label: string } | null;
  fixed: boolean;
  /** Same stops as an already saved palette or an earlier file in the drop. */
  dup: string | null;
  checked: boolean;
  error: string | null;
}

export interface ScaleDialog {
  paneId: string | null;
  pid: string;
  kind: string;
  tableId: string;
  /** Where the dialog opened (screen px), so it starts near the click. */
  x: number;
  y: number;
  naming: boolean;
}

const UNDO_MAX = 100;

interface ColorTableState {
  editor: EditorState | null;
  /** The editor's table as .pal text, drawn in place of the product's table
   *  while the editor is open (live recolouring). */
  draft: { pid: string; text: string } | null;
  scale: ScaleDialog | null;
  importer: { items: ImportItem[]; skipped: number; switchTo: boolean; error: string | null } | null;
  note: { text: string; id: number } | null;

  openEditor: (e: Omit<EditorState, "entries" | "sel" | "popup" | "undo" | "redo" | "dirty" | "naming">) => void;
  closeEditor: () => void;
  /** An edit: `record` pushes the state before it onto the undo stack (once
   *  per gesture: a drag records at its start, not at every move). */
  edit: (entries: PalEntry[], opts?: { record?: boolean; sel?: number | null }) => void;
  /** The state before a gesture starts, for its single undo step. */
  checkpoint: () => void;
  select: (sel: number | null, popup?: boolean) => void;
  undo: () => void;
  redo: () => void;
  reset: () => void;
  setNaming: (on: boolean) => void;
  setDraft: (draft: { pid: string; text: string } | null) => void;

  openScale: (d: Omit<ScaleDialog, "naming">) => void;
  closeScale: () => void;
  setScaleNaming: (on: boolean) => void;

  openImport: (items: ImportItem[], skipped: number) => void;
  updateItem: (key: string, patch: Partial<ImportItem>) => void;
  setImport: (patch: Partial<{ switchTo: boolean; error: string | null }>) => void;
  closeImport: () => void;

  showNote: (text: string) => void;
}

let noteId = 0;

export const useColorTableStore = create<ColorTableState>((set, get) => ({
  editor: null,
  draft: null,
  scale: null,
  importer: null,
  note: null,

  openEditor: (e) =>
    set({
      editor: {
        ...e,
        baseEntries: cloneEntries(e.baseEntries),
        entries: cloneEntries(e.baseEntries),
        sel: null,
        popup: false,
        undo: [],
        redo: [],
        dirty: false,
        naming: false,
      },
      draft: null,
    }),

  closeEditor: () => set({ editor: null, draft: null }),

  edit: (entries, opts = {}) => {
    const ed = get().editor;
    if (!ed) return;
    const undo = opts.record ? [...ed.undo, cloneEntries(ed.entries)].slice(-UNDO_MAX) : ed.undo;
    set({
      editor: {
        ...ed,
        entries,
        undo,
        redo: opts.record ? [] : ed.redo,
        dirty: true,
        sel: opts.sel !== undefined ? opts.sel : ed.sel,
      },
    });
  },

  checkpoint: () => {
    const ed = get().editor;
    if (!ed) return;
    set({ editor: { ...ed, undo: [...ed.undo, cloneEntries(ed.entries)].slice(-UNDO_MAX), redo: [] } });
  },

  select: (sel, popup) => {
    const ed = get().editor;
    if (!ed) return;
    set({ editor: { ...ed, sel, popup: popup ?? (sel === null ? false : ed.popup) } });
  },

  undo: () => {
    const ed = get().editor;
    if (!ed || !ed.undo.length) return;
    const prev = ed.undo[ed.undo.length - 1];
    set({
      editor: {
        ...ed,
        entries: prev,
        undo: ed.undo.slice(0, -1),
        redo: [...ed.redo, cloneEntries(ed.entries)],
        dirty: true,
        sel: ed.sel !== null && ed.sel < prev.length ? ed.sel : null,
      },
    });
  },

  redo: () => {
    const ed = get().editor;
    if (!ed || !ed.redo.length) return;
    const next = ed.redo[ed.redo.length - 1];
    set({
      editor: {
        ...ed,
        entries: next,
        redo: ed.redo.slice(0, -1),
        undo: [...ed.undo, cloneEntries(ed.entries)],
        dirty: true,
        sel: ed.sel !== null && ed.sel < next.length ? ed.sel : null,
      },
    });
  },

  reset: () => {
    const ed = get().editor;
    if (!ed) return;
    set({
      editor: {
        ...ed,
        entries: cloneEntries(ed.baseEntries),
        undo: [...ed.undo, cloneEntries(ed.entries)].slice(-UNDO_MAX),
        redo: [],
        dirty: false,
        sel: null,
        popup: false,
      },
    });
  },

  setNaming: (on) => {
    const ed = get().editor;
    if (ed) set({ editor: { ...ed, naming: on } });
  },

  setDraft: (draft) => set({ draft }),

  openScale: (d) => set({ scale: { ...d, naming: false } }),
  closeScale: () => set({ scale: null }),
  setScaleNaming: (on) => {
    const s = get().scale;
    if (s) set({ scale: { ...s, naming: on } });
  },

  openImport: (items, skipped) => set({ importer: { items, skipped, switchTo: true, error: null } }),
  updateItem: (key, patch) => {
    const im = get().importer;
    if (!im) return;
    set({ importer: { ...im, error: null, items: im.items.map((it) => (it.key === key ? { ...it, ...patch } : it)) } });
  },
  setImport: (patch) => {
    const im = get().importer;
    if (im) set({ importer: { ...im, ...patch } });
  },
  closeImport: () => set({ importer: null }),

  showNote: (text) => set({ note: { text, id: ++noteId } }),
}));
