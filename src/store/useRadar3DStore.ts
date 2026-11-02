import { create } from "zustand";

import { isPreset, type CurveId, type CurvePoint, type SavedCurve } from "../lib/radar3d/lut";
import type { GroundMode } from "../lib/radar3d/ground";
import type { Style3D } from "../lib/radar3d/renderer";
import {
  describeProgress,
  fetchVolume3D,
  fetchVolume3DProgress,
  Volume3DError,
  type Volume3D,
} from "../lib/radar3d/volume";
import { describe } from "../lib/patience";
import { TDWR_VOLUME_NOTE } from "../lib/nexrad";
import { isTdwrId } from "./useNexradStore";
import { onRadarOptionsChange } from "../lib/radarOptions";
import { boxRing, checkSelection, maskVolume, ringBBox, siteSpot, type LngLat, type Sel3D } from "../lib/radar3d/selection";

/**
 * The 3D view: which radar volume it shows (the box, the moment, the frame on
 * the radar timeline), how it looks, and the volume itself. It follows the
 * radar frame on screen like the cross-section does; the newest live frame
 * asks for the newest WHOLE volume (a scan still coming in is never drawn).
 * The selection is drawn on the map (Radar3DBoxTool); with none the view
 * stays open, empty, asking for one.
 */

type BBox = [number, number, number, number];
export type DrawMode = "box" | "area" | null;

/** The camera seen from above, for the map: where it stands and its view cone. */
export interface CamFoot {
  eye: LngLat;
  cone: LngLat[];
  yaw: number;
}

const QUICK_FAMS = ["B", "G"];
const NO_CODES = new Uint8Array(0);

const PREFS_KEY = "weatherts.radar3d.prefs";

/** The vertical cut through the volume: a plane standing on the ground,
 *  `dir` degrees clockwise from north along its length, `pos` km from the
 *  box centre across it. */
export interface Cut3D {
  on: boolean;
  dir: number;
  pos: number;
  opacity: number;
  /** Hide the volume on the camera's side of the plane. */
  away: boolean;
  /** Lie along the cross-section line drawn on the map. */
  follow: boolean;
}

const CUT_OFF: Cut3D = { on: false, dir: 90, pos: 0, opacity: 0.85, away: true, follow: false };

interface Prefs {
  style: Style3D;
  curve: CurveId;
  /** Edited curves, one per moment kind. */
  customCurves: Record<string, CurvePoint[]>;
  savedCurves: SavedCurve[];
  /** The storm look: echo edges slope between tilts (the backend's look=smooth). */
  smooth: boolean;
  ground: GroundMode;
  /** Warnings in force drawn on the ground in their colours. */
  groundAlerts: boolean;
  /** Sunbeams through the haze around the storm. */
  shafts: boolean;
  vScale: number;
  sunMode: "scan" | "manual";
  sunElev: number;
  sunAz: number;
  cone: boolean;
  lightning: boolean;
  cloudEdge: number;
  cloudBase: number;
  renderScale: number;
}

const DEFAULTS: Prefs = {
  style: "storm",
  curve: "soft",
  customCurves: {},
  savedCurves: [],
  smooth: true,
  ground: "satellite",
  groundAlerts: true,
  shafts: false,
  vScale: 2,
  sunMode: "scan",
  sunElev: 35,
  sunAz: 225,
  cone: false,
  lightning: true,
  cloudEdge: 12,
  cloudBase: 1.2,
  renderScale: 0.67,
};

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULTS };
    const v = JSON.parse(raw) as Partial<Prefs> & { pv?: number };
    const out = { ...DEFAULTS, ...v };
    // Before the storm-look rework the cone of silence was on by default.
    if (!v.pv) out.cone = false;
    if (typeof out.curve !== "string" || !(isPreset(out.curve) || out.curve === "custom" || out.curve.startsWith("saved:"))) out.curve = "soft";
    if (!out.customCurves || typeof out.customCurves !== "object") out.customCurves = {};
    if (!Array.isArray(out.savedCurves)) out.savedCurves = [];
    if (!["satellite", "map", "plain"].includes(out.ground)) out.ground = "satellite";
    if (out.style !== "storm" && out.style !== "radar") out.style = "storm";
    if (!(out.vScale >= 1 && out.vScale <= 6)) out.vScale = 2;
    if (!(out.renderScale >= 0.4 && out.renderScale <= 1)) out.renderScale = 0.67;
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

function savePrefs(s: Prefs): void {
  try {
    const keep: Prefs & { pv: number } = {
      pv: 2,
      style: s.style,
      curve: s.curve,
      customCurves: s.customCurves,
      savedCurves: s.savedCurves,
      smooth: s.smooth,
      ground: s.ground,
      groundAlerts: s.groundAlerts,
      shafts: s.shafts,
      vScale: s.vScale,
      sunMode: s.sunMode,
      sunElev: s.sunElev,
      sunAz: s.sunAz,
      cone: s.cone,
      lightning: s.lightning,
      cloudEdge: s.cloudEdge,
      cloudBase: s.cloudBase,
      renderScale: s.renderScale,
    };
    localStorage.setItem(PREFS_KEY, JSON.stringify(keep));
  } catch {
    /* private mode: the choice lasts the session */
  }
}

let controller: AbortController | null = null;
let inFlight = false;
let again = false;
let debounce: number | null = null;

function abortLoad(): void {
  controller?.abort();
  controller = null;
  inFlight = false;
  again = false;
  if (debounce != null) window.clearTimeout(debounce);
  debounce = null;
}

function rid(): string {
  return `v3d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface Radar3DState extends Prefs {
  open: boolean;
  site: string | null;
  bbox: BBox | null;
  fam: string;
  /** Fill the cone and the gaps from neighbouring radars (off each open). */
  fill: boolean;
  /** Slow automatic orbit while the radar loop plays. */
  present: boolean;
  /** The frame on the radar timeline: its time and Level II key, or neither
   *  for the newest live frame. */
  at: number | null;
  key: string;
  data: Volume3D | null;
  busy: boolean;
  progress: { text: string; frac: number } | null;
  error: string | null;
  /** The error is about the box (out of range, too big): moving it helps. */
  errorBox: boolean;
  /** Bumps when the camera should go back to its starting view. */
  resetRev: number;
  /** What is selected on the map; null = nothing yet ("Draw a box"). */
  sel: Sel3D | null;
  /** A storm cell (SCIT id) the box follows as new scans come. */
  follow: string | null;
  /** Drawing a new selection on the map. */
  drawMode: DrawMode;
  /** A short message for the map bar: a refused box, what to do next. */
  notice: string | null;
  /** Quick Analysis: reflectivity and velocity side by side, one camera. */
  quick: boolean;
  data2: Volume3D | null;
  error2: string | null;
  cam: CamFoot | null;
  /** The whole window; otherwise the view shares the screen with the map. */
  expanded: boolean;

  openView: (o: {
    site: string;
    at?: number | null;
    key?: string;
    bbox?: BBox | null;
    fam?: string;
    sel?: Sel3D | null;
    follow?: string | null;
    quick?: boolean;
    draw?: DrawMode;
  }) => void;
  /** A new selection; false (and a notice) when it is refused. */
  setSelection: (sel: Sel3D, follow?: string | null) => boolean;
  clearSelection: () => void;
  /** The radar changed: the box goes, the view stays open asking for a new one. */
  changeSite: (site: string | null) => void;
  setDrawMode: (m: DrawMode) => void;
  setNotice: (t: string | null) => void;
  setQuick: (v: boolean) => void;
  setCam: (c: CamFoot | null) => void;
  setExpanded: (v: boolean) => void;
  close: () => void;
  setFam: (fam: string) => void;
  setStyle: (s: Style3D) => void;
  setCurve: (c: CurveId) => void;
  /** Edit this moment's curve (it becomes "custom"). */
  setCurvePoints: (kind: string, pts: CurvePoint[]) => void;
  /** Keep a curve under a name (replacing one of that name and moment). */
  saveCurve: (name: string, kind: string, pts: CurvePoint[]) => void;
  deleteCurve: (name: string, kind: string) => void;
  setSmooth: (v: boolean) => void;
  setGround: (g: GroundMode) => void;
  setGroundAlerts: (v: boolean) => void;
  setShafts: (v: boolean) => void;
  cut: Cut3D;
  setCut: (c: Partial<Cut3D>) => void;
  setFill: (v: boolean) => void;
  setLightning: (v: boolean) => void;
  setCone: (v: boolean) => void;
  setSunMode: (m: "scan" | "manual") => void;
  setSun: (elev: number, az: number) => void;
  setVScale: (v: number) => void;
  setPresent: (v: boolean) => void;
  setCloudEdge: (dbz: number) => void;
  setCloudBase: (km: number) => void;
  setRenderScale: (s: number) => void;
  /** The radar timeline moved: follow it when it is the same radar. */
  setFrame: (site: string | null, at: number | null, key: string) => void;
  retry: () => void;
  load: () => Promise<void>;
  reload: () => void;
}

export const useRadar3DStore = create<Radar3DState>((set, get) => {
  const pref = <K extends keyof Prefs>(k: K, v: Prefs[K]) => {
    set({ [k]: v } as Partial<Radar3DState>);
    savePrefs(get());
  };
  return {
    ...loadPrefs(),
    open: false,
    site: null,
    bbox: null,
    fam: "B",
    fill: false,
    present: false,
    at: null,
    key: "",
    data: null,
    busy: false,
    progress: null,
    error: null,
    errorBox: false,
    resetRev: 0,
    sel: null,
    follow: null,
    drawMode: null,
    notice: null,
    quick: false,
    data2: null,
    error2: null,
    cam: null,
    expanded: false,
    cut: { ...CUT_OFF },

    openView: ({ site, at = null, key = "", bbox = null, fam, sel = null, follow = null, quick, draw = null }) => {
      const s = get();
      const q = quick ?? (s.open ? s.quick : false);
      const nf = q ? "B" : (fam ?? (s.style === "storm" ? "B" : s.fam));
      let pick: Sel3D | null = sel ?? (bbox ? { kind: "box", ring: boxRing(bbox) } : null);
      let notice: string | null = null;
      if (pick) {
        const why = checkSelection(site, pick.ring, q ? QUICK_FAMS : [nf]);
        if (why) {
          notice = why;
          pick = null;
        }
      }
      const bb = pick ? ringBBox(pick.ring) : null;
      // The volume on screen stays only while it is the same radar and box.
      const same = s.open && s.site === site && JSON.stringify(s.bbox) === JSON.stringify(bb) && s.quick === q;
      if (!pick) abortLoad();
      set({
        open: true,
        site,
        at,
        key,
        bbox: bb,
        sel: pick,
        follow: pick ? follow : null,
        drawMode: pick ? null : draw,
        notice,
        quick: q,
        fam: nf,
        style: nf !== "B" ? "radar" : s.style,
        fill: false,
        data: same ? s.data : null,
        data2: same ? s.data2 : null,
        busy: pick ? s.busy : false,
        progress: pick ? s.progress : null,
        error: null,
        error2: null,
        errorBox: false,
        resetRev: s.resetRev + 1,
      });
      if (pick) get().reload();
    },
    setSelection: (sel, follow = null) => {
      const s = get();
      const why = checkSelection(s.site, sel.ring, s.quick ? QUICK_FAMS : [s.fam]);
      if (why) {
        set({ notice: why, drawMode: null });
        return false;
      }
      set({ sel, bbox: ringBBox(sel.ring), follow, drawMode: null, notice: null, error: null, error2: null, errorBox: false });
      get().reload();
      return true;
    },
    clearSelection: () => {
      abortLoad();
      set({
        sel: null,
        bbox: null,
        follow: null,
        data: null,
        data2: null,
        busy: false,
        progress: null,
        error: null,
        error2: null,
        errorBox: false,
        cam: null,
      });
    },
    changeSite: (site) => {
      get().clearSelection();
      const spot = siteSpot(site);
      set({ site, at: null, key: "", drawMode: null, notice: isTdwrId(site) ? TDWR_VOLUME_NOTE : `The radar changed to ${spot?.icao ?? site ?? "another radar"}: draw a new box.` });
    },
    setDrawMode: (drawMode) => set({ drawMode, ...(drawMode ? { notice: null } : {}) }),
    setNotice: (notice) => set({ notice }),
    setQuick: (v) => {
      const s = get();
      if (v === s.quick) return;
      if (v && s.sel) {
        const why = checkSelection(s.site, s.sel.ring, QUICK_FAMS);
        if (why) {
          set({ notice: why });
          return;
        }
      }
      set({ quick: v, data2: null, error2: null, ...(v && s.fam !== "B" ? { fam: "B" } : {}) });
      get().reload();
    },
    setCam: (cam) => set({ cam }),
    setExpanded: (expanded) => set({ expanded }),
    close: () => {
      abortLoad();
      set({
        open: false,
        data: null,
        data2: null,
        busy: false,
        progress: null,
        error: null,
        error2: null,
        errorBox: false,
        present: false,
        sel: null,
        bbox: null,
        follow: null,
        drawMode: null,
        notice: null,
        quick: false,
        cam: null,
      });
    },
    setFam: (fam) => {
      if (fam === get().fam) return;
      // The storm look draws reflectivity; another moment is shown as radar colours.
      set({ fam, ...(fam !== "B" && get().style === "storm" ? { style: "radar" as Style3D } : {}) });
      savePrefs(get());
      get().reload();
    },
    setStyle: (style) => {
      if (style === "storm" && get().fam !== "B") {
        set({ fam: "B" });
        get().reload();
      }
      pref("style", style);
    },
    setCurve: (c) => pref("curve", c),
    setCurvePoints: (kind, pts) => {
      set({ customCurves: { ...get().customCurves, [kind]: pts }, curve: "custom" });
      savePrefs(get());
    },
    saveCurve: (name, kind, pts) => {
      const rest = get().savedCurves.filter((c) => !(c.name === name && c.kind === kind));
      set({ savedCurves: [...rest, { name, kind, points: pts }], curve: `saved:${name}` });
      savePrefs(get());
    },
    deleteCurve: (name, kind) => {
      const s = get();
      set({
        savedCurves: s.savedCurves.filter((c) => !(c.name === name && c.kind === kind)),
        ...(s.curve === `saved:${name}` ? { curve: "soft" as CurveId } : {}),
      });
      savePrefs(get());
    },
    setSmooth: (v) => {
      if (v === get().smooth) return;
      pref("smooth", v);
      get().reload();
    },
    setGround: (g) => pref("ground", g),
    setGroundAlerts: (v) => pref("groundAlerts", v),
    setShafts: (v) => pref("shafts", v),
    setCut: (c) => set({ cut: { ...get().cut, ...c } }),
    setFill: (fill) => {
      if (fill === get().fill) return;
      set({ fill });
      get().reload();
    },
    setLightning: (v) => {
      pref("lightning", v);
      if (v && get().data && !get().data!.flashes.length && get().data!.header.glm?.available) get().reload();
    },
    setCone: (v) => pref("cone", v),
    setSunMode: (m) => pref("sunMode", m),
    setSun: (elev, az) => {
      set({ sunElev: elev, sunAz: az, sunMode: "manual" });
      savePrefs(get());
    },
    setVScale: (v) => pref("vScale", v),
    setPresent: (present) => set({ present }),
    setCloudEdge: (dbz) => pref("cloudEdge", dbz),
    setCloudBase: (km) => pref("cloudBase", km),
    setRenderScale: (s) => pref("renderScale", s),

    setFrame: (site, at, key) => {
      const s = get();
      if (!s.open || !site || site !== s.site) return;
      if (at === s.at && key === s.key) return;
      set({ at, key });
      get().reload();
    },
    retry: () => {
      set({ error: null, errorBox: false });
      get().reload();
    },

    load: async () => {
      const { site, open, bbox: hasBox } = get();
      if (!open || !site || !hasBox) return;
      if (inFlight) {
        again = true;
        return;
      }
      const ctrl = new AbortController();
      controller = ctrl;
      inFlight = true;
      again = false;
      const want = () => {
        const s = get();
        return { site: s.site!, fam: s.fam, at: s.at, key: s.key, bbox: s.bbox, lightning: s.lightning, fill: s.fill, look: (s.smooth ? "smooth" : "beams") as "smooth" | "beams" };
      };
      const q = want();
      const { quick, sel } = get();
      // A traced area is asked for as its bounding box, then cut to its outline.
      const ring = sel?.kind === "area" ? sel.ring : null;
      const fit = (v: Volume3D) => (ring ? maskVolume(v, ring) : v);
      const id = rid();
      set({ busy: true, progress: describeProgress(null, q.site) });
      // The pill follows the backend's progress while the request runs.
      let polling = true;
      const poll = async () => {
        while (polling && !ctrl.signal.aborted) {
          const p = await fetchVolume3DProgress(id, ctrl.signal);
          if (!polling || ctrl.signal.aborted) break;
          if (p && p.stage && p.stage !== "waiting") set({ progress: describeProgress(p, q.site) });
          await new Promise((r) => window.setTimeout(r, 250));
        }
      };
      void poll();
      try {
        // The radar's own volume first (fast), then the neighbour's fill.
        let vol = await fetchVolume3D({ ...q, fill: false, rid: id }, ctrl.signal);
        if (ctrl.signal.aborted) return;
        let shown = fit(vol);
        set({ data: shown, error: null, errorBox: false });
        // Quick Analysis: the same volume's velocity for the second view.
        if (quick) {
          set({ progress: { text: "Reading the velocity", frac: 0.75 } });
          try {
            const v2 = await fetchVolume3D({ ...q, fam: "G", key: vol.header.key, fill: false, lightning: false, rid: id }, ctrl.signal);
            if (ctrl.signal.aborted) return;
            set({ data2: fit(v2), error2: null });
          } catch (err) {
            if (ctrl.signal.aborted) return;
            set({ data2: null, error2: err instanceof Volume3DError ? err.message : describe(err, "The radar service") });
          }
        }
        if (q.fill) {
          set({ progress: { text: "Filling from other radars", frac: 0.8 } });
          vol = await fetchVolume3D({ ...q, key: vol.header.key, fill: true, rid: id }, ctrl.signal);
          if (ctrl.signal.aborted) return;
          shown = fit(vol);
          set({ data: shown });
        }
        // GOES lightning arrives after the volume: ask again until it is all in.
        let tries = 0;
        while (q.lightning && (vol.header.glm?.pending ?? 0) > 0 && tries < 6 && !ctrl.signal.aborted) {
          tries++;
          set({ progress: { text: "Reading GOES lightning", frac: 0.96 } });
          const g = await fetchVolume3D({ ...q, key: vol.header.key, fill: q.fill, part: "glm", rid: id }, ctrl.signal);
          if (ctrl.signal.aborted) return;
          vol = { ...vol, header: { ...vol.header, glm: g.header.glm, flashCount: g.header.flashCount }, flashes: g.flashes };
          // The codes are already cut to the area; only the flashes are new.
          const flashes = ring ? maskVolume({ ...vol, codes: NO_CODES }, ring).flashes : vol.flashes;
          shown = { ...shown, header: vol.header, flashes };
          set({ data: shown });
        }
        set({ busy: false, progress: null });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const box = err instanceof Volume3DError && err.box;
        const msg = err instanceof Volume3DError ? err.message : describe(err, "The radar service");
        set({
          busy: false,
          progress: null,
          error: msg,
          errorBox: box,
          ...(box ? { notice: msg } : {}),
        });
      } finally {
        polling = false;
        if (controller === ctrl) {
          inFlight = false;
          if (again) void get().load();
        }
      }
    },

    reload: () => {
      if (debounce != null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        debounce = null;
        void get().load();
      }, 80);
    },
  };
});

// The velocity options (Settings > Radar > Velocity): an open view showing
// velocity or SRV (or Quick Analysis' velocity) is asked again.
onRadarOptionsChange(() => {
  const s = useRadar3DStore.getState();
  if (s.open && s.site && s.bbox && (s.fam === "G" || s.fam === "S" || s.quick)) s.reload();
});
