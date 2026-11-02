import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Columns2, Download, Film, Lasso, Loader2, Maximize2, Minimize2, RotateCcw, Scan, ScissorsLineDashed, Square, X } from "lucide-react";

import { buildLut, parsePal } from "../lib/pal";
import { downloadBlob } from "../lib/gifExport";
import { useElementSize } from "../lib/useElementSize";
import { eyeOf, presetCamera, type CameraPreset, type OrbitCamera } from "../lib/radar3d/camera";
import { captionCanvas, exportLoopGif, type LoopFrame } from "../lib/radar3d/export3d";
import { registerExportView } from "../lib/exportViews";
import { fromGridKm, maskVolume, siteSpot, toGridKm, type LngLat } from "../lib/radar3d/selection";
import { buildLut3D, OPACITY_PRESETS } from "../lib/radar3d/lut";
import { ACCUM_FRAMES, Radar3DRenderer, type CutParams, type FlashLight, type RenderParams } from "../lib/radar3d/renderer";
import { composeGround, GROUND_MODES, GROUND_SPAN, groundAlerts, groundBase, groundGeo, type GroundBase, type GroundExtent } from "../lib/radar3d/ground";
import { useAppStore } from "../store/useAppStore";
import { selectVisibleAlerts, useAlertStore } from "../store/useAlertStore";
import { useXsectStore } from "../store/useXsectStore";
import { lineInBox, lutCurve, planeOfLine, Radar3DColorBar, Radar3DCutBar } from "./Radar3DExtras";
import { lightingFor, sunPosition } from "../lib/radar3d/sun";
import { useDock } from "../lib/radar3d/dock";
import { VOLUME3D_MOMENTS, type Volume3D, type Volume3DHeader } from "../lib/radar3d/volume";
import { isTdwrId, useNexradStore } from "../store/useNexradStore";
import { TDWR_VOLUME_NOTE } from "../lib/nexrad";
import { useRadar3DStore, type CamFoot } from "../store/useRadar3DStore";
import { useTimelineStore } from "../store/useTimelineStore";
import { takeWholeView } from "./Radar3DBoxTool";
import { AnalysisPlaceButton, useInPane } from "./PaneWindows";

const MOTION_SOURCE: Record<string, string> = { track: "echo tracking", sti: "NWS storm tracks", manual: "manual" };

const FOV = 50;
const V_SCALES = [1, 2, 3, 5];

function stamp(unix: number): string {
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

function hm(unix: number): string {
  const d = new Date(unix * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}Z`;
}

let probe: CanvasRenderingContext2D | null = null;
/** A theme colour (CSS variable) as 0-1 RGB. */
function cssRgb(name: string, fallback: string): [number, number, number] {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  probe ??= document.createElement("canvas").getContext("2d");
  if (!probe) return [0.1, 0.1, 0.1];
  probe.fillStyle = fallback;
  probe.fillStyle = raw;
  const s = String(probe.fillStyle);
  if (s.startsWith("#")) {
    const n = parseInt(s.slice(1, 7), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const m = s.match(/[\d.]+/g);
  return m ? [Number(m[0]) / 255, Number(m[1]) / 255, Number(m[2]) / 255] : [0.1, 0.1, 0.1];
}

interface Theme3D {
  bg: [number, number, number];
  ground: [number, number, number];
  grid: [number, number, number];
  line: [number, number, number, number];
}

function readTheme(): Theme3D {
  const bg = cssRgb("--panel-solid", "#14171c");
  const text = cssRgb("--text-dim", "#9aa4b2");
  const light = bg[0] + bg[1] + bg[2] > 1.5;
  const ground: [number, number, number] = light
    ? [bg[0] * 0.93, bg[1] * 0.93, bg[2] * 0.94]
    : [bg[0] * 0.85 + 0.035, bg[1] * 0.85 + 0.035, bg[2] * 0.85 + 0.04];
  return { bg, ground, grid: text, line: [text[0], text[1], text[2], 0.5] };
}

/** Flashes alight at this instant of the replay: the whole lightning window
 *  plays every `period` seconds, each flash a brief bright point. */
function activeFlashes(v: Volume3D, nowMs: number, period: number): FlashLight[] {
  const fl = v.flashes;
  if (!fl.length) return [];
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const f of fl) {
    if (f.t < t0) t0 = f.t;
    if (f.t > t1) t1 = f.t;
  }
  const span = Math.max(1, t1 - t0);
  const phase = ((nowMs / 1000) % period) / period;
  const tNow = t0 + phase * span;
  const life = (0.3 / period) * span; // 0.3 s of screen time
  const out: FlashLight[] = [];
  for (const f of fl) {
    const age = tNow - f.t;
    if (age < 0 || age > life) continue;
    const z = f.top > 0 ? Math.min(14, Math.max(2.5, f.top * 0.6)) : 6;
    const e = Math.min(1, Math.log10(1 + Math.max(0, f.energy)) / 3);
    out.push({ x: f.x, y: f.y, z, intensity: (0.55 + 0.45 * e) * Math.exp(-age / (life * 0.35)) });
  }
  out.sort((a, b) => b.intensity - a.intensity);
  return out.slice(0, 8);
}

/** The camera seen from above: where it stands, and its view cone over the
 *  ground as far as a little past what it looks at. */
function footprint(c: OrbitCamera, h: Volume3DHeader, aspect: number): CamFoot {
  const eye = eyeOf(c);
  const hfov = 2 * Math.atan(Math.tan((c.fovDeg * Math.PI) / 360) * Math.max(0.3, aspect));
  const span = Math.max(h.halfXKm, h.halfYKm);
  const horiz = Math.hypot(c.target[0] - eye[0], c.target[1] - eye[1]);
  const reach = Math.min(span * 2.2, Math.max(span * 0.45, horiz * 1.6, 12));
  const yaw = (c.yaw * Math.PI) / 180;
  const at = (x: number, y: number) => fromGridKm(h.centerLat, h.centerLon, x, y);
  const cone: LngLat[] = [at(eye[0], eye[1])];
  for (let k = 0; k <= 8; k++) {
    const a = yaw - hfov / 2 + (hfov * k) / 8;
    cone.push(at(eye[0] + reach * Math.sin(a), eye[1] + reach * Math.cos(a)));
  }
  return { eye: cone[0], cone, yaw: c.yaw };
}

/** The radar loop's frames as the 3D view asks for them (newest live = newest whole volume). */
function loopFrames(max = 36): LoopFrame[] {
  const s = useNexradStore.getState();
  const live = s.archiveTime === null && s.archiveDate === null;
  const out: LoopFrame[] = [];
  const seen = new Set<number>();
  s.scans.forEach((scan, i) => {
    if (seen.has(scan.time)) return;
    seen.add(scan.time);
    const newest = live && i === s.scans.length - 1;
    out.push({ at: newest ? null : scan.time, key: !newest && scan.key?.startsWith("L2") ? scan.key : "" });
  });
  return out.slice(-max);
}

function clampEye(c: OrbitCamera): OrbitCamera {
  const minSin = (0.05 - c.target[2]) / c.distance;
  const minPitch = (Math.asin(Math.max(-1, Math.min(1, minSin))) * 180) / Math.PI;
  return { ...c, pitch: Math.min(89, Math.max(c.pitch, minPitch, -60)) };
}

/** The 3D view, full screen like the cross-section: the radar volume ray
 *  marched as a sunlit storm or in the radar's own colours. */
export function Radar3DPanel() {
  const st = useRadar3DStore();
  // The view can be open when the radar moves to an airport radar: it says why it stops.
  const tdwrSite = isTdwrId(st.site);
  const data = st.data;
  const h = data?.header ?? null;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [plotRef, size] = useElementSize<HTMLDivElement>();
  const expanded = st.expanded;
  const setExpanded = (f: (v: boolean) => boolean) => st.setExpanded(f(st.expanded));
  // Split panes: the view docks over the panes beside the focused one.
  // In a pane of its own (panes-compare) the view fits the pane: no docking.
  const inPane = useInPane();
  const docked = useDock();
  const dock = inPane ? { focus: docked.focus, view: null } : docked;
  const rootRef = useRef<HTMLDivElement>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const renderer = useRef<Radar3DRenderer | null>(null);
  // Quick Analysis: the velocity beside the reflectivity, on the same camera.
  const data2 = st.quick ? st.data2 : null;
  const h2 = data2?.header ?? null;
  const canvas2Ref = useRef<HTMLCanvasElement>(null);
  const [plot2Ref, size2] = useElementSize<HTMLDivElement>();
  const renderer2 = useRef<Radar3DRenderer | null>(null);
  const [gif, setGif] = useState<{ done: number; total: number } | null>(null);
  const [gifNote, setGifNote] = useState<string | null>(null);
  const gifRun = useRef<AbortController | null>(null);
  const cam = useRef<OrbitCamera | null>(null);
  const dirty = useRef(true);
  const params = useRef<RenderParams | null>(null);
  const [theme, setTheme] = useState<Theme3D>(() => readTheme());
  const [camPreset, setCamPreset] = useState<CameraPreset | null>("overview");
  const vsPrev = useRef(st.vScale);
  const playing = useTimelineStore((s) => s.playing);

  // The radar's own palette for the moment, custom tables included.
  const palText = useNexradStore((s) => (h ? s.resolvePal(h.kind) : null));
  const pal = useMemo(() => {
    if (!palText) return null;
    try {
      return buildLut(parsePal(palText));
    } catch {
      return null;
    }
  }, [palText]);
  const palText2 = useNexradStore((s) => (h2 ? s.resolvePal(h2.kind) : null));
  const pal2 = useMemo(() => {
    if (!palText2) return null;
    try {
      return buildLut(parsePal(palText2));
    } catch {
      return null;
    }
  }, [palText2]);

  // Theme switches recolour the "Radar" style's ground and lines.
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setTheme(readTheme());
      dirty.current = true;
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onMq = () => setTheme(readTheme());
    mq.addEventListener("change", onMq);
    return () => {
      obs.disconnect();
      mq.removeEventListener("change", onMq);
    };
  }, []);

  // The renderer lives as long as the canvas.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    try {
      renderer.current = new Radar3DRenderer(c);
    } catch (err) {
      setGlError(err instanceof Error ? err.message : String(err));
    }
    return () => {
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, []);

  // The second view's renderer lives while Quick Analysis is on.
  useEffect(() => {
    if (!st.quick) return;
    const c = canvas2Ref.current;
    if (!c) return;
    try {
      renderer2.current = new Radar3DRenderer(c);
    } catch (err) {
      setGlError(err instanceof Error ? err.message : String(err));
    }
    dirty.current = true;
    return () => {
      renderer2.current?.dispose();
      renderer2.current = null;
    };
  }, [st.quick]);
  useEffect(() => {
    const r = renderer2.current;
    if (!r) return;
    if (!data2) r.clear(readTheme().bg);
    else r.setVolume(data2);
    dirty.current = true;
  }, [data2, st.quick]);
  useEffect(() => {
    const r = renderer2.current;
    if (!r || !h2) return;
    r.setLut(buildLut3D(h2, pal2, lutCurve(h2, st.curve, st.customCurves, st.savedCurves)));
    dirty.current = true;
  }, [h2, pal2, st.curve, st.customCurves, st.savedCurves, st.quick]);
  useEffect(() => {
    const c = canvas2Ref.current;
    if (!c || size2.w < 2 || size2.h < 2) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size2.w * dpr);
    c.height = Math.round(size2.h * dpr);
    c.style.width = `${size2.w}px`;
    c.style.height = `${size2.h}px`;
    dirty.current = true;
  }, [size2.w, size2.h, st.quick]);

  // Esc closes (a drawing on the map takes Esc first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !useRadar3DStore.getState().drawMode) useRadar3DStore.getState().close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A new volume: onto the GPU; a new box (or the first) resets the camera.
  const boxSig = h ? `${h.site}|${h.bbox.map((v) => v.toFixed(3)).join(",")}` : "";
  const lastBox = useRef("");
  const lastReset = useRef(-1);
  useEffect(() => {
    const r = renderer.current;
    if (!r) return;
    if (!data) {
      r.clear(readTheme().bg);
      return;
    }
    r.setVolume(data);
    if (boxSig !== lastBox.current || lastReset.current !== st.resetRev || !cam.current) {
      lastBox.current = boxSig;
      lastReset.current = st.resetRev;
      const sb = r.sceneBox(useRadar3DStore.getState().vScale);
      if (sb) cam.current = clampEye(presetCamera("overview", sb, FOV));
      setCamPreset("overview");
    }
    dirty.current = true;
  }, [data, boxSig, st.resetRev]);

  // The colour table for the "Radar" style (row 1 also colours the cut face).
  const lut = useMemo(
    () => (h ? buildLut3D(h, pal, lutCurve(h, st.curve, st.customCurves, st.savedCurves)) : null),
    [h, pal, st.curve, st.customCurves, st.savedCurves],
  );
  useEffect(() => {
    const r = renderer.current;
    if (!r || !lut) return;
    r.setLut(lut);
    dirty.current = true;
  }, [lut]);

  // The ground: the map (or satellite) picture four box widths across, with
  // the warnings in force and the radar's spot drawn on it.
  const basemapId = useAppStore((s) => s.basemapId);
  const alertFeatures = useAlertStore((s) => s.features);
  const alertTime = useAlertStore((s) => s.timeFilter);
  const alertCats = useAlertStore((s) => s.categoryFilters);
  const [ground, setGround] = useState<{ base: GroundBase; ext: GroundExtent } | null>(null);
  const gExt = h ? `${h.centerLat.toFixed(4)}|${h.centerLon.toFixed(4)}|${Math.max(h.halfXKm, h.halfYKm).toFixed(1)}` : "";
  useEffect(() => {
    if (!h || st.ground === "plain") {
      setGround(null);
      return;
    }
    let dead = false;
    const ext: GroundExtent = { clat: h.centerLat, clon: h.centerLon, halfKm: GROUND_SPAN * Math.max(h.halfXKm, h.halfYKm) };
    const size = Math.min(2048, renderer.current?.maxTexture() ?? 2048);
    void groundBase(st.ground, basemapId, ext, size).then((base) => {
      if (!dead) setGround(base ? { base, ext } : null);
    });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gExt, st.ground, basemapId]);
  useEffect(() => {
    const rs = [renderer.current, renderer2.current];
    if (!ground || !h) {
      for (const r of rs) r?.setGround(null, null);
      dirty.current = true;
      return;
    }
    const alerts = st.groundAlerts
      ? groundAlerts(selectVisibleAlerts({ features: alertFeatures, timeFilter: alertTime, categoryFilters: alertCats }), ground.base)
      : [];
    const img = composeGround(ground.base, alerts, { lon: h.siteLon, lat: h.siteLat, label: siteSpot(h.site)?.icao ?? h.site });
    const geo = { ...groundGeo(ground.ext, ground.base), halfKm: ground.ext.halfKm };
    for (const r of rs) r?.setGround(img, geo);
    dirty.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ground, alertFeatures, alertTime, alertCats, st.groundAlerts, st.quick, h?.site]);

  // The cut: from the sliders, or along the cross-section line on the map.
  const xa = useXsectStore((s) => s.a);
  const xb = useXsectStore((s) => s.b);
  const xLine = useMemo(() => {
    if (!h || !xa || !xb) return null;
    const a = toGridKm(h.centerLat, h.centerLon, xa[1], xa[0]);
    const b = toGridKm(h.centerLat, h.centerLon, xb[1], xb[0]);
    const seg = lineInBox(a, b, h.halfXKm, h.halfYKm);
    return seg ? planeOfLine(seg[0], seg[1]) : null;
  }, [h, xa, xb]);
  const cutReach = h ? Math.ceil(Math.hypot(h.halfXKm, h.halfYKm)) : 100;
  const cutShown = st.cut.follow && xLine ? { ...st.cut, dir: xLine.dir, pos: xLine.pos } : st.cut;
  const cutParams: CutParams | null = useMemo(() => {
    if (!st.cut.on) return null;
    const r = (cutShown.dir * Math.PI) / 180;
    return { nx: Math.cos(r), ny: -Math.sin(r), d: cutShown.pos, away: cutShown.away, opacity: cutShown.opacity };
  }, [st.cut.on, cutShown.dir, cutShown.pos, cutShown.away, cutShown.opacity]);

  // Vertical scale: keep looking at the same height of the storm.
  useEffect(() => {
    const c = cam.current;
    if (c && vsPrev.current !== st.vScale) {
      const k = st.vScale / vsPrev.current;
      cam.current = clampEye({ ...c, target: [c.target[0], c.target[1], c.target[2] * k] });
    }
    vsPrev.current = st.vScale;
    dirty.current = true;
  }, [st.vScale]);

  // The sun at the scan's time over the box, or where the sliders put it.
  // Before a volume loads, Scan time means the frame's time at the radar
  // (the newest live frame: now); with neither known, no numbers at all.
  const sun = useMemo(() => {
    if (st.sunMode === "manual") return { elevation: st.sunElev, azimuth: st.sunAz };
    if (h) return sunPosition(h.scanUnix, h.centerLat, h.centerLon);
    const spot = siteSpot(st.site);
    if (!spot) return null;
    return sunPosition(st.at ?? Date.now() / 1000, spot.lat, spot.lon);
  }, [st.sunMode, st.sunElev, st.sunAz, h, st.site, st.at]);
  const light = useMemo(() => lightingFor(sun ?? { elevation: st.sunElev, azimuth: st.sunAz }), [sun, st.sunElev, st.sunAz]);

  // Everything the shader needs, kept in a ref for the frame loop.
  useEffect(() => {
    params.current = {
      style: st.style,
      vScale: st.vScale,
      renderScale: st.renderScale,
      sharpen: 0.32,
      light,
      cloudEdge: st.cloudEdge,
      cloudBase: st.cloudBase,
      density: 2.4,
      exposure: 1.2,
      opacity: 0.9,
      cone: st.cone,
      flashes: [],
      shafts: st.shafts,
      showGround: st.ground !== "plain",
      cut: cutParams,
      bg: theme.bg,
      ground: theme.ground,
      grid: theme.grid,
      line: st.style === "storm" ? [1, 1, 1, 0.22] : theme.line,
    };
    radarLine.current = theme.line;
    dirty.current = true;
  }, [st.style, st.vScale, st.renderScale, st.cloudEdge, st.cloudBase, st.cone, st.shafts, st.ground, cutParams, light, theme]);

  // Canvas size follows its box, in device pixels.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || size.w < 2 || size.h < 2) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    c.style.width = `${size.w}px`;
    c.style.height = `${size.h}px`;
    dirty.current = true;
  }, [size.w, size.h]);

  // The frame loop: draws when something changed, while Present orbits, and
  // while lightning flickers.
  const frameMs = useRef(0);
  // Frames averaged so far with the camera still (the jitter melts away).
  const accum = useRef(0);
  const lastPub = useRef(0);
  const lastCam = useRef("");
  const radarLine = useRef<[number, number, number, number]>([0.6, 0.64, 0.7, 0.5]);
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const r = renderer.current;
      const p = params.current;
      const c = cam.current;
      const s = useRadar3DStore.getState();
      if (!r || !p || !c || !s.data) return;
      // The camera on the map, a few times a second while it moves.
      if (now - lastPub.current > 80) {
        const sig = `${c.yaw.toFixed(1)}|${c.pitch.toFixed(1)}|${c.distance.toFixed(2)}|${c.target.map((v) => v.toFixed(2)).join(",")}|${s.data.header.bbox.join(",")}`;
        if (sig !== lastCam.current && r.canvas.height > 0) {
          lastCam.current = sig;
          lastPub.current = now;
          s.setCam(footprint(c, s.data.header, r.canvas.width / r.canvas.height));
        }
      }
      let animate = false;
      let moving = false;
      if (s.present && useTimelineStore.getState().playing) {
        cam.current = { ...c, yaw: (c.yaw + dt * 5) % 360 };
        animate = true;
        moving = true;
      }
      let flashes: FlashLight[] = [];
      if (s.lightning && s.data.flashes.length) {
        flashes = activeFlashes(s.data, now, 12);
        animate = true;
      }
      // A change or a moving camera starts the average again; a still camera
      // adds jittered frames to it (flickering flashes keep a short memory).
      let frame = 0;
      let minWeight = 0;
      if (dirty.current || moving) frame = 0;
      else if (animate) {
        frame = accum.current + 1;
        minWeight = 0.3;
      } else if (accum.current < ACCUM_FRAMES - 1) frame = accum.current + 1;
      else return;
      dirty.current = false;
      const t0 = performance.now();
      accum.current = r.render(cam.current!, { ...p, flashes }, frame, minWeight);
      const r2 = renderer2.current;
      if (r2?.info && s.quick && s.data2) r2.render(cam.current!, { ...p, style: "radar", line: radarLine.current, flashes: [] }, frame, minWeight);
      if (frame === 0) frameMs.current = performance.now() - t0;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // A debugging handle for timing the renderer from the console.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>).__radar3d = {
      bench: (n = 20) => {
        const r = renderer.current;
        const p = params.current;
        if (!r || !p || !cam.current) return null;
        const ms = r.benchmark(cam.current, p, n);
        dirty.current = true;
        return ms;
      },
      camera: () => cam.current,
      params: () => params.current,
      accum: () => accum.current,
      setCamera: (c: OrbitCamera) => {
        cam.current = clampEye(c);
        dirty.current = true;
      },
      preset: (p: CameraPreset) => applyPreset(p),
      exportDataUrl: () => composeExport()?.toDataURL("image/png") ?? null,
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__radar3d;
    };
  });

  // The Export page (src/lib/viewExport.ts) captures a pane showing this view
  // as the view: its picture rendered now, at the canvas size, no caption strip.
  useEffect(() =>
    registerExportView("r3d", (ow, oh) => {
      const r = renderer.current;
      const p = params.current;
      const c = cam.current;
      const cv = canvasRef.current;
      if (!r?.info || !p || !c || !cv || !h || cv.width < 2 || cv.height < 2) return null;
      // At the size the export draws it (sharper than the on-screen render
      // scale), within the GPU's reach.
      const w = Math.max(2, Math.min(4096, Math.round(ow ?? cv.width)));
      const ht = Math.max(2, Math.min(4096, Math.round(oh ?? cv.height)));
      return {
        image: r.capture(c, { ...p, flashes: [] }, w, ht),
        lines: [`3D view · ${h.site} ${h.productLabel}`, st.style === "storm" ? "Storm look" : "Radar look"],
        unix: h.scanUnix,
      };
    }),
  );

  const applyPreset = (p: CameraPreset) => {
    const r = renderer.current;
    const sb = r?.sceneBox(useRadar3DStore.getState().vScale);
    if (!sb) return;
    cam.current = clampEye(presetCamera(p, sb, FOV));
    setCamPreset(p);
    dirty.current = true;
  };

  // Moving around: drag orbits, right-drag or shift-drag pans, wheel or pinch zooms.
  const drag = useRef<{ mode: "orbit" | "pan"; x: number; y: number } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.current.size === 2) {
      const [a, b] = [...touches.current.values()];
      pinch.current = Math.hypot(a.x - b.x, a.y - b.y);
      drag.current = null;
      return;
    }
    drag.current = { mode: e.button === 2 || e.button === 1 || e.shiftKey ? "pan" : "orbit", x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = cam.current;
    if (!c) return;
    if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.current.size === 2 && pinch.current) {
      const [a, b] = [...touches.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > 0) zoomBy(pinch.current / d);
      pinch.current = d;
      return;
    }
    const g = drag.current;
    if (!g) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    g.x = e.clientX;
    g.y = e.clientY;
    if (g.mode === "orbit") {
      cam.current = clampEye({ ...c, yaw: (c.yaw + dx * 0.3 + 360) % 360, pitch: c.pitch + dy * 0.25 });
    } else {
      const k = (c.distance * Math.tan((FOV * Math.PI) / 360) * 2) / Math.max(200, size.h);
      const y = (c.yaw * Math.PI) / 180;
      // Right and forward along the ground.
      const rx = Math.cos(y);
      const ry = -Math.sin(y);
      const fx = Math.sin(y);
      const fy = Math.cos(y);
      cam.current = clampEye({
        ...c,
        target: [c.target[0] - dx * k * rx + dy * k * fx, c.target[1] - dx * k * ry + dy * k * fy, c.target[2]],
      });
    }
    setCamPreset(null);
    dirty.current = true;
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    touches.current.delete(e.pointerId);
    if (touches.current.size < 2) pinch.current = null;
    drag.current = null;
  };
  const zoomBy = (k: number) => {
    const c = cam.current;
    const r = renderer.current;
    if (!c || !r?.info) return;
    const span = Math.max(r.info.hx, r.info.hy);
    cam.current = clampEye({ ...c, distance: Math.min(span * 12, Math.max(0.6, c.distance * k)) });
    setCamPreset(null);
    dirty.current = true;
  };
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    zoomBy(Math.exp(e.deltaY * 0.0012));
  };

  // Export: one full-scale frame with a caption strip (radar, product, time).
  const composeExport = (): HTMLCanvasElement | null => {
    const r = renderer.current;
    const p = params.current;
    const c = cam.current;
    if (!r || !p || !c || !h) return null;
    const w = canvasRef.current?.width ?? 1280;
    const ht = canvasRef.current?.height ?? 720;
    const img = r.capture(c, { ...p, flashes: [] }, w, ht);
    return captionCanvas(
      img,
      `${h.site} · ${h.productLabel} · 3D · ${st.style === "storm" ? "Storm" : "Radar"}`,
      `${stamp(h.scanUnix)} · WeatherTS`,
      window.devicePixelRatio || 1,
    );
  };

  // The loop in 3D: the camera held where it is, one picture per volume.
  const exportGif = async () => {
    if (gifRun.current) {
      gifRun.current.abort();
      return;
    }
    const s = useRadar3DStore.getState();
    const p = params.current;
    const c = cam.current;
    const cv = canvasRef.current;
    if (!h || !s.bbox || !s.site || !p || !c || !cv) return;
    const frames = loopFrames();
    if (!frames.length) return;
    const ctrl = new AbortController();
    gifRun.current = ctrl;
    setGifNote(null);
    setGif({ done: 0, total: frames.length });
    const k = Math.min(1, 960 / Math.max(cv.width, cv.height));
    const ring = s.sel?.kind === "area" ? s.sel.ring : null;
    const style = s.style;
    const curveOf = (vh: Volume3DHeader) => lutCurve(vh, s.curve, s.customCurves, s.savedCurves);
    const sunScan = s.sunMode === "scan";
    try {
      const out = await exportLoopGif({
        site: s.site,
        fam: s.fam,
        bbox: s.bbox,
        frames,
        fit: (v) => (ring ? maskVolume(v, ring) : v),
        cam: c,
        paramsFor: (v) => ({
          ...p,
          flashes: [],
          light: sunScan ? lightingFor(sunPosition(v.header.scanUnix, v.header.centerLat, v.header.centerLon)) : p.light,
        }),
        lutFor: (v) => buildLut3D(v.header, pal, curveOf(v.header)),
        width: Math.round(cv.width * k),
        height: Math.round(cv.height * k),
        caption: (v) => [
          `${v.header.site} · ${v.header.productLabel} · 3D · ${style === "storm" ? "Storm" : "Radar"}`,
          `${stamp(v.header.scanUnix)} · WeatherTS`,
        ],
        delayMs: 450,
        onProgress: (done, total) => setGif({ done, total }),
        signal: ctrl.signal,
      });
      const d = new Date(h.scanUnix * 1000);
      const p2 = (n: number) => String(n).padStart(2, "0");
      downloadBlob(out.blob, `${h.site}_3D_${h.kind.toUpperCase()}_loop_${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}_${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}.gif`);
      setGifNote(`GIF saved: ${out.frames} volume${out.frames === 1 ? "" : "s"}${out.failed ? `, ${out.failed} could not be read` : ""}`);
    } catch (err) {
      if (!ctrl.signal.aborted) setGifNote(err instanceof Error ? err.message : String(err));
    } finally {
      gifRun.current = null;
      setGif(null);
    }
  };
  useEffect(() => () => gifRun.current?.abort(), []);
  const exportImage = () => {
    const out = composeExport();
    if (!out || !h) return;
    out.toBlob((blob) => {
      if (!blob) return;
      const d = new Date(h.scanUnix * 1000);
      const p2 = (n: number) => String(n).padStart(2, "0");
      const name = `${h.site}_3D_${h.kind.toUpperCase()}_${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}_${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}.png`;
      downloadBlob(blob, name);
    }, "image/png");
  };

  const fillNote = (() => {
    const f = h?.fill;
    if (!st.fill || !f || f.mode === "none") return null;
    if (f.status === "filled") return `Filled from ${f.site}`;
    return f.reason ?? "No neighbouring radar to fill from.";
  })();
  const glmNote = !st.lightning || !h ? null : h.glm?.available ? `${data?.flashes.length ?? 0} GOES flashes` : h.glm?.reason ?? null;
  // Only worth a note when a real part of the box was not seen.
  const coneLeft = h ? h.cone.left / Math.max(1, h.nx * h.ny * h.nz) : 0;
  const sunText = !sun
    ? "Sun at the scan's time"
    : st.sunMode === "scan"
      ? sun.elevation < -6
        ? `Night · sun ${Math.abs(sun.elevation).toFixed(0)}° below the horizon · dim moonlight for display`
        : `${light.label} · sun ${sun.elevation.toFixed(0)}° high, ${sun.azimuth.toFixed(0)}°`
      : `Manual sun ${sun.elevation.toFixed(0)}° / ${sun.azimuth.toFixed(0)}°`;
  // SRV takes out the storm motion the map's SRV does (Settings > Radar > Velocity).
  const motionNote =
    h && h.kind === "srv" && h.motion
      ? h.motion[0] > 0
        ? `Storm motion ${h.motion[0].toFixed(0)} kt from ${((h.motion[1] + 180) % 360).toFixed(0)}°${h.motionSource ? ` (${MOTION_SOURCE[h.motionSource] ?? h.motionSource})` : ""}`
        : "No storm motion known: SRV is base velocity"
      : null;

  const host = (rootRef.current?.offsetParent as HTMLElement | null | undefined)?.getBoundingClientRect();
  const dockStyle =
    !expanded && dock.view
      ? {
          left: dock.view.left - (host?.left ?? 0) + 6,
          top: dock.view.top - (host?.top ?? 0) + 6,
          width: Math.max(240, dock.view.width - 12),
          height: Math.max(200, dock.view.height - 12),
          right: "auto",
          bottom: "auto",
        }
      : undefined;

  return (
    <div
      ref={rootRef}
      style={dockStyle}
      className={`sv r3d-screen${expanded && !inPane ? " is-expanded" : ""}${st.drawMode ? " is-mapping" : ""}${st.quick ? " is-quick" : ""}${dock.view ? " is-docked" : ""}`}
      role="dialog"
      aria-label="Radar 3D view"
    >
      <header className="sv__head">
        <div className="sv__title">
          <Box size={16} />
          <div>
            <strong>{st.quick ? "Quick analysis · reflectivity and velocity" : `3D view${h ? ` · ${h.productLabel}` : ""}`}</strong>
            <span>
              {h
                ? `${h.site} / ${hm(h.scanUnix)}${h.vcp ? ` / VCP ${h.vcp}` : ""} / ${(2 * h.halfXKm).toFixed(0)} × ${(2 * h.halfYKm).toFixed(0)} km / ${h.elevations.length} tilts`
                : st.sel
                  ? `${siteSpot(st.site)?.icao ?? st.site ?? ""} / reading the volume…`
                  : `${siteSpot(st.site)?.icao ?? st.site ?? ""} / nothing selected yet`}
            </span>
          </div>
        </div>
        <div className="sv__brand">{st.site?.toUpperCase().startsWith("BR-") ? "Radar volume" : "NEXRAD Level II"}</div>
        <div className="sv__headbtns">
          <AnalysisPlaceButton kind="r3d" />
          <button
            type="button"
            className={st.quick ? "is-on" : ""}
            onClick={() => st.setQuick(!st.quick)}
            title="Quick analysis: reflectivity and velocity side by side, one camera"
            aria-pressed={st.quick}
          >
            <Columns2 size={15} />
          </button>
          <button
            type="button"
            className={st.cut.on ? "is-on" : ""}
            onClick={() => st.setCut({ on: !st.cut.on })}
            disabled={!data}
            title="Cut: slice the volume along a vertical plane"
            aria-pressed={st.cut.on}
          >
            <ScissorsLineDashed size={15} />
          </button>
          <button type="button" onClick={exportImage} disabled={!data} title="Export image (PNG with a caption)">
            <Download size={15} />
          </button>
          <button
            type="button"
            className={gif ? "is-on" : ""}
            onClick={() => void exportGif()}
            disabled={!data && !gif}
            title={gif ? "Stop the GIF" : "Export the radar loop in 3D as a GIF (the camera held still)"}
          >
            {gif ? <X size={15} /> : <Film size={15} />}
          </button>
          {/* In a pane the pane's own Fullscreen (as a window) does this. */}
          {!inPane && (
            <button type="button" onClick={() => setExpanded((v) => !v)} title={expanded ? "Restore" : "Expand"}>
              {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
          )}
          <button type="button" onClick={() => useRadar3DStore.getState().close()} title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="sv__controls r3d__controls">
        <div className="sv__ctl" hidden={st.quick}>
          <span>PRODUCT</span>
          <div className="xsect__seg" role="group" aria-label="Moment">
            {VOLUME3D_MOMENTS.map((m) => (
              <button
                key={m.fam}
                type="button"
                className={st.fam === m.fam ? "is-on" : ""}
                onClick={() => st.setFam(m.fam)}
                title={m.label}
                aria-pressed={st.fam === m.fam}
              >
                {m.short}
              </button>
            ))}
          </div>
        </div>
        <div className="sv__ctl">
          <span>STYLE</span>
          <div className="xsect__seg" role="group" aria-label="Style">
            <button type="button" className={st.style === "storm" ? "is-on" : ""} onClick={() => st.setStyle("storm")} title="A sunlit cloud built from reflectivity">
              Storm
            </button>
            <button type="button" className={st.style === "radar" ? "is-on" : ""} onClick={() => st.setStyle("radar")} title="The product's own colours">
              Radar
            </button>
          </div>
        </div>
        {st.style === "radar" && (
          <div className="sv__ctl">
            <span>OPACITY</span>
            <div className="xsect__seg" role="group" aria-label="Opacity curve">
              {OPACITY_PRESETS.map((o) => (
                <button key={o.id} type="button" className={st.curve === o.id ? "is-on" : ""} onClick={() => st.setCurve(o.id)} title={o.hint}>
                  {o.label}
                </button>
              ))}
              {h && st.customCurves[h.kind] && (
                <button type="button" className={st.curve === "custom" ? "is-on" : ""} onClick={() => st.setCurve("custom")} title="The curve as you last edited it">
                  Custom
                </button>
              )}
              {h &&
                st.savedCurves
                  .filter((c) => c.kind === h.kind)
                  .map((c) => (
                    <button key={c.name} type="button" className={st.curve === `saved:${c.name}` ? "is-on" : ""} onClick={() => st.setCurve(`saved:${c.name}`)} title={`Saved curve "${c.name}"`}>
                      {c.name}
                    </button>
                  ))}
            </div>
          </div>
        )}
        <div className="sv__ctl">
          <span>CAMERA</span>
          <div className="xsect__seg" role="group" aria-label="Camera">
            {(["ground", "overview", "radar"] as CameraPreset[]).map((p) => (
              <button key={p} type="button" className={camPreset === p ? "is-on" : ""} onClick={() => applyPreset(p)} disabled={!data}>
                {p === "ground" ? "Ground" : p === "overview" ? "Overview" : "Radar"}
              </button>
            ))}
            <button
              type="button"
              className={st.present ? "is-on" : ""}
              onClick={() => st.setPresent(!st.present)}
              title="Circle the storm slowly while the radar loop plays"
              aria-pressed={st.present}
            >
              Present
            </button>
          </div>
        </div>
        <div className="sv__ctl">
          <span>VERTICAL</span>
          <div className="xsect__seg" role="group" aria-label="Vertical scale">
            {V_SCALES.map((v) => (
              <button key={v} type="button" className={st.vScale === v ? "is-on" : ""} onClick={() => st.setVScale(v)}>
                {v}×
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="sv__body r3d__body">
        <div className="r3d__views">
        <div className="r3d__view" ref={plotRef}>
          <canvas
            ref={canvasRef}
            className="r3d__canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
            onContextMenu={(e) => e.preventDefault()}
          />
          {st.quick && <div className="r3d__tag">Reflectivity</div>}
          {gif ? (
            <div className="r3d__pill" role="status">
              <Loader2 size={13} className="spin" />
              <span>
                Rendering the 3D loop · {gif.done}/{gif.total}
              </span>
              <i style={{ transform: `scaleX(${Math.max(0.04, gif.done / Math.max(1, gif.total))})` }} />
            </div>
          ) : (
            st.busy &&
            st.progress && (
              <div className="r3d__pill" role="status">
                <Loader2 size={13} className="spin" />
                <span>{st.progress.text}</span>
                <i style={{ transform: `scaleX(${Math.max(0.04, st.progress.frac)})` }} />
              </div>
            )
          )}
          {!st.sel && !glError && (
            <div className="r3d__state">
              <strong>{tdwrSite ? "No 3D on an airport radar" : "Draw a box"}</strong>
              <span>
                {tdwrSite ? TDWR_VOLUME_NOTE : st.notice ??
                  `Pick the part of ${siteSpot(st.site)?.icao ?? "the radar"}'s volume to see in 3D: drag a box on the map, trace an area around a storm, or take what the map shows.`}
              </span>
              {!tdwrSite && (
              <div className="r3d__btns">
                <button type="button" className={`r3d__btn${st.drawMode === "box" ? " is-on" : ""}`} onClick={() => st.setDrawMode("box")}>
                  <Square size={13} />
                  Draw a box
                </button>
                <button type="button" className={`r3d__btn${st.drawMode === "area" ? " is-on" : ""}`} onClick={() => st.setDrawMode("area")}>
                  <Lasso size={13} />
                  Trace an area
                </button>
                <button type="button" className="r3d__btn" onClick={() => takeWholeView()}>
                  <Scan size={13} />
                  Whole view
                </button>
              </div>
              )}
            </div>
          )}
          {st.sel && (glError || (st.error && !st.busy)) && (
            <div className="r3d__state">
              <strong>{glError ? "The 3D view cannot draw here" : "No 3D volume"}</strong>
              <span>{glError ?? st.error}</span>
              {!glError && (
                <button type="button" className="r3d__btn" onClick={() => st.retry()}>
                  <RotateCcw size={13} />
                  Try again
                </button>
              )}
            </div>
          )}
          {st.sel && !data && !st.error && !glError && (
            <div className="r3d__state r3d__state--quiet">
              <Loader2 size={22} className="spin" />
              <span>Every tilt of the volume is read the first time; another moment of it after that takes about a second.</span>
            </div>
          )}
          {data && (
            <div className="r3d__hint">
              Drag to orbit · right-drag or Shift-drag to pan · wheel to zoom
              {st.present && !playing ? " · Present circles while the loop plays" : ""}
            </div>
          )}
          {data && h && st.style === "radar" && <Radar3DColorBar h={h} lut={lut} />}
          {data && st.cut.on && (
            <Radar3DCutBar cut={cutShown} reach={cutReach} line={!!xLine} onClose={() => st.setCut({ on: false })} />
          )}
        </div>
        {st.quick && (
          <div className="r3d__view" ref={plot2Ref}>
            <canvas
              ref={canvas2Ref}
              className="r3d__canvas"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onWheel={onWheel}
              onContextMenu={(e) => e.preventDefault()}
            />
            <div className="r3d__tag">Velocity</div>
            {st.sel && !data2 && !st.error2 && st.busy && (
              <div className="r3d__state r3d__state--quiet">
                <Loader2 size={22} className="spin" />
                <span>Reading the same volume's velocity…</span>
              </div>
            )}
            {st.sel && st.error2 && !st.busy && (
              <div className="r3d__state">
                <strong>No velocity here</strong>
                <span>{st.error2}</span>
              </div>
            )}
          </div>
        )}
        </div>
        <div className="r3d__foot">
          <div className="sv__ctl">
            <span>SUN</span>
            <div className="xsect__seg" role="group" aria-label="Sun">
              <button type="button" className={st.sunMode === "scan" ? "is-on" : ""} onClick={() => st.setSunMode("scan")} title="Where the sun was at the scan's time over the box">
                Scan time
              </button>
              <button type="button" className={st.sunMode === "manual" ? "is-on" : ""} onClick={() => st.setSun(sun?.elevation ?? st.sunElev, sun?.azimuth ?? st.sunAz)}>
                Manual
              </button>
            </div>
          </div>
          {st.sunMode === "manual" && (
            <>
              <label className="r3d__slider">
                <span>Elevation {st.sunElev.toFixed(0)}°</span>
                <input type="range" min={-20} max={90} step={1} value={st.sunElev} onChange={(e) => st.setSun(Number(e.target.value), st.sunAz)} />
              </label>
              <label className="r3d__slider">
                <span>Azimuth {st.sunAz.toFixed(0)}°</span>
                <input type="range" min={0} max={359} step={1} value={st.sunAz} onChange={(e) => st.setSun(st.sunElev, Number(e.target.value))} />
              </label>
            </>
          )}
          {st.style === "storm" && (
            <>
              <label className="r3d__slider">
                <span>Cloud edge {st.cloudEdge} dBZ</span>
                <input type="range" min={0} max={35} step={1} value={st.cloudEdge} onChange={(e) => st.setCloudEdge(Number(e.target.value))} />
              </label>
              <label className="r3d__slider">
                <span>Cloud base {st.cloudBase.toFixed(1)} km</span>
                <input type="range" min={0.3} max={3.5} step={0.1} value={st.cloudBase} onChange={(e) => st.setCloudBase(Number(e.target.value))} />
              </label>
            </>
          )}
          <div className="sv__ctl">
            <span>GROUND</span>
            <div className="xsect__seg" role="group" aria-label="Ground">
              {GROUND_MODES.map((g) => (
                <button key={g.id} type="button" className={st.ground === g.id ? "is-on" : ""} onClick={() => st.setGround(g.id)} title={g.hint}>
                  {g.label}
                </button>
              ))}
            </div>
          </div>
          <div className="r3d__toggles">
            <label className="r3d__check" title="Interpolate between the tilts so echo edges slope from one tilt to the next (off: each beam as the radar swept it)">
              <input type="checkbox" checked={st.smooth} onChange={(e) => st.setSmooth(e.target.checked)} />
              Storm look
            </label>
            <label className="r3d__check" title="Warnings in force drawn on the ground in their colours">
              <input type="checkbox" checked={st.groundAlerts} disabled={st.ground === "plain"} onChange={(e) => st.setGroundAlerts(e.target.checked)} />
              Alert boxes
            </label>
            {st.style === "storm" && (
              <label className="r3d__check" title="Sunbeams through the haze around the storm">
                <input type="checkbox" checked={st.shafts} onChange={(e) => st.setShafts(e.target.checked)} />
                Light shafts
              </label>
            )}
            <label className="r3d__check" title="Fill the cone of silence and gaps from neighbouring radars (REF, CC, ZDR, KDP, SW)">
              <input type="checkbox" checked={st.fill} onChange={(e) => st.setFill(e.target.checked)} />
              Fill from other radars
            </label>
            <label className="r3d__check" title="GOES lightning mapper flashes around the scan">
              <input type="checkbox" checked={st.lightning} onChange={(e) => st.setLightning(e.target.checked)} />
              Lightning
            </label>
            <label className="r3d__check" title="Show where the radar saw nothing (above its top tilt)">
              <input type="checkbox" checked={st.cone} onChange={(e) => st.setCone(e.target.checked)} />
              Cone of silence
            </label>
          </div>
          <div className="r3d__notes">
            <span>{sunText}</span>
            {motionNote && <span>{motionNote}</span>}
            {fillNote && <span>{fillNote}</span>}
            {glmNote && <span>{glmNote}</span>}
            {h && coneLeft > 0.002 && st.cone && <span>Faint shell: the cone the radar cannot see</span>}
            {st.sel?.kind === "area" && <span>Only inside the traced area</span>}
            {gifNote && <span>{gifNote}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
