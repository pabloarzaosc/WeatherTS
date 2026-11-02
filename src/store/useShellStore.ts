import { create } from "zustand";

/**
 * How much of the app is on screen (ux-shell):
 *   normal    -- everything;
 *   minimal   -- Ctrl+\: no dock, side panels, status bar, search or timeline,
 *                the map fills the window; the pointer at the top edge brings
 *                a small bar back;
 *   broadcast -- the map alone for streaming or a projector: no controls,
 *                chips, toolbars, notes, toasts or focus outline; a caption per
 *                pane and the logo. The legend, layers, loop and the hover
 *                readout stay. Kept across a reload (it is a setup, not a
 *                moment); minimal is not.
 * The mode is mirrored on <html data-shell> so plain CSS (ux-shell.css) does
 * the hiding: components stay mounted, so a loop keeps playing behind a
 * hidden timeline.
 */
export type ShellMode = "normal" | "minimal" | "broadcast";

const KEY = "weatherts-shell";

function readSaved(): ShellMode {
  try {
    return window.localStorage.getItem(KEY) === "broadcast" ? "broadcast" : "normal";
  } catch {
    return "normal";
  }
}

function save(mode: ShellMode): void {
  try {
    if (mode === "broadcast") window.localStorage.setItem(KEY, "broadcast");
    else window.localStorage.removeItem(KEY);
  } catch {
    /* a convenience: the mode just will not survive the reload */
  }
}

function mirror(mode: ShellMode): void {
  const root = document.documentElement;
  if (mode === "normal") delete root.dataset.shell;
  else root.dataset.shell = mode;
  // The map areas change size: maps watch their containers, but a pane
  // header measuring its room listens for resize.
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}

interface ShellState {
  mode: ShellMode;
  /** The keyboard shortcut list ("?"). */
  shortcutsOpen: boolean;
  setMode: (mode: ShellMode) => void;
  /** Ctrl+\: broadcast -> normal; normal <-> minimal. */
  toggleMinimal: () => void;
  toggleBroadcast: () => void;
  setShortcutsOpen: (open: boolean) => void;
}

export const useShellStore = create<ShellState>((set, get) => ({
  mode: "normal",
  shortcutsOpen: false,
  setMode: (mode) => {
    if (mode === get().mode) return;
    save(mode);
    mirror(mode);
    set({ mode });
  },
  toggleMinimal: () => get().setMode(get().mode === "normal" ? "minimal" : "normal"),
  toggleBroadcast: () => get().setMode(get().mode === "broadcast" ? "normal" : "broadcast"),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
}));

/** Put back a broadcast setup from the last visit. Called once from main.tsx. */
export function restoreShell(): void {
  const saved = readSaved();
  if (saved !== "normal") useShellStore.getState().setMode(saved);
}
