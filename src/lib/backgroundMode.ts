import { isBackground, onBackgroundChange, setBackground } from "./appActivity";
import { retryFailedFrames } from "./radarFrameStatus";
import { installConnection, onReconnect } from "../store/useConnectionStore";
import { pollNexradNow, useNexradStore } from "../store/useNexradStore";
import { useTimelineStore } from "../store/useTimelineStore";

/**
 * The window in the background, and the connection coming back.
 *
 * Hidden for a minute: the app goes into the background (appActivity.ts). The
 * radar stops polling for new scans (its poll skips the round) and a playing
 * loop pauses -- a loop nobody sees only spends downloads and GPU time. Alerts
 * keep checking when a keeper says so (alert sounds, when they exist:
 * setBackgroundKeeper("alerts", ...)).
 *
 * Seen again, or back online after being offline: catch up. The radar asks
 * for its scan list at once (the scans it missed join the loop, and a pane
 * parked on the newest moves to it), failed frames are tried again, a frame
 * that failed on screen is shown again, and "weatherts:catchup" tells the
 * rest (alerts reload). A loop the background paused plays on.
 */

/** How long hidden before the app counts as in the background. */
export const BACKGROUND_AFTER_MS = 60_000;

let hideTimer: number | null = null;
let resumePlay = false;
let installed = false;
let hideMs = BACKGROUND_AFTER_MS;

function catchUp(): void {
  void pollNexradNow();
  retryFailedFrames();
  const s = useNexradStore.getState();
  if (s.site && s.error) void s.showIndex(s.index);
  window.dispatchEvent(new Event("weatherts:catchup"));
}

function enter(): void {
  if (isBackground()) return;
  const tl = useTimelineStore.getState();
  resumePlay = tl.playing;
  if (tl.playing) tl.stop();
  setBackground(true);
}

function leave(): void {
  if (!isBackground()) return;
  setBackground(false);
  catchUp();
  if (resumePlay) useTimelineStore.getState().resume();
  resumePlay = false;
}

function onVisibility(): void {
  if (document.hidden) {
    if (hideTimer === null) hideTimer = window.setTimeout(() => {
      hideTimer = null;
      if (document.hidden) enter();
    }, hideMs);
    return;
  }
  if (hideTimer !== null) window.clearTimeout(hideTimer);
  hideTimer = null;
  leave();
}

/** Once, at start: the connection watch, the background timer and the catch-ups. */
export function installBackground(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  installConnection();
  document.addEventListener("visibilitychange", onVisibility);
  onReconnect(catchUp);
  if (import.meta.env.DEV || import.meta.env.VITE_PROBE) {
    // Probes: shorten the minute, or enter/leave by hand.
    (window as unknown as { __bg?: unknown }).__bg = {
      enter,
      leave,
      setHideMs: (ms: number) => {
        hideMs = ms;
      },
      isBackground,
      onBackgroundChange,
    };
  }
}
