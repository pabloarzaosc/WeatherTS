import { create } from "zustand";
import { persist } from "zustand/middleware";

import { parsePal } from "../lib/pal";

// The radar's colour tables beyond the built-ins: the user's saved .pal tables
// (imported or made in the colour table editor), which table each product
// draws with, and each table's colour scale and offset.
//
// Since the browser does the colouring, none of this costs any server work:
// a change is a recolour of the meshes already on screen.

export interface CustomPalette {
  id: string; // "user:<slug>" -- namespaced so it can't collide with a built-in
  label: string;
  pal: string; // .pal text, its stops in WeatherTS's units (dBZ, kt, kft, in)
  product: string | null; // the file's own `Product:` line, if any
  units: string | null;
  addedAt: number;
  /** The product it is a table for, as that product's default palette id
   *  (FILE_DR = reflectivity, FILE_amixof2BV = velocity, ...). Unset on
   *  tables saved before products were tracked: see pidOfCustom. */
  pid?: string | null;
}

/** Colour scale and offset: every stop moved from v to v * scale + offset. */
export interface PalAdjust {
  scale: number;
  offset: number;
}

/** How many saved palettes there can be. */
export const MAX_CUSTOM = 50;

/** Before products were tracked, an import pointed at these ids -- alternates
 *  nothing draws with -- so a reflectivity import did nothing at all. They
 *  move to the product's real table id once (persist version 1). */
const LEGACY_IDS: Record<string, string> = {
  REF: "FILE_DR",
  VEL: "FILE_amixof2BV",
  SRV: "FILE_SRV",
  ZDR: "FILE_ZDR",
  KDP: "FILE_KDP",
  SW: "FILE_SW",
  EET: "FILE_ET_steep",
  VIL: "FILE_VIL",
  DHC: "FILE_HC",
  DAA: "FILE_OHP",
  DTA: "FILE_STP",
};

/** Sanity check so a wrong file fails here instead of rendering blank. */
export function validatePal(text: string): { ok: true; stops: number } | { ok: false; error: string } {
  let table;
  try {
    table = parsePal(text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const n = table.entries.length;
  if (n < 2) {
    return {
      ok: false,
      error: "No usable colour stops found — expected `Color: value r g b` lines (or `value r g b`).",
    };
  }
  if (table.entries[0].v === table.entries[n - 1].v) {
    return { ok: false, error: "All stops sit at the same value, so there's no range to colour." };
  }
  return { ok: true, stops: n };
}

export function slugOf(name: string): string {
  const base = name
    .replace(/\.pal$/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "palette";
}

/** The product a saved palette belongs to: its own field, else the product it
 *  is drawn for (a table saved before the field existed). */
export function pidOfCustom(c: CustomPalette, overrides: Record<string, string>): string | null {
  if (c.pid) return c.pid;
  const hit = Object.entries(overrides).find(([, v]) => v === c.id);
  return hit ? hit[0] : null;
}

export interface SaveInput {
  /** Overwrite this saved palette; omitted = a new one. */
  id?: string;
  label: string;
  pal: string;
  pid: string | null;
}

interface PaletteState {
  custom: CustomPalette[];
  /** product palette id -> the table drawn for it: a saved palette's id or a
   *  built-in alternate's id. Absent = the product's default. */
  overrides: Record<string, string>;
  /** table id -> its colour scale and offset. Absent = as written. */
  adjust: Record<string, PalAdjust>;

  save: (p: SaveInput) => { ok: true; id: string } | { ok: false; error: string };
  /** Several at once (the bulk import), one state change. */
  saveMany: (ps: SaveInput[]) => { ok: true; ids: string[] } | { ok: false; error: string };
  remove: (id: string) => void;
  /** Settings' "Replaces": the product this palette is for, drawn now ("" = none). */
  setTarget: (id: string, target: string) => void;
  /** The table a product draws with (null = its default). */
  select: (pid: string, tableId: string | null) => void;
  setAdjust: (tableId: string, adj: PalAdjust | null) => void;
}

function uniqueId(label: string, taken: Set<string>): string {
  const base = `user:${slugOf(label)}`;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

function entryOf(p: SaveInput, id: string, was?: CustomPalette): CustomPalette {
  const { product, units } = parsePal(p.pal);
  return {
    id,
    label: p.label.replace(/\.pal$/i, "").trim() || "Custom palette",
    pal: p.pal,
    product,
    units,
    addedAt: was?.addedAt ?? Date.now(),
    pid: p.pid ?? was?.pid ?? null,
  };
}

export const usePaletteStore = create<PaletteState>()(
  persist(
    (set, get) => ({
      custom: [],
      overrides: {},
      adjust: {},

      save: (p) => {
        const r = get().saveMany([p]);
        return r.ok ? { ok: true, id: r.ids[0] } : r;
      },

      saveMany: (ps) => {
        for (const p of ps) {
          const check = validatePal(p.pal);
          if (!check.ok) return { ok: false, error: `${p.label}: ${check.error}` };
        }
        const custom = [...get().custom];
        const fresh = ps.filter((p) => !p.id || !custom.some((c) => c.id === p.id)).length;
        if (custom.length + fresh > MAX_CUSTOM) {
          return {
            ok: false,
            error: `Up to ${MAX_CUSTOM} saved palettes: ${custom.length} saved, ${fresh} more is ${custom.length + fresh - MAX_CUSTOM} too many.`,
          };
        }
        const taken = new Set(custom.map((c) => c.id));
        const ids: string[] = [];
        for (const p of ps) {
          const at = p.id ? custom.findIndex((c) => c.id === p.id) : -1;
          if (at >= 0) {
            custom[at] = entryOf(p, custom[at].id, custom[at]);
            ids.push(custom[at].id);
          } else {
            const id = uniqueId(p.label, taken);
            taken.add(id);
            custom.push(entryOf(p, id));
            ids.push(id);
          }
        }
        set({ custom });
        return { ok: true, ids };
      },

      remove: (id) => {
        const overrides = { ...get().overrides };
        for (const [k, v] of Object.entries(overrides)) if (v === id) delete overrides[k];
        const adjust = { ...get().adjust };
        delete adjust[id];
        set({ custom: get().custom.filter((p) => p.id !== id), overrides, adjust });
      },

      setTarget: (id, target) => {
        const overrides = { ...get().overrides };
        for (const [k, v] of Object.entries(overrides)) if (v === id) delete overrides[k];
        if (target) overrides[target] = id;
        const custom = get().custom.map((c) => (c.id === id && target ? { ...c, pid: target } : c));
        set({ overrides, custom });
      },

      select: (pid, tableId) => {
        const overrides = { ...get().overrides };
        if (!tableId || tableId === pid) delete overrides[pid];
        else overrides[pid] = tableId;
        set({ overrides });
      },

      setAdjust: (tableId, adj) => {
        const adjust = { ...get().adjust };
        if (!adj || (adj.scale === 1 && adj.offset === 0)) delete adjust[tableId];
        else adjust[tableId] = { scale: adj.scale, offset: adj.offset };
        set({ adjust });
      },
    }),
    {
      name: "weatherts.palettes",
      version: 1,
      migrate: (persisted, version) => {
        const s = (persisted ?? {}) as Partial<Pick<PaletteState, "custom" | "overrides" | "adjust">>;
        const custom = [...(s.custom ?? [])];
        const overrides = { ...(s.overrides ?? {}) };
        if (version < 1) {
          for (const [k, v] of Object.entries(s.overrides ?? {})) {
            const real = LEGACY_IDS[k];
            if (!real) continue;
            delete overrides[k];
            if (!overrides[real]) overrides[real] = v;
            const at = custom.findIndex((c) => c.id === v);
            if (at >= 0 && !custom[at].pid) custom[at] = { ...custom[at], pid: real };
          }
        }
        return { custom, overrides, adjust: s.adjust ?? {} } as PaletteState;
      },
      partialize: (s) => ({ custom: s.custom, overrides: s.overrides, adjust: s.adjust }),
    },
  ),
);
