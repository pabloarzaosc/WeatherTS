/**
 * Whether the app is "in the background": its window hidden for over a minute
 * (backgroundMode.ts decides). While it is, the radar stops polling for new
 * scans and the loop pauses; both catch up when the window is seen again.
 *
 * A leaf module (no imports), so the stores can ask without import cycles.
 *
 * Some things should keep going while hidden: alerts, once alert sounds exist,
 * must keep checking so a new warning can sound. Such a feature registers a
 * keeper here -- setBackgroundKeeper("alerts", () => soundsOn) -- and its poll
 * asks backgroundAllows("alerts") before skipping a round.
 */

let background = false;
const keepers = new Map<string, () => boolean>();
const subs = new Set<(bg: boolean) => void>();

export function isBackground(): boolean {
  return background;
}

export function setBackground(bg: boolean): void {
  if (bg === background) return;
  background = bg;
  for (const cb of [...subs]) cb(bg);
}

export function onBackgroundChange(cb: (bg: boolean) => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

/** Keep `what` polling in the background while `keep()` is true; null removes it. */
export function setBackgroundKeeper(what: string, keep: (() => boolean) | null): void {
  if (keep) keepers.set(what, keep);
  else keepers.delete(what);
}

/** May `what` poll now? Always in the foreground; in the background only with a keeper saying so. */
export function backgroundAllows(what: string): boolean {
  if (!background) return true;
  try {
    return keepers.get(what)?.() ?? false;
  } catch {
    return false;
  }
}
