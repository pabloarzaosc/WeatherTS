import { create } from "zustand";

/**
 * State for the animation exporter (the "Customize Animation" dialog).
 *
 * `area` is a crop rectangle in CSS pixels *relative to the focused pane's map
 * canvas*, not the page: panes move when the side panel or the alert rail opens,
 * and a page-relative rectangle would then point at the wrong ground. Null means
 * export the whole view.
 */
export interface GifArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AnimFormat = "mp4" | "gif";
/** What the animation steps through: the radar's scans, a model's hours, or the satellite's frames. */
export type AnimSubject = "radar" | "models" | "satellite";
export type LoopStyle = "forward" | "boomerang";

/** Output size presets: a fraction of the native capture size. */
export const SIZE_PRESETS = [
  { scale: 1, label: "Full" },
  { scale: 0.75, label: "Large" },
  { scale: 0.5, label: "Medium" },
] as const;

/** Whether this browser can encode MP4 (WebCodecs). GIF always works. */
export const MP4_SUPPORTED =
  typeof window !== "undefined" && typeof (window as unknown as { VideoEncoder?: unknown }).VideoEncoder === "function";

interface GifState {
  /** The Customize Animation dialog. */
  open: boolean;
  format: AnimFormat;
  subject: AnimSubject;
  /** Frame window, as indices into the current scan list (inclusive). */
  startIdx: number;
  endIdx: number;
  /** Take every Nth frame in the window. */
  step: number;
  /** Seconds each frame is held. */
  delaySec: number;
  /** Forward-only, or forward-then-back (ping-pong). */
  loop: LoopStyle;
  /** Burn the info bar (product, time, colour scale) into the frames. */
  caption: boolean;
  /** Output scale (1 = native, capped). */
  scale: number;

  area: GifArea | null;
  /** True while the user is dragging out the crop rectangle on the map. */
  selecting: boolean;

  setOpen: (open: boolean) => void;
  setFormat: (format: AnimFormat) => void;
  setSubject: (subject: AnimSubject) => void;
  setRange: (startIdx: number, endIdx: number) => void;
  setStep: (step: number) => void;
  setDelaySec: (delaySec: number) => void;
  setLoop: (loop: LoopStyle) => void;
  setCaption: (caption: boolean) => void;
  setScale: (scale: number) => void;
  setArea: (area: GifArea | null) => void;
  setSelecting: (v: boolean) => void;
}

export const useGifStore = create<GifState>()((set) => ({
  open: false,
  format: MP4_SUPPORTED ? "mp4" : "gif",
  subject: "radar",
  startIdx: 0,
  endIdx: 0,
  step: 1,
  delaySec: 0.3,
  loop: "forward",
  caption: true,
  scale: 1,

  area: null,
  selecting: false,

  setOpen: (open) => set({ open }),
  setFormat: (format) => set({ format }),
  setSubject: (subject) => set({ subject }),
  setRange: (startIdx, endIdx) => set({ startIdx, endIdx }),
  setStep: (step) => set({ step }),
  setDelaySec: (delaySec) => set({ delaySec }),
  setLoop: (loop) => set({ loop }),
  setCaption: (caption) => set({ caption }),
  setScale: (scale) => set({ scale }),
  setArea: (area) => set({ area, selecting: false }),
  setSelecting: (selecting) => set({ selecting }),
}));

/** The scan indices to capture, from the window + step, in `loop` order. */
export function selectedIndices(
  startIdx: number,
  endIdx: number,
  step: number,
  count: number,
  loop: LoopStyle = "forward",
): number[] {
  const lo = Math.max(0, Math.min(startIdx, endIdx));
  const hi = Math.min(count - 1, Math.max(startIdx, endIdx));
  const fwd: number[] = [];
  for (let i = lo; i <= hi; i += Math.max(1, step)) fwd.push(i);
  // The end frame is worth guaranteeing even if step doesn't land on it.
  if (fwd.length && fwd[fwd.length - 1] !== hi) fwd.push(hi);
  if (loop !== "boomerang" || fwd.length < 3) return fwd;
  // Ping-pong: play back down, without repeating the two turning-point frames.
  return [...fwd, ...fwd.slice(1, -1).reverse()];
}
