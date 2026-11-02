import { wireCode, type NexradScan, type ProductFamily } from "./nexrad";
import { getMesh, isTdwrId, loadScan, paneKey, scanId, useNexradStore } from "../store/useNexradStore";
import { useCompareStore } from "../store/useCompareStore";

/**
 * Compare two products in one pane (panes-compare): the right half's loader
 * and the pane menu's actions.
 *
 * The right half is not a pane of its own -- the radar store knows nothing of
 * it, so pane counts, links and the loop stay as they were. It follows its
 * pane instead: whenever the pane shows a new frame (its meshRev bumps), the
 * second product is loaded for that same frame, on the pane's radar, at the
 * pane's tilt when the product has it.
 */

/** What the right half can show: the product picker's own list (each moment
 *  once, on its best source for this radar and time, once the radar has it). */
export function compareFamilies(): ProductFamily[] {
  return useNexradStore.getState().grids.filter((f) => f.tilts.length && !f.checking);
}

export function familyById(id: string | null | undefined): ProductFamily | undefined {
  if (!id) return undefined;
  const s = useNexradStore.getState();
  return s.grids.find((f) => f.id === id) ?? s.catalog.find((f) => f.id === id && f.tilts.length);
}

/** The right half's wire code: its family at the pane's tilt when it has it. */
export function compareProduct(paneId: string): string | null {
  const slot = useCompareStore.getState().slots[paneId];
  const host = useNexradStore.getState().paneRadar[paneId];
  const fam = familyById(slot?.family);
  if (!slot || !fam) return null;
  const keep = fam.tilts.find((t) => t.tilt === host?.tilt);
  return wireCode(fam, keep?.tilt ?? fam.tilts[0]?.tilt ?? null);
}

/** What a pane is compared with when nothing was picked: reflectivity with
 *  velocity and the other way round, else reflectivity. */
export function defaultCompareFamily(paneId: string): string | null {
  const host = useNexradStore.getState().paneRadar[paneId];
  const fams = compareFamilies().filter((f) => !f.unavailable);
  const mine = familyById(host?.family);
  const want = mine?.kind === "ref" ? ["vel"] : mine?.kind === "vel" || mine?.kind === "srv" ? ["ref"] : ["ref", "vel"];
  for (const k of want) {
    const pick =
      fams.find((f) => f.kind === k && f.id !== host?.family && f.source === mine?.source && f.group !== "derived") ??
      fams.find((f) => f.kind === k && f.id !== host?.family);
    if (pick) return pick.id;
  }
  return fams.find((f) => f.id !== host?.family)?.id ?? null;
}

export function isComparing(paneId: string | null | undefined): boolean {
  return !!paneId && !!useCompareStore.getState().slots[paneId];
}

/** Split the pane: left its product, right `family` (or the usual partner). */
export function startCompare(paneId: string, family?: string): boolean {
  const host = useNexradStore.getState().paneRadar[paneId];
  if (!host || host.empty) return false;
  const fam = family ?? defaultCompareFamily(paneId);
  if (!fam) return false;
  const cur = useCompareStore.getState().slots[paneId];
  useCompareStore.getState().setSlot(paneId, { family: fam, split: cur?.split ?? 0.5 });
  return true;
}

export function setCompareFamily(paneId: string, family: string): void {
  const cur = useCompareStore.getState().slots[paneId];
  useCompareStore.getState().setSlot(paneId, { family, split: cur?.split ?? 0.5 });
}

export function stopCompare(paneId: string): void {
  useCompareStore.getState().setSlot(paneId, null);
}

/** Swap sides: the right product becomes the pane's, the pane's goes right. */
export function swapSides(paneId: string): void {
  const slot = useCompareStore.getState().slots[paneId];
  const host = useNexradStore.getState().paneRadar[paneId];
  if (!slot || !host || host.empty) return;
  const was = host.family;
  useNexradStore.getState().setPaneFamily(paneId, slot.family);
  useCompareStore.getState().setSlot(paneId, { family: was, split: slot.split });
}

// ---- the loader ----

const tokens = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function nearest(scans: NexradScan[], t: number): number {
  let best = 0;
  for (let i = 1; i < scans.length; i++) if (Math.abs(scans[i].time - t) < Math.abs(scans[best].time - t)) best = i;
  return best;
}

function schedule(paneId: string): void {
  if (timers.has(paneId)) return;
  timers.set(
    paneId,
    setTimeout(() => {
      timers.delete(paneId);
      void load(paneId);
    }, 0),
  );
}

async function load(paneId: string): Promise<void> {
  const cs = useCompareStore.getState();
  const slot = cs.slots[paneId];
  if (!slot) return;
  const nx = useNexradStore.getState();
  const host = nx.paneRadar[paneId];
  if (!host || host.empty || !nx.site || !nx.scans.length) {
    // The pane was blanked (no radar, a past moment with no scans): its compared
    // half does not stay on the map alone.
    const v = cs.viewOf(paneId);
    if (host && !host.empty && !host.scan && v.mesh) {
      tokens.set(paneId, (tokens.get(paneId) ?? 0) + 1);
      cs.setView(paneId, { scan: null, mesh: null, rev: v.rev + 1, note: null, product: null, loading: false });
    }
    return;
  }
  const product = compareProduct(paneId);
  const my = (tokens.get(paneId) ?? 0) + 1;
  tokens.set(paneId, my);
  const live = () => tokens.get(paneId) === my && !!useCompareStore.getState().slots[paneId];
  if (!product) {
    const note = isTdwrId(host.site || nx.site) ? "NEXRAD only" : "This radar has no such product";
    cs.setView(paneId, { loading: false, note, scan: null, mesh: null, rev: cs.viewOf(paneId).rev + 1 });
    return;
  }
  const scans = nx.scans;
  const idx = Math.max(0, Math.min(host.ownTime != null ? nearest(scans, host.ownTime) : nx.index, scans.length - 1));
  const frame = scans[idx];
  const site = host.site || nx.site;
  const frameSite = frame?.site ?? nx.site;
  // Another radar than the frame's: its own list decides (never the frame's key).
  const master = site === frameSite ? (frame?.product ?? nx.product) : "";
  cs.setView(paneId, { loading: true });
  try {
    const key = await paneKey(site, product, master, frame);
    const scan = await loadScan(site, product, key);
    if (!live()) return;
    if (scan.meta.pending) {
      // The volume being written has not reached this tilt: what is drawn stays.
      useCompareStore.getState().setView(paneId, { loading: false, note: scan.meta.note ?? "Not scanned yet" });
      return;
    }
    const pal = nx.resolvePal(scan.meta.kind);
    if (!pal) throw new Error("The colour tables are not loaded yet");
    const mesh = await getMesh(scanId(site, product, key), scan, pal, nx.smooth, nx.threshold);
    if (!live()) return;
    const v = useCompareStore.getState().viewOf(paneId);
    useCompareStore.getState().setView(paneId, {
      scan,
      mesh,
      rev: v.rev + 1,
      loading: false,
      note: scan.meta.elevation == null && scan.meta.note ? scan.meta.note : null,
      product,
    });
    if (host.ownTime == null) void warmAhead(paneId, my, site, product, master, scans, idx);
  } catch (e) {
    if (!live()) return;
    const v = useCompareStore.getState().viewOf(paneId);
    useCompareStore.getState().setView(paneId, {
      loading: false,
      note: e instanceof Error ? e.message : String(e),
      scan: null,
      mesh: null,
      rev: v.rev + 1,
    });
  }
}

/** The next few frames of the right half, so a play does not wait on them. */
async function warmAhead(paneId: string, my: number, site: string, product: string, master: string, scans: NexradScan[], idx: number): Promise<void> {
  for (let k = 1; k <= 3 && k < scans.length; k++) {
    if (tokens.get(paneId) !== my) return;
    const f = scans[(idx + k) % scans.length];
    if (!f || f.site) continue;
    try {
      const key = await paneKey(site, product, master, f);
      await loadScan(site, product, key, true);
    } catch {
      /* shown later, retried then */
    }
  }
}

/** Once for the app: the right halves follow their panes. */
export function installPaneCompare(): void {
  useNexradStore.subscribe((s, p) => {
    const slots = useCompareStore.getState().slots;
    const ids = Object.keys(slots);
    if (!ids.length) return;
    const all =
      s.colorRev !== p.colorRev ||
      s.smooth !== p.smooth ||
      s.threshold !== p.threshold ||
      s.site !== p.site ||
      s.grids !== p.grids;
    for (const id of ids) {
      const h = s.paneRadar[id];
      const ph = p.paneRadar[id];
      if (all || h?.meshRev !== ph?.meshRev || h?.tilt !== ph?.tilt || h?.site !== ph?.site) schedule(id);
    }
  });
  useCompareStore.subscribe((s, p) => {
    if (s.slots === p.slots) return;
    for (const [id, slot] of Object.entries(s.slots)) {
      if (p.slots[id]?.family === slot.family) continue;
      // Another product: the old picture must not stand in under the new name.
      const v = useCompareStore.getState().viewOf(id);
      useCompareStore.getState().setView(id, { scan: null, mesh: null, rev: v.rev + 1, note: null, product: null });
      schedule(id);
    }
  });
  // Slots kept from the last visit load once the radar is up (the subscription
  // above catches the first frame); nothing to do now.
}
