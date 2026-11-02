import { create } from "zustand";

import { fetchLiveStatus, setComposeLive, type LiveStatus } from "../lib/radarFrames";
import { useSettingsStore } from "../settings/useSettingsStore";
import { useAppStore } from "./useAppStore";
import { dropPendingScans, pollNexradNow, recomposeScans, useNexradStore } from "./useNexradStore";

/**
 * The Level II volume being written at the radar on screen (backend
 * level2_live.status), polled while a live Level II product is shown: the
 * panes' "Streaming KTLX · cut 5 of 12 · 7.0 / 10.6 MB" line, and the
 * in-progress frame at the end of the loop (radarFrames.ts), which fills in
 * tilt by tilt as cuts complete.
 */
interface RadarLiveState {
  /** The radar the status is for. */
  site: string | null;
  status: LiveStatus | null;
  error: string | null;
}

export const useRadarLiveStore = create<RadarLiveState>(() => ({ site: null, status: null, error: null }));

/** A cut of 720 radials takes ~25-30 s; polled a few times a cut. */
const POLL_MS = 8_000;

/** The radar to follow, or null when nothing live in Level II is on screen. */
function wanted(): string | null {
  const s = useNexradStore.getState();
  if (!s.site || s.site.startsWith("BR-") || s.archiveTime !== null || s.archiveDate || !s.autoUpdate) return null;
  if (!s.product.startsWith("L2")) return null;
  if (!useAppStore.getState().layers["nexrad"]?.visible) return null;
  if (typeof document !== "undefined" && document.hidden) return null;
  return s.site;
}

let timer: number | null = null;
let ctl: AbortController | null = null;
let installed = false;

function schedule(ms: number): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => void tick(), ms);
}

function clearStatus(): void {
  if (!useRadarLiveStore.getState().status && !useRadarLiveStore.getState().site) return;
  useRadarLiveStore.setState({ site: null, status: null, error: null });
  setComposeLive(null, null);
  recomposeScans();
}

async function tick(): Promise<void> {
  timer = null;
  const site = wanted();
  if (!site) {
    ctl?.abort();
    clearStatus();
    schedule(POLL_MS);
    return;
  }
  ctl?.abort();
  const mine = new AbortController();
  ctl = mine;
  try {
    const st = await fetchLiveStatus(site, mine.signal);
    if (mine.signal.aborted || wanted() !== site) return;
    const before = useRadarLiveStore.getState();
    const prev = before.site === site ? before.status : null;
    useRadarLiveStore.setState({ site, status: st, error: null });
    setComposeLive(site, st);
    const moved =
      !prev ||
      prev.key !== st.key ||
      prev.cutsDone !== st.cutsDone ||
      prev.complete !== st.complete ||
      prev.stale !== st.stale ||
      JSON.stringify(prev.reps) !== JSON.stringify(st.reps);
    if (moved) {
      // Tilts that were not scanned may be in now; the in-progress frames change.
      dropPendingScans();
      recomposeScans();
      // The volume finished (or a newer one began): its whole frame is listed now.
      if (prev && (prev.key !== st.key || (!prev.complete && st.complete))) pollNexradNow();
    }
  } catch (err) {
    if (mine.signal.aborted) return;
    useRadarLiveStore.setState({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    if (ctl === mine && timer === null) schedule(POLL_MS);
  }
}

/** Follow the radar store, the radar layer and the two settings that shape
 *  the loop. Once, from main.tsx. */
export function installRadarLive(): void {
  if (installed) return;
  installed = true;
  let last = "";
  const check = () => {
    const s = useNexradStore.getState();
    const site = wanted() ?? "";
    const now = [site, s.product, s.tilt].join("|");
    if (now === last) return;
    const siteChanged = last.split("|")[0] !== site || last === "";
    last = now;
    if (siteChanged) {
      ctl?.abort();
      ctl = null;
      if (useRadarLiveStore.getState().site !== wanted()) clearStatus();
      schedule(50);
    }
  };
  useNexradStore.subscribe(check);
  useAppStore.subscribe(check);
  document.addEventListener("visibilitychange", check);
  // The loop's shape settings: compose again at once.
  useSettingsStore.subscribe((s, p) => {
    const keys = ["radar.inProgress", "radar.expandSails"];
    if (keys.some((k) => s.values[k] !== p.values[k])) recomposeScans();
  });
  schedule(1_000);
}
