import type { GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import type { LayerModule } from "../types";
import { NexradGlLayer } from "../nexradGlLayer";
import { addRing, removeRing, RING_LINE } from "../nexradRing";
import { addStorms, removeStorms, STORM_LAYERS } from "../nexradStorms";
import { paneIdOf } from "../../map/mapInstance";
import { useNexradStore } from "../../store/useNexradStore";
import { mapInk } from "../../map/mapInk";
import { attachRadarHold } from "../radarHold";

const SITE_SRC = "nexrad-sites-src";
const SITE_LABEL = "nexrad-sites-label";
const GL_LAYER = "nexrad-gl-layer";

// Per-map state. With split-screen the same module is added to several maps at
// once, so anything mutable has to hang off the map it belongs to -- module-level
// variables would have each pane clobbering the last one's handlers and layer.
interface PaneState {
  onClick: (e: MapLayerMouseEvent) => void;
  onEnter: () => void;
  onLeave: () => void;
  unsub: () => void;
  glLayer: NexradGlLayer | null;
  /** Press and hold to switch to the nearest radar (radarHold.ts). */
  detachHold: () => void;
}
const state = new WeakMap<import("maplibre-gl").Map, PaneState>();
// Opacity is a layer-wide setting, not per-map, so it stays shared.
let opacity = 0.85;

function sitesFC() {
  const { sites, site, error } = useNexradStore.getState();
  return {
    type: "FeatureCollection" as const,
    features: sites.map((s) => {
      const active = s.id === site;
      // "down" -> red pill. A site is red when the catalog marks it offline, or
      // when it's the one we're pointed at and its scan failed to load: that's
      // the radar the user sees "not working", so it turns red in place.
      const down = s.online === false || (active && !!error);
      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
        properties: {
          id: s.id,
          icao: s.icao,
          name: s.name,
          active,
          status: down ? "down" : "ok",
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

// Rounded-rect "pill" backgrounds the site name sits inside, drawn as nine-patch
// images so they stretch cleanly to any name. Registered once per map. This is
// what replaced the plain dot markers -- the user wanted the radar's name on a
// background, not a bare dot.
const PILL_BG = "nx-pill";
const PILL_ACTIVE = "nx-pill-active";
const PILL_DOWN = "nx-pill-down";
/** The plain badge follows the basemap: dark on a dark map, paper on a light
 *  one (see mapInk). Its own image per tone, so a switch never reuses the other. */
const pillBg = () => `${PILL_BG}-${mapInk().tone}`;
function registerSitePills(map: import("maplibre-gl").Map) {
  const R = 2; // draw at 2x for crisp edges
  const W = 64 * R;
  const H = 24 * R;
  const RAD = 8 * R;
  const make = (id: string, bg: string, border: string) => {
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
    ctx.beginPath();
    ctx.moveTo(x + RAD, y);
    ctx.arcTo(x + w, y, x + w, y + h, RAD);
    ctx.arcTo(x + w, y + h, x, y + h, RAD);
    ctx.arcTo(x, y + h, x, y, RAD);
    ctx.arcTo(x, y, x + w, y, RAD);
    ctx.closePath();
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.lineWidth = 1.4 * R;
    ctx.strokeStyle = border;
    ctx.stroke();
    map.addImage(id, ctx.getImageData(0, 0, W, H), {
      pixelRatio: R,
      // stretch only the middle so the rounded corners survive icon-text-fit
      stretchX: [[RAD, W - RAD]],
      stretchY: [[RAD, H - RAD]],
      content: [RAD, 4 * R, W - RAD, H - 4 * R],
    });
  };
  const ink = mapInk();
  make(pillBg(), ink.badge, ink.badgeEdge);
  make(PILL_ACTIVE, "rgba(250,204,21,0.95)", "rgba(255,255,255,0.7)");
  make(PILL_DOWN, "rgba(222,80,80,0.92)", "rgba(255,155,155,0.9)");
}

/** NEXRAD single-site radar: site markers + the selected site's Level III scan. */
export const nexradLayer: LayerModule = {
  id: "nexrad",
  name: "Radar (NEXRAD)",
  description: "US single-site NEXRAD Level III. Click a site to load its scan.",
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

    addRing(map);
    addStorms(map);

    if (!map.getSource(SITE_SRC)) {
      map.addSource(SITE_SRC, { type: "geojson", data: sitesFC() as unknown as GeoJSON.FeatureCollection });
    }
    registerSitePills(map);
    if (!map.getLayer(SITE_LABEL)) {
      map.addLayer({
        id: SITE_LABEL,
        type: "symbol",
        source: SITE_SRC,
        layout: {
          // the name on a pill background, sized to fit the text
          "icon-image": [
            "case",
            ["==", ["get", "status"], "down"],
            PILL_DOWN,
            ["get", "active"],
            PILL_ACTIVE,
            pillBg(),
          ],
          "icon-text-fit": "both",
          "icon-text-fit-padding": [2, 8, 2, 8],
          "text-field": ["get", "icao"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 11,
          "text-padding": 2,
          // the selected site must win collision and never be decluttered away
          "symbol-sort-key": ["case", ["get", "active"], 0, 1],
        },
        paint: {
          "text-color": [
            "case",
            ["==", ["get", "status"], "down"],
            "#ffeded",
            ["get", "active"],
            "#121212",
            mapInk().badgeText,
          ],
        },
      });
    }

    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      if (f.properties?.status === "down") return;
      const id = f.properties?.id;
      if (id) useNexradStore.getState().selectSite(String(id));
    };
    const onEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
    };
    map.on("click", SITE_LABEL, onClick);
    map.on("mouseenter", SITE_LABEL, onEnter);
    map.on("mouseleave", SITE_LABEL, onLeave);

    const unsub = useNexradStore.subscribe((s, prev) => {
      if (s.sites !== prev.sites || s.site !== prev.site || s.error !== prev.error) pushSites(map);
      const id = paneIdOf(map);
      const rev = id ? s.paneRadar[id]?.meshRev : undefined;
      const prevRev = id ? prev.paneRadar[id]?.meshRev : undefined;
      if (rev !== prevRev) pushMesh(map);
      // palette swap: geometry is untouched, only the colour buffer changes
      else if (s.colorRev !== prev.colorRev) {
        const m = paneMesh(map);
        if (m) state.get(map)?.glLayer?.setColors(m);
      }
    });

    // Added again after a style reload: the gesture from before goes first.
    state.get(map)?.detachHold();
    state.set(map, { onClick, onEnter, onLeave, unsub, glLayer, detachHold: attachRadarHold(map) });
    pushSites(map);
    pushMesh(map);
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
    for (const id of [SITE_LABEL, GL_LAYER]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    for (const id of [`${PILL_BG}-dark`, `${PILL_BG}-light`, PILL_ACTIVE, PILL_DOWN]) {
      if (map.hasImage(id)) map.removeImage(id);
    }
    if (map.getSource(SITE_SRC)) map.removeSource(SITE_SRC);
    useNexradStore.getState().clear();
  },

  setOpacity(map, o) {
    opacity = o;
    state.get(map)?.glLayer?.setOpacity(o);
  },

  getLayerIds() {
    // bottom -> top: the scan mesh, the range ring, the storm tracks, then the
    // site markers
    return [GL_LAYER, RING_LINE, ...STORM_LAYERS, SITE_LABEL];
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
