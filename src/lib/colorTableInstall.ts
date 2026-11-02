// Colour tables, once for the app: ] and [ step the focused pane's product
// through its tables, and any change to which table draws (a choice, a saved
// palette, a scale/offset, the open editor's draft) recolours every pane.

import { getActivePaneId } from "../map/mapInstance";
import { useAppStore } from "../store/useAppStore";
import { useColorTableStore } from "../store/useColorTableStore";
import { useNexradStore } from "../store/useNexradStore";
import { usePaletteStore } from "../store/usePaletteStore";
import { activeTableId, analyzeFiles, cycleTable, sourceOf, tableLabel, tableText } from "./colorTables";
import { parsePal } from "./pal";

/** The radar product a pane shows: its family, kind and palette id. */
export function paneProduct(paneId: string | null): { family: string; kind: string; pid: string; label: string } | null {
  const nx = useNexradStore.getState();
  const pr = paneId ? nx.paneRadar[paneId] : null;
  if (pr?.empty) return null;
  const family = pr?.family ?? nx.family;
  const fam = nx.grids.find((f) => f.id === family) ?? nx.catalog.find((f) => f.id === family);
  if (!fam) return null;
  return { family, kind: fam.kind, pid: nx.paletteIdFor(fam.kind), label: fam.label };
}

/** Open the colour table editor in a pane, on the product's current table
 *  (or `tableId`). Anything unsaved in an open editor is dropped. */
export function openEditor(paneId: string, pid: string, kind: string, tableId?: string): boolean {
  const tables = useNexradStore.getState().palTables;
  const id = tableId ?? activeTableId(pid, tables);
  const text = tableText(id, tables);
  if (!text) return false;
  const t = parsePal(text);
  if (t.entries.length < 2) return false;
  useColorTableStore.getState().openEditor({
    paneId,
    pid,
    kind,
    baseId: id,
    baseLabel: tableLabel(id, tables),
    baseSource: sourceOf(id, pid),
    header: { product: t.product, units: t.units, step: t.step, rf: t.rf },
    baseEntries: t.entries,
  });
  return true;
}

/** ] / [ on a pane: the next or previous table, with a note naming it. */
export function stepTable(dir: 1 | -1, paneId: string | null = getActivePaneId()): boolean {
  const nx = useNexradStore.getState();
  if (!nx.site || !useAppStore.getState().layers.nexrad?.visible) return false;
  const p = paneProduct(paneId);
  if (!p) return false;
  const r = cycleTable(p.pid, dir, nx.palTables, nx.kindDefaults);
  if (!r) return false;
  const ed = useColorTableStore.getState().editor;
  if (ed && ed.pid === p.pid) openEditor(ed.paneId, ed.pid, ed.kind, r.choice.id);
  const name = r.choice.source === "default" ? `Default (${r.choice.label})` : r.choice.label;
  useColorTableStore.getState().showNote(
    r.count > 1 ? `${p.label}: ${name} · ${r.index + 1} of ${r.count}` : `${p.label}: ${name} is its only table`,
  );
  return true;
}

function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return true;
  return !!el.closest?.('[role="listbox"], [role="menu"], [role="combobox"], [role="dialog"]');
}

function onKey(e: KeyboardEvent) {
  if (e.key !== "]" && e.key !== "[") return;
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (typing(e.target)) return;
  if (stepTable(e.key === "]" ? 1 : -1)) e.preventDefault();
}

declare global {
  interface Window {
    __colorTablesOff?: () => void;
    __ctab?: Record<string, unknown>;
  }
}

/** Install the keys and the recolouring. Safe to call again (HMR). */
export function installColorTables(): void {
  window.__colorTablesOff?.();
  window.addEventListener("keydown", onKey);

  // One recolour per frame however many changes land in it (a marker drag
  // moves the draft at the pointer's rate).
  let raf = 0;
  const schedule = () => {
    if (raf) return;
    raf = window.requestAnimationFrame(() => {
      raf = 0;
      useNexradStore.getState().repaint();
    });
  };
  const offPal = usePaletteStore.subscribe((s, p) => {
    if (s.overrides !== p.overrides || s.adjust !== p.adjust || s.custom !== p.custom) schedule();
    // An open editor follows its product's table when that changes from
    // elsewhere (an import's "Switch to them", Settings, the scale dialog's
    // Save as palette, its palette removed) -- unless it holds unsaved edits,
    // which keep drawing until it closes.
    if (s.overrides !== p.overrides || s.custom !== p.custom) {
      const ed = useColorTableStore.getState().editor;
      if (ed && !ed.dirty) {
        const now = activeTableId(ed.pid, useNexradStore.getState().palTables);
        if (now !== ed.baseId) openEditor(ed.paneId, ed.pid, ed.kind, now);
      }
    }
  });
  const offDraft = useColorTableStore.subscribe((s, p) => {
    if (s.draft !== p.draft) schedule();
  });

  if (import.meta.env.DEV || import.meta.env.VITE_PROBE) {
    window.__ctab = {
      openEditor,
      stepTable,
      paneProduct,
      analyze: (files: { name: string; text: string }[]) => {
        const nx = useNexradStore.getState();
        return analyzeFiles(files.map((f) => ({ ...f, size: f.text.length })), nx.kindDefaults);
      },
      openImport: (files: { name: string; text: string }[]) => {
        const nx = useNexradStore.getState();
        const items = analyzeFiles(files.map((f) => ({ ...f, size: f.text.length })), nx.kindDefaults);
        useColorTableStore.getState().openImport(items, 0);
        return items.length;
      },
      ct: useColorTableStore,
      pal: usePaletteStore,
    };
  }

  window.__colorTablesOff = () => {
    window.removeEventListener("keydown", onKey);
    offPal();
    offDraft();
    if (raf) window.cancelAnimationFrame(raf);
  };
}
