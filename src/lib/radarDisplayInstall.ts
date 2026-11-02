// Wiring for the radar display options (radarDisplay.ts, which may not import
// the radar store): the frame on screen is drawn again when the gate filter or
// a pane's trail changes, and T toggles the maximum value trail on the focused
// pane. Installed once from main.tsx.

import { getActivePaneId, PRIMARY_PANE } from "../map/mapInstance";
import { useSettingsStore } from "../settings/useSettingsStore";
import { useDrawStore } from "../store/useDrawStore";
import { useNexradStore } from "../store/useNexradStore";
import { useRadarDisplayStore } from "../store/useRadarDisplayStore";
import { clearTrails } from "./radarDisplay";

const GATE_KEYS = ["radar.gateLow", "radar.gateHigh"];

function redraw(): void {
  const st = useNexradStore.getState();
  if (st.site && st.scans.length) void st.showIndex(st.index);
}

function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return true;
  return !!el.closest?.('[role="listbox"], [role="menu"], [role="combobox"]');
}

/** The pane the T key and the panel's trail switch act on. */
export function focusedPaneId(): string {
  const id = getActivePaneId();
  const panes = useNexradStore.getState().paneRadar;
  if (id && panes[id]) return id;
  return Object.keys(panes)[0] ?? PRIMARY_PANE;
}

export function toggleFocusedTrail(): void {
  useRadarDisplayStore.getState().toggleTrail(focusedPaneId());
}

function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return;
  if (e.key !== "t" && e.key !== "T") return;
  if (typing(e.target) || useDrawStore.getState().active) return;
  const s = useNexradStore.getState();
  if (!s.site || !s.scans.length) return;
  e.preventDefault();
  toggleFocusedTrail();
}

declare global {
  interface Window {
    __radarDisplayOff?: () => void;
  }
}

export function installRadarDisplay(): void {
  window.__radarDisplayOff?.();
  window.addEventListener("keydown", onKey, true);

  let timer: ReturnType<typeof setTimeout> | null = null;
  const offSettings = useSettingsStore.subscribe((s, p) => {
    if (!GATE_KEYS.some((k) => s.values[k] !== p.values[k])) return;
    // A slider being dragged: draw once it rests a moment.
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      redraw();
    }, 140);
  });
  const offTrail = useRadarDisplayStore.subscribe((s, p) => {
    if (s.trail === p.trail) return;
    if (!Object.keys(s.trail).length) clearTrails();
    redraw();
  });
  // Another radar, another loop: the running trails start again.
  const offRadar = useNexradStore.subscribe((s, p) => {
    if (s.site !== p.site || s.archiveTime !== p.archiveTime || s.archiveDate !== p.archiveDate) clearTrails();
    // A pane that closed takes its trail and opacity with it.
    if (s.paneRadar !== p.paneRadar) {
      for (const id of Object.keys(p.paneRadar)) if (!s.paneRadar[id]) useRadarDisplayStore.getState().forget(id);
    }
  });
  window.__radarDisplayOff = () => {
    window.removeEventListener("keydown", onKey, true);
    if (timer) clearTimeout(timer);
    offSettings();
    offTrail();
    offRadar();
  };
}
