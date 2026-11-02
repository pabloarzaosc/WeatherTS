/**
 * Pane operations (panes-layout): close a pane, focus one by number, take the
 * product off a pane, move or swap a product between panes, show a picked
 * product in a given pane, move an overlay, and the two per-pane sync
 * switches.
 *
 * Moving and swapping hand the decoded scan and its mesh over with the
 * product, so nothing is downloaded or rebuilt for it.
 */
import { allMaps, getActivePaneId, getMapById, setActivePane } from "../map/mapInstance";
import { useAppStore } from "../store/useAppStore";
import { useNexradStore, type PaneRadar } from "../store/useNexradStore";
import { usePaneStore } from "../store/usePaneStore";
import { useRadarDisplayStore } from "../store/useRadarDisplayStore";
import { dropPaneExtrasFrom, shiftPaneExtras } from "./paneWindows";

export function paneIds(count = useAppStore.getState().paneCount): string[] {
  return Array.from({ length: count }, (_, i) => `pane-${i}`);
}

/** Focus a pane: the product picker, the colour bar and every map tool follow. */
export function focusPane(id: string): void {
  if (!getMapById(id)) return;
  setActivePane(id);
  useNexradStore.getState().focusPane(id);
}

/** Keys 1-6: focus pane A-F. False when there is no such pane. */
export function focusPaneNumber(n: number): boolean {
  const ids = paneIds();
  if (ids.length < 2 || n < 1 || n > ids.length) return false;
  focusPane(ids[n - 1]);
  return true;
}

/** The product fields that travel with a chip. */
type Carried = Pick<PaneRadar, "product" | "family" | "tilt" | "scan" | "mesh" | "site" | "note" | "empty">;
function carried(p: PaneRadar): Carried {
  return { product: p.product, family: p.family, tilt: p.tilt, scan: p.scan, mesh: p.mesh, site: p.site ?? null, note: p.note ?? null, empty: !!p.empty };
}

/** After panes changed products: the focused one's mirror, and the loop's list
 *  when the focused pane's product (which the list is for) changed. */
function afterChange(prevProduct: string): void {
  const s = useNexradStore.getState();
  const focus = getActivePaneId();
  if (focus && s.paneRadar[focus]) s.focusPane(focus);
  const now = useNexradStore.getState();
  if (!now.site) return;
  if (now.product !== prevProduct) void now.refresh();
  else void now.showIndex(now.index);
  // Panes on their own scrubber rebuild at their own frame.
  for (const [id, p] of Object.entries(now.paneRadar)) {
    if (p.ownTime != null && !p.scan && !p.empty) void now.showIndex(nearestIndex(p.ownTime), id);
  }
}

export function nearestIndex(t: number): number {
  const scans = useNexradStore.getState().scans;
  let best = 0;
  for (let i = 1; i < scans.length; i++) if (Math.abs(scans[i].time - t) < Math.abs(scans[best].time - t)) best = i;
  return best;
}

/** Take the radar product off a pane: it shows "Select product". */
export function clearPane(id: string): void {
  const s = useNexradStore.getState();
  const p = s.paneRadar[id];
  if (!p || p.empty) return;
  useNexradStore.setState({
    paneRadar: { ...s.paneRadar, [id]: { ...p, empty: true, scan: null, mesh: null, note: null, meshRev: p.meshRev + 1 } },
    ...(getActivePaneId() === id ? { scan: null, mesh: null, meshRev: s.meshRev + 1 } : {}),
  });
}

/**
 * Drop a pane's product chip on another pane: swap when that pane shows a
 * product too, move it there (leaving "Select product") when it is empty.
 */
export function moveOrSwap(from: string, to: string): "move" | "swap" | null {
  if (from === to) return null;
  const s = useNexradStore.getState();
  const a = s.paneRadar[from];
  const b = s.paneRadar[to];
  if (!a || !b || a.empty) return null;
  const prevProduct = s.product;
  const swap = !b.empty;
  // Two panes at different frames (one on its own scrubber): the pictures do
  // not belong to the other pane's time, so they are rebuilt (from the cache).
  const sameTime = (a.ownTime ?? null) === (b.ownTime ?? null);
  const keep = (c: Carried): Carried => (sameTime ? c : { ...c, scan: null, mesh: null });
  const paneRadar = { ...s.paneRadar };
  paneRadar[to] = { ...b, ...keep(carried(a)), meshRev: b.meshRev + 1 };
  paneRadar[from] = swap
    ? { ...a, ...keep(carried(b)), meshRev: a.meshRev + 1 }
    : { ...a, empty: true, scan: null, mesh: null, note: null, site: null, meshRev: a.meshRev + 1 };
  useNexradStore.setState({ paneRadar });
  // The trail and the pane opacity are the pane's display, not the product's.
  afterChange(prevProduct);
  return swap ? "swap" : "move";
}

/** A product button dropped on a pane: that pane shows it. */
export function showFamilyIn(id: string, family: string): void {
  const s = useNexradStore.getState();
  if (!s.paneRadar[id]) return;
  if (getActivePaneId() === id) {
    s.setFamily(family);
    return;
  }
  s.setPaneFamily(id, family);
}

/** An overlay chip dropped on another pane: it leaves the first. */
export function moveOverlay(overlay: string, from: string, to: string): void {
  if (from === to) return;
  const ps = usePaneStore.getState();
  ps.setHidden(to, overlay, false);
  ps.setHidden(from, overlay, true);
}

/** Sync camera on/off for a pane; back on, it jumps to the shared camera. */
export function setCameraSync(id: string, on: boolean): void {
  usePaneStore.getState().setSync(id, { camera: on });
  if (!on) return;
  const me = getMapById(id);
  const ps = usePaneStore.getState();
  const peer = paneIds()
    .filter((p) => p !== id && ps.syncOf(p).camera)
    .map((p) => getMapById(p))
    .find((m) => !!m);
  if (me && peer) me.jumpTo({ center: peer.getCenter(), zoom: peer.getZoom(), bearing: peer.getBearing(), pitch: peer.getPitch() });
}

/** Follow the animation on/off for a pane. Off parks the pane on the frame it
 *  shows now, with its own scrubber; on brings it back to the timeline. */
export function setFollow(id: string, on: boolean): void {
  const ps = usePaneStore.getState();
  ps.setSync(id, { follow: on });
  const s = useNexradStore.getState();
  const p = s.paneRadar[id];
  if (!p) return;
  if (on) {
    ps.setOwn(id, { playing: false });
    useNexradStore.setState({ paneRadar: { ...s.paneRadar, [id]: { ...p, ownTime: null, scan: null, mesh: null, meshRev: p.meshRev + 1 } } });
    if (s.site) void useNexradStore.getState().showIndex(useNexradStore.getState().index);
    return;
  }
  const t = s.scans[s.index]?.time ?? null;
  if (t == null) return;
  useNexradStore.setState({ paneRadar: { ...s.paneRadar, [id]: { ...p, ownTime: t } } });
}

/** Step a pane on its own scrubber to frame `i` of the loop. */
export function showOwnFrame(id: string, i: number): Promise<boolean> {
  const s = useNexradStore.getState();
  const p = s.paneRadar[id];
  const f = s.scans[Math.max(0, Math.min(i, s.scans.length - 1))];
  if (!p || !f) return Promise.resolve(false);
  useNexradStore.setState({ paneRadar: { ...s.paneRadar, [id]: { ...p, ownTime: f.time } } });
  return useNexradStore.getState().showIndex(i, id);
}

/**
 * The x on a pane: close it and shrink the layout (4 -> 3 -> 2 -> 1; six
 * panes go to four, since there is no five). The panes after it move down a
 * slot with their product, camera, sync switches and display.
 */
export function closePane(id: string): void {
  const app = useAppStore.getState();
  const n = app.paneCount;
  if (n <= 1) return;
  const ids = paneIds(n);
  const k = ids.indexOf(id);
  if (k < 0) return;
  const target = (n - 1 === 5 ? 4 : n - 1) as 1 | 2 | 3 | 4;
  const nx = useNexradStore.getState();
  const prevProduct = nx.product;
  const ps = usePaneStore.getState();
  const disp = useRadarDisplayStore.getState();

  const paneRadar = { ...nx.paneRadar };
  const sync = { ...ps.sync };
  const hidden = { ...ps.hidden };
  const own = { ...ps.own };
  const trail = { ...disp.trail };
  const opacity = { ...disp.opacity };
  const shift = <T,>(rec: Record<string, T>, to: string, from: string) => {
    if (from in rec) rec[to] = rec[from];
    else delete rec[to];
  };
  for (let j = k; j < n - 1; j++) {
    const to = ids[j];
    const from = ids[j + 1];
    const src = nx.paneRadar[from];
    const dst = nx.paneRadar[to];
    if (src && dst) paneRadar[to] = { ...src, meshRev: dst.meshRev + 1 };
    shift(sync, to, from);
    shift(hidden, to, from);
    shift(own, to, from);
    shift(trail, to, from);
    shift(opacity, to, from);
    // The camera moves with the pane when it was not shared.
    const mFrom = getMapById(from);
    const mTo = getMapById(to);
    if (mFrom && mTo && !(ps.syncOf(from).camera && ps.syncOf(to).camera)) {
      mTo.jumpTo({ center: mFrom.getCenter(), zoom: mFrom.getZoom(), bearing: mFrom.getBearing(), pitch: mFrom.getPitch() });
    }
  }
  // The slots that go away: their state goes now, so the pane unmounting
  // finds nothing to remember (dropPane would park an added radar for reuse).
  for (let j = target; j < n; j++) {
    delete paneRadar[ids[j]];
    delete sync[ids[j]];
    delete hidden[ids[j]];
    delete own[ids[j]];
    delete trail[ids[j]];
    delete opacity[ids[j]];
  }
  // Three panes losing a top one leave one above the other.
  if (n === 3 && target === 2) ps.setStacked(k < 2);
  usePaneStore.setState({ sync, hidden, own });
  useRadarDisplayStore.setState({ trail, opacity });
  // Windows, analysis views and compare halves move with their panes too.
  shiftPaneExtras(ids, k, target);
  const focus = getActivePaneId();
  const focusAfter = focus === id ? ids[Math.min(k, target - 1)] : focus && ids.indexOf(focus) > k ? ids[ids.indexOf(focus) - 1] : focus;
  useNexradStore.setState({ paneRadar });
  app.setPaneCount(target);
  // The maps of the gone panes unmount on the next render.
  setTimeout(() => {
    if (focusAfter && getMapById(focusAfter)) setActivePane(focusAfter);
    afterChange(prevProduct);
    for (const m of allMaps()) m.resize();
  }, 0);
}

/** The pane layouts the dock offers. */
export function setLayout(count: 1 | 2 | 3 | 4 | 6, stacked = false): void {
  usePaneStore.getState().setStacked(count === 2 && stacked);
  dropPaneExtrasFrom(count);
  useAppStore.getState().setPaneCount(count);
}

