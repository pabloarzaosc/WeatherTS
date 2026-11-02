// Scan line (display-opts): a line sweeping round the radar, drawn over every
// pane showing that radar, on live radar only.
//
//   Settings > Radar > Scan line (radar.scanLine):
//     never   off
//     new     one turn as each new scan of the product on screen comes in, and
//             as each new tilt of a live Level II volume arrives
//     always  turning all the time, at the radar's pace
//
// The turn takes about as long as the radar takes to fly one tilt: the time
// between the live volume's cuts arriving when that has been seen, else its
// scan strategy's low tilt (VCP_TILT_S). Every pane on the same radar shares
// one clock, so they circle together. Increment marks every N km along the
// line. Sounds (radar.scanSound): when a sweep starts (each turn in "always"),
// or on every update -- each new scan and each new tilt (useRadarLiveStore).
//
// Drawn on a 2D canvas laid over each map (under the map's controls), with
// map.project per point, so it follows pan, zoom and the globe. Animation runs
// only while there is a sweep to draw.

import type { Map as MapLibreMap } from "maplibre-gl";

import { allMaps, paneIdOf } from "../map/mapInstance";
import { getSetting, useSettingsStore } from "../settings/useSettingsStore";
import { useAppStore } from "../store/useAppStore";
import { useNexradStore } from "../store/useNexradStore";
import { useRadarLiveStore } from "../store/useRadarLiveStore";
import { installSweepAudioUnlock, playSweepSound, type SweepSoundId } from "../lib/sweepSounds";

/** Seconds the radar takes for its lowest tilt, by VCP (approximate: the
 *  antenna rate of the low surveillance cut). Faster upper tilts are not
 *  modelled -- the line is a cue, not a position report. */
const VCP_TILT_S: Record<number, number> = {
  12: 17, 212: 17, 112: 17, 215: 20, 121: 18, 35: 36, 31: 72, 32: 73, 21: 30, 11: 18,
};
const DEFAULT_TILT_S = 20;

export function tiltSeconds(vcp: number | null | undefined): number {
  return (vcp != null && VCP_TILT_S[vcp]) || DEFAULT_TILT_S;
}

/** Seconds per tilt seen on a live Level II volume: the time between cuts
 *  arriving (useRadarLiveStore), newest last, per radar. */
const pace = new Map<string, { at: number; vol: number; cuts: number; secs: number[] }>();

function notePace(site: string, vol: number, cuts: number): void {
  const now = performance.now();
  const p = pace.get(site);
  if (p && p.vol === vol && cuts > p.cuts) {
    const per = (now - p.at) / 1000 / (cuts - p.cuts);
    // A gap from a hidden window or a stalled feed says nothing about the radar,
    // nor does a volume's first cut (it carries the volume's start-up).
    if (p.cuts > 0 && per >= 4 && per <= 90) p.secs = [...p.secs, per].slice(-6);
    p.at = now;
    p.cuts = cuts;
  } else pace.set(site, { at: now, vol, cuts, secs: p?.secs ?? [] });
}

/** How long one turn takes for this radar: what its live cuts show (median of
 *  the last few), else its scan strategy's low tilt. */
function turnSeconds(site: string): number {
  const s = pace.get(site)?.secs ?? [];
  if (s.length >= 2) {
    const m = [...s].sort((a, b) => a - b)[Math.floor((s.length - 1) / 2)];
    return Math.max(8, Math.min(80, m));
  }
  return tiltSeconds(vcpOf(site));
}

interface Sweep {
  /** performance.now() when this turn began (shared by every pane on the radar). */
  t0: number;
  /** ms for one turn. */
  dur: number;
  /** One turn only ("new" mode / a preview). */
  once: boolean;
  /** Drawn in archive too (the preview). */
  force: boolean;
}
const sweeps = new Map<string, Sweep>();

const isLive = () => {
  const s = useNexradStore.getState();
  return s.archiveTime === null && !s.archiveDate;
};
const mode = () => getSetting<string>("radar.scanLine");

function vcpOf(site: string): number | null {
  const s = useNexradStore.getState();
  if (s.site === site && s.scan?.meta.vcp != null) return s.scan.meta.vcp;
  for (const p of Object.values(s.paneRadar)) if ((p.site || s.site) === site && p.scan?.meta.vcp != null) return p.scan.meta.vcp;
  return null;
}

function sound(): void {
  const effect = getSetting<string>("radar.scanSoundEffect") as SweepSoundId;
  playSweepSound(effect === "tone" || effect === "tick" ? effect : "blip", Number(getSetting<number>("radar.scanSoundVolume")));
}

/** A new scan of `site` came in: start a turn (and its sound). */
export function startSweep(site: string, opts: { force?: boolean } = {}): void {
  const m = mode();
  if (m === "never" && !opts.force) return;
  const dur = turnSeconds(site) * 1000;
  // The same arrival seen twice (the new cut, then the frame it fills): one turn.
  const cur = sweeps.get(site);
  if (!opts.force && cur?.once && performance.now() - cur.t0 < 2000) return;
  if (m === "always" && !opts.force) {
    // Already turning: keep its phase, only make sure it exists.
    if (!sweeps.has(site)) sweeps.set(site, { t0: performance.now(), dur, once: false, force: false });
  } else {
    sweeps.set(site, { t0: performance.now(), dur, once: true, force: !!opts.force });
  }
  const snd = getSetting<string>("radar.scanSound");
  if (snd === "start" || snd === "update") sound();
  kick();
}

/** A new tilt of the live volume came in: "When a new scan arrives" turns the
 *  line once; "Always" keeps turning and only "Every update" sounds. */
function noteUpdate(site: string): void {
  const m = mode();
  if (m === "never") return;
  if (m === "new") {
    startSweep(site);
    return;
  }
  if (getSetting<string>("radar.scanSound") === "update") sound();
}

/** Show the scan line now on the radar on screen (settings preview). */
export function previewSweep(): boolean {
  const site = useNexradStore.getState().site;
  if (!site) return false;
  startSweep(site, { force: true });
  return true;
}

// ---------------------------------------------------------------------------
// Drawing

const canvases = new WeakMap<MapLibreMap, HTMLCanvasElement>();

function canvasFor(map: MapLibreMap): HTMLCanvasElement {
  let cv = canvases.get(map);
  if (cv && cv.isConnected) return cv;
  cv = document.createElement("canvas");
  cv.className = "radar-sweep";
  const host = map.getContainer();
  const controls = host.querySelector(".maplibregl-control-container");
  host.insertBefore(cv, controls);
  canvases.set(map, cv);
  return cv;
}

const KM_PER_DEG = 111.32;

function drawPane(map: MapLibreMap, now: number): boolean {
  const s = useNexradStore.getState();
  const id = paneIdOf(map);
  const pane = id ? s.paneRadar[id] : undefined;
  const site = (pane?.site || s.site) ?? null;
  const scan = pane?.scan ?? null;
  const sw = site ? sweeps.get(site) : undefined;
  const cv = canvases.get(map);
  const visible = !!useAppStore.getState().layers.nexrad?.visible;
  if (!sw || !scan || !visible || (!sw.force && !isLive())) {
    if (cv && cv.width) {
      cv.width = 0;
      cv.height = 0;
    }
    return false;
  }
  const c = canvasFor(map);
  const dpr = window.devicePixelRatio || 1;
  const w = map.getCanvas().clientWidth;
  const h = map.getCanvas().clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext("2d");
  if (!ctx) return false;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const frac = ((now - sw.t0) / sw.dur) % 1;
  const az = frac * 360;
  const { siteLat, siteLon } = scan.meta;
  const maxKm = Math.max(30, scan.meta.maxRangeKm || 230);
  const kmPerDegLon = KM_PER_DEG * Math.cos((siteLat * Math.PI) / 180);
  const at = (deg: number, km: number) => {
    const r = (deg * Math.PI) / 180;
    return map.project([siteLon + (km * Math.sin(r)) / kmPerDegLon, siteLat + (km * Math.cos(r)) / KM_PER_DEG]);
  };
  const line = (deg: number) => {
    ctx.beginPath();
    const step = 20;
    for (let km = 0; km <= maxKm + 0.1; km += step) {
      const p = at(deg, Math.min(km, maxKm));
      if (km === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    if (maxKm % step) {
      const p = at(deg, maxKm);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  };

  const color = getSetting<string>("radar.scanLineColor") || "#7fdcff";
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  // A short afterglow behind the line: fainter copies a degree or so apart.
  ctx.lineWidth = 1.5;
  for (let k = 6; k >= 1; k--) {
    ctx.globalAlpha = 0.28 * (1 - k / 7);
    line(az - k * 1.1);
  }
  ctx.globalAlpha = 1;
  ctx.lineWidth = 2;
  line(az);

  // Increment marks: a short tick across the line every N km.
  const every = Math.max(10, Math.min(50, Number(getSetting<number>("radar.scanMarksKm")) || 25));
  ctx.strokeStyle = getSetting<string>("radar.scanMarksColor") || "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  for (let km = every; km < maxKm; km += every) {
    const a = at(az, km - 1);
    const b = at(az, km + 1);
    const p = at(az, km);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const big = km % (every * 4) === 0 ? 6 : 4;
    const nx = (-dy / len) * big;
    const ny = (dx / len) * big;
    ctx.moveTo(p.x - nx, p.y - ny);
    ctx.lineTo(p.x + nx, p.y + ny);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  return true;
}

let raf = 0;
function frame(): void {
  raf = 0;
  const now = performance.now();
  // A finished single turn goes; "always" keeps a turn going on live radars.
  for (const [site, sw] of sweeps) if (sw.once && now - sw.t0 >= sw.dur) sweeps.delete(site);
  if (mode() === "always" && isLive()) {
    const site = useNexradStore.getState().site;
    if (site && !sweeps.has(site)) sweeps.set(site, { t0: now, dur: turnSeconds(site) * 1000, once: false, force: false });
  }
  // "Always": each new turn is a sweep start (its sound), and picks up the
  // pace the live cuts have shown since.
  for (const [site, sw] of sweeps) {
    if (sw.once || now - sw.t0 < sw.dur) continue;
    sw.t0 += Math.floor((now - sw.t0) / sw.dur) * sw.dur;
    sw.dur = turnSeconds(site) * 1000;
    if (getSetting<string>("radar.scanSound") === "start" && document.visibilityState === "visible") sound();
  }
  for (const [site, sw] of sweeps) if (!sw.once && (mode() !== "always" || !isLive())) sweeps.delete(site);
  let any = false;
  for (const map of allMaps()) any = drawPane(map, now) || any;
  if (sweeps.size && (any || [...sweeps.values()].some((x) => x.once))) raf = requestAnimationFrame(frame);
  else for (const map of allMaps()) drawPane(map, now); // clears
}

function kick(): void {
  if (!raf) raf = requestAnimationFrame(frame);
}

/** For a test: what is turning now. */
export function sweepState(): Record<string, { angle: number; dur: number; once: boolean }> {
  const now = performance.now();
  const out: Record<string, { angle: number; dur: number; once: boolean }> = {};
  for (const [site, sw] of sweeps) out[site] = { angle: Math.round((((now - sw.t0) / sw.dur) % 1) * 3600) / 10, dur: sw.dur, once: sw.once };
  return out;
}

// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __radarSweepOff?: () => void;
  }
}

/** Watch for new scans and settings. Installed once from main.tsx. */
export function installRadarSweep(): void {
  window.__radarSweepOff?.();
  installSweepAudioUnlock();
  const newest = (scans: { key: string; time: number }[]) => scans[scans.length - 1];
  const offRadar = useNexradStore.subscribe((s, p) => {
    // "Always": a radar to turn over (picked, back to live, a pane redrawn).
    if (!raf && mode() === "always" && s.scan !== p.scan) kick();
    if (!s.site || s.site !== p.site || s.product !== p.product || !isLive()) return;
    // A new scan at the end of the loop.
    const a = newest(s.scans);
    const b = newest(p.scans);
    if (s.scans !== p.scans && a && b && a.key !== b.key && a.time >= b.time) {
      startSweep(s.site);
      return;
    }
    // The in-progress volume reached the tilt on screen: it is drawn now.
    if (s.scan !== p.scan && s.scan && p.scan && s.index === s.scans.length - 1 && p.scan.meta.pendingNote && !s.scan.meta.pendingNote) {
      startSweep(s.site);
    }
  });
  const offLive = useRadarLiveStore.subscribe((s, p) => {
    const a = s.status;
    const b = p.status;
    if (!a || !b || a.site !== b.site || !isLive()) return;
    // The live store names the radar by ICAO (KTLX), the radar store by id (TLX).
    const site = useNexradStore.getState().site;
    if (!site || !a.site.endsWith(site)) return;
    if (a.vol !== b.vol || a.cutsDone !== b.cutsDone) notePace(site, a.vol, a.cutsDone);
    if (a.vol !== b.vol || a.cutsDone > b.cutsDone) noteUpdate(site);
  });
  const offSettings = useSettingsStore.subscribe((s, p) => {
    if (s.values["radar.scanLine"] !== p.values["radar.scanLine"]) {
      if (mode() === "never") sweeps.clear();
      kick();
    }
  });
  const offApp = useAppStore.subscribe((s, p) => s.layers !== p.layers && kick());
  kick();
  window.__radarSweepOff = () => {
    offRadar();
    offLive();
    offSettings();
    offApp();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    sweeps.clear();
  };
}
