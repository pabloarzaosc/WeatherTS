/**
 * Which alerts are flashing, and until when. The notifier (ui/AlertNotifier)
 * starts a flash when a new alert arrives or playback reaches an alert's issue
 * time; the alerts layer draws the flashing ones pulsing on every pane, and
 * the list gives their rows a glow.
 *
 * A leaf module: no imports, so the layer, the list and the notifier can all
 * use it without cycles.
 */

const until = new Map<string, number>();
const subs = new Set<() => void>();
let timer: number | null = null;

function emit(): void {
  for (const cb of [...subs]) cb();
}

/** Drop the flashes that are over; stop the clock when none are left. */
function sweep(): void {
  const now = Date.now();
  let changed = false;
  for (const [id, t] of until) {
    if (t <= now) {
      until.delete(id);
      changed = true;
    }
  }
  if (until.size === 0 && timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
  if (changed) emit();
}

/** Flash alert `id` for `ms` (a longer flash already running is kept). */
export function flashAlert(id: string, ms: number): void {
  if (ms <= 0) return;
  const t = Date.now() + ms;
  if ((until.get(id) ?? 0) >= t) return;
  until.set(id, t);
  if (timer === null) timer = window.setInterval(sweep, 500);
  emit();
}

export function stopFlashes(): void {
  if (until.size === 0) return;
  until.clear();
  sweep();
  emit();
}

/** The ids flashing now. */
export function flashingIds(): string[] {
  const now = Date.now();
  return [...until].filter(([, t]) => t > now).map(([id]) => id);
}

export function isFlashing(id: string): boolean {
  return (until.get(id) ?? 0) > Date.now();
}

export function onFlashChange(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}
