import { create } from "zustand";

/**
 * The Frames panel: whether it is open, and when the live loop last looked
 * for -- and last found -- a new scan ("Last new data 42 s ago").
 * A leaf store: the radar store writes the times, the panel reads them.
 */
interface FramesState {
  open: boolean;
  /** When a poll for new scans last answered (ms). */
  lastChecked: number | null;
  /** When a poll last found a scan the loop did not have (ms). */
  lastNew: number | null;
  /** The radar those times are for. */
  site: string | null;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useFramesStore = create<FramesState>((set, get) => ({
  open: false,
  lastChecked: null,
  lastNew: null,
  site: null,
  setOpen: (open) => set({ open }),
  toggle: () => set({ open: !get().open }),
}));

/** A live scan list came back for `site`; `found` = it had a scan the loop did not. */
export function noteLiveCheck(site: string, found: boolean): void {
  const s = useFramesStore.getState();
  const now = Date.now();
  if (s.site !== site) {
    useFramesStore.setState({ site, lastChecked: now, lastNew: found ? now : null });
    return;
  }
  useFramesStore.setState({ lastChecked: now, ...(found ? { lastNew: now } : {}) });
}
