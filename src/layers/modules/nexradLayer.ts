import type { GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import type { LayerModule } from "../types";
import { NexradGlLayer } from "../nexradGlLayer";
import { addRing, removeRing, RING_LINE } from "../nexradRing";
import { addStorms, removeStorms, STORM_LAYERS } from "../nexradStorms";
import { paneIdOf } from "../../map/mapInstance";
import { useNexradStore } from "../../store/useNexradStore";
import { useAppStore } from "../../store/useAppStore";
import { mapInk } from "../../map/mapInk";
import { attachRadarHold } from "../radarHold";
import { registerMarkerLayers } from "../clickPriority";
import { getSetting, useSettingsStore } from "../../settings/useSettingsStore";
import { useRadarDisplayStore } from "../../store/useRadarDisplayStore";
import type { FlashStyle } from "../nexradGlLayer";
import { useCompareStore } from "../../store/useCompareStore";
import type { NexradSite } from "../../lib/nexrad";
import { placeOf } from "../../lib/radarSites";
import { siteClass, siteIsDown, siteRow, useRadarSitesStore } from "../../store/useRadarSitesStore";

const SITE_SRC = "nexrad-sites-src";
const SITE_LABEL = "nexrad-sites-label";
const GL_LAYER = "nexrad-gl-layer";
/** panes-compare: the second product, right of the divider. */
const GL_CMP = "nexrad-gl-cmp";

// Per-map state. With split-screen the same module is added to several maps at
// once, so anything mutable has to hang off the map it belongs to -- module-level
// variables would have each pane clobbering the last one's handlers and layer.
interface PaneState {
  onClick: (e: MapLayerMouseEvent) => void;
  onEnter: () => void;
  onLeave: () => void;
  unsub: () => void;
  glLayer: NexradGlLayer | null;
  cmpLayer: NexradGlLayer | null;
  /** Press and hold to switch to the nearest radar (radarHold.ts). */
  detachHold: () => void;
}
const state = new WeakMap<import("maplibre-gl").Map, PaneState>();
// Opacity is a layer-wide setting, not per-map, so it stays shared.
let opacity = 0.85;

/** The label: the id or the city, and the scan strategy after it (Settings > Radar > Sites). */
function siteLabel(s: NexradSite, vcp: string | null): string {
  const base = getSetting<boolean>("radar.siteCity") ? placeOf(s) : s.icao;
  return getSetting<boolean>("radar.siteVcp") && vcp ? `${base} ${vcp}` : base;
}

function sitesFC() {
  const { sites, site, error, scan } = useNexradStore.getState();
  return {
    type: "FeatureCollection" as const,
    features: sites.map((s) => {
      const active = s.id === site;
      // radar-sites: the live class colours the label (blue live, orange
      // late, yellow quiet 5+ min, red down 30+ min, gray unknown; "none" in
      // the archive). The radar we're pointed at whose scan failed to load
      // turns red in place too: that's the radar the user sees "not working".
      const cls = siteClass(s.id);
      const down = cls === "down" || (active && !!error);
      const vcp = active && scan?.meta.vcp != null ? String(scan.meta.vcp) : cls === "none" ? null : (siteRow(s.id)?.vcp ?? null);
      const tdwr = s.type === "TDWR";
      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
        properties: {
          id: s.id,
          icao: s.icao,
          name: s.name,
          active,
          status: down ? "down" : "ok",
          st: down ? "down" : cls,
          label: siteLabel(s, vcp),
          // An airport radar wears a different badge: a small yellow hexagon.
          kind: tdwr ? "tdwr" : "nexrad",
          pre: tdwr ? TDWR_PILL : "",
        },
      };
    }),
  };
}

function pushSites(map: import("maplibre-gl").Map) {
  (map.getSource(SITE_SRC) as GeoJSONSource | undefined)?.setData(
    sitesFC() as unknown as GeoJSON.FeatureCollection,
  );
}

/** Draw THIS pane's mesh. Each pane shows its own product at the shared frame,
 *  so the layer can't read the store's top-level mesh -- that one mirrors
 *  whichever pane is focused, which would make every pane look identical. */
function paneMesh(map: import("maplibre-gl").Map) {
  const s = useNexradStore.getState();
  const id = paneIdOf(map);
  return (id && s.paneRadar[id]?.mesh) || null;
}

function pushMesh(map: import("maplibre-gl").Map) {
  state.get(map)?.glLayer?.setMesh(paneMesh(map));
}

/** This pane's radar opacity: its own (display options), else the layer's. */
function paneOpacity(map: import("maplibre-gl").Map): number {
  const id = paneIdOf(map);
  const own = id ? useRadarDisplayStore.getState().opacity[id] : undefined;
  return own ?? opacity;
}

function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Flash reflectivity for this pane: on a reflectivity product only. */
function paneFlash(map: import("maplibre-gl").Map): FlashStyle | null {
  if (!getSetting<boolean>("radar.flash")) return null;
  const id = paneIdOf(map);
  const scan = id ? useNexradStore.getState().paneRadar[id]?.scan : null;
  if (!scan || scan.meta.kind !== "ref") return null;
  const [r, g, b] = hexRgb(getSetting<string>("radar.flashColor"));
  const a = Math.max(0, Math.min(1, Number(getSetting<number>("radar.flashOpacity"))));
  return { min: Number(getSetting<number>("radar.flashMin")), rgba: [r, g, b, a] };
}

/** Opacity + flash of this pane's layer, from the display options. */
function applyDisplay(map: import("maplibre-gl").Map) {
  const gl = state.get(map)?.glLayer;
  if (!gl) return;
  gl.setOpacity(paneOpacity(map));
  gl.setFlash(paneFlash(map));
  state.get(map)?.cmpLayer?.setOpacity(paneOpacity(map));
}

/** panes-compare: this pane split between two products -- the second one's
 *  mesh right of the divider, the pane's own product clipped to its left. */
function pushCompare(map: import("maplibre-gl").Map) {
  const st = state.get(map);
  if (!st?.glLayer || !st.cmpLayer) return;
  const id = paneIdOf(map);
  const cs = useCompareStore.getState();
  const slot = id ? cs.slots[id] : undefined;
  const host = id ? useNexradStore.getState().paneRadar[id] : undefined;
  const on = !!slot && !!host && !host.empty;
  st.cmpLayer.setMesh(on && id ? cs.viewOf(id).mesh : null);
  st.cmpLayer.setOpacity(paneOpacity(map));
  st.glLayer.setClip(on ? [0, slot!.split] : null);
  st.cmpLayer.setClip(on ? [slot!.split, 1] : null);
}

// Rounded-rect "pill" backgrounds the site name sits inside, drawn as nine-patch
// images so they stretch cleanly to any name. Registered once per map. This is
// what replaced the plain dot markers -- the user wanted the radar's name on a
// background, not a bare dot.
const PILL_BG = "nx-pill";
const PILL_DOWN = "nx-pill-down";
const PILL_DOWN_TDWR = "nx-pill-down-tdwr";
/** The TDWRs' images: the same classes under this name, a hexagon instead of a pill. */
const TDWR_PILL = "tdwr-";
/** radar-sites: the classes a label can show; "none" is the plain badge (archive). */
const PILL_CLASSES = ["ok", "late", "stale", "unknown", "none"] as const;
/** The status colour of each class: a cap at the badge's left end and its outline. */
const CLASS_INK: Record<"dark" | "light", Record<string, string>> = {
  dark: { ok: "#5f96ff", late: "#ff9a2e", stale: "#ffd84a", unknown: "#8f9aa8" },
  light: { ok: "#2f6fe8", late: "#e57a00", stale: "#e3b500", unknown: "#8a949f" },
};
/** An airport radar is yellow, whatever the basemap; a live one is plain yellow,
 *  otherwise the class shows on its left point (a quiet one's would be yellow
 *  on yellow, so it takes a dark olive). */
const TDWR_INK = {
  dark: { fill: "#ffd84a", edge: "#b8921a" },
  light: { fill: "#f7cf2e", edge: "#8f7308" },
  text: "#1c1500",
  cap: { ok: undefined, late: "#ff8a1e", stale: "#6b5a12", unknown: "#8f9aa8", none: undefined } as Record<string, string | undefined>,
};
/** The radar on screen: the app's accent, by the basemap's tone. */
const ACTIVE_INK = { dark: { fill: "#6c9dff", text: "#121212" }, light: { fill: "#3f7cf2", text: "#0b1522" } };
/** The plain badge follows the basemap: dark on a dark map, paper on a light
 *  one (see mapInk). Its own image per tone, so a switch never reuses the other. */
const pillPrefix = () => `${PILL_BG}-${mapInk().tone}-`;
const pillActivePrefix = () => `${PILL_BG}-act-${mapInk().tone}-`;
function registerSitePills(map: import("maplibre-gl").Map) {
  const R = 2; // draw at 2x for crisp edges
  const W = 64 * R;
  const H = 24 * R;
  const RAD = 8 * R;
  const CAP = 6 * R;
  const make = (id: string, bg: string, border: string, cap?: string) => {
    if (map.hasImage(id)) return;
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const x = R + 0.5,
      y = R + 0.5,
      w = W - 2 * R - 1,
      h = H - 2 * R - 1;
    const path = new Path2D();
    path.moveTo(x + RAD, y);
    path.arcTo(x + w, y, x + w, y + h, RAD);
    path.arcTo(x + w, y + h, x, y + h, RAD);
    path.arcTo(x, y + h, x, y, RAD);
    path.arcTo(x, y, x + w, y, RAD);
    path.closePath();
    ctx.fillStyle = bg;
    ctx.fill(path);
    if (cap) {
      // the status cap: the left end of the badge, outside the stretched middle
      ctx.save();
      ctx.clip(path);
      ctx.fillStyle = cap;
      ctx.fillRect(0, 0, x + CAP, H);
      ctx.restore();
    }
    ctx.lineWidth = 1.4 * R;
    ctx.strokeStyle = border;
    ctx.stroke(path);
    map.addImage(id, ctx.getImageData(0, 0, W, H), {
      pixelRatio: R,
      // stretch only the middle so the rounded corners survive icon-text-fit
      stretchX: [[RAD, W - RAD]],
      stretchY: [[RAD, H - RAD]],
      content: [RAD, 4 * R, W - RAD, H - 4 * R],
    });
  };
  // The airport radars' badge: a small flat hexagon, pointed at both ends, clear
  // of a NEXRAD's round pill at a glance. Its content box is the whole image, so
  // the points sit inside the layer's text padding and the badge stays small.
  const makeHex = (id: string, bg: string, border: string, cap?: string) => {
    if (map.hasImage(id)) return;
    const HW = 28 * R;
    const HH = 12 * R;
    const POINT = 6 * R;
    const cv = document.createElement("canvas");
    cv.width = HW;
    cv.height = HH;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const inset = 0.6 * R;
    const path = new Path2D();
    path.moveTo(POINT, inset);
    path.lineTo(HW - POINT, inset);
    path.lineTo(HW - inset, HH / 2);
    path.lineTo(HW - POINT, HH - inset);
    path.lineTo(POINT, HH - inset);
    path.lineTo(inset, HH / 2);
    path.closePath();
    ctx.fillStyle = bg;
    ctx.fill(path);
    if (cap) {
      ctx.save();
      ctx.clip(path);
      ctx.fillStyle = cap;
      ctx.fillRect(0, 0, POINT, HH);
      ctx.restore();
    }
    ctx.lineWidth = 1 * R;
    ctx.strokeStyle = border;
    ctx.stroke(path);
    map.addImage(id, ctx.getImageData(0, 0, HW, HH), {
      pixelRatio: R,
      stretchX: [[POINT, HW - POINT]],
      stretchY: [[2 * R, HH - 2 * R]],
      content: [0, 0, HW, HH],
    });
  };
  const ink = mapInk();
  const cls = CLASS_INK[ink.tone];
  const act = ACTIVE_INK[ink.tone];
  const hex = TDWR_INK[ink.tone];
  for (const c of PILL_CLASSES) {
    const capInk = cls[c];
    make(pillPrefix() + c, ink.badge, capInk ?? ink.badgeEdge, capInk);
    make(pillActivePrefix() + c, act.fill, capInk ?? "rgba(255,255,255,0.7)", capInk);
    makeHex(pillPrefix() + TDWR_PILL + c, hex.fill, hex.edge, TDWR_INK.cap[c]);
    // the radar on screen stays yellow (the accent drowned in its own echoes),
    // brighter and with a near-black edge
    makeHex(pillActivePrefix() + TDWR_PILL + c, "#ffe45c", TDWR_INK.text, TDWR_INK.cap[c]);
  }
  make(PILL_DOWN, "rgba(200,52,52,0.95)", "rgba(255,155,155,0.9)");
  makeHex(PILL_DOWN_TDWR, "rgba(200,52,52,0.95)", "rgba(255,155,155,0.9)");
}

/** NEXRAD single-site radar: site markers + the selected site's Level III scan. */
export const nexradLayer: LayerModule = {
  id: "nexrad",
  name: "Radar (NEXRAD)",
  description: "US single-site NEXRAD and TDWR airport radars, Level III. Click a site to load its scan.",
  category: "weather",
  source: "NOAA NEXRAD Level III via Unidata",
  defaultVisible: false,
  defaultOpacity: 0.85,

  async addTo(map) {
    await useNexradStore.getState().loadCatalog();

    // The scan is drawn client-side as a WebGL mesh (below the site markers), so
    // switching palettes only re-uploads vertex colours -- no server render.
    // Z-order is the manager's job (it re-stacks every module after each
    // reconcile, which would undo any beforeId passed here); alert outlines stay
    // above this via their module's topLayerIds().
    // A layer already on this map (left by an earlier add that failed partway)
    // is taken over rather than abandoned: abandoned, it would keep drawing its
    // last scan with nothing left holding it to update or remove.
    const existing = (map.getLayer(GL_LAYER) as { implementation?: unknown } | undefined)?.implementation;
    let glLayer: NexradGlLayer | null = existing instanceof NexradGlLayer ? existing : null;
    if (!glLayer) {
      glLayer = new NexradGlLayer(GL_LAYER);
      glLayer.setOpacity(opacity);
      map.addLayer(glLayer);
    }
    const existingCmp = (map.getLayer(GL_CMP) as { implementation?: unknown } | undefined)?.implementation;
    let cmpLayer: NexradGlLayer | null = existingCmp instanceof NexradGlLayer ? existingCmp : null;
    if (!cmpLayer) {
      cmpLayer = new NexradGlLayer(GL_CMP);
      cmpLayer.setOpacity(opacity);
      map.addLayer(cmpLayer);
    }

    addRing(map);
    addStorms(map);

    if (!map.getSource(SITE_SRC)) {
      // promoteId: the new-scan blink is a feature state keyed by the site id
      map.addSource(SITE_SRC, { type: "geojson", data: sitesFC() as unknown as GeoJSON.FeatureCollection, promoteId: "id" });
    }
    registerSitePills(map);
    if (!map.getLayer(SITE_LABEL)) {
      map.addLayer({
        id: SITE_LABEL,
        type: "symbol",
        source: SITE_SRC,
        layout: {
          // the name on a pill background, sized to fit the text, its left
          // end in the radar's status colour (radar-sites)
          "icon-image": [
            "case",
            ["==", ["get", "st"], "down"],
            ["case", ["==", ["get", "kind"], "tdwr"], PILL_DOWN_TDWR, PILL_DOWN],
            ["get", "active"],
            ["concat", pillActivePrefix(), ["get", "pre"], ["get", "st"]],
            ["concat", pillPrefix(), ["get", "pre"], ["get", "st"]],
          ],
          "icon-text-fit": "both",
          "icon-text-fit-padding": [2, 8, 2, 8],
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Bold"],
          "text-size": ["case", ["==", ["get", "kind"], "tdwr"], 9, 11],
          "text-padding": 2,
          // the selected site must win collision and never be decluttered away;
          // where they crowd, a NEXRAD's label beats an airport radar's
          "symbol-sort-key": ["case", ["get", "active"], 0, ["==", ["get", "kind"], "tdwr"], 2, 1],
        },
        paint: {
          "text-color": [
            "case",
            ["==", ["get", "status"], "down"],
            "#ffffff",
            ["get", "active"],
            ACTIVE_INK[mapInk().tone].text,
            ["==", ["get", "kind"], "tdwr"],
            TDWR_INK.text,
            mapInk().badgeText,
          ],
          // a radar that just finished a scan blinks twice (radarSitesInstall)
          "icon-opacity": ["case", ["boolean", ["feature-state", "blink"], false], 0.15, 1],
          "text-opacity": ["case", ["boolean", ["feature-state", "blink"], false], 0.15, 1],
        },
      });
    }

    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const id = f.properties?.id;
      if (!id) return;
      // A radar that is down cannot be picked: its reasons show instead.
      if (siteIsDown(String(id))) {
        const ev = e.originalEvent as MouseEvent;
        useRadarSitesStore.getState().openNotice(String(id), ev.clientX, ev.clientY);
        return;
      }
      if (f.properties?.status === "down") return;
      useNexradStore.getState().selectSite(String(id));
    };
    const onEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
    };
    map.on("click", SITE_LABEL, onClick);
    // A click on a radar's label is about the radar, not the warning under it.
    registerMarkerLayers([SITE_LABEL]);
    map.on("mouseenter", SITE_LABEL, onEnter);
    map.on("mouseleave", SITE_LABEL, onLeave);

    const unsub = useNexradStore.subscribe((s, prev) => {
      if (
        s.sites !== prev.sites || s.site !== prev.site || s.error !== prev.error ||
        s.archiveTime !== prev.archiveTime || s.archiveDate !== prev.archiveDate ||
        s.scan?.meta.vcp !== prev.scan?.meta.vcp
      ) pushSites(map);
      const id = paneIdOf(map);
      const rev = id ? s.paneRadar[id]?.meshRev : undefined;
      const prevRev = id ? prev.paneRadar[id]?.meshRev : undefined;
      if (rev !== prevRev) {
        pushMesh(map);
        applyDisplay(map);
        pushCompare(map);
      }
      // palette swap: geometry is untouched, only the colour buffer changes
      else if (s.colorRev !== prev.colorRev) {
        const m = paneMesh(map);
        if (m) state.get(map)?.glLayer?.setColors(m);
      }
    });

    // Display options: this pane's opacity, flash reflectivity.
    const unsubDisplay = useRadarDisplayStore.subscribe((s, p) => s.opacity !== p.opacity && applyDisplay(map));
    const unsubSettings = useSettingsStore.subscribe((s, p) => {
      if (["radar.flash", "radar.flashMin", "radar.flashColor", "radar.flashOpacity"].some((k) => s.values[k] !== p.values[k])) {
        applyDisplay(map);
      }
      if (["radar.siteVcp", "radar.siteCity"].some((k) => s.values[k] !== p.values[k])) pushSites(map);
    });
    // radar-sites: each new standing of the radars recolours their labels.
    const unsubStatus = useRadarSitesStore.subscribe((s, p) => {
      if (s.feed !== p.feed || s.feedError !== p.feedError) pushSites(map);
    });
    // The compared product (panes-compare): its mesh and the divider.
    const unsubCompare = useCompareStore.subscribe((s, p) => {
      const id = paneIdOf(map);
      if (!id) return;
      if (s.slots[id] !== p.slots[id] || s.views[id] !== p.views[id]) pushCompare(map);
    });
    const unsubAll = () => {
      unsubStatus();
      unsubCompare();
      unsub();
      unsubDisplay();
      unsubSettings();
    };

    // Added again after a style reload: the gesture from before goes first.
    state.get(map)?.detachHold();
    state.set(map, { onClick, onEnter, onLeave, unsub: unsubAll, glLayer, cmpLayer, detachHold: attachRadarHold(map) });
    pushSites(map);
    pushMesh(map);
    applyDisplay(map);
    pushCompare(map);
  },

  removeFrom(map) {
    const st = state.get(map);
    if (st) {
      map.off("click", SITE_LABEL, st.onClick);
      map.off("mouseenter", SITE_LABEL, st.onEnter);
      map.off("mouseleave", SITE_LABEL, st.onLeave);
      st.unsub();
      st.detachHold();
      state.delete(map);
    }
    removeRing(map);
    removeStorms(map);
    for (const id of [SITE_LABEL, GL_LAYER, GL_CMP]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    for (const tone of ["dark", "light"]) {
      for (const c of PILL_CLASSES) {
        for (const id of [
          `${PILL_BG}-${tone}-${c}`,
          `${PILL_BG}-act-${tone}-${c}`,
          `${PILL_BG}-${tone}-${TDWR_PILL}${c}`,
          `${PILL_BG}-act-${tone}-${TDWR_PILL}${c}`,
        ]) if (map.hasImage(id)) map.removeImage(id);
      }
    }
    if (map.hasImage(PILL_DOWN)) map.removeImage(PILL_DOWN);
    if (map.hasImage(PILL_DOWN_TDWR)) map.removeImage(PILL_DOWN_TDWR);
    if (map.getSource(SITE_SRC)) map.removeSource(SITE_SRC);
    // Only when the radar layer itself was turned off. A pane closing (2 panes
    // -> 1) takes the layer off ITS map too, and clearing then threw away the
    // radar the remaining pane was showing.
    if (!useAppStore.getState().layers.nexrad?.visible) useNexradStore.getState().clear();
  },

  setOpacity(map, o) {
    opacity = o;
    state.get(map)?.glLayer?.setOpacity(paneOpacity(map));
    state.get(map)?.cmpLayer?.setOpacity(paneOpacity(map));
  },

  getLayerIds() {
    // bottom -> top: the scan mesh, the range ring, the storm tracks, then the
    // site markers
    return [GL_LAYER, GL_CMP, RING_LINE, ...STORM_LAYERS, SITE_LABEL];
  },

  topLayerIds() {
    // Radar site names and storm cells must stay above alert outlines and other
    // modules -- a tracked cell buried under a warning polygon is unclickable.
    return [...STORM_LAYERS, SITE_LABEL];
  },
  // Above the mesoscale discussion outline in particular: that layer covers a
  // whole watch area and would otherwise sit on top of the site name and every
  // storm cell inside it, which is the one thing this list exists to keep
  // clickable. Still below LSR -- a filed report outranks a tracked cell.
  topPriority: 20,
};
