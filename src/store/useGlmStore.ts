import { create } from "zustand";

import { fetchGlm, prefetchGlm, type GlmData, type GlmSat } from "../lib/glm";
import { describe } from "../lib/patience";
import { allMaps } from "../map/mapInstance";

/**
 * GLM lightning state: which satellites, how long a window, and where it ends.
 *
 * `atUnix` keeps lightning on the one timeline: the window ends at the radar,
 * satellite or analysis frame on screen, so a loop shows each frame's own
 * flashes; null is live, the window ending now. `span` is the loop's whole
 * stretch of time, read ahead so a play finds each frame's flashes here.
 */

export const GLM_WINDOWS = [5, 10, 15, 30, 60] as const;

/** NOAA writes a file per satellite every 20 s. */
const POLL_MS = 20_000;
/** A window still downloading is asked for again this soon. */
const PENDING_MS = 1200;
/** Timeline steps arrive in bursts while scrubbing: ask for the last one. */
const DEBOUNCE_MS = 60;

let controller: AbortController | null = null;
/** A load is running; another was asked for meanwhile and follows it. */
let inFlight = false;
let again = false;
let debounce: number | null = null;
let pollTimer: number | null = null;
let pendingTimer: number | null = null;
let spanTimer: number | null = null;
let spanAsked = "";

/** Every pane's view together, a quarter wider each way, so flashes just off
 *  the screen are already there when the map pans. */
function viewBox(): [number, number, number, number] | null {
  const maps = allMaps();
  if (!maps.length) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const m of maps) {
    const b = m.getBounds();
    w = Math.min(w, b.getWest());
    e = Math.max(e, b.getEast());
    s = Math.min(s, b.getSouth());
    n = Math.max(n, b.getNorth());
  }
  const dx = (e - w) * 0.25;
  const dy = (n - s) * 0.25;
  return [w - dx, Math.max(-90, s - dy), e + dx, Math.min(90, n + dy)];
}

interface GlmState {
  sat: GlmSat;
  minutes: number;
  /** null = live. */
  atUnix: number | null;
  /** The timeline's whole loop, [first, last] unix s, while lightning follows it. */
  span: [number, number] | null;
  data: GlmData | null;
  busy: boolean;
  error: string | null;

  setSat: (s: GlmSat) => void;
  setMinutes: (m: number) => void;
  setAtUnix: (t: number | null) => void;
  setSpan: (span: [number, number] | null) => void;
  /** Ask for the window now. `fresh` drops a request on its way (the window
   *  changed shape); otherwise one on its way finishes first and this follows,
   *  so a playing loop's steps never cancel each other into showing nothing. */
  load: (fresh?: boolean) => Promise<void>;
  /** A load a moment from now; calls in the meantime fold into it. */
  reload: () => void;
  startPolling: () => void;
  stopPolling: () => void;
}

export const useGlmStore = create<GlmState>((set, get) => ({
  sat: "both",
  minutes: 15,
  atUnix: null,
  span: null,
  data: null,
  busy: false,
  error: null,

  setSat: (sat) => {
    if (sat === get().sat) return;
    set({ sat });
    spanAsked = "";
    void get().load(true);
    get().setSpan(get().span);
  },
  setMinutes: (minutes) => {
    if (minutes === get().minutes) return;
    set({ minutes });
    spanAsked = "";
    void get().load(true);
    get().setSpan(get().span);
  },
  setAtUnix: (atUnix) => {
    if (atUnix === get().atUnix) return;
    set({ atUnix });
    get().reload();
  },
  setSpan: (span) => {
    set({ span });
    if (spanTimer != null) window.clearTimeout(spanTimer);
    if (!span) return;
    spanTimer = window.setTimeout(() => {
      spanTimer = null;
      const { sat, minutes } = get();
      const bbox = viewBox();
      // Each frame's window reaches `minutes` back from it.
      const start = span[0] - minutes * 60;
      const key = `${sat}|${start}|${span[1]}|${bbox?.map((v) => v.toFixed(0)).join(",")}`;
      if (key === spanAsked) return;
      spanAsked = key;
      void prefetchGlm({ sat, start, end: span[1], bbox }).catch(() => undefined);
    }, 400);
  },

  load: async (fresh = false) => {
    if (inFlight && !fresh) {
      again = true;
      return;
    }
    controller?.abort();
    const ctrl = new AbortController();
    controller = ctrl;
    inFlight = true;
    again = false;
    if (pendingTimer != null) window.clearTimeout(pendingTimer);
    pendingTimer = null;
    const { sat, minutes, atUnix } = get();
    set({ busy: true });
    try {
      const data = await fetchGlm({ sat, minutes, end: atUnix, bbox: viewBox() }, ctrl.signal);
      if (ctrl.signal.aborted) return;
      set({ data, busy: false, error: null });
      // Part of the window was still downloading: ask again for the rest.
      if (data.info.pending > 0 && !again) pendingTimer = window.setTimeout(() => void get().load(), PENDING_MS);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      set({ busy: false, error: describe(err, "The lightning service") });
    } finally {
      if (controller === ctrl) {
        inFlight = false;
        // Asked for meanwhile (the timeline moved on): that window now.
        if (again) void get().load();
      }
    }
  },

  reload: () => {
    if (debounce != null) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      debounce = null;
      void get().load();
    }, DEBOUNCE_MS);
  },

  startPolling: () => {
    if (pollTimer != null) return;
    pollTimer = window.setInterval(() => {
      if (get().atUnix == null) void get().load();
    }, POLL_MS);
  },
  stopPolling: () => {
    if (pollTimer != null) window.clearInterval(pollTimer);
    pollTimer = null;
    if (pendingTimer != null) window.clearTimeout(pendingTimer);
    pendingTimer = null;
    controller?.abort();
    controller = null;
    inFlight = false;
    again = false;
    set({ busy: false });
  },
}));
