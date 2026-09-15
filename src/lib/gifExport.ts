// Animated export of the radar loop, as GIF or MP4.
//
// The frames are captured from the live map rather than re-rendered offscreen,
// so what you export is exactly what you were looking at -- basemap, alerts,
// storm chrome and all. Each frame gets a caption strip burned in underneath:
// the product, the site and tilt, the frame's own timestamp, a frame counter
// that climbs as the loop plays, and the product's colour table. A file posted
// somewhere else carries no UI around it, so the scale has to travel with it.
//
// GIF and MP4 share every bit of the capture + composition; they differ only in
// the FrameSink that consumes each finished canvas.

import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import type { Map as MapLibreMap } from "maplibre-gl";

import { getMap, getMapById, getActivePaneId } from "../map/mapInstance";
import { useNexradStore } from "../store/useNexradStore";
import { usePaletteStore } from "../store/usePaletteStore";
import type { AnimFormat, GifArea } from "../store/useGifStore";
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

/** Below this the caption goes to two rows -- one line will not fit. */
const isNarrow = (w: number) => w < 470;
/** The caption strip's height, which depends on that layout choice. */
const captionHeight = (w: number) => (isNarrow(w) ? 62 : 74);

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
}

// ---- frame sinks: one per output format, same interface ----

interface FrameSink {
  add(canvas: HTMLCanvasElement, delayMs: number): Promise<void>;
  finish(): Promise<Blob>;
}

class GifSink implements FrameSink {
  private gif = GIFEncoder();
  constructor(private w: number, private h: number) {}
  async add(canvas: HTMLCanvasElement, delayMs: number): Promise<void> {
    const ctx = canvas.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, this.w, this.h);
    const palette = quantize(data, 256, { format: "rgb565" });
    const index = applyPalette(data, palette, "rgb565");
    this.gif.writeFrame(index, this.w, this.h, { palette, delay: delayMs, repeat: 0 });
  }
  async finish(): Promise<Blob> {
    this.gif.finish();
    return new Blob([this.gif.bytes() as unknown as BlobPart], { type: "image/gif" });
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

/**
 * Wait for the next paint, but never hang: a hidden tab stops firing rAF
 * entirely, so race it against a short un-throttled sleep.
 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(fin);
    void sleepAwake(50).then(fin);
  });
}

/**
 * Wait until the map has actually painted the frame we just committed.
 *
 * `idle` is the real signal (tiles settled, no pending repaint); race it against
 * an un-throttled timeout so a hidden tab can't wedge here. The two paints after
 * it are what guarantee the WebGL buffer we read has the new mesh in it.
 */
async function settled(map: MapLibreMap): Promise<void> {
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      map.off("idle", finish);
      resolve();
    };
    map.on("idle", finish);
    map.triggerRepaint();
    void sleepAwake(900).then(finish);
  });
  await nextPaint();
  await nextPaint();
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
  ctx.font = "10px ui-monospace, Consolas, monospace";
  ctx.fillStyle = "rgba(236,236,236,0.65)";
  ctx.textBaseline = "top";
  let lastRight = -Infinity;
  for (const v of palTicks(vmin, vmax, table.step)) {
    const px = x + ((v - vmin) / span) * w;
    const label = String(v);
    const tw = ctx.measureText(label).width;
    const lx = Math.max(x, Math.min(px - tw / 2, x + w - tw));
    if (lx < lastRight + 6) continue;
    ctx.fillText(label, lx, y + h + 4);
    lastRight = lx + tw;
  }
}

function paintClasses(ctx: CanvasRenderingContext2D, table: PalTable, x: number, y: number, w: number, h: number): void {
  const classes = hcaKey(table);
  if (classes.length === 0) return;
  const cell = w / classes.length;
  ctx.font = "10px ui-monospace, Consolas, monospace";
  ctx.textBaseline = "top";
  classes.forEach((c, i) => {
    const cx = x + i * cell;
    ctx.fillStyle = c.color;
    ctx.fillRect(Math.round(cx), y, Math.ceil(cell) - 1, h);
    ctx.fillStyle = "rgba(236,236,236,0.65)";
    const tw = ctx.measureText(c.short).width;
    ctx.fillText(c.short, cx + (cell - tw) / 2, y + h + 4);
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
    table: PalTable;
    kind: string;
  },
): void {
  const h = captionHeight(w);
  ctx.fillStyle = "#262626";
  ctx.fillRect(0, top, w, h);
  ctx.fillStyle = "#353535";
  ctx.fillRect(0, top, w, 1);

  const { day, time } = fmtUtc(info.unix);
  const counter = `${String(info.frame).padStart(2, "0")} / ${info.total}`;
  ctx.textBaseline = "alphabetic";

  if (isNarrow(w)) {
    ctx.fillStyle = "#ececec";
    // Canvas takes a family name and nothing more: there is no way to reach
    // Recursive's MONO axis from ctx.font. So the labels share the app's face,
    // and the figures stay on the system mono, which is the closest a canvas
    // can get. The face is already loaded by the time anyone exports -- the UI
    // has been drawing in it since startup.
    ctx.font = "600 12px 'Recursive Variable', system-ui, 'Segoe UI', sans-serif";
    ctx.fillText(info.product, PAD, top + 16);

    ctx.font = "600 12px ui-monospace, Consolas, monospace";
    ctx.fillStyle = "#6c9dff";
    ctx.fillText(counter, w - PAD - ctx.measureText(counter).width, top + 16);

    ctx.font = "10px ui-monospace, Consolas, monospace";
    ctx.fillStyle = "rgba(236,236,236,0.7)";
    const line2 = [info.units, info.site, info.tilt].filter(Boolean).join(" · ");
    ctx.fillText(line2, PAD, top + 30);
    const stamp = `${day.replace(/ \d{4}$/, "")} ${time}`;
    ctx.fillText(stamp, w - PAD - ctx.measureText(stamp).width, top + 30);

    paintScale(ctx, info.table, PAD, top + 40, w - PAD * 2, 10, info.kind);
    return;
  }

  ctx.fillStyle = "#ececec";
  ctx.font = "600 14px 'Recursive Variable', system-ui, 'Segoe UI', sans-serif";
  const title = info.product;
  ctx.fillText(title, PAD, top + 19);

  const x = PAD + ctx.measureText(title).width + 8;
  ctx.font = "11px ui-monospace, Consolas, monospace";
  ctx.fillStyle = "rgba(236,236,236,0.55)";
  const sub = [info.units, info.site, info.tilt].filter(Boolean).join("  ·  ");
  ctx.fillText(sub, x, top + 19);

  ctx.font = "600 13px ui-monospace, Consolas, monospace";
  ctx.fillStyle = "#6c9dff";
  const cw = ctx.measureText(counter).width;
  ctx.fillText(counter, w - PAD - cw, top + 19);

  ctx.font = "11px ui-monospace, Consolas, monospace";
  ctx.fillStyle = "rgba(236,236,236,0.75)";
  const stamp = `${day}  ${time}`;
  const sw = ctx.measureText(stamp).width;
  ctx.fillText(stamp, w - PAD - cw - 14 - sw, top + 19);

  paintScale(ctx, info.table, PAD, top + 30, w - PAD * 2, 12, info.kind);
}

// ---- split-screen composition ----

const PANE_GAP = 2;
const PANE_STRIP_H = 44;
const FOOTER_H = 28;

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
  ctx.font = "600 11px 'Recursive Variable', system-ui, 'Segoe UI', sans-serif";
  ctx.fillText(info.product, x + 6, y + 13);

  const right = [info.units, info.tilt].filter(Boolean).join("  ");
  if (right) {
    ctx.font = "10px ui-monospace, Consolas, monospace";
    ctx.fillStyle = "rgba(236,236,236,0.55)";
    ctx.fillText(right, x + w - 6 - ctx.measureText(right).width, y + 13);
  }

  paintScale(ctx, info.table, x + 6, y + 19, w - 12, 8, info.kind);
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
        ctx.font = "11px ui-monospace, Consolas, monospace";
        ctx.fillStyle = "rgba(236,236,236,0.8)";
        ctx.fillText(`${site}  ${day}  ${time}`, PAD, footY + 18);

        const counter = `${String(n + 1).padStart(2, "0")} / ${total}`;
        ctx.font = "600 12px ui-monospace, Consolas, monospace";
        ctx.fillStyle = "#6c9dff";
        ctx.fillText(counter, w - PAD - ctx.measureText(counter).width, footY + 18);
      }

      await sink.add(out, delayFor(n, total, opts.delayMs));
      onProgress({ phase: "capturing", done: n + 1, total });
      await nextPaint();
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

/**
 * Capture the selected radar frames as a GIF or MP4.
 *
 * Runs over `opts.indices` of the focused pane (every pane in split screen),
 * leaving the timeline back where it started. Rejects with GifCancelled if the
 * caller cancels mid-run.
 */
export async function exportAnimation(
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
          table: pal.table,
          kind: pal.kind,
        });
      }

      await sink.add(out, delayFor(n, total, opts.delayMs));
      onProgress({ phase: "capturing", done: n + 1, total });
      await nextPaint();
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
export function estimateDimensions(scale: number, caption: boolean): { w: number; h: number } | null {
  const map = getMap();
  if (!map) return null;
  const box = map.getCanvas().getBoundingClientRect();
  const panes = Math.max(1, Object.keys(useNexradStore.getState().paneRadar).length);
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
  return { w, h: even(mapH + (caption ? captionHeight(w) : 0)) };
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
