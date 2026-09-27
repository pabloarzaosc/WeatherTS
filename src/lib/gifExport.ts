// Animated export of the radar loop -- or of a model's hours -- as GIF or MP4.
//
// The frames are captured from the live map rather than re-rendered offscreen,
// so what you export is exactly what you were looking at -- basemap, alerts,
// storm chrome and all. Each frame gets a caption strip burned in underneath:
// the product, the site and tilt, the frame's own timestamp, a frame counter
// that climbs as the loop plays, and the product's colour table. A file posted
// somewhere else carries no UI around it, so the scale has to travel with it.
//
// GIF and MP4 share every bit of the capture + composition; they differ only in
// the FrameSink that consumes each finished canvas. Radar, the models and the
// satellite share it too: they differ in how a frame is put on the map and what
// the caption says (a model's caption carries the run, the forecast hour and its
// own scale). Every frame carries the app's name, caption or not.

import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import type { ImageSource, Map as MapLibreMap } from "maplibre-gl";

import { getMap, getMapById, getActivePaneId } from "../map/mapInstance";
import { OBS_IMAGE_SOURCES, obsDetailNow, obsFrameFinal, obsPreload } from "../layers/modules/obsLayer";
import { SAT_IMAGE_SOURCE, satFrameOnScreen } from "../layers/modules/satelliteLayer";
import { useNexradStore } from "../store/useNexradStore";
import { useObsStore } from "../store/useObsStore";
import { selectSatProduct, selectSatRegion, selectSatSatellite, useSatStore } from "../store/useSatStore";
import { usePaletteStore } from "../store/usePaletteStore";
import type { AnimFormat, AnimSubject, GifArea } from "../store/useGifStore";
import { fhText, prefetchObsLoop, type ObsBar } from "./observations";
import type { SatLegend } from "./satellite";
import GifWorker from "./gifWorker?worker&inline";
import { hcaKey } from "./hca";
import { buildLut, palTicks, parsePal, type PalTable } from "./pal";

/** Widest single-pane export. A ~1280 view exports at native resolution; only
 *  genuinely huge windows scale down (cleanly, high-quality smoothing on). */
const MAX_WIDTH = 1600;
/** For split screen the whole grid shares this budget, so cells stay legible. */
const MAX_GRID_WIDTH = 1800;
/** The last frame holds longer, so the loop doesn't snap back the instant it lands. */
const LAST_FRAME_HOLD = 900;

const PAD = 12;
/** The colour scales' figures, right under their ramp. */
const TICK_FONT = "9px ui-monospace, Consolas, monospace";
const TICK_GAP = 2;

/** Below this the caption goes to two rows -- one line will not fit. */
const isNarrow = (w: number) => w < 470;
/**
 * The caption strip's height: a line of text with the colour scale under it
 * (two lines on a narrow export), the text alone for a product without a
 * scale. It was 74 px and took too much of the picture (Pablo, 2026-09-26).
 */
const captionHeight = (w: number, scaled = true) => (isNarrow(w) ? (scaled ? 50 : 32) : scaled ? 44 : 26);

/** MP4 (H.264) requires even dimensions; round both down. */
const even = (n: number) => n - (n % 2);

export interface GifProgress {
  phase: "capturing" | "encoding";
  done: number;
  total: number;
}

/** Cooperative cancellation: the UI flips `cancelled` and the run bails out. */
export interface GifCancel {
  cancelled: boolean;
}

export class GifCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "GifCancelled";
  }
}

export interface AnimOptions {
  /** Exactly which scan indices to capture, in order (from the dialog). */
  indices: number[];
  /** Milliseconds each frame is held. */
  delayMs: number;
  /** Crop, in CSS px relative to the focused pane's canvas. Null = whole view. */
  area: GifArea | null;
  format: AnimFormat;
  /** Burn the info bar / colour scale into the frames (off = clean map). */
  caption: boolean;
  /** Output scale on top of the native-size cap (1 = native). */
  scale: number;
  /** Radar scans (the default) or the Models panel's hours. */
  subject?: AnimSubject;
}

// ---- frame sinks: one per output format, same interface ----

interface FrameSink {
  add(canvas: HTMLCanvasElement, delayMs: number): Promise<void>;
  finish(): Promise<Blob>;
}

/** GIF encoding workers: most of the machine, leaving a core for the page. */
const GIF_WORKERS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
/** Frames handed to the workers and not yet back, at most: it bounds memory. */
const GIF_QUEUE = GIF_WORKERS * 2;

/**
 * GIF, encoded on workers (gifWorker.ts) while the next frames are captured:
 * a frame's quantising and compressing, about half a second, is more than its
 * capture takes, so several run at once, each on whole frames, and the pieces
 * are joined in order at the end. Inlined, so they also start in the desktop
 * app, whose page is a file:// one. Should workers not start, the frames are
 * encoded here.
 */
class GifSink implements FrameSink {
  private workers: Worker[] = [];
  private gif: ReturnType<typeof GIFEncoder> | null = null;
  private parts: Uint8Array[] = [];
  private seq = 0;
  private out = 0;
  private freed: (() => void)[] = [];
  private allBack: (() => void) | null = null;
  private err: Error | null = null;

  constructor(private w: number, private h: number) {
    try {
      for (let k = 0; k < GIF_WORKERS; k++) {
        const worker = new GifWorker();
        worker.onmessage = (e: MessageEvent<{ seq: number; bytes: Uint8Array }>) => {
          this.parts[e.data.seq] = e.data.bytes;
          this.out -= 1;
          this.freed.shift()?.();
          if (this.out === 0) this.allBack?.();
        };
        worker.onerror = (e) => {
          this.err = new Error(e.message || "The GIF encoder stopped.");
          for (const go of this.freed.splice(0)) go();
          this.allBack?.();
        };
        this.workers.push(worker);
      }
    } catch {
      for (const worker of this.workers) worker.terminate();
      this.workers = [];
      this.gif = GIFEncoder();
    }
  }

  async add(canvas: HTMLCanvasElement, delayMs: number): Promise<void> {
    if (this.err) throw this.err;
    const ctx = canvas.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, this.w, this.h);
    if (!this.workers.length) {
      const palette = quantize(data, 256, { format: "rgb565" });
      const index = applyPalette(data, palette, "rgb565");
      this.gif!.writeFrame(index, this.w, this.h, { palette, delay: delayMs, repeat: 0 });
      return;
    }
    while (this.out >= GIF_QUEUE) await new Promise<void>((go) => this.freed.push(go));
    if (this.err) throw this.err;
    const seq = this.seq++;
    this.out += 1;
    this.workers[seq % this.workers.length].postMessage(
      { seq, first: seq === 0, data, width: this.w, height: this.h, delay: delayMs },
      [data.buffer],
    );
  }

  async finish(): Promise<Blob> {
    if (!this.workers.length) {
      this.gif!.finish();
      return new Blob([this.gif!.bytes() as unknown as BlobPart], { type: "image/gif" });
    }
    try {
      if (this.out > 0) await new Promise<void>((done) => (this.allBack = done));
      if (this.err) throw this.err;
      const all = new Uint8Array(this.parts.reduce((n, part) => n + part.length, 0) + 1);
      let at = 0;
      for (const part of this.parts) {
        all.set(part, at);
        at += part.length;
      }
      all[at] = 0x3b; // the file's trailer
      return new Blob([all], { type: "image/gif" });
    } finally {
      for (const worker of this.workers) worker.terminate();
    }
  }
}

// Codecs to try, most-compatible first. Level 4.0+ so a ~1280x900 frame fits
// (level 3.1 caps below that and configure would reject it).
const MP4_CODECS = ["avc1.640028", "avc1.4d0028", "avc1.420028"];

/** Friendly message when the browser has VideoEncoder but can't actually do H.264. */
const MP4_UNAVAILABLE = "This browser can't encode MP4 (Firefox doesn't yet) — export as GIF instead.";

class Mp4Sink implements FrameSink {
  private target = new ArrayBufferTarget();
  private muxer: Muxer<ArrayBufferTarget>;
  private encoder: VideoEncoder;
  private ts = 0;
  private n = 0;
  private err: DOMException | null = null;
  // The muxer can only write the file once it has the codec's decoder config,
  // which arrives with the first chunk's metadata. Firefox reports H.264 as a
  // supported config but never delivers that config, so finalize() would throw
  // an opaque "decoderConfig is null" -- track it and fail with a clear message.
  private gotConfig = false;

  private constructor(w: number, h: number, codec: string, delayMs: number) {
    this.muxer = new Muxer({
      target: this.target,
      video: { codec: "avc", width: w, height: h },
      fastStart: "in-memory",
    });
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta?.decoderConfig) this.gotConfig = true;
        this.muxer.addVideoChunk(chunk, meta);
      },
      error: (e) => {
        this.err = e;
      },
    });
    this.encoder.configure({
      codec,
      width: w,
      height: h,
      bitrate: Math.min(24_000_000, w * h * 8),
      framerate: Math.max(1, Math.round(1000 / delayMs)),
      // Force length-prefixed NAL + an avcC config in the chunk metadata, which
      // is what the MP4 muxer needs (some encoders otherwise emit annex-B).
      avc: { format: "avc" },
    });
  }

  static async create(w: number, h: number, delayMs: number): Promise<Mp4Sink> {
    for (const codec of MP4_CODECS) {
      const cfg = { codec, width: w, height: h } as VideoEncoderConfig;
      const ok = await VideoEncoder.isConfigSupported(cfg).catch(() => null);
      if (ok?.supported) return new Mp4Sink(w, h, codec, delayMs);
    }
    throw new Error(MP4_UNAVAILABLE);
  }

  async add(canvas: HTMLCanvasElement, delayMs: number): Promise<void> {
    if (this.err) throw this.err;
    const dur = delayMs * 1000; // microseconds
    const frame = new VideoFrame(canvas, { timestamp: this.ts, duration: dur });
    this.ts += dur;
    // A keyframe every ~2 s keeps seeking sane without bloating the file.
    this.encoder.encode(frame, { keyFrame: this.n % 30 === 0 });
    frame.close();
    this.n += 1;
    // Backpressure: don't queue frames faster than the encoder drains them.
    while (this.encoder.encodeQueueSize > 2) await new Promise((r) => setTimeout(r, 4));
  }

  async finish(): Promise<Blob> {
    await this.encoder.flush();
    if (this.err) throw this.err;
    if (!this.gotConfig) throw new Error(MP4_UNAVAILABLE);
    this.muxer.finalize();
    return new Blob([this.target.buffer], { type: "video/mp4" });
  }
}

// Whether MP4 encoding genuinely works here -- not just "VideoEncoder exists".
// Firefox has the API but no H.264 encoder, and only a real test encode (does a
// decoderConfig come back?) tells them apart. Cached: it runs at most once.
let mp4Probe: Promise<boolean> | null = null;
export function probeMp4Support(): Promise<boolean> {
  if (mp4Probe) return mp4Probe;
  mp4Probe = (async () => {
    if (typeof VideoEncoder !== "function" || typeof VideoFrame !== "function") return false;
    for (const codec of MP4_CODECS) {
      try {
        const support = await VideoEncoder.isConfigSupported({ codec, width: 64, height: 64 });
        if (!support.supported) continue;
        let gotConfig = false;
        const enc = new VideoEncoder({
          output: (_c, meta) => {
            if (meta?.decoderConfig) gotConfig = true;
          },
          error: () => {},
        });
        enc.configure({ codec, width: 64, height: 64, bitrate: 1_000_000, framerate: 10, avc: { format: "avc" } });
        const cv = document.createElement("canvas");
        cv.width = 64;
        cv.height = 64;
        const cx = cv.getContext("2d");
        if (cx) {
          cx.fillStyle = "#123";
          cx.fillRect(0, 0, 64, 64);
        }
        const frame = new VideoFrame(cv, { timestamp: 0, duration: 100_000 });
        enc.encode(frame, { keyFrame: true });
        frame.close();
        await enc.flush();
        enc.close();
        if (gotConfig) return true;
      } catch {
        /* try the next codec */
      }
    }
    return false;
  })();
  return mp4Probe;
}

function makeSink(format: AnimFormat, w: number, h: number, delayMs: number): Promise<FrameSink> {
  return format === "mp4" ? Mp4Sink.create(w, h, delayMs) : Promise.resolve(new GifSink(w, h));
}

// A macrotask that a hidden tab does NOT throttle. setTimeout is clamped to
// ~1 s (and, after minutes hidden, ~1/min) when the tab isn't visible, which
// would wedge the whole export; a MessageChannel round-trip is not clamped, so
// all the waits below stay bounded even if the user tabs away mid-run.
function macroYield(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

/** Sleep ~ms, using yields that keep ticking even when the tab is hidden. */
async function sleepAwake(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) await macroYield();
}

/** Longest a frame may take to have its tiles and pictures in. */
const SETTLE_MS = 20_000;

/**
 * The frame just committed, drawn onto the map's canvas now: once every tile
 * and picture it needs is in, one synchronous redraw.
 *
 * This used to wait for the map's own paint -- its "idle" event and animation
 * frames -- and a hidden or minimised window runs neither: the export stood
 * still until the window came back. redraw() draws whether the window shows
 * or not, and waiting on what the frame needs rather than on a paint also took
 * the fixed 0.9 s per frame out (idle seldom came, and the wait ran out).
 */
async function settled(map: MapLibreMap, images: string[] = []): Promise<void> {
  const end = Date.now() + SETTLE_MS;
  const loaded = () =>
    map.areTilesLoaded() &&
    images.every((id) => {
      const src = map.getSource(id) as ImageSource | undefined;
      return !src || src.loaded();
    });
  // Each redraw also starts whatever loading the new frame still needs.
  map.redraw();
  while (!loaded() && Date.now() < end) {
    await sleepAwake(20);
    map.redraw();
  }
  map.redraw();
}

/** The colour table for a product family, resolved the way the map resolves it. */
function paletteFor(family: string): { table: PalTable; units: string; product: string; kind: string } | null {
  const s = useNexradStore.getState();
  const fam = s.grids.find((f) => f.id === family) ?? s.catalog.find((f) => f.id === family);
  if (!fam) return null;

  const pid = s.kindDefaults[fam.kind] ?? "REF";
  const { overrides, custom } = usePaletteStore.getState();
  const mine = overrides[pid] ? custom.find((p) => p.id === overrides[pid]) : null;
  const text = mine?.pal ?? s.palTables[pid]?.pal;
  if (!text) return null;

  const table = parsePal(text);
  if (table.entries.length < 2) return null;
  return { table, units: fam.units || table.units || "", product: fam.label, kind: fam.kind };
}

function fmtUtc(unix: number): { day: string; time: string } {
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return {
    day: `${mo[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`,
  };
}

/** The palette ramp, sampled straight from the LUT the map colours gates with.
 *  Hydrometeor classes get one block per class with its NWS code under it. */
function paintScale(
  ctx: CanvasRenderingContext2D,
  table: PalTable,
  x: number,
  y: number,
  w: number,
  h: number,
  kind = "",
): void {
  if (kind === "hca") {
    paintClasses(ctx, table, x, y, w, h);
    return;
  }
  const { lut, vmin, vmax } = buildLut(table, 256);
  for (let i = 0; i < w; i++) {
    const idx = Math.min(255, Math.round((i / Math.max(w - 1, 1)) * 255)) * 4;
    ctx.fillStyle = `rgb(${lut[idx]},${lut[idx + 1]},${lut[idx + 2]})`;
    ctx.fillRect(x + i, y, 1, h);
  }
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  const span = vmax - vmin || 1;
  ctx.font = TICK_FONT;
  ctx.fillStyle = "rgba(236,236,236,0.65)";
  ctx.textBaseline = "top";
  let lastRight = -Infinity;
  for (const v of palTicks(vmin, vmax, table.step)) {
    const px = x + ((v - vmin) / span) * w;
    const label = String(v);
    const tw = ctx.measureText(label).width;
    const lx = Math.max(x, Math.min(px - tw / 2, x + w - tw));
    if (lx < lastRight + 6) continue;
    ctx.fillText(label, lx, y + h + TICK_GAP);
    lastRight = lx + tw;
  }
}

function paintClasses(ctx: CanvasRenderingContext2D, table: PalTable, x: number, y: number, w: number, h: number): void {
  const classes = hcaKey(table);
  if (classes.length === 0) return;
  const cell = w / classes.length;
  ctx.font = TICK_FONT;
  ctx.textBaseline = "top";
  classes.forEach((c, i) => {
    const cx = x + i * cell;
    ctx.fillStyle = c.color;
    ctx.fillRect(Math.round(cx), y, Math.ceil(cell) - 1, h);
    ctx.fillStyle = "rgba(236,236,236,0.65)";
    const tw = ctx.measureText(c.short).width;
    ctx.fillText(c.short, cx + (cell - tw) / 2, y + h + TICK_GAP);
  });
}

/** The caption strip under the map: what this is, when, and how far through. */
function paintCaption(
  ctx: CanvasRenderingContext2D,
  w: number,
  top: number,
  info: {
    product: string;
    units: string;
    site: string;
    tilt: string;
    unix: number;
    frame: number;
    total: number;
    /** Draws the colour scale into the given box; none, no scale row. */
    scale?: (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void;
    /** Before the time stamp: a model's forecast hour ("F012"). */
    lead?: string;
  },
): void {
  const h = captionHeight(w, Boolean(info.scale));
  ctx.fillStyle = "#262626";
  ctx.fillRect(0, top, w, h);
  ctx.fillStyle = "#353535";
  ctx.fillRect(0, top, w, 1);

  const { day, time } = fmtUtc(info.unix);
  const counter = `${String(info.frame).padStart(2, "0")} / ${info.total}`;
  const lead = info.lead ? `${info.lead}  ` : "";
  ctx.textBaseline = "alphabetic";

  if (isNarrow(w)) {
    ctx.fillStyle = "#ececec";
    // Canvas takes a family name and nothing more: there is no way to reach
    // Recursive's MONO axis from ctx.font. So the labels share the app's face,
    // and the figures stay on the system mono, which is the closest a canvas
    // can get. The face is already loaded by the time anyone exports -- the UI
    // has been drawing in it since startup.
    ctx.font = "600 11px 'Recursive Variable', system-ui, 'Segoe UI', sans-serif";
    ctx.fillText(info.product, PAD, top + 13);

    ctx.font = "600 11px ui-monospace, Consolas, monospace";
    ctx.fillStyle = "#6c9dff";
    ctx.fillText(counter, w - PAD - ctx.measureText(counter).width, top + 13);

    ctx.font = "9.5px ui-monospace, Consolas, monospace";
    ctx.fillStyle = "rgba(236,236,236,0.7)";
    const line2 = [info.units, info.site, info.tilt].filter(Boolean).join(" · ");
    ctx.fillText(line2, PAD, top + 25);
    const stamp = `${lead}${day.replace(/ \d{4}$/, "")} ${time}`;
    ctx.fillText(stamp, w - PAD - ctx.measureText(stamp).width, top + 25);

    info.scale?.(ctx, PAD, top + 30, w - PAD * 2, 6);
    return;
  }

  ctx.fillStyle = "#ececec";
  ctx.font = "600 12.5px 'Recursive Variable', system-ui, 'Segoe UI', sans-serif";
  const title = info.product;
  ctx.fillText(title, PAD, top + 16);

  const x = PAD + ctx.measureText(title).width + 8;
  ctx.font = "10.5px ui-monospace, Consolas, monospace";
  ctx.fillStyle = "rgba(236,236,236,0.55)";
  const sub = [info.units, info.site, info.tilt].filter(Boolean).join("  ·  ");
  ctx.fillText(sub, x, top + 16);

  ctx.font = "600 11.5px ui-monospace, Consolas, monospace";
  ctx.fillStyle = "#6c9dff";
  const cw = ctx.measureText(counter).width;
  ctx.fillText(counter, w - PAD - cw, top + 16);

  ctx.font = "10.5px ui-monospace, Consolas, monospace";
  ctx.fillStyle = "rgba(236,236,236,0.75)";
  const stamp = `${lead}${day}  ${time}`;
  const sw = ctx.measureText(stamp).width;
  ctx.fillText(stamp, w - PAD - cw - 14 - sw, top + 16);

  info.scale?.(ctx, PAD, top + 22, w - PAD * 2, 7);
}

/** A model product's scale, from the bar its legend draws: the colours as a
 *  ramp, and its ticks -- or its words, for a categorical product. */
function paintBar(ctx: CanvasRenderingContext2D, bar: ObsBar, x: number, y: number, w: number, h: number): void {
  const ramp = ctx.createLinearGradient(x, 0, x + w, 0);
  bar.colors.forEach((c, i) => ramp.addColorStop(i / Math.max(1, bar.colors.length - 1), c));
  ctx.fillStyle = ramp;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  const span = bar.max - bar.min || 1;
  const marks = bar.labels ?? bar.ticks.map((v) => ({ v, t: String(Math.round(v * 100) / 100) }));
  ctx.font = TICK_FONT;
  ctx.fillStyle = "rgba(236,236,236,0.65)";
  ctx.textBaseline = "top";
  let lastRight = -Infinity;
  for (const m of marks) {
    const px = x + ((m.v - bar.min) / span) * w;
    const tw = ctx.measureText(m.t).width;
    const lx = Math.max(x, Math.min(px - tw / 2, x + w - tw));
    if (lx < lastRight + 6) continue;
    ctx.fillText(m.t, lx, y + h + TICK_GAP);
    lastRight = lx + tw;
  }
}

/** A satellite product's legend (the Level 2 products carry one): a ramp
 *  through its stops, spaced by value, or a block per category. */
function paintSatLegend(ctx: CanvasRenderingContext2D, legend: SatLegend, x: number, y: number, w: number, h: number): void {
  ctx.font = TICK_FONT;
  ctx.textBaseline = "top";
  const cats = legend.categories ?? [];
  if (cats.length > 0) {
    const cell = w / cats.length;
    cats.forEach(([name, color], i) => {
      const cx = x + i * cell;
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(cx), y, Math.ceil(cell) - 1, h);
      ctx.fillStyle = "rgba(236,236,236,0.65)";
      let t = name;
      while (t.length > 1 && ctx.measureText(t).width > cell - 3) t = t.slice(0, -1);
      ctx.fillText(t, cx + (cell - ctx.measureText(t).width) / 2, y + h + TICK_GAP);
    });
    return;
  }
  const stops = legend.stops ?? [];
  if (stops.length < 2) return;
  const lo = stops[0][0];
  const hi = stops[stops.length - 1][0];
  const at = (v: number) =>
    legend.log && lo > 0
      ? (Math.log(Math.max(v, lo)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo) || 1)
      : (v - lo) / (hi - lo || 1);
  const ramp = ctx.createLinearGradient(x, 0, x + w, 0);
  for (const [v, c] of stops) ramp.addColorStop(Math.max(0, Math.min(1, at(v))), c);
  ctx.fillStyle = ramp;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.fillStyle = "rgba(236,236,236,0.65)";
  let lastRight = -Infinity;
  for (const [v] of stops) {
    const t = String(Math.round(v * 100) / 100);
    const tw = ctx.measureText(t).width;
    const lx = Math.max(x, Math.min(x + at(v) * w - tw / 2, x + w - tw));
    if (lx < lastRight + 6) continue;
    ctx.fillText(t, lx, y + h + TICK_GAP);
    lastRight = lx + tw;
  }
}

/**
 * The app's name on every exported frame, caption or not: a file posted
 * elsewhere carries nothing else to say where it came from (Pablo,
 * 2026-09-26). Top left of the map, small, on a dark tab so it reads over any
 * imagery; sized to the export.
 */
function paintWatermark(ctx: CanvasRenderingContext2D, x: number, y: number, w: number): void {
  const size = Math.max(11, Math.min(16, Math.round(w / 95)));
  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.font = `700 ${size}px 'Recursive Variable', system-ui, 'Segoe UI', sans-serif`;
  const first = "Weather";
  const second = "TS";
  const w1 = ctx.measureText(first).width;
  const w2 = ctx.measureText(second).width;
  const padX = Math.round(size * 0.55);
  const padY = Math.round(size * 0.32);
  const bw = Math.ceil(w1 + w2 + padX * 2);
  const bh = Math.ceil(size + padY * 2);
  const bx = x + 8;
  const by = y + 8;
  ctx.fillStyle = "rgba(20,20,20,0.62)";
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 1;
  ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
  const base = Math.round(by + padY + size * 0.8);
  ctx.fillStyle = "#f2f2f2";
  ctx.fillText(first, bx + padX, base);
  ctx.fillStyle = "#6c9dff";
  ctx.fillText(second, bx + padX + w1, base);
  ctx.restore();
}

// ---- split-screen composition ----

const PANE_GAP = 2;
const PANE_STRIP_H = 32;
const FOOTER_H = 20;

function gridCols(count: number): number {
  if (count <= 2) return count;
  if (count <= 4) return 2;
  return 3;
}

function paintPaneStrip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  info: { product: string; units: string; tilt: string; table: PalTable; kind: string },
): void {
  ctx.fillStyle = "#262626";
  ctx.fillRect(x, y, w, PANE_STRIP_H);

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ececec";
  ctx.font = "600 10.5px 'Recursive Variable', system-ui, 'Segoe UI', sans-serif";
  ctx.fillText(info.product, x + 6, y + 11);

  const right = [info.units, info.tilt].filter(Boolean).join("  ");
  if (right) {
    ctx.font = "9.5px ui-monospace, Consolas, monospace";
    ctx.fillStyle = "rgba(236,236,236,0.55)";
    ctx.fillText(right, x + w - 6 - ctx.measureText(right).width, y + 11);
  }

  paintScale(ctx, info.table, x + 6, y + 15, w - 12, 6, info.kind);
}

/** The frame delay for step n, holding the last frame a touch longer. */
const delayFor = (n: number, total: number, base: number) => (n === total - 1 ? base + LAST_FRAME_HOLD : base);

/** Extension + human name for a format, for the download filename + reporting. */
const fileExt = (f: AnimFormat) => (f === "mp4" ? "mp4" : "gif");

/** Record every pane into one file, arranged as they are on screen. */
async function exportPanes(
  opts: AnimOptions,
  onProgress: (p: GifProgress) => void,
  cancel: GifCancel,
  paneIds: string[],
): Promise<{ blob: Blob; name: string }> {
  const s0 = useNexradStore.getState();
  const scans = s0.scans;
  const startIndex = s0.index;

  const targets = paneIds
    .map((id) => {
      const m = getMapById(id);
      const pane = s0.paneRadar[id];
      const pal = pane ? paletteFor(pane.family) : null;
      return m && pal ? { id, map: m, pal } : null;
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);
  if (targets.length === 0) throw new Error("No panes to capture.");

  const cols = gridCols(targets.length);
  const rows = Math.ceil(targets.length / cols);

  const first = targets[0].map.getCanvas();
  const firstBox = first.getBoundingClientRect();
  const crop = opts.area ?? { x: 0, y: 0, w: firstBox.width, h: firstBox.height };

  const scale =
    Math.min(1, (MAX_GRID_WIDTH - (cols - 1) * PANE_GAP) / Math.max(crop.w * cols, 1)) * opts.scale;
  const cellW = Math.max(2, Math.round(crop.w * scale));
  const cellMapH = Math.max(2, Math.round(crop.h * scale));
  const stripH = opts.caption ? PANE_STRIP_H : 0;
  const footH = opts.caption ? FOOTER_H : 0;
  const cellH = cellMapH + stripH;

  const w = even(cols * cellW + (cols - 1) * PANE_GAP);
  const h = even(rows * cellH + (rows - 1) * PANE_GAP + footH);

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const indices = opts.indices;
  const total = indices.length;
  const sink = await makeSink(opts.format, w, h, opts.delayMs);
  const site = s0.site ? `K${s0.site}` : "";

  try {
    for (let n = 0; n < total; n++) {
      if (cancel.cancelled) throw new GifCancelled();
      const i = indices[n];

      const ok = await useNexradStore.getState().showIndex(i);
      if (cancel.cancelled) throw new GifCancelled();
      if (!ok) throw new Error(`Frame ${n + 1} failed to load.`);
      await Promise.all(targets.map((t) => settled(t.map)));
      if (cancel.cancelled) throw new GifCancelled();

      ctx.fillStyle = "#202020";
      ctx.fillRect(0, 0, w, h);

      const st = useNexradStore.getState();
      targets.forEach((t, k) => {
        const cx = (k % cols) * (cellW + PANE_GAP);
        const cy = Math.floor(k / cols) * (cellH + PANE_GAP);

        const src = t.map.getCanvas();
        const box = src.getBoundingClientRect();
        const dpr = src.width / Math.max(box.width, 1);
        const sx = Math.max(0, Math.round(crop.x * dpr));
        const sy = Math.max(0, Math.round(crop.y * dpr));
        const sw = Math.max(2, Math.min(Math.round(crop.w * dpr), src.width - sx));
        const sh = Math.max(2, Math.min(Math.round(crop.h * dpr), src.height - sy));
        ctx.drawImage(src, sx, sy, sw, sh, cx, cy, cellW, cellMapH);

        if (opts.caption) {
          const elev = st.paneRadar[t.id]?.scan?.meta.elevation;
          paintPaneStrip(ctx, cx, cy + cellMapH, cellW, {
            product: t.pal.product,
            units: t.pal.units,
            tilt: elev != null ? `${elev.toFixed(1)}°` : "",
            table: t.pal.table,
            kind: t.pal.kind,
          });
        }
      });

      if (opts.caption) {
        const footY = h - FOOTER_H;
        ctx.fillStyle = "#262626";
        ctx.fillRect(0, footY, w, FOOTER_H);
        ctx.fillStyle = "#353535";
        ctx.fillRect(0, footY, w, 1);

        const { day, time } = fmtUtc(scans[i].time);
        ctx.textBaseline = "alphabetic";
        ctx.font = "10.5px ui-monospace, Consolas, monospace";
        ctx.fillStyle = "rgba(236,236,236,0.8)";
        ctx.fillText(`${site}  ${day}  ${time}`, PAD, footY + 14);

        const counter = `${String(n + 1).padStart(2, "0")} / ${total}`;
        ctx.font = "600 11px ui-monospace, Consolas, monospace";
        ctx.fillStyle = "#6c9dff";
        ctx.fillText(counter, w - PAD - ctx.measureText(counter).width, footY + 14);
      }
      paintWatermark(ctx, 0, 0, w);

      await sink.add(out, delayFor(n, total, opts.delayMs));
      onProgress({ phase: "capturing", done: n + 1, total });
      await macroYield();
    }

    onProgress({ phase: "encoding", done: total, total });
    const blob = await sink.finish();
    const { day, time } = fmtUtc(scans[indices[indices.length - 1]].time);
    const name = `${site || "radar"}_${targets.length}panes_${day.replace(/ /g, "-")}_${time.replace(":", "")}.${fileExt(opts.format)}`;
    return { blob, name };
  } finally {
    await useNexradStore.getState().showIndex(startIndex);
  }
}

/** One pane's capture box and the output canvas, the same for radar, the
 *  models and the satellite. `scaled`: the caption has a colour scale row. */
function singlePane(map: MapLibreMap, opts: AnimOptions, scaled = true) {
  const src = map.getCanvas();
  const box = src.getBoundingClientRect();
  const dpr = src.width / Math.max(box.width, 1);
  const crop = opts.area ?? { x: 0, y: 0, w: box.width, h: box.height };
  const sx = Math.max(0, Math.round(crop.x * dpr));
  const sy = Math.max(0, Math.round(crop.y * dpr));
  const sw = Math.max(2, Math.min(Math.round(crop.w * dpr), src.width - sx));
  const sh = Math.max(2, Math.min(Math.round(crop.h * dpr), src.height - sy));
  const scale = Math.min(1, MAX_WIDTH / Math.max(crop.w, 1)) * opts.scale;
  const w = even(Math.max(2, Math.round(crop.w * scale)));
  const mapH = Math.max(2, Math.round(crop.h * scale));
  const capH = opts.caption ? captionHeight(w, scaled) : 0;
  const h = even(mapH + capH);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return { src, sx, sy, sw, sh, w, h, mapH, out, ctx };
}

/** Longest a model frame may take to be drawn before the export gives up. */
const MODEL_FRAME_TIMEOUT_MS = 120_000;

/**
 * Put the model frame `want` ("source|field|key") on the map and wait until it
 * is final: drawn, and its sharp on-screen picture over it (or none needed at
 * this zoom) -- so the export shows what the screen would, not the coarse
 * whole-domain picture under it.
 */
async function modelFrame(map: MapLibreMap, i: number, want: string, cancel: GifCancel): Promise<void> {
  useObsStore.getState().setIndex(i);
  const end = Date.now() + MODEL_FRAME_TIMEOUT_MS;
  let asked = false;
  for (;;) {
    if (cancel.cancelled) throw new GifCancelled();
    const s = useObsStore.getState();
    // Its city values too: without them a frame went out with the numbers of
    // the one before, when the frames themselves came fast.
    if (obsFrameFinal(map, want)) return;
    if (!s.busy && s.error && s.drawn !== want) throw new Error(s.error);
    // Drawn: its detail picture and values at once, not after the settle timers.
    if (s.drawn === want && !asked) {
      asked = true;
      obsDetailNow();
    }
    if (Date.now() > end) throw new Error("A frame took too long to draw.");
    await sleepAwake(20);
  }
}

/**
 * Capture the Models panel's hours -- the selected ones of the timeline -- as a
 * GIF or MP4, from the focused pane. The frames' pictures are made ahead on the
 * server first, and the timeline goes back to where it was.
 */
async function exportModels(
  opts: AnimOptions,
  onProgress: (p: GifProgress) => void,
  cancel: GifCancel,
): Promise<{ blob: Blob; name: string }> {
  const map = getMap();
  if (!map) throw new Error("No map to capture.");
  const s0 = useObsStore.getState();
  if (s0.view === "models") throw new Error("Close Compare models first: the export records the main map.");
  const frames = s0.frames;
  if (frames.length === 0) throw new Error("No model hours loaded yet.");
  if (opts.indices.length === 0) throw new Error("No frames selected.");
  // The timeline stops: it and the export would both be moving the map.
  if (s0.playing) s0.stopLoop();

  const { source, field, catalog } = s0;
  const model = catalog?.sources.find((x) => x.id === source)?.label ?? source;
  const product = catalog?.products.find((x) => x.id === field);
  const startIndex = s0.index;
  const indices = opts.indices;
  const total = indices.length;
  const keys = indices.map((i) => frames[i].key);
  // Made on the server, and brought here with their detail pictures, ahead of
  // the capture: it then steps through frames that are already in.
  prefetchObsLoop(source, field, keys).catch(() => {
    /* each is made as it is reached instead */
  });
  void obsPreload(map, source, field, [...new Set(keys)], () => cancel.cancelled);

  const { src, sx, sy, sw, sh, w, h, mapH, out, ctx } = singlePane(map, opts);
  const sink = await makeSink(opts.format, w, h, opts.delayMs);

  try {
    for (let n = 0; n < total; n++) {
      if (cancel.cancelled) throw new GifCancelled();
      const i = indices[n];
      const f = frames[i];
      await modelFrame(map, i, `${source}|${field}|${f.key}`, cancel);
      await settled(map, OBS_IMAGE_SOURCES);
      if (cancel.cancelled) throw new GifCancelled();

      ctx.fillStyle = "#202020";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, mapH);
      paintWatermark(ctx, 0, 0, w);

      const bar = useObsStore.getState().bar;
      if (opts.caption && bar) {
        const run = f.run ? `${f.run.slice(8, 10)}Z run` : "";
        paintCaption(ctx, w, mapH, {
          product: product?.label ?? field,
          units: bar.unit || product?.unit || "",
          site: model,
          tilt: run,
          unix: f.unix,
          frame: n + 1,
          total,
          scale: (c, x, y, bw, bh) => paintBar(c, bar, x, y, bw, bh),
          lead: f.fh != null ? fhText(f) : undefined,
        });
      }

      await sink.add(out, delayFor(n, total, opts.delayMs));
      onProgress({ phase: "capturing", done: n + 1, total });
      await macroYield();
    }

    onProgress({ phase: "encoding", done: total, total });
    const blob = await sink.finish();
    const lastFrame = frames[indices[indices.length - 1]];
    const { day, time } = fmtUtc(lastFrame.unix);
    const slug = (x: string) => x.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "");
    const name = `${slug(model)}_${slug(product?.label ?? field)}_${day.replace(/ /g, "-")}_${time.replace(":", "")}.${fileExt(opts.format)}`;
    return { blob, name };
  } finally {
    useObsStore.getState().setIndex(startIndex);
  }
}

/** Longest a satellite frame may take to come before the export gives up. */
const SAT_FRAME_TIMEOUT_MS = 120_000;
/** Past this, a frame whose sharp picture has not come goes out with its quick one. */
const SAT_SHARP_WAIT_MS = 30_000;

/**
 * Capture the satellite's frames -- the selected ones of its loop -- as a GIF
 * or MP4, from the focused pane: every frame with its sharp picture (the loop
 * downloads ahead of the capture), a frame the provider has no picture for
 * left out, and the timeline back where it was.
 */
async function exportSatellite(
  opts: AnimOptions,
  onProgress: (p: GifProgress) => void,
  cancel: GifCancel,
): Promise<{ blob: Blob; name: string }> {
  const map = getMap();
  if (!map) throw new Error("No map to capture.");
  const s0 = useSatStore.getState();
  if (s0.frames.length === 0) throw new Error("No satellite frames loaded yet.");
  if (opts.indices.length === 0) throw new Error("No frames selected.");
  // The timeline stops -- it and the export would both be moving the map --
  // and the whole loop downloads now, ahead of the capture.
  if (s0.playing) s0.stopLoop();
  useSatStore.getState().armLoop();

  const sat = selectSatSatellite(s0);
  const region = selectSatRegion(s0);
  const product = selectSatProduct(s0);
  const legend = product?.legend ?? null;
  const startTime = s0.frames[s0.index]?.time;
  // By time, not index: a new scan arriving mid-export shifts the list.
  const times = opts.indices.map((i) => s0.frames[i]?.time).filter((t): t is string => Boolean(t));
  const total = times.length;

  const { src, sx, sy, sw, sh, w, h, mapH, out, ctx } = singlePane(map, opts, Boolean(legend));
  const sink = await makeSink(opts.format, w, h, opts.delayMs);
  let lastUnix = 0;

  try {
    for (let n = 0; n < total; n++) {
      if (cancel.cancelled) throw new GifCancelled();
      const t = times[n];
      const i = useSatStore.getState().frames.findIndex((f) => f.time === t);
      if (i < 0) continue; // dropped off the list meanwhile
      useSatStore.getState().setIndex(i);
      const t0 = Date.now();
      let shown: "yes" | "no" | "empty" = "no";
      for (;;) {
        if (cancel.cancelled) throw new GifCancelled();
        shown = satFrameOnScreen(map, t, Date.now() - t0 > SAT_SHARP_WAIT_MS);
        if (shown !== "no") break;
        if (Date.now() - t0 > SAT_FRAME_TIMEOUT_MS) throw new Error("A satellite frame took too long to come.");
        await sleepAwake(40);
      }
      if (shown === "empty") continue;
      await settled(map, [SAT_IMAGE_SOURCE]);
      if (cancel.cancelled) throw new GifCancelled();

      const frame = useSatStore.getState().frames[i];
      lastUnix = frame.unix;
      ctx.fillStyle = "#202020";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, mapH);
      paintWatermark(ctx, 0, 0, w);
      if (opts.caption) {
        paintCaption(ctx, w, mapH, {
          product: product?.label ?? s0.product,
          units: legend?.units ?? "",
          site: [sat?.label, region?.label].filter(Boolean).join(" "),
          tilt: "",
          unix: frame.unix,
          frame: n + 1,
          total,
          scale: legend ? (c, x, y, bw, bh) => paintSatLegend(c, legend, x, y, bw, bh) : undefined,
        });
      }

      await sink.add(out, delayFor(n, total, opts.delayMs));
      onProgress({ phase: "capturing", done: n + 1, total });
      await macroYield();
    }
    if (lastUnix === 0) throw new Error("None of these frames has a picture.");

    onProgress({ phase: "encoding", done: total, total });
    const blob = await sink.finish();
    const { day, time } = fmtUtc(lastUnix);
    const slug = (x: string) => x.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "");
    const name = `${slug(sat?.label ?? s0.sat)}_${slug(product?.label ?? s0.product)}_${day.replace(/ /g, "-")}_${time.replace(":", "")}.${fileExt(opts.format)}`;
    return { blob, name };
  } finally {
    const back = useSatStore.getState().frames.findIndex((f) => f.time === startTime);
    if (back >= 0) useSatStore.getState().setIndex(back);
  }
}

/**
 * Capture the selected frames -- radar scans, the Models panel's hours, or the
 * satellite's frames -- as a GIF or MP4, leaving the timeline back where it
 * started. Rejects with GifCancelled if the caller cancels mid-run.
 */
export async function exportAnimation(
  opts: AnimOptions,
  onProgress: (p: GifProgress) => void,
  cancel: GifCancel,
): Promise<{ blob: Blob; name: string }> {
  // In the desktop app, the window is told not to slow down while hidden for
  // the length of the export: its timers keep their pace and the map keeps
  // drawing, minimised or not. (The capture itself no longer needs the window
  // on screen; this keeps the rest of the app -- labels, pictures -- on time.)
  const desktop = (window as unknown as { electronAPI?: { keepRendering?: (on: boolean) => void } }).electronAPI;
  desktop?.keepRendering?.(true);
  try {
    if (opts.subject === "models") return await exportModels(opts, onProgress, cancel);
    if (opts.subject === "satellite") return await exportSatellite(opts, onProgress, cancel);
    return await exportRadar(opts, onProgress, cancel);
  } finally {
    desktop?.keepRendering?.(false);
  }
}

/** The radar's scans, from the focused pane (every pane in split screen). */
async function exportRadar(
  opts: AnimOptions,
  onProgress: (p: GifProgress) => void,
  cancel: GifCancel,
): Promise<{ blob: Blob; name: string }> {
  const map = getMap();
  const paneId = getActivePaneId();
  if (!map) throw new Error("No map to capture.");

  const s0 = useNexradStore.getState();
  const scans = s0.scans;
  if (scans.length === 0) throw new Error("No radar frames loaded yet.");
  if (opts.indices.length === 0) throw new Error("No frames selected.");
  // Scans not downloaded yet load several at a time from the first exported one
  // on, rather than one by one as each frame comes up.
  s0.prefetch(opts.indices[0]);

  const paneIds = Object.keys(s0.paneRadar).sort();
  if (paneIds.length > 1) return exportPanes(opts, onProgress, cancel, paneIds);

  const pane = paneId ? s0.paneRadar[paneId] : undefined;
  const family = pane?.family ?? s0.family;
  const pal = paletteFor(family);
  if (!pal) throw new Error("No colour table for this product.");

  const startIndex = s0.index;
  const indices = opts.indices;
  const total = indices.length;

  const src = map.getCanvas();
  const box = src.getBoundingClientRect();
  const dpr = src.width / Math.max(box.width, 1);
  const crop = opts.area ?? { x: 0, y: 0, w: box.width, h: box.height };
  const sx = Math.max(0, Math.round(crop.x * dpr));
  const sy = Math.max(0, Math.round(crop.y * dpr));
  const sw = Math.max(2, Math.min(Math.round(crop.w * dpr), src.width - sx));
  const sh = Math.max(2, Math.min(Math.round(crop.h * dpr), src.height - sy));

  const scale = Math.min(1, MAX_WIDTH / Math.max(crop.w, 1)) * opts.scale;
  const w = even(Math.max(2, Math.round(crop.w * scale)));
  const mapH = Math.max(2, Math.round(crop.h * scale));
  const capH = opts.caption ? captionHeight(w) : 0;
  const h = even(mapH + capH);

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const sink = await makeSink(opts.format, w, h, opts.delayMs);
  const site = s0.site ? `K${s0.site}` : "";

  try {
    for (let n = 0; n < total; n++) {
      if (cancel.cancelled) throw new GifCancelled();
      const i = indices[n];

      const ok = await useNexradStore.getState().showIndex(i);
      if (cancel.cancelled) throw new GifCancelled();
      if (!ok) throw new Error(`Frame ${n + 1} failed to load.`);
      await settled(map);
      if (cancel.cancelled) throw new GifCancelled();

      ctx.fillStyle = "#202020";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, mapH);
      paintWatermark(ctx, 0, 0, w);

      if (opts.caption) {
        const st = useNexradStore.getState();
        const cur = (paneId ? st.paneRadar[paneId]?.scan : null) ?? st.scan;
        paintCaption(ctx, w, mapH, {
          product: pal.product,
          units: pal.units,
          site,
          tilt: cur?.meta.elevation != null ? `${cur.meta.elevation.toFixed(1)}°` : "",
          unix: scans[i].time,
          frame: n + 1,
          total,
          scale: (c, x, y, sw2, sh2) => paintScale(c, pal.table, x, y, sw2, sh2, pal.kind),
        });
      }

      await sink.add(out, delayFor(n, total, opts.delayMs));
      onProgress({ phase: "capturing", done: n + 1, total });
      await macroYield();
    }

    onProgress({ phase: "encoding", done: total, total });
    const blob = await sink.finish();
    const { day, time } = fmtUtc(scans[indices[indices.length - 1]].time);
    const slug = pal.product.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "");
    const name = `${site || "radar"}_${slug}_${day.replace(/ /g, "-")}_${time.replace(":", "")}.${fileExt(opts.format)}`;
    return { blob, name };
  } finally {
    await useNexradStore.getState().showIndex(startIndex);
  }
}

/** The pixel size an export would produce right now, for the dialog's summary. */
export function estimateDimensions(
  scale: number,
  caption: boolean,
  subject: AnimSubject = "radar",
): { w: number; h: number } | null {
  const map = getMap();
  if (!map) return null;
  const box = map.getCanvas().getBoundingClientRect();
  // The models and the satellite are captured from the focused pane alone.
  const panes = subject !== "radar" ? 1 : Math.max(1, Object.keys(useNexradStore.getState().paneRadar).length);
  if (panes > 1) {
    const cols = gridCols(panes);
    const rows = Math.ceil(panes / cols);
    const s = Math.min(1, (MAX_GRID_WIDTH - (cols - 1) * PANE_GAP) / Math.max(box.width * cols, 1)) * scale;
    const cellW = Math.max(2, Math.round(box.width * s));
    const cellMapH = Math.max(2, Math.round(box.height * s));
    const stripH = caption ? PANE_STRIP_H : 0;
    const footH = caption ? FOOTER_H : 0;
    return {
      w: even(cols * cellW + (cols - 1) * PANE_GAP),
      h: even(rows * (cellMapH + stripH) + (rows - 1) * PANE_GAP + footH),
    };
  }
  const s = Math.min(1, MAX_WIDTH / Math.max(box.width, 1)) * scale;
  const w = even(Math.max(2, Math.round(box.width * s)));
  const mapH = Math.max(2, Math.round(box.height * s));
  const scaled = subject !== "satellite" || Boolean(selectSatProduct(useSatStore.getState())?.legend);
  return { w, h: even(mapH + (caption ? captionHeight(w, scaled) : 0)) };
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
