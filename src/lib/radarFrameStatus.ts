/**
 * Where each radar loop frame is: not asked for yet, downloading, decoding,
 * ready or failed -- the coloured line under the timeline's scrubber and the
 * "Loading frames 13/24 · 6 downloading · 3 decoding" card read it.
 *
 * Keyed by the store's scan id (site | wire code | key). "Downloading" is the
 * request being out (the backend fetching and decoding the radar file, then
 * the transfer); "decoding" is this side: the wire format unpacked and the
 * mesh built on the workers. A failed frame is tried again after 1 minute,
 * after 5, and whenever the connection comes back.
 */

export type FrameState = "idle" | "down" | "decode" | "ready" | "failed";

const states = new Map<string, FrameState>();
const STATES_MAX = 3000;

/** Retry schedule after the 1st and 2nd failure; later ones wait for "online". */
const RETRY_MS = [60_000, 300_000];
interface Fail {
  tries: number;
  timer: number | null;
  retry: () => void;
}
const fails = new Map<string, Fail>();

/** Bytes on the wire per frame, for the loop-length size note. */
const sizes = new Map<string, number>();
const SIZES_MAX = 600;

let rev = 0;
let queued: number | null = null;
const subs = new Set<() => void>();

function bump(): void {
  if (queued !== null) return;
  // Coalesced: a warm-up flips dozens of frames a second, the strip needs a
  // few repaints of it.
  queued = window.setTimeout(() => {
    queued = null;
    rev++;
    for (const cb of subs) cb();
  }, 120);
}

export function setFrameState(id: string, s: FrameState): void {
  if (states.get(id) === s) return;
  states.delete(id);
  states.set(id, s);
  while (states.size > STATES_MAX) {
    const oldest = states.keys().next().value;
    if (oldest === undefined) break;
    states.delete(oldest);
  }
  bump();
}

export function frameState(id: string): FrameState {
  return states.get(id) ?? "idle";
}

export function subscribeFrames(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function framesRev(): number {
  return rev;
}

/** A frame failed: try it again later (1 min, 5 min, then on reconnect). */
export function frameFailed(id: string, retry: () => void): void {
  const f = fails.get(id) ?? { tries: 0, timer: null, retry };
  f.retry = retry;
  f.tries++;
  if (f.timer !== null) window.clearTimeout(f.timer);
  f.timer = null;
  const wait = RETRY_MS[f.tries - 1];
  if (wait !== undefined) {
    f.timer = window.setTimeout(() => {
      f.timer = null;
      f.retry();
    }, wait);
  }
  fails.set(id, f);
  setFrameState(id, "failed");
}

/** A frame came in: forget its failures. */
export function frameOk(id: string): void {
  const f = fails.get(id);
  if (!f) return;
  if (f.timer !== null) window.clearTimeout(f.timer);
  fails.delete(id);
}

/** Forget every pending retry (another site, product or loop). */
export function dropRetries(keep: (id: string) => boolean = () => false): void {
  for (const [id, f] of fails) {
    if (keep(id)) continue;
    if (f.timer !== null) window.clearTimeout(f.timer);
    fails.delete(id);
  }
}

export function noteFrameBytes(id: string, n: number): void {
  sizes.set(id, n);
  while (sizes.size > SIZES_MAX) {
    const oldest = sizes.keys().next().value;
    if (oldest === undefined) break;
    sizes.delete(oldest);
  }
}

/** Mean bytes a frame of this site + wire code took, or null when none seen. */
export function meanFrameBytes(prefix: string): number | null {
  let n = 0;
  let sum = 0;
  for (const [id, b] of sizes) {
    if (!id.startsWith(prefix)) continue;
    n++;
    sum += b;
  }
  return n ? sum / n : null;
}

/** Bytes on the wire for one frame, when it was loaded this session. */
export function frameBytes(id: string): number | null {
  return sizes.get(id) ?? null;
}

/** Every failed frame, now (the connection came back). */
export function retryFailedFrames(): void {
  for (const f of [...fails.values()]) f.retry();
}

if (typeof window !== "undefined") {
  // Back online: every failed frame at once.
  window.addEventListener("online", retryFailedFrames);
}
