// Radar keyboard: one key per product for the focused pane, and the up/down
// arrows for its tilt (Shift = every pane). Installed once from main.tsx.
//
//   R reflectivity   V velocity   S SRV        W spectrum width
//   Z ZDR            C CC         P PHI        K KDP
//   E echo tops      L VIL        D DVIL       N NROT       O VROT
//
// Keys are ignored while typing (inputs, text areas, selects, editable text),
// inside an open list or menu, with Ctrl/Alt/Meta held, and while the drawing
// tool owns the letters. Shift + a letter stays free (Shift is the readout).
//
// The install also reloads the frame on screen when a velocity option changes
// (dealiasing, range folded, storm motion -- radarOptions.ts), since that
// module may not import the radar store.

import { getActivePaneId } from "../map/mapInstance";
import { useDrawStore } from "../store/useDrawStore";
import { useLsrStore } from "../store/useLsrStore";
import { stopWarming, useNexradStore } from "../store/useNexradStore";
import { wireCode, type ProductFamily } from "./nexrad";
import { onRadarOptionsChange } from "./radarOptions";
import { focusPaneNumber } from "./paneOps";

interface ProductKey {
  key: string;
  name: string;
  /** Family ids in order of preference (derived Level II first where the
   *  derived product is the one the key stands for). */
  ids: string[];
  /** Fallback: the first listed family of this kind (Brazilian volumes). */
  kind: string;
}

export const PRODUCT_KEYS: ProductKey[] = [
  { key: "R", name: "Reflectivity", ids: ["B"], kind: "ref" },
  { key: "V", name: "Velocity", ids: ["G"], kind: "vel" },
  { key: "S", name: "Storm relative velocity", ids: ["L2S", "S"], kind: "srv" },
  { key: "W", name: "Spectrum width", ids: ["L2W", "W"], kind: "sw" },
  { key: "Z", name: "Differential reflectivity", ids: ["L2X", "X"], kind: "zdr" },
  { key: "C", name: "Correlation coefficient", ids: ["L2C", "C"], kind: "cc" },
  { key: "P", name: "Differential phase", ids: ["L2P", "P"], kind: "phi" },
  { key: "K", name: "Specific differential phase", ids: ["K", "L2K"], kind: "kdp" },
  { key: "E", name: "Echo tops", ids: ["L2ET", "EET"], kind: "tops" },
  { key: "L", name: "VIL", ids: ["L2VIL", "DVL"], kind: "vil" },
  { key: "D", name: "VIL density", ids: ["L2DVIL"], kind: "dvil" },
  { key: "N", name: "Normalized rotation", ids: ["R"], kind: "nrot" },
  { key: "O", name: "Rotational velocity", ids: ["L2VROT"], kind: "vrot" },
];

/** The key that picks this family, for tooltips ("R"), or null. */
export function keyForFamily(id: string): string | null {
  return PRODUCT_KEYS.find((k) => k.ids.includes(id))?.key ?? null;
}

const usable = (f: ProductFamily | undefined): f is ProductFamily => !!f && !f.unavailable && f.tilts.length > 0;

/** The family a product key stands for at the radar on screen, or null. */
export function familyForKey(grids: ProductFamily[], key: string): ProductFamily | null {
  const k = PRODUCT_KEYS.find((p) => p.key === key.toUpperCase());
  if (!k) return null;
  for (const id of k.ids) {
    const f = grids.find((g) => g.id === id);
    if (usable(f)) return f;
  }
  return grids.find((g) => g.kind === k.kind && usable(g)) ?? null;
}

/** Tilt slots of a family, lowest elevation first. */
function slotsOf(fam: ProductFamily): string[] {
  return fam.tilts
    .filter((t) => t.tilt !== null)
    .slice()
    .sort((a, b) => (a.elev ?? 99) - (b.elev ?? 99))
    .map((t) => t.tilt as string);
}

/** The slot one step up (+1) or down (-1) from `tilt`; no wrap. */
function stepSlot(fam: ProductFamily, tilt: string | null, dir: 1 | -1): string | null {
  const slots = slotsOf(fam);
  if (slots.length < 2) return null;
  const i = tilt === null ? -1 : slots.indexOf(tilt);
  const j = i < 0 ? (dir > 0 ? 0 : slots.length - 1) : i + dir;
  if (j < 0 || j >= slots.length || j === i) return null;
  return slots[j];
}

/** Up/down a tilt in the focused pane, or in every pane. */
export function stepTilt(dir: 1 | -1, allPanes: boolean): boolean {
  const s = useNexradStore.getState();
  const fams = [...s.grids, ...s.catalog];
  const focus = getActivePaneId();
  let moved = false;
  if (allPanes) {
    // Other panes first, quietly; the focused pane's setTilt then reloads all.
    const panes = { ...s.paneRadar };
    for (const [id, pane] of Object.entries(panes)) {
      if (id === focus) continue;
      const fam = fams.find((f) => f.id === pane.family);
      const slot = fam ? stepSlot(fam, pane.tilt, dir) : null;
      const code = fam && slot ? wireCode(fam, slot) : null;
      if (!code) continue;
      panes[id] = { ...pane, tilt: slot, product: code, scan: null, mesh: null, meshRev: pane.meshRev + 1 };
      moved = true;
    }
    if (moved) useNexradStore.setState({ paneRadar: panes });
  }
  const fam = fams.find((f) => f.id === s.family);
  const slot = fam ? stepSlot(fam, s.tilt, dir) : null;
  if (slot) {
    useNexradStore.getState().setTilt(slot);
    return true;
  }
  if (moved) void useNexradStore.getState().showIndex(useNexradStore.getState().index);
  return moved;
}

function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return true;
  return !!el.closest?.('[role="listbox"], [role="menu"], [role="combobox"]');
}

function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || (e.repeat && e.key.length === 1)) return;
  if (typing(e.target)) return;
  // Keys 1-6 focus pane A-F (panes-layout), with or without a radar.
  if (/^[1-6]$/.test(e.key) && !e.shiftKey) {
    if (focusPaneNumber(Number(e.key))) e.preventDefault();
    return;
  }
  const s = useNexradStore.getState();
  if (!s.site || !s.grids.length) return;

  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    // The storm-report card steps its list with these.
    if (useLsrStore.getState().selected) return;
    // Captured, so the map does not also pan.
    e.preventDefault();
    e.stopPropagation();
    stepTilt(e.key === "ArrowUp" ? 1 : -1, e.shiftKey);
    return;
  }

  if (e.key.length !== 1 || e.shiftKey) return;
  if (useDrawStore.getState().active) return;
  const fam = familyForKey(s.grids, e.key);
  if (!fam) return;
  e.preventDefault();
  if (fam.id !== s.family) s.setFamily(fam.id);
}

declare global {
  interface Window {
    __radarKeysOff?: () => void;
  }
}

/** Install the radar keys (and the option reload). Safe to call again (HMR). */
export function installRadarKeys(): void {
  window.__radarKeysOff?.();
  window.addEventListener("keydown", onKey, true);
  const offOptions = onRadarOptionsChange(() => {
    // The loop frames being warmed carry the old option: stop them so the
    // frame on screen is not queued behind them.
    stopWarming();
    const st = useNexradStore.getState();
    if (st.site && st.scans.length) void st.showIndex(st.index);
  });
  window.__radarKeysOff = () => {
    window.removeEventListener("keydown", onKey, true);
    offOptions();
  };
}
