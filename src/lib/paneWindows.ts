/**
 * Floating windows and analysis views in panes (panes-compare).
 *
 *  - "Window" pops a pane out of the grid into a window floating over the map
 *    area. Its box is kept as shares of the map area (so it lands in the same
 *    place on another screen size), it stays inside the map area, raises on a
 *    click, and goes Fullscreen on a double-click of its title. "Back to a pane"
 *    puts it back in the grid; the box is remembered for the next time.
 *  - The cross-section and the 3D view can take a pane of their own instead of
 *    covering the map: an empty pane, else one added to the layout, else the
 *    user is asked which. A pane added for a view goes again when it closes.
 *
 * The pane itself never remounts for any of this -- the same element changes
 * place -- so its map, its product and its loop survive every move.
 */
import { getActivePaneId, getMapById, setActivePane } from "../map/mapInstance";
import { useAppStore } from "../store/useAppStore";
import { useCompareStore } from "../store/useCompareStore";
import { useNexradStore } from "../store/useNexradStore";
import { paneLetter, usePaneStore, type AnalysisKind, type AnalysisPlace, type PaneFloat } from "../store/usePaneStore";
import { useRadar3DStore } from "../store/useRadar3DStore";
import { useXsectStore } from "../store/useXsectStore";
import { closePane, moveOrSwap, paneIds } from "./paneOps";

/** The window's title bar, px (the pane's map starts below it). */
export const TITLE_H = 26;
export const MIN_W = 0.16;
export const MIN_H = 0.2;

export const ANALYSIS_LABEL: Record<AnalysisKind, string> = { xsect: "Cross section", r3d: "3D view" };

/** A pane floating now (a box kept with `docked` is only remembered). */
export function isFloat(f: PaneFloat | undefined): f is PaneFloat {
  return !!f && !f.docked;
}

export function floatingIds(): string[] {
  const { floats } = usePaneStore.getState();
  return paneIds().filter((id) => isFloat(floats[id]));
}

/** The panes in the grid, in order. */
export function tiledIds(count = useAppStore.getState().paneCount): string[] {
  const { floats } = usePaneStore.getState();
  return paneIds(count).filter((id) => !isFloat(floats[id]));
}

/** A window needs other panes under it: the last pane in the grid stays. */
export function canFloat(id: string): boolean {
  const tiled = tiledIds();
  return tiled.includes(id) && tiled.length > 1;
}

function clampRect(r: PaneFloat): PaneFloat {
  const w = Math.max(MIN_W, Math.min(1, r.w));
  const h = Math.max(MIN_H, Math.min(1, r.h));
  return { ...r, w, h, x: Math.max(0, Math.min(1 - w, r.x)), y: Math.max(0, Math.min(1 - h, r.y)) };
}

function topZ(): number {
  const { floats } = usePaneStore.getState();
  let z = 0;
  for (const f of Object.values(floats)) if (isFloat(f)) z = Math.max(z, f.z);
  return z;
}

function setFloat(id: string, f: PaneFloat | null): void {
  const floats = { ...usePaneStore.getState().floats };
  if (f) floats[id] = f;
  else delete floats[id];
  usePaneStore.setState({ floats });
}

/** Pop a pane out into a floating window (its last box, else a fresh one). */
/** Where an analysis view's last window box is kept (not a pane id, so the
 *  pane bookkeeping never moves or drops it). */
const viewBoxKey = (kind: AnalysisKind) => `view:${kind}`;

export function popOut(id: string): boolean {
  if (!canFloat(id)) return false;
  const ps = usePaneStore.getState();
  const view = ps.analysis[id];
  const was = ps.floats[id] ?? (view ? ps.floats[viewBoxKey(view)] : undefined);
  // A new window cascades past the windows already there (never exactly on
  // top of one). An analysis view brings rows of options: it starts taller.
  const others = floatingIds().map((o) => ps.floats[o]);
  const fresh: PaneFloat = view ? { x: 0.26, y: 0.06, w: 0.5, h: 0.82, z: 0 } : { x: 0.3, y: 0.14, w: 0.42, h: 0.52, z: 0 };
  for (let k = 0; k < 8 && others.some((o) => Math.abs(o.x - fresh.x) < 0.02 && Math.abs(o.y - fresh.y) < 0.02); k++) {
    fresh.x = Math.min(1 - fresh.w, fresh.x + 0.03);
    fresh.y = Math.min(1 - fresh.h, fresh.y + 0.04);
  }
  setFloat(id, { ...clampRect(was ? { ...was, full: false, docked: false } : fresh), z: topZ() + 1 });
  focusLater(id);
  return true;
}

/** "Back to a pane": into the grid again (the box is kept for next time). */
export function dockBack(id: string): void {
  const f = usePaneStore.getState().floats[id];
  if (!f) return;
  setFloat(id, { ...f, full: false, docked: true });
  focusLater(id);
}

export function raise(id: string): void {
  const f = usePaneStore.getState().floats[id];
  if (!isFloat(f)) return;
  const z = topZ();
  if (f.z === z && Object.values(usePaneStore.getState().floats).filter((g) => isFloat(g) && g.z === z).length === 1) return;
  setFloat(id, { ...f, z: z + 1 });
}

export function setRect(id: string, r: Pick<PaneFloat, "x" | "y" | "w" | "h">): void {
  const f = usePaneStore.getState().floats[id];
  if (!isFloat(f)) return;
  setFloat(id, clampRect({ ...f, ...r, full: false }));
}

export function toggleFull(id: string): void {
  const f = usePaneStore.getState().floats[id];
  if (!isFloat(f)) return;
  setFloat(id, { ...f, full: !f.full, z: topZ() + 1 });
}

function focusLater(id: string): void {
  setTimeout(() => {
    for (const m of [getMapById(id)]) m?.resize();
    if (!usePaneStore.getState().analysis[id] && getMapById(id)) {
      setActivePane(id);
      useNexradStore.getState().focusPane(id);
    }
  }, 0);
}

/** "Pane B · KTLX REF" (or the analysis view it shows). */
export function windowTitle(id: string): string {
  const view = usePaneStore.getState().analysis[id];
  if (view) return `Pane ${paneLetter(id)} · ${ANALYSIS_LABEL[view]}`;
  const s = useNexradStore.getState();
  const p = s.paneRadar[id];
  if (!p || p.empty || !s.site) return `Pane ${paneLetter(id)}`;
  const fam = [...s.grids, ...s.catalog].find((f) => f.id === p.family);
  const site = p.site || s.site;
  const icao = s.sites.find((x) => x.id === site)?.icao ?? site;
  const name = fam?.short ?? fam?.label ?? p.family;
  const cmp = useCompareStore.getState().slots[id];
  const other = cmp ? [...s.grids, ...s.catalog].find((f) => f.id === cmp.family) : undefined;
  return `Pane ${paneLetter(id)} · ${icao} ${name}${other ? ` | ${other.short ?? other.label}` : ""}`;
}

// ---- analysis views in panes ----

export function analysisPaneOf(kind: AnalysisKind): string | null {
  const { analysis } = usePaneStore.getState();
  for (const id of paneIds()) if (analysis[id] === kind) return id;
  return null;
}

function setAnalysis(id: string, kind: AnalysisKind | null, added?: boolean): void {
  const ps = usePaneStore.getState();
  const analysis = { ...ps.analysis };
  const addedMap = { ...ps.added };
  if (kind) analysis[id] = kind;
  else delete analysis[id];
  if (added === true) addedMap[id] = true;
  else if (added === false) delete addedMap[id];
  usePaneStore.setState({ analysis, added: addedMap });
}

function setPref(kind: AnalysisKind, place: AnalysisPlace): void {
  const ps = usePaneStore.getState();
  usePaneStore.setState({ analysisPref: { ...ps.analysisPref, [kind]: place } });
}

/** The focused pane goes back to a map pane when the view takes it. */
function refocusAway(id: string): void {
  if (getActivePaneId() !== id) return;
  const other = paneIds().find((x) => x !== id && !usePaneStore.getState().analysis[x]);
  if (other && getMapById(other)) {
    setActivePane(other);
    useNexradStore.getState().focusPane(other);
  }
}

/**
 * Put an analysis view in a pane: an empty pane, else one added to the layout
 * (up to four), else the user picks (the chooser). `window` floats it too.
 */
export function placeInPane(kind: AnalysisKind, window = false): void {
  setPref(kind, window ? "window" : "pane");
  const cur = analysisPaneOf(kind);
  if (cur) {
    if (window && !isFloat(usePaneStore.getState().floats[cur])) popOut(cur);
    return;
  }
  const ps = usePaneStore.getState();
  const nx = useNexradStore.getState();
  const focus = getActivePaneId();
  const free = paneIds().find((id) => id !== focus && !ps.analysis[id] && (!nx.paneRadar[id] || nx.paneRadar[id].empty));
  if (free) {
    setAnalysis(free, kind);
    refocusAway(free);
    if (window) setTimeout(() => popOut(free), 0);
    return;
  }
  const n = useAppStore.getState().paneCount;
  if (n < 4) {
    const id = `pane-${n}`;
    setAnalysis(id, kind, true);
    useAppStore.getState().setPaneCount((n + 1) as 2 | 3 | 4);
    if (window) setTimeout(() => popOut(id), 0);
    return;
  }
  usePaneStore.setState({ chooser: { kind, at: Date.now() } });
}

/** The chooser's answer: this pane shows the view while it is open. */
export function placeInChosen(kind: AnalysisKind, id: string): void {
  usePaneStore.setState({ chooser: null });
  const other = usePaneStore.getState().analysis[id];
  if (other && other !== kind) closeAnalysis(other);
  setAnalysis(id, kind);
  refocusAway(id);
}

/** Over the map again, as the view was before panes could hold it. */
export function backToOverlay(kind: AnalysisKind): void {
  setPref(kind, "overlay");
  release(kind);
}

/** The view closed: its pane shows its map again, or goes if it was added. */
export function release(kind: AnalysisKind): void {
  const id = analysisPaneOf(kind);
  if (!id) return;
  const wasAdded = !!usePaneStore.getState().added[id];
  // The view's window box is the view's: it opens there next time.
  const box = usePaneStore.getState().floats[id];
  if (box) usePaneStore.setState({ floats: { ...usePaneStore.getState().floats, [viewBoxKey(kind)]: { ...box, full: false, docked: true } } });
  setAnalysis(id, null, false);
  if (wasAdded) {
    const f = usePaneStore.getState().floats[id];
    if (f) setFloat(id, null);
    closePane(id);
  }
}

/** Close the view itself (its own close button does the same). */
export function closeAnalysis(kind: AnalysisKind): void {
  if (kind === "xsect") useXsectStore.getState().close();
  else useRadar3DStore.getState().close();
}

/** Drag the view's chip onto another pane: it moves there (or swaps with
 *  the view that pane shows). */
export function moveAnalysis(from: string, to: string): void {
  const ps = usePaneStore.getState();
  const kind = ps.analysis[from];
  if (!kind || from === to) return;
  const there = ps.analysis[to];
  const analysis = { ...ps.analysis, [to]: kind };
  if (there) analysis[from] = there;
  else delete analysis[from];
  const trade = <T,>(rec: Record<string, T>) => {
    const a = rec[to];
    const b = rec[from];
    if (a !== undefined) rec[from] = a;
    else delete rec[from];
    if (b !== undefined) rec[to] = b;
    else delete rec[to];
  };
  if (!there) {
    // The map the view lands on takes the view's old place (with its compare
    // split) instead of hiding behind the view.
    moveOrSwap(to, from);
    const cs = useCompareStore.getState();
    const slots = { ...cs.slots };
    const views = { ...cs.views };
    trade(slots);
    trade(views);
    useCompareStore.setState({ slots, views });
  }
  // "Added for the view" goes with the view: closing it removes its pane.
  const added = { ...ps.added };
  trade(added);
  usePaneStore.setState({ analysis, added });
  refocusAway(to);
}

/**
 * Closing pane k (paneOps.closePane): the panes after it move down a slot, and
 * what this step keeps per pane moves with them.
 */
export function shiftPaneExtras(ids: string[], k: number, target: number): void {
  const ps = usePaneStore.getState();
  const cs = useCompareStore.getState();
  const floats = { ...ps.floats };
  const analysis = { ...ps.analysis };
  const added = { ...ps.added };
  const slots = { ...cs.slots };
  const views = { ...cs.views };
  const shift = <T,>(rec: Record<string, T>, to: string, from: string) => {
    if (from in rec) rec[to] = rec[from];
    else delete rec[to];
  };
  for (let j = k; j < ids.length - 1; j++) {
    for (const rec of [floats, analysis, added, slots, views] as Record<string, unknown>[]) shift(rec, ids[j], ids[j + 1]);
  }
  for (let j = target; j < ids.length; j++) {
    for (const rec of [floats, analysis, added, slots, views] as Record<string, unknown>[]) delete rec[ids[j]];
  }
  usePaneStore.setState({ floats, analysis, added });
  useCompareStore.setState({ slots, views });
}

/** A layout with fewer panes: what the panes that go kept goes with them. */
export function dropPaneExtrasFrom(count: number): void {
  const ps = usePaneStore.getState();
  const cs = useCompareStore.getState();
  const floats = { ...ps.floats };
  const analysis = { ...ps.analysis };
  const added = { ...ps.added };
  const slots = { ...cs.slots };
  for (let j = count; j < 6; j++) {
    const id = `pane-${j}`;
    delete floats[id];
    delete analysis[id];
    delete added[id];
    delete slots[id];
  }
  usePaneStore.setState({ floats, analysis, added });
  useCompareStore.setState({ slots });
}

/**
 * Once for the app: a view opening goes where it went last time (a pane, a
 * window); a view closing gives its pane back.
 */
export function installAnalysisPanes(): void {
  // A reload closes the views: a view's window box is kept for its next
  // opening, its pane shows its map again, and the panes added for views go
  // (the maps have not mounted yet, so nothing flashes).
  const ps0 = usePaneStore.getState();
  if (Object.keys(ps0.analysis).length) {
    const floats = { ...ps0.floats };
    for (const [id, kind] of Object.entries(ps0.analysis)) {
      const f = floats[id];
      if (f && !f.docked) floats[viewBoxKey(kind)] = { ...f, full: false, docked: true };
    }
    usePaneStore.setState({ floats, analysis: {} });
  }
  if (Object.keys(usePaneStore.getState().added).length) {
    for (const id of [...paneIds()].reverse()) if (usePaneStore.getState().added[id]) closePane(id);
    usePaneStore.setState({ added: {} });
  }
  const shownX = () => {
    const s = useXsectStore.getState();
    return !!(s.a && s.b && !s.drawing);
  };
  const activeX = () => {
    const s = useXsectStore.getState();
    return !!(s.a && s.b) || s.drawing;
  };
  let wasX = shownX();
  useXsectStore.subscribe(() => {
    const now = shownX();
    if (now && !wasX) {
      const pref = usePaneStore.getState().analysisPref.xsect;
      if ((pref === "pane" || pref === "window") && !analysisPaneOf("xsect")) placeInPane("xsect", pref === "window");
    }
    wasX = now;
    if (!activeX()) release("xsect");
  });
  let was3 = useRadar3DStore.getState().open;
  useRadar3DStore.subscribe((s) => {
    if (s.open && !was3) {
      const pref = usePaneStore.getState().analysisPref.r3d;
      if ((pref === "pane" || pref === "window") && !analysisPaneOf("r3d")) placeInPane("r3d", pref === "window");
    }
    was3 = s.open;
    if (!s.open) release("r3d");
  });
  // A chooser left open by a view that closed in the meantime.
  usePaneStore.subscribe((s) => {
    if (!s.chooser) return;
    const open = s.chooser.kind === "xsect" ? activeX() : useRadar3DStore.getState().open;
    if (!open) usePaneStore.setState({ chooser: null });
  });
}
