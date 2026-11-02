/**
 * The Export page's work (src/ui/ExportPage.tsx): one pane, or every pane
 * together, as a PNG, a GIF of the whole loop, or a video.
 *
 * The panes are drawn IN PLACE: each at the spot it has on screen, floating
 * windows over the tiled panes in their stacking order, a thin divider where
 * tiled panes meet. A pane showing the 3D view or a cross-section is drawn as
 * that view, fitted into the pane. Each pane carries a caption block top-left
 * -- one line per thing it shows (radar / product / tilt, the model and its
 * hour, the satellite, the mosaic, an outlook, the storm picked) and the time
 * in the viewer's own time zone -- and the picture carries the WeatherTS logo
 * once, bottom-right, with the basemap's credit.
 *
 * What gifExport.ts already does is used from there: the frame sinks (GIF on
 * workers, MP4 through WebCodecs, WebM where there is no H.264 encoder), the
 * wait for a frame's tiles and pictures, the model and satellite frame waits,
 * the colour scale painter. The Customize Animation dialog stays for ranges,
 * steps and boomerangs; this page is the one-click export of what is on screen.
 */
import type { Map as MapLibreMap } from "maplibre-gl";

import { getActivePaneId, getMap, getMapById } from "../map/mapInstance";
import { basemapInfo } from "../map/basemaps";
import { getLayerModule } from "../layers/registry";
import { OBS_IMAGE_SOURCES, obsPreload } from "../layers/modules/obsLayer";
import { SAT_IMAGE_SOURCE, satFrameOnScreen } from "../layers/modules/satelliteLayer";
import { getSetting } from "../settings/useSettingsStore";
import { useAppStore } from "../store/useAppStore";
import { useCompareStore } from "../store/useCompareStore";
import { useNexradStore } from "../store/useNexradStore";
import { useObsStore } from "../store/useObsStore";
import { usePaneStore, type AnalysisKind } from "../store/usePaneStore";
import { selectSatProduct, selectSatRegion, selectSatSatellite, useSatStore } from "../store/useSatStore";
import { useTimelineStore } from "../store/useTimelineStore";
import { useXsectStore } from "../store/useXsectStore";
import {
  MAX_ANIM_SIDE,
  useExportStore,
  type ExportKind,
  type ExportSize,
} from "../store/useExportStore";
import { captureExportView, type ViewShot } from "./exportViews";
import {
  GifCancelled,
  createGifSink,
  createVideoSink,
  downloadBlob,
  macroYield,
  modelFrame,
  paintScale,
  paletteFor,
  settled,
  sleepAwake,
  type FrameSink,
  type GifCancel,
} from "./gifExport";
import { fhText, prefetchObsLoop } from "./observations";
import { paneIds } from "./paneOps";
import { isFloat } from "./paneWindows";
import type { PalTable } from "./pal";

// ---------------------------------------------------------------- layout ---

interface PaneBox {
  id: string;
  el: HTMLElement;
  /** Page CSS px. */
  x: number;
  y: number;
  w: number;
  h: number;
  floating: boolean;
  z: number;
}

export interface ExportLayout {
  /** The exported region, page CSS px. */
  left: number;
  top: number;
  w: number;
  h: number;
  panes: PaneBox[];
  /** Device px per CSS px of the maps (the screen's resolution). */
  dpr: number;
}

const even = (n: number) => Math.max(2, n - (n % 2));

function paneEl(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.mappane[data-pane="${id}"]`);
}

/** Where every pane to export sits now: one pane, or all of them. */
export function exportLayout(all: boolean, paneId: string): ExportLayout {
  const floats = usePaneStore.getState().floats;
  const ids = all ? paneIds() : [paneId];
  const panes: PaneBox[] = [];
  for (const id of ids) {
    const el = paneEl(id);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const f = floats[id];
    const floating = isFloat(f);
    panes.push({ id, el, x: r.left, y: r.top, w: r.width, h: r.height, floating, z: floating ? f.z : 0 });
  }
  if (!panes.length) throw new Error("There is no pane to capture.");
  panes.sort((a, b) => Number(a.floating) - Number(b.floating) || a.z - b.z);

  let box = { left: panes[0].x, top: panes[0].y, w: panes[0].w, h: panes[0].h };
  if (all && panes.length > 1) {
    const area = document.querySelector<HTMLElement>(".map-canvas")?.getBoundingClientRect();
    if (area && area.width > 2 && area.height > 2) box = { left: area.left, top: area.top, w: area.width, h: area.height };
    else {
      const l = Math.min(...panes.map((p) => p.x));
      const t = Math.min(...panes.map((p) => p.y));
      box = { left: l, top: t, w: Math.max(...panes.map((p) => p.x + p.w)) - l, h: Math.max(...panes.map((p) => p.y + p.h)) - t };
    }
  }
  // The maps' own resolution: their canvas pixels per CSS px.
  let dpr = window.devicePixelRatio || 1;
  for (const p of panes) {
    const c = getMapById(p.id)?.getCanvas();
    const w = c?.getBoundingClientRect().width ?? 0;
    if (c && w > 0) {
      dpr = c.width / w;
      break;
    }
  }
  return { ...box, panes, dpr };
}

/** GIF / video scale: the size asked (long side), never past the screen's
 *  resolution or MAX_ANIM_SIDE. */
export function animScale(L: ExportLayout, size: ExportSize): number {
  const long = Math.max(L.w, L.h, 1);
  const want = size === "full" ? L.dpr : Number(size) / long;
  return Math.min(L.dpr, MAX_ANIM_SIDE / long, want);
}

/** The pixel size each export would have now, for the page's rows. */
export function exportDims(kind: ExportKind, all: boolean, paneId: string, size: ExportSize): { w: number; h: number } | null {
  try {
    const L = exportLayout(all, paneId);
    const k = kind === "image" ? L.dpr : animScale(L, size);
    const w = Math.round(L.w * k);
    const h = Math.round(L.h * k);
    return kind === "image" ? { w, h } : { w: even(w), h: even(h) };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- captions ---

interface Caption {
  lines: string[];
  unix: number | null;
  scale: { table: PalTable; kind: string } | null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The time in the viewer's own time zone: "Mon, May 20, 2013, 3:16:43 PM CDT". */
export function localStamp(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

function shortLocal(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function famOf(id: string) {
  const s = useNexradStore.getState();
  return s.grids.find((f) => f.id === id) ?? s.catalog.find((f) => f.id === id);
}

function icaoOf(siteId: string | null | undefined): string {
  if (!siteId) return "";
  return useNexradStore.getState().sites.find((x) => x.id === siteId)?.icao ?? siteId;
}

/** What one pane shows, as its caption lines. */
function paneCaption(id: string, view: AnalysisKind | undefined, shot: ViewShot | null): Caption {
  if (view === "r3d") {
    return { lines: shot?.lines ?? ["3D view"], unix: shot?.unix ?? null, scale: null };
  }
  if (view === "xsect") {
    const xs = useXsectStore.getState();
    const m = xs.data?.meta;
    const lines = [
      `Cross section · ${icaoOf(m?.site ?? xs.site)} ${m?.productLabel ?? famOf(xs.fam)?.label ?? xs.fam}`.trim(),
    ];
    if (m) lines.push(`${m.lengthKm.toFixed(0)} km line · top ${m.topKm} km`);
    return { lines, unix: m?.scanUnix ?? xs.at ?? null, scale: null };
  }

  const app = useAppStore.getState();
  const nx = useNexradStore.getState();
  const hidden = new Set(usePaneStore.getState().hidden[id] ?? []);
  const lines: string[] = [];
  let unix: number | null = null;
  let scale: Caption["scale"] = null;

  // Radar / product / tilt (and the compared product, when the pane is split).
  const pane = nx.paneRadar[id];
  const radarShown = !!app.layers.nexrad?.visible && !!pane && !pane.empty;
  if (radarShown && pane) {
    const scan = pane.scan;
    const fam = famOf(pane.family);
    const elev = scan?.meta.elevation;
    let line = `${icaoOf(pane.site || scan?.meta.site || nx.site)} · ${fam?.label ?? pane.family}${elev != null ? ` ${elev.toFixed(1)}°` : ""}`;
    const cmp = useCompareStore.getState().slots[id];
    if (cmp) line += ` | ${famOf(cmp.family)?.label ?? cmp.family}`;
    lines.push(line);
    unix = scan?.meta.sweepUnix ?? scan?.meta.scanUnix ?? scan?.meta.validUnix ?? nx.scans[nx.index]?.time ?? null;
    const pal = paletteFor(pane.family);
    if (pal) scale = { table: pal.table, kind: pal.kind };
  }

  // The model and its hour, or the mosaic.
  const ob = useObsStore.getState();
  if (app.layers.observations?.visible && !hidden.has("observations") && ob.frames.length) {
    const src = ob.catalog?.sources.find((x) => x.id === ob.source);
    const prod = ob.catalog?.products.find((x) => x.id === ob.field);
    const f = ob.frames[Math.max(0, Math.min(ob.index, ob.frames.length - 1))];
    if (/mrms/i.test(ob.source)) {
      lines.push(`MRMS mosaic · ${prod?.label ?? ob.field}${radarShown && f ? ` · ${shortLocal(f.unix)}` : ""}`);
    } else {
      const parts = [src?.label ?? ob.source, prod?.label ?? ob.field];
      if (f?.fh != null) parts.push(fhText(f));
      if (f?.run) parts.push(`${f.run.slice(8, 10)}Z run`);
      if (radarShown && f) parts.push(`valid ${shortLocal(f.unix)}`);
      lines.push(parts.join(" · "));
    }
    if (unix == null && f) unix = f.unix;
  }

  // The satellite.
  const sat = useSatStore.getState();
  if (app.layers.satellite?.visible && sat.frames.length) {
    const s = selectSatSatellite(sat);
    const r = selectSatRegion(sat);
    const p = selectSatProduct(sat);
    lines.push(`${[s?.label ?? sat.sat, r?.label].filter(Boolean).join(" ")} · ${p?.label ?? sat.product}`);
    const f = sat.frames[sat.index];
    if (unix == null && f) unix = f.unix;
  }

  // Outlooks.
  for (const [lid, st] of Object.entries(app.layers)) {
    if (!st.visible || hidden.has(lid)) continue;
    const mod = getLayerModule(lid);
    if (mod?.category === "outlooks") lines.push(mod.name);
  }

  // The storm picked on the map (its popup open).
  if (radarShown && nx.showTracks && nx.selectedCellId && !hidden.has("storms")) {
    const c = nx.storms?.cells.find((x) => x.id === nx.selectedCellId);
    if (c) {
      const parts = [`Storm ${c.id}`];
      if (c.headingCompass && c.speedKt != null) parts.push(`moving ${c.headingCompass} at ${Math.round(c.speedKt)} kt`);
      if (c.maxHailSizeIn) parts.push(`hail up to ${c.maxHailSizeIn.toFixed(2)} in`);
      lines.push(parts.join(" · "));
    }
  }
  return { lines, unix, scale };
}

// ---------------------------------------------------------------- drawing ---

const SANS = "'Recursive Variable', system-ui, 'Segoe UI', sans-serif";
const MONO = "ui-monospace, Consolas, monospace";
const DIVIDER = "#0e1013";
const VIEW_BG = "#16181c";

function fitInto(ctx: CanvasRenderingContext2D, img: CanvasImageSource, iw: number, ih: number, x: number, y: number, w: number, h: number) {
  if (iw < 1 || ih < 1) return;
  const s = Math.min(w / iw, h / ih);
  const dw = iw * s;
  const dh = ih * s;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function asCanvas(img: ImageData | HTMLCanvasElement): HTMLCanvasElement {
  if (img instanceof HTMLCanvasElement) return img;
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d")?.putImageData(img, 0, 0);
  return c;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

/** A pane's caption block, top-left, in CSS px scaled by k. */
function paintCaption(ctx: CanvasRenderingContext2D, cap: Caption, x: number, y: number, w: number, k: number): void {
  const rows: { text: string; font: string; color: string; lh: number }[] = [];
  cap.lines.forEach((t, i) =>
    rows.push(
      i === 0
        ? { text: t, font: `650 13px ${SANS}`, color: "#f2f4f7", lh: 17 }
        : { text: t, font: `500 11.5px ${SANS}`, color: "rgba(236,238,242,0.86)", lh: 15 },
    ),
  );
  if (cap.unix != null) rows.push({ text: localStamp(cap.unix), font: `500 11px ${MONO}`, color: "rgba(236,238,242,0.74)", lh: 15 });
  if (!rows.length) return;

  const inset = 10;
  const pad = 8;
  const maxText = Math.max(60, Math.min(w / k - inset * 2, 480) - pad * 2);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  let textW = 0;
  for (const r of rows) {
    ctx.font = r.font;
    r.text = ellipsize(ctx, r.text, maxText);
    textW = Math.max(textW, ctx.measureText(r.text).width);
  }
  const scaleH = cap.scale ? 6 + 4 + 11 : 0;
  if (cap.scale) textW = Math.max(textW, Math.min(maxText, 200));
  const boxW = Math.ceil(textW + pad * 2);
  const boxH = Math.ceil(pad + rows.reduce((n, r) => n + r.lh, 0) + scaleH + pad - 3);
  ctx.fillStyle = "rgba(16,18,22,0.80)";
  ctx.fillRect(inset, inset, boxW, boxH);
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 1;
  ctx.strokeRect(inset + 0.5, inset + 0.5, boxW - 1, boxH - 1);
  ctx.textBaseline = "alphabetic";
  let cy = inset + pad;
  for (const r of rows) {
    ctx.font = r.font;
    ctx.fillStyle = r.color;
    ctx.fillText(r.text, inset + pad, cy + r.lh - 4);
    cy += r.lh;
  }
  if (cap.scale) paintScale(ctx, cap.scale.table, inset + pad, cy + 4, boxW - pad * 2, 6, cap.scale.kind);
  ctx.restore();
}

let logoP: Promise<HTMLImageElement | null> | null = null;
/** The app's logo, if it can go on a canvas that is read back (a file:// page
 *  could taint it: then the name alone). */
function loadLogo(): Promise<HTMLImageElement | null> {
  if (!logoP) {
    logoP = new Promise((done) => {
      const im = new Image();
      im.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = 2;
          c.height = 2;
          const x = c.getContext("2d")!;
          x.drawImage(im, 0, 0, 2, 2);
          x.getImageData(0, 0, 1, 1);
          done(im);
        } catch {
          done(null);
        }
      };
      im.onerror = () => done(null);
      im.src = "./logo.png";
    });
  }
  return logoP;
}

/** The logo, the name and the basemap's credit, once, bottom-right. */
function paintLogo(ctx: CanvasRenderingContext2D, W: number, H: number, k: number, logo: HTMLImageElement | null): void {
  const credit = (basemapInfo(useAppStore.getState().basemapId).attribution || "").replace(/<[^>]*>/g, "").trim();
  ctx.save();
  ctx.scale(k, k);
  const w = W / k;
  const h = H / k;
  const size = 22;
  const pad = 6;
  ctx.font = `700 14px ${SANS}`;
  const nameW = ctx.measureText("Weather").width + ctx.measureText("TS").width;
  ctx.font = `500 9.5px ${SANS}`;
  const creditW = credit ? ctx.measureText(credit).width : 0;
  const logoW = logo ? (size * logo.naturalWidth) / Math.max(1, logo.naturalHeight) : 0;
  const boxW = Math.ceil(pad + (logo ? logoW + 6 : 0) + Math.max(nameW, creditW) + pad);
  const boxH = credit ? size + pad * 2 + 10 : size + pad * 2;
  const bx = w - boxW - 10;
  const by = h - boxH - 10;
  ctx.fillStyle = "rgba(16,18,22,0.74)";
  ctx.fillRect(bx, by, boxW, boxH);
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 1;
  ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1);
  let tx = bx + pad;
  if (logo) {
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(logo, tx, by + pad, logoW, size);
    tx += logoW + 6;
  }
  ctx.textBaseline = "alphabetic";
  ctx.font = `700 14px ${SANS}`;
  const base = by + pad + 16;
  ctx.fillStyle = "#f2f4f7";
  ctx.fillText("Weather", tx, base);
  ctx.fillStyle = "#6c9dff";
  ctx.fillText("TS", tx + ctx.measureText("Weather").width, base);
  if (credit) {
    ctx.font = `500 9.5px ${SANS}`;
    ctx.fillStyle = "rgba(236,238,242,0.62)";
    ctx.fillText(credit, tx, by + boxH - pad);
  }
  ctx.restore();
}

/** Draw everything the layout holds onto `out`, at k output px per CSS px.
 *  Returns the time the first pane shows (for the file name). */
function compose(out: HTMLCanvasElement, L: ExportLayout, k: number, caption: boolean, logo: HTMLImageElement | null): number | null {
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable.");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = DIVIDER;
  ctx.fillRect(0, 0, out.width, out.height);
  // Captions and the logo keep a readable size in a small GIF.
  const kc = Math.max(k, 0.8);
  const analysis = usePaneStore.getState().analysis;
  let firstUnix: number | null = null;
  for (const p of L.panes) {
    const x = (p.x - L.left) * k;
    const y = (p.y - L.top) * k;
    const w = p.w * k;
    const h = p.h * k;
    const view = analysis[p.id];
    let shot: ViewShot | null = null;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = VIEW_BG;
    ctx.fillRect(x, y, w, h);
    if (view === "r3d") {
      // Rendered at the size it takes in the export, the view's own shape.
      const cv = p.el.querySelector<HTMLCanvasElement>(".r3d__canvas");
      const aspect = cv && cv.clientWidth > 0 && cv.clientHeight > 0 ? cv.clientWidth / cv.clientHeight : w / h;
      const dh = Math.min(h, w / aspect);
      shot = captureExportView("r3d", dh * aspect, dh);
      if (shot) {
        const c = asCanvas(shot.image);
        fitInto(ctx, c, c.width, c.height, x, y, w, h);
      }
    } else if (view === "xsect") {
      const cv = p.el.querySelector<HTMLCanvasElement>(".xsect__canvas");
      if (cv && cv.width > 1 && cv.height > 1) fitInto(ctx, cv, cv.width, cv.height, x, y, w, h);
    } else {
      const src = getMapById(p.id)?.getCanvas();
      if (src) {
        const r = src.getBoundingClientRect();
        ctx.drawImage(src, 0, 0, src.width, src.height, (r.left - L.left) * k, (r.top - L.top) * k, r.width * k, r.height * k);
      }
    }
    ctx.restore();
    const cap = paneCaption(p.id, view, shot);
    if (firstUnix == null) firstUnix = cap.unix;
    if (caption) paintCaption(ctx, cap, x, y, w, kc);
  }
  // Thin dividers where tiled panes meet; a hairline round a floating window.
  const lw = Math.max(2, Math.round(1.5 * k));
  ctx.fillStyle = DIVIDER;
  for (const p of L.panes) {
    const x = (p.x - L.left) * k;
    const y = (p.y - L.top) * k;
    const w = p.w * k;
    const h = p.h * k;
    if (p.floating) {
      ctx.strokeStyle = "rgba(236,238,242,0.55)";
      ctx.lineWidth = Math.max(1, Math.round(k));
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      continue;
    }
    if (p.x - L.left > 1) ctx.fillRect(Math.round(x - lw / 2), Math.round(y), lw, Math.round(h));
    if (p.y - L.top > 1) ctx.fillRect(Math.round(x), Math.round(y - lw / 2), Math.round(w), lw);
  }
  paintLogo(ctx, out.width, out.height, kc, logo);
  return firstUnix;
}

function canvasOf(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** Every map of the layout drawn with what its frame needs. */
async function settleAll(L: ExportLayout, images: string[] = []): Promise<void> {
  const analysis = usePaneStore.getState().analysis;
  const maps = L.panes
    .filter((p) => !analysis[p.id])
    .map((p) => getMapById(p.id))
    .filter((m): m is MapLibreMap => !!m);
  await Promise.all(maps.map((m) => settled(m, images)));
}

// ------------------------------------------------------------- file names ---

/** "2013-05-20T20-16-43" (UTC). */
function stampOf(unix: number | null): string {
  const d = unix != null ? new Date(unix * 1000) : new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}-${pad2(d.getUTCMinutes())}-${pad2(d.getUTCSeconds())}`;
}

const slug = (x: string) => x.replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "");

/** weatherts-KTLX-REF-<time>.png, weatherts-4-panes-KTLX-<time>.gif ... */
function fileName(L: ExportLayout, ext: string, unix: number | null): string {
  const app = useAppStore.getState();
  const nx = useNexradStore.getState();
  const radarOn = !!app.layers.nexrad?.visible;
  const parts = ["weatherts"];
  if (L.panes.length > 1) {
    parts.push(`${L.panes.length}-panes`);
    if (radarOn && nx.site) parts.push(icaoOf(nx.site));
  } else {
    const id = L.panes[0].id;
    const view = usePaneStore.getState().analysis[id];
    const pane = nx.paneRadar[id];
    if (view) parts.push(view === "r3d" ? "3D" : "xsect");
    if (radarOn && pane && !pane.empty) {
      parts.push(icaoOf(pane.site || pane.scan?.meta.site || nx.site));
      if (!view) {
        const fam = famOf(pane.family);
        parts.push(slug(fam?.short ?? pane.family));
      }
    }
    const ob = useObsStore.getState();
    if (!view && app.layers.observations?.visible && ob.frames.length) {
      const src = ob.catalog?.sources.find((x) => x.id === ob.source);
      parts.push(slug(src?.label ?? ob.source), slug(ob.field));
    }
    if (!view && app.layers.satellite?.visible && useSatStore.getState().frames.length) {
      parts.push(slug(selectSatSatellite(useSatStore.getState())?.label ?? "satellite"));
    }
    if (parts.length === 1) parts.push("map");
  }
  return `${parts.filter(Boolean).join("-")}-${stampOf(unix)}.${ext}`;
}

// ------------------------------------------------------------ loop frames ---

type Subject = "radar" | "models" | "satellite";

/** What the timeline loops now: what drives it, else the radar, a model or the satellite. */
export function loopSubject(): { subject: Subject; frames: number } | null {
  const app = useAppStore.getState();
  const nx = useNexradStore.getState();
  const ob = useObsStore.getState();
  const sat = useSatStore.getState();
  const radar = !!app.layers.nexrad?.visible && nx.scans.length > 0;
  const src = ob.catalog?.sources.find((x) => x.id === ob.source);
  const models = !!app.layers.observations?.visible && ob.frames.length > 0 && ob.view !== "models" && !src?.tracks;
  const satOk = !!app.layers.satellite?.visible && sat.frames.length > 0;
  const driver = useTimelineStore.getState().driver;
  if (driver === "obs" && models) return { subject: "models", frames: ob.frames.length };
  if (driver === "sat" && satOk) return { subject: "satellite", frames: sat.frames.length };
  if (radar) return { subject: "radar", frames: nx.scans.length };
  if (models) return { subject: "models", frames: ob.frames.length };
  if (satOk) return { subject: "satellite", frames: sat.frames.length };
  return null;
}

/** Milliseconds a frame is held: the loop's own speed, or the frame rate set. */
export function frameDelayMs(subject: Subject): number {
  const st = useExportStore.getState();
  if (st.speed === "fps") return Math.round(1000 / st.fps);
  const speed = useTimelineStore.getState().speed || 1;
  const key = subject === "models" ? "timeline.obsMs" : subject === "satellite" ? "timeline.satMs" : "timeline.radarMs";
  return Math.max(50, Math.round((Number(getSetting<number>(key)) || 700) / speed));
}

/** The last frame stays up this much longer, so the loop does not snap back. */
const LAST_HOLD_MS = 1000;
const SAT_FRAME_TIMEOUT_MS = 120_000;
const SAT_SHARP_WAIT_MS = 30_000;

interface Stepper {
  total: number;
  /** Put frame n on the maps; false = it could not be shown (left out). */
  show: (n: number) => Promise<boolean>;
  /** The frame's own time. */
  unix: (n: number) => number | null;
  images: string[];
  restore: () => Promise<void>;
}

function radarStepper(): Stepper {
  const s0 = useNexradStore.getState();
  const startKey = s0.scans[s0.index]?.key;
  const frames = s0.scans.map((f) => ({ key: f.key, time: f.time }));
  s0.prefetch(0);
  return {
    total: frames.length,
    images: [],
    unix: (n) => frames[n]?.time ?? null,
    show: async (n) => {
      // By key: a scan arriving mid-export shifts the list.
      const i = useNexradStore.getState().scans.findIndex((f) => f.key === frames[n].key);
      if (i < 0) return false;
      return useNexradStore.getState().showIndex(i);
    },
    restore: async () => {
      const s = useNexradStore.getState();
      const i = s.scans.findIndex((f) => f.key === startKey);
      if (i >= 0) await s.showIndex(i);
    },
  };
}

function modelStepper(map: MapLibreMap, cancel: GifCancel): Stepper {
  const s0 = useObsStore.getState();
  if (s0.playing) s0.stopLoop();
  const { source, field } = s0;
  const frames = s0.frames;
  const start = s0.index;
  const keys = frames.map((f) => f.key);
  prefetchObsLoop(source, field, keys).catch(() => {
    /* each is made as it is reached instead */
  });
  void obsPreload(map, source, field, [...new Set(keys)], () => cancel.cancelled);
  return {
    total: frames.length,
    images: OBS_IMAGE_SOURCES,
    unix: (n) => frames[n]?.unix ?? null,
    show: async (n) => {
      await modelFrame(map, n, `${source}|${field}|${frames[n].key}`, cancel);
      return true;
    },
    restore: async () => useObsStore.getState().setIndex(start),
  };
}

function satStepper(map: MapLibreMap, cancel: GifCancel): Stepper {
  const s0 = useSatStore.getState();
  if (s0.playing) s0.stopLoop();
  s0.armLoop();
  const times = s0.frames.map((f) => f.time);
  const unixes = s0.frames.map((f) => f.unix);
  const startTime = s0.frames[s0.index]?.time;
  return {
    total: times.length,
    images: [SAT_IMAGE_SOURCE],
    unix: (n) => unixes[n] ?? null,
    show: async (n) => {
      const i = useSatStore.getState().frames.findIndex((f) => f.time === times[n]);
      if (i < 0) return false;
      useSatStore.getState().setIndex(i);
      const t0 = Date.now();
      for (;;) {
        if (cancel.cancelled) throw new GifCancelled();
        const shown = satFrameOnScreen(map, times[n], Date.now() - t0 > SAT_SHARP_WAIT_MS);
        if (shown === "yes") return true;
        if (shown === "empty") return false;
        if (Date.now() - t0 > SAT_FRAME_TIMEOUT_MS) throw new Error("A satellite frame took too long to come.");
        await sleepAwake(40);
      }
    },
    restore: async () => {
      const i = useSatStore.getState().frames.findIndex((f) => f.time === startTime);
      if (i >= 0) useSatStore.getState().setIndex(i);
    },
  };
}

// ------------------------------------------------------------------ runs ---

export interface ExportOutput {
  blob: Blob;
  name: string;
  w: number;
  h: number;
  frames: number;
  failed: number;
  note?: string;
}

interface RunOptions {
  all: boolean;
  paneId: string;
  caption: boolean;
  size: ExportSize;
  onFrame: (done: number, total: number, phase: "capturing" | "encoding") => void;
  cancel: GifCancel;
}

/** One picture of the pane(s), at the screen's resolution. */
async function exportImage(o: RunOptions): Promise<ExportOutput> {
  const L = exportLayout(o.all, o.paneId);
  await settleAll(L);
  if (o.cancel.cancelled) throw new GifCancelled();
  const k = L.dpr;
  const out = canvasOf(Math.round(L.w * k), Math.round(L.h * k));
  const logo = await loadLogo();
  const unix = compose(out, L, k, o.caption, logo);
  const blob = await new Promise<Blob | null>((done) => out.toBlob(done, "image/png"));
  if (!blob) throw new Error("The picture could not be made.");
  // Named by the loop's frame (the volume's time) when the radar is on, as the
  // GIF and the video are; else by what the first pane shows.
  const nx = useNexradStore.getState();
  const frameUnix = useAppStore.getState().layers.nexrad?.visible ? (nx.scans[nx.index]?.time ?? null) : null;
  return { blob, name: fileName(L, "png", frameUnix ?? unix), w: out.width, h: out.height, frames: 1, failed: 0 };
}

let forceWebm = false;

/** The whole loop as a GIF or a video, every frame composed like the image. */
async function exportLoop(kind: "gif" | "video", o: RunOptions): Promise<ExportOutput> {
  const what = loopSubject();
  if (!what) throw new Error("Nothing is looping yet: load a radar loop, a model or the satellite first.");
  const tl = useTimelineStore.getState();
  if (tl.playing) tl.stop();
  const L = exportLayout(o.all, o.paneId);
  const k = animScale(L, o.size);
  const W = even(Math.round(L.w * k));
  const H = even(Math.round(L.h * k));
  const delay = frameDelayMs(what.subject);
  const map = getMapById(o.paneId) ?? getMap();
  if (!map && what.subject !== "radar") throw new Error("No map to capture.");
  const step =
    what.subject === "radar" ? radarStepper() : what.subject === "models" ? modelStepper(map!, o.cancel) : satStepper(map!, o.cancel);
  if (step.total === 0) throw new Error("The loop has no frames yet.");

  let sink: FrameSink;
  let ext = "gif";
  if (kind === "gif") sink = createGifSink(W, H);
  else {
    const v = await createVideoSink(W, H, delay, forceWebm ? "webm" : "mp4");
    sink = v.sink;
    ext = v.ext;
  }
  const logo = await loadLogo();
  // Two canvases in turn: a frame goes to the encoder once the next one is in,
  // so the last one shown is the one held.
  const bufs = [canvasOf(W, H), canvasOf(W, H)];
  let held: HTMLCanvasElement | null = null;
  let heldUnix: number | null = null;
  let drawn = 0;
  let failed = 0;
  try {
    for (let n = 0; n < step.total; n++) {
      if (o.cancel.cancelled) throw new GifCancelled();
      o.onFrame(n + 1, step.total, "capturing");
      const ok = await step.show(n);
      if (o.cancel.cancelled) throw new GifCancelled();
      if (!ok) {
        failed++;
        continue;
      }
      await settleAll(L, step.images);
      if (o.cancel.cancelled) throw new GifCancelled();
      const cur = bufs[drawn % 2];
      compose(cur, L, k, o.caption, logo);
      if (held) await sink.add(held, delay);
      held = cur;
      heldUnix = step.unix(n);
      drawn++;
      await macroYield();
    }
    if (!held) throw new Error("None of the loop's frames could be loaded.");
    await sink.add(held, delay + LAST_HOLD_MS);
    o.onFrame(step.total, step.total, "encoding");
    const blob = await sink.finish();
    const notes: string[] = [];
    if (failed) notes.push(`${failed} frame${failed === 1 ? "" : "s"} could not be loaded and were left out`);
    if (kind === "video" && ext === "webm") notes.push("WebM: this browser has no MP4 encoder");
    return { blob, name: fileName(L, ext, heldUnix), w: W, h: H, frames: drawn, failed, note: notes.join(" · ") || undefined };
  } finally {
    await step.restore();
  }
}

// ----------------------------------------------------------------- saving ---

interface DesktopApi {
  keepRendering?: (on: boolean) => void;
  saveExport?: (name: string, bytes: Uint8Array) => Promise<string | null>;
  showInFolder?: (path: string) => Promise<boolean>;
}
const desktop = (): DesktopApi | undefined => (window as unknown as { electronAPI?: DesktopApi }).electronAPI;

/** The desktop app: a save dialog on the Downloads folder. The browser: a download. */
async function saveBlob(blob: Blob, name: string): Promise<{ saved: boolean; path: string | null }> {
  const api = desktop();
  if (api?.saveExport) {
    const path = await api.saveExport(name, new Uint8Array(await blob.arrayBuffer()));
    return { saved: !!path, path: path ?? null };
  }
  downloadBlob(blob, name);
  return { saved: true, path: null };
}

export function canShowInFolder(): boolean {
  return !!desktop()?.showInFolder;
}

export function showInFolder(path: string): void {
  void desktop()?.showInFolder?.(path);
}

let running: GifCancel | null = null;
let lastOut: (Omit<ExportOutput, "blob"> & { kind: ExportKind; bytes: number; ms: number; blob: Blob }) | null = null;

/** Run one export from the Export page's options; the store shows its progress. */
export async function runExport(kind: ExportKind): Promise<void> {
  const st = useExportStore.getState();
  if (st.job) return;
  const cancel: GifCancel = { cancelled: false };
  running = cancel;
  const t0 = performance.now();
  st.setJob({ kind, phase: "capturing", done: kind === "image" ? 1 : 0, total: 1 });
  const api = desktop();
  api?.keepRendering?.(true);
  const opts: RunOptions = {
    all: st.all && useAppStore.getState().paneCount > 1,
    paneId: getMapById(st.paneId) ? st.paneId : (getActivePaneId() ?? "pane-0"),
    caption: st.caption,
    size: st.size,
    cancel,
    onFrame: (done, total, phase) => useExportStore.getState().setJob({ kind, phase, done, total }),
  };
  try {
    const out = kind === "image" ? await exportImage(opts) : await exportLoop(kind, opts);
    lastOut = { ...out, kind, bytes: out.blob.size, ms: Math.round(performance.now() - t0) };
    useExportStore.getState().setJob({ kind, phase: "saving", done: out.frames, total: out.frames });
    const saved = await saveBlob(out.blob, out.name);
    if (!saved.saved) useExportStore.getState().finish(null, { kind, message: "Not saved." });
    else useExportStore.getState().finish({ kind, name: out.name, path: saved.path, note: out.note });
  } catch (e) {
    if (e instanceof GifCancelled) useExportStore.getState().finish(null, null);
    else useExportStore.getState().finish(null, { kind, message: e instanceof Error ? e.message : String(e) });
  } finally {
    running = null;
    api?.keepRendering?.(false);
  }
}

export function cancelExport(): void {
  if (running) running.cancelled = true;
}

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__exp = {
    run: runExport,
    cancel: cancelExport,
    layout: (all = true, paneId = "pane-0") => exportLayout(all, paneId),
    forceWebm: (on: boolean) => {
      forceWebm = on;
    },
    last: () => lastOut,
  };
}
