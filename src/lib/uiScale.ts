// Interface size and density (ux-shell; settings ui.scale / ui.density).
//
// Size is a page zoom, not a font-size rule: the app is laid out in px, and
// the map's own popups, readouts and pane chips are positioned in the same px
// as the map, so scaling everything together is the one way nothing drifts.
// The desktop app zooms the window itself (Electron webFrame: crisp map,
// exact viewport units); a browser gets CSS zoom on the root, with each map
// drawn at the zoomed pixel ratio so it stays sharp.
// Density is a data attribute that ux-shell.css reads.

import { allMaps, subscribeMaps } from "../map/mapInstance";
import { getSetting, useSettingsStore } from "../settings/useSettingsStore";

interface ZoomApi {
  setZoomFactor?: (f: number) => void;
}

const api = (): ZoomApi | undefined => (window as unknown as { electronAPI?: ZoomApi }).electronAPI;

let cssZoom = 1;

function sharpMaps(): void {
  const ratio = window.devicePixelRatio * cssZoom;
  for (const map of allMaps()) {
    const m = map as unknown as { setPixelRatio?: (r: number) => void; getPixelRatio?: () => number };
    if (m.setPixelRatio && Math.abs((m.getPixelRatio?.() ?? 0) - ratio) > 1e-3) m.setPixelRatio(ratio);
  }
}

function apply(): void {
  const raw = Number(getSetting<number>("ui.scale"));
  const z = Number.isFinite(raw) ? Math.min(1.25, Math.max(0.75, raw)) : 1;
  const root = document.documentElement;
  const electron = api();
  const was = cssZoom;
  if (electron?.setZoomFactor) {
    electron.setZoomFactor(z);
    cssZoom = 1;
    root.style.removeProperty("zoom");
  } else {
    cssZoom = z;
    if (Math.abs(z - 1) < 1e-3) root.style.removeProperty("zoom");
    else root.style.setProperty("zoom", String(z));
  }
  if (cssZoom !== was) sharpMaps();
  if (getSetting<string>("ui.density") === "compact") root.dataset.density = "compact";
  else delete root.dataset.density;
}

declare global {
  interface Window {
    __uiScaleOff?: () => void;
  }
}

/** Apply now and on every change. Safe to call again (HMR). */
export function installUiScale(): void {
  window.__uiScaleOff?.();
  apply();
  const off = useSettingsStore.subscribe((s, prev) => {
    if (s.values["ui.scale"] !== prev.values["ui.scale"] || s.values["ui.density"] !== prev.values["ui.density"]) apply();
  });
  // A pane opened later, or the window moved to another screen.
  const offMaps = subscribeMaps(() => cssZoom !== 1 && sharpMaps());
  const onResize = () => cssZoom !== 1 && sharpMaps();
  window.addEventListener("resize", onResize);
  window.__uiScaleOff = () => {
    off();
    offMaps();
    window.removeEventListener("resize", onResize);
  };
}
