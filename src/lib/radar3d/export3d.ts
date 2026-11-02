/**
 * Saving the 3D view: one picture with a caption strip, or the radar loop as a
 * GIF -- the camera held still, one picture per volume, each with its own
 * caption. The loop is drawn on a renderer of its own (an off-screen canvas),
 * so the view on screen is left as it is while the frames are made.
 */
import { createFrameSink } from "../gifExport";
import type { OrbitCamera } from "./camera";
import { Radar3DRenderer, type RenderParams } from "./renderer";
import { fetchVolume3D, type Volume3D } from "./volume";

/** A rendered frame with the caption strip under it: left text, right text. */
export function captionCanvas(img: ImageData, left: string, right: string, scale = 1): HTMLCanvasElement | null {
  const w = img.width;
  const ht = img.height;
  const strip = Math.round(30 * scale);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = ht + strip;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.putImageData(img, 0, 0);
  const cs = getComputedStyle(document.documentElement);
  ctx.fillStyle = cs.getPropertyValue("--panel-solid").trim() || "#14171c";
  ctx.fillRect(0, ht, w, strip);
  ctx.fillStyle = cs.getPropertyValue("--border").trim() || "rgba(140,150,165,0.3)";
  ctx.fillRect(0, ht, w, Math.max(1, Math.round(scale)));
  const mono = cs.getPropertyValue("--mono").trim() || "ui-monospace, monospace";
  ctx.font = `600 ${Math.round(12 * scale)}px ${mono}`;
  ctx.textBaseline = "middle";
  const y = ht + strip / 2;
  ctx.fillStyle = cs.getPropertyValue("--text").trim() || "#e6e9ee";
  ctx.textAlign = "left";
  ctx.fillText(left, 10 * scale, y);
  ctx.textAlign = "right";
  ctx.fillStyle = cs.getPropertyValue("--text-dim").trim() || "#9aa4b2";
  ctx.fillText(right, w - 10 * scale, y);
  return out;
}

export interface LoopFrame {
  at: number | null;
  key: string;
}

export interface LoopExportOptions {
  site: string;
  fam: string;
  bbox: [number, number, number, number];
  frames: LoopFrame[];
  /** What the view does to each volume before drawing it (an area's mask). */
  fit: (v: Volume3D) => Volume3D;
  cam: OrbitCamera;
  paramsFor: (v: Volume3D) => RenderParams;
  lutFor: (v: Volume3D) => Uint8Array;
  /** The picture's size, caption strip not included (rounded down to even). */
  width: number;
  height: number;
  caption: (v: Volume3D) => [string, string];
  delayMs: number;
  onProgress: (done: number, total: number) => void;
  signal: AbortSignal;
}

const even = (n: number) => Math.max(2, n - (n % 2));

/** The radar loop in 3D as a GIF. Frames whose volume is the one before
 *  (Level III scans inside one Level II volume) are drawn once. */
export async function exportLoopGif(o: LoopExportOptions): Promise<{ blob: Blob; frames: number; failed: number }> {
  const w = even(o.width);
  const h = even(o.height);
  const scale = w >= 1400 ? 2 : 1;
  const strip = Math.round(30 * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const r = new Radar3DRenderer(canvas);
  const pending = new Map<number, Promise<Volume3D | null>>();
  const fetchFrame = (i: number): Promise<Volume3D | null> => {
    let p = pending.get(i);
    if (!p) {
      const f = o.frames[i];
      p = fetchVolume3D(
        { site: o.site, fam: o.fam, at: f.at, key: f.key, bbox: o.bbox, fill: false, lightning: false, rid: "" },
        o.signal,
      ).catch(() => null);
      pending.set(i, p);
    }
    return p;
  };
  try {
    const sink = await createFrameSink("gif", w, even(h + strip), o.delayMs);
    let lastKey = "";
    let drawn = 0;
    let failed = 0;
    let held: HTMLCanvasElement | null = null;
    for (let i = 0; i < o.frames.length; i++) {
      if (o.signal.aborted) throw new DOMException("cancelled", "AbortError");
      // One volume ahead on the line while this one is drawn.
      const cur = fetchFrame(i);
      if (i + 1 < o.frames.length) void fetchFrame(i + 1);
      const v = await cur;
      pending.delete(i);
      o.onProgress(i + 1, o.frames.length);
      if (!v) {
        failed++;
        continue;
      }
      if (v.header.key === lastKey) continue;
      lastKey = v.header.key;
      const shown = o.fit(v);
      r.setVolume(shown);
      r.setLut(o.lutFor(shown));
      const img = r.capture(o.cam, o.paramsFor(shown), w, h);
      const [left, right] = o.caption(shown);
      const c = captionCanvas(img, left, right, scale);
      if (!c) continue;
      // Each frame is added once the next is known, so the last one can be held.
      if (held) await sink.add(held, o.delayMs);
      held = c;
      drawn++;
    }
    if (o.signal.aborted) throw new DOMException("cancelled", "AbortError");
    if (!held) throw new Error("None of the loop's volumes could be read.");
    await sink.add(held, Math.max(o.delayMs, 1500));
    return { blob: await sink.finish(), frames: drawn, failed };
  } finally {
    r.dispose();
    (r.gl.getExtension("WEBGL_lose_context") as { loseContext?: () => void } | null)?.loseContext?.();
  }
}
