/**
 * Which frame a playing loop will show after a given one.
 *
 * At high speeds the play steps over frames (MapTimeline's MIN_FRAME_MS), and
 * the layers that get frames ready ahead of it -- the satellite's decoded
 * pictures, the models' sharp pictures -- readied the next few in a row, which
 * the play then skipped: at 80x nearly every frame it did show was waited on
 * (2026-10-03). The timeline sets this while a loop plays; the layers walk it.
 */

export type PlayDriver = "obs" | "sat";

let current: { driver: PlayDriver; next: (index: number) => number } | null = null;

export function setPlayNext(driver: PlayDriver, next: (index: number) => number): void {
  current = { driver, next };
}

/** Only this play's own: a play restarted (a new speed) has set its own by
 *  the time the old one winds down. */
export function clearPlayNext(next: (index: number) => number): void {
  if (current?.next === next) current = null;
}

/** The `count` frames after `index`, in the order a play of `driver` will
 *  show them; the next ones in a row when it is not playing. */
export function upcomingFrames(driver: PlayDriver, index: number, length: number, count: number): number[] {
  const out: number[] = [];
  const step = current?.driver === driver ? current.next : (i: number) => (i + 1) % length;
  let i = index;
  for (let k = 0; k < count && length > 1; k++) {
    const j = step(i);
    if (j < 0 || j >= length || j === index || out.includes(j)) break;
    out.push(j);
    i = j;
  }
  return out;
}
